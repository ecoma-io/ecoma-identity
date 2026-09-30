# Data model

What this document is: the domain model, and how each shape becomes a table.

What this document is **not**: the schema itself. The migrations are the
authority and live in `database/identity/migrations/`, which is the
`migrations_dir` of the `identity` deployable and the only migrations
directory in the tree. This document explains the
mapping and the reasoning, so that a migration can be reviewed for whether it is
the right shape and not only for whether it applies.

## Status

| Layer                                          | State                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The domain types in `identity-domain`          | `IMPLEMENTED` — the structs, enums and newtypes are real and their invariants are tested                       |
| The table names and column shapes below        | `DEFERRED` — this is the intended mapping; the migrations are being written                                    |
| The repository traits that read and write them | `SCAFFOLDED` — ports declared in `identity-application` with no bodies                                         |
| The D1 adapters that implement them            | `SCAFFOLDED` — `identity-cloudflare`'s `d1` module is written; the crate is mid-write and does not compile yet |
| The uniqueness index on `(provider, subject)`  | `PLANNED` — claimed by the domain; not yet created. The invariant test for it is `#[ignore]`d with that reason |

**The domain is real. Nothing is stored.** No migration exists, no repository
exists, and no row has ever been written. A reader designing against the tables
below is designing against an intent.

## The forward-only rule

Constraint 21: **database migrations are backward-compatible. There is no
database rollback path; a migration may add, never remove or narrow.**

The full reasoning belongs in the ADR this belongs to; the operational
consequence belongs in [rollback.md](../operations/rollback.md), and it is worth
stating here because it shapes every schema decision:

- A migration may **add** a table, a column (nullable or with a default), an
  index, or a new value in a check constraint's vocabulary.
- A migration may **widen** a constraint: accept more values, raise a length
  limit, permit a new status.
- A migration may **not** remove or rename a column that any not-yet-rolled-back
  version reads; may not narrow a constraint any not-yet-rolled-back version
  satisfies; and may not change a value's meaning.

This is what makes a rollback a version promotion rather than a database
restore. The previous version of the Worker is still running against the current
schema for the whole time any rollback window is open, so the schema has to be
readable by both. A rename is a drop and an add wearing a disguise, and it is
the change most likely to be proposed by someone who has not thought about the
rollback window.

## The entities

| Domain type              | Table                | Notes                                  |
| ------------------------ | -------------------- | -------------------------------------- |
| `User`                   | `users`              | The person and their standing          |
| `UserId` (UUID)          | `users.id`           | Primary key                            |
| `Identity`               | `user_identities`    | A provider's assertion about a user    |
| `IdentityId` (UUID)      | `user_identities.id` | Primary key                            |
| `Authenticator`          | `authenticators`     | A factor the user has enrolled         |
| `AuthenticatorId` (UUID) | `authenticators.id`  | Primary key                            |
| `Session`                | `sessions`           | A live authentication                  |
| `SessionId` (UUID)       | `sessions.id`        | Primary key                            |
| `EmailAddress`           | `user_emails`        | Verified and unverified addresses      |
| `Application`            | `applications`       | A registered OAuth/OIDC client         |
| `ApplicationId` (UUID)   | `applications.id`    | Primary key                            |
| `SecurityVersion` (u32)  | a column on `users`  | Not a table; it is a value on the user |
| `AuditEvent`             | `audit_events`       | Append-only                            |
| `AuditEventId` (UUID)    | `audit_events.id`    | Primary key                            |
| `OutboxEvent`            | `outbox_events`      | The transactional outbox               |

Two of these are not tables, and the distinction is load-bearing:

- **`SecurityVersion` is a `u32` column on `users`, not a table.** Its whole
  purpose is to make "revoke every session" an O(1) comparison per request
  instead of an enumeration of session rows. A session records the version it
  was issued under; an access check compares it against the user's current
  version and refuses when they differ. Bumping the column invalidates every
  older session at once, with no write to `sessions` at all. The domain crate
  asserts this arithmetic for real, and the reason is in
  [threat-model.md](../security/threat-model.md) under the
  `security_version` gap.
- **`Aal` is a value on a session row, not a table.** `Aal` is `Aal1` or `Aal2`
  and nothing else. Making it a table would be modelling a two-variant enum.

## The shapes

### `users`

