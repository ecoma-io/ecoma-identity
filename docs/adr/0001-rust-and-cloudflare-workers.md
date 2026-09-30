# Rust and Cloudflare Workers on the platform

<!--
What this file is: ADR-0001, the record of why the platform is Rust on
Cloudflare Workers, and why the WebAssembly-native Worker runtime rather than a
TypeScript Workers implementation.

What this file is **not**: a language preference, a benchmark report, or a claim
that the alternative would not have worked. It lost on specific counts, below.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** the bootstrap of this repository; the nine-crate Cargo
  workspace in `Cargo.toml`
- **Constraints covered:** 7, 9, 11, 25 (the platform decision constrains what the
  others can be implemented in), 29

## Context

Ecoma Identity is the identity plane for the Ecoma organisation: one service
that owns users, identities, sessions, authenticators and OAuth applications,
and answers "who is this request made by" for every other repository. Every
Ecoma repository is a solo-founder operation with a strict bar on code that a
reviewer has to take on faith, and this one holds every credential the
organisation has. It also has to run at a scale where an identity outage is an
organisation-wide outage, on a platform whose pricing model favours the platform's
own language.

The platform choices had to be made before any authentication code exists, and
they determine the shape of every line that will follow. Four forces made this
decision hard rather than routine:

1. **The rules must be reviewable without a platform.** Whether a user may
   authenticate, whether a session is live, whether the last administrator can be
   demoted — these are the rules the whole organisation's security rests on. They
   have to be expressible, testable and readable without booting a runtime, a
   database or a network. That argues for a language where a domain model is a
   set of types rather than a set of classes wired to a framework.
2. **The cryptography has to be WebCrypto, which is a platform API, not a
   library** (constraint 25, [ADR-0008](0008-webcrypto-only.md)). Whichever
   language is chosen, the primitives arrive from the Workers runtime. A language
   with weak WebCrypto bindings turns constraint 25 from a rule into a
   temptation, and a temptation is what a deadline produces.
3. **The deployment model is Cloudflare's, not ours** (constraints 9–14, 16, 18).
   Production promotion is an immutable Version promoted by id, which means the
   deployable must compile to something the Workers runtime accepts and that
   `wrangler versions upload` can address. That is a hard requirement, not a
   preference, and it rules out any deployment target where a rollback means
   "redeploy the previous commit".
4. **The organisation already runs Rust.** The dependency graph in `Cargo.toml`
   and the tooling in `.moon/`, `.prototools` and `package.json` are shared
   vocabulary across the org, and a second language for a second service is a
   second toolchain, a second review skill and a second class of bug.

The specific question this ADR answers: Workers supports TypeScript, JavaScript
and Rust. Why is the platform Rust when the frontends are TypeScript?

## Decision drivers

- The identity rules must be provable in isolation, with no platform in the
  dependency graph of the crate that holds them.
- WebCrypto must be the _only_ source of cryptographic primitives, which means
  the bindings must be first-class and hard to misuse.
- The deployable must be a Cloudflare Worker uploadable as an immutable Version,
  because rollback is version promotion ([ADR-0013](0013-immutable-worker-versions.md)).
- One toolchain per organisation, not one per service.
- A domain model that reads as types: `SessionStatus::permits_authentication` is
  a total function over a small enum, not a method dispatching to a service.
- Dependency direction must be checkable from `cargo metadata` by a script
  ([ADR-0003](0003-identity-d1-single-owner.md),
  [ADR-0006](0006-jobs-worker-owns-no-identity-state.md)), which means the
  boundaries must be manifest edges, not directory conventions.

## Decision

We implement the platform in **Rust on Cloudflare Workers**, using the
`worker` crate (worker-rs) with the `d1`, `queue` and `http` features enabled
workspace-wide, and `worker-macros` for the `#[event]` and `#[worker]` entry
points. The web apps are TypeScript and Vue, compiled by `vite` and shipped as
Cloudflare Static Assets through the `ASSETS` binding; they share no Rust crate
with the Worker behind them, by [ADR-0015](0015-frontend-and-bff-one-release-unit.md).

