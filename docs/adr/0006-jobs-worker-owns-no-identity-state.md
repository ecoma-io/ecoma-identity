# The Jobs Worker owns no identity state

<!--
What this file is: ADR-0006, the record of why `identity-jobs` is a side-effect
worker with no domain vocabulary, and why the manifest omission that keeps it so
is cheaper than any runtime check.

What this file is **not**: a job-processing design. The queue consumer, the
dead-letter handling and the idempotency gate are all `DEFERRED`. This ADR decides
what the worker is *able* to do, which is a smaller and more durable question.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `apps/identity-jobs/worker/Cargo.toml`, the dependency
  rule in `tooling/scripts/check-architecture.mjs`
- **Constraints covered:** 5, 22, 24, 29

## Context

`identity-jobs` is the background side-effect worker. It consumes
`IDENTITY_QUEUE`, sends email through the deferred `EMAIL_PROVIDER` binding,
archives audit records, and holds `IDENTITY` (a private service binding, for the
narrow internal endpoints it needs), `IDENTITY_QUEUE` and `JOBS_KV` — scratch and
idempotency only, never authoritative. It has no D1 binding at all.

It exists because side effects do not belong in a request path. Sending email
couples a user's login latency to a third-party provider's availability; a queue
consumer that crashes must not be able to take an authentication request with it;
and a retry of a side effect must not be a retry of a login. The queue is what
separates "the system decided something" from "the system told somebody", and this
deployable is where the second thing happens.

The constraint that makes it interesting is that **the Jobs Worker owns no identity
state** — and the manifest states that as a _dependency_ decision, not a runtime
one. `apps/identity-jobs/worker/Cargo.toml` deliberately does not depend on
`identity-domain` or `identity-application`. It may depend on `identity-oidc` (wire
types), `identity-security` (the error vocabulary and the idempotency gate) and
`identity-cloudflare` (adapters). The manifest's own comment says the reason
plainly: a background worker that could reach the domain model could reach identity
state, and "it only needs the User type" is how that dependency starts.

Why does it matter that the _domain model_ is unreachable, when Jobs has no D1
binding anyway? Because the two failures are different, and only one of them is
about storage.

**The storage failure** is the obvious one: Jobs reading or writing identity rows
directly, with no rule about who may do what, because it is a background worker and
nobody is looking. That is prevented by the absent binding
([ADR-0003](0003-identity-d1-single-owner.md)).

**The rules failure** is subtler and is the one this ADR is about. A queue message
is not a trustworthy caller. Anything that can publish to `IDENTITY_QUEUE` — a
future producer, a misconfigured binding, a replayed message — can put a payload
in it. If Jobs could evaluate identity rules, it would be evaluating them on
untrusted input, in a component with no operator watching, writing state that a
human's account depends on. The defence is not input validation; it is that the
component has no vocabulary for the decision. Jobs cannot decide "is this account
allowed to do this" because it does not have the types that make the question
expressible, and it cannot grow them without a Cargo manifest change that fails CI.

The natural symptom of the failure this prevents is not an attack. It is a
refactor. Someone needs to send a security notification that says "your password
was changed"; the fastest way is to import the `User` type and ask
`user.status.permits_authentication()`. The dependency is small, the intent is
honest, and the worker is now evaluating an identity rule from a message body.

**Delivery makes this sharper.** The queue is at-least-once. A message can be
delivered twice, in any order relative to another message, or not at all within a
window anyone is watching. [ADR-0007](0007-outbox-pattern.md) records why, and
[ADR-0010](0010-server-side-sessions.md) records the session side. What Jobs does
with that fact is its own discipline: every effect is idempotent, keyed on the
message's identity, and "already did this" is a success, not a failure. `JOBS_KV` is
where that memory lives, and it is explicitly scratch: losing it means
re-processing, which is why that is acceptable and why losing D1 would not be.

## Decision drivers

- A background component that can evaluate identity rules can make identity
  decisions, and its input is a message it did not author.
- The denial must be structural, so it is a manifest edge and a checker rather
  than a code review convention.
- Side effects must be retryable, which means at-least-once, which means
  idempotent effects, which means the worker has to be able to recognise its own
  past work without owning authoritative state.
