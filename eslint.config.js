import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'test-results/**',
      'playwright-report/**',
      'work/**',
      '.playwright/**',
      '.tools/**',
      '.npm-cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/studio-demo/src/*.{jsx,mjs}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'localStorage',
          'location',
          'parent',
          'crypto',
          'URL',
          'Blob',
          'setTimeout',
          'requestAnimationFrame',
          'addEventListener',
          'MutationObserver',
          'HTMLTextAreaElement',
          '__CODE_DOCUMENT__',
          '__ARTIFACT_PREVIEW_DOCUMENT__',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    files: ['apps/studio-demo/site/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
