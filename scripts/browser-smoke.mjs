// Real-browser smoke test for BangerBox — spec §11.4. Drives the system-installed Edge
// via Playwright (`channel: 'msedge'` — locked decision §1.3 #13, no browser download)
// against a live dev server AND a production preview:
//
//   Section A (dev server, COOP/COEP headers):
//     - `crossOriginIsolated === true`
//     - the app shell boots past the capability gate
//     - the audio engine starts on the user gesture (§5.1), a pad plays an audible
//       signal the master meter tracks (§5.4/§5.8), create/destroy churn is leak-free
//       (§5.3), and OfflineAudioContext effect renders assert DSP properties (§11.2)
//   Section B (production build + preview server):
//     - the PWA manifest is served and linked
//     - the service worker installs and takes control
//     - with the network offline, the shell reloads from the SW precache, stays
//       cross-origin isolated, and the engine self-test still passes (installable
//       offline PWA shell — Phase 0 exit criterion)
//
// Fails on any console error or page error.
//
//   node scripts/browser-smoke.mjs             # full run (dev + offline PWA) — phase-exit proof
//   node scripts/browser-smoke.mjs --dev-only  # fast: dev section only (skips the vite build)
//   node scripts/browser-smoke.mjs --headed    # watch it run
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
// Overridable because the defaults are not reserved: another project listening on 5199 fails
// this smoke in a way that looks like a BangerBox fault rather than a port collision.
const DEV_PORT = Number(process.env.BANGERBOX_SMOKE_PORT ?? 5199);
const PREVIEW_PORT = Number(process.env.BANGERBOX_SMOKE_PREVIEW_PORT ?? 5198);
const DEV_URL = `http://localhost:${DEV_PORT}/`;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const headed = process.argv.includes('--headed');
// --dev-only: run just Section A (dev server) for fast iteration — skips the production
// `vite build` + preview + offline reload (Section B), the slowest part. The default (full)
// run remains the binding phase-exit proof (spec §11.4/§13.5). All Phase 6 proofs (sample
// pipeline, .mpcweb round-trip, worklet effects) already run in the dev section.
const devOnly = process.argv.includes('--dev-only');
const artefactDir = resolve(root, 'scripts/smoke-artefacts');
// spec §5.7's own default delay time, restated here because the point of the issue-#131 step
// is that the store, the graph and the panel all land on the same NUMBER — not merely on
// whatever number they happen to share. The range floor they used to read is 1 ms.
const DELAY_DEFAULT_MS = 350;

const results = [];
const consoleErrors = [];
const pageErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    // The step's value is passed through so one step can feed the next (e.g. the factory
    // cache warm-up hands the offline assertion the pack filename it warmed).
    const value = await fn();
    record(name, true);
    return value;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Record every toast the app raises, as it is raised.
 *
 * Sampling the DOM at the end cannot work: toasts are transient, so a warning raised early
 * has usually gone by the time any later step looks. This installs a MutationObserver
 * before any page script runs (and again after every navigation, which is why it is an
 * init script rather than an evaluate), appending each toast to `__toastLog`.
 *
 * This exists because three "Autosave failed — will retry." toasts sat in the dev section
 * for an unknown length of time without failing the run — the smoke asserted console errors
 * but never toasts, so a warning the user would plainly see was invisible here (spec §14
 * 2026-07-18 (r)).
 */
async function wireToastRecorder(pageOrContext) {
  await pageOrContext.addInitScript(() => {
    globalThis.__toastLog = [];
    const record = (node) => {
      if (node.nodeType !== 1 || node.dataset?.testid !== 'toast') return;
      globalThis.__toastLog.push({
        tone: node.dataset.tone ?? 'unknown',
        message: node.querySelector('span')?.textContent ?? node.textContent ?? '',
      });
    };
    const observer = new MutationObserver((records) => {
      for (const record_ of records) {
        for (const node of record_.addedNodes) {
          record(node);
          // A toast can arrive nested inside the viewport when the viewport itself mounts.
          if (node.nodeType === 1) node.querySelectorAll?.('[data-testid="toast"]').forEach(record);
        }
      }
    });
    const start = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
}

/** Fail the run on any warning/error toast; info/success are user-action confirmations. */
async function assertNoWarningToasts(page, label) {
  await step(`${label}: no warning or error toasts were raised`, async () => {
    const toasts = await page.evaluate(() => globalThis.__toastLog ?? []);
    const bad = toasts.filter((t) => t.tone === 'warning' || t.tone === 'error');
    if (bad.length > 0) {
      const detail = bad.map((t) => `[${t.tone}] ${t.message}`).join('; ');
      throw new Error(`${bad.length} warning/error toast(s): ${detail}`);
    }
  });
}

function wireErrorCollectors(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    consoleErrors.push(`request failed: ${request.url()} — ${request.failure()?.errorText}`);
  });
}

