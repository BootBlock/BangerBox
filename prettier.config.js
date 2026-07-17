// Prettier config — house style shared with the Gubbins reference repo: single-quote,
// semicolons, 2-space indent, ~110-column lines. Prettier never adds/removes braces, so
// the braceless single-line-guard style is enforced by ESLint's `curly` rule instead.
/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 110,
  tabWidth: 2,
  arrowParens: 'always',
};
