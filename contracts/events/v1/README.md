# Events v1 contract

What this directory owns: what Identity says happened, on its way to something
else. The outbox events, the queue wire shape, and the three payload versions
that exist as names today.

**Nothing is being produced or consumed.** `apps/identity-jobs/worker/src/lib.rs`
is a one-line placeholder. The types below are real; the workers that would move
the messages are not written.

## Delivery is at-least-once, and it is not a detail

Cloudflare Queues delivers **at least once**. A message can be handed to a
consumer more than once: the platform retries a batch whose handler threw, a
consumer can be redeployed mid-batch, and a `retry_all` after a partial batch
replays the whole thing. There is no exactly-once and there will never be one
across two systems.

Every consumer therefore **must** be idempotent by construction, keyed on the
outbox event id. The producer side makes that possible: `OutboxEvent::new`
mints the id when the event is _written to the outbox_, not when it is
dispatched, so a replay after a crash carries the same id and the consumer can
recognise it. `QueuedEvent::from_outbox` copies that id onto the wire unchanged.

This is the reason `queued-event.schema.json` carries `id` as a required field
and the three payload schemas carry no id of their own. A payload field the
consumer might dedupe on would be a second, wrong idempotency key.

## Why the outbox exists at all

**A D1 commit and a Queues enqueue are not atomic, and cannot be made so.** They
are two different systems with two different failure domains.

- Write the event to the queue and _then_ commit the row: a crash between them
  loses the row with the queue already holding the message — a user is sent an
  email for a session that was never created.
- Commit the row and _then_ enqueue: a crash between them loses the message — the
  user is never told their password changed.

There is no ordering that fixes both. So the fact is committed to D1 **in the
same batch as the state change it describes** (`crate::d1::execute_batch`), and a
dispatcher later reads committed rows and enqueues them. A crash between the two
replays the row; a crash before the commit writes nothing at all. That is the
trade: at-least-once delivery, in exchange for never losing a fact.

`enqueue_outbox_event` carries the rule in its doc comment: **call it only from
the dispatcher**, after the row is committed, and only after
`record_dispatch_attempt` has been written in the same transaction as the
increment. A producer that enqueues inside its own transaction is assuming an
atomicity that does not exist.

## The three versions that exist

Every event type carries its version in its own name. `identity.email.send.v1`
and `identity.email.send.v2` are different message types, which is what lets a
consumer be deployed to understand both while the producer is still emitting the
first (ADR-0014). A consumer that only knows `v1` is never handed a `v2` body.

`OutboxEventType::parse` enforces the `.vN` suffix mechanically. Requiring it is
what makes "this schema evolved" visible in the type name instead of hidden in a
payload field, and it means a producer cannot invent an unversioned type and
have it delivered as something it looks like.

| Event type                          | Payload type    | Producer             | Consumer             |
| ----------------------------------- | --------------- | -------------------- | -------------------- |
| `identity.email.send.v1`            | **none exists** | `DEFERRED` — Phase 7 | `DEFERRED` — Phase 7 |
| `identity.security.notification.v1` | **none exists** | `DEFERRED` — Phase 7 | `DEFERRED` — Phase 7 |
| `identity.audit.archive.v1`         | **none exists** | `DEFERRED` — Phase 7 | `DEFERRED` — Phase 7 |

The honest statement about all three payload schemas: the **event_type string is
implemented** — `OutboxEventType::email_send_v1()` and its two siblings return
these names — but **no Rust type anywhere in the repository carries these
payload shapes.** `OutboxEvent::payload` is `serde_json::Value`, opaque by
design. Each payload schema is therefore marked `"x-rust-type": "NONE"` and its
`kind`/field enums are deliberately left open rather than closed, because a
closed list here would be a claim about types that do not exist. Phase 7 fixes
each one and updates its schema in the same commit.

## The dispatch ceiling

`OutboxEvent::MAX_DISPATCH_ATTEMPTS` is `25`. `should_dispatch` returns false
past it and `record_dispatch_attempt` returns
`DomainError::IllegalTransition`. A row past the ceiling is dead-lettered rather
than retried forever.

The number is chosen to outlast a weekend of a queue being misconfigured while
still failing in hours rather than days. **An email that arrives three days late
is a support incident**, and an unbounded retry is worse than a visible dead
letter — the row stays, and the counter is how an operator sees it. The counter
is written by the dispatcher, never by the producer.

## Three dispositions, and no fourth

`Disposition` is a closed three-way enum, and `BatchOutcome` is what a batch
handler returns rather than a bare `Result<()>`, because the per-message
disposition has to survive the loop:

- `Done` — the effect was performed. Ack.
- `Retry` — the effect could not be performed and should be attempted again.
- `DeadLetter` — the effect can never be performed and retrying is pointless.

There is no "silently ignored". The reason it is named: a handler that retries
the whole batch on one bad message re-runs the effects of the good ones — which
is exactly the duplicate delivery the idempotency key absorbs, but only if the
_handler_ is idempotent — while also burning the platform's retry budget on a
poison message.

The default strategy, `retry_all_outcome`, retries everything and acks nothing.
Correct under at-least-once delivery **only because** every handler is
idempotent. It is the default rather than "ack what succeeded" because a partial
ack that forgets one message loses that effect permanently, and a replay of an
already-applied message costs one idempotency lookup.

## Refusing an unknown type

`QueuedEvent::known_type` returns `None` for an unknown or malformed type, and
`None` is the answer a consumer must act on **by refusing the message**, not by
guessing at its shape. A well-formed type this build has never heard of — say
`something.entirely.v9` — parses and reports version 9; `version()` returns `0`
for a suffix it cannot read rather than guessing, so a malformed type surfaces as
"version 0", which no consumer supports, instead of a plausible version that
silently binds to the wrong schema.

## Two refusals worth knowing about

`QueuedEvent::parsed_id` refuses an empty id and an id that is not a UUID.
**A key that cannot be parsed cannot be used to dedupe**, and a consumer that
processed the message anyway would be processing something with no way to
recognise its own replay — so it is refused at the parse boundary, not deep in
the handler.

One honest caveat, recorded in `queue.rs`'s own test comments and repeated here:
`parsed_id` consults the domain, and `OutboxEventId` has **no `parse`
constructor** today, so it refuses every value including a well-formed UUID. The
error says why (`the event id is not an outbox event id the domain will accept`)
rather than reporting a parse failure. Phase 7 adds the constructor.

## Two timestamps that answer different questions

`QueuedEvent.occurred_at_ms` is when the fact was **committed**. The payload's
own timestamp, where it has one, is when the thing **happened**. They are not
the same field for the same reason: a notification about a sign-in three seconds
ago may be committed now. Collapsing them makes it impossible to tell a slow
dispatcher from a late login — and both are things an operator investigates
separately.

## Files

| File                                   | Rust type                                 | Status                                       |
| -------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `queued-event.schema.json`             | `identity_cloudflare::queue::QueuedEvent` | shape IMPLEMENTED; no producer/consumer      |
| `email-send-v1.schema.json`            | none                                      | event_type IMPLEMENTED; payload **PROMISED** |
| `security-notification-v1.schema.json` | none                                      | event_type IMPLEMENTED; payload **PROMISED** |
| `audit-archive-v1.schema.json`         | none                                      | event_type IMPLEMENTED; payload **PROMISED** |