- The worker must be testable without identity. A test that needs a D1 database to
  check that an email was not sent twice is a test that will not be written.
- Failure domains must be separate: a crash here must not take a login with it.

## Decision

**`identity-jobs` is a background side-effect worker that owns no identity state.
It depends on neither `identity-domain` nor `identity-application`. It may depend
on `identity-oidc` (wire types), `identity-security` (error vocabulary and the
idempotency gate) and `identity-cloudflare` (adapters). It holds no D1 binding,
and `JOBS_KV` is scratch and idempotency memory that is never authoritative.**

From now on:

1. **`apps/identity-jobs/worker/Cargo.toml` does not name `identity-domain` or
   `identity-application`,** and a Cargo manifest change that adds either one fails
   `pnpm arch`. The check judges the graph from `cargo metadata` and the git index,
   not from source-text heuristics, so a barrel re-export or a clever import
   cannot defeat it.
2. **Jobs performs effects; it does not decide.** It receives an event, validates
   it against `identity-security`'s typed error vocabulary and its idempotency
   gate, performs the effect, and records the fact that it did. It never
   evaluates a domain invariant, and it has no use-case vocabulary to borrow one
   from.
3. **`JOBS_KV` is scratch.** It holds idempotency markers and counters, it is
   explicitly non-authoritative, and losing it means re-processing rather than
   losing an account. It is never consulted for an authorization decision and
   never read before `identity` for a question about identity state.
4. **The `IDENTITY` service binding is used only for the narrow internal endpoints
   Jobs genuinely needs,** and — as with the Admin Worker
   ([ADR-0004](0004-admin-worker-holds-no-database.md)) — a service binding
   authenticates the _Worker_, not the user, so any actor identity it carries must
   be re-derivable by `identity` and not taken from the message.
5. **Every effect is idempotent, keyed on the message's identity.** A redelivered
   message is recognised and skipped; `JOBS_KV` is where the recognition lives, and
   "already done" is a success. The mechanics are in
   [ADR-0007](0007-outbox-pattern.md); this ADR fixes the _shape_ that makes them
   possible — no state, so no transaction to be atomic with, so re-processing is
   always safe.
6. **The queue is not a request path.** Nobody asks Jobs a question by publishing
   to `IDENTITY_QUEUE`. It is a one-way notification channel with no read path, and
   a design that needs a queue message to come back with an answer is a design that
   belongs on a synchronous internal endpoint.

**Enforcement:**

| Boundary                                                             | Enforced by                                                                                                                                                                                                                                                                                                                                    | Exists today                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jobs depends on neither `identity-domain` nor `identity-application` | `tooling/scripts/check-architecture.mjs`'s `boundary-2-jobs-isolation`, judging the crate graph from `cargo metadata`; `apps/identity-jobs/worker/Cargo.toml` omits both and documents the omission in the manifest                                                                                                                            | Yes. I ran the script on this tree and `boundary-2-jobs-isolation` reported `ok` with 0 violations, so the omission is not merely written down — it is currently enforced                                                                                                      |
| Jobs holds no D1 binding                                             | The same script's `boundary-2-jobs-isolation` config half, which fails on any `d1_databases` entry in `.generated/cloudflare/<env>/identity-jobs/wrangler.jsonc` — the same binding check that keeps the Admin Worker off `IDENTITY_DB`                                                                                                        | Yes. All three jobs configs declare no `d1_databases` block at all, each with a comment recording that adding one is a constraint change needing an ADR, not a config edit                                                                                                     |
| `JOBS_KV` is not authoritative                                       | `no-authoritative-kv-or-do` in the same script, which fails on any `durable_objects` binding at any severity and warns on any `kv_namespaces` binding with the constraint restated at the point of the binding; plus the role declared in `docs/architecture/worker-architecture.md` and in `docs/architecture/trust-boundaries.md` boundary 9 | Partially. The check exists and I ran it: 0 violations, 6 warnings, one for each `IDENTITY_KV` and `JOBS_KV` declaration. The check does not — and cannot, from a config — establish that no authorization _read_ consults it; that half is the role documentation plus review |
| The check itself has not been weakened                               | `pnpm arch:canary` — a fixture tree violating the law in the exact forbidden ways must fail with the exact violations, and the real tree must stay clean                                                                                                                                                                                       | **Enforcement not yet built.** The check script and its `__fixtures__/` tree are landing concurrently and I have read only the `CHECKS` array; `tooling/scripts/check-architecture.test.mjs` is being written beside the script                                                |
| An effect is idempotent                                              | The idempotency gate in `identity-security` (a trait with no body today) plus the event-id contract in `identity-domain::outbox`, where `OutboxEventId` is the idempotency key and is minted when the event is _written_, not when it is dispatched                                                                                            | Types yes; the gate body is `DEFERRED` to the jobs phase                                                                                                                                                                                                                       |

