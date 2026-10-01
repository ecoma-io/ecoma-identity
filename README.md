# Ecoma Identity

The identity plane for the [Ecoma](https://github.com/ecoma-io) organisation:
one service that owns users, identities, sessions, authenticators and
applications, and answers **"who is this request made by"** for every other
Ecoma repository.

It is three Cloudflare Workers, a Rust workspace, two web apps, an independent
public Nuxt/Nitro application, and the gates that keep those three Workers apart.

---

## Status: platform bootstrap. Authentication is not implemented.

**Read this before anything else.** The platform exists. The identity flows do
not.

What works today:

- The Rust workspace: a domain model with its invariants, a use-case layer, the
  OIDC wire types, the ten security service interfaces, the Cloudflare
  adapters, and three Worker entrypoints.
- Two health endpoints per Worker. `/ready` reports — truthfully — that
  authentication is not implemented. It does not report a service ready to
  authenticate anyone.
- The architecture guard, the CI matrix, the release, canary and rollback
  paths, the database schema, and the four API contracts.

What does not work, and is not claimed to:

- **Nobody can sign in.** Every declared protocol route answers
  `501 Not Implemented`. The end-user UI and the operator console say the same
  thing in their own words rather than showing a placeholder that looks like a
  working screen.
- No email is sent. No token is signed or verified on a live path. No
  third-party provider is contacted.

`docs/README.md` defines the status vocabulary every document in this
repository uses, and [`docs/roadmap/phases.md`](docs/roadmap/phases.md) names
the phase that builds each deferred piece, with the exit condition for each.

**If a document or a surface in this repository describes behaviour that does
not exist, that is a bug in the document** — please report it.

## The four deployables

| Deployable       | Owns                                                 | Must never                                                |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `identity`       | The identity database. The single source of truth.   | Trust a second writer.                                    |
| `identity-admin` | An operator console. No data of its own.             | Hold a database.                                          |
| `identity-jobs`  | Background side effects. No identity state.          | Decide anything about an identity.                        |
| `home-web`       | The public-facing web application. No Identity data. | Call Identity, hold a session, or import Identity crates. |

The Admin Worker reaches identity **only** through a private service binding.
The Jobs Worker consumes queue messages and performs effects; it does not
evaluate identity rules and its crate cannot even name the types that would let
it. `home-web` is an independent Nuxt/Nitro application on Workers + Workers
Assets; it has no Identity binding and no internal crate dependency.

Those absences are the most load-bearing constraints in the repository and they
are enforced mechanically, not by convention — see
`tooling/scripts/check-architecture.mjs`.

There is no fifth Worker without an ADR (`docs/adr/0002-three-deployables-and-no-more.md`,
superseded on the count by `docs/adr/0016-home-web-fourth-deployable.md`).

## What identity is not

Identity decides **who someone is**. It never decides **what they may do** in
another Ecoma repository.

A role in this system says what an _administrator_ may do to an _account_ —
suspend a user, change a role, revoke sessions. It is never consulted to decide
whether a user may merge a pull request in Archkeep, ship a release in Release
Craft, or review a diff in Action Agents. Those systems own that data and that
decision (`docs/adr/0005-no-business-authorization.md`).

## Getting started

```bash
# Prerequisites, all pinned in-repo: node 24.20.0, pnpm 12.8.1, moon 2.5.6,
# cocogitto 7.0.0 (.prototools, .node-version, package.json#packageManager).
proto install          # moon, proto, cocogitto
pnpm install

# The three Identity Workers, each in its own terminal.
moon run identity:dev
moon run identity-admin:dev
moon run identity-jobs:dev

# The two Identity web apps.
pnpm --filter identity-web dev
pnpm --filter identity-admin-web dev

# The public home-web application (independent, no Identity runtime).
moon run home-web:dev
```

Then read [`docs/getting-started/local-development.md`](docs/getting-started/local-development.md).

**There is no development authentication bypass** — not a flag, not an env var,
not a "demo account". Local development runs the same code path as production,
with real secrets from a gitignored `.dev.vars`
(`docs/adr/0009-no-auth-bypass.md`). A bypass in a development build is a bypass in
production, because nobody ever removes it.

## The gates

```bash
pnpm verify          # format, lint, typecheck, tests, architecture check
pnpm arch            # the architecture guard, on its own
pnpm arch:canary     # proves the guard still catches what it exists to catch
```

The Rust side, in full:

```bash
cargo test --workspace --locked
cargo clippy --workspace --all-targets
cargo doc --workspace --no-deps
```

`moon run identity-domain:test-invariants` runs the `#[ignore]`d domain
invariants — the six rules the security model rests on — and answers "how much
of the security model is real yet?".

## Layout

```
apps/
  identity/worker/            the identity Worker          (identity)
  identity/web/               the end-user UI + BFF        (identity)
  identity-admin/worker/      the operator console Worker  (identity-admin)
  identity-admin/web/         the operator console UI      (identity-admin)
  identity-jobs/worker/       the background worker        (identity-jobs)
crates/
  identity-domain/            users, identities, sessions, invariants
  identity-application/       use cases; depends on the domain and nothing else
  identity-oidc/              OIDC wire types; no flow runs yet
  identity-security/          ten service interfaces; no cryptography of its own
  identity-cloudflare/        D1, Queues, KV, WebCrypto adapters
  identity-testkit/           deterministic test doubles
contracts/                    four versioned API contracts
database/                     forward-only, additive migrations
docs/                         architecture, security, operations, ADRs
infra/cloudflare/             wrangler configuration per environment
tooling/                      the architecture guard and CI helpers
tests/                        cross-boundary suites (mostly deferred)
```

The dependency law between those crates is in
[`docs/architecture/crate-dependency-law.md`](docs/architecture/crate-dependency-law.md)
and is enforced from `cargo metadata`, not from source text.

## Deployment

Three environments — `development`, `staging`, `production` — configured in
`infra/cloudflare/`. Staging deploys automatically on a merge to `main`.
Production promotes **immutable Worker versions** through a canary ladder:
smoke → 1% → health gate → 10% → **human approval** → 50% → 100%. Admin and
Jobs go to 100% automatically; they hold no data, so the blast radius of a bad
one is an outage, not a compromise.

Release is not deployment. Release Please owns the version, the release PR and
the tag; a human merges that PR; promotion is a separate act with its own
approval. Rollback promotes a version id that already exists — it never checks
out, builds, tests or packages, because a rebuild produces a _new_ version
rather than restoring the old one
([`docs/operations/rollback.md`](docs/operations/rollback.md)).

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. It is the authority on what a diff gets
rejected for, and the architecture map at the top tells you which document owns
which fact.

Commits are [Conventional Commits](https://www.conventionalcommits.org/) with
this repository's scopes, validated by Cocogitto. Every commit is
cryptographically signed. Every PR lands through the merge queue.

**Security issues do not go through issues or pull requests** — see
[`SECURITY.md`](SECURITY.md) and email the maintainer.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE). The licence is the organisation's
standard across its repositories; it is not a statement that this repository is
public, and a public surface will not appear without a decision recorded in
`docs/adr/`.