/** Spawn a vite server (node + vite bin directly — no shell, clean kill on Windows). */
function spawnVite(args) {
  return spawn(process.execPath, [viteBin, ...args], { cwd: root, stdio: 'pipe' });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs} ms`);
}

/** Launch the system Edge; fall back to Chrome, then a bundled build if present. */
async function launchBrowser() {
  const attempts = [{ channel: 'msedge' }, { channel: 'chrome' }, {}];
  let lastErr;
  for (const opts of attempts) {
    try {
      return await chromium.launch({ ...opts, headless: !headed });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function assertShellAndSelfTest(page, label) {
  await step(`${label}: context is cross-origin isolated`, async () => {
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    if (!isolated) throw new Error('crossOriginIsolated is not true');
  });

  await step(`${label}: app shell boots past the capability gate`, async () => {
    // Phase 7: the start gate (spec §5.1) is the first screen; the shell mounts behind it.
    await page.locator('h1', { hasText: 'BangerBox' }).waitFor({ timeout: 15_000 });
    await page.getByTestId('audio-start').waitFor({ timeout: 15_000 });
  });

  // Phase 3 exit criteria (spec §12): audible end-to-end path, meters reflect real
  // peaks, leak-free create/destroy churn (§5.3), OfflineAudioContext effect asserts
  // (§11.2). The audio probe (window.__bangerboxAudioProbe) is the §11.4 test seam.
  await step(`${label}: audio engine starts on the user gesture (spec §5.1)`, async () => {
    await page.getByTestId('audio-start').click();
    await page
      .getByTestId('audio-engine-status')
      .and(page.locator('[data-status="running"]'))
      .waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => typeof globalThis.__bangerboxAudioProbe?.masterPeak === 'function',
      undefined,
      { timeout: 10_000 },
    );
  });

  // Phase 1 exit criterion (spec §12): the real-OPFS path — SQLite worker boot +
  // migrations, then a project row AND an OPFS file round-trip on this device. These
  // diagnostics live in Q-Link Edit's Storage panel with the other device settings
  // (changelog 2026-07-18 (o)); Main carries no storage panel any more.
  await step(`${label}: database worker boots on the OPFS VFS with schema v1`, async () => {
    await page.getByTestId('mode-tab-qlink-edit').click();
    // Collapsed disclosure — open it so the controls below are visible to click.
    await page.getByTestId('storage-diagnostics').locator('summary').click();
    const status = page.getByTestId('storage-panel-status');
    await status.and(page.locator('[data-status="ready"], [data-status="failed"]')).waitFor({
      timeout: 30_000,
    });
    const outcome = await status.getAttribute('data-status');
    if (outcome !== 'ready') {
      const detail = await page.getByTestId('storage-panel-detail').textContent();
      throw new Error(`storage boot ${outcome}: ${detail}`);
    }
    const detail = await page.getByTestId('storage-panel-detail').textContent();
    if (!/schema v1/.test(detail ?? '')) {
      throw new Error(`diagnostics did not report schema v1: ${detail}`);
    }
  });

  await step(`${label}: storage self-test round-trips SQLite and OPFS`, async () => {
    await page.getByTestId('storage-self-test-run').click();
    const status = page.getByTestId('storage-self-test-status');
    await status.and(page.locator('[data-status="passed"], [data-status="failed"]')).waitFor({
      timeout: 30_000,
    });
    const outcome = await status.getAttribute('data-status');
    if (outcome !== 'passed') {
      const detail = await page.getByTestId('storage-self-test-detail').textContent();
      throw new Error(`storage self-test ${outcome}: ${detail}`);
    }
  });

  // The everyday storage read is the persistent transport gauge (changelog 2026-07-18
  // (o)) — it must report on every mode, so assert it from Main.
  await step(`${label}: transport storage gauge reports usage`, async () => {
    await page.getByTestId('mode-tab-main').click();
    const gauge = page.getByTestId('transport-storage');
    await gauge.waitFor({ timeout: 15_000 });
    const now = await gauge.getByRole('progressbar').getAttribute('aria-valuenow');
    if (now === null || Number.isNaN(Number(now))) {
      throw new Error(`storage gauge reported no usage: ${now}`);
    }
  });

  await step(`${label}: a pad plays an audible signal and the master meter tracks it`, async () => {
    // Prove the UI button is wired…
    await page.getByTestId('pad-trigger-0').click();
    // …then retrigger through the probe, observing BOTH the master meter SAB peak
    // (audible path) and the meter canvas aria-valuenow (meters reflect peaks) within a
    // tight window of each hit — so the ~0.2 s peak is never missed by poll timing, and
    // the aria check sees signal while it is still flowing (peak-hold has not decayed).
    const result = await page.evaluate(async () => {
      const probe = globalThis.__bangerboxAudioProbe;
      const ariaNow = () =>
        Number(document.querySelector('[data-testid="meter-master"]')?.getAttribute('aria-valuenow') ?? '0');
      let peakSeen = false;
      let ariaSeen = false;
      for (let attempt = 0; attempt < 60 && !(peakSeen && ariaSeen); attempt++) {
        await probe.churn(1); // one demo pad hit (awaits decode + start)
        const start = performance.now();
        while (performance.now() - start < 350) {
          if (probe.masterPeak() > 0.02) peakSeen = true;
          if (ariaNow() > 0) ariaSeen = true;
          if (peakSeen && ariaSeen) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      return { peakSeen, ariaSeen };
    });
    if (!result.peakSeen) throw new Error('master meter SAB never registered a peak after pad hits');
    if (!result.ariaSeen) throw new Error('master meter canvas aria-valuenow never rose above 0');
  });

  await step(`${label}: create/destroy churn is leak-free (spec §5.3)`, async () => {
    const before = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    await page.evaluate(() => globalThis.__bangerboxAudioProbe.churn(24));
    await page.waitForFunction(
      () => (globalThis.__bangerboxAudioProbe?.liveVoiceCount() ?? -1) === 0,
      undefined,
      { timeout: 6_000 },
    );
    const after = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    if (before > 0 && after - before > 12 * 1024 * 1024) {
      throw new Error(
        `heap grew ${Math.round((after - before) / 1048576)} MiB across churn — possible node leak`,
      );
    }
  });

  await step(`${label}: offline effect renders assert DSP properties (spec §11.2)`, async () => {
    const results = await page.evaluate(async () => {
      const probe = globalThis.__bangerboxAudioProbe;
      const nonSilent = {};
      for (const fx of ['eq4', 'filter', 'delay', 'compressor', 'saturator', 'reverb']) {
        nonSilent[fx] = await probe.renderEffect(fx);
      }
      const sat = await probe.renderEffect('saturator', { params: { drive: 36, curve: 1 } });
      const filt = await probe.renderEffect('filter', {
        toneHz: 6000,
        params: { type: 0, cutoff: 200, resonance: 1 },
      });
      return { nonSilent, sat, filt };
    });
    for (const [fx, r] of Object.entries(results.nonSilent)) {
      if (!(r.outputRms > 0.0005) || !Number.isFinite(r.outputRms)) {
        throw new Error(`${fx} rendered silence/NaN (rms ${r.outputRms})`);
      }
    }
    if (results.sat.outputPeak > 1.05) {
      throw new Error(`saturator peak ${results.sat.outputPeak} exceeds the unity bound`);
    }
    if (!(results.filt.outputRms < results.filt.inputRms * 0.6)) {
      throw new Error(
        `low-pass did not attenuate a 6 kHz tone (out ${results.filt.outputRms} vs in ${results.filt.inputRms})`,
      );
    }
  });

  // Phase 4 exit criterion (spec §12): the record-then-playback path. The probe drives the
  // real store → sync → scheduler worker → dispatcher → graph loop: it records a take via
  // live notes, lets the worker capture + flush it, then plays it back (§7.1, §7.7).
  await step(`${label}: sequencer records a take and plays it back (spec §12)`, async () => {
    const result = await page.evaluate(() => globalThis.__bangerboxAudioProbe.recordThenPlayback());
    if (!(result.recorded >= 2)) {
      throw new Error(`recording captured only ${result.recorded} note(s) — expected ≥ 2`);
    }
    if (!(result.played >= 2)) {
      throw new Error(`playback dispatched only ${result.played} note(s) — expected ≥ 2`);
    }
  });

  // Phase 5 exit criteria (spec §12): velocity-layer switching is audible and keygroup pitch
  // is accurate — both proven by offline renders through the real resolution + voice path.
  await step(`${label}: velocity switches the layer, changing pitch (spec §12)`, async () => {
    const { soft, hard } = await page.evaluate(() => globalThis.__bangerboxAudioProbe.velocityLayerPitches());
    if (!(soft > 0) || !(hard > 0)) throw new Error(`layer render silent (soft ${soft}, hard ${hard})`);
    // Hard layer is tuned +12 semitones → about one octave (2×) above the soft layer.
    const ratio = hard / soft;
    if (!(ratio > 1.8 && ratio < 2.2)) {
      throw new Error(
        `velocity did not switch layers: hard/soft pitch ratio ${ratio.toFixed(3)} (expected ~2)`,
      );
    }
  });

  await step(`${label}: keygroup repitches accurately across an octave (spec §12)`, async () => {
    const { root, octave } = await page.evaluate(() => globalThis.__bangerboxAudioProbe.keygroupPitches());
    if (!(root > 0) || !(octave > 0)) {
      throw new Error(`keygroup render silent (root ${root}, octave ${octave})`);
    }
    const ratio = octave / root;
    if (!(ratio > 1.94 && ratio < 2.06)) {
      throw new Error(`keygroup octave pitch ratio ${ratio.toFixed(3)} (expected ~2.0)`);
    }
  });

  // The five §5/§7 settings that were reachable to set and changed nothing you could hear
  // (issues #84, #107, #70). Each is proven by an offline render through the real path.
  await step(`${label}: a reversed layer plays backwards (spec §6, issue #84)`, async () => {
    const { forward, reversed } = await page.evaluate(() =>
      globalThis.__bangerboxAudioProbe.reversedLayerHalves(),
    );
    // The sample is silent for its first half and a tone for its second, so playing it
    // backwards has to move the energy from one half of the render to the other.
    if (!(forward.second > forward.first * 4)) {
      throw new Error(
        `forward playback did not put the burst last (first ${forward.first}, second ${forward.second})`,
      );
    }
    if (!(reversed.first > reversed.second * 4)) {
      throw new Error(`reverse was not applied (first ${reversed.first}, second ${reversed.second})`);
    }
  });

  await step(`${label}: warp decouples pitch from duration (spec §5.7.9, issue #84)`, async () => {
    const { plain, warped } = await page.evaluate(() =>
      globalThis.__bangerboxAudioProbe.warpDecouplesPitch(),
    );
    if (!(plain.frequency > 0) || !(warped.frequency > 0)) {
      throw new Error(`warp render silent (plain ${plain.frequency}, warped ${warped.frequency})`);
    }
    // Both are tuned +12 semitones, so both sound an octave up…
    const ratio = warped.frequency / plain.frequency;
    if (!(ratio > 0.85 && ratio < 1.18)) {
      throw new Error(`warp changed the pitch (warped/plain ${ratio.toFixed(3)}, expected ~1)`);
    }
    // …but only the plain voice pays for it in duration: coupled repitch halves the sample.
    const lengthRatio = warped.seconds / plain.seconds;
    if (!(lengthRatio > 1.6)) {
      throw new Error(
        `warp did not preserve duration: warped ${warped.seconds.toFixed(3)} s vs plain ` +
          `${plain.seconds.toFixed(3)} s (expected about twice as long)`,
      );
    }
  });

  await step(`${label}: a synced LFO follows the tempo (spec §6, issue #107)`, async () => {
    const rates = await page.evaluate(() => globalThis.__bangerboxAudioProbe.syncedLfoRates());
    // A 1/4-synced LFO is 1 Hz at 60 bpm and 4 Hz at 240 bpm; the free one ignores both.
    if (!(rates.atSlowTempo > 0.5 && rates.atSlowTempo < 1.6)) {
      throw new Error(`1/4 sync at 60 bpm measured ${rates.atSlowTempo} Hz (expected ~1)`);
    }
    if (!(rates.atFastTempo > 3.2 && rates.atFastTempo < 4.8)) {
      throw new Error(`1/4 sync at 240 bpm measured ${rates.atFastTempo} Hz (expected ~4)`);
    }
    if (!(rates.free > 1.5 && rates.free < 2.5)) {
      throw new Error(`free-running LFO measured ${rates.free} Hz (expected ~2)`);
    }
  });

  await step(`${label}: an LFO phase offset rotates its wave (spec §6, issue #107)`, async () => {
    const { unshifted, quarterTurn } = await page.evaluate(() =>
      globalThis.__bangerboxAudioProbe.lfoPhaseStart(),
    );
    // This is also the check on `createPeriodicWave`'s basis (spec §2.7): a sine starts at
    // zero, and the same sine rotated a quarter turn starts at its positive peak.
    if (Math.abs(unshifted) > 0.05) {
      throw new Error(`an unshifted sine started at ${unshifted} (expected ~0)`);
    }
    if (!(quarterTurn > 0.9)) {
      throw new Error(`a quarter-turn sine started at ${quarterTurn} (expected ~+1)`);
    }
  });

  await step(`${label}: the delay follows a synced division (spec §5.7, issue #70)`, async () => {
    const measure = (options) =>
      page.evaluate((opts) => globalThis.__bangerboxAudioProbe.delayEcho(opts), options);
    // A quarter note is 0.5 s at 120 bpm and 1 s at 60 — the whole point of syncing.
    const free = await measure({ bpm: 120 });
    if (Math.abs(free.echoSeconds - 0.35) > 0.02) {
      throw new Error(`a free 350 ms delay echoed at ${free.echoSeconds.toFixed(3)} s`);
    }
    const fast = await measure({ division: '1/4', bpm: 120 });
    if (Math.abs(fast.echoSeconds - 0.5) > 0.02) {
      throw new Error(`a 1/4 delay at 120 bpm echoed at ${fast.echoSeconds.toFixed(3)} s (expected 0.5)`);
    }
    const slow = await measure({ division: '1/4', bpm: 60 });
    if (Math.abs(slow.echoSeconds - 1) > 0.03) {
      throw new Error(`a 1/4 delay at 60 bpm echoed at ${slow.echoSeconds.toFixed(3)} s (expected 1.0)`);
    }
    // …and a tempo change retunes a delay that is already built (spec §4.3 sync layer).
    const retuned = await measure({ division: '1/4', bpm: 120, retuneToBpm: 60 });
    if (Math.abs(retuned.echoSeconds - 1) > 0.03) {
      throw new Error(
        `a tempo change did not retune the delay: echoed at ${retuned.echoSeconds.toFixed(3)} s`,
      );
    }
  });

  // Phase 7 exit criteria (spec §12): the 12-mode surface mounts for real and every mode
  // is reachable, with no console errors from any of them (spec §8.5, §3.4 no dead modes).
  await step(`${label}: all 12 modes mount from the rail (spec §8.5)`, async () => {
    const tabs = page.getByRole('tab');
    const count = await tabs.count();
    if (count !== 12) throw new Error(`expected 12 mode tabs, found ${count}`);
    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      const id = await tab.getAttribute('data-testid');
      await tab.click();
      await page.locator('[role="tabpanel"]').waitFor({ timeout: 5_000 });
      const selected = await tab.getAttribute('aria-selected');
      if (selected !== 'true') throw new Error(`${id} did not become the selected mode`);
    }
    // Leave the rail on Main so later steps see the diagnostics panels.
    await page.getByTestId('mode-tab-main').click();
  });

  // The transport UI is wired end to end (spec §3.4): Play drives the scheduler and the
  // playhead SAB advances (spec §7.1.4).
  await step(`${label}: transport UI advances the playhead (spec §3.4)`, async () => {
    await page.getByTestId('transport-play').click();
    await page.waitForFunction(() => (globalThis.__bangerboxAudioProbe?.playheadTick() ?? 0) > 0, undefined, {
      timeout: 6_000,
    });
    await page.getByTestId('transport-play').click(); // stop
  });

  // A continuous gesture reaches the graph and re-renders nothing (spec §3.3, §4.1, issue
  // #27). The mechanism IS the store notification count, so that is what is counted; the
  // meter peak is what proves the gesture still did its job while React was left alone.
  await step(`${label}: a gesture moves the graph without a re-render (spec §3.3, issue #27)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.gestureRenderProof());
    if (r.notificationsDuringGesture !== 0) {
      throw new Error(
        `${r.samplesSent} transient samples woke ${r.notificationsDuringGesture} store subscribers — §3.3 requires 0`,
      );
    }
    if (r.notificationsAtCommit !== 1) {
      throw new Error(`the commit woke ${r.notificationsAtCommit} subscribers — expected exactly 1`);
    }
    if (!(r.peakBefore > 0.02)) throw new Error(`no audible signal before the gesture (${r.peakBefore})`);
    // Pulled down to a quarter of the fader: the hit has to be measurably quieter, or the
    // transient never reached the graph at all and the zero above would be meaningless.
    if (!(r.peakDuringGesture < r.peakBefore * 0.6)) {
      throw new Error(`the gesture did not reach the graph: peak ${r.peakBefore} → ${r.peakDuringGesture}`);
    }
    if (!(r.peakAfterCommit > r.peakDuringGesture * 1.5)) {
      throw new Error(
        `the commit did not restore the level: peak ${r.peakDuringGesture} → ${r.peakAfterCommit}`,
      );
    }
  });

  // §8.2 requires ONE announcer. Two regions competing produce an unpredictable order and
  // drop announcements, which nothing that inspects a rendered tree can see — so the count is
  // taken from the live document with real toasts on screen (spec §13.5, issue #34).
  await step(
    `${label}: one announcer, two channels, no region per notice (spec §8.2, issue #34)`,
    async () => {
      const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.announcementProof());
      if (r.regionsIdle !== 2) {
        throw new Error(`${r.regionsIdle} live regions with nothing announced — expected exactly 2`);
      }
      if (r.regionsWithToasts !== 2 || r.strayRegions.length > 0) {
        throw new Error(
          `${r.toastsOnScreen} toasts minted ${r.regionsWithToasts} live regions (stray: ${r.strayRegions.join(', ') || 'none'})`,
        );
      }
      if (r.toastsOnScreen < 3) {
        throw new Error(`only ${r.toastsOnScreen} toasts rendered — the count is untested`);
      }
      // Severity survives as a CHANNEL: an error interrupts, advice waits its turn.
      if (!r.assertiveAfterError.includes('Probe error notice')) {
        throw new Error(`an error toast did not reach the assertive channel: "${r.assertiveAfterError}"`);
      }
      if (r.politeAfterError.includes('Probe error notice')) {
        throw new Error('an error toast reached BOTH channels — the two are not separated');
      }
      if (!r.politeAfterInfo.includes('Probe advisory notice')) {
        throw new Error(`an advisory toast did not reach the polite channel: "${r.politeAfterInfo}"`);
      }
      if (r.assertiveAfterInfo.includes('Probe advisory notice')) {
        throw new Error('an advisory toast interrupted — it must wait its turn');
      }

      // The proof deliberately raises an error and a warning toast, because the channel
      // split it exists to demonstrate is chosen by severity. They are the probe's own
      // traffic, not the product's, so they are taken back out of the log the next step
      // reads — every message it raises begins with "Probe " for exactly this.
      await page.evaluate(() => {
        globalThis.__toastLog = (globalThis.__toastLog ?? []).filter(
          (entry) => !entry.message.startsWith('Probe '),
        );
      });
    },
  );

  // §9.7 wants "a persistent dismissible warning that the browser may evict data". A `title`
  // satisfies an inspection and fails a keyboard, so the proof reads the real DOM back after
  // driving the real §9.7 state (spec §13.5, issue #51).
  await step(`${label}: the §9.7 eviction warning is readable and dismissible (issue #51)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.platformNoticeProof());
    if (r.noticesWhileGranted !== 0) {
      throw new Error(`${r.noticesWhileGranted} notices while storage was protected — it is not a nag`);
    }
    if (!/may clear your projects/i.test(r.text) || !/Install BangerBox as an app/i.test(r.text)) {
      throw new Error(`the warning does not say what is at stake or what to do: "${r.text.slice(0, 120)}"`);
    }
    if (!r.dismissFocusable) throw new Error('the Dismiss control is not in the tab order');
    if (!r.dismissName.startsWith('Dismiss ')) {
      throw new Error(`the Dismiss control does not name what it dismisses: "${r.dismissName}"`);
    }
    if (r.noticesAfterDismiss !== 0) throw new Error('the warning survived being dismissed');
    if (/evict/i.test(r.gaugeTitle)) {
      throw new Error(`the gauge still hides the warning in a title: "${r.gaugeTitle}"`);
    }
  });

  // §7.7 removes a held pad's events "as the loop passes", and the case the unit tests could
  // not reach is the shape of a REAL lookahead window as the playhead crosses the bar line
  // (spec §13.5, issue #16). Under the defect the two lists below swap places.
  await step(`${label}: a live-erase sweep over the loop end takes what it passed (issue #16)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.liveEraseWrapProof());
    if (r.ticksBefore.length !== 5) {
      throw new Error(`the probe wrote ${r.ticksBefore.length} notes, not 5 — nothing to sweep`);
    }
    const gone = r.ticksBefore.filter((tick) => !r.ticksAfter.includes(tick));
    // The sweep straddles tick 3840: it takes 3600 on the way out and 0 on the way back in.
    if (gone.join(',') !== '0,3600') {
      throw new Error(
        `the sweep took ticks [${gone.join(', ')}] — expected [0, 3600], survivors [${r.ticksAfter.join(', ')}]`,
      );
    }
    if (r.ticksAfter.join(',') !== '960,1920,2880') {
      throw new Error(`the ticks away from the sweep did not survive: [${r.ticksAfter.join(', ')}]`);
    }
    console.log(`       live erase: swept [${gone.join(', ')}] of a ${r.loopLengthTicks}-tick loop`);
  });

  // §7.9's `songAdvanced { entryIndex }` indexes the position-sorted ENTRY list, and §8.5.12's
  // playlist has to mark the same row. Both halves are read from the running application: the
  // worker's numbering, and the row Song mode lit while the repeated entry was still playing.
  await step(`${label}: songAdvanced indexes §7.9's sorted entries, repeats and all (#130)`, async () => {
    await page.getByTestId('mode-tab-song').click();
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.songEntryIndexProof());
    if (r.entryCount !== 2 || r.segmentCount !== 3) {
      throw new Error(
        `the probe built ${r.entryCount} entries over ${r.segmentCount} plays — expected 2 over 3`,
      );
    }
    if (r.reportedIndices.join(',') !== '0,1') {
      throw new Error(
        `the worker reported entry indices [${r.reportedIndices.join(', ')}] — a repeat consumed one of its own`,
      );
    }
    if (r.markedRowIndex !== 0 || !r.markedRowText.includes('Entry probe A')) {
      throw new Error(
        `row ${r.markedRowIndex} ("${r.markedRowText}") was marked during the repeat — expected row 0, Entry probe A`,
      );
    }
    console.log(
      `       song entries: reported [${r.reportedIndices.join(', ')}] over ${r.segmentCount} plays of ${r.entryCount} entries`,
    );
    await page.getByTestId('mode-tab-main').click();
  });

  // §3.4 requires that "the store value reflects the actual node state". The two are measured
  // separately, because that is the only way the disagreement is visible: the store number is
  // taken through the fallback every reader uses, and the graph number is an offline render of
  // a delay built from the slot's params verbatim (spec §11.2). Three slots, because a fix at
  // the creating action alone leaves a project already on disk still wrong.
  await step(`${label}: a slot's stored params are the ones the graph runs (spec §3.4, #131)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.insertDefaultsProof());
    for (const [name, agreement] of Object.entries({
      added: r.added,
      reloaded: r.reloaded,
      legacy: r.legacy,
    })) {
      if (!agreement.stored) {
        throw new Error(`the ${name} slot carries no delay time at all — ${r.path} reads its range floor`);
      }
      if (!(agreement.echoPeak > 0.02)) {
        throw new Error(`the ${name} slot rendered no audible echo (peak ${agreement.echoPeak})`);
      }
      // The absolute number is what makes this more than an internal-consistency check: the
      // graph must echo at §5.7's own stated default, and the store must read the same. One
      // millisecond of tolerance, because the echo is found by peak search at 48 kHz.
      for (const [half, value] of [
        ['reads', agreement.storeTimeMs],
        ['echoes at', agreement.graphTimeMs],
      ]) {
        if (!(Math.abs(value - DELAY_DEFAULT_MS) < 1)) {
          throw new Error(
            `the ${name} slot ${half} ${value.toFixed(1)} ms — §5.7's default delay time is ${DELAY_DEFAULT_MS}`,
          );
        }
      }
    }
    // A gesture that reached nothing would leave BOTH numbers below at the default, so the
    // touched value is asserted too: without it the undo check could pass while proving
    // nothing (the §7.8 address stops parsing past the §1.3.1 slot limit — issue #135).
    if (Math.abs(r.touchedToMs - 600) > 0.001) {
      throw new Error(`the first touch of the fresh delay put it at ${r.touchedToMs} ms — expected 600`);
    }
    // The range floor it used to be undone to is 1 ms — a value the delay had never held.
    if (Math.abs(r.undoneToMs - DELAY_DEFAULT_MS) > 0.001) {
      throw new Error(
        `undoing the first touch of a fresh delay left it at ${r.undoneToMs} ms — expected ${DELAY_DEFAULT_MS}`,
      );
    }
    console.log(
      `       insert defaults: added ${r.added.storeTimeMs.toFixed(0)}/${r.added.graphTimeMs.toFixed(1)} ms, reloaded ${r.reloaded.storeTimeMs.toFixed(0)}/${r.reloaded.graphTimeMs.toFixed(1)} ms, legacy ${r.legacy.storeTimeMs.toFixed(0)}/${r.legacy.graphTimeMs.toFixed(1)} ms`,
    );
  });

  // The third reader of the same value: what §8.5.6's own panel draws and §8.2 announces.
  // Added through the slot picker a user actually operates, rather than by reaching into the
  // store — and taken back out the same way, so the project is left as it was found.
  await step(`${label}: the insert panel announces the value the graph runs (spec §8.2, #131)`, async () => {
    await page.getByTestId('mode-tab-mixer').click();
    await page.getByTestId('mixer-tab').getByRole('radio', { name: 'Master' }).click();
    await page.getByTestId('mixer-inserts-master').click();
    const slots = page.locator('[data-testid^="insert-slot-"]');
    const before = await slots.count();
    await page.getByTestId('insert-add').selectOption('delay');
    // `addInsert` appends, so the slot this step created is the last one — and the master
    // chain may already carry inserts this step did not put there. Everything below is scoped
    // to that one list item rather than matched across the panel.
    const slot = slots.nth(before);
    const time = slot.getByRole('slider', { name: /^Time, insert \d+, Delay$/ });
    await time.waitFor({ timeout: 5_000 });
    const announced = await time.getAttribute('aria-valuetext');
    if (announced !== `${DELAY_DEFAULT_MS} ms`) {
      throw new Error(
        `the fresh delay's Time knob announces "${announced}" — the graph runs ${DELAY_DEFAULT_MS} ms`,
      );
    }
    const feedbackText = await slot
      .getByRole('slider', { name: /^Feedback, insert \d+, Delay$/ })
      .getAttribute('aria-valuetext');
    if (feedbackText !== '35 %') {
      throw new Error(`the fresh delay's Feedback knob announces "${feedbackText}" — the graph runs 35 %`);
    }
    console.log(`       insert panel: Time "${announced}", Feedback "${feedbackText}"`);
    // What this step added, it takes back, through §8.5.6's own Remove control — so no later
    // step mixes through an effect it did not ask for.
    await slot.getByRole('button', { name: /^Remove insert \d+, Delay$/ }).click();
    if ((await slots.count()) !== before) {
      throw new Error(`removing the added insert left ${await slots.count()} slots, not ${before}`);
    }
    await page.getByTestId('mode-tab-main').click();
  });

  // A pad's mixer strip is the §6 payload's own values wearing a §4.2 shape (issue #133), and
  // it used to be neither reachable nor persistent: no strip was published for a project just
  // loaded, so every control on §8.5.6's Pads tab did nothing; and where one did exist,
  // `flushProgram` serialised a program the edit had never reached. The bounce is what makes
  // the second half audible — a −12 dB pad fader, saved, reloaded, and heard in the file.
  //
  // It sits HERE, after the two §5.7 insert-defaults steps, because those end on a fresh
  // `loadProject` and so does this one — while the two steps below it do not, and the Grid
  // step reads the arrangement the §7.9 one leaves in the stores rather than the §9.3 rows.
  await step(`${label}: a pad's mixer strip is reachable and survives a reload (#133)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.padStripProof());
    if (!r.stripPresentOnLoad) {
      throw new Error(
        `no strip for ${r.padChannel} on a freshly loaded project — every control on the Pads tab is inert`,
      );
    }
    // A gesture that reached nothing would leave every number below at its default, so the
    // committed value is asserted first: without it the reload check could pass while proving
    // nothing at all.
    if (Math.abs(r.committedLevel - 0.8) > 0.001) {
      throw new Error(`the fader commit put the strip at ${r.committedLevel} — expected 0.8`);
    }
    if (Math.abs(r.reloadedLevel - 0.8) > 0.001) {
      throw new Error(`the strip read ${r.reloadedLevel} after a save and reload — expected 0.8`);
    }
    // §8.5.6's law maps 0.8 to −12 dB, which is 10^(-12/20) = 0.2512 of the amplitude.
    if (!(r.defaultRms > 0.01)) {
      throw new Error(`the unedited bounce is silent (${r.defaultRms.toFixed(5)} RMS) — nothing sounded`);
    }
    const ratio = r.reloadedRms / r.defaultRms;
    if (Math.abs(ratio - 0.2512) > 0.02) {
      throw new Error(
        `the reloaded bounce rendered at ${ratio.toFixed(4)} of the unedited one — a −12 dB pad fader is 0.2512`,
      );
    }
    for (const [where, reading] of [
      ['the §6 payload on disk', r.onDisk],
      ['the strip after a reload', r.afterReload],
    ]) {
      const wrong = [];
      if (Math.abs(reading.level - 0.8) > 0.001) wrong.push(`level ${reading.level}`);
      if (Math.abs(reading.pan + 0.5) > 0.001) wrong.push(`pan ${reading.pan}`);
      if (Math.abs(reading.send1 - 0.6) > 0.001) wrong.push(`send 2 ${reading.send1}`);
      if (reading.insertType !== 'delay') wrong.push(`insert ${String(reading.insertType)}`);
      if (Math.abs(reading.insertTimeMs - DELAY_DEFAULT_MS) > 0.001) {
        wrong.push(`insert time ${reading.insertTimeMs} ms`);
      }
      if (wrong.length > 0) throw new Error(`${where} carries ${wrong.join(', ')}`);
    }
    // §5.2 solo-in-place, now that a pad strip exists from the moment a project loads. A pad
    // channel feeds its track's input, so a solo judged across one group mutes every pad of
    // the soloed track and renders silence — the regression this work would otherwise ship.
    if (!(r.soloedTrackRms > r.defaultRms * 0.9)) {
      throw new Error(
        `soloing the track rendered ${r.soloedTrackRms.toFixed(5)} RMS against ${r.defaultRms.toFixed(5)} unsoloed — its own pads were muted (spec §5.2)`,
      );
    }
    console.log(
      `       pad strip: bounce ${r.defaultRms.toFixed(5)} → ${r.reloadedRms.toFixed(5)} RMS (×${ratio.toFixed(4)}) after a save and reload; disk and strip both read 0.8 / −0.5 / 0.6 / delay ${DELAY_DEFAULT_MS} ms; soloed track ${r.soloedTrackRms.toFixed(5)} RMS`,
    );
  });

  // A deleted track kept sounding until the project was reloaded (#137): the sender's events
  // subscriber never handled a removed key, where the automation subscriber beside it does,
  // so `removeTrack` told the worker nothing. The unit tests drive the core with an injected
  // clock; the wire is what they cannot reach, and the defect lived entirely on it.
  //
  // Two tracks sound the same pad in unison, so the master peak halves when one goes — an
  // audio measurement of "it stopped sounding" rather than an inspection (spec §11.2, §13.5).
  // The delete happens WHILE THE TRANSPORT ROLLS, which is the §7.1.4 lookahead case.
  //
  // It sits HERE, beside the pad-strip step, because both end on a fresh `loadProject` while
  // the two steps below do not — and the Grid step reads whatever arrangement the stores hold.
  await step(`${label}: a deleted track stops sounding and leaves nothing behind (#137)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.trackWithdrawalProof());
    // Nothing scheduled at all is a transport or engine failure, not a withdrawal that took
    // too much — and blaming the withdrawal for it would send the next person to the wrong file.
    if (r.scheduledBefore.length !== 2) {
      throw new Error(
        `${r.scheduledBefore.length} of 2 tracks sounded before the delete — the transport did not roll, so this proves nothing`,
      );
    }
    if (r.scheduledAfter.join(',') !== r.keptTrackId) {
      throw new Error(
        `the worker scheduled [${r.scheduledAfter.join(', ')}] a full lookahead after the delete — expected the surviving track alone (master peak ${r.masterPeakBefore.toFixed(5)} → ${r.masterPeakAfter.toFixed(5)})`,
      );
    }
    if (!(r.masterPeakBefore > 0.05)) {
      throw new Error(`the master bus was silent before the delete (peak ${r.masterPeakBefore.toFixed(5)})`);
    }
    if (!(r.masterPeakAfter > 0.01)) {
      throw new Error(
        `the master bus fell silent after the delete (peak ${r.masterPeakAfter.toFixed(5)}) — the surviving track went with it`,
      );
    }
    // The deleted track's pad is five times the surviving one's, so the peak should fall to
    // roughly a fifth. The bound is loose because this is a live meter reading rather than an
    // offline render; what it has to separate is "audibly quieter" from the ×1.0 the defect
    // gives, and the unequal levels are what buy that separation.
    const ratio = r.masterPeakAfter / r.masterPeakBefore;
    if (!(ratio < 0.45)) {
      throw new Error(
        `the master peak went ${r.masterPeakBefore.toFixed(5)} → ${r.masterPeakAfter.toFixed(5)} (×${ratio.toFixed(3)}) — the deleted track, five times the louder of the two, is still sounding`,
      );
    }
    if (r.stripRemains) throw new Error('the deleted track kept its §4.2 channel strip');
    // What the save left on disk. `midi_events` cascades from the `tracks` row; the other two
    // do not, and are the track's own to take (spec §7.5, §7.8, §9.3).
    const leftovers = [];
    if (r.trackRowRemains) leftovers.push('its §9.3 tracks row');
    if (r.eventRowsRemain > 0) leftovers.push(`${r.eventRowsRemain} midi_events rows`);
    if (r.automationRowsRemain > 0) leftovers.push(`${r.automationRowsRemain} automation_points rows`);
    if (r.grooveAssignmentRemains) leftovers.push('its §7.5 groove assignment in projects.payload');
    if (leftovers.length > 0) {
      throw new Error(`a project saved with the track deleted still carries ${leftovers.join(', ')}`);
    }
    console.log(
      `       track withdrawal: master peak ${r.masterPeakBefore.toFixed(5)} → ${r.masterPeakAfter.toFixed(5)} (×${ratio.toFixed(3)}) with the transport rolling; the worker scheduled ${r.scheduledBefore.length} tracks then 1; no row, event, lane, groove key or strip left behind`,
    );
  });

  // §7.9 makes song mode the way to play several sequences in order, which only means
  // something if sequence mode plays ONE. The unit tests drive the core with an injected
  // clock; the wire is what they cannot reach, and the defect lived on both sides of it —
  // the sender forwards every track in the project and the schedule path chose none of them.
  // The middle assertion is the one that says the fix is on the right side: an active-sequence
  // switch mid-transport sends `sequenceMeta` and no events, and the next window is right.
  await step(`${label}: sequence mode plays one sequence and erases in it alone (#132)`, async () => {
    const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.sequenceFilterProof());
    if (r.activeTicksBefore.join(',') !== '0,960,1920,2880') {
      throw new Error(`the probe wrote ticks [${r.activeTicksBefore.join(', ')}] — expected four beats`);
    }
    if (r.otherTicksBefore.join(',') !== '0,960,1920,2880') {
      throw new Error(`the second sequence lost notes before the erase: [${r.otherTicksBefore.join(', ')}]`);
    }
    // Nothing scheduled at all is a transport or engine failure, not a filter that took too
    // much — and blaming the filter for it would send the next person to the wrong file.
    if (r.scheduledBeforeSwitch.length === 0) {
      throw new Error('nothing was scheduled at all — the transport did not roll, so this proves nothing');
    }
    if (r.scheduledBeforeSwitch.join(',') !== r.activeTrackId) {
      throw new Error(
        `${r.scheduledBeforeSwitch.length} tracks sounded in sequence mode — only the active sequence's may`,
      );
    }
    if (r.scheduledAfterSwitch.join(',') !== r.otherTrackId) {
      throw new Error(
        `switching the active sequence mid-transport scheduled [${r.scheduledAfterSwitch.join(', ')}] — expected the new sequence's track alone`,
      );
    }
    const takenFromActive = r.activeTicksBefore.filter((tick) => !r.activeTicksAfter.includes(tick));
    if (takenFromActive.length === 0) {
      throw new Error('the held erase took nothing at all — the sweep reached no notes');
    }
    // The data-loss half: a pad held over Erase must not delete the same pad's notes out of a
    // sequence that is not playing, and `result.erased` reaches the store, so it would persist.
    if (r.otherTicksAfter.join(',') !== r.otherTicksBefore.join(',')) {
      throw new Error(
        `the erase deleted ticks [${r.otherTicksBefore.filter((t) => !r.otherTicksAfter.includes(t)).join(', ')}] from the sequence that was not playing`,
      );
    }
    console.log(
      `       sequence filter: scheduled 1 of 2 tracks, followed the switch, swept [${takenFromActive.join(', ')}] and left the other bar whole`,
    );
  });

  // Grid scroll and zoom are held outside React (spec §3.3, §8.4, issue #28). Driven through
  // real wheel events on the real canvas, with the frame time measured across them — §11.5's
  // budget is 60 fps, and a mode re-rendering per wheel event is what used to threaten it.
  await step(`${label}: Grid pans and zooms at 60 fps without React (spec §3.3, issue #28)`, async () => {
    await page.getByTestId('mode-tab-grid').click();
    await page.locator('[data-testid="grid-canvas"]').waitFor({ timeout: 5_000 });
    const readout = page.locator('[data-testid="grid-zoom-readout"]');
    const before = await readout.textContent();

    const result = await page.evaluate(async () => {
      const canvas = document.querySelector('[data-testid="grid-canvas"]');
      if (!canvas) throw new Error('no grid canvas');
      const box = canvas.getBoundingClientRect();
      const at = (init) =>
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
            ...init,
          }),
        );

      // Measure across the gesture, not around it: a frame the wheel handler blocked is the
      // cost being measured, and it only shows up if the sampling overlaps the events.
      const frames = [];
      let last = performance.now();
      let running = true;
      const sample = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      for (let event = 0; event < 120; event += 1) {
        at({ deltaX: 40, deltaY: 0 });
        if (event % 20 === 0) at({ deltaY: -1, ctrlKey: true });
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      running = false;
      await new Promise((resolve) => requestAnimationFrame(resolve));

      // Drop the first frame: it spans whatever happened before the loop began.
      const measured = frames.slice(1);
      measured.sort((a, b) => a - b);
      return {
        frames: measured.length,
        medianMs: measured[Math.floor(measured.length / 2)] ?? 0,
        worstMs: measured[measured.length - 1] ?? 0,
      };
    });

    const after = await readout.textContent();
    if (after === before) throw new Error(`the zoom readout never moved (stayed at ${before})`);
    if (result.frames < 10) throw new Error(`only ${result.frames} frames measured — too few to judge`);
    // 16.7 ms is 60 fps (spec §11.5). The median is the honest statistic here: a single
    // stalled frame in a headless run says more about the machine than about the code.
    if (!(result.medianMs < 16.7)) {
      throw new Error(
        `median frame time ${result.medianMs.toFixed(2)} ms across 120 wheel events — over the 60 fps budget`,
      );
    }
    console.log(
      `       grid gesture: ${result.frames} frames, median ${result.medianMs.toFixed(2)} ms, worst ${result.worstMs.toFixed(2)} ms`,
    );
    await page.getByTestId('mode-tab-main').click();
  });

  // Phase 6 proofs run once (dev section, last) — they exercise heavy WASM paths and mutate
  // project state (import re-hydrates a fresh project), so they run after the other assertions
  // and need not repeat under the offline reload.
  if (label === 'dev') {
    await step(`${label}: worklet WASM effects render (multibandComp, limiter) — spec §5.7`, async () => {
      const results = await page.evaluate(async () => {
        const probe = globalThis.__bangerboxAudioProbe;
        return {
          comp: await probe.renderEffect('multibandComp'),
          limiter: await probe.renderEffect('limiter'),
        };
      });
      for (const [fx, r] of Object.entries(results)) {
        if (!(r.outputRms > 0.0005) || !Number.isFinite(r.outputRms)) {
          throw new Error(`${fx} worklet rendered silence/NaN (rms ${r.outputRms})`);
        }
      }
    });

    await step(`${label}: sample pipeline — import, transient chop, time-stretch (spec §12)`, async () => {
      const result = await page.evaluate(() => globalThis.__bangerboxAudioProbe.samplePipelineProof());
      if (!(result.chops >= 3)) {
        throw new Error(`transient chop produced ${result.chops} slices — expected ≥ 3`);
      }
      // rate 0.5 stretches to about twice the length.
      if (!(result.stretchedRatio > 1.7 && result.stretchedRatio < 2.3)) {
        throw new Error(
          `time-stretch ratio ${result.stretchedRatio} (imported ${result.importedFrames}f → stretched ${result.stretchedFrames}f; expected ~2×)`,
        );
      }
    });

    // Every §9.5 bounce produces a file the user can get back (issue #104). Three of the four
    // wrote a correct WAV into OPFS and stopped, which no part of the UI can browse.
    await step(`${label}: every §9.5 bounce writes a file that can be read back (issue #104)`, async () => {
      const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.bounceReachProof());
      for (const [variant, bytes] of [
        ['sequence', r.sequenceBytes],
        ['song', r.songBytes],
        ['stem', r.stemBytes],
        ['resample', r.resampledBytes],
      ]) {
        // A WAV header alone is 44 bytes, so anything at or below that carries no audio.
        if (!(bytes > 44)) throw new Error(`the ${variant} bounce read back ${bytes} bytes`);
      }
      if (!r.resampledIsBrowsable) {
        throw new Error('the resampled sample is not listed by the library query the Browser runs');
      }
    });

    // A bounce is of the MIX, not of a dry sum of voices (issue #134). Each render below moves
    // one §5.2 stage and is read back from the WAV it wrote, so every number is what the user
    // would hear in the file. Un-fixed, all eight readings are the baseline.
    await step(`${label}: a §9.5 bounce renders the §5.2 mixer (issue #134)`, async () => {
      const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.bounceMixProof());
      if (!(r.baseline.rms > 0.01)) {
        throw new Error(`the baseline bounce rendered ${r.baseline.rms.toFixed(5)} RMS — nothing sounded`);
      }
      // Stage 5, the fader: 0.8 on the §8.5.6 law is −12 dB, so a quarter of the amplitude.
      const levelRatio = r.levelled.rms / r.baseline.rms;
      if (!(levelRatio > 0.18 && levelRatio < 0.33)) {
        throw new Error(
          `a −12 dB track fader rendered at ${levelRatio.toFixed(3)} of unity — expected about 0.25`,
        );
      }
      // Stage 5, pan: hard right empties the left channel outright.
      if (!(r.panned.leftRms < r.baseline.leftRms * 0.02)) {
        throw new Error(
          `a hard-right track left ${r.panned.leftRms.toFixed(5)} RMS in the left channel (baseline ${r.baseline.leftRms.toFixed(5)})`,
        );
      }
      if (!(r.panned.rightRms > r.baseline.rightRms)) {
        throw new Error('a hard-right track did not gain in the right channel');
      }
      // Stage 6, a track insert: a 100 Hz lowpass against a 1 kHz tone.
      if (!(r.inserted.rms < r.baseline.rms * 0.2)) {
        throw new Error(
          `a 100 Hz lowpass insert left ${(r.inserted.rms / r.baseline.rms).toFixed(3)} of a 1 kHz tone`,
        );
      }
      // Stages 7 and 8, a send and its return: the delayed copy lands where nothing else is.
      if (!(r.baseline.gapRms < 0.001)) {
        throw new Error(`the baseline is not silent between beats (${r.baseline.gapRms.toFixed(5)} RMS)`);
      }
      if (!(r.sent.gapRms > 0.01)) {
        throw new Error(`an open send returned ${r.sent.gapRms.toFixed(5)} RMS into the beat gap`);
      }
      // Stage 9, a §7.8 lane on the master fader: near silence at the bar's start, unity at
      // its end. The first beat must also be far below where the same beat sat unautomated.
      if (!(r.automated.firstBeatRms < r.baseline.firstBeatRms * 0.1)) {
        throw new Error(
          `the automated first beat rendered at ${(r.automated.firstBeatRms / r.baseline.firstBeatRms).toFixed(3)} of unautomated — the lane did not ramp`,
        );
      }
      if (!(r.automated.lastBeatRms > r.automated.firstBeatRms * 5)) {
        throw new Error(
          `the automation lane went ${r.automated.firstBeatRms.toFixed(5)} → ${r.automated.lastBeatRms.toFixed(5)} RMS across the bar`,
        );
      }
      // The other half of the §7.8 grammar: a lane on the track insert's own cutoff. It
      // addresses a slot 1-based over the §4.2 slot array, which is what the graph's chain
      // used to disagree with.
      if (!(r.insertAutomated.lastBeatRms > r.insertAutomated.firstBeatRms * 5)) {
        throw new Error(
          `an insert cutoff lane went ${r.insertAutomated.firstBeatRms.toFixed(5)} → ${r.insertAutomated.lastBeatRms.toFixed(5)} RMS — the §7.8 slot address reached no effect`,
        );
      }
      // §9.5's stem is post-insert, pre-master: the master strip is cut to −42 dB AND
      // lowpassed, so a full mix collapses where the stem of the same project does not.
      if (!(r.masteredMix.rms < r.sent.rms * 0.1)) {
        throw new Error(
          `the master strip left ${(r.masteredMix.rms / r.sent.rms).toFixed(3)} of the mix — stage 9 did not render`,
        );
      }
      const stemRatio = r.stem.rms / r.sent.rms;
      if (!(stemRatio > 0.9 && stemRatio < 1.1)) {
        throw new Error(
          `the stem rendered at ${stemRatio.toFixed(3)} of the pre-master mix — it is not pre-master`,
        );
      }
      // And the stem carries the return its own sends drove, or a stem set cannot sum to the mix.
      if (!(r.stem.gapRms > 0.01)) {
        throw new Error(`the stem dropped its send return (${r.stem.gapRms.toFixed(5)} RMS in the gap)`);
      }
      console.log(
        `       bounce mix: level ×${levelRatio.toFixed(3)}, insert ×${(r.inserted.rms / r.baseline.rms).toFixed(3)}, ` +
          `send gap ${r.sent.gapRms.toFixed(4)}, master lane ${r.automated.firstBeatRms.toFixed(4)} → ${r.automated.lastBeatRms.toFixed(4)}, ` +
          `insert lane ${r.insertAutomated.firstBeatRms.toFixed(4)} → ${r.insertAutomated.lastBeatRms.toFixed(4)}, ` +
          `stem ×${stemRatio.toFixed(3)} vs mastered ×${(r.masteredMix.rms / r.sent.rms).toFixed(4)}`,
      );
    });

    await step(`${label}: .mpcweb export/import round-trips a project (spec §12 exit)`, async () => {
      const result = await page.evaluate(() => globalThis.__bangerboxAudioProbe.packRoundTrip());
      if (!result.imported) throw new Error('import did not open a fresh project');
      if (!(result.samples >= 1)) {
        throw new Error(`imported project has ${result.samples} samples — expected ≥ 1`);
      }
    });

    await step(`${label}: factory kit merges and demo opens over the real path (spec §9.8)`, async () => {
      const r = await page.evaluate(() => globalThis.__bangerboxAudioProbe.factoryInstallProof());

      if (!(r.kits >= 3 && r.demos >= 3)) {
        throw new Error(`catalogue has ${r.kits} kits / ${r.demos} demos — expected ≥ 3 of each (§9.8)`);
      }
      // A kit contributes sound...
      if (!(r.programsAfter > r.programsBefore)) throw new Error('kit merge added no program');
      if (!(r.globalAfterKit > 0)) throw new Error('kit merge installed no samples (§9.1, §9.8)');
      if (!r.mergedSamplesReadable) throw new Error('an installed sample is missing or empty in OPFS (§9.1)');
      // ...into the SHARED library, not the project: factory audio is content-addressed so a
      // kit and the demo that plays it store one copy between them (spec §9.1, §9.8).
      if (r.samplesAfter !== r.samplesBefore) {
        throw new Error(
          `kit merge added project-scoped samples ${r.samplesBefore} → ${r.samplesAfter} (§9.8)`,
        );
      }
      if (r.globalAfterDemo !== r.globalAfterKit) {
        throw new Error(
          `demo re-stored its kit's audio: global samples ${r.globalAfterKit} → ${r.globalAfterDemo} (§9.8)`,
        );
      }
      // ...and never arrangement: the active project's sequences, tracks and song are
      // exactly as they were (spec §9.8).
      if (r.sequencesAfter !== r.sequencesBefore) {
        throw new Error(`kit merge changed sequence count ${r.sequencesBefore} → ${r.sequencesAfter}`);
      }
      if (r.tracksAfter !== r.tracksBefore) {
        throw new Error(`kit merge changed track count ${r.tracksBefore} → ${r.tracksAfter}`);
      }
      if (r.songEntriesAfter !== r.songEntriesBefore) {
        throw new Error(`kit merge changed song entries ${r.songEntriesBefore} → ${r.songEntriesAfter}`);
      }
      // A demo opens as a new, populated project.
      if (!r.demoOpenedNewProject) throw new Error('demo pack did not open a new project');
      if (!(r.demoSequences >= 1)) {
        throw new Error(`demo project has ${r.demoSequences} sequences — expected ≥ 1`);
      }
      // The demo's audio is in the shared library (asserted above), so the project itself owns
      // no sample rows — its programs point at the global copies (spec §9.1, §9.8).
      if (r.demoSamples !== 0) {
        throw new Error(
          `demo project owns ${r.demoSamples} sample rows — expected 0, they are global (§9.8)`,
        );
      }
    });
  }
}

