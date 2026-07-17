// Flat ESLint config (ESLint 9) — adapted from the proven Gubbins reference config
// (spec §13.6 reference-implementation rule): 2-space, single-quote, braceless
// single-line guards; Prettier owns formatting (eslint-config-prettier last).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Never lint build output, deps, generated assets, or AssemblyScript kernel sources
  // (AS is compiled by asc, not tsc — spec §5.6; its `load<f32>`-style builtins are not
  // valid app TypeScript).
  {
    ignores: [
      'dist/**',
      'dev-dist/**',
      'coverage/**',
      'node_modules/**',
      'public/**',
      'src/core/dsp/assembly/**',
      'src/core/dsp/dist/**',
      '.claude/worktrees/**',
    ],
  },

  // Base: ESLint core + typescript-eslint (syntactic — fast, no type information).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide rules.
  {
    rules: {
      // `tsc` already flags undefined identifiers with full type awareness; `no-undef`
      // false-positives on ambient/DOM types (typescript-eslint's own guidance).
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Ambient declaration files legitimately use triple-slash references.
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },

  // App source (NOT tests): React rules + type-aware async-safety rules.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'src/test/**'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A stale/oversized dep array is a real bug, not a style nit.
      'react-hooks/exhaustive-deps': 'error',
      // Accessibility linting — spec §3.5 lens 1 / §8.2.
      ...jsxA11y.flatConfigs.recommended.rules,
      // Async-safety rules `tsc` alone won't catch — valuable for a worker/RPC codebase.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // Tests: vitest globals (globals: true in vite.config.ts), browser env via happy-dom.
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker, ...globals.vitest },
    },
    rules: {
      // Tests assert against loosely-typed boundaries; product code stays strict.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Node-side tooling: Vite config and the scripts/ directory.
  {
    files: ['*.{js,ts}', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Disable every rule that would fight Prettier. Stays last EXCEPT the curly override.
  prettier,

  // House style: braceless single-line guards allowed; a wrapped body MUST brace.
  // eslint-config-prettier disables `curly` defensively, so re-assert it after.
  {
    rules: {
      curly: ['error', 'multi-line'],
    },
  },
);
