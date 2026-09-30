# The Admin Worker holds no database

<!--
What this file is: ADR-0004, the record of the single hardest negative in the
platform — `identity-admin` has no D1 binding for identity state, ever — together
with the escalation path for the day the binding is not enough.

What this file is **not**: a description of the admin console, an admin route
list, or a plan for an admin database. The console does not exist yet; the routes
are `DEFERRED`.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `apps/identity-admin/worker/`, `docs/architecture/admin-isolation.md`
- **Constraints covered:** 3, 4, 7, 8, 28, 29

## Context

`identity-admin` is the operator surface: the administrative BFF behind
`apps/identity-admin/web`, and the deployable an administrator's browser talks to.
It is a separate Worker for a specific reason — it is the component most likely to
be compromised and the least likely to be the target of a careful attack. It is
internal-facing, with a small enumerable route set, and it is where a new report
goes, where a temporary incident script gets wired in, and where the inputs are
partly free-text search terms typed by people in a hurry. It has the lowest
input quality in the system.

The constraint says it must not access Identity D1 directly, and must reach
identity through a private service binding to the Identity Worker. Two arguments
make that more than a preference, and they are independent.

**The confused deputy.** A deputy acts with another's authority. The classic
form appears the moment a component is asked a question it is not the authority on
and answers it in terms of what it can see. Suppose the Admin Worker could read
D1. An operator asks for "list users matching this filter as a CSV report". If the
report is built with SQL written in the Worker, then a function whose job is
formatting has become the thing that decides which columns of which rows are
visible. Its author was thinking about CSV column order, not about having just
written an authorization decision. The same happens without malice: a report that
joins `users` to `sessions` to `audit_events` will, in the ordinary course of
being useful, include session identifiers and last-used timestamps, which are
credentials-adjacent; a "count this user's sessions" widget becomes a per-user
activity signal, and in an identity system knowing when a specific person is
active is the first half of an account takeover; and a filter parameterised as
`${filter}` rather than as a bound parameter is not an attack anyone has to
attempt, it is a maintenance accident waiting for a feature request that mentions
a specific email address.

None of these need an attacker, which is the point. Each is a plausible feature
one line away from turning the Admin Worker into an unauthenticated-in-practice
read path over the user table, guarded by whatever the report's own access check
happens to be. And once the query is in the Worker, the audit trail for the read
is the report writer's own logging, not the Identity Worker's — a hole in the
audit trail exactly where the system is least likely to be looking.

**Blast radius.** Given that this is the component most likely to be reached by
accident and least likely to be attacked deliberately, the question is what an
attacker who reaches it gets. Through reviewed internal endpoints: whatever those
endpoints were designed to expose, with every read attributable to an actor in the
identity audit trail. Through Identity D1 directly: the entire user table —
every user, every identity, every authenticator, every session, every application
registration and its client-secret hash. Password-equivalent for every account on
the platform, immediately, with no further work. There is no middle option, and
there is no read-only D1 binding.

The last sentence is the load-bearing one. Blast radius is not a function of how
careful the code is; it is a function of what the component can reach. D1
credentials are read/write authority over the whole database, so a "read-only"
capability built on a read-write credential is a reduced-privilege convention, not
a reduced-privilege design, and conventions are what fail at 3am.

**And the honest cost:** the binding is a real per-request cost. The service
binding is a network hop from `identity-admin` into `identity`, and every admin
operation pays it. The binding also constrains what the admin surface can be: a
dashboard that needs a wide read has to be composed from narrow internal endpoints
or not built.

## Decision drivers

- The component with the worst inputs must not hold the capability that turns
  those inputs into the whole user table.
- "Do not query it" is a request to be reasoned with at 3am; "there is no
  binding" is a capability the runtime does not hand the isolate, and a bug
  cannot be talked out of a capability it was never given.
- The decision about what an operator may see must be made in the component that
  owns the data, reviewed as an identity decision, and written to the identity
  audit trail.
- Two writers to one table would force the audit trail, the session issuance rules
  and the last-administrator invariant to be enforced twice, once per path, and
  two enforcement points drift.
- The constraint must be greppable and checkable by a script, because a promise
  only a reviewer can remember is a promise that will be broken by someone who was
  not in the room.

## Decision

