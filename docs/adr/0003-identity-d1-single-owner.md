# Identity D1 is reachable only by the Identity Worker

<!--
What this file is: ADR-0003, the record of the single-writer rule for identity
state and — more importantly — of why the rule is enforced by configuration and
by a checker, and not by a runtime check.

What this file is **not**: a description of a runtime guard. There is no runtime
check, by decision. This ADR is about the absence of one.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `infra/cloudflare/`, `tooling/scripts/check-architecture.mjs`
- **Constraints covered:** 1, 2, 12, 21, 24, 29

## Context

`IDENTITY_DB` is a Cloudflare D1 database. It holds every user, every identity
link, every authenticator enrollment, every session, every application
registration and its client-secret hash, every OTP challenge, every audit event
and every outbox row. It is the most valuable table in the organisation and the
one component whose compromise is equivalent to the compromise of every account
on the platform.

D1 has no per-caller authorisation. The binding is a capability: an isolate that
holds it can read and write every row, and there is no read-only variant, no
per-query grant and no row-level policy. The only question D1 answers is whether
this isolate was handed the capability at all.

The founding constraint is therefore unusually absolute, and each clause of it
rules out a different way of losing:

> Identity D1 is accessed **only** by the Identity Worker. No other Worker, no
> other code path, no script, no migration runner outside the Worker.

"Only by the Identity Worker" excludes the other two Workers. "No other code
path" excludes a second route inside `identity` that writes a table it should not
— a report query, an export, a debug handler. "No script" excludes a Node
script, a Python script, a `psql`-alike or a one-off shell. "No migration runner
outside the Worker" is the clause that people forget, and it is the one with the
longest reach: a D1 migration applied by a laptop, or by a CI job holding a
production API token, is a second writer with a second set of intentions, a
different version of the schema and no audit trail.

There is also a constraint that interacts with this one: no KV and no Durable
Objects as authoritative identity state in bootstrap (constraint 24). A KV entry
that a security decision reads is a second source of truth, and a second source
of truth is a disagreement waiting to happen at 3am. `IDENTITY_KV` and
`JOBS_KV` exist and are rate-limit counters and scratch space; they are named
precisely so that a reader knows they are not authority.

## Decision drivers

- The capability must be _absent_ from the other two Workers, not merely unused.
  An absent capability is a control; an unused one is a request.
- The rule must be checkable by a script, because the sentence that will be said
  in six months is "this query is simpler through D1" and it will be said
  sincerely, by someone writing a report an operator genuinely needs.
- The rule must be checkable from the repository's own index rather than from
  source-text heuristics, so a clever import or a barrel re-export cannot defeat
  it.
- The migration path must be a deployment, like everything else, or a
  production schema is one developer's laptop away from being different.
- A second reader of the _same_ bytes is what breaks audits, because the read is
  then not attributable to an actor in the identity audit trail.

## Decision

**`IDENTITY_DB` is bound in exactly one place: the `identity` Worker's
`wrangler.jsonc`, in each environment under `infra/cloudflare/`. No other Worker,
no code path, no script and no migration runner may access it.**

Concretely, from now on:

1. `grep -rn "IDENTITY_DB" infra/cloudflare/` returns hits in exactly one file
   per environment, the `identity` one. If a second file names it, the
   architecture check fails and the build is red.
2. `identity-admin` and `identity-jobs` hold no D1 binding for identity state in
   any environment, and a future own-database for either of them must be bound
   under a **different name** so the grep above stays a one-line proof.
3. **Migrations are applied by the Identity Worker, or by an action that first
   authenticates as it.** There is no migration runner outside the Worker. A
   migration is a deployment: a `wrangler d1 migrations apply` against a
   production database requires a credential that only the deploy path holds, and
   the migration appears in the deploy workflow as a step that runs inside the
   same gated pipeline as the code that expects it
   ([ADR-0014](0014-canary-promotion-identity.md)). The migration path is **per
   Worker**: the `identity` deployable's `wrangler.jsonc` declares `migrations_dir`
   pointing at `database/identity/migrations/`, and that is the only
   `migrations_dir` in the repository. `database/admin/migrations/` exists and is
   empty, because the Admin Worker holds no database and therefore has nothing to
   migrate ([ADR-0004](0004-admin-worker-holds-no-database.md)). The split is by
   **data owner**, not by convenience.