async function main() {
  mkdirSync(artefactDir, { recursive: true });

  // The wasm artefact is gitignored — build it if absent so the smoke is
  // self-sufficient on a fresh checkout.
  if (!existsSync(resolve(root, 'src/core/dsp/dist/gainProof.wasm'))) {
    const wasm = spawnSync(process.execPath, [resolve(root, 'scripts/build-wasm.mjs')], {
      cwd: root,
      stdio: 'inherit',
    });
    if (wasm.status !== 0) throw new Error('build:wasm failed');
  }

  // Factory packs are a gitignored artefact too (spec §9.8) — build them if absent so the
  // smoke stays self-sufficient on a fresh checkout.
  if (!existsSync(resolve(root, 'public/factory/index.json'))) {
    // `--import` installs the generator's TS/alias resolution hook (spec §9.8), exactly as
    // the `build:factory` script does — without it the generator cannot resolve `@/`.
    const factory = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve(root, 'scripts/factory/register.mjs')).href,
        resolve(root, 'scripts/build-factory.mjs'),
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (factory.status !== 0) throw new Error('build:factory failed');
  }

  const browser = await launchBrowser();
  let devServer;
  let previewServer;
  let page;

  try {
    // ---- Section A: dev server --------------------------------------------------
    console.log('Section A — dev server');
    devServer = spawnVite(['--port', String(DEV_PORT), '--strictPort']);
    await waitForServer(DEV_URL);

    const devContext = await browser.newContext();
    await wireToastRecorder(devContext);
    page = await devContext.newPage();
    wireErrorCollectors(page);
    await page.goto(DEV_URL, { waitUntil: 'load' });
    await assertShellAndSelfTest(page, 'dev');

    await step('dev: second tab is blocked by the multi-tab guard', async () => {
      const page2 = await devContext.newPage();
      wireErrorCollectors(page2);
      await page2.goto(DEV_URL, { waitUntil: 'load' });
      const takeover = page2.getByTestId('already-open-takeover');
      await takeover.waitFor({ timeout: 15_000 });
      if (!(await takeover.isDisabled())) {
        throw new Error('take-over must stay disabled while the first tab owns the database');
      }
      await page2.close();
      // Ownership is proven from the storage diagnostics, which live in Q-Link Edit
      // (changelog 2026-07-18 (o)) — the first tab is left on Main by the gauge step, so
      // go back there. Remounting re-boots the worker, which only succeeds if this tab
      // still holds the database.
      await page.getByTestId('mode-tab-qlink-edit').click();
      await page.getByTestId('storage-diagnostics').locator('summary').click();
      const status = page.getByTestId('storage-panel-status');
      await status.and(page.locator('[data-status="ready"], [data-status="failed"]')).waitFor({
        timeout: 30_000,
      });
      if ((await status.getAttribute('data-status')) !== 'ready') {
        throw new Error('first tab lost database ownership to the second tab');
      }
    });

    await assertNoWarningToasts(page, 'dev');

    await devContext.close();
    devServer.kill();
    devServer = undefined;

    // ---- Section B: production build + preview (offline PWA shell) --------------
    // Skipped under --dev-only (the slow `vite build`); the default run keeps it as the
    // binding offline-PWA phase-exit proof (spec §11.4).
    if (devOnly) {
      console.log('Section B skipped (--dev-only).');
    } else {
      console.log('Section B — production preview + offline');
      const build = spawnSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });
      if (build.status !== 0) throw new Error('vite build failed');

      previewServer = spawnVite(['preview', '--port', String(PREVIEW_PORT), '--strictPort']);
      await waitForServer(PREVIEW_URL);

      const previewContext = await browser.newContext();
      await wireToastRecorder(previewContext);
      page = await previewContext.newPage();
      wireErrorCollectors(page);
      await page.goto(PREVIEW_URL, { waitUntil: 'load' });

      await step('preview: PWA manifest is linked and served', async () => {
        const href = await page.getAttribute('link[rel="manifest"]', 'href');
        if (!href) throw new Error('no <link rel="manifest"> in the document');
        const manifest = await page.evaluate(async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`manifest fetch ${response.status}`);
          return response.json();
        }, href);
        if (manifest.name !== 'BangerBox') throw new Error(`manifest name is ${manifest.name}`);
        if (manifest.display !== 'standalone') throw new Error('manifest display is not standalone');
      });

      await step('preview: service worker installs and takes control', async () => {
        await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
          timeout: 30_000,
        });
      });

      // Warm the factory runtime cache while still online, so the offline assertion below
      // tests the CACHE rather than merely re-testing the network (spec §9.8 "Caching").
      const warmedPack = await step('preview: factory content is runtime-cached (spec §9.8)', async () => {
        const result = await page.evaluate(async () => {
          const catalogue = await (await fetch('factory/index.json')).json();
          const first = catalogue[0];
          // Drain the body: an unread response stream is aborted by the reload below, which
          // the smoke's own console-hygiene check would (correctly) flag as an error.
          await (await fetch(`factory/${first.file}`)).arrayBuffer();
          const cache = await caches.open('bangerbox-factory-v1');
          return {
            file: first.file,
            catalogueCached: (await cache.match(new URL('factory/index.json', location.href).href)) != null,
            packCached: (await cache.match(new URL(`factory/${first.file}`, location.href).href)) != null,
          };
        });
        if (!result.catalogueCached) throw new Error('catalogue was not runtime-cached');
        if (!result.packCached) throw new Error(`${result.file} was not runtime-cached`);
        return result.file;
      });

      await previewContext.setOffline(true);
      await page.reload({ waitUntil: 'load' });

      await step('offline: factory catalogue and pack are served from cache (spec §9.8)', async () => {
        const result = await page.evaluate(async (file) => {
          const catalogue = await fetch('factory/index.json');
          const pack = await fetch(`factory/${file}`);
          return { catalogue: catalogue.ok, pack: pack.ok, bytes: (await pack.arrayBuffer()).byteLength };
        }, warmedPack);
        // With the network down these can only succeed from the dedicated factory cache —
        // which is also the proof it survived the §2.4 stale-precache prune on activate.
        if (!result.catalogue) throw new Error('factory catalogue is unavailable offline');
        if (!result.pack) throw new Error('factory pack is unavailable offline');
        if (!(result.bytes > 0)) throw new Error('cached factory pack is empty offline');
      });

      await assertShellAndSelfTest(page, 'offline');
      await assertNoWarningToasts(page, 'offline');
      await previewContext.setOffline(false);
      await previewContext.close();
    }

    // ---- Console hygiene --------------------------------------------------------
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      for (const text of consoleErrors) console.error(`  console error: ${text}`);
      for (const text of pageErrors) console.error(`  page error: ${text}`);
      throw new Error(`${consoleErrors.length + pageErrors.length} console/page error(s)`);
    }
    record('no console or page errors', true);

    console.log(`\nSmoke complete: ${results.filter((r) => r.ok).length}/${results.length} steps passed.`);
  } catch (error) {
    // Surface everything the page complained about before the failing step aborted.
    for (const text of consoleErrors) console.error(`  console error: ${text}`);
    for (const text of pageErrors) console.error(`  page error: ${text}`);
    if (page && !page.isClosed()) {
      const shot = resolve(artefactDir, `smoke-failure-${Date.now()}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.error(`Failure screenshot: ${shot}`);
      } catch {
        // page may already be unusable
      }
    }
    throw error;
  } finally {
    devServer?.kill();
    previewServer?.kill();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