| Column             | Type    | Notes                                                        |
| ------------------ | ------- | ------------------------------------------------------------ |
| `id`               | TEXT    | UUID, the canonical string form, primary key                 |
| `display_name`     | TEXT    | Non-blank, bounded                                           |
| `role`             | TEXT    | `member`, `support`, `administrator`, `service`              |
| `status`           | TEXT    | `active`, `suspended`, `deactivated`, `pending_verification` |
| `security_version` | INTEGER | `0` at creation; bumped to invalidate sessions               |
| `created_at_ms`    | INTEGER |                                                              |

`UserStatus::permits_authentication` is the rule that `active` is the only
status from which a user may authenticate. `Deactivated` and `PendingVerification`
are distinct from `Suspended` on purpose: suspension is an administrative act
that can be lifted, deactivation is a user act, and conflating them makes "who
did this and can it be undone" unanswerable from the row alone. The invariant
that ties status to authentication is `#[ignore]`d in the domain crate, with the
reason that the use case that would enforce it does not exist yet.

`PlatformRole` is `Member`, `Support`, `Administrator` or `Service`, and the
important properties are on the type: `is_administrative()` and
`may_assign_roles()`. Only `Administrator` may assign roles; `Support` moderates
accounts but does not promote. This is platform administration and **not**
business authorization — see [overview.md](overview.md).

The `Service` role deserves a note. It is the role for a machine identity. Its
existence is a `DEFERRED` design, and the constraint that matters when it is
built: a service identity may not assign roles. The `RoleChange` evaluation
already refuses a non-`may_assign_roles` actor before the administrator count is
consulted, and there is a test for exactly that.

### `user_identities`

| Column     | Type | Notes                                          |
| ---------- | ---- | ---------------------------------------------- |
| `id`       | TEXT | UUID, primary key                              |
| `user_id`  | TEXT | Foreign key to `users.id`                      |
| `provider` | TEXT | `oauth`, `passkey`, `email`, `saml`            |
| `subject`  | TEXT | The provider's user identifier                 |
| `label`    | TEXT | Nullable; a human label for the linked account |

**Unique on `(provider, subject)`.** This index is the enforcement point for "a
user subject cannot be reused by another user", and it is the reason
`IdentityProvider::subject_is_globally_unique` exists. Only `Passkey` subjects
are globally unique on their own, because a passkey's user handle is minted here.
An OAuth provider's `sub` is only stable and unique _within that provider_ —
Google's and GitHub's identifiers are both only meaningful paired with the
provider. A unique index on `subject` alone would refuse a legitimate user who
has both a Google and a GitHub account whose identifiers happen to collide, and
a unique index on nothing at all would let one provider's subject be claimed by
another user's account.

That uniqueness rule is `#[ignore]`d in `identity-domain` with exactly this
reason: the index is the claim, and until a repository exists, nothing checks
it.

### `authenticators`

| Column            | Type    | Notes                                           |
| ----------------- | ------- | ----------------------------------------------- |
| `id`              | TEXT    | UUID, primary key                               |
| `user_id`         | TEXT    | Foreign key to `users.id`                       |
| `kind`            | TEXT    | `email_otp`, `totp`, `passkey`, `recovery_code` |
| `label`           | TEXT    | Nullable                                        |
| `enrolled_at_ms`  | INTEGER |                                                 |
| `last_used_at_ms` | INTEGER | Nullable                                        |
| `secret`          | TEXT    | Per kind; see below                             |

The `secret` column is where a real schema gets interesting, and the honest
answer today is that it does not exist yet. Three rules constrain it, and they
are all `PLANNED`:

- A **TOTP secret is shared-secret material.** It is stored, it is never logged,
  and it never appears in a `Display` implementation. `TotpSecret`'s `Debug` and
  `Display` are already redacted, and there is a test asserting it.
- A **passkey holds no private key.** The browser holds it. What is stored is
  the credential's public key and its id. There is a domain test asserting that
  `PasskeyCredential` holds no private key.
- A **recovery code is single-use.** The batch is stored hashed; redemption
  consumes a row.

One `secret` column with a per-kind meaning is the simplest shape, and it is
also the one that most invites "let's just add another nullable column".
Splitting it per kind is defensible; keeping it single is defensible; the thing
that is not defensible is making that decision implicitly, in a migration,
without an ADR. See [secrets-management.md](../security/secrets-management.md).

### `sessions`

