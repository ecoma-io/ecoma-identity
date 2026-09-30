# Ecoma Identity — documentation map

This is the entry point to the Ecoma Identity documentation set and the single
authority for **what is real today**. It is not a tutorial and not a product
description: the other fifteen documents are the tutorial and the product
description, and this file is the map that says which is which and how far each
has been built.

If a document here and a document there disagree about what exists, this file
wins, and the other one is the bug. Fix the disagreement in the same commit
rather than leaving both to rot.

## The repository in one paragraph

Ecoma Identity is the identity plane for the Ecoma organisation. It owns users,
identities, sessions, authenticators and OAuth/OIDC applications, and it answers
one question for every other Ecoma repository: _who is this request made by?_
It is not a business authorization service, not a directory other systems read
for permissions, and not a session store other systems copy from. What a user
may do in Archkeep, Loom, Release Craft or Action Agents is decided in those
systems from their own data. A `PlatformRole` in this repository says what an
administrator may do to an **account**; it is never consulted about a merge.

It is three Cloudflare Workers, one Rust workspace, two web apps, and the gates
that keep those three Workers apart.

## The status vocabulary

Every described behaviour in every document in this set carries one of four
markers. The marker is not decoration and not a maturity estimate: it answers
"can a reader depend on this today?".

| Marker        | Means                                                                                                      | How you can tell                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `IMPLEMENTED` | Works today, and there is a test that fails if it stops working.                                           | The test exists and runs in `cargo test --workspace`.                                  |
| `SCAFFOLDED`  | The type, route, trait or configuration exists; the behaviour does not. The surface exists and says so.    | The request gets a 501 with the `not_implemented` envelope, or the trait has no body.  |
| `DEFERRED`    | Named, with the phase that will build it. Nothing exists yet.                                              | The document names the phase, and [`roadmap/phases.md`](roadmap/phases.md) defines it. |
| `PLANNED`     | A decision exists; nothing is built, and the decision may still be reachable for revision through its ADR. | The document links the ADR number.                                                     |

Two rules make the vocabulary honest rather than decorative:

1. **A marker is a claim about code, not about intent.** `IMPLEMENTED` is only
   available to a behaviour with a test that would fail if the behaviour
   regressed. A route that answers a hard-coded 200 is `SCAFFOLDED`, not
   `IMPLEMENTED`, no matter how much work went into it.
2. **A document may never describe unimplemented behaviour in the present
   tense.** If a flow is `DEFERRED`, the document says what _will_ happen and
   marks it, and says what exists today instead. A reader designing against
   an overstated document builds on sand.

The bootstrap state is the case this rule exists for: **the platform exists and
authentication does not.** Every declared protocol route is contracted to answer
501 rather than 404, and `/ready` is contracted to report that authentication is
not implemented. Both contracts are stated as data in `identity-oidc` and both
are `DEFERRED` to a Worker that does not exist yet, so nothing serves them
today.

## What is real today

This table is the honest summary. It is deliberately at the top of the map and
not in a document about something else.

| Area                                                                                                                | State                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust workspace: 9 members, `resolver = "3"`, workspace lints                                                        | `IMPLEMENTED`                                                                                                                                                                                                                                                                     | `cargo test --workspace` passes; `Cargo.toml`                                                                                                                                                                           |
| `identity-domain` — users, identities, sessions, authenticators, applications, outbox, audit, AAL, security version | `IMPLEMENTED`                                                                                                                                                                                                                                                                     | The types and their invariants are real and tested. `crates/identity-domain/`                                                                                                                                           |
| `identity-oidc` — route table, discovery document, request/response shapes, JWT/JWK shapes                          | `IMPLEMENTED` as shapes; the protocol is `DEFERRED`                                                                                                                                                                                                                               | `Route::is_implemented()` returns false for every protocol route and a test says so. `crates/identity-oidc/src/route.rs`                                                                                                |
| `identity-application` — command and query traits with typed input/output                                           | `SCAFFOLDED`                                                                                                                                                                                                                                                                      | Every trait has no body. The one exception, the last-administrator rule, is `IMPLEMENTED`. `crates/identity-application/src/administration.rs`                                                                          |
| `identity-security` — factor, token, PKCE, nonce, CSRF and cipher gates                                             | `SCAFFOLDED`                                                                                                                                                                                                                                                                      | Every gate is a trait with no body. No cryptography is implemented anywhere. `crates/identity-security/src/lib.rs`                                                                                                      |
| `identity-cloudflare` — D1, KV, Queues, rate limiting, request/response, error envelope, secrets, clock, ids        | `SCAFFOLDED` — the adapter modules exist; the crate is mid-write and does not compile yet, and `crypto` is declared but absent. `crates/identity-cloudflare/src/`                                                                                                                 |
| `identity-testkit`                                                                                                  | `DEFERRED`                                                                                                                                                                                                                                                                        | The crate is a one-line placeholder. `crates/identity-testkit/src/lib.rs`                                                                                                                                               |
| The three Worker composition roots                                                                                  | `DEFERRED`                                                                                                                                                                                                                                                                        | All three `lib.rs` files are one-line placeholders. `apps/*/worker/src/lib.rs`                                                                                                                                          |
| `GET /health` and `GET /ready` on the Identity Worker                                                               | `DEFERRED`                                                                                                                                                                                                                                                                        | The routes are declared and `Route::is_implemented()` claims they are live, but the Worker that would serve them is a placeholder. The route table's claim is about the _protocol surface_, not about a running binary. |
| OIDC protocol endpoints (`/oauth/*`, `/.well-known/*`)                                                              | `SCAFFOLDED`                                                                                                                                                                                                                                                                      | Declared in the route table with a 501 contract. `crates/identity-oidc/src/route.rs`                                                                                                                                    |
| Email OTP login, TOTP, passkeys, recovery codes                                                                     | `DEFERRED`                                                                                                                                                                                                                                                                        | The gates are declared; no implementation exists. `crates/identity-security/src/factors.rs`                                                                                                                             |
| Two Vue web apps                                                                                                    | `SCAFFOLDED` — the Vue apps are written (routers, feature views, an API client, a `capabilities.ts` honesty table, Vitest suites) and build to `dist/`. They render deferred states because every route behind them answers 501. `apps/identity/web/`, `apps/identity-admin/web/` |
| Database schema and migrations                                                                                      | `DEFERRED`                                                                                                                                                                                                                                                                        | The directories exist; the forward-only rule is decided and the files are being written. `database/migrations/`                                                                                                         |
| API contracts (OIDC, self-service, admin, events)                                                                   | `DEFERRED`                                                                                                                                                                                                                                                                        | The directories exist. `contracts/`                                                                                                                                                                                     |
| Wrangler configuration per environment                                                                              | `SCAFFOLDED` — the development configs for `identity` and `identity-admin` are written; staging and production are not yet. `infra/cloudflare/`                                                                                                                                   |
| CI, release and deploy workflows                                                                                    | `DEFERRED`                                                                                                                                                                                                                                                                        | The directory exists. `.github/workflows/`                                                                                                                                                                              |
| Architecture gate (`pnpm arch`)                                                                                     | `SCAFFOLDED` — `tooling/scripts/check-architecture.mjs` exists, with a deliberately-violating fixture tree under `__fixtures__/violating-tree/`. Whether it passes on the real tree is `DEFERRED` while the Rust crate is mid-write.                                              |

