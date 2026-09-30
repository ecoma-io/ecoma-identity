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
authentication does not.** Every declared protocol route answers 501 with the
`not_implemented` envelope, and `/ready` reports `ready: false` with
`authentication: "not_implemented"`. Both are enforced by tests in
`apps/identity/worker/src/lib.rs`, and `Route::is_implemented()` is the one
function the dispatcher, the probe, the smoke test and `identity-oidc`'s own
tests all read, so the four cannot disagree.

## What is real today

This table is the honest summary. It is deliberately at the top of the map and
not in a document about something else.

| Area                                                                                                                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust workspace: 9 members, `resolver = "3"`, workspace lints                                                        | `IMPLEMENTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `cargo test --workspace` passes; `Cargo.toml`                                                                                                                                                                                                                                                                                                                                                            |
| `identity-domain` — users, identities, sessions, authenticators, applications, outbox, audit, AAL, security version | `IMPLEMENTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The types and their invariants are real and tested. `crates/identity-domain/`                                                                                                                                                                                                                                                                                                                            |
| `identity-oidc` — route table, discovery document, request/response shapes, JWT/JWK shapes                          | `IMPLEMENTED` as shapes; the protocol is `DEFERRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `Route::is_implemented()` returns false for every protocol route and a test says so. `crates/identity-oidc/src/route.rs`                                                                                                                                                                                                                                                                                 |
| `identity-application` — command and query traits with typed input/output                                           | `SCAFFOLDED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Every trait has no body. The one exception, the last-administrator rule, is `IMPLEMENTED`. `crates/identity-application/src/administration.rs`                                                                                                                                                                                                                                                           |
| `identity-security` — factor, token, PKCE, nonce, CSRF and cipher gates                                             | `SCAFFOLDED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Every gate is a trait with no body. No cryptography is implemented anywhere. `crates/identity-security/src/lib.rs`                                                                                                                                                                                                                                                                                       |
| `identity-cloudflare` — D1, KV, Queues, rate limiting, request/response, error envelope, secrets, clock, ids        | `IMPLEMENTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Every adapter is real, compiles for both the host and `wasm32-unknown-unknown`, and is covered by tests. `crypto` is present: every primitive is read from the platform's WebCrypto, and none is implemented here. `crates/identity-cloudflare/src/`                                                                                                                                                     |
| `identity-testkit`                                                                                                  | `DEFERRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The crate is a one-line placeholder. Nothing in the workspace depends on it. `crates/identity-testkit/src/lib.rs`                                                                                                                                                                                                                                                                                        |
| The `identity` Worker composition root                                                                              | `IMPLEMENTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The `fetch` entrypoint, the route dispatch, the two probes and the 501 surface are real and tested. No handler reads or writes identity state, because no handler exists that could. `apps/identity/worker/src/lib.rs`                                                                                                                                                                                   |
| The three Worker composition roots                                                                                  | `IMPLEMENTED` — all three serve a `fetch` entrypoint, a route dispatch and the two probes. Two of the three serve the 501 protocol surface (`identity`, `identity-admin`); `identity-jobs` serves only its two probes and a 404, because it is a queue consumer and has no business answering an authorization request. None of them serves a flow. `apps/*/worker/src/lib.rs`                                                                                                                                                                                                                                                                        |
| `GET /health` and `GET /ready` on the Identity Worker                                                               | `IMPLEMENTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Both answer 200 on a real binary. `/ready` reports `ready: false` and `authentication: "not_implemented"`, and asserts the same two facts in its tests. `apps/identity/worker/src/lib.rs`                                                                                                                                                                                                                |
| OIDC protocol endpoints (`/oauth/*`, `/.well-known/*`)                                                              | `SCAFFOLDED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | All seven answer 501 with the `not_implemented` envelope, and a path that is not declared answers 404. Verified by `cargo test -p identity-worker`. `crates/identity-oidc/src/route.rs`, `apps/identity/worker/src/lib.rs`                                                                                                                                                                               |
| Email OTP login, TOTP, passkeys, recovery codes                                                                     | `DEFERRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The gates are declared; no implementation exists. `crates/identity-security/src/factors.rs`                                                                                                                                                                                                                                                                                                              |
| Two Vue web apps                                                                                                    | `SCAFFOLDED` — the Vue apps are written (routers, feature views, an API client, a `capabilities.ts` honesty table, Vitest suites) and build to `dist/`. They render deferred states because every route behind them answers 501. `apps/identity/web/`, `apps/identity-admin/web/`                                                                                                                                                                                                                                                                                                                                                                     |
| Database schema and migrations                                                                                      | `DEFERRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The directories exist; the forward-only rule is decided and the files are being written. `database/migrations/`                                                                                                                                                                                                                                                                                          |
| API contracts (OIDC, self-service, admin, events)                                                                   | `IMPLEMENTED` as documents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 42 JSON Schema draft 2020-12 files, every one parsing, across `contracts/{oidc,self-service,admin,events,shared}/v1/`. Each schema carries `x-rust-type`, `x-serde-status` and `x-phase`, and `pnpm contracts` enforces all three plus the cross-check between the OIDC route table and `identity_oidc::route::Route`. A contract here is a promise about a surface, not evidence the surface is served. |
| Wrangler configuration per environment                                                                              | `SCAFFOLDED` — all nine configs are written (3 Workers × development/staging/production) and are judged by `pnpm arch`. No id in any of them points at a real Cloudflare resource. `infra/cloudflare/`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| CI, release and deploy workflows                                                                                    | `SCAFFOLDED` — seven workflows are written (`ci`, `analysis`, `deploy`, `deploy-worker`, `deploy-production`, `release`, `rollback`) and every action reference is SHA-pinned. **`ci` and `release` have now run**, and the first run of each **failed** — the very first push exposed that `lefthook` was never a dependency, so `prepare` exited 127 on every clean checkout and no job installed its hooks. Fixed by pinning it; recorded here because a workflow that has never run is a workflow that is not known to work. `deploy*` and `rollback` have still never run: nothing is deployed, and nothing is rolled back. `.github/workflows/` |
| Architecture gate (`pnpm arch`)                                                                                     | `IMPLEMENTED` and **passing** — the guard judges the real tree from `cargo metadata` and the git index, exits 0, and runs all 10 of its checks. `pnpm arch:canary` is 21/21 against the deliberately-violating fixture tree under `__fixtures__/violating-tree/`, including a case that a direct-edge reading of the Jobs boundary walks straight through. It found a real violation here first — the Jobs Worker reached `identity-domain` transitively — and the fix was the code, not the check. The 9 warnings are about capabilities no deployable has yet, not about boundary escapes.                                                          |

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
