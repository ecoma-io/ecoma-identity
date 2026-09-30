# Three deployables and no more

<!--
What this file is: ADR-0002, the record of the three-Worker topology, the rule
that a fourth deployable requires an ADR and a proof, and the shape that proof
has to take.

What this file is **not**: a component diagram. The diagram is in
`docs/architecture/overview.md`. This is the argument for the number three, and
the terms of the escape clause.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** the three Worker crates in `apps/*/worker/`, the `moon.yml`
  project ids
- **Constraints covered:** 7, 8, 23, 28, 29

## Context

Ecoma Identity ships as exactly three Cloudflare Workers: `identity`,
`identity-admin` and `identity-jobs`. The number is not an accident of how the
code fell out; it is the number at which every boundary in this system stays
expressible, and each of the three earns its place against a specific property.

`identity` is the source of truth. It holds `IDENTITY_DB` (D1, authoritative),
`IDENTITY_KV` (rate-limit counters only), `IDENTITY_QUEUE` (producer),
`EMAIL_PROVIDER` (deferred `fetch`), `RATE_LIMITER` and `ASSETS`. It is the only
thing in the system that may touch identity state
([ADR-0003](0003-identity-d1-single-owner.md)), and it is the only thing that
evaluates identity rules.

`identity-admin` is the operator surface: a BFF behind `apps/identity-admin/web`
with an admin-specific session. It holds `IDENTITY` (a private service binding to
`identity`), `ADMIN_RATE_LIMITER` and `ASSETS`. It has no database of identity
state at all, ever ([ADR-0004](0004-admin-worker-holds-no-database.md)). It exists
because the admin surface has the lowest-quality inputs in the system and a
separate deployable is what makes its blast radius a service binding rather than
a credential.

`identity-jobs` is the background side-effect worker: it consumes
`IDENTITY_QUEUE`, sends email, writes audit archives, and owns no identity state
([ADR-0006](0006-jobs-worker-owns-no-identity-state.md)). It holds `IDENTITY` (a
private service binding, for the narrow internal endpoints it needs),
`IDENTITY_QUEUE`, `EMAIL_PROVIDER` (deferred), and `JOBS_KV` (scratch and
idempotency only). It exists because the alternative — sending email from inside
a request path — couples a user-visible latency budget to a third-party
provider's availability, and because a queue consumer that crashes must not be
able to take an authentication request with it.

The forces that made this hard:

1. **Every additional deployable is a place a boundary can leak.** A fourth
   Worker is a fourth `wrangler.jsonc`, a fourth release-please component, a
   fourth canary policy, a fourth rollback path, and a fourth set of bindings that
   a reader must check against a data-ownership question. The cost is not
   deployment; it is the size of the set of things that must all be true for the
   "one component owns identity state" claim to be checkable at all.
2. **A component with no reason to be separate gets merged into a component
   that has one.** The two failure modes are "this should have been a fourth
   Worker" and "this should never have been a Worker", and both are decided by the
   same question: does this thing have a different authority, a different data
   ownership story, or a different availability requirement from everything it
   currently lives with?
3. **The three deployables map onto the three release cadences.** The end-user
   surface ships with its BFF ([ADR-0015](0015-frontend-and-bff-one-release-unit.md));
   the admin surface ships with its own BFF; the background worker ships on the
   same tag but is deployed on a different promotion policy, fully automatic with
   no human gate ([ADR-0014](0014-canary-promotion-identity.md)). Three
   deployables, two approval behaviours. A fourth would mean deciding which of
   those two buckets it falls into before it exists.

## Decision drivers

- One component must hold identity state, and the binding set must be able to
  prove it: an absent binding is a capability the runtime does not hand the
  isolate, which is a control, whereas "do not query it" is a request.
- Each deployable must have a blast radius that does not include another
  deployable's secrets.
- A background side effect must not share a failure domain with an
  authentication request.
- The count must be small enough that a reviewer can hold all the binding sets
  in their head, and a script can check all of them.
- The frontend must ship with the BFF behind it, which means "the BFF" is a
  deployable-level concept and not an incidental library.

## Decision

We deploy **exactly three Workers**: `identity`, `identity-admin` and
`identity-jobs`, with the binding sets above and in
`docs/architecture/worker-architecture.md`.

**The rule: a fourth deployable requires a new ADR, and that ADR must contain a
proof that the work cannot live in one of the three.** The proof is not a
sentence; it is a specific argument against each of the three in turn, on the
grounds of authority, data ownership, or availability requirement. "It is a
different concern" is not a proof. "It needs a different release cadence" is not
a proof, because all three deployables already share a tag and differ only in
promotion policy, and a different promotion policy is one line in
`.github/workflows/`. "It is easier to test" is not a proof.

The proof must also state what the fourth deployable is _forbidden_: which
bindings it may not hold, and which data it may not own. A proposed fourth Worker
that cannot say "and it will not hold `IDENTITY_DB`, and it will not be reachable
by a public route" is not a proposal, because those are the two boundaries that
the topology exists to keep.

Existing work in one of the three is not a reason to make a fourth. It is the
default answer.