**`identity-admin` holds no D1 binding for identity state. Its complete binding
set is `IDENTITY` (a private service binding to the Identity Worker),
`ADMIN_RATE_LIMITER`, and `ASSETS` (its static web UI). Every read and every write
of identity state it performs is a typed, audited command inside `identity`,
reached through the `IDENTITY` service binding and by no other route.**

From now on:

1. **There is no `IDENTITY_DB` in `apps/identity-admin/worker`'s
   configuration, in any environment, for any reason.** If the admin surface
   needs a fact, the answer is an internal endpoint on `identity`, not a binding.
2. **The Admin Worker's `Cargo.toml` names no identity D1 adapter.** A
   manifest-level omission is the only kind of boundary that cannot be bypassed by
   a careless import; the omission is written there, with a comment saying why.
3. **Every internal call is a named operation, not a query.** A call names an
   `identity-application` command; `identity` performs its own authorization for
   it, re-deriving the actor from something the Identity Worker issued and can
   verify — never from a header or body the caller supplied. (A private service
   binding authenticates _which Worker_ is calling, not _which operator_. The
   design for that re-derivation is `PLANNED`; it is an open question in
   `docs/architecture/trust-boundaries.md` and will need its own ADR before the
   admin surface is built.)
4. **`identity` writes the state change and the audit event in the same
   transaction.** The audit trail is a property of the mutation, not of the
   caller's logging.
5. **A "read-only report" is not an exception.** The word "read" is not a
   capability level. If the report cannot be served by an internal endpoint, the
   report is wrong, or it belongs to a different database that is not identity
   state.

**What to do when the binding is genuinely insufficient — the escalation path, in
order. This is the part that makes the constraint workable rather than merely
absolute:**

1. **Write down the need.** What does the operator want, and why can they not get
   it another way? A need that cannot be stated in one sentence is usually a UI
   problem, not a data problem.
2. **Check whether the need is a new _endpoint_, not a new _binding_.** Most
   "D1 would be simpler" cases are an endpoint that does not exist yet. A new
   internal endpoint keeps the constraint and costs one reviewed use case.
3. **If it really needs a new read path, it gets a new internal endpoint with its
   own audit event.** Not a bypass, not a report flag — an endpoint.
4. **If the need genuinely cannot be served by `identity` at all, it is not
   identity data, and it belongs to an admin-owned database** bound under a
   _differently named_ binding, so that `grep IDENTITY_DB .generated/cloudflare/` still
   finds the identity binding exactly once. What such a database may contain is a
   `PLANNED` decision with its own ADR. Identity state is never copied into it: a
   copy is a second source of truth, and
   [ADR-0006](0006-jobs-worker-owns-no-identity-state.md) and
   [ADR-0007](0007-outbox-pattern.md) explain why that is worse than it sounds.
5. **If none of the above is possible, write an ADR proposing a change to the
   constraint** and take it through review. There is no path where the answer is
   "this one query is an exception."

**Enforcement:**

| Boundary                                                                    | Enforced by                                                                                                                                                                                                                                                 | Exists today                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `IDENTITY_DB` in the Admin Worker's config, any environment              | `tooling/scripts/check-architecture.mjs`'s `boundary-1-admin-d1`, which reads every `d1_databases` entry in `.generated/cloudflare/<env>/<worker>/wrangler.jsonc` and fails on any of them, run by `pnpm arch` from `package.json#scripts.arch`             | Yes. All three admin configs declare no `d1_databases` block at all, each with a comment recording that the absence is deliberate; I ran the script on this tree and it reported 0 violations, with two warnings for comments in `apps/identity-admin/` that _name_ `IDENTITY_DB` — the check flagging a comment as a thing somebody will later add a binding for |
| The Admin Worker cannot reach identity state through a dependency either    | The same script's `boundary-2-jobs-isolation`, judging the crate graph from `cargo metadata`; `apps/identity-admin/worker/Cargo.toml` deliberately omits the identity D1 adapter and documents the omission in the manifest                                 | Manifest omission yes; the script reported `ok` with 0 violations when I ran it on this tree                                                                                                                                                                                                                                                                      |
| A differently named admin database, if one exists, cannot be identity state | The binding-name grep (step 4 above) plus a per-binding role statement in `docs/architecture/worker-architecture.md`; `database/admin/` is a `PLANNED` decision with its own ADR                                                                            | **Enforcement not yet built.** `database/admin/` exists with empty `fixtures/` and `migrations/` directories, and an empty `migrations/` is this ADR's direct consequence — there is nothing to migrate. `no-authoritative-kv-or-do` warns on any unclassified KV or Durable Object binding, which is the mechanism that would catch one                          |
| The architecture check has not been weakened to make a gate green           | `pnpm arch:canary` — a fixture tree violating the law in the exact forbidden ways must fail with the exact violations, and the real tree must stay clean; never weaken a constraint, widen a fixture's tolerance, or add a suppression to make a gate green | **Enforcement not yet built.** The check script and its `__fixtures__/` tree are landing concurrently and I have read only the `CHECKS` array; the `canary` script is named in `AGENTS.md` and `tooling/scripts/check-architecture.test.mjs` is being written beside the script                                                                                   |

