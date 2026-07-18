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
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const DEV_PORT = 5199;
const PREVIEW_PORT = 5198;
const DEV_URL = `http://localhost:${DEV_PORT}/`;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const headed = process.argv.includes('--headed');
// --dev-only: run just Section A (dev server) for fast iteration — skips the production
// `vite build` + preview + offline reload (Section B), the slowest part. The default (full)
// run remains the binding phase-exit proof (spec §11.4/§13.5). All Phase 6 proofs (sample
// pipeline, .mpcweb round-trip, worklet effects) already run in the dev section.
const devOnly = process.argv.includes('--dev-only');
const artefactDir = resolve(root, 'scripts/smoke-artefacts');

const results = [];
const consoleErrors = [];
const pageErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    await fn();
    record(name, true);
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
 * 2026-07-18 (o)).
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
  // migrations, then a project row AND an OPFS file round-trip on this device. From
  // Phase 7 these diagnostics live in Main mode (spec §8.5.1), behind the start gate.
  await step(`${label}: database worker boots on the OPFS VFS with schema v1`, async () => {
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
        Number(
          document.querySelector('[data-testid="meter-master"]')?.getAttribute('aria-valuenow') ?? '0',
        );
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
      throw new Error(`heap grew ${Math.round((after - before) / 1048576)} MiB across churn — possible node leak`);
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
    const { soft, hard } = await page.evaluate(() =>
      globalThis.__bangerboxAudioProbe.velocityLayerPitches(),
    );
    if (!(soft > 0) || !(hard > 0)) throw new Error(`layer render silent (soft ${soft}, hard ${hard})`);
    // Hard layer is tuned +12 semitones → about one octave (2×) above the soft layer.
    const ratio = hard / soft;
    if (!(ratio > 1.8 && ratio < 2.2)) {
      throw new Error(`velocity did not switch layers: hard/soft pitch ratio ${ratio.toFixed(3)} (expected ~2)`);
    }
  });

  await step(`${label}: keygroup repitches accurately across an octave (spec §12)`, async () => {
    const { root, octave } = await page.evaluate(() =>
      globalThis.__bangerboxAudioProbe.keygroupPitches(),
    );
    if (!(root > 0) || !(octave > 0)) throw new Error(`keygroup render silent (root ${root}, octave ${octave})`);
    const ratio = octave / root;
    if (!(ratio > 1.94 && ratio < 2.06)) {
      throw new Error(`keygroup octave pitch ratio ${ratio.toFixed(3)} (expected ~2.0)`);
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
    await page.waitForFunction(
      () => (globalThis.__bangerboxAudioProbe?.playheadTick() ?? 0) > 0,
      undefined,
      { timeout: 6_000 },
    );
    await page.getByTestId('transport-play').click(); // stop
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
      if (!(result.chops >= 3)) throw new Error(`transient chop produced ${result.chops} slices — expected ≥ 3`);
      // rate 0.5 stretches to about twice the length.
      if (!(result.stretchedRatio > 1.7 && result.stretchedRatio < 2.3)) {
        throw new Error(
          `time-stretch ratio ${result.stretchedRatio} (imported ${result.importedFrames}f → stretched ${result.stretchedFrames}f; expected ~2×)`,
        );
      }
    });

    await step(`${label}: .mpcweb export/import round-trips a project (spec §12 exit)`, async () => {
      const result = await page.evaluate(() => globalThis.__bangerboxAudioProbe.packRoundTrip());
      if (!result.imported) throw new Error('import did not open a fresh project');
      if (!(result.samples >= 1)) throw new Error(`imported project has ${result.samples} samples — expected ≥ 1`);
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
      const status = await page.getByTestId('storage-panel-status').getAttribute('data-status');
      if (status !== 'ready') throw new Error('first tab lost database ownership to the second tab');
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

      await previewContext.setOffline(true);
      await page.reload({ waitUntil: 'load' });
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