**Enforcement:**

| Boundary                                                                    | Enforced by                                                                                                                                                                                                                                                                                                                  | Exists today                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly three deployables                                                   | `.moon/workspace.yml`'s explicit project map, which has no globs and registers the three deployables under their own names (`identity`, `identity-admin`, `identity-jobs`) — a new project must be added there deliberately                                                                                                  | Yes                                                                                                                                                                                                                                                                                                                                                                                                             |
| Each deployable's name is one word, not a language name                     | `.moon/workspace.yml` registers each deployable under its deployable name rather than its crate name, so `moon run identity:build` addresses a deployable. The crate names (`identity-worker` and friends) remain the `Cargo.toml` package names; they are a different namespace and no command addresses a task through one | Yes                                                                                                                                                                                                                                                                                                                                                                                                             |
| No fourth `wrangler.jsonc`                                                  | `tooling/scripts/check-architecture.mjs`'s `deploymentable-count` and `boundary-5-worker-registration`, which walk `apps/*/worker/` and the wrangler configs under `.generated/cloudflare/{development,staging,production}/`                                                                                                 | Partially. I ran the script on this tree: `deploymentable-count` reported `ok` (exactly three), and nine configs exist — three Workers in three environments. `boundary-5-worker-registration` reported 3 violations, because `apps/{identity,identity-admin,identity-jobs}/worker/` have no `moon.yml` of their own; the script is landing concurrently and I have not read its body beyond the `CHECKS` array |
| A new Worker is also a new release-please component and a new canary policy | `.release-please-manifest.json` (Release Please) and `.github/workflows/deploy.yml` — a fourth name in one is a fourth name the other needs                                                                                                                                                                                  | **Enforcement not yet built.** `release-please-config.json` does not exist yet and `.github/workflows/` is empty at the time of writing. `boundary-5-worker-registration` names `release-please-config.json` as one of its four registration points and reports that step as **skipped — the file does not exist yet**, which is the script's own honesty property rather than a pass                           |
| A fourth Worker is impossible to add without an ADR                         | The ADR requirement is process, not code: the ADR is a file in this directory, and the boundary-check script's own comments name the rule                                                                                                                                                                                    | Process                                                                                                                                                                                                                                                                                                                                                                                                         |

## Consequences

### Easier

- **The binding sets fit in a reviewer's head.** Three Workers, six bindings
  between them, and the interesting question is always the same one: which
  capability did this isolate get. There is no fourth set to wonder about.
- **Every boundary has exactly one obvious home.** "Where does this go?" has
  three answers and each is decided by a property already in the set: does it
  read or write identity state (→ `identity`), is it an operator surface with
  free-text input (→ `identity-admin`), is it a side effect that can be retried
  (→ `identity-jobs`). New work is classified rather than debated.
- **The failure domains are separated along real lines.** A third-party email
  provider being slow does not slow a login, because email is sent by
  `identity-jobs` from a queue. An operator's mistyped search term does not reach
  the user table, because it stops at a service binding.
- **Rollback has three paths and a known owner for each**, because a rollback is
  a version promotion and every deployable is uploaded with a version id
  ([ADR-0013](0013-immutable-worker-versions.md)).
- **The frontend boundary is a deployable boundary.** "The SPA and the Worker
  behind it ship together"
  ([ADR-0015](0015-frontend-and-bff-one-release-unit.md)) is a fact about
  release-please components, not a CI convention someone has to remember to apply
  to two independent pipelines.

### Harder or more expensive

- **A genuinely different concern has to be argued into an existing Worker,
  sometimes awkwardly.** A webhook-ingress surface that receives third-party
  callbacks at high volume would have to live in `identity` (which is the wrong
  blast radius) or in `identity-jobs` (which is the wrong trust level, because
  jobs owns no state). The topology's answer is "add an internal endpoint and
  enqueue", which is more work than a new Worker.
- **The three have genuinely different operational characters and one
  documentation set has to hold all of them.** The admin surface is
  internal-facing with a small enumerable route set; the end-user surface is
  public and is the one under credential-stuffing pressure; the jobs surface has
  no public route at all. Three threat profiles in one threat model
  (`docs/security/threat-model.md`) is a document that has to be read carefully
  rather than skimmed.
- **"Not a fourth Worker" pushes pressure toward making an existing Worker do a
  job it is unsuited to.** This is the real ongoing cost, and it is why the proof
  requirement is written as a per-Worker argument. The failure mode is
  `identity-jobs` growing an inbound HTTP route because that was easier than an
  ADR — which is exactly what
  [ADR-0006](0006-jobs-worker-owns-no-identity-state.md) forbids.
- **Two of the three share an approval story that the third does not**
  ([ADR-0014](0014-canary-promotion-identity.md)), so "deploy the platform" is
  never one action and never one permission. A maintainer has to remember which
  deployable is gated.

### What a future maintainer will resent

- **The proof requirement will feel like bureaucracy the first time someone
  proposes a fourth Worker, and they will want to skip it.** It is the entire
  reason the topology is a decision rather than an accident. The second, fourth
  and sixth Worker are the ones that make the first three hard to audit, and the
  person who proposes one is almost never the person who maintains the boundary
  checks afterwards.
