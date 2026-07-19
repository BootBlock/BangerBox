// Capability-gate + COI-bootstrap smoke test — spec §2.1, §14 2026-07-18 (n).
//
// WHY THIS EXISTS SEPARATELY from browser-smoke.mjs and pages-smoke.mjs: both of those
// prove the app gets *past* the gate. Nothing exercised the gate itself, and nothing at
// all guarded the bootstrap's retry logic — which is precisely where the three (n)
// defects hid. Two of them were invisible to any test that only asserts the happy path,
// because they only bite on the SECOND load or when storage throws.
//
// Served from a deliberately header-less static server, the GitHub Pages condition, so
// isolation has to come from the service worker exactly as it does in production.
//
//   Section A — the gate's copy is specific and actionable (§2.1)
//   Section B — the bootstrap's retry logic, i.e. the (n) regression guards
//
// Requires a Pages-base production build:
//   BANGERBOX_BASE=/BangerBox/ npm run build && node scripts/gate-smoke.mjs
//
// Runs in CI on the windows-latest runner (`.github/workflows/tests.yml`, #15): like its
// sibling smokes it drives the system-installed Edge (`channel: 'msedge'`, spec §1.3 #13)
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
const PORT = 5296;
const URL_ = `http://localhost:${PORT}${BASE}`;
const headed = process.argv.includes('--headed');
const ATTEMPT_KEY = 'bangerbox-coi-attempts';

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

/** Static server with NO COOP/COEP — the Pages condition. */
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

async function withServer({ blockServiceWorker = false } = {}, fn) {
  const server = serve({ blockServiceWorker });
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: !headed });
  // A fresh context per scenario: an installed worker or a surviving attempt counter
  // leaking between scenarios would mask exactly the bugs under test.
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    return await fn(page, { pageErrors, context });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

/** Poll until the page reports isolation, or give up. Reloads race us, hence the catch. */
async function waitForIsolation(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      if (await page.evaluate(() => window.crossOriginIsolated)) return true;
    } catch {
      // navigating mid-reload
    }
  }
  return false;
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.trim());
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ is missing — run `BANGERBOX_BASE=/BangerBox/ npm run build` first.');
  process.exit(1);
}

console.log(`Gate smoke — serving dist/ at ${URL_} with NO COOP/COEP\n`);

// ---------------------------------------------------------------------------
console.log('Section A — the gate explains itself (§2.1)');

// A1: only isolation missing (worker blocked) ⇒ lead with the reload, not with blame.
await withServer({ blockServiceWorker: true }, async (page, { pageErrors }) => {
  await page.goto(URL_, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2500));
  const text = await bodyText(page);

  record('isolation-only failure leads with the reload', /needs one more reload/i.test(text));
  record(
    'offers a reload button',
    (await page.locator('[data-testid="capability-gate-reload"]').count()) === 1,
  );
  record('does not blame the browser', !/can’t start in this browser/i.test(text));

  // The whole point of (n)(3): per-item copy, not a blanket statement.
  record('names the requirement in plain English', /Secure isolated mode/i.test(text));
  record('says what it costs the user', /audio engine cannot start/i.test(text));
  record('gives a specific remedy', /ad blocker or privacy tool/i.test(text));
  record('keeps the API name for bug reports', /crossOriginIsolated/i.test(text));

  record('links to the troubleshooting guide', /troubleshooting guide/i.test(text));
  record('links to the wiki', /documentation wiki/i.test(text));
  record('links to the repo', /BangerBox on GitHub/i.test(text));
  record('offers diagnostics to copy', /copy diagnostics/i.test(text));
  record('no uncaught error', pageErrors.length === 0, pageErrors[0] ?? '');
});

// A2: a genuine capability gone ⇒ the reload shortcut must NOT be offered, because
// reloading cannot help and promising otherwise would just loop the user.
await withServer({ blockServiceWorker: true }, async (page) => {
  await page.addInitScript(() => {
    delete window.AudioWorkletNode;
  });
  await page.goto(URL_, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2500));
  const text = await bodyText(page);

  record(
    'genuine capability loss says the browser cannot start it',
    /can’t start in this browser/i.test(text),
  );
  record(
    'withholds the reload shortcut',
    (await page.locator('[data-testid="capability-gate-reload"]').count()) === 0,
  );
  record('explains the real-time audio requirement', /Real-time audio processing/i.test(text));
  record('tells the user to update the browser', /Update to the latest Microsoft Edge/i.test(text));
});

// ---------------------------------------------------------------------------
console.log('\nSection B — bootstrap retry logic (§14 2026-07-18 (n) regression guards)');

// B1: the happy path still works, AND the attempt counter is cleared afterwards.
// Defect (n)(1)(a) was precisely that the guard survived success and poisoned the
// session, so "is it gone once we are isolated?" is the assertion that catches it.
await withServer({}, async (page) => {
  await page.goto(URL_, { waitUntil: 'load' });
  const isolated = await waitForIsolation(page);
  record('service worker reload achieves isolation', isolated);

  const attempts = await page.evaluate((key) => sessionStorage.getItem(key), ATTEMPT_KEY);
  record('attempt counter is cleared once isolated', attempts === null, `counter=${attempts}`);

  const text = await bodyText(page);
  record('app boots past the gate', /Start BangerBox/i.test(text), text.slice(0, 60));
});

// B2: a stale counter from an earlier failed attempt must not permanently block a
// session that CAN isolate. Under the old one-shot flag this load stayed gated forever;
// the counter now leaves budget, and success clears it.
await withServer({}, async (page) => {
  await page.addInitScript((key) => sessionStorage.setItem(key, '1'), ATTEMPT_KEY);
  await page.goto(URL_, { waitUntil: 'load' });
  const isolated = await waitForIsolation(page);
  record('recovers from a stale attempt counter', isolated);

  const attempts = await page.evaluate((key) => sessionStorage.getItem(key), ATTEMPT_KEY);
  record('stale counter is cleared on recovery', attempts === null, `counter=${attempts}`);
});

// B3: sessionStorage that THROWS must not abort the bootstrap. Defect (n)(1)(c): the
// exception escaped before register() ran, so the worker never installed and isolation
// was unreachable — the failure looked like an unsupported browser.
await withServer({}, async (page) => {
  await page.addInitScript(() => {
    const boom = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => ({ getItem: boom, setItem: boom, removeItem: boom }),
    });
  });
  await page.goto(URL_, { waitUntil: 'load' });

  const registered = await page
    .evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg);
    })
    .catch(() => false);
  record('registers the worker even when storage throws', registered);
  record('still reaches isolation with storage blocked', await waitForIsolation(page));
});

const failed = results.filter((r) => !r.ok);
console.log(`\nGate smoke: ${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
