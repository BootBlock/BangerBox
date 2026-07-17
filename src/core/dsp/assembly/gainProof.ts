// BangerBox `gainProof` kernel — the trivial Phase 0 AssemblyScript kernel proving the
// npm-only WASM toolchain (spec §1.3 #5) and the worklet-module-transfer path (§5.6.2).
// Compiled by `npm run build:wasm` with `--runtime stub -O3` (§2.7); buffer lifetimes
// are managed manually via heap.alloc/heap.free (§5.6.3). This file is AssemblyScript,
// not app TypeScript — it is excluded from tsc and ESLint.

/** Kernel state layout: a single f32 gain value at offset 0. */
const STATE_SIZE: usize = 4;

// spec §5.6.1 — kernel seam lifecycle: create(sampleRate, maxBlock, ...cfg) → handle.
// The trivial kernel needs neither value yet; the signature is the binding seam shape.
export function create(sampleRate: f32, maxBlock: i32): usize {
  const handle = heap.alloc(STATE_SIZE);
  store<f32>(handle, 1.0);
  return handle;
}

/** Kernel-specific parameter setter (spec §5.6.1). */
export function setGain(handle: usize, gain: f32): void {
  store<f32>(handle, gain);
}

/** Allocate an f32 I/O buffer of `frames` samples inside kernel linear memory. */
export function allocateBuffer(frames: i32): usize {
  return heap.alloc((<usize>frames) << 2);
}

/** Free a buffer allocated with allocateBuffer. */
export function freeBuffer(ptr: usize): void {
  heap.free(ptr);
}

// spec §5.6.1 — process(handle, inPtr, outPtr, frames).
export function process(handle: usize, inPtr: usize, outPtr: usize, frames: i32): void {
  const gain = load<f32>(handle);
  for (let i = 0; i < frames; i++) {
    const offset = (<usize>i) << 2;
    store<f32>(outPtr + offset, load<f32>(inPtr + offset) * gain);
  }
}

// spec §5.6.1 — free(handle) releases all kernel state.
export function free(handle: usize): void {
  heap.free(handle);
}
