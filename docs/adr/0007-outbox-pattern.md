# The outbox pattern and the absence of atomicity

<!--
What this file is: ADR-0007, the record of why identity writes its queue messages
through a transactional outbox, what the non-atomicity between a D1 commit and a
queue enqueue forces on every producer and consumer, and why there is no version
of this that gets both.

What this file is **not**: a claim that the outbox is implemented. The outbox
types exist in `identity-domain`; the table, the dispatcher and the queue producer
are `DEFERRED` to the events phase.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `crates/identity-domain/src/outbox.rs`,
  `docs/architecture/event-model.md`
- **Constraints covered:** 1, 5, 22, 24, 29

## Context

Identity has to tell other things things. A password change produces a security
notification; an account moderation produces an audit archive; a signup produces a
verification email. Those are the messages on `IDENTITY_QUEUE`, consumed by
`identity-jobs`
([ADR-0006](0006-jobs-worker-owns-no-identity-state.md)).

The obvious implementation is two statements: commit the state change, then send
the message. It is wrong in three directions, and each failure is silent:

- **Enqueue first, commit second.** The message goes out for a change that never
  happened. The recipient gets a "your password was changed" email about a
  password that was not changed, and the sender has no idea the commit failed.
- **Commit first, enqueue second, crash between.** The state changed and nobody
  was told. A security notification that never arrives is a control that silently
  stopped working, which is worse than a control that was never built because
  nobody is looking for it.
- **Enqueue inside the D1 transaction.** D1 offers no queue in the same
  transaction. There is no API that commits a row and an enqueue together, and
  there is no two-phase commit across D1 and Cloudflare Queues.

This is not a Cloudflare limitation that a different host would fix, exactly. The
general fact is that **a relational commit and a message-broker enqueue are two
separate systems with no shared transaction coordinator.** Every system that needs
both has this problem, and the honest options are: give up one guarantee, emulate
a transaction across the two, or accept at-least-once and make the consumer
idempotent.

The emulation is the transactional outbox, and it is the standard answer for good
reasons. An `outbox_events` row is written **in the same D1 transaction as the
state change it describes**, so the fact and the intent to publish it commit or
roll back together. A dispatcher then reads committed outbox rows and enqueues
them. A crash between the read and the enqueue replays the row; a crash before the
transaction commits writes nothing. There is no window in which the fact exists
without the intent, or the intent exists without the fact.

The cost is stated plainly, in the module's own documentation in
`crates/identity-domain/src/outbox.rs`: **delivery is at-least-once, never
exactly-once.** The dispatcher cannot know whether the enqueue it just performed
succeeded, so it will try again, and some messages will be enqueued twice. Not
"might" — will, on every crash between enqueue and the dispatcher's own record of
it. Every consumer must therefore be idempotent, keyed on the event's identity.

That identity is `OutboxEventId`, and its documentation states the design point
precisely: it "is minted when the event is _written_, not when it is dispatched,
so a replay after a crash carries the same id and the consumer can recognise it."
The version is in the message type name itself — `identity.email.send.v1` and
`identity.email.send.v2` are different types — so a consumer deployed to
understand `v1` can be running while the producer emits `v2`, and a consumer that
only knows `v1` is never handed a `v2` body. That is
[ADR-0006](0006-jobs-worker-owns-no-identity-state.md)'s "producer and consumer
are backward-compatible with each other" in one string, and it is the reason
message-version suffixes are _required_ by `OutboxEventType`'s constructor rather
than conventional.

**The absence of atomicity is the point of this ADR's title.** It is not a defect
in the design; it is the fact the design is built around. The alternative — the
two-statement version — buys the appearance of atomicity and pays with silent
data loss in one direction and phantom notifications in the other.

## Decision drivers

- A fact and the intent to announce it must never disagree, in either direction.
- Retries are inevitable. Cloudflare Queues is at-least-once by construction, and
  so is any consumer that survives a crash mid-effect.