- **"It is basically a small worker"** is the sentence that precedes every fourth
  Worker. It is worth treating as a red flag rather than a description.

## Alternatives considered

### One Worker with a router

**Rejected**, and it was the closest of the alternatives. One deployable holding
`IDENTITY_DB`, `IDENTITY_QUEUE`, the admin routes and the queue consumer would be
fewer moving parts, one canary, one version to roll back, and no service-binding
design to get wrong.

It loses on the thing the three deployables are for. Blast radius is a function of
what a component can reach: with one Worker, the compromise of an admin report
generator, a free-text search box, or a queue payload parser is a compromise of
every credential in the organisation, because they are all in the same isolate
holding the same binding. The admin surface has the lowest-quality inputs in the
system, and merging it into the same process as the credential store is precisely
the arrangement
[ADR-0004](0004-admin-worker-holds-no-database.md) was written to prevent. The
failure domains also fuse: a slow email provider on a queue retry would be a
slow login, because they are the same request budget.

What would have changed the answer: if the admin surface had not existed, or if
the whole system had been single-tenant with no operator-facing free-text input,
one Worker would have been the right answer and cheaper.

### Two Workers — `identity` and `identity-admin+jobs`

**Rejected.** It fuses the admin BFF and the queue consumer. They have nothing in
common except that neither of them owns identity state, which is an argument that
they are _both_ separate from `identity`, not that they belong together. The
result is a process whose inputs are free-text operator search terms _and_
attacker-influenceable queue payloads, with `IDENTITY_QUEUE` and `ADMIN_RATE_LIMITER`
and `ASSETS` in one binding set. The blast radius of a bug in either half is the
other half.

### Four or five Workers — adding, for example, a webhook ingress and a reporting Worker

**Rejected**, and this is the alternative the rule exists for. It was genuinely
considered as a plausible end state, and the arguments for it are real: a webhook
ingress surface has a genuinely different availability profile from an
authentication endpoint, and a reporting Worker would let a heavy read query run
without holding `IDENTITY_DB` in a request path. It loses because both needs can
be served inside the existing three — a webhook becomes an internal endpoint on
`identity` that validates the signature and enqueues, and a report becomes a
narrow read endpoint on `identity` ([ADR-0004](0004-admin-worker-holds-no-database.md))
— and because adding them would cost two more binding sets, two more release
components, two more canary policies and two more rollback paths to keep true.

The honest note: if a webhook ingress ever needs to accept unauthenticated
third-party traffic _at volume_ with a real SLA, the argument for a separate
ingress deployable becomes strong. That is what the revisit condition below is
for.

### A Durable Object per user, with no central Worker

**Rejected.** It would make `identity` a single logical store with per-user
serialisation, which is attractive for the write paths. It loses on constraint
24 (no Durable Objects as authoritative identity state in bootstrap): the blast
radius of a bug becomes a per-user shard, the transaction story for the outbox
gets worse, and a system of one Durable Object per user is a system with a
per-user failure and deployment story that this platform has no tooling for.
Durable Objects are not forbidden forever; they are forbidden _as authoritative
identity state in bootstrap_, and reopening that is
[ADR-0003](0003-identity-d1-single-owner.md)'s revisit condition.

## Revisit when

- **A fourth deployable is proposed.** The ADR must be written before the code,
  and it must argue each of the three specifically, on authority, data ownership
  or availability requirement.
- **An inbound third-party webhook surface needs a real SLA** that an internal
  endpoint plus an enqueue cannot meet — observable as queue depth on the
  ingress path, or as p99 latency on the accepting endpoint.
- **A read-heavy reporting need cannot be served by a narrow internal endpoint**
  within one round trip, and a read replica becomes possible. This is the
  concrete condition named in
  [ADR-0004](0004-admin-worker-holds-no-database.md); a replica that is not
  `IDENTITY_DB` would not be a breach of constraint 3, but naming it is.
- **The three deployables' release cadences genuinely diverge** such that a
  change to one blocks an unrelated change to another. Observable as: a change to
  `identity-jobs` is routinely held up behind a change to `identity`'s canary.
  Note that a different _promotion policy_ is not this condition; all three share
  a tag today and that is deliberate.
- **Cloudflare's Workers platform changes its isolation or billing model** in a
  way that makes three deployables materially more expensive or materially
  harder to observe than one.

## Related

- [ADR-0001 — Rust and Cloudflare Workers on the platform](0001-rust-and-cloudflare-workers.md)
  — the language and runtime the three deployables are written in
- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — the boundary a fourth deployable would have to respect
- [ADR-0004 — The Admin Worker holds no database](0004-admin-worker-holds-no-database.md)
  — the reason `identity-admin` is a deployable at all
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — the reason `identity-jobs` is a deployable at all
- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — why three deployables means three version ids to roll back
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — why the three have two different approval stories
- `docs/architecture/overview.md` — the component map this ADR is the argument for
- `.moon/workspace.yml` — the project map that makes three the default, with no globs and no second map to disagree with