The Cargo workspace at the repository root is the single Rust build, with
`resolver = "3"`, edition 2024, `rust-version = "1.85"` and workspace-inherited
lints (`unsafe_code` forbidden, clippy `all` denied, `pedantic` warned,
`missing_docs` denied at each crate root). The nine members are
`identity-domain`, `identity-application`, `identity-oidc`, `identity-security`,
`identity-cloudflare`, `identity-testkit`, and the three Worker composition roots
`identity-worker`, `identity-admin-worker`, `identity-jobs-worker`. The
dependency direction among them is law, stated in `Cargo.toml` and judged by
`tooling/scripts/check-architecture.mjs`.

A constraint that follows from this choice and is therefore in force from now on:
`identity-domain` depends on **no** other workspace crate and on **nothing from
the platform** — no `worker` crate, no D1 type, no Cloudflare type. The rules that
decide what a valid user, session or application _is_ must remain true no matter
which runtime evaluates them, and a Cloudflare type in that crate's dependency
graph would make that untrue the first time the platform changed.

**Enforcement:**

| Boundary                                                         | Enforced by                                                                                                                        | Exists today                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language and runtime                                             | `Cargo.toml` `[workspace]`, the `worker` dependency in `[workspace.dependencies]`, `rust-version = "1.85"`                         | Yes                                                                                                                                                                                                                  |
| `identity-domain` depends on nothing internal or platform-shaped | `tooling/scripts/check-architecture.mjs`'s `boundary-3-domain-platform`, judging the graph from `cargo metadata` and the git index | Yes — I ran the script on this tree and `boundary-3-domain-platform` reported `ok` with 0 violations                                                                                                                 |
| No `unsafe` anywhere                                             | `[workspace.lints.rust] unsafe_code = "forbid"`, inherited by every crate                                                          | Yes                                                                                                                                                                                                                  |
| Per-crate lint escapes are visible diffs                         | `[lints] workspace = true` in every crate; a crate needing an escape must write its own `[lints]` table                            | Yes — nine of nine manifests inherit the workspace table                                                                                                                                                             |
| No cryptography crate is ever added                              | `AGENTS.md` ("Dependencies are architecture"); the primitives come from `worker`'s WebCrypto module                                | **Prose only.** No check in `tooling/scripts/check-architecture.mjs`'s `CHECKS` array judges the dependency allowlist; see [ADR-0008](0008-webcrypto-only.md), which records the same gap and names what should land |
| MSRV                                                             | `rust-version` in `[workspace.package]`, and CI running that floor in addition to `stable`                                         | The field is committed; the CI job is `DEFERRED` to the platform phase and I have not seen `.github/workflows/` — the directory is empty at the time of writing                                                      |

## Consequences

### Easier

- **The domain rules are testable with nothing running.** `cargo test -p
identity-domain` needs no database, no network, no `wrangler`. The
  `#[ignore]`d invariant skeletons in `crates/identity-domain/src/invariants.rs`
  are the mechanism: they name the rule, they are not ignored by accident, and
  `moon run identity-domain:test-invariants` runs them ignoring the ignore so a
  maintainer can ask how much of the security model is real yet. That question has
  a command, which is worth more than the answer would have been.
- **The dependency law is checkable from outside the compiler.** `cargo metadata`
  is JSON. A script can read it and refuse an inverted edge, which is how
  [ADR-0003](0003-identity-d1-single-owner.md),
  [ADR-0004](0004-admin-worker-holds-no-database.md) and
  [ADR-0006](0006-jobs-worker-owns-no-identity-state.md) get their teeth. In a
  TypeScript implementation the same boundaries would live in `tsconfig` path
  aliases or eslint `no-restricted-imports`, both of which are conventions a
  bundler can defeat and neither of which appears in a dependency graph a script
  can read.
