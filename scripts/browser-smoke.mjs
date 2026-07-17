// Real-browser smoke test for BangerBox — spec §11.4. Drives the system-installed Edge
// via Playwright (`channel: 'msedge'` — locked decision §1.3 #13, no browser download)
// against a live dev server AND a production preview:
//
//   Section A (dev server, COOP/COEP headers):
//     - `crossOriginIsolated === true`
//     - the app shell boots past the capability gate
//     - the engine self-test passes: worklet module loads as a real file and the WASM
//       kernel, transferred via processorOptions, processes audio inside the worklet
//       (spec §5.6.2)
//   Section B (production build + preview server):
//     - the PWA manifest is served and linked
//     - the service worker installs and takes control
//     - with the network offline, the shell reloads from the SW precache, stays
//       cross-origin isolated, and the engine self-test still passes (installable
//       offline PWA shell — Phase 0 exit criterion)
//
// Fails on any console error or page error.
//
//   node scripts/browser-smoke.mjs            # headless
//   node scripts/browser-smoke.mjs --headed   # watch it run
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
    await page.locator('h1', { hasText: 'BangerBox' }).waitFor({ timeout: 15_000 });
    await page.locator('h2', { hasText: 'Storage foundation' }).waitFor({ timeout: 15_000 });
  });

  // Phase 1 exit criterion (spec §12): the real-OPFS path — SQLite worker boot +
  // migrations, then a project row AND an OPFS file round-trip on this device.
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

  await step(`${label}: engine self-test proves the worklet + WASM transfer path`, async () => {
    await page.getByTestId('engine-self-test-run').click();
    const status = page.getByTestId('engine-self-test-status');
    await status.and(page.locator('[data-status="passed"], [data-status="failed"]')).waitFor({
      timeout: 20_000,
    });
    const outcome = await status.getAttribute('data-status');
    if (outcome !== 'passed') {
      const detail = await page.getByTestId('engine-self-test-detail').textContent();
      throw new Error(`self-test ${outcome}: ${detail}`);
    }
  });
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

    await devContext.close();
    devServer.kill();
    devServer = undefined;

    // ---- Section B: production build + preview (offline PWA shell) --------------
    console.log('Section B — production preview + offline');
    const build = spawnSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('vite build failed');

    previewServer = spawnVite(['preview', '--port', String(PREVIEW_PORT), '--strictPort']);
    await waitForServer(PREVIEW_URL);

    const previewContext = await browser.newContext();
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
    await previewContext.setOffline(false);
    await previewContext.close();

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