4. **There is no runtime check that a call came from `identity`.** This is the
   decision that is easiest to get wrong by instinct. A runtime guard — a header,
   an internal-token comparison, a route allowlist — is a control that can be
   wrong, that has to be maintained, that a bug can bypass, and that gives the
   false comfort of enforcement while the capability is still handed to the
   isolate. The enforcement is the absence of the binding, and the absence is
   maintained by the checker.

**Enforcement:**

| Boundary                                                                                   | Enforced by                                                                                                                                                                                                                                                                                 | Exists today                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY_DB` appears in one `wrangler.jsonc` per environment                              | `tooling/scripts/check-architecture.mjs`'s `boundary-1-admin-d1`, over the files in `infra/cloudflare/{development,staging,production}/`, run by `pnpm arch` from `package.json#scripts.arch` and by CI                                                                                     | Yes for the binding half — I ran the script on this tree and `boundary-1-admin-d1` reported 0 violations, with two warnings for comments in `apps/identity-admin/` that _name_ `IDENTITY_DB`. The wrangler-config paths the script reads are `infra/cloudflare/<env>/<worker>/wrangler.jsonc`, which is the layout that has landed                                        |
| `identity-admin` and `identity-jobs` cannot reach identity state even through a dependency | The same script's `boundary-2-jobs-isolation`, judging the crate graph from `cargo metadata` and the git index; `apps/identity-admin/worker/Cargo.toml` deliberately names no identity D1 adapter, and its own comment says why a manifest omission cannot be bypassed by a careless import | Yes. I ran the script on this tree and `boundary-2-jobs-isolation` reported `ok`, 0 violations. The manifest omission is committed                                                                                                                                                                                                                                        |
| No migration runner outside the Worker                                                     | The `migrations_dir` declared in each `identity` wrangler config, which is the only `migrations_dir` in the tree; the migration step in the deploy workflow; and the absence of any other credential that can reach a production D1 database                                                | **Partially built.** The `migrations_dir` and `migrations_table` are committed in `infra/cloudflare/{development,staging,production}/identity/wrangler.jsonc`. The workflow step is `DEFERRED` to the release phase — `.github/workflows/` is empty at the time of writing                                                                                                |
| KV and Durable Objects are not authoritative                                               | `tooling/scripts/check-architecture.mjs`'s `no-authoritative-kv-or-do`, which fails on any `durable_objects` binding and warns on any `kv_namespaces` binding, restating the constraint at the point of the binding                                                                         | Yes, and it is already saying something. I ran the script on this tree: 0 violations, 6 warnings, one for each `IDENTITY_KV` and `JOBS_KV` declaration. The bindings exist with the role-names-you-can-trust naming ([ADR-0008](0008-webcrypto-only.md)'s reasoning about names applied to storage); the warning is the check refusing to take the declared role on trust |
| `check-architecture.mjs` itself has not been weakened                                      | `pnpm arch:canary` — a fixture tree that violates the law in the exact ways the documents forbid must fail with the exact violations, while the real tree stays clean                                                                                                                       | **Enforcement not yet built.** The check script and its `__fixtures__/` tree are landing concurrently and I have read only the `CHECKS` array; the `canary` script is named in the `AGENTS.md` contract and `tooling/scripts/check-architecture.test.mjs` is being written beside the script                                                                              |

## Consequences

### Easier

- **The strongest control in the system is a capability, not a check.** A
  determined bug in `identity-admin` — a path traversal, an injection in a filter,
  a confused deputy in a handler — stops at the edge of a binding the isolate was
  never given. There is no code to be correct, because there is no code path.
- **One component decides who may see identity data.** Every read and every write
  goes through an `identity-application` command that has an actor, a rule and an
  audit event, all inside one transaction. The audit trail is a property of the
  mutation rather than of a caller's logging.
- **A grep is a proof.** `grep -rn IDENTITY_DB infra/cloudflare/` is a
  one-command answer to "is the Admin Worker still holding the database", which
  matters more than it sounds: the question is asked during an incident review, by
  someone who did not write the system.