- **WebCrypto is reached through a typed API, not a global.** `worker::crypto`
  takes and returns Rust types, so a key is a typed value rather than a
  `CryptoKey` from a namespace. `identity-security` can declare the _questions_
  — `OtpService`, `TotpService`, `PasskeyService`, `TokenSigner`,
  `SecretCipher` — as traits with typed, fallible methods, and the WebCrypto
  implementation arrives later without a caller noticing. That is what
  [ADR-0008](0008-webcrypto-only.md) needs in order to be a rule rather than a
  preference.
- **One toolchain across the organisation.** `cargo fmt`, `cargo clippy`,
  `cargo doc`, moon tasks, `.prototools` and `.moon/toolchains.yml` are the same
  vocabulary the other Ecoma repositories use. A maintainer who has reviewed
  Rust in one repository has reviewed the toolchain in all of them.
- **The type system does the enforcing.** `SecurityVersion::bumped` returns a
  `Result` and refuses to saturate, because a saturating bump would look like it
  revoked every session and would not. `Aal::satisfies` is a total comparison
  with the direction written into the parameter names. `EmailAddress` refuses a
  missing or repeated `@` in its constructor. None of those are checks a reviewer
  has to remember; they are types.

### Harder or more expensive

- **Compile times are real and they are paid on every loop.** Nine crates in one
  workspace with `worker` pulling in a large tree means a cold `cargo check` is
  minutes, not seconds. The root `moon.yml` sets `cache: false` on the cargo
  tasks deliberately, so the first iteration is genuinely slow. The org-wide
  alternative was fast feedback and a weaker boundary.
- **The async story is heavier.** `worker` is async, D1 is async, and
  `identity-application` traits are async. Every command signature carries
  `.await` and every trait definition carries the associated future, which makes
  the trait scaffolds in `identity-application` longer than the equivalent
  TypeScript and slightly harder to read. A reviewer has to hold more in their
  head to check a signature.
- **WebCrypto's surface is narrower than the crypto crates' surface.** Anything
  WebCrypto does not offer is unavailable, and the answer is a design change
  rather than a dependency. That is the intended pressure — see the alternative
  below — but it is a real tax: some designs that would be trivial with
  `argon2` or `subtle` are simply not available here, and the work becomes
  "restructure so the primitive is not needed".
- **The frontend and backend have different type systems.** A wire type has to
  live in `contracts/` and be generated into both a TypeScript type and a Rust
  type. The Vue app cannot import a Rust type, and the Rust crate cannot import a
  `.ts` file. That is the BFF boundary
  ([ADR-0015](0015-frontend-and-bff-one-release-unit.md)) made concrete, and it
  costs a contract-generation step that a single-language implementation would not
  need.
- **WebAssembly cold starts are worse than a JS isolate's.** A Rust Worker pays a
  larger instantiation cost per request. For this system that is acceptable
  because the request rate is an organisation's, not a public API's, and the
  alternative is a language with weaker guarantees; but it is a real cost and a
  traffic spike is where it shows.

### What a future maintainer will resent

- **The build is slow and it will get slower as crates are added.** The first
  complaint about this decision will be "cargo is taking four minutes", and it
  will be correct. The answer is that the boundaries being bought are worth more
  than the minutes, and that removing a crate to save compile time is a proposal
  to weaken a boundary.
- **Reading the Worker composition roots is not the same as reading the product.**
  `apps/identity/worker/src/lib.rs` is wiring. Every real rule is two crates
  away, and the instinct to put a check "right here, in the Worker" is the exact
  instinct [ADR-0004](0004-admin-worker-holds-no-database.md) and
  [ADR-0006](0006-jobs-worker-owns-no-identity-state.md) are built to stop.
- **Every new dependency needs an architectural argument, not just a need.** The
  bar is high enough that people will try to route around it, and "it is just a
  helper crate" is how the graph gets its first wrong edge.

## Alternatives considered

### TypeScript Workers (`wrangler`'s native support, with Hono or a similar framework)

**Rejected**, and it was close. TypeScript has the two advantages that matter
most in a bootstrap — it is what the web apps are written in, so a wire type is
one declaration rather than two, and a solo maintainer moves fast in it. Against
that:

