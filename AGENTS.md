# Agent guidance

For working **on** this repository. Read it before the first edit — the rules
below are the ones a diff gets rejected for violating, and most of them are not
inferable from the code. This file is the single authority for agent behavior in
this repository; host instruction files import it and add nothing.

## What this repository is

Ecoma Identity is the identity plane for the Ecoma organisation: one service
that owns users, identities, sessions, authenticators and applications, and
answers "who is this request made by" for every other Ecoma repository. It is
three Cloudflare Workers, a Rust workspace, two operator and end-user web
apps, and the gates that keep those three Workers apart.

It is **not** a business authorization service, not a user directory other
systems read for permissions, and not a session store other systems copy from.
Identity decides who someone is. What they may do in Archkeep, Loom, Release
Craft or Action Agents is decided in those systems, from their own data. A role
in this repository says what an _administrator_ may do to an _account_; it is
never consulted about a merge.

**The repository is at platform bootstrap.** The toolchain, the architecture
law, the gates, the three deployables' shapes, the contracts and the schemas
exist. Authentication does not: every declared protocol route answers **501**,
and `/ready` says so truthfully. `docs/README.md` owns the status vocabulary,
and the single rule below about not overstating is the one most likely to be
violated by accident.

## The authority map

One fact, one owner. When two documents disagree, the owner wins — fix the
other in the same commit rather than leaving both to rot.

| Fact                                                        | Owner                                         |
| ----------------------------------------------------------- | --------------------------------------------- |
| What the repository is and is not, and the bootstrap status | `docs/README.md`                              |
| What is real today vs. scaffolded vs. deferred              | `docs/README.md` (status vocabulary)          |
| What lands in which phase, and each phase's exit condition  | `docs/roadmap/phases.md`                      |
| Component map, the three deployables, the request paths     | `docs/architecture/overview.md`               |
| Where the trust lines are and what crosses them             | `docs/architecture/trust-boundaries.md`       |
| The Rust dependency law in prose                            | `docs/architecture/crate-dependency-law.md`   |
| The bindings each Worker may and may not hold               | `docs/architecture/worker-architecture.md`    |
| Why the Admin Worker holds no database                      | `docs/architecture/admin-isolation.md`        |
| Why the Jobs Worker owns no identity state                  | `docs/architecture/jobs-isolation.md`         |
| The domain model and how it becomes tables                  | `docs/architecture/data-model.md`             |
| The outbox, at-least-once delivery, consumer idempotency    | `docs/architecture/event-model.md`            |
| Assets, actors, and the attacks that matter here            | `docs/security/threat-model.md`               |
| The non-negotiable security rules and the ADR behind each   | `docs/security/security-constraints.md`       |
| Where secrets live and how they are rotated                 | `docs/security/secrets-management.md`         |
| Version, Deployment, Promotion, and the three deployables   | `docs/operations/deployment-model.md`         |
| Why release is not deployment, and who does what            | `docs/operations/release-process.md`          |
| The three rollback paths and the no-rebuild rule            | `docs/operations/rollback.md`                 |
| What is logged, what is never logged, and the audit trail   | `docs/operations/observability.md`            |
| Running the three Workers and two web apps locally          | `docs/getting-started/local-development.md`   |
| Recorded decisions (the "why")                              | `docs/adr/`                                   |
| The executable form of the boundary law                     | `tooling/scripts/check-architecture.mjs`      |
| The archkeep constraint table                               | `module-boundaries.config.mjs`                |
| Project map, tags, tasks                                    | `.moon/workspace.yml`, per-project `moon.yml` |
| The scopes a commit may carry                               | `commitlint.config.mjs`                       |
| The database schema and its forward-only rule               | `database/migrations/`                        |
| The four API contracts                                      | `contracts/`                                  |
| Bindings per environment                                    | `infra/cloudflare/`                           |
| CI, release, deploy, rollback, canary                       | `.github/workflows/`                          |

Architecture facts are verified from the repository, not from memory. Re-read
the owner document before relying on one, because the file you remember may have
moved in someone else's commit.

## The one rule that gets broken most often

**Never describe unimplemented behaviour as though it works.** Not in a doc, not
in a route's description, not in a UI empty state, not in a PR body, not in a
test name. The repository is a bootstrap and it must read like one at every
point a human looks. A test that is skipped with a named reason is honest; a
test that passes vacuously is a lie that costs someone a debugging session.
`identity-domain`'s `#[ignore]`d invariants and `identity-oidc`'s
`Route::is_implemented()` exist so that the honest state is mechanical rather
than a matter of discipline.

## The boundary law is mechanical

`docs/architecture/` states the law in prose. `pnpm arch`
(`node tooling/scripts/check-architecture.mjs`) is what judges it, from
`cargo metadata` and the git index rather than from source-text heuristics. Four
invariants are worth naming because they are easy to violate by accident:

- **The Admin Worker holds no D1 binding.** Not in code, not in
  `wrangler.jsonc`, not "just for this one report". It reaches identity through
  the `IDENTITY` service binding and nothing else.
- **The Jobs Worker depends on neither `identity-domain` nor
  `identity-application`.** A background worker that can evaluate identity rules
  can make identity decisions, and a queue message is not a trustworthy caller.
- **`identity-domain` depends on nothing internal and nothing platform-shaped.**
  No `worker`, no D1, no Cloudflare type ever appears in it. The same is true
  of `identity-application` with respect to the platform.
- **Nothing reaches the frontends.** `crates/**` and `apps/*/worker/**` may not
  import from `apps/*/web/**`. The BFF is a boundary, not a shared library.

