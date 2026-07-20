// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/manifest.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // core: must stay runtime-agnostic (no figma/chrome/Node) so figma-plugin,
  // agent-kit, and extension can each compile it for their own target — see
  // Documentation/MISSION.md and packages/core/ARCHITECTURE.md's Requirements.
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.spec.ts'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'figma', message: 'core must not depend on the figma global.' },
        { name: 'chrome', message: 'core must not depend on the chrome global.' },
        { name: 'process', message: 'core must not depend on Node built-ins.' },
        { name: '__dirname', message: 'core must not depend on Node built-ins.' },
        { name: '__filename', message: 'core must not depend on Node built-ins.' },
        { name: 'require', message: 'core must not depend on Node built-ins.' },
        { name: 'module', message: 'core must not depend on Node built-ins.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core must not depend on Node built-ins.' },
            { group: ['chrome', 'chrome.*'], message: 'core must not depend on chrome.*.' },
          ],
        },
      ],
    },
  },
  // figma-plugin: main-thread files see the `figma` global, no DOM
  {
    files: ['packages/figma-plugin/src/main/**/*.ts'],
    languageOptions: {
      globals: {
        figma: 'readonly',
        __html__: 'readonly',
        __uiFiles__: 'readonly',
      },
    },
  },
  // figma-plugin: UI-thread files are Preact + DOM, no `figma` global.
  // Uses the classic JSX transform (jsxFactory: "h", see tsconfig), so the
  // `h` import from 'preact' is load-bearing even though nothing references
  // it by name — no-unused-vars can't see that, so it's disabled here.
  {
    files: ['packages/figma-plugin/src/ui/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^h$', args: 'after-used' },
      ],
    },
  },
  eslintConfigPrettier,
)