- A duplicate message must be recognisable as a duplicate by the consumer alone,
  without consulting the producer, because the producer may be a previous
  deployment.
- A schema evolution must not be able to break a consumer that is still running.
  During a deploy, producer and consumer are at different versions by definition.
- The system must never be unable to explain why a notification did or did not
  go out.

## Decision

**We use the transactional outbox. Every message Identity produces is an
`outbox_events` row written in the same D1 transaction as the state change it
describes; a dispatcher reads committed rows and enqueues them. Delivery is
at-least-once. Every consumer is idempotent, keyed on `OutboxEventId`. There is no
exactly-once, and no design in this repository will claim one.**

From now on:

1. **An outbox insert is part of the transaction, not a follow-up to it.** If a
   command changes state and produces a fact about it, the state change and the
   `outbox_events` row commit together or not at all. A command that needs a
   message writes the row; it never enqueues.
2. **No code anywhere in this repository calls `IDENTITY_QUEUE.send()` on a
   request path.** The only producer is the dispatcher, reading committed rows.
3. **The dispatcher is at-least-once and says so.** It marks a row dispatched
   after the enqueue, not before; an enqueue that succeeded and a mark that did
   not produces a duplicate, and that is the correct trade. The alternative — mark
   first, enqueue second — trades duplicates for silent loss, and silent loss is
   worse.
4. **Every consumer keys idempotency on the message's `OutboxEventId`** and treats
   "already did this" as a success. For `identity-jobs` that marker lives in
   `JOBS_KV`, which is scratch for exactly this reason
   ([ADR-0006](0006-jobs-worker-owns-no-identity-state.md)).
5. **Every message type carries a `.vN` suffix, required by the constructor.** A
   change to a payload that is not backwards-compatible produces a new type name
   and both versions may be in flight. A consumer is never handed a body it does
   not understand.
6. **Producers and consumers are backward-compatible with each other** — the
   consumer must tolerate a producer one version ahead, and the producer must
   tolerate a consumer one version behind. A deployment window is exactly the
   interval in which they are not the same version, and the queue is the only place
   where that mismatch is observable.
7. **The outbox is not a read path and the queue is not a question.** Nobody asks
   Identity a question by publishing to `IDENTITY_QUEUE`. If a flow needs an answer,
   it needs a synchronous internal endpoint.

**Enforcement:**

| Boundary                                                         | Enforced by                                                                                                                                                                                                                                     | Exists today                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every message type carries a `.vN` suffix                        | `OutboxEventType`'s constructor in `crates/identity-domain/src/outbox.rs`, which returns `DomainError::Invalid` for a name without one, plus its 128-byte maximum                                                                               | Yes — a real constructor, tested                                                                                                                                                                                                                                   |
| Producers and consumers stay backward-compatible across a deploy | The versioned type name itself; `OutboxEventId` is minted at write time so a replay is recognisable; the event contract in `contracts/events/v1/` is generated per version                                                                      | Type yes; the contract and the dispatcher are `DEFERRED` to the events phase                                                                                                                                                                                       |
| Consumers are idempotent                                         | The idempotency gate declared in `identity-security` (a trait with no body) and `JOBS_KV`'s declared scratch role                                                                                                                               | **Enforcement not yet built**; it will be the gate's body plus the jobs phase's tests, in the events phase                                                                                                                                                         |
| No request path enqueues                                         | The architecture check over the crate graph, plus the fact that the dispatcher is a distinct unit; reviewable as "the only `queue.send` call site is the dispatcher"                                                                            | **Enforcement not yet built.** No check in the `CHECKS` array of `tooling/scripts/check-architecture.mjs` judges queue send sites — that script is landing concurrently and I have read only its `CHECKS` array. The review rule is the enforcement until one does |
| Migrations and the outbox table                                  | [ADR-0011](0011-forward-only-migrations.md) — the outbox is a table, so it is a migration, so it is forward-only. It belongs in `database/identity/migrations/`, because the outbox lives in `IDENTITY_DB` and the migration path is per Worker | Yes — `database/identity/migrations/` holds `0001_schema_migrations.sql` and the tables are being written. The `migrations_dir` that points there is declared in `infra/cloudflare/<env>/identity/wrangler.jsonc`                                                  |

