# module-boundaries.config.mjs — the archkeep constraint table

This file is the `depConstraints` table consumed by
[`@ecoma-io/archkeep`](https://github.com/ecoma-io/archkeep). `AGENTS.md` names
it the owner of "the archkeep constraint table", and the boundary law it
encodes is stated in prose in `docs/architecture/crate-dependency-law.md` and
`docs/architecture/worker-architecture.md`. This table and those documents move
in one commit or not at all.

The machine-enforced form of the same law is `pnpm arch`
(`tooling/scripts/check-architecture.mjs`), which reads the Cargo manifest
graph from `cargo metadata` and the git index. This table is the declaration of
that law in archkeep's vocabulary. They are two readers of one law, and the two
must be kept in agreement; where this file and the script disagree, someone has
to decide which one is the mistake — the script exits non-zero on the boundary
law, and this file is judged by archkeep when it runs.

## How to read the table

Every row has a `sourceTag` (or `allSourceTags`) that selects the source
projects, and `onlyDependOnLibsWithTags` / `notDependOnLibsWithTags` /
`bannedExternalImports` that constrain what those sources may reach. A project
must satisfy EVERY row whose tag it carries, so the axes compose.

The tags are the ones the per-project `moon.yml` files declare. Moon tags
cannot contain colons, so the `layer:` vocabulary other Ecoma repositories use
is spelled bare here: the crates carry `domain`, `application`, `oidc`,
`security`, `adapter` (for `identity-cloudflare`) and the Workers carry
`identity`, `identity-admin`, `identity-jobs`; the Vue apps carry `web` via the
tag list in their `moon.yml`. Adding a tag is a boundary decision and belongs in
the same commit that adds the row that judges it — a tag no row judges is a
module with no law, and a row naming a tag no project carries is refused by
archkeep at load (exit 3, "a row that covers nothing").

## What archkeep judges here, and what it cannot — stated in the open

Verified against archkeep's own engine (`node packages/archkeep/cli.mjs check`),
not assumed from the schema:

- **The Rust layering rows (`domain` / `application` / `oidc` / `security` /
  `adapter` / `identity-jobs`) are LIVE at the source level.** archkeep's Rust
  analysis resolves a `use identity_oidc::…` to the owning project and judges it
  against `onlyDependOnLibsWithTags`. Evidence: injecting
  `use identity_oidc::route::Route;` into `identity-application` fails with
  exactly the `application` row's message; injecting
  `use identity_domain::user::UserId;` into the Jobs Worker fails with the
  `identity-jobs` row's message. The project graph (Moon 2.5.6) carries no
  Cargo edges — `moon project-graph --json` returns `edges: []` — but the Rust
  source analyzer does not need them.

- **`identity-cloudflare` is in `identity-application`'s and `identity-oidc`'s
  and `identity-security`'s allow-lists because the law puts it there.** The
  `application` row's allow-list is `["application", "domain"]`, yet
  `identity-cloudflare` depends on `identity-application` by law. archkeep's
  cycle gate fires on THEM before the row ever can — which is correct: it is
  the architecture, not a dead row. A green run on this tree while a cycle
  exists elsewhere is the architecture asserting itself, and the README is
  where that fact lives so it does not read as "the table is dead".

- **The platform law is declared but known to be unenforceable in this engine
  today.** The four `bannedExternalImports` rows say what the law is, and
  `pnpm arch` enforces it from `cargo metadata`. archkeep's own engine cannot
  currently fire those rows for realistic Rust code because of a defect in its
  package guard (archkeep#957): it recognises a package by `/` (npm path
  syntax), whereas Rust names imports with `::`. `use worker;` fires the ban;
  `use worker::Env;` — the only spelling real code uses — is silently
  suppressed before the glob is tested. The rows stay because they are the
  law's archkeep-surface spelling and they will start enforcing when #957
  lands; `pnpm arch` is the enforcement that is real today. Anyone reading a
  green archkeep run therefore cannot infer "no platform type above the line"
  from it — only "no boundary import above the line that archkeep can see".

- **The frontend rule is enforced in `check-architecture.mjs`, not by this
  table's `notDependOnLibsWithTags` rows.** The Workers and crates carry
  `notDependOnLibsWithTags: ["web"]`, which archkeep would apply transitively
  if Moon inferred the edges it needs. Moon 2.5.6 infers no Rust edges, so that
  half is nominal here, exactly as the Cargo-edge rows are; the real
  enforcement is `check-architecture.mjs` check 4 (no frontend package is
  reachable from a backend path), which reads the git index and the file tree
  and is the one with teeth.

## Running archkeep in this repository

There is no `@ecoma-io/archkeep` dependency in `package.json` and no
`archkeep` binary on path, and archkeep's Moon provider shells out to
`moon project-graph --json`, which itself currently fails on a repository with
no commits (`fatal: ambiguous argument 'HEAD'`). So on this machine, today:

- `node /path/to/archkeep/packages/archkeep/cli.mjs check` works against a
  _committed_ copy of the tree.
- it refuses to run until `tsconfig.base.json` exists (it reads a TS `paths`
  table from it; this repository's own apps carry no `paths`, so the refusal
  is a false positive for us but is deliberately loud) and until every
  `docs/adr/*` filename matches `NNN-slug.md`.
- it exits 3 on the real tree because the deliberately-violating fixture under
  `tooling/scripts/__fixtures__/violating-tree/` is tracked and unowned by any
  Moon project.

None of that is a defect in this table. Wiring archkeep into CI is a separate
change that should land with an ADR that says which provider it uses and what
it adds over `pnpm arch`; until then, `pnpm arch` is the gate with teeth and
this file is its declaration.

## The canary for this table

`tooling/ci/check-contracts.mjs` (the contract-conformance gate) also proves
the table is not vacuous: it injects a violating import into a fixture copy and
asserts the offending row fires. It reads `depConstraints` from this file, so a
renamed or removed row fails that gate before it can silently stop judging.
