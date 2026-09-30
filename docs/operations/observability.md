# Observability

What this document is: what this system logs, what it must never log, what the
audit trail is and how it differs from a log, and what an operator can answer
from each.

What this document is **not**: a metrics catalogue or a dashboard specification.
There is no metrics pipeline described here, because there is no running system to
produce metrics.

## Status

| Fact                                                                             | State                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The audit event vocabulary — 21 `AuditEventType` values                          | `IMPLEMENTED` as a type, with `is_administrative()` and `concerns_a_user()`                                                                                                                                                                    |
| `AuditEvent`'s three separate identities and its `request_id`                    | `IMPLEMENTED` as a type                                                                                                                                                                                                                        |
| Redacted `Debug`/`Display` for `ClientSecret`, `TotpSecret`, `RecoveryCodeBatch` | `IMPLEMENTED`, with tests                                                                                                                                                                                                                      |
| `SecurityError::merits_audit()` and `is_client_safe()`                           | `IMPLEMENTED`                                                                                                                                                                                                                                  |
| Any log statement in any Worker                                                  | `DEFERRED` — all three Worker crates are placeholders                                                                                                                                                                                          |
| The `audit_events` table                                                         | `DEFERRED` — no migration exists                                                                                                                                                                                                               |
| Writing an audit event in the same transaction as the state change               | `DEFERRED`                                                                                                                                                                                                                                     |
| The `request_id` plumbing                                                        | `SCAFFOLDED` — `identity-cloudflare`'s error envelope carries a `request_id: Option<String>` and `CloudflareError::envelope(request_id)` threads it through. What does not exist is a Worker that generates one at the edge and propagates it. |

**There is no log output from this system today.** No Worker exists. What follows
is the contract, and the contract is where the value is: deciding what not to
log is most of the work.

## The three records, and why they are not interchangeable

Ecoma Identity produces three kinds of record, and conflating them is the most
common observability mistake in an identity system.

|                     | Log line                  | Audit event                                      | Outbox row                                        |
| ------------------- | ------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| **Purpose**         | Operate the system        | Establish what happened, and who did it          | Carry a committed fact to a side effect           |
| **Audience**        | An operator, on call, now | An investigator, later — possibly a regulator    | A consumer, later                                 |
| **Latency**         | Immediate                 | Immediate, in the same transaction as the change | After the transaction commits                     |
| **May be dropped**  | Yes — logs expire         | **No — append-only**                             | No, until dispatched and past the attempt ceiling |
| **Who may read it** | Anyone with log access    | Auditors, investigators, the operator            | The Jobs Worker                                   |
| **Mutable**         | No, but it expires        | **Never**                                        | Only `dispatch_attempts`                          |

The distinction that matters most: **a log line is a best-effort record and an
audit event is a durable one.** A security review needs to know who changed a
role, when, and from where. If that fact lives only in a log line, then the
system cannot answer the question after the log retention window, which is
precisely when a security review happens.

The second distinction: **an audit event is written by the component that
performs the mutation, in the same transaction as the mutation.** This is why the
Admin Worker has no database. If the audit record for an administrative action
were written by the caller, then a compromise of the caller is a compromise of
the audit trail — and an audit trail that the attacker controls is not evidence.
Full argument in
[../architecture/admin-isolation.md](../architecture/admin-isolation.md).

## The audit trail

### The event vocabulary

21 event types, all defined in `identity-domain::audit::AuditEventType`:

| Group                | Events                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| **Authentication**   | `UserAuthenticated`, `AuthenticationFailed`                               |
| **Sessions**         | `SessionCreated`, `SessionRevoked`, `AllSessionsRevoked`                  |
| **Authenticators**   | `AuthenticatorEnrolled`, `AuthenticatorRemoved`                           |
| **Identities**       | `IdentityLinked`, `IdentityUnlinked`                                      |
| **Email**            | `EmailAdded`, `EmailRemoved`                                              |
| **Profile**          | `ProfileUpdated`                                                          |
| **Account state**    | `UserSuspended`, `UserUnsuspended`, `UserRoleChanged`                     |
| **Applications**     | `ApplicationRegistered`, `ApplicationUpdated`, `ApplicationSecretRotated` |
| **Access grants**    | `ApplicationAccessGranted`, `ApplicationAccessRevoked`                    |
| **Security version** | `SecurityVersionBumped`                                                   |

Two predicates make this queryable without scanning free text:
`is_administrative()` covers the administrative events, and `concerns_a_user()`
covers the events that are about somebody. Those two questions — "show me every
administrative action" and "show me everything about this user" — are the two an
investigator actually asks, and they are indexable because the predicate exists.

`ApplicationSecretRotated` is in that list on purpose. A client-secret rotation
is a security event with a blast radius — it is in
[../security/secrets-management.md](../security/secrets-management.md) — and a
rotation with no audit record is a rotation an investigator cannot see.

