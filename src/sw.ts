/// <reference lib="webworker" />
/**
 * BangerBox service worker — vite-plugin-pwa `injectManifest` strategy (spec §2.4).
 *
 * One custom worker, one responsibility: offline-first precaching of the static app
 * shell with an offline navigation fallback. Updates are prompt-based — a new build
 * installs but stays waiting until the user accepts the "Reload to update" toast, so
 * the page never reloads out from under an unsaved project.
 *
 * The SW MUST NOT intercept OPFS or blob URLs; it caches only the static app shell and
 * audio data never transits it (spec §2.4). Cross-origin isolation comes from the
 * dev/preview server headers (locked decision §1.3 #14) — precached responses retain
 * those headers, so the offline shell stays isolated too. Adapted from the proven
 * Gubbins worker (§13.6 reference-implementation rule).
 */

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const sw = self as unknown as ServiceWorkerGlobalScope;

// `self.__WB_MANIFEST` is the injection point vite-plugin-pwa replaces at build time.
// De-duplicate by URL: the manifest can list the same asset twice (precache glob +
// webmanifest icon injection) and `cache.addAll` REJECTS on duplicate requests, which
// would abort install and leave the worker redundant (lesson from Gubbins).
const PRECACHE_URLS = [
  ...new Set((self as unknown as { __WB_MANIFEST: PrecacheEntry[] }).__WB_MANIFEST.map((entry) => entry.url)),
];

const CACHE = 'bangerbox-precache-v1';
const INDEX_URL = 'index.html';

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
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
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
 * A worker's `self.location` comes from the RESPONSE URL, not the request URL. An
 * `ignoreSearch` cache hit returns the query-less stored response, which silently
 * strips `?vfs=opfs` from sqlite-wasm's OPFS async-proxy worker offline and breaks
 * the whole database (the proxy throws "Expecting vfs=… URL argument"). Re-wrapping
 * the body in a fresh Response clears `response.url`, making the browser fall back
 * to the request URL — query preserved (same mechanism as the proven Gubbins SW).
 */
function preserveRequestUrl(cached: Response, request: Request): Response {
  if (cached.url === '' || cached.url === request.url) return cached;
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

async function respond(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);

  // App navigations resolve to the precached shell (offline-first).
  if (request.mode === 'navigate') {
    const index = await cache.match(INDEX_URL, MATCH_OPTIONS);
    if (index) return index;
  }

  const cached = await cache.match(request, MATCH_OPTIONS);
  if (cached) return preserveRequestUrl(cached, request);

  try {
    return await fetch(request);
  } catch {
    // The shell fallback applies to NAVIGATIONS only — serving index.html for a failed
    // script/asset request would hand a module loader text/html (strict MIME failure).
    if (request.mode === 'navigate') {
      const fallback = await cache.match(INDEX_URL, MATCH_OPTIONS);
      if (fallback) return fallback;
    }
    return Response.error();
  }
}
