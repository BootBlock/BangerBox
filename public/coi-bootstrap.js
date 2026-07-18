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
 */
(function () {
  // Already isolated (dev server, preview server, or a reload that the worker served).
  if (window.crossOriginIsolated) return;

  // Service workers need a secure context; file:// and plain http:// cannot isolate.
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  // Guard against a reload loop. If isolation still fails after one reload — a browser
  // without the APIs, or an extension stripping headers — stop, and let the capability
  // gate explain the problem rather than reloading the page forever.
  var RELOAD_KEY = 'bangerbox-coi-reloaded';
  if (sessionStorage.getItem(RELOAD_KEY)) return;

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (sessionStorage.getItem(RELOAD_KEY)) return;
    sessionStorage.setItem(RELOAD_KEY, '1');
    window.location.reload();
  });

  // Resolved against this script's own URL, so it follows the base path (`/BangerBox/`
  // on Pages, `/` locally) without the deploy having to rewrite anything.
  var swUrl = new URL('sw.js', document.currentScript.src).href;
  navigator.serviceWorker.register(swUrl).catch(function () {
    // Registration failed (private mode, blocked worker). Nothing to do: the capability
    // gate will report the missing isolation with its normal message.
  });
})();