## Consequences

### Easier

- **The strongest control on the admin surface is an absent capability.** A
  determined bug stops at the edge of a binding the isolate was never given.
- **Every identity read and write is attributable to an operator in the audit
  trail**, because the audit trail is written by the component that performs the
  mutation.
- **A compromise of the internal-facing surface with the worst inputs does not
  become a compromise of every account on the platform.** This is the whole
  argument, in one line.
- **The last-administrator rule is enforced in one place**, inside the
  transaction that applies the change — `RoleChangeRequest::evaluate` in
  `identity-application/src/administration.rs`, which needs a count of
  administrators and therefore has to be where the state is, rather than in two
  places that could drift.
- **The admin surface is trivially reviewable.** Every handler is either a typed
  command call or a formatter. There is no SQL in `identity-admin`, and that is a
  property a reviewer can see in a diff without reading a design document.

### Harder or more expensive

- **A "read-only report" is the most expensive thing to build on this platform.**
  It is one narrow, reviewed, audited use case per read, not one query. The
  operator's need is real and the cost is paid in the identity team's time, which
  means the temptation is constant.
- **Every admin operation pays a service-binding hop.** Latency for the admin
  surface is the sum of the two Workers, not the minimum. For an operator surface
  that is acceptable; for a dashboard that renders a dozen reads, it is the reason
  the dashboard needs an aggregate endpoint rather than a fan-out from the browser.
- **The admin surface can be slower to evolve than the data it shows.** A new
  field on `users` is a migration plus, sometimes, a new internal endpoint before
  the console can show it. The console is deliberately downstream of identity.
- **Some genuinely useful queries will be declined.** The escalation path is an
  ADR, not an exception, and an ADR takes a review. When a support workflow is
  waiting, that cost is real and it will be felt as obstruction.
- **The actor re-derivation design is still open.** A service binding authenticates
  the Worker, not the operator, so until that design exists the admin surface
  cannot be built at all. That is the right order — the boundary is decided before
  the thing it protects — but it means the console is further away than the
  binding argument alone suggests.

### What a future maintainer will resent

- **"This query is simpler through D1"** is the sentence, and it will be said
  about a report an operator genuinely needs, by someone trying to help. The
  answer is the escalation path, in order, and the second step (is it an endpoint,
  not a binding?) resolves most of these in one reviewed use case.
- **"But it's only a read."** Being told that a capability is read-only is the
  moment to remember that D1 credentials are read/write over the whole database
  and that the word describes the intent, not the authority.
- **The temptation to add a report flag, a query parameter, or a "temporary"
  bypass.** Those are the three shapes this ADR's enforcement is designed to catch,
  and each of them is the beginning of a bypass that outlives the incident.

## Alternatives considered

### The Admin Worker reads D1 for reports only, with a reviewed query allowlist

**Rejected**, and it was close, and it is the version people propose most often.
The appeal is real: the report works, the console ships, the constraint feels like
a delay. It loses on two independent counts, either of which is sufficient. First,
authority: an allowlist is a list of what the Admin Worker has been _asked_ not to
do, and the mistake that matters is the query nobody thought to add to the list.
Second, and more decisively, D1 has no read-only binding, so a report that "only"
reads still runs on read/write authority over the whole database — a
reduced-privilege convention rather than a design. There is no compensating control
for the blast radius, and the blast radius is every account on the platform.

### The Admin Worker gets its own database, containing a copy of what the console needs

