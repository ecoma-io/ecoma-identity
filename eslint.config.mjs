import tseslint from "typescript-eslint";

/**
 * ESLint flat config for the JavaScript and TypeScript in this repository.
 *
 * WHAT THIS LINTS, and why the list is short. The Rust workspace is judged by
 * `cargo clippy`, not by a JavaScript linter, and each Vue app is judged by
 * `vue-tsc` plus its own Vitest suite. What is left is the tooling itself:
 * `tooling/scripts/`, `tooling/ci/`, `tooling/contract-generation/`, and the
 * root `*.mjs` config files. Those are ordinary Node ES modules and they are
 * the code that judges every boundary in this repository, so they get the
 * strictest settings here rather than the loosest.
 *
 * WHY THE FILE EXISTS AT ALL. It did not, and `pnpm lint` — which resolves to
 * `moon run :lint` — was a task that ran `eslint .` with no configuration and
 * therefore failed on every invocation. A gate that always fails is not a gate:
 * it is a build that cannot be run, and it trains a developer to reach for
 * `--no-verify` rather than to fix the thing the gate was pointing at. If you
 * are reading this because a lint rule fired and you think the rule is wrong,
 * the rule is only wrong if it cannot be justified from a document in `docs/`;
 * say so in an issue rather than disabling it inline.
 *
 * `AGENTS.md` requires that a check which cannot run "says so loudly and exits
 * non-zero", and that a new dependency carry an architectural justification.
 * ESLint and typescript-eslint are already declared in the root
 * `devDependencies` for exactly this file; neither is a runtime dependency and
 * neither reaches a Worker.
 */

/** Files that are Node ES modules: no DOM, no bundler globals. */
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  structuredClone: "readonly",
};

/** Globals a browser-side Vue/TypeScript file may use. */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  fetch: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  crypto: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  customElements: "readonly",
  HTMLElement: "readonly",
  Element: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  console: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  structuredClone: "readonly",
  performance: "readonly",
};

export default tseslint.config(
  {
    // Nothing is linted by default; each block below opts a path in
    // explicitly. An `ignores` entry here silences the whole tree, and this
    // file has no such entry on purpose — a newly added file should be linted
    // by the next block that matches its extension rather than quietly skipped
    // by a catch-all that somebody added to quiet a warning.
    files: ["**/*"],
  },

  // --- The tooling --------------------------------------------------------
  // Plain Node ES modules, linted WITHOUT the type-aware rules. This is a
  // deliberate difference from the Vue block below, and the reason is that
  // `check-architecture.mjs` has no `tsconfig.json` to be found by — a
  // type-aware rule on a file the project service cannot resolve does not
  // degrade to "unchecked", it fails to parse, which is a linter that reports
  // nothing useful. The rules below are the ones that catch a real defect in
  // this kind of code: a floating promise, an empty catch, a loose equality.
  {
    files: ["tooling/**/*.{js,mjs,cjs}", "*.mjs"],
    extends: [
      tseslint.configs.eslintRecommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      // A check that cannot see what it is checking must fail rather than
      // pass quietly: `console.log` in a gate is how a "verification" becomes
      // a report of nothing having been verified.
      "no-console": "error",
      // An empty catch block is how an error becomes invisible.
      "no-empty": ["error", { allowEmptyCatch: false }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      // The promise rules (`no-floating-promises`, `no-misused-promises`,
      // `require-await`) are deliberately ABSENT from this block. Each needs a
      // type checker, and there is no tsconfig covering these files: with one
      // switched on, ESLint aborts the whole run with "you have used a rule
      // which requires type information" rather than skipping the rule. They
      // are on in the Vue block below, which does have a tsconfig. A rule that
      // prevents the linter from running is not a strict setting, it is an
      // absent one — and an absent linter is what this file exists to fix.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // --- The two Vue apps ----------------------------------------------------
  {
    files: ["apps/*/web/src/**/*.ts", "apps/*/web/tests/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: browserGlobals,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      // The `any`-shaped rules are off here, and the reason is specific
      // rather than a refusal to lint. `vue-tsc` is the type authority for
      // these two apps, and Vue's own public types are parameterised by `any`
      // at the seams — `createApp(App)`, a router push target, a component
      // instance in a template ref. Every one of those yields "unsafe
      // assignment of an `any` value" from a rule that cannot tell the
      // difference between Vue's deliberate `any` and a real one. Turning the
      // rule on would produce dozens of findings that all resolve to "this is
      // how Vue is typed", which is the noise shape that teaches a developer
      // to add `eslint-disable` and then stop reading the output.
      //
      // What IS enforced here is everything that does not depend on resolving
      // an `any`: unused symbols, dead code, unreachable branches, and the
      // promise rules, which have real value in a `fetch` client.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },

  // --- Configuration files at the root -------------------------------------
  {
    files: [
      "*.config.mjs",
      "commitlint.config.mjs",
      "module-boundaries.config.mjs",
    ],
    rules: {
      // These files are data, and a long literal list is the point of them.
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },

  // --- Generated and vendored trees are not ours to lint -------------------
  {
    // The canary fixture exists to be REJECTED by `pnpm arch`. Linting it
    // would be linting a deliberate violation, and the violations are the
    // fixture's entire purpose — `vendor/loom/`, the fourth Worker, the D1
    // binding on the Admin Worker. Same reasoning as the guard's
    // `WALK_SKIP_DIRS` entry: it is reached explicitly, through `--root`, and
    // never by an implicit walk.
    ignores: [
      // `.vue` is EXCLUDED, and the reason is worth stating rather than
      // leaving as a silent glob. Linting a single-file component needs
      // `vue-eslint-parser`; without it ESLint hands the file to `espree`,
      // which stops at the first `<` and reports "Parsing error: Unexpected
      // token <" for every one of the twenty-odd components in this
      // repository. Twenty-nine parse errors that all mean the same thing
      // teach a developer that `pnpm lint` is broken.
      //
      // The coverage is real, it is just not here: `vue-tsc` type-checks every
      // component in `pnpm typecheck`, and Vitest mounts the real components
      // through `@vue/test-utils` rather than testing a copy of their logic.
      // A component's logic lives in the `.ts` modules it imports, and those
      // ARE linted. If this repository later adds `vue-eslint-parser`, this
      // entry and the block above it are the two things to remove.
      "**/*.vue",
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/.moon/**",
      "tooling/scripts/__fixtures__/**",
    ],
  },
);