- **Migrations are ordinary deployments.** A schema change goes out the same
  gated path as the code that needs it, so "the migration is applied but the code
  is not" cannot be a state a production database is in. That also makes
  [ADR-0011](0011-forward-only-migrations.md) enforceable: the forward-only rule
  is what makes it safe to apply a migration _before_ the code that reads the new
  shape is live, and applying it through the deploy pipeline is what makes "before"
  a thing that happens automatically.
- **The `identity-cloudflare` adapter crate is a single seam.** D1 access is
  written once, in one crate, reviewable as one piece. A SQL mistake is a bug in
  one place rather than a pattern repeated across three Workers.

### Harder or more expensive

- **Reports and exports get slower to build.** Every read an operator wants has
  to become an internal endpoint on `identity`, which is one reviewed use case per
  read rather than one SQL query. This is the friction
  [ADR-0004](0004-admin-worker-holds-no-database.md) absorbs on behalf of the
  Admin Worker, and it is a real tax paid in maintainer's time.
- **No ad-hoc data access, ever.** "Just run this query against production" is
  not available. A support question that needs a fact nobody thought to expose
  becomes an ADR and a migration rather than a `psql` invocation. During an
  incident that is painful, and the answer has to be "the endpoint you need does
  not exist yet", which is an admission, not a fix.
- **The single writer is a throughput ceiling.** Every identity read and write
  serialises through one deployable's concurrency. For an organisation's scale
  that is not a real limit; for a public signup spike it would be, and the
  answer then is caching (counters, which are already non-authoritative) or
  replicas, not a second writer.
- **"No other code path" is the clause that costs the most to hold.** A new
  internal admin endpoint on `identity` is fine; a new _read_ endpoint that joins
  tables the caller did not name is how the "only by the Identity Worker" claim
  quietly becomes "also by a read-only thing in the same Worker". Keeping that
  reviewable is a per-PR discipline, not an automated gate.
- **The absence of a runtime check is uncomfortable.** An engineer who cannot add
  a guard against a wrong caller will look for a way to add a guard, and a header
  check looks like a guard. It is not one. This ADR's revisit condition names the
  situation where a real one becomes available.

### What a future maintainer will resent

- **"This query is simpler through D1"** is the sentence. It will be said about a
  report an operator genuinely needs, by someone trying to help, and it will feel
  like obstruction rather than architecture. It is the reason the enforcement is a
  script and not a code review habit: the script will say no, and that answer will
  not depend on who is arguing.
- **Debugging production data will be harder than it is elsewhere.** A schema
  question at 2am will be answered by the migrations and the contract, not by
  opening a connection. Expect the irritation, and treat it as the cost of the
  blast-radius argument rather than a bug to be fixed by relaxing the rule.

## Alternatives considered

### A read-only D1 credential for `identity-admin`

**Rejected**, and it was the closest alternative. Cloudflare does not offer a
read-only D1 binding today, so this would have had to be approximated, and the
approximations are all bad: a second D1 database with a synchronised subset (a
second source of truth that disagrees); a SQL view layer maintained by hand (the
same queries, reviewed somewhere else); or a stored procedure in D1 (still the
Admin Worker deciding what a report shows, just one level down).

The general argument is worth stating because it will recur: **D1 credentials are
read/write authority over the whole database, so a read-only capability built on
a read/write credential is a reduced-privilege convention, not a
reduced-privilege design** — and conventions are what fail at 2am. A feature that
returns a CSV of users and sessions is exactly the feature where "it is only
read" is true of the intent and irrelevant to the credential.

### A runtime check inside `identity`: internal callers present a signed header

**Rejected.** It is the most natural instinct and it is wrong here, for three
reasons. It does not actually work: a runtime check cannot take the capability
away, so the other Workers must still hold the D1 binding for the check to have
anything to check, and every moment they hold it, a bug is a full compromise. It
adds a secret that must be shared with every caller, which is a credential in
`infra/cloudflare/` and a rotation obligation. And it is bypassable by a bug in
exactly the way that matters: a route that forgets the check is a public route
that reads the users table, and the failure is silent.

