// Tests for scripts/check-orphans.mjs (spec §3.4). Each case builds a throwaway source
// tree and sweeps it with the real `collectOrphans`, so the module resolver and the
// barrel edges are exercised exactly as they will be by `npm run check:orphans`. The
// sweep runs in-process: spawning a `node` per case loads the TypeScript compiler a
// dozen times over and made the suite flaky under load. One case shells out to cover the
// exit code, which is the only part the function itself does not decide.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectOrphans } from './check-orphans.mjs';

// Resolved from the Vitest root rather than `import.meta.url`: the runner rewrites module
// URLs to its own scheme, so `fileURLToPath` on them throws.
const script = resolve(process.cwd(), 'scripts/check-orphans.mjs');
const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/** Write a fixture tree (paths relative to the fixture root) and return its root. */
function fixture(files, allowlistEntries = []) {
  const root = mkdtempSync(join(tmpdir(), 'orphans-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  mkdirSync(resolve(root, 'scripts'), { recursive: true });
  writeFileSync(
    resolve(root, 'scripts/check-orphans.allowlist.json'),
    JSON.stringify({ comment: 'test fixture', exports: allowlistEntries }),
  );
  return root;
}

/** Sweep a fixture and return just the orphan names, for terse assertions. */
const names = (root) => collectOrphans(root).orphans.map((orphan) => orphan.name);

// Generous timeout: each case writes a fixture tree to the temp directory and parses it
// with the TypeScript compiler. That is milliseconds on an idle machine, but the full
// suite runs these alongside 120 other files (several of them building wasm), and the
// 5s default is not enough headroom under that contention.
describe('check:orphans', { timeout: 30_000 }, () => {
  it('flags an export nothing imports', () => {
    const root = fixture({
      'src/main.tsx': `import { used } from './helpers';\nused();\n`,
      'src/helpers.ts': `export function used() {}\nexport function speculative() {}\n`,
    });
    expect(names(root)).toEqual(['speculative']);
  });

  it('does not flag a symbol re-exported through a barrel and consumed elsewhere', () => {
    const root = fixture({
      'src/main.tsx': `import { helper } from './feature';\nhelper();\n`,
      'src/feature/index.ts': `export { helper } from './helper';\n`,
      'src/feature/helper.ts': `export function helper() {}\n`,
    });
    expect(names(root)).toEqual([]);
  });

  it('resolves the same through `export *` and chained barrels', () => {
    const root = fixture({
      'src/main.tsx': `import { deep } from './feature';\ndeep();\n`,
      'src/feature/index.ts': `export * from './inner';\n`,
      'src/feature/inner/index.ts': `export * from './deep';\n`,
      'src/feature/inner/deep.ts': `export function deep() {}\n`,
    });
    expect(names(root)).toEqual([]);
  });

  it('does not let a barrel launder an otherwise unused export', () => {
    const root = fixture({
      'src/main.tsx': `import { helper } from './feature';\nhelper();\n`,
      'src/feature/index.ts': `export { helper } from './helper';\nexport { orphan } from './orphan';\n`,
      'src/feature/helper.ts': `export function helper() {}\n`,
      'src/feature/orphan.ts': `export function orphan() {}\n`,
    });
    const { orphans } = collectOrphans(root);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ file: 'src/feature/orphan.ts', name: 'orphan' });
  });

  it('does not let `export *` launder an unused export either', () => {
    const root = fixture({
      'src/main.tsx': `import { helper } from './feature';\nhelper();\n`,
      'src/feature/index.ts': `export * from './helper';\n`,
      'src/feature/helper.ts': `export function helper() {}\nexport function orphan() {}\n`,
    });
    expect(names(root)).toEqual(['orphan']);
  });

  it('still counts an export as an orphan when only a test imports it', () => {
    const root = fixture({
      'src/main.tsx': `import { used } from './helpers';\nused();\n`,
      'src/helpers.ts': `export function used() {}\nexport function testOnly() {}\n`,
      'src/helpers.test.ts': `import { testOnly } from './helpers';\ntestOnly();\n`,
    });
    const { orphans } = collectOrphans(root);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ name: 'testOnly', testOnly: true });
  });

  it('passes when the orphan is allowlisted', () => {
    const files = {
      'src/main.tsx': `import { used } from './helpers';\nused();\n`,
      'src/helpers.ts': `export function used() {}\nexport function maths() {}\n`,
      'src/helpers.test.ts': `import { maths } from './helpers';\nmaths();\n`,
    };
    expect(names(fixture(files))).toEqual(['maths']);

    const result = collectOrphans(
      fixture(files, [
        { file: 'src/helpers.ts', export: 'maths', reason: 'pure helper reached by its unit test' },
      ]),
    );
    expect(result.orphans).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.allowedCount).toBe(1);
  });

  it('reports an allowlist entry that is no longer an orphan', () => {
    const root = fixture(
      {
        'src/main.tsx': `import { used } from './helpers';\nused();\n`,
        'src/helpers.ts': `export function used() {}\n`,
      },
      [{ file: 'src/helpers.ts', export: 'used', reason: 'stale' }],
    );
    const { orphans, stale } = collectOrphans(root);
    expect(orphans).toEqual([]);
    expect(stale).toEqual(['src/helpers.ts#used']);
  });

  it('ignores type-only exports and type-only re-exports', () => {
    const root = fixture({
      'src/main.tsx': `import { used } from './helpers';\nused();\n`,
      'src/helpers.ts': `export type Unused = { a: number };\nexport interface AlsoUnused { b: string }\nexport function used() {}\n`,
      'src/types.ts': `export type { Unused } from './helpers';\n`,
    });
    expect(names(root)).toEqual([]);
  });

  it('treats entry points, workers and worklets as live', () => {
    const root = fixture({
      'src/main.tsx': `export function bootstrap() {}\nbootstrap();\n`,
      'src/sw.ts': `export const CACHE = 'v1';\n`,
      'src/audio/peak.worker.ts': `export const handler = () => {};\n`,
      'src/audio/meter.worklet.ts': `export const processor = 1;\n`,
    });
    expect(names(root)).toEqual([]);
  });

  it('treats a namespace import as consuming the whole module surface', () => {
    const root = fixture({
      'src/main.tsx': `import * as helpers from './helpers';\nhelpers.a();\n`,
      'src/helpers.ts': `export function a() {}\nexport function b() {}\n`,
    });
    expect(names(root)).toEqual([]);
  });

  it('resolves the @/ alias', () => {
    const root = fixture({
      'src/main.tsx': `import { helper } from '@/lib/helper';\nhelper();\n`,
      'src/lib/helper.ts': `export function helper() {}\n`,
    });
    expect(names(root)).toEqual([]);
  });

  it('does not count a module using its own export internally as a use', () => {
    const root = fixture({
      'src/main.tsx': `import { outer } from './helpers';\nouter();\n`,
      'src/helpers.ts': `export const STEP = 2;\nexport function outer() {\n  return STEP;\n}\n`,
    });
    expect(names(root)).toEqual(['STEP']);
  });

  it('flags a default-exported component nothing imports', () => {
    const root = fixture({
      'src/main.tsx': `import App from './App';\nApp();\n`,
      'src/App.tsx': `export default function App() {\n  return null;\n}\n`,
      'src/Stray.tsx': `export default function Stray() {\n  return null;\n}\n`,
    });
    expect(names(root)).toEqual(['default']);
  });

  it('exits 1 and names the orphan when run as a command', () => {
    const root = fixture({
      'src/main.tsx': `import { used } from './helpers';\nused();\n`,
      'src/helpers.ts': `export function used() {}\nexport function speculative() {}\n`,
    });
    let code = 0;
    let output = '';
    try {
      output = execFileSync('node', [script, root], { encoding: 'utf8' });
    } catch (error) {
      code = error.status;
      output = `${error.stdout}${error.stderr}`;
    }
    expect(code).toBe(1);
    expect(output).toContain('check:orphans FAILED');
    expect(output).toContain('`speculative`');
  });

  it('exits 0 with a summary when the tree is clean', () => {
    const root = fixture({
      'src/main.tsx': `import { used } from './helpers';\nused();\n`,
      'src/helpers.ts': `export function used() {}\n`,
    });
    const output = execFileSync('node', [script, root], { encoding: 'utf8' });
    expect(output).toContain('check:orphans OK');
  });
});