- The dependency-boundary mechanism is weaker. A TypeScript implementation would
  have to express "the Jobs Worker may not reach identity rules" as a lint rule
  and a directory convention. `check-architecture.mjs` reads `cargo metadata`
  because cargo's manifest _is_ the graph; a TypeScript graph is assembled at
  bundle time from import statements, and the imports that matter are exactly the
  ones a bundler resolves through a barrel file. The check would become a
  heuristic over source text, which is the class of check that passes on the day
  it is written and fails quietly afterwards.
- The domain types would be runtime assertions, not type errors. `SessionStatus`
  being a union is worth little if a plain object can be cast into it at any
  call site. Constraint 25 and constraint 9 have no such gap in Rust, and that gap
  is the kind that only shows up in production.
- It would have been the second language with a build step and a type system
  anyway, not the removal of one.

What would have changed the answer: if the architecture checker had to be a
lint-rule-plus-convention instead of a manifest read, _and_ the maintainer had
been unwilling to maintain a codegen step for wire types, TypeScript would have
won on cost.

### Go on Cloudflare Workers (`workerd` compiled via wasm)

**Rejected.** Go produces a large binary, its WebCrypto story on the platform is
poor, and it would be a third language in an organisation that already has
TypeScript and Rust. It also forfeits the trait-based gates in
`identity-security`, which are most naturally expressed as interfaces with
fallible, typed methods.

### A containers-on-Cloudflare deployment, or any non-Workers host

**Rejected**, and not narrowly. The whole deployment model — immutable Version
promoted by id, canary percentages, `wrangler rollback` — is
[ADR-0013](0013-immutable-worker-versions.md) and
[ADR-0014](0014-canary-promotion-identity.md). A container host would give
rollback a meaning that is "redeploy the previous image", which is the same
meaning as rebuilding, and that is the one thing constraint 14 rules out. Adopting
it would have meant rewriting the deployment model before writing any
authentication.

### Node.js on a container host with a relational database

**Rejected.** The nearest alternative by popularity, and the one that loses on
blast radius rather than on principle. A conventional auth service gets its own
database, its own migrations with a real rollback path, its own connection pool
and its own outage domain. Every one of those is an asset when you own the
machine and a liability when the service holds every credential in the
organisation. It also makes constraint 21 (forward-only migrations) easier to
violate, because a conventional host makes "roll the migration back" look like an
available option.

## Revisit when

- **Cloudflare ships a first-class Workers support for a language whose
  dependency graph is as inspectable as cargo's** and whose WebCrypto bindings are
  as typed. That would reopen the TypeScript question, and the answer would
  probably still be no — the organisation's Rust investment is the larger force.
- **`worker` stops supporting a toolchain the org uses**, or a platform change
  makes the crate unmaintained. The MSRV floor in `Cargo.toml` is the tripwire;
  if it cannot be met with a maintained release, this ADR is reopened.
- **A cryptographic primitive is needed that WebCrypto genuinely does not
  provide** and that a maintained crate does. This is a
  [ADR-0008](0008-webcrypto-only.md) revisit, not this one, and per
  `AGENTS.md` it is answered with "the design is wrong" until proven otherwise.
- **The compile-time cost becomes the dominant contributor to review latency**
  and the boundary checks are not the reason anyone notices. Measure before
  reopening; a fast build with an unenforced boundary is the worse outcome.

## Related

- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md)
  — the topology this language choice is spent on
- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — the boundary the manifest graph exists to keep
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — the boundary that costs the most to violate
- [ADR-0008 — WebCrypto only; no self-implemented cryptography](0008-webcrypto-only.md)
  — the constraint that made the runtime choice matter
- [ADR-0015 — Frontend and BFF are one release unit](0015-frontend-and-bff-one-release-unit.md)
  — what the two-type-system consequence buys
- `Cargo.toml` — the workspace, the lint bar, and the dependency law in manifest form
- `AGENTS.md` — the conventions this choice imposes on every later change