`SecurityVersionBumped` is there for the same reason. Bumping `security_version`
revokes every session on an account, and a platform-wide `security_version`
change is a mass revocation. It is the kind of event that must be attributable.

### The record shape

| Field              | Why it exists                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `id`               | A UUID, so an event is addressable.                                                                    |
| `event_type`       | From the fixed vocabulary.                                                                             |
| `user_id`          | **Who the event is about.** Nullable: an `ApplicationRegistered` concerns no user.                     |
| `actor_id`         | **Who did it.** Nullable: a system-initiated event has no human actor.                                 |
| `actor_session_id` | **Under which session.** The difference between "an admin did this" and "an admin's session did this". |
| `occurred_at_ms`   | When, in milliseconds. A monotonic source would be better for ordering; this is what the type carries. |
| `request_id`       | Ties the event to a log line. This is the join between the two records.                                |
| `metadata`         | `BTreeMap<String, String>`, keys from a fixed vocabulary.                                              |

**The three identities are three columns and are never collapsed.** For a
suspension, `user_id` is the suspended user and `actor_id` is the administrator.
Collapsing them into one "user id" is how an audit log becomes unable to answer
"who suspended me" — which is the first question asked of any suspension.

**`metadata` is a `BTreeMap<String, String>`, not an arbitrary JSON object.**
Three consequences, all deliberate:

- Key order is **stable**, so two runs of the same operation produce
  byte-identical metadata. A diff of two audit rows is meaningful.
- Values are **strings only**, so an arbitrary value cannot be smuggled in. If
  `metadata` accepted a nested object, a caller could put a token in it, and
  `metadata` is read by people.
- The key vocabulary is **fixed**, so "what fields does this event type carry" is
  answerable. A free-form map with no vocabulary means every consumer has to
  discover the shape by reading rows.

### Append-only

There is no `UPDATE` against `audit_events`. There is no `DELETE` against
`audit_events`. There is no operation in `identity-domain` or
`identity-application` that would produce one.

This is not a policy that could be relaxed; there is no code path to relax. A
change that would add one is a change to the model, and it needs an ADR.

The corollary for operators: **audit events are never rotated or expired.** The
table grows. That is a capacity problem with a known answer (partitioning,
archiving — which is what the `identity.audit.archive.v1` outbox event is
_for_), and it is not a reason to add a delete.

## What is never logged

Restated from SC-24 in
[../security/security-constraints.md](../security/security-constraints.md),
because the reasoning is worth repeating: **logs are longer-lived, wider, and
less protected than the system they describe.** A session token in a log
aggregator is a session that cannot be invalidated by revoking the session,
because revoking the session does not remove it from the log.

Never logged, at any level, including `debug`:

| Never                                                                       | Why                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Client secrets                                                              | A bearer credential for every user who authorized the client. |
| TOTP secrets                                                                | A permanent second factor.                                    |
| Recovery codes                                                              | A full second-factor bypass.                                  |
| Session cookie values, `Set-Cookie`                                         | A completed authentication.                                   |
| `Authorization`, `Cookie` headers                                           | Directly the above.                                           |
| Authorization codes                                                         | Redeemable for a token by anyone who has them.                |
| OTPs                                                                        | Bearer credentials with a short life and a long audit trail.  |
| Refresh tokens                                                              | Long-lived bearer credentials.                                |
| `code_verifier` values                                                      | The PKCE secret; leaking it defeats PKCE.                     |
| Passkey assertions and challenges                                           | An assertion is an authentication.                            |
| `token`, `code`, `code_secret`, `client_secret`, `state` request parameters | The same material, in the URL, where every proxy logs it.     |

The redaction is in the **types**, not at the call sites. `ClientSecret`,
`TotpSecret` and `RecoveryCodeBatch` have hand-written redacted `Debug` and
`Display` implementations, and there are tests asserting it. A `#[derive(Debug)]`
on a type that holds secret material leaks on every log statement, forever; the
fix is in the type, not in a review checklist.

Never forwarded to a client — the same separation, for reasons that are the
mirror image: an operator-facing message that reaches a client is an information
disclosure, and some of them are worse than a stack trace because they are
confident.

| Never forwarded                         | Because it names                                                |
| --------------------------------------- | --------------------------------------------------------------- |
| `ApplicationError::Dependency` reason   | A database error string, from a system the caller does not own. |
| `SecurityError::MissingSecret`          | The **name** of the absent secret — which key is misconfigured. |
| `SecurityError::Cryptographic`          | A reason that can carry a key name.                             |
| `SecurityError::RateLimiterUnavailable` | Our outage, in our words, to our caller.                        |

`is_client_safe()` is the question the transport must ask, and
`ApplicationError::Dependency` is the reason it is a question rather than a
default.