Read that table again before you read anything else in this set. Several rows
say `DEFERRED` for a thing that clearly has a design, and that is the point: a
design is not a capability.

## The documents

### Getting started

| Document                                                     | What it answers                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [local-development.md](getting-started/local-development.md) | How do I run the three Workers and the two web apps on this machine, and what do I put in `.dev.vars`? |
| [first-deploy.md](getting-started/first-deploy.md)           | How do I take this from zero to a real Cloudflare account, once, by hand?                              |

### Roadmap

- [`roadmap/phases.md`](roadmap/phases.md) — what lands in which phase, and the
  exit condition for each. This file owns the phase number every `DEFERRED`
  marker in this set points at.

### Architecture

| Document                                                        | What it answers                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [overview.md](architecture/overview.md)                         | What are the three deployables and what are the request paths through them?                  |
| [trust-boundaries.md](architecture/trust-boundaries.md)         | Where are the trust lines and what crosses them?                                             |
| [crate-dependency-law.md](architecture/crate-dependency-law.md) | What may each Rust crate depend on, and why is each arrow there?                             |
| [worker-architecture.md](architecture/worker-architecture.md)   | What bindings does each Worker hold, and what may each one never do?                         |
| [admin-isolation.md](architecture/admin-isolation.md)           | Why does the Admin Worker have no database, and what do I do when a query seems to need one? |
| [jobs-isolation.md](architecture/jobs-isolation.md)             | Why does the Jobs Worker own no identity state?                                              |
| [data-model.md](architecture/data-model.md)                     | What are the entities, and how do they become tables?                                        |
| [event-model.md](architecture/event-model.md)                   | How does the outbox deliver, and how does a consumer survive a duplicate?                    |

### Security

| Document                                                    | What it answers                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [threat-model.md](security/threat-model.md)                 | What are the assets, who are the actors, and which attacks matter here specifically? |
| [security-constraints.md](security/security-constraints.md) | What are the non-negotiable security rules, and which ADR is behind each?            |
| [secrets-management.md](security/secrets-management.md)     | What counts as a secret, where does it live, and how is it rotated?                  |

### Operations

| Document                                              | What it answers                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [deployment-model.md](operations/deployment-model.md) | What are Versions, Deployments and Promotions, and what is the canary ladder?      |
| [release-process.md](operations/release-process.md)   | Who cuts a release, who promotes it, and why are those different people?           |
| [rollback.md](operations/rollback.md)                 | The three rollback paths, the exact commands, and why a rebuild is not a rollback. |
| [observability.md](operations/observability.md)       | What is logged, what is never logged, and where is the audit trail?                |

### Decision records

The [ADRs](adr/) are the recorded _why_. This set states consequences; the
ADRs state decisions. Where a document here needs a decision, it links the ADR
by number rather than restating it, because a decision and a restatement drift.

## The one rule that gets broken most often

**Never describe unimplemented behaviour as though it works.** Not in a document,
not in a route description, not in a UI empty state, not in a PR body, not in a
test name.

The repository is at platform bootstrap, and it must read like one at every point
a human looks. A skipped test with a named reason is honest; a test that passes
vacuously is a lie that costs someone a debugging session. The `#[ignore]`d
invariants in `identity-domain` and `Route::is_implemented()` in `identity-oidc`
exist so that the honest state is mechanical rather than a matter of discipline.

## When two documents disagree

The authority map lives in `AGENTS.md` at the repository root: one fact, one
owner. Read it before editing anything in this set, and if your change makes a
document here stale, fix the stale one in the same commit.