## Consequences

### Easier

- **A fact and its announcement cannot disagree.** That is a guarantee, and it is
  the reason to prefer a table over a call.
- **The dispatcher's crash behaviour is the easy direction.** Crash before commit
  writes nothing. Crash after commit replays a row and the consumer recognises it.
  The two failure modes a reader worries about at 3am — "we sent a notification for
  something that did not happen" and "we never sent the notification" — are both
  impossible.
- **The consumer is the only place that has to be clever, and the consumer is the
  cheap place to be clever.** It has one job, no state, and a scratch store for its
  memory ([ADR-0006](0006-jobs-worker-owns-no-identity-state.md)).
- **Adding a new event is a migration and a handler, not a change to a message
  contract.** The `.vN` suffix means the old consumers keep working, so a new
  event type can be introduced while an old consumer is still deployed.
- **The outbox is also an explainability tool.** "Why did this user get a
  password-change email at 14:03" is answerable from a row, which is a question
  that is otherwise very hard to answer about a broker.

### Harder or more expensive

- **A new table, a dispatcher, a retention job, and an operational surface.** The
  outbox is a moving part that exists only to fix a non-atomicity, and it has its
  own failure modes: a dispatcher that stops, a backlog that grows, a retention
  policy that is wrong. Each of those is a page someone has to write.
- **Latency between the fact and the message.** The dispatcher is a poll or a
  trigger, so "the password changed" and "the email was sent" are separated by
  however long the dispatcher takes. For a security notification that is a
  meaningful gap, and someone will eventually ask whether it can be tightened. The
  answer is a shorter interval or a trigger, not a synchronous enqueue.
- **Every consumer writes de-duplication logic, and every one is slightly
  different.** That is inherent to at-least-once, and it is the main source of
  duplicated emails in this system. The `identity-jobs` gate is one implementation;
  a future second consumer is another, and they will not be identical.
- **Exactly-once is permanently unavailable, and someone will ask for it.** The
  answer has to be given in writing more than once, and the honest version is
  "the platform does not offer it and the standard answer is idempotency, which is
  what we do".
- **The `OutboxEventId` has to survive as long as any consumer might replay.** If
  a consumer can redeliver a week-old message, a retention policy that clears the
  outbox in a day has turned a duplicate into an unrecognisable message. Retention
  is a correctness parameter, not a housekeeping one.

### What a future maintainer will resent

- **The dispatcher, the backlog, the retention job, and the outbox table** are all
  infrastructure that exists only because two systems cannot share a transaction.
  Every one of them will look like it could be simplified away. The moment one is
  simplified away is the moment a fact and its announcement start disagreeing, and
  it will look like a flaky third-party provider rather than a missing table.
- **The gap between the fact and the email** will produce a support question that
  looks like a bug ("I changed my password and the email came a minute later") and
  is a design property. It needs a sentence in the support playbook.

## Alternatives considered

### Enqueue after the commit, in the same request handler

**Rejected**, and it is what most systems start with, and it is wrong in a way
that only shows up in production. It loses the commit-then-crash window: the state
changed, the notification was never sent, and there is no record anywhere that one
was owed. It also loses the enqueue-then-fail window when the two are ordered the
other way. Both failures are silent, and both are invisible to the code that
"works". It is simpler by exactly one table and it is not worth the two silent
failure modes.

### Enqueue in the request, and have the consumer read the authoritative state to reconcile

**Rejected.** This is the "the message is a hint, go look" design, and it makes
the queue a _read path_, which
[ADR-0006](0006-jobs-worker-owns-no-identity-state.md) forbids and
[ADR-0003](0003-identity-d1-single-owner.md) makes impossible: the consumer would
need to read identity state, and the consumer has no domain vocabulary to read it
with. It is also a version of the confused deputy: a message that says "user X's
password changed" and a consumer that fetches user X's current state and decides
what to tell them is a consumer making an authorization decision from a hint. The
outbox avoids this by making the message a _fact_, not a hint.

