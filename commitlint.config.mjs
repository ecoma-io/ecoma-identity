/**
 * Conventional Commits with this repository's scopes.
 *
 * The scope list IS the module map: one scope per moon project in
 * `.moon/workspace.yml`, plus the scopes that name no project (the repository
 * itself, CI, the architecture guard, the database, the contracts). A commit
 * that changes two modules carries the one that owns the change; a commit that
 * changes none of them carries a repository-level scope.
 *
 * The rule this file exists to serve: A NEW MODULE BRINGS ITS SCOPE IN THE SAME
 * COMMIT. A module the commit vocabulary does not name is a module with no law
 * — the reviewer reading a `feat(widgets)` header has nothing to check the
 * diff against, and a scope added three commits later fixes nothing.
 * `AGENTS.md` §"Before you change anything" states it as a four-file commit
 * (directory + `moon.yml`, `module-boundaries.config.mjs` row,
 * `check-architecture.mjs` check, and the scope here); this file is the
 * fourth of the four.
 *
 * ---------------------------------------------------------------------------
 * COMMITLINT IS NOT THE RELEASE-MESSAGE AUTHORITY.
 *
 * Cocogitto (`cocogitto.toml`) is. Release Please is what cuts a release, and
 * the release commit message is what it reads; Cocogitto is what validates that
 * message's conventional shape and its scope, and it is the tier that fails a
 * bad one. Commitlint is a SECOND, INDEPENDENT tier: it re-checks the same
 * message against a superset of the rules, and it is the tier a CI job can run
 * against a pushed commit where no hook was ever installed. The two roles must
 * never be confused, and a fix that tunes one to satisfy the other is the
 * reason the confusion happens. `AGENTS.md` §"Commits, PRs, and security"
 * carries the same statement; the two must keep agreeing.
 * ---------------------------------------------------------------------------
 *
 * The three files that hold commit law — this one, `cocogitto.toml` and
 * `lefthook.yml` — are deliberately redundant with each other. That is not
 * drift: they are three checks a commit must pass, and each fails in a
 * different place (this one is the CI tier, `cocogitto.toml` is the release
 * tier, `lefthook.yml` is what runs locally). They agree on the SCOPE LIST,
 * which is the part that has one meaning and three copies.
 *
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // A scope is not optional. An unscoped `feat: thing` is a commit whose
    // diff this repository's law cannot place, and this repository is a
    // boundary-enforcing one.
    "scope-empty": [2, "never"],
    "scope-enum": [
      2,
      "always",
      [
        // ---- crates/ — one per project in .moon/workspace.yml ----------
        "identity-domain",
        "identity-application",
        "identity-oidc",
        "identity-security",
        "identity-cloudflare",
        "identity-testkit",
        // ---- apps/ — the three Workers and the two web apps ---------------
        // The deployable aliases from the root `moon.yml`, not the moon
        // project ids: a deployable is called `identity`, `identity-admin`
        // and `identity-jobs` everywhere a human reads a name (wrangler
        // worker names, release-please components, Cloudflare version tags),
        // and a commit header is a human-readable surface. The two Worker
        // crates behind an alias are `identity-worker`, `identity-admin-worker`
        // and `identity-jobs-worker`; the frontends are the two `*-web` names.
        "identity",
        "identity-admin",
        "identity-jobs",
        "identity-web",
        "identity-admin-web",
        // ---- repository-level — changes no single project owns ----------
        "arch", // the boundary law itself (pnpm arch, the config, the prose)
        "ci", // .github/workflows and the CI matrix
        "contracts", // contracts/** — the four API contracts
        "db", // database/** — migrations, seeds, fixtures
        "deps", // dependency additions, bumps and the lockfiles they move
        "docs", // docs/** — anything a reader reads to learn the system
        "infra", // infra/cloudflare — bindings per environment, wrangler config
        "release", // release automation, versions, tags, changelog
        "repo", // the repository itself: root config, toolchain, this file
        "security", // SECURITY.md, secrets handling, threat model, an ADR
      ],
    ],
  },
};