The rule is a capability boundary, and capabilities are not checkable at runtime
— they are checkable at the place the capability is granted. That place is a
`wrangler.jsonc` and a Cargo manifest, which is where this ADR puts the check.

### A shared database accessed by all three Workers, with row-level authorisation

**Rejected.** Row-level authorisation in the application layer is a policy every
query has to remember, and a policy every query has to remember is a policy one
query will forget. It also destroys the audit argument: with three writers, the
question "who changed this row" has three answers and the "last administrator
cannot be demoted" rule has to be enforced in each path, which is the failure
mode `identity-application/src/administration.rs` is explicitly written to avoid
(`RoleChangeRequest::evaluate` needs a count of administrators inside the
transaction, and it is in one place for that reason).

### External migrations — `wrangler d1 migrations apply` from a laptop with a production API token

**Rejected**, and this one loses specifically because it is convenient. A
production token on a developer machine is constraint 27's violation wearing a
migration's clothes, and it makes the schema a thing that changes at times
unrelated to the release cadence. It also destroys the forward-only guarantee in
practice: a migration applied ad hoc is a migration applied without the rollback
path being considered, and the absence of that path is the entire content of
[ADR-0011](0011-forward-only-migrations.md).

### D1 read replicas for reporting, with `identity` as the only writer

**Not rejected; deferred.** This is the credible version of the reporting
problem, and it does not violate the letter of the constraint — a replica is not
`IDENTITY_DB` — but it introduces a replication lag into an identity system's
reads, which is a new class of "the answer was correct five seconds ago". It is
named here so that when someone proposes it, the answer is "revisit", not "no".
See the revisit conditions.

## Revisit when

- **Cloudflare ships a read-only or per-caller D1 credential.** The
  confused-deputy argument in
  [ADR-0004](0004-admin-worker-holds-no-database.md) is about _authority_, and a
  genuine read-only capability would answer part of it honestly. It would not
  answer the audit-trail half, so a read-only binding would still not justify
  putting report queries in the Admin Worker.
- **Cloudflare ships a first-class transactional outbox or a database-integrated
  queue**, which changes the outbox argument in
  [ADR-0007](0007-outbox-pattern.md) and may change where the dispatcher runs.
- **A fifth deployable appears with a different data-ownership story** — for
  example a component that legitimately needs its own authoritative store and no
  path to identity state. That is a [ADR-0002](0002-three-deployables-and-no-more.md)
  question first and this one second.
- **A support workflow needs a read the internal endpoints cannot serve within
  one round trip**, and the aggregate pattern shows up in the logs: the same
  operational question producing more than a handful of endpoint requests. At
  that point the honest options are a narrower read model or a read replica, and
  this ADR should be reopened to say which.
- **A second writer becomes unavoidable for throughput**, observable as
  write-latency at the Identity Worker's concurrency limit under a load the
  organisation's own traffic does not produce. The answer then is sharding inside
  `identity` or a Durable Object, not a second binding — and constraint 24's
  "in bootstrap" wording is what this revisit is for.
- **Any proposal appears for a Durable Object holding authoritative state**, even
  within `identity`. That is a real change to what "single source of truth" means
  and it needs its own ADR rather than a config edit.

## Related

- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md)
  — why the "only by the Identity Worker" is a sentence about exactly one deployable
- [ADR-0004 — The Admin Worker holds no database](0004-admin-worker-holds-no-database.md)
  — the boundary this rule is most often tested by
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — the same rule from the queue's side
- [ADR-0007 — The outbox pattern and the absence of atomicity](0007-outbox-pattern.md)
  — why the migration is a deployment and the queue write is not a transaction
- [ADR-0011 — Forward-only, backward-compatible database migrations](0011-forward-only-migrations.md)
  — the rule that makes "apply before the code" safe
- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — why migrations ship through a promotion path
- `docs/architecture/worker-architecture.md` — the binding table, with the roles of the KV namespaces
- `docs/architecture/trust-boundaries.md` — boundary 2, the Worker to D1 edge
- `docs/architecture/admin-isolation.md` — the long-form argument on the other side
- `tooling/scripts/check-architecture.mjs` — where the rule is executed
