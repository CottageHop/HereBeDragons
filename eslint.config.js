import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

// Flat config (ESLint v9). The lint script only targets src/ and test/, but
// the ignore block keeps editor/IDE ESLint integrations off build output too.
export default [
  {
    ignores: ['dist/**', 'demo-dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  // typescript-eslint's flat/recommended sets up the parser + plugin and turns
  // off the core rules TS handles better (e.g. no-unused-vars).
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Browser map library with vitest (node) tests — expose both.
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      // Honor the `_`-prefix convention for intentionally-unused params that
      // exist only to satisfy an interface/override signature (e.g. `_dt`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // `const self = this` is used to capture the instance for getters inside
      // returned object-literal handles (getters can't be arrow functions).
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['self'] }]
    }
  }
];
