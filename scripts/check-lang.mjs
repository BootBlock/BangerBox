// check:lang — spec §13.6/§3.7. Scans identifiers, comments, and UI strings for
// American spellings, with an explicit allowlist file for platform-fixed API names
// (scripts/check-lang.allowlist.json). British English is the house language.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// American spellings scanned for (word-stem match, case-insensitive; catches camelCase
// too). Extend as violations are discovered — never shrink without a §14 entry.
const americanStems = [
  'color',
  'behavior',
  'initializ',
  'synchroniz',
  'normaliz',
  'organiz',
  'optimiz',
  'customiz',
  'serializ',
  'analyz',
  'favorite',
  'catalog(?!ue)',
  'canceled',
  'centered',
  'gray(?!scale)', // greyscale exception: 'grayscale' is the platform CSS filter name
  'artifact',
  'localiz',
  'minimiz',
  'maximiz',
  'recogniz',
];
const americanPattern = new RegExp(`(?:${americanStems.join('|')})`, 'gi');

const allowlist = JSON.parse(
  readFileSync(resolve(root, 'scripts/check-lang.allowlist.json'), 'utf8'),
).patterns.map((entry) => new RegExp(entry.pattern, 'gi'));

// Scanned surfaces: app source, index.html, and the tooling scripts. The checker and
// its allowlist are excluded (they contain the scanned words by definition), as are
// built artefacts and third-party directories.
const scanRoots = ['src', 'scripts', 'index.html', 'vite.config.ts', 'eslint.config.js'];
const excluded = new Set(['scripts/check-lang.mjs', 'scripts/check-lang.allowlist.json']);
const extensions = new Set(['.ts', '.tsx', '.css', '.html', '.mjs', '.js', '.json']);

function* walk(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    if (/node_modules|dist$/.test(path)) return;
    for (const entry of readdirSync(path)) yield* walk(join(path, entry));
    return;
  }
  yield path;
}

const violations = [];

for (const scanRoot of scanRoots) {
  for (const file of walk(resolve(root, scanRoot))) {
    const rel = relative(root, file).replaceAll('\\', '/');
    if (excluded.has(rel)) continue;
    if (![...extensions].some((ext) => rel.endsWith(ext))) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      let stripped = line;
      for (const pattern of allowlist) stripped = stripped.replace(pattern, '');
      const matches = stripped.match(americanPattern);
      if (matches) {
        violations.push(`${rel}:${index + 1} — ${[...new Set(matches)].join(', ')} | ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error('check:lang FAILED — American spellings found (spec §3.7):');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log('check:lang OK — no American spellings outside the platform allowlist.');