`pnpm arch:canary` proves the guard fires: a fixture tree that violates the law
in the exact ways the documents forbid must fail with the exact violations, and
the real tree must stay clean. Never weaken a constraint, widen a fixture's
tolerance, or add a suppression to make a gate green. If the law is wrong,
change the document and the table together, in the open, with an ADR. Fixing the
code to satisfy the gate is the correct direction; the reverse is sabotage.

## Before you change anything

1. **Read the owner document** for the area you are touching (table above).
2. **Inspect the mechanical constraints**: `module-boundaries.config.mjs`,
   `tooling/scripts/check-architecture.mjs`, the project's `moon.yml`, and the
   relevant `wrangler.jsonc`.
3. **New module = one commit, four files**: its directory with `moon.yml` (tags
   included), a row in `module-boundaries.config.mjs` that judges its tag, a
   check in `check-architecture.mjs` if it establishes a boundary, and its scope
   in `commitlint.config.mjs`. A module the boundary table does not judge is a
   module with no law.

## Conventions

**Rust** (workspace `crates/`, plus `apps/*/worker/`): edition 2024, MSRV 1.85
via `rust-version`, no `rust-toolchain.toml` — the ambient stable toolchain is
the toolchain. Every command that can take it gets `--locked`; `Cargo.lock` is
committed. Lints are workspace-inherited (`unsafe_code` forbidden, clippy `all`
denied, pedantic warned, `missing_docs` at the crate root) — **do not add
per-crate lint escapes**. `#[allow]` needs a `reason = "…"` and an explanation in
the comment, and a reviewer will ask what it is suppressing.

Crate responsibilities and their dependency directions are in
`docs/architecture/crate-dependency-law.md`. The short version:
`identity-domain` → nothing; `identity-application` → domain; `identity-oidc`
and `identity-security` → domain; `identity-cloudflare` → all of those;
Workers → all; `identity-testkit` → anything, and is never a production
dependency.

**TypeScript / Vue** (`apps/identity/web`, `apps/identity-admin/web`): strict
TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
Vue `<script setup>` only, Vitest for unit tests. Formatting is prettier's job
alone. **No token ever reaches `localStorage` or readable JavaScript**: the
session cookie is `HttpOnly` + `Secure` + `SameSite=Lax`, every authenticated
call is a `credentials: "include"` fetch, and CSRF protection belongs to the
server. There is no dev-mode auth bypass anywhere, including in the UI.

**Tests are not optional at any layer.** Every crate carries real tests; the
test task fails a suite that runs zero tests. Do not write a test that asserts
what the compiler already enforces unless the assertion _is_ the point — a test
whose failure mode is "someone deleted a `pub`" is a boundary test and should
say so in its name. `moon run identity-domain:test-invariants` runs the
`#[ignore]`d set and answers "how much of the security model is real yet?".

**Dependencies are architecture.** A new dependency needs an architectural
justification in the PR, not just a need. In particular: no cryptography
crate, ever — WebCrypto through `worker` is the only source of primitives
(ADR-0008). A dependency that makes a Worker need a fourth deployable, or a
Worker need a database it must not have, needs an ADR before the code lands.

## Definition of done

A change is done when, on a clean checkout of the branch: `pnpm verify` passes
(format, lint, typecheck, tests, architecture check); `pnpm arch:canary` passes;
`cargo doc --workspace --no-deps` is warning-free; new user-facing behaviour is
named in the document that owns it; a new dependency is justified in the PR
description; and **nothing in the diff claims a capability that does not exist**.

## Prohibited shortcuts

- No `--no-verify`, no skipped hooks, no disabled gate to land a diff.
- No placeholder command that reports success without performing the check it
  advertises. A check that cannot run on this machine says so loudly and exits
  non-zero.
- No authentication bypass — not a flag, not an env var, not a dev role, not a
  test-only shortcut in production code (ADR-0009).
- No self-implemented cryptography, including a hand-rolled constant-time
  comparison (ADR-0008). If WebCrypto does not offer it, the design is wrong.
- No production secret in a tracked file, and no `.env` that is not an
  `.example` (ADR-0009, §27 of the founding constraints).
- No forward-incompatible database migration. There is no database rollback; a
  migration may only add (ADR-0011).
- No rollback that checks out, builds, tests or packages. A rollback promotes an
  existing version id, and a rebuild is a new version rather than a rollback
  (ADR-0013).
- No new Worker without an ADR and proof it fits in one of the three
  (ADR-0002).
- No claim of an unimplemented feature in any user-facing surface. The UI at
  bootstrap says authentication does not exist yet — that honesty is a feature;
  keep it.
- No editing generated or lock files by hand (`Cargo.lock`, `pnpm-lock.yaml`);
  regenerate them with the toolchain.

## Commits, PRs, and security

Conventional Commits with the scopes in `commitlint.config.mjs`, validated by
**Commitlint** at the `commit-msg` hook and in CI. A new module brings its
scope in the same commit. Hooks run the fast gates per commit and the full
suite on push. Never bypass them, never push to `main` directly: every PR lands
through the merge queue, and commits are cryptographically signed.

Keep PRs small enough to review in one sitting. A PR that changes the
architecture law links the document diff beside the code diff, and a PR that
changes a hard constraint links its ADR and says which one.

Security issues never travel through issues or PRs — follow `SECURITY.md`
(private advisory to the maintainer) and stop. That includes a suspected
boundary escape in this repository's own tooling: report it there, do not
open a public issue against it, and do not "fix it quietly" in a way that hides
that it was ever broken.

## Working with subagents

When a task decomposes into independent units, dispatch concurrent subagents
rather than serial work, each with the issue number, branch and draft PR in its
prompt, and its own worktree if two agents edit the same moon project. Agents
that change the same project conflict by construction; agents in different
projects do not. The coordinating session synthesizes and routes follow-ups; the
architecture gate is the arbiter when parallel edits drift — run `pnpm arch`
after integrating, not before dispatching.
