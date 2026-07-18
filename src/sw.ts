/// <reference lib="webworker" />
/**
 * BangerBox service worker — vite-plugin-pwa `injectManifest` strategy (spec §2.4).
 *
 * One custom worker, two responsibilities:
 *   1. Offline-first precaching of the static app shell, with an offline navigation
 *      fallback. Updates are prompt-based — a new build installs but stays waiting until
 *      the user accepts the "Reload to update" toast, so the page never reloads out from
 *      under an unsaved project.
 *   2. Injecting the cross-origin isolation headers on every response it serves, so
 *      SharedArrayBuffer and the SQLite OPFS VFS work on a static host that cannot send
 *      headers of its own — GitHub Pages (spec §1.3 #14, §14 2026-07-18 (m)). Locally
 *      the dev/preview server already sets them and this is simply idempotent.
 *
 * The SW MUST NOT intercept OPFS or blob URLs; it caches only the static app shell and
 * audio data never transits it (spec §2.4).
 */

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const sw = self as unknown as ServiceWorkerGlobalScope;

// `self.__WB_MANIFEST` is the injection point vite-plugin-pwa replaces at build time.
// De-duplicate by URL: the manifest can list the same asset twice (precache glob +
// webmanifest icon injection) and `cache.addAll` REJECTS on duplicate requests, which
// would abort install and leave the worker redundant.
const PRECACHE_URLS = [
  ...new Set((self as unknown as { __WB_MANIFEST: PrecacheEntry[] }).__WB_MANIFEST.map((entry) => entry.url)),
];

const CACHE = 'bangerbox-precache-v1';
const INDEX_URL = 'index.html';

/**
 * Factory content cache (spec §9.8 "Caching"). Packs and the catalogue are runtime-cached
 * cache-first in their OWN cache, deliberately separate from the precache: the §2.4
 * precache glob covers neither `.wav` nor `.mpcweb` and is NOT widened, and keeping factory
 * content out of `CACHE` means `pruneStalePrecache` — which deletes anything not in the
 * current build manifest — cannot evict it.
 */
const FACTORY_CACHE = 'bangerbox-factory-v1';

/** Caches this worker owns; every other cache is a previous build's and is swept on activate. */
const OWNED_CACHES = new Set([CACHE, FACTORY_CACHE]);

/** URL prefix of the factory directory, resolved against the deployment base path. */
const FACTORY_PREFIX = new URL('factory/', sw.location.href).pathname;

sw.addEventListener('install', (event) => {
  // A genuine update (an active worker exists) stays waiting until the user accepts
  // the in-app prompt. The very first install has no session to protect, so it
  // activates immediately.
  event.waitUntil(
    (async () => {
      await caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS));
      if (!sw.registration.active) await sw.skipWaiting();
    })(),
  );
});

// The page (vite-plugin-pwa's `prompt` handshake, driven by the "Reload to update"
// toast) posts SKIP_WAITING to hand control to the waiting worker.
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void sw.skipWaiting();
  }
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !OWNED_CACHES.has(key)).map((key) => caches.delete(key)));
      await pruneStalePrecache();
      await sw.clients.claim();
    })(),
  );
});

/**
 * Drop precache entries left behind by previous builds: the cache name is stable
 * across releases (the offline shell survives an update) and every build emits new
 * content-hashed URLs, so superseded assets would otherwise linger forever and eat
 * into the storage quota the app meters (spec §9.7).
 */
async function pruneStalePrecache(): Promise<void> {
  const cache = await caches.open(CACHE);
  const wanted = new Set(PRECACHE_URLS.map((url) => new URL(url, sw.location.href).href));
  const cached = await cache.keys();
  await Promise.all(
    cached.filter((request) => !wanted.has(request.url)).map((request) => cache.delete(request)),
  );
}

sw.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Static app shell only — same-origin http(s). blob:/OPFS/data traffic never reaches
  // respondWith (spec §2.4).
  if (url.origin !== sw.location.origin) return;
  event.respondWith(respond(event.request));
});

// `ignoreVary` matters: the precache was populated by install-time fetches with no
// Origin header, while the page's `crossorigin` module-script requests carry one — a
// `Vary` response header from the server would otherwise make every offline script
// lookup miss. The precache is fully same-origin, so ignoring Vary is safe.
const MATCH_OPTIONS: CacheQueryOptions = { ignoreSearch: true, ignoreVary: true };

/**
 * Re-wrap a response with the cross-origin isolation headers (spec §1.3 #14).
 *
 * COOP/COEP are what make `crossOriginIsolated` true, which the §2.1 capability gate
 * treats as a HARD requirement; CORP is set so the app's own subresources remain
 * loadable under `require-corp`.
 *
 * This also subsumes the response-URL fix that used to live in `preserveRequestUrl`: a
 * worker's `self.location` comes from the RESPONSE URL, not the request URL, so an
 * `ignoreSearch` cache hit would otherwise strip `?vfs=opfs` from sqlite-wasm's OPFS
 * async-proxy worker offline and break the whole database (the proxy throws "Expecting
 * vfs=… URL argument"). Constructing a fresh Response clears `response.url`, making the
 * browser fall back to the request URL with its query intact.
 */
function withIsolationHeaders(response: Response): Response {
  // Opaque and error responses have an immutable, unreadable body — rewrapping one
  // would replace a real cross-origin result with a broken same-origin copy.
  if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Cache-first handling for factory packs and the catalogue (spec §9.8 "Caching").
 *
 * Cache-first, not stale-while-revalidate: pack archives are immutable build artefacts, so
 * a hit is always correct and a background revalidation would re-download megabytes for
 * nothing. Only successful responses are stored — caching an error would make a transient
 * network failure permanent, and §8.5 item 7 requires a fetch failure to stay retryable.
 */
async function respondFactory(request: Request): Promise<Response> {
  const cache = await caches.open(FACTORY_CACHE);
  const cached = await cache.match(request);
  if (cached) return withIsolationHeaders(cached);

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return withIsolationHeaders(response);
}

async function respond(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.startsWith(FACTORY_PREFIX)) {
    return respondFactory(request);
  }

  const cache = await caches.open(CACHE);

  // App navigations resolve to the precached shell (offline-first).
  if (request.mode === 'navigate') {
    const index = await cache.match(INDEX_URL, MATCH_OPTIONS);
    if (index) return withIsolationHeaders(index);
  }

  const cached = await cache.match(request, MATCH_OPTIONS);
  if (cached) return withIsolationHeaders(cached);

  try {
    return withIsolationHeaders(await fetch(request));
  } catch {
    // The shell fallback applies to NAVIGATIONS only — serving index.html for a failed
    // script/asset request would hand a module loader text/html (strict MIME failure).
    if (request.mode === 'navigate') {
      const fallback = await cache.match(INDEX_URL, MATCH_OPTIONS);
      if (fallback) return withIsolationHeaders(fallback);
    }
    return Response.error();
  }
}
