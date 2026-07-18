---
name: verify
description: Drive BangerBox in a real browser to observe a change working. Use when verifying UI or audio behaviour end to end, especially from inside a `.claude/worktrees/` worktree.
---

# Verifying BangerBox in a browser

`npm run test:e2e` (`scripts/browser-smoke.mjs`) is the §11.4 proof and the best
reference for driving the app — read it for selectors and the audio probe seam.
For verifying one change, write a throwaway Playwright driver instead; it is
faster and you control what gets captured.

## From a worktree, build and preview — the dev server will not work

Worktrees have no `node_modules` of their own (Node resolves up to the main
checkout). Vite's `server.fs.allow` is rooted at the worktree, so the dev server
serves `sqlite3.wasm` as an error page and the DB worker dies with:

```
CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 0a 20 20 20
```

The app still boots and the audio engine still starts, so this is easy to miss —
the symptom is the toast **"BangerBox could not open your project — storage may
be unavailable"** and an empty sample list.

Two things that look like fixes but are not: a `node_modules` junction (Vite
resolves the real path anyway, and it breaks Vitest's config resolution), and
widening `fs.allow` via a custom config (the wasm still does not serve).

What works — build and preview, which emits the wasm as a real `dist/` asset:

```sh
npx vite build          # skip `npm run build`; its build:wasm step needs assemblyscript
npx vite preview --port <free-port> --strictPort
```

The WASM DSP kernels are gitignored build artefacts that exist only in the main
checkout. Copy them in or the kernel unit tests fail spuriously:

```sh
cp ../../../src/core/dsp/dist/*.wasm src/core/dsp/dist/
```

## Driving

```js
const browser = await chromium.launch({ channel: 'msedge', headless: true });
await page.getByTestId('audio-start').click();                    // §5.1 start gate
await page.getByTestId('audio-engine-status')
  .and(page.locator('[data-status="running"]')).waitFor();
await page.getByTestId('mode-tab-browser').click();               // mode-tab-<mode id>
```

To get real samples into the library, merge a factory kit in Browser mode
(`[data-testid^="factory-install-"]`). It merges into the **open project**, so
wait for the DB to boot and auto-open one first — otherwise you get "Open a
project before installing a kit". The 808 kit yields 14 samples.

## Gotchas

- **Check the port is actually free.** A leftover server from an earlier run
  keeps serving the *old* build and the run silently verifies stale code; Vite
  prints "Port N is already in use" but the driver happily connects. Kill it:
  `Get-NetTCPConnection -LocalPort N -State Listen | Stop-Process -Id { $_.OwningProcess }`.
  Port 5199 (the smoke's default) is squatted by another local project.
- Pipe driver output to a file, not through `tail` — `tail` buffers everything
  until the stream ends, so you see nothing while it runs.
- Auditing a canvas beats eyeballing a screenshot: read `getImageData` back and
  count non-background pixels, so "drawn" and "blank" are distinguishable.
