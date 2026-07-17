/**
 * Kernel module loader — spec §5.6.2. Worklet global scope has no fetch, so the main
 * thread fetches and compiles each kernel's WebAssembly.Module exactly once (cached)
 * and passes it to processors via processorOptions (structured clone of
 * WebAssembly.Module is supported cross-thread).
 */
const moduleCache = new Map<string, Promise<WebAssembly.Module>>();

export function loadKernelModule(url: URL): Promise<WebAssembly.Module> {
  const key = url.href;
  const cached = moduleCache.get(key);
  if (cached) return cached;

  const compiled = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Kernel module fetch failed (${response.status}) for ${url.href}`);
    }
    return WebAssembly.compile(await response.arrayBuffer());
  })();

  // Cache the promise so concurrent callers share one compile; drop it on failure so a
  // transient fetch error can be retried.
  moduleCache.set(key, compiled);
  compiled.catch(() => moduleCache.delete(key));
  return compiled;
}