## Consequences

### Easier

- **Jobs is testable with nothing but its own message and a fake
  collaborator.** No D1, no network, no `wrangler`. That is the practical payoff
  of having no domain dependency: the interesting tests are "given this message
  twice, the provider was called once".
- **The blast radius of a Jobs bug is a side effect, not a credential.** A bug that
  sends the wrong email is embarrassing and recoverable. The same bug in a worker
  that could evaluate identity rules is an authentication defect.
- **Redelivery is boring.** Because Jobs owns no state, "I already did that" is
  always a safe answer and re-processing is always safe. A consumer that owned
  state would need the same care and would not get it right.
- **The failure domain is separate.** A slow email provider, a dead queue, a
  crashing consumer — none of these is in a user's login path, and none of them
  can take one down.
- **The dependency graph stays small enough to audit.** Four crates, and the rule
  is a two-name deny list. A script can judge it in milliseconds and it has no
  judgement calls.

### Harder or more expensive

- **Some jobs will be awkward to write.** "Email the user whose password just
  changed" needs the recipient and enough context to render a message. Without the
  domain model, either the message carries a denormalised payload (and the schema
  of that payload is a contract
  ([ADR-0007](0007-outbox-pattern.md))) or Jobs calls an internal endpoint. Both
  are more work than importing `User`, and the second is a round trip. That is the
  tax, and it is the right one.
- **No local decision means no local answer.** Anything Jobs cannot do from the
  message alone becomes an `identity` call, which means Jobs's throughput is bounded
  by Identity's availability for those jobs. Acceptable for email; worth noticing
  for a high-volume job that only needed a field.
- **Idempotency is a real implementation burden, and it is invisible until it is
  done.** Every handler needs the marker, every marker needs a retention policy,
  and a job with a `JOBS_KV` write that nobody has tested under redelivery is a job
  that will send a duplicate email in production. This is the single largest source
  of "it looked fine in staging" in queue systems.
