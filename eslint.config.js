import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * The money rule, mechanically enforced.
 *
 * SRS §8.5: `parseFloat`, `toFixed`, and a bare `number` used as rupees are
 * forbidden for money. §15.1: one money-math module owns every arithmetic
 * operation on paise — no ad-hoc `*`, `/`, or `Math.round` on money exists
 * anywhere else in the codebase.
 *
 * A linter cannot tell a monetary `Math.round` from an innocent one, so the
 * ban is positional: these are unavailable everywhere except src/money/, which
 * is the only place they are ever legitimate. That converts the rule from
 * reviewer vigilance into a build failure.
 */
const MONEY_RULE =
  'Money arithmetic belongs in src/money/ only (SRS §8.5, §15.1). ' +
  'All money is integer paise; never let a fractional money value exist.';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      '.wrangler',
      'drizzle/migrations',
      'worker-configuration.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },

  {
    // The service worker runs in a ServiceWorkerGlobalScope, not a window.
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },

  {
    files: ['src/client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/money/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: MONEY_RULE },
        { name: 'parseInt', message: MONEY_RULE + ' Use Number() for non-money integers.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'round', message: MONEY_RULE },
        { object: 'Number', property: 'parseFloat', message: MONEY_RULE },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='toFixed']",
          message: MONEY_RULE + ' Use formatPaise() at the render boundary.',
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
