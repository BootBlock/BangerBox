// check:orphans — spec §3.4. "Every exported function, store, or component is imported
// and used within the live application tree. No speculative exports." This script fails
// on any runtime export in `src` that nothing in the live tree imports.
//
// Why the TypeScript compiler API rather than regular expressions over import lines:
// barrels. `src/**/index.ts` files re-export with `export { X } from './x'` and
// `export * from './x'`, so a grep for `X` finds a hit in the barrel and every orphan
// behind a barrel launders itself clean. Resolving specifiers properly (including the
// `@/*` alias from tsconfig.app.json, extensionless paths and directory `index` files)
// and modelling re-exports as *conditional* uses is the only way to get the right answer,
// and the compiler ships the resolver already. Only the parser and module resolver are
// used — no type checker, no full program — so the sweep stays fast.
//
// The model is a graph over (file, exportName) nodes:
//   - a plain `import { X } from './x'` in a live file is a direct use of (x.ts, X);
//   - an `export { X } from './x'` in a barrel is *not* a use. It is an edge: (x.ts, X)
//     counts as used only once something else uses the barrel's own X. A barrel cannot
//     launder an orphan into looking consumed;
//   - `import * as ns` and `import('./x')` mark every export of the target used, because
//     the property actually read is not knowable without the checker. Conservative on
//     purpose: a missed orphan is cheaper than a false accusation.
// The used-set is then closed over the re-export edges to a fixpoint.
//
// "Live application tree" excludes `*.test.ts(x)` and `src/test/**`. An export that only
// a test imports is precisely the speculative export §3.4 targets — if it is deliberate
// (a pure helper exposed so a test can reach it while its own module uses it internally)
// it belongs in scripts/check-orphans.allowlist.json with a reason, not in the code
// unremarked.
//
// The sweep is exposed as `collectOrphans(root)` so the test suite can drive it over
// fixture trees in-process; running this file directly reports and sets the exit code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

// Computed lazily and defensively: when Vitest imports this module for its own tests it
// rewrites `import.meta.url` to a non-file scheme, and `fileURLToPath` then throws. Those
// tests always pass an explicit fixture root, so the fallback is never the answer they use.
function defaultRoot() {
  try {
    return fileURLToPath(new URL('..', import.meta.url));
  } catch {
    return resolve(process.cwd());
  }
}

// Entry points are loaded by path, not by import, so nothing imports them and their
// exports cannot be judged by the graph.
//   - src/main.tsx      — `<script type="module">` in index.html
//   - src/sw.ts         — vite-plugin-pwa injectManifest (srcDir 'src', filename 'sw.ts')
//   - *.worker.ts       — `new Worker(new URL('./x.worker.ts', import.meta.url))`
//   - *.worklet.ts      — AudioWorklet modules, pulled in via Vite's `?worker&url`
//                         suffix, which is a real-file reference the resolver cannot see
//   - *.d.ts            — declarations only; no runtime surface at all
const entryFiles = new Set(['src/main.tsx', 'src/sw.ts']);
const isEntry = (rel) =>
  entryFiles.has(rel) || rel.endsWith('.worker.ts') || rel.endsWith('.worklet.ts') || rel.endsWith('.d.ts');

const isTest = (rel) => /\.test\.tsx?$/.test(rel) || rel.startsWith('src/test/');

function* walk(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    // `.claude/worktrees` and `dist` hold whole copies of `src`; sweeping them would
    // double-count every module. `assembly` is AssemblyScript, compiled by asc (§5.6).
    if (/node_modules|assembly|dist$|\.claude$/.test(path)) return;
    for (const entry of readdirSync(path)) yield* walk(join(path, entry));
    return;
  }
  yield path;
}

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
const resolutionHost = { fileExists, readFile: (path) => readFileSync(path, 'utf8') };

function* bindingNames(name) {
  if (ts.isIdentifier(name)) {
    yield name.text;
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) yield* bindingNames(element.name);
  }
}

