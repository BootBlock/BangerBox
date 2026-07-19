// GitHub Pages smoke test — spec §1.3 #14, §14 2026-07-18 (m).
//
// The regular browser smoke (browser-smoke.mjs) drives the dev and preview servers, and
// BOTH of those send COOP/COEP themselves. That cannot prove the Pages path works: on a
// static host the headers must come from the service worker instead. This script serves
// the production build from a deliberately header-less static server — the Pages
// condition — and asserts two things the deploy depends on:
//
//   A. With the service worker reachable: the page starts un-isolated, the bootstrap
//      registers the worker, one reload later `crossOriginIsolated === true` and the app
//      boots to the start gate. (The Pages deploy works.)
//   B. With the service worker NOT reachable (a browser that cannot isolate at all): the
//      §2.1 capability gate renders its explanation instead of a blank page. This is a
//      real regression guard — a module-scope `z.instanceof(SharedArrayBuffer)` used to
//      throw at import time here, taking the whole bundle down before the gate could run.
//
// Requires `npm run build` to have produced dist/ with the Pages base path:
//   BANGERBOX_BASE=/BangerBox/ npm run build && node scripts/pages-smoke.mjs
//
// Runs in CI on the windows-latest runner (`.github/workflows/tests.yml`, #15): like the
// browser smoke it drives the system-installed Edge (`channel: 'msedge'`, spec §1.3 #13)
// rather than downloading a browser, and only that image ships Edge.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(root, 'dist');
const BASE = '/BangerBox/';
const PORT = 5297;
const headed = process.argv.includes('--headed');
// Where the per-document isolation log lives inside the page. Namespaced away from the
// bootstrap's own sessionStorage reload guard.
const ISOLATION_LOG_KEY = '__bangerbox_smoke_isolation__';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Static server with NO COOP/COEP — the whole point. `blockServiceWorker` additionally
 * 404s the worker and its bootstrap, simulating a browser that cannot isolate.
 */
function serve({ blockServiceWorker }) {
  return createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
    if (blockServiceWorker && (pathname.endsWith('sw.js') || pathname.endsWith('coi-bootstrap.js'))) {
      res.writeHead(404).end();
      return;
    }
    if (!pathname.startsWith(BASE)) {
      res.writeHead(404).end();
      return;
    }
    let rel = pathname.slice(BASE.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = resolve(join(DIST, rel));
    // Path-traversal guard: never serve outside dist/.
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  });
}

async function withServer({ blockServiceWorker }, fn) {
  const server = serve({ blockServiceWorker });
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: !headed });
  // A fresh context each time: the sessionStorage reload guard and any installed worker
  // must not leak between the two scenarios.
  const context = await browser.newContext();
  const page = await context.newPage();
  // Kept apart on purpose. `pageErrors` are uncaught exceptions — always a defect.
  // `consoleErrors` include the 404s scenario B deliberately provokes by blocking the
  // worker, so that scenario asserts only on pageErrors.
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  try {
    return await fn(page, { pageErrors, consoleErrors });
  } finally {
    // Both teardowns always run: a browser that fails to close must not leave the port
    // held, or the next local run contends with this one's leftovers.
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(() => r()));
  }
}

/**
 * Runs one scenario, converting any throw into a recorded failure. The scenarios are
 * independent regression guards — B in particular guards §14 2026-07-18 (m) item 4 — so a
 * fault in one must never stop the other from running.
 */
async function scenario(name, options, fn) {
  try {
    await withServer(options, fn);
  } catch (error) {
    record(
      `scenario ${name} ran to completion`,
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ is missing — run `BANGERBOX_BASE=/BangerBox/ npm run build` first.');
  process.exit(1);
}

console.log(`Pages smoke — serving dist/ at http://localhost:${PORT}${BASE} with NO COOP/COEP\n`);

console.log('Scenario A — service worker available (the real Pages deploy)');
await scenario('A', { blockServiceWorker: false }, async (page, { pageErrors, consoleErrors }) => {
  // `crossOriginIsolated` is recorded from inside the page, once per document, before any
  // page script runs. Asking for it from the outside after `goto` races the bootstrap's
  // reload: when the reload wins, `evaluate` either throws (context destroyed) or reports
  // the *second* document's `true`, failing a check on an app that behaved perfectly.
  await page.addInitScript((key) => {
    try {
      const log = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      log.push(window.crossOriginIsolated);
      sessionStorage.setItem(key, JSON.stringify(log));
    } catch {
      // sessionStorage unavailable — the log check below will report the gap.
    }
  }, ISOLATION_LOG_KEY);
  await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: 'load' });

  let isolated = false;
  const deadline = Date.now() + 30_000;
  while (!isolated && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      isolated = await page.evaluate(() => window.crossOriginIsolated);
    } catch {
      // navigating mid-reload
    }
  }

  const log = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) ?? '[]'),
    ISOLATION_LOG_KEY,
  );
  record('first load is not yet isolated', log[0] === false, `documents: ${JSON.stringify(log)}`);
  record('service worker reload achieves cross-origin isolation', isolated);

  const text = await page.evaluate(() => document.body.innerText);
  record('app boots to the start gate', /Start BangerBox/i.test(text), text.slice(0, 80));
  const noise = [...pageErrors, ...consoleErrors];
  record('no console or page errors', noise.length === 0, noise[0] ?? '');
});

console.log('\nScenario B — cannot isolate at all (unsupported browser)');
await scenario('B', { blockServiceWorker: true }, async (page, { pageErrors }) => {
  await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2500));
  const text = await page.evaluate(() => document.body.innerText.trim());
  // Copy per §14 2026-07-18 (n): with only isolation missing the gate leads with the
  // reload it knows will fix it, rather than blaming the browser.
  record('capability gate renders instead of a blank page', /needs one more reload/i.test(text));
  record('gate names the missing isolation', /crossOriginIsolated/i.test(text));
  record('gate offers the troubleshooting guide', /troubleshooting guide/i.test(text));
  // Only uncaught exceptions count here: this scenario deliberately 404s the worker and
  // its bootstrap, so console 404s are the simulation working, not a defect.
  record('no uncaught import-time error', pageErrors.length === 0, pageErrors[0] ?? '');
});

const failed = results.filter((r) => !r.ok);
console.log(`\nPages smoke: ${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
