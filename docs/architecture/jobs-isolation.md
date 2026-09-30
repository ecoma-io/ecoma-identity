# Jobs isolation

What this document is: why the Jobs Worker depends on neither
`identity-domain` nor `identity-application`, owns no identity state, and has no
D1 binding at all.

What this document is **not**: a description of the job types, the retry policy,
or the email templates. Those are `DEFERRED`, and the parts that are decided are
in [event-model.md](event-model.md).

## Status

| Fact                                                                                                               | State                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/identity-jobs/worker/Cargo.toml` names no `identity-domain` and no `identity-application`                    | `IMPLEMENTED` — the manifest is written that way today                                                                            |
| The Jobs Worker has no `IDENTITY_DB` binding                                                                       | `PLANNED` — decided; the configuration that proves it is `DEFERRED`                                                               |
| The Jobs Worker holds an `IDENTITY` service binding for narrow internal endpoints                                  | `PLANNED` — decided; the client is `DEFERRED`                                                                                     |
| The Jobs Worker consumes `IDENTITY_QUEUE`                                                                          | `PLANNED` — decided; the consumer is `DEFERRED`                                                                                   |
| The three event types (`identity.email.send.v1`, `identity.security.notification.v1`, `identity.audit.archive.v1`) | `IMPLEMENTED` as type names in `identity-domain`; no producer and no consumer exist                                               |
| The consumer idempotency contract                                                                                  | `DEFERRED` — the sequence is specified in [event-model.md](event-model.md); **no trait for it exists yet** in `identity-security` |

## The rule

> The **Jobs Worker** is a background side-effect worker and owns **no**
> identity state.

Two absences enforce it, and both are absences rather than prohibitions:

1. **No D1 binding at all.** The Jobs Worker's bootstrap configuration has no
   identity database. It cannot read identity state because it was never handed
   a way to.
2. **No dependency on `identity-domain` or `identity-application`.** The
   manifest names only `identity-cloudflare`, `identity-security`, `worker`,
   `serde` and `serde_json`. It is structurally incapable of evaluating an
   identity rule.

A prohibition ("do not query identity state") is a request. An absence (no
binding, no dependency) is a control. This is the same reasoning as
[admin-isolation.md](admin-isolation.md), applied to a different boundary.

## Why the dependency absence is the real boundary

The D1 binding is the obvious one, and it is the weaker of the two. Consider
what happens if the Jobs Worker had a database but no domain vocabulary. It
receives a message, and the payload contains a `user_id`. It has no way to ask
whether that user is active, whether the session is live, whether the
`security_version` matches, whether a second factor was satisfied. Every one of
those questions is answered by the Identity Worker, over the service binding, or
not at all.

That is the correct design. A background worker that _could_ answer those
questions would be answering them from stale data anyway — a queue message is a
fact about the past, and a user suspended a second after the message was
published would still be suspended-by-the-time-of-the-message. A decision made
from a stale local copy is a decision made from a lie.

The dangerous shape is the one where the vocabulary is available. Then Jobs has
enough to write something that looks like a rule — a check on a field, a
comparison against a status — and the check is wrong in a way no type system
can catch, because the check is not about types. It is about who is allowed to
do what, and that is precisely the judgement `identity-application` exists to
own.

The manifest comment names the exact sentence that starts this: _"it only needs
the `User` type"_. It is not a strawman. It is the most common real reason a
boundary like this erodes, and it is why the constraint is enforced at the
manifest rather than in review.

## What a queue message is, and is not

A message on `IDENTITY_QUEUE` is an untrusted input.

It is not a trustworthy caller. Anyone who can publish to the queue can put a
payload on it, and a future producer — including one added by a later phase, by
a different team, for a different purpose — becomes a new caller of the Jobs
Worker without anyone reviewing it as such. The consequence of treating a
message as an authenticated instruction is that the security question shifts
from "is this request permitted?" to "is this message well-formed?", which is a
much weaker question.

The consequences that follow, all of them `DEFERRED`:

- The payload is validated against the event type's own versioned schema before
  anything is done with it.
- The event type carries a version in its name — `identity.email.send.v1` — and
  `OutboxEventType::parse` **refuses** a type without a `.vN` suffix. A consumer
  that does not understand the version refuses the message rather than
  misreading it. `OutboxEventType::version()` returns `0` for an unparseable
  suffix, and no consumer supports version 0, so a malformed type surfaces as
  "unsupported", not as a plausible-looking version that binds to the wrong
  schema.
- An unknown event type is not an error to be ignored. It is a message to
  dead-letter or skip deliberately, with a count, not a silent `Ok`.

## What the Jobs Worker may legitimately need

There are narrow cases where a job needs to know something about identity, and
they all have the same answer: **ask the Identity Worker over the service
binding, and let it decide.**

| Need                                         | How it is answered                                                                                           | State     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| "What is this user's current email address?" | A narrow internal endpoint on `identity`                                                                     | `PLANNED` |
| "Is this user still active?"                 | The same, and the answer is only used to decide whether the effect is still wanted                           | `PLANNED` |
| "Is this event still worth delivering?"      | A narrow internal endpoint, or the message's own semantics                                                   | `PLANNED` |
| "Record that I sent this email"              | Not identity state. The Jobs Worker records the fact in its own scratch state, or does not record it at all. | `PLANNED` |

`JOBS_KV` holds scratch and idempotency state. It is not authoritative, in the
same way and for the same reason `IDENTITY_KV` is not: a stale idempotency
record causes a duplicate email, and a duplicate email is a support ticket, not a
security incident. The distinction matters — see
[event-model.md](event-model.md) for what a duplicate actually costs in each
direction.

## What breaks if this is violated

| Violation                                               | Consequence                                                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jobs gains `identity-domain`                            | It can construct and pattern-match on model types, and the first "is this user still active?" check written from a queue payload is a decision made from stale data. |
| Jobs gains `IDENTITY_DB`                                | It can read and write every user, credential and session, from a code path nobody reviews as an identity code path.                                                  |
| Jobs publishes to the queue                             | A loop with no owner. Every message generates another message, and the failure mode is an unbounded bill and a queue nobody can drain.                               |
| Jobs treats a duplicate as an error and dead-letters it | Real work is dropped: an email that was never sent is never retried. See [event-model.md](event-model.md).                                                           |
| Jobs assumes a message is authentic                     | The security question becomes structural validity, which a hostile publisher satisfies for free.                                                                     |
| Jobs grows a general-purpose "task" capability          | Constraint 7 in disguise: a fourth deployable by accretion. A new Worker needs an ADR and proof it cannot live in one of the three.                                  |

## The escape route

The Jobs Worker has no database. If a job needs persistent state of its own that
is not a scratch cache, the answer is not "give it the identity database" and
not "let it write to the admin database". It is: is this a fourth deployable? If
so, that is a constraint-7 decision, it needs an ADR, and it needs proof it
cannot live in one of the three.

Most jobs that appear to need this do not. The outbox row is already
persistent, already owned by the Identity Worker, and already the record of the
fact. The job's own scratch state is a cache of that row, not a second copy of
it.

## Related

- [event-model.md](event-model.md) — delivery guarantees and consumer
  idempotency.
- [admin-isolation.md](admin-isolation.md) — the same argument applied to the
  other negative boundary.
- [crate-dependency-law.md](crate-dependency-law.md) — the dependency graph this
  absence sits in.
