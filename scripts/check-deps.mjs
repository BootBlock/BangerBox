// check:deps — spec §13.6. Fails if package.json contains any package outside the
// closed §2.2 dependency matrix, any forbidden package, or a non-npm lockfile.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

// The closed runtime dependency matrix — spec §2.2.
const allowedRuntime = new Set([
  'react',
  'react-dom',
  'zustand',
  'zod',
  '@sqlite.org/sqlite-wasm',
  'fflate',
  'motion',
  'lucide-react',
  'clsx',
  'tailwind-merge',
  'class-variance-authority',
  'react-error-boundary',
]);

// The closed dev dependency matrix — spec §2.2. `@eslint/js` and `globals` are
// constituents of the flat "eslint (+ …)" tooling grouping; `@types/*` is the
// spec's own wildcard entry.
const allowedDev = new Set([
  'vite',
  '@vitejs/plugin-react',
  'typescript',
  'tailwindcss',
  '@tailwindcss/vite',
  'vite-plugin-pwa',
  'assemblyscript',
  'vitest',
  'happy-dom',
  '@testing-library/react',
  '@testing-library/user-event',
  '@testing-library/jest-dom',
  'playwright',
  'eslint',
  '@eslint/js',
  'globals',
  'typescript-eslint',
  'eslint-plugin-react-hooks',
  'eslint-plugin-jsx-a11y',
  'eslint-config-prettier',
  'prettier',
]);

// Forbidden packages — spec §2.2 (non-exhaustive list, matched as name or prefix).
const forbidden = [
  'tone',
  'howler',
  'standardized-audio-context',
  'rxjs',
  'redux',
  '@reduxjs/toolkit',
  'mobx',
  'jotai',
  'recoil',
  'react-router',
  'react-router-dom',
  '@tanstack/react-router',
  '@tanstack/router-plugin',
  'comlink',
  'uuid',
  'lodash',
  'underscore',
  'moment',
  'dayjs',
  'date-fns',
  'axios',
  'jszip',
  'sql.js',
  'wa-sqlite',
  'next',
  'remix',
  '@remix-run/react',
  'styled-components',
  '@emotion/react',
  '@emotion/styled',
  '@radix-ui/',
  '@mui/',
  'antd',
  '@chakra-ui/',
  'framer-motion',
  'jest',
];

const problems = [];

function checkSection(section, allowed, label) {
  for (const name of Object.keys(section ?? {})) {
    const isForbidden = forbidden.some((f) => (f.endsWith('/') ? name.startsWith(f) : name === f));
    if (isForbidden) {
      problems.push(`${label}: "${name}" is on the §2.2 forbidden list.`);
      continue;
    }
    if (name.startsWith('@types/')) continue; // spec §2.2 `@types/*`
    if (!allowed.has(name)) {
      problems.push(`${label}: "${name}" is outside the closed §2.2 dependency matrix.`);
    }
  }
}

checkSection(pkg.dependencies, allowedRuntime, 'dependencies');
checkSection(pkg.devDependencies, allowedDev, 'devDependencies');

// npm is the only package manager — spec §1.3 #2.
for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
  if (existsSync(resolve(root, lockfile))) {
    problems.push(`Non-npm lockfile present: ${lockfile} (spec §1.3 #2 — npm only).`);
  }
}
if (!existsSync(resolve(root, 'package-lock.json'))) {
  problems.push('package-lock.json is missing (spec §1.3 #2 — it must be committed).');
}
if (pkg.engines?.node !== '>=24') {
  problems.push(`engines.node is "${pkg.engines?.node}" (spec §1.3 #2 requires ">=24").`);
}

if (problems.length > 0) {
  console.error('check:deps FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('check:deps OK — dependency surface matches the closed §2.2 matrix.');