| Column                   | Type    | Notes                                                       |
| ------------------------ | ------- | ----------------------------------------------------------- |
| `id`                     | TEXT    | UUID, primary key. This is the cookie's session identifier. |
| `user_id`                | TEXT    | Foreign key to `users.id`                                   |
| `status`                 | TEXT    | `active`, `revoked`, `expired`                              |
| `security_version`       | INTEGER | The user's version at issue time                            |
| `created_at_ms`          | INTEGER |                                                             |
| `expires_at_ms`          | INTEGER |                                                             |
| `aal`                    | TEXT    | `aal1` or `aal2`                                            |
| `recently_authenticated` | INTEGER | Boolean, **per session**                                    |

Two of these columns carry most of the security weight.

**`security_version`.** A session records the version it was issued under. Every
authenticated request compares it against `users.security_version`; a mismatch
refuses. This is what makes "log out everywhere" a single `UPDATE` on one row
rather than an enumeration, and it is why a password change or a role change
that alters security posture is an integer bump.

**`recently_authenticated`, per session and not per user.** This is the step-up
flag, and there is a domain test that says why it cannot live on the user row:
if "recently authenticated" were a property of the user, one account-wide flag
would let an attacker holding _any_ session on that account make _every other
session_ step-up-eligible at once. The step-up is a property of a moment in one
session, and the row is where the moment is.

### `user_emails`

| Column           | Type    | Notes                           |
| ---------------- | ------- | ------------------------------- |
| `id`             | TEXT    | UUID, primary key               |
| `user_id`        | TEXT    | Foreign key to `users.id`       |
| `address`        | TEXT    | The address, validated          |
| `verified_at_ms` | INTEGER | Nullable; null means unverified |
| `is_primary`     | INTEGER | Boolean                         |

`EmailAddress` validates on construction: at most 320 bytes overall, a local part
at most 64, a domain at most 255, and a non-blank, single-`@` shape with both
halves present. Uniqueness is a decision that is `PLANNED`, and the reason it is
not a bare unique index is that unverified addresses must be able to collide
with a row another user is mid-way through confirming. The shape is a partial
unique index on `(address)` where `is_primary = 1`, plus a separate uniqueness
rule for verified addresses only. That exact rule is `DEFERRED`; naming the
tension is more useful than picking a constraint now and defending it later.

### `applications`

| Column                 | Type    | Notes                                                         |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `id`                   | TEXT    | UUID, primary key                                             |
| `client_id`            | TEXT    | The public identifier presented at the token endpoint; unique |
| `client_secret_hash`   | TEXT    | The hash. Never the secret.                                   |
| `display_name`         | TEXT    |                                                               |
| `status`               | TEXT    | `active`, `suspended`, `retired`                              |
| `access_mode`          | TEXT    | `oidc` or `oauth2`                                            |
| `redirect_uris`        | TEXT    | JSON array; see below                                         |
| `allowed_scopes`       | TEXT    | JSON array; see below                                         |
| `secret_expires_at_ms` | INTEGER | Nullable; a rotation grace window                             |

`client_secret_hash` is a hash and never a secret. `ClientSecret` in
`identity-application` refuses to be printed — its `Display` and `Debug` are
redacted and a test asserts it — and the only accessor is
`expose_for_hashing`, a name that reads as an instruction to the next reader.
What it exposes to is a hasher, not a hasher _and_ an equality check: the
rotation outcome carries the old secret's expiry, not the old secret.

`redirect_uris` and `allowed_scopes` are stored as JSON arrays rather than as
child tables, and that is a real decision with a real cost. It keeps the
registration row one row, which suits a value that is only ever read as a whole
and written as a whole. It costs referential integrity and it makes
"which applications use this redirect URI" a full scan rather than an index
lookup. For a platform with a bounded number of registered applications, that
trade is correct. It would not be correct for a public multi-tenant registry,
and the day that becomes the requirement the decision needs revisiting — through
an ADR, with a migration that adds the child table without dropping the column.

The `redirect_uri` rules are enforced at the domain boundary, not by the
database: absolute, `http://` or `https://`, no fragment, at most 2048 bytes, no
duplicates. `Application::allows_redirect_uri` is an exact comparison, never a
prefix and never a glob — a registered `https://app.example.com/` does not
license `https://app.example.com/steal`, and certainly not
`https://app.example.com.attacker.test/`. The `granted_scopes` method returns
the **intersection** of requested and registered, not an error, because a
client asking optimistically for more than it registered for should get the
narrower grant rather than a hard failure.

### `audit_events`