**Rejected.** A copy is a second source of truth. It disagrees, it disagrees
silently, and in an identity system the two places it can disagree are "is this
account locked" and "who is an administrator" — the two facts the whole system's
security rests on. It also duplicates the audit problem: reads of the copy are not
in the identity audit trail, and the copy has no revocation story of its own. The
narrow version of this idea survives, for _non-identity_ admin data only, and it is
step 4 of the escalation path: a differently named binding, an ADR for what it may
hold, and never a copy of identity state.

### The Admin Worker calls the Identity Worker's public HTTP routes

**Rejected**, because it is the same boundary with worse properties. A public route
is addressable from the internet, needs its own authentication, and its own rate
limiting, and its actor identity is whatever the caller claims over the network. A
private service binding is not addressable from outside, needs no credential,
because the platform has already established which Worker is calling. Using the
public routes for an internal caller would add every cost of a public endpoint and
remove the one property that makes the service binding safe.

### Move the admin surface into the Identity Worker

**Rejected**, and it deserves its own paragraph because it is the alternative
that removes a deployable rather than adding a boundary. It would fuse the
lowest-quality inputs in the system with the process that holds `IDENTITY_DB`, and
the blast radius of a report bug would become the blast radius of a credential
store. It would also make the end-user and admin surfaces one release unit, so an
admin UI change would redeploy the identity path. This is the trade
[ADR-0002](0002-three-deployables-and-no-more.md) makes deliberately: one
deployable is cheaper, and it is cheaper _because_ the bad inputs are in their own
isolate. The admin surface is a separate deployable precisely so that the blast
radius is a service binding rather than a credential.

### Let the Admin Worker cache identity reads in `JOBS_KV` or an admin KV namespace for speed

**Not rejected; deferred with a condition.** A cache would not breach the
constraint — it is a copy, not a reach, and a cache is a well-understood thing to
have. It would breach it in spirit if the cached copy were authoritative, and the
condition is exact: a cached read may exist, it may be used to _render_ a
list or a dashboard, and it may never be used to make an authorization decision or
to answer "is this account locked". Any such cache is `DEFERRED` to the admin
phase and must be documented with its staleness bound. It is named here so that
"we need a cache" is answered with a rule rather than with a rejection.

## Revisit when

- **A support workflow needs a read the binding cannot serve within one round
  trip** — observable as the same operational question producing more than a
  handful of internal-endpoint calls, or as an admin dashboard whose latency is
  dominated by service-binding hops. The honest options at that point are an
  aggregate endpoint on `identity`, a narrow read model, or a replica — and each
  of those is a new ADR.
- **Cloudflare ships a genuine read-only D1 credential or a row-level policy
  mechanism.** That changes the authority half of the confused-deputy argument,
  which is the half that lost. It would not change the audit half, so a read-only
  binding alone still would not justify putting report queries in the Admin
  Worker.
- **The admin surface grows an operational need that is genuinely not identity
  data** — internal runbooks, feature flags, a support queue. Then the admin-owned
  database becomes justified, and it gets its own ADR stating what it may hold and
  what it may never hold. It must still be bound under a different name, so
  `grep IDENTITY_DB` stays a one-line proof.
- **The actor re-derivation design lands**, i.e. there is an implemented way for
  `identity` to establish which _operator_ is behind a service-binding call. That
  is not a revisit of this ADR — it strengthens it — but it is the gate on
  building the console at all, and until it exists, this constraint is protecting
  a surface that does not exist.
- **A fourth deployable appears** (see
  [ADR-0002](0002-three-deployables-and-no-more.md)), and the question it raises
  is whether the admin surface should become two. The answer is a
  data-ownership argument, not this ADR's, but the same grep proves the new one
  too.

## Related

- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md)
  — why the admin surface is a deployable rather than a route
- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — the same rule from the database's side
- [ADR-0005 — Identity holds no business authorization](0005-no-business-authorization.md)
  — the rule the service binding is _not_ a substitute for
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — the other negative boundary, and the same escalation path
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — why the admin surface has no human production gate
- `docs/architecture/admin-isolation.md` — the long-form argument, with the blast-radius table
- `docs/architecture/trust-boundaries.md` — boundary 3, and the open actor-identity warning
- `docs/architecture/worker-architecture.md` — the binding table this ADR is a row of
- `apps/identity-admin/worker/Cargo.toml` — the manifest omission, and its comment
