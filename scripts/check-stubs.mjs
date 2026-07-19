// check:stubs — spec §13.6. Every temporary stub or deferred wiring is tagged
// `// STUB(phase-N): reason`. This script lists open stubs (they must appear in the
// phase handover) and FAILS from Phase 7 onward if any remain. It also fails on
// malformed stub tags, so untagged deferrals can't hide.
//
// A tag gate only catches deferrals written as tags. Deferrals written as prose —
// "the polished editor is Phase 7", "the Browser UI lands in Phase 6" — used to leave
// this gate green while the work was outstanding, which is exactly what §13.6 exists to
// prevent. So the script also fails on any phase reference in `src` outside the
// historical phrasings in scripts/check-stubs.allowlist.json. Outstanding work is
// described as outstanding and linked to its issue, never parked on a phase number.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const currentPhase = Number(pkg.config?.phase ?? 0);

const stubPattern = /\/\/ STUB\(phase-(\d+)\): (.+)/;
const loosePattern = /\bSTUB\b/;
const extensions = ['.ts', '.tsx'];

// Any mention of an implementation phase (§12). Every phase has completed, so a surviving
// mention is either history (allowlisted below) or a prose deferral (a violation).
const phasePattern = /\bphase[\s-]?\d\b/gi;
const phaseAllowlist = JSON.parse(
  readFileSync(resolve(root, 'scripts/check-stubs.allowlist.json'), 'utf8'),
).patterns.map((entry) => new RegExp(entry.pattern, 'gi'));

function* walk(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    if (/node_modules|assembly|dist$/.test(path)) return;
    for (const entry of readdirSync(path)) yield* walk(join(path, entry));
    return;
  }
  yield path;
}

const stubs = [];
const malformed = [];
const phaseProse = [];

for (const file of walk(resolve(root, 'src'))) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (!extensions.some((ext) => rel.endsWith(ext))) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = stubPattern.exec(line);
    if (match) {
      stubs.push({ file: rel, line: index + 1, phase: Number(match[1]), reason: match[2].trim() });
      return;
    }
    if (loosePattern.test(line) && !rel.endsWith('check-stubs.mjs')) {
      malformed.push(`${rel}:${index + 1} — ${line.trim()}`);
      return;
    }
    let stripped = line;
    for (const pattern of phaseAllowlist) stripped = stripped.replace(pattern, '');
    if (phasePattern.test(stripped)) {
      phaseProse.push(`${rel}:${index + 1} — ${line.trim()}`);
    }
    phasePattern.lastIndex = 0;
  });
}

if (malformed.length > 0) {
  console.error('check:stubs FAILED — malformed stub tags (required form: `// STUB(phase-N): reason`):');
  for (const entry of malformed) console.error(`  - ${entry}`);
  process.exit(1);
}

if (phaseProse.length > 0) {
  console.error('check:stubs FAILED — phase references outside the historical allowlist (spec §13.6).');
  console.error('  Every §12 phase has completed, so naming one describes no schedule. Say what the');
  console.error('  code does now; if work is genuinely outstanding, link its issue instead.');
  for (const entry of phaseProse) console.error(`  - ${entry}`);
  process.exit(1);
}

if (stubs.length > 0) {
  console.log(`check:stubs — ${stubs.length} open stub(s) (must appear in PHASE_HANDOVER.md):`);
  for (const stub of stubs) {
    console.log(`  - [phase-${stub.phase}] ${stub.file}:${stub.line} — ${stub.reason}`);
  }
} else {
  console.log('check:stubs — no open stubs.');
}

// spec §13.6 — stubs must be resolved before the polish phase completes.
if (currentPhase >= 7 && stubs.length > 0) {
  console.error(`check:stubs FAILED — phase ${currentPhase} ≥ 7 with ${stubs.length} open stub(s).`);
  process.exit(1);
}
console.log('check:stubs OK — no open stubs and no phase prose outside the allowlist.');
