// ---------------------------------------------------------------------------
// ESLint 9 (flat config) — Phase 1 Check 4 · Stage E.
//
// Replaces the previous `lint` script, which merely re-ran `tsc --noEmit` and
// so linted nothing. This is a genuine ESLint pass (typescript-eslint +
// react-hooks) over the browser app and the Node-side tooling/test scripts.
//
// Deliberately WARN-FIRST: rules report as warnings, not errors, so the lint is
// informative without blocking `verify` or the build while the codebase is
// brought into line. The one exception is `react-hooks/rules-of-hooks`, kept at
// `error` because violating it is a real correctness bug, not a style nit.
// Flipping the warn-tier rules to `error` is a later, deliberate step.
//
// Supabase Edge Functions run on Deno and are TYPECHECKED separately (via
// supabase/functions/tsconfig.json). They are ignored by ESLint here so browser
// globals do not clash with Deno globals; lint them with `deno lint` where Deno
// is available.
// ---------------------------------------------------------------------------
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      // P0-4 (§2.8): `release:seal` freezes the deployable build in
      // out/release/dist and writes its run logs to out/. That is build output,
      // not source — linting it adds thousands of phantom problems against a
      // pinned budget and would make a post-seal `npm run lint` look broken.
      // The source digest already excludes out/ for the same reason.
      'out/**',
      'node_modules/**',
      'supabase/functions/**',
      'coverage/**',
      '**/*.config.{js,mjs,cjs,ts}',
      'vite.config.*',
      // Reconstruction/build-recipe scaffolding, not application source. The
      // ws7b_overlay/ payload is byte-identical copies of files already linted
      // in their canonical locations (scripts/**, supabase/**), and its .mjs
      // copies sit outside the scripts/** environment-globals override by
      // design — linting them here is both redundant and spuriously failing.
      'ws7-build/**',
    ],
  },

  // Baseline best-practice rule sets (non type-checked: fast, no full type graph).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- Warn-first severity policy (applies everywhere) -----------------------
  // Intentional or pervasive patterns are surfaced as warnings, not errors, so
  // the lint never blocks the build during adoption.
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'prefer-const': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Browser application source.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // React Hooks — rules-of-hooks is a correctness guarantee, keep it hard.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // R4.9 G4 — THE PUBLIC SURFACE MAY NOT IMPORT THE SEED CATALOGUE.
  //
  // The fail-open defect this gate closed was six `items || INITIAL_X`
  // expressions in the two components that render public content. The
  // PublicCollection union makes that idiom a type error, but only while the
  // seeds are out of reach: a future edit could still import them and hand an
  // array to `{ status: 'ready', items }`. This makes the import itself an
  // ERROR in exactly the two modules that face customers. It fires zero times
  // today, so the 239-warning ceiling is untouched; it fires loudly the moment
  // anyone reaches for the seeds again.
  //
  // App.tsx keeps its DEV-ONLY seed branch, which is why the restriction names
  // the public component and the seed module rather than banning the import
  // outright — see DEV_SEED_CONTENT in src/App.tsx, statically dead in a
  // production build.
  {
    files: ['src/components/PublicPages.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '../data',
          importNames: ['INITIAL_MENU_ITEMS', 'INITIAL_STORES', 'INITIAL_JOBS', 'INITIAL_DEALS'],
          message:
            'The public surface renders a PublicCollection state, never seed data. ' +
            'Handle status: loading | ready | unavailable instead of substituting src/data.ts.',
        }],
      }],
    },
  },

  // Node-side scripts (test harnesses, tooling). Some build HTML/OG assets and
  // reference DOM globals, so both environments are provided.
  {
    files: ['scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
