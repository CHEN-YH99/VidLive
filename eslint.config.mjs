import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

const webNextConfig = nextVitals
  .filter((entry) => !('ignores' in entry))
  .map((entry) => ({
    ...entry,
    files: ['apps/web/**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    settings: {
      ...entry.settings,
      next: {
        rootDir: 'apps/web'
      }
    }
  }));

export default [
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/next-env.d.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },
  ...webNextConfig,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@next/next/no-img-element': 'off',
      '@next/next/no-html-link-for-pages': 'off'
    }
  }
];