| Column             | Type    | Notes                                                           |
| ------------------ | ------- | --------------------------------------------------------------- |
| `id`               | TEXT    | UUID, primary key                                               |
| `event_type`       | TEXT    | One of the 21 `AuditEventType` values                           |
| `user_id`          | TEXT    | Nullable; who the event is _about_                              |
| `actor_id`         | TEXT    | Nullable; who _did_ it                                          |
| `actor_session_id` | TEXT    | Nullable; under which session                                   |
| `occurred_at_ms`   | INTEGER |                                                                 |
| `request_id`       | TEXT    | Nullable; ties the event to a log line                          |
| `metadata`         | TEXT    | JSON object; `BTreeMap<String, String>`, so key order is stable |

**Append-only.** There is no update path and no delete path, and there is no
`identity-domain` or `identity-application` operation that would produce one.
`AuditEventType::is_administrative()` and `concerns_a_user()` exist so that
"show me every administrative action" and "show me everything about this user"
are indexable questions rather than a scan over a free-text metadata blob.

The three id columns are separate on purpose. `user_id` is who the event concerns
and `actor_id` is who performed it, and for a suspension they are different
people. Collapsing them into one "user id" is how an audit log becomes unable to
answer "who suspended me".

`metadata` is a `BTreeMap<String, String>`, not a JSON object with arbitrary
values, and that is a constraint rather than an accident: a string-valued map
serialises deterministically, so two runs of the same operation produce
byte-identical metadata, and a diff of two audit rows is meaningful.

### `outbox_events`

| Column              | Type    | Notes                                              |
| ------------------- | ------- | -------------------------------------------------- |
| `id`                | TEXT    | UUID, **and the idempotency key** for the consumer |
| `event_type`        | TEXT    | `identity.email.send.v1` and its siblings          |
| `payload`           | TEXT    | JSON; the message body                             |
| `occurred_at_ms`    | INTEGER | When the fact was committed                        |
| `dispatch_attempts` | INTEGER | Written by the dispatcher, never the producer      |

One row per committed fact, written in the same transaction as the state change
it describes. `event_type` carries its schema version in the name —
`identity.email.send.v1` — and `OutboxEventType::parse` refuses a type with no
`.vN` suffix, so an unversioned type cannot be written at all.

`dispatch_attempts` is bounded at `OutboxEvent::MAX_DISPATCH_ATTEMPTS` = 25.
Past the ceiling the row is dead-lettered rather than retried forever, and
`record_dispatch_attempt` returns `DomainError::IllegalTransition` on an
exhausted row, which is a dispatcher bug and should be visible as one. The
ceiling is chosen to outlast a weekend of a queue being misconfigured while
still failing in hours rather than days: an email that arrives three days late is
a support incident, and an unbounded retry is worse than a visible dead letter.

The delivery and consumer side of this table is [event-model.md](event-model.md).

## Indexes the rules need

| Index                                               | The rule it enforces                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `user_identities (provider, subject)` unique        | A subject cannot be claimed by two users                                                  |
| `applications (client_id)` unique                   | A client identifier names one application                                                 |
| `sessions (user_id, status)`                        | Listing and revoking a user's sessions without a scan                                     |
| `sessions (expires_at_ms)`                          | Expiry sweeps                                                                             |
| `outbox_events (dispatch_attempts, occurred_at_ms)` | The dispatcher claims un-dispatched rows in order                                         |
| `audit_events (user_id, occurred_at_ms)`            | "Everything about this user"                                                              |
| `audit_events (event_type, occurred_at_ms)`         | `is_administrative()` queries                                                             |
| `users (role, status)`                              | The active-administrator count, which must be evaluated inside the demotion's transaction |

That last one is load-bearing for a rule that is already implemented:
`RoleChangeRequest::evaluate` takes `active_administrator_count` as an **input**
so it can be a pure function and be tested without a database. The command that
will apply the change must compute that count inside the same transaction — two
concurrent demotions each seeing two administrators and both succeeding is
exactly how a platform ends up with zero. The function is real
(`identity-application::administration`); the transaction that feeds it correctly
is `DEFERRED`.

## Related

- [event-model.md](event-model.md) — the outbox, delivery, and consumer
  idempotency.
- [../security/threat-model.md](../security/threat-model.md) — what an attacker
  wants from each of these tables.
- [../operations/observability.md](../operations/observability.md) — the audit
  trail as an operational artifact.
- [../operations/rollback.md](../operations/rollback.md) — why the schema is
  forward-only.