/**
 * Sweep `<root>/src` and return the §3.4 violations.
 * @returns {{ orphans: object[], stale: string[], allowedCount: number }}
 */
export function collectOrphans(root = defaultRoot()) {
  const allowlist = JSON.parse(
    readFileSync(resolve(root, 'scripts/check-orphans.allowlist.json'), 'utf8'),
  ).exports;
  const allowed = new Set(allowlist.map((entry) => `${entry.file}#${entry.export}`));

  // Module resolution mirrors tsconfig.app.json — the `@/*` alias (spec §2.3.6) and
  // bundler resolution, so `./x`, `./x.ts` and `./dir` (meaning `./dir/index.ts`) land.
  const compilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    baseUrl: root,
    paths: { '@/*': ['./src/*'] },
  };

  const files = [];
  for (const file of walk(resolve(root, 'src'))) {
    const rel = relative(root, file).replaceAll('\\', '/');
    if (/\.tsx?$/.test(rel)) files.push({ rel, abs: file });
  }

  const sources = new Map();
  for (const { rel, abs } of files) {
    sources.set(rel, ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true));
  }

  /** Resolve a specifier to a repo-relative `src` path, or null if it leaves `src`. */
  function resolveSpecifier(specifier, fromRel) {
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
    // Strip Vite's query suffixes (`?worker&url`, `?raw`) before resolving — spec §2.7.
    const bare = specifier.split('?')[0];
    const resolved = ts.resolveModuleName(
      bare,
      resolve(root, fromRel),
      compilerOptions,
      resolutionHost,
    ).resolvedModule;
    if (!resolved) return null;
    const rel = relative(root, resolved.resolvedFileName).replaceAll('\\', '/');
    return sources.has(rel) ? rel : null;
  }

  const exportsOf = new Map(); // rel -> Map<name, { line, kind }>
  const reexportEdges = []; // { fromFile, fromName, toFile, toName }
  const starEdges = []; // { fromFile, toFile }
  const directUses = new Set(); // "file#name"
  const testUses = new Set();
  const useAll = new Set(); // files whose whole export surface is consumed opaquely

  const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  for (const { rel } of files) {
    const source = sources.get(rel);
    const own = new Map();
    exportsOf.set(rel, own);
    const live = !isTest(rel);

    const record = (name, node, kind) => own.set(name, { line: lineOf(source, node), kind });

    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
      const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const ambient = modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

      // --- imports: uses ------------------------------------------------------------
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveSpecifier(statement.moduleSpecifier.text, rel);
        const clause = statement.importClause;
        if (!target || !clause) continue;
        const sink = live ? directUses : testUses;
        if (clause.name) sink.add(`${target}#default`);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          if (live) useAll.add(target);
        } else if (bindings) {
          for (const element of bindings.elements) {
            sink.add(`${target}#${(element.propertyName ?? element.name).text}`);
          }
        }
        continue;
      }

      // --- re-exports: conditional edges, never uses ---------------------------------
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const target =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? resolveSpecifier(statement.moduleSpecifier.text, rel)
            : null;
        if (!statement.exportClause) {
          // `export * from './x'` — every name x exports is exposed under the same name.
          if (target) starEdges.push({ fromFile: rel, toFile: target });
          continue;
        }
        if (ts.isNamespaceExport(statement.exportClause)) {
          // `export * as ns from './x'` — the whole surface escapes opaquely.
          if (target) useAll.add(target);
          continue;
        }
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const local = (element.propertyName ?? element.name).text;
          const exposed = element.name.text;
          if (target) {
            reexportEdges.push({ fromFile: rel, fromName: exposed, toFile: target, toName: local });
            own.set(exposed, { line: lineOf(source, element), kind: 'reexport' });
          } else {
            // `export { X }` of a binding declared elsewhere in this same file.
            own.set(exposed, { line: lineOf(source, element), kind: 'local' });
          }
        }
        continue;
      }

      // `export default <expression>` is a statement kind of its own.
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        own.set('default', { line: lineOf(source, statement), kind: 'default' });
        continue;
      }

      if (!exported) continue;

      // --- declarations: the export surface ------------------------------------------
      if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
      if (ambient) continue; // `export declare` — no emitted runtime binding.

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(declaration.name)) record(name, statement, 'const');
        }
        continue;
      }
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        const name = isDefault ? 'default' : statement.name?.text;
        if (name) record(name, statement, ts.isClassDeclaration(statement) ? 'class' : 'function');
        continue;
      }
      if (ts.isEnumDeclaration(statement)) {
        record(statement.name.text, statement, 'enum');
      }
    }

    // Dynamic `import('./x')` — the shape of what is read off the promise is not knowable
    // without the checker, so treat the target's whole surface as consumed.
    if (live) {
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const target = resolveSpecifier(node.arguments[0].text, rel);
          if (target) useAll.add(target);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  // Close `export *` into concrete edges now that every export surface is known. This has
  // to run to a fixpoint, not in one pass: a barrel that stars a barrel that stars a
  // module only learns the leaf names once the inner barrel has itself been closed.
  let starChanged = true;
  while (starChanged) {
    starChanged = false;
    for (const { fromFile, toFile } of starEdges) {
      const exposed = exportsOf.get(fromFile);
      for (const name of [...(exportsOf.get(toFile)?.keys() ?? [])]) {
        if (exposed.has(name)) continue;
        exposed.set(name, { line: 0, kind: 'reexport' });
        reexportEdges.push({ fromFile, fromName: name, toFile, toName: name });
        starChanged = true;
      }
    }
  }

  // A use of a barrel's name propagates to whatever that name re-exports. Iterate to a
  // fixpoint so chained barrels (feature index -> sub-index -> module) resolve.
  const used = new Set(directUses);
  for (const file of useAll) {
    for (const name of exportsOf.get(file)?.keys() ?? []) used.add(`${file}#${name}`);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of reexportEdges) {
      if (!used.has(`${edge.fromFile}#${edge.fromName}`)) continue;
      const key = `${edge.toFile}#${edge.toName}`;
      if (used.has(key)) continue;
      used.add(key);
      changed = true;
    }
  }

  const orphans = [];
  const allowedHits = new Set();

  for (const { rel } of files) {
    if (isTest(rel) || isEntry(rel)) continue;
    for (const [name, meta] of exportsOf.get(rel)) {
      if (meta.kind === 'reexport') continue; // judged at the module that declares it
      const key = `${rel}#${name}`;
      if (used.has(key)) continue;
      if (allowed.has(key)) {
        allowedHits.add(key);
        continue;
      }
      orphans.push({ file: rel, name, line: meta.line, kind: meta.kind, testOnly: testUses.has(key) });
    }
  }

  // A stale allowlist entry is a lie about the codebase — fail on it, as the others do.
  const stale = [...allowed].filter((key) => !allowedHits.has(key));

  return { orphans, stale, allowedCount: allowed.size };
}

// --- CLI ---------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { orphans, stale, allowedCount } = collectOrphans(
    process.argv[2] ? resolve(process.argv[2]) : defaultRoot(),
  );

  if (orphans.length > 0) {
    console.error('check:orphans FAILED — exports nothing in the live application tree imports (spec §3.4):');
    for (const orphan of orphans) {
      const note = orphan.testOnly ? ' (imported only by tests)' : '';
      console.error(`  - ${orphan.file}:${orphan.line} — ${orphan.kind} \`${orphan.name}\`${note}`);
    }
    console.error('  Delete it, wire it up, or justify it in scripts/check-orphans.allowlist.json.');
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error('check:orphans FAILED — allowlist entries that are no longer orphans:');
    for (const key of stale) console.error(`  - ${key}`);
    console.error('  The export is used now (or gone). Remove the entry from the allowlist.');
    process.exit(1);
  }

  console.log(
    `check:orphans OK — every runtime export in src is consumed by the live tree (${allowedCount} allowlisted).`,
  );
}