- **The `PlatformRole` service-identity variant exists partly for this worker**
  (`PlatformRole`'s own documentation: "held by the Jobs worker when it needs to
  act on its own behalf"). That is a small machine identity inside an identity
  system, and it deserves the same scepticism as any other.

### What a future maintainer will resent

- **"It only needs the `User` type."** That is the exact sentence, and it is
  always reasonable-sounding. It is the reason this is a manifest omission and a
  checker rather than a code-review rule. Expect to explain it more than once, to
  people who are trying to be helpful.
- **The awkward job.** Some effect will be genuinely painful to write without the
  domain, and the right answer will keep being "put the field in the message" or
  "add a narrow internal endpoint", not "import the crate". Both are correct and
  both will feel like extra work; the alternative is a worker that can decide.

## Alternatives considered

### Let Jobs depend on `identity-domain` but not `identity-application`

**Rejected**, and it is the closest of the alternatives, and it deserves a careful
answer. The argument for it is real: reading a `User`'s status is a data question,
and having the type is not the same as having the ability to _decide_ anything. The
argument against is the one that matters in practice. `identity-domain` is where
the rules _are_ — `UserStatus::permits_authentication`,
`SessionStatus::permits_authentication`, `Aal::satisfies`,
`SecurityVersion` — and a worker that can read them can call them. Once the type
is in scope, "is this account allowed to do this" is one method call away, and the
reviewer has to notice. The blast radius of that is a background process making
authorization decisions from a message body, with no operator watching. The cost
saved — a nicer typed payload — is paid for with the whole boundary. The two
denied crates are denied together for that reason.

### Jobs calls `identity` for every message, i.e. no local effects at all

**Rejected**, and it is the other serious candidate. If Jobs did nothing but forward
to internal endpoints, it would own nothing and could depend on nothing. It also
would be pointless: the queue would be a slow, unreliable way to call a function,
and every message would pay a round trip plus a retry policy plus a dead-letter
queue to express what a direct call expresses. The queue exists precisely so that
a side effect — sending an email, archiving a record — happens outside a request
path; a side effect that is itself a request needs neither the queue nor the
worker.

### Give Jobs its own small database, and let it own its delivery state

**Rejected.** Its own authoritative state is not identity state, so it would not
breach this ADR, but it would be a fourth data store for a worker whose only
durable need is "did I already do this", and KV answers that adequately at this
scale. It would also re-open the `IDENTITY_DB` grep argument: a second D1 binding in
`.generated/cloudflare/` is a thing every future reviewer has to check is not identity's.
The narrow version — an idempotency store in Jobs' own namespace — is what
`JOBS_KV` already is.

### Move job processing back into the Identity Worker as a queue consumer

**Rejected.** It would work, and it would collapse a deployable, and it would fuse
the failure domains this ADR exists to separate: an email provider being slow
becomes a login being slow, because they are the same request budget. It would
also give the credential-holding process the lowest-trust input in the system
(queue payloads), which is the argument of
[ADR-0004](0004-admin-worker-holds-no-database.md) applied to a different input.
And it would break the architecture rule that a queue consumer is not a request
path: the Identity Worker would have both a public surface and a consumer in one
isolate, and the two would share a concurrency budget.

## Revisit when

- **A job genuinely needs to reason about identity state** — for example "only
  email accounts that are `Active`", or "skip if a security version changed since
  the event". That is the moment to check whether it is a _narrow internal
  endpoint_ on `identity` (which is the answer) or a _domain decision_ (which
  needs a new ADR, and the new ADR should have to argue why the decision cannot
  be made by the producer at write time). The first is routine; the second is a
  real change to this ADR.
- **Queue volume makes `JOBS_KV` inadequate** as an idempotency store —
  observable as KV write latency or a size limit interfering with the
  idempotency check. The answer is a different store or partitioning, not identity
  state, and it is a small decision rather than a boundary change.
- **A second consumer of `IDENTITY_QUEUE` appears** (an analytics sink, a webhook
  forwarder). It gets the same two denied crates and the same rule, and it is
  evidence that the "side effects live in Jobs" rule generalises rather than
  evidence against it.
- **Cloudflare ships a first-class transactional outbox or a queue with
  exactly-once delivery semantics.** That changes the cost of this ADR
  substantially — the idempotency burden would shrink — and it is named in
  [ADR-0007](0007-outbox-pattern.md)'s revisit conditions. The dependency denial
  would survive it; the _cost_ would not.
- **Durable Objects become a credible home for a long-running job** (one that
  needs sequencing or a per-user lock). That is a
  [ADR-0002](0002-three-deployables-and-no-more.md) and constraint-24 question
  first, and it does not change the "no identity state" rule — a Durable Object in
  Jobs would be as forbidden as D1 in Jobs.

## Related

- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md)
  — why the jobs side is a deployable
- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — the binding half of this ADR
- [ADR-0004 — The Admin Worker holds no database](0004-admin-worker-holds-no-database.md)
  — the same shape of boundary, on a different input
- [ADR-0007 — The outbox pattern and the absence of atomicity](0007-outbox-pattern.md)
  — where at-least-once delivery comes from, and what it forces on the consumer
- [ADR-0010 — Sessions are server-side records, not tokens](0010-server-side-sessions.md)
  — the other decision that touches the same idempotency machinery, deliberately
  cross-linked
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — why this deployable has no human production gate
- `docs/architecture/jobs-isolation.md` — the long-form argument
- `docs/architecture/trust-boundaries.md` — boundary 6, the queue to Jobs edge
- `apps/identity-jobs/worker/Cargo.toml` — the manifest omission, and its comment
