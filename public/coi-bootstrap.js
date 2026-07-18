/*
 * Cross-origin isolation bootstrap (spec §1.3 #14, §14 2026-07-18 (m)).
 *
 * On a static host that cannot send COOP/COEP — GitHub Pages — the service worker
 * (src/sw.ts) supplies those headers instead. But a service worker cannot affect the
 * response that loaded the page that registered it, so the FIRST visit is never
 * isolated. This script closes that gap: it registers the worker and reloads once, at
 * which point the worker is controlling and serves the shell with the headers attached.
 *
 * WHY THIS REGISTERS THE WORKER ITSELF, rather than only waiting for one:
 * src/main.tsx runs the §2.1 capability gate BEFORE mounting <App/>, and returns early
 * when a hard requirement is missing. `crossOriginIsolated` is a hard requirement, and
 * the PWA registration lives inside <App/> (usePwaUpdate). So on a fresh Pages visit the
 * gate would block, <App/> would never mount, the worker would never register, the
 * headers would never arrive, and the gate would block forever — a permanent deadlock
 * where every visitor sees "unsupported browser". Registering here breaks that cycle.
 * Registration is idempotent, so the app's own later registerSW() call is unaffected.
 *
 * Locally this is inert: the dev/preview server sets the headers, so the page is already
 * isolated and the first check returns immediately.
 *
 * THE THREE WAYS ISOLATION USED TO FAIL INTERMITTENTLY, and how each is handled now:
 *
 *   1. A controller was ALREADY present but the page still was not isolated — the
 *      navigation came from the HTTP/back-forward cache, so the worker never saw it and
 *      no `controllerchange` ever fired. The old code only ever reloaded from that
 *      event, so it waited for a signal that could not arrive. Now a live controller
 *      with no isolation triggers the reload directly.
 *   2. The reload guard was a one-shot flag, set before reloading and never cleared. One
 *      unlucky attempt therefore poisoned the WHOLE browsing session: every later
 *      navigation short-circuited on the flag and showed the gate, and only closing the
 *      tab fixed it. It is now an attempt COUNTER, cleared the moment isolation
 *      succeeds, so a transient failure costs one retry rather than a whole session.
 *   3. `sessionStorage` THROWS, rather than returning null, when storage is blocked
 *      (Firefox's "block cookies" setting, some private windows). That exception escaped
 *      and killed the bootstrap before `register()` was ever reached, so the worker was
 *      never installed at all. Every access now goes through try/catch.
 */
(function () {
  var ATTEMPT_KEY = 'bangerbox-coi-attempts';
  var MAX_ATTEMPTS = 2;

  // sessionStorage access throws outright when storage is blocked — never let that
  // escape, or the registration below never runs (failure mode 3).
  function readAttempts() {
    try {
      return parseInt(sessionStorage.getItem(ATTEMPT_KEY) || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  function writeAttempts(value) {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, String(value));
    } catch {
      /* Storage blocked: we lose the cross-reload guard, but `reloading` still bounds us
         within this page load, and the gate explains the problem if it persists. */
    }
  }

  function clearAttempts() {
    try {
      sessionStorage.removeItem(ATTEMPT_KEY);
    } catch {
      /* Nothing to clear if storage is unavailable. */
    }
  }

  // Already isolated (dev server, preview server, or a reload the worker served). Clear
  // the counter so a LATER transient failure still gets its full retry budget — leaving
  // it set is what turned one bad load into a broken session (failure mode 2).
  if (window.crossOriginIsolated) {
    clearAttempts();
    return;
  }

  // Service workers need a secure context; file:// and plain http:// cannot isolate.
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  // Stop after a bounded number of tries. If isolation still fails — a browser without
  // the APIs, or an extension stripping headers — let the capability gate explain the
  // problem rather than reloading forever.
  var attempts = readAttempts();
  if (attempts >= MAX_ATTEMPTS) return;

  var reloading = false;

  function reloadForIsolation() {
    if (reloading || window.crossOriginIsolated) return;
    reloading = true;
    writeAttempts(attempts + 1);
    window.location.reload();
  }

  // A worker taking control mid-load: reload so it can serve the shell with headers.
  navigator.serviceWorker.addEventListener('controllerchange', reloadForIsolation);

  // Resolved against this script's own URL, so it follows the base path (`/BangerBox/`
  // on Pages, `/` locally) without the deploy having to rewrite anything.
  var swUrl = new URL('sw.js', document.currentScript.src).href;
  navigator.serviceWorker.register(swUrl).catch(function () {
    // Registration failed (private mode, blocked worker). Nothing to do: the capability
    // gate will report the missing isolation with its normal message.
  });

  // The case `controllerchange` cannot cover (failure mode 1): a worker is already
  // active and controlling us, yet this response arrived without the headers because it
  // came from cache rather than through the worker. No event will ever fire, so hang off
  // the ready promise and reload from there instead.
  navigator.serviceWorker.ready
    .then(function () {
      if (navigator.serviceWorker.controller) reloadForIsolation();
    })
    .catch(function () {
      /* Never became ready; the gate reports the missing isolation. */
    });
})();