### Exactly-once: rely on the queue's own delivery guarantees

**Rejected**, because the platform does not offer them, and pretending otherwise
is the failure mode. A queue that redelivers after a consumer crash is doing so
because it cannot know the effect completed; any design that claims exactly-once
across that boundary is claiming a two-phase commit between a broker and a side
effect. The honest statement is at-least-once plus idempotency, and it is the
statement `crates/identity-domain/src/outbox.rs` already makes.

### A transactional outbox _and_ a change-data-capture pipeline

**Rejected** as premature and overlapping. CDC on D1 would give the same
at-least-once property with less code, but it moves the message schema out of
this repository's control and into the shape of the tables, which couples the event
contract to the schema in a way that makes a payload change a migration. The
explicit outbox costs a table and gives the event its own versioned type name,
which is what makes a schema evolution safe. If the table count ever becomes the
problem, this is the alternative to revisit — not "enqueue in the request".

### Skip the queue for low-volume events and send them synchronously

**Rejected**, because it makes the correctness of a user-visible action depend on
its volume. A verification email sent synchronously from a request path couples
login latency to a third-party provider
([ADR-0002](0002-three-deployables-and-no-more.md)'s reason for having a jobs
deployable at all), and "low volume" is a property that changes. One delivery
mechanism is worth more than a saved round trip.

## Revisit when

- **Cloudflare ships a first-class transactional outbox, or Queues gains
  exactly-once or deduplication-by-id semantics.** That is the observable
  condition. It would not eliminate the need for idempotent consumers — a side
  effect outside the broker still is not atomic with the enqueue — but it would
  shrink the operational surface considerably and this ADR should be rewritten
  rather than amended.
- **The outbox backlog becomes an operational problem** — observable as dispatch
  latency visible to a user, or as a retention job that cannot keep up. The
  answer is a shorter poll interval or a trigger, and only then a CDC pipeline
  ([ADR-0011](0011-forward-only-migrations.md)'s rule applies to the CDC tables
  too: a migration may add, never remove or narrow).
- **A consumer needs to know a message was _not_ sent**, which at-least-once
  cannot tell it. That is a need for a read model or a query, not for better
  delivery, and it is the boundary at which "the queue is not a read path"
  ([ADR-0006](0006-jobs-worker-owns-no-identity-state.md)) should be revisited.
- **A second producer for `IDENTITY_QUEUE` appears** from outside this
  repository. Then the message contract is a shared interface rather than an
  internal one, and the `.vN` convention needs an owner and a deprecation policy,
  not just a suffix.
- **The outbox table is written by more than one code path** — for example if a
  future administrative bulk operation is not a command and therefore not a
  transaction. That is a bug against this ADR; the condition is worth naming
  because it is the shape the ADR is defending against.

## Related

- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — the consumer this ADR's delivery guarantee lands on, and the owner of `JOBS_KV`
- [ADR-0010 — Sessions are server-side records, not tokens](0010-server-side-sessions.md)
  — the other decision that touches the same idempotency machinery, deliberately
  cross-linked
- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — the outbox is a table in the one database that has a writer
- [ADR-0011 — Forward-only, backward-compatible database migrations](0011-forward-only-migrations.md)
  — the outbox table is a migration, and the dispatcher that reads it is deployed
  independently of the migration
- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — a rollback can leave a dispatcher running a version that predates a migration,
  which is exactly why the migration is forward-only
- [ADR-0015 — Frontend and BFF are one release unit](0015-frontend-and-bff-one-release-unit.md)
  — the producer side of the queue is a request path, and its latency is
  independent of when the message is sent
- `docs/architecture/event-model.md` — the long-form event model
- `crates/identity-domain/src/outbox.rs` — the types, and the cost stated in the module docs