## What is logged

The counterpart. A system that only has a "never" list logs nothing, and an
operator with nothing is as blind as one with a leak.

Every log line, at every level:

- A **`request_id`**, generated at the edge and propagated. This is the join
  between the log and the audit trail, and it is why `AuditEvent.request_id`
  exists.
- The **route** and the **status code**.
- The **duration**. A request that takes 40 seconds is a failure even when it
  returns 200.
- The **Worker and version id**. Two Workers both log to the same place, and a
  line without a version is a line you cannot attribute to a deploy. This is
  most useful during a canary, when 1% of traffic is on a version you may need
  to roll back.

And, by severity:

| Level   | What goes here                          | Example                                                                       |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `error` | A failure an operator must act on       | A dependency failure, a missing secret, a cryptographic operation that failed |
| `warn`  | A refused request that is not an attack | `Expired` credentials, `MalformedToken`, `RateLimiterUnavailable`             |
| `info`  | A security-relevant success             | A session created, a role changed, a secret rotated                           |
| `debug` | Diagnostics, off by default             | A rejected scope, a requested-but-not-granted field                           |

The `warn` row is not arbitrary; it follows `SecurityError::merits_audit()`.
That function exists to make this distinction mechanical rather than a judgement
call per call site: `VerificationFailed`, `AlreadyRedeemed`,
`ChallengeMismatch`, `TokenRejected` and `InsufficientAssurance` merit an audit
event; `Expired`, `MalformedToken`, `RateLimiterUnavailable`, `MissingSecret`
and `Cryptographic` do not.

The reasoning is in the source and is worth repeating, because getting it wrong
makes the audit trail unqueryable: a repeated `VerificationFailed` is a
credential-stuffing signal, a `MalformedToken` is usually a confused client, and
a `RateLimiterUnavailable` is an outage. Recording all three in one table makes
the first one impossible to find.

## Request identity

`request_id` is generated at the edge — the first thing a Worker does with a
request — and propagated through the handler, into any audit event the request
produces, and into every log line the request produces.

Its jobs:

1. **Join the two records.** A log line and an audit event for the same action
   share an id, so an investigator moves from "an administrator did something at
   14:32" to the request's full detail.
2. **Survive the queue.** An outbox event carries the `request_id` of the request
   that committed it, so an email the Jobs Worker sent hours later is traceable
   to the action that caused it.
3. **Distinguish retries.** A retried request has a new `request_id`. Two log
   lines with different ids and the same action are a retry, not two actions.

The plumbing lives in the shared adapter crate — "the health routes, the OIDC
route table, the error envelope and the request-id plumbing all come from
`identity-cloudflare`" — so the three Workers cannot drift on it, which is the
same reason the error envelope does. `ErrorEnvelope` carries
`request_id: Option<String>`, skipped from the wire when absent, and
`CloudflareError::envelope(request_id)` is where a code, a client-safe message
and that id are assembled into the one object a response returns. What is
`DEFERRED` is the other half: no Worker generates a request id at the edge, puts
it in a log line, or propagates it into an audit event.

## What an operator can answer

The test of an observability design is what it answers, so here are the questions
this system is meant to answer, and whether it can today.

| Question                                                 | Source                                                                      | Answerable today?         |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| Who changed this user's role, and when?                  | `audit_events` filtered by `user_id` and `event_type = 'user_role_changed'` | **No** — no table         |
| Who suspended this user?                                 | `user_id` is the subject, `actor_id` is the administrator                   | **No**                    |
| What is live in production right now?                    | `wrangler deployments list`                                                 | **No** — nothing deployed |
| Which version served this request?                       | The `version id` on the log line                                            | **No** — no Workers       |
| Did this email address attempt a login in the last hour? | `audit_events` where `metadata` carries the address, or a log query         | **No**                    |
| What did this administrator do today?                    | `audit_events` where `is_administrative()`                                  | **No**                    |
| Is the outbox draining?                                  | `outbox_events` where `dispatch_attempts > 0`                               | **No**                    |
| What is dead-lettered?                                   | `outbox_events` where `dispatch_attempts = 25`                              | **No**                    |

Every row is **No**, and that is the honest state. The table is here so that the
questions are named before the answers are needed — a system that has never
decided what it will answer is a system that cannot answer anything during an
incident, when the decision is expensive.

## Related

- [../security/secrets-management.md](../security/secrets-management.md) — the
  full never-logged list, and the rotation procedures the audit trail records.
- [../security/security-constraints.md](../security/security-constraints.md) —
  SC-21 (code is the contract), SC-23 (append-only), SC-24 (never logged).
- [../architecture/data-model.md](../architecture/data-model.md) — the
  `audit_events` and `outbox_events` tables.
- [rollback.md](rollback.md) — step 4 of the post-rollback procedure depends on
  this trail.
