# Database

What this directory is: the D1 schema for the `identity` Worker, the fixtures
that let the integration tests exercise it, and an honest statement of what is
not there yet.

What this directory is **not**: the data model. `docs/architecture/data-model.md`
explains the mapping from a domain type to a table; this directory is the
migrations, and where the two disagree, the migrations are right and the
document is fixed in the same commit (`AGENTS.md`, "one fact, one owner").

## Status

| Fact                                                             | State                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Every table named by `data-model.md` exists as a migration       | `IMPLEMENTED` as SQL                                                                                  |
| Every migration applies to an empty D1 database                  | `IMPLEMENTED` — verified, see below                                                                   |
| Every migration applies on top of the previous one               | `IMPLEMENTED` — verified, see below                                                                   |
| `wrangler d1 migrations apply` is transactional per file         | `IMPLEMENTED` — verified empirically, not assumed                                                     |
| The OTP consumption guard refuses a second concurrent redemption | `IMPLEMENTED` as SQL — verified by a race test, see below                                             |
| Row constructors, repositories, D1 adapters                      | `DEFERRED` — no code reads or writes any of these tables                                              |
| Seed data                                                        | `DEFERRED` — there is nothing to seed yet, and `seeds/` says so                                       |
| A test runner that applies these migrations in CI                | `DEFERRED` — the integration test shells out to `wrangler`, which is not on PATH in every environment |

**The schema is real. Nothing is stored.** No repository exists, no row has ever
been written by the platform, and every authentication route answers `501`. A
table existing is not a feature working.

## Why the directory is split in two

```
database/
├── identity/     <- migrations, seeds, fixtures. Owned by the `identity` Worker.
└── admin/        <- NO migrations. Fixtures only.
```

This split is the constraint, not an organisational preference.

The `identity` Worker is the only thing permitted to touch Identity D1
(constraint §2, ADR-0003). Its migrations therefore live under
`database/identity/`, named for the Worker that owns the database rather than
for the data, because the ownership is the fact that matters: if the split were
by subject matter ("users/", "sessions/"), the day somebody adds an
`identity-admin/` table next to them the boundary would be invisible.

`database/admin/` has **no migrations at all**, and that is the correct state
rather than a gap. The Admin Worker holds no `IDENTITY_DB` binding, in code and
in configuration (ADR-0004, `docs/architecture/admin-isolation.md`). It reaches
identity only through the private `IDENTITY` service binding, so there is no
identity schema for it to migrate. What it legitimately owns is its _own_
administrative storage — operator preferences, saved filters, rate-limiter state
— which must be a different database with different credentials containing no
user, session, credential or authentication record, bound through a differently
named binding so `pnpm arch` finds the identity binding in exactly one
Worker per environment.

That database is `DEFERRED` and needs its own ADR before it exists
(`admin-isolation.md` §5.4). Until then `database/admin/fixtures/` holds
fixtures that are honest about being fixtures for a schema that does not exist
yet, and `database/admin/migrations/` holds a README explaining the absence
instead of an empty directory.

## Order

Migrations are applied in numeric-prefix order, which is why every file is named
`NNNN_snake_case_name.sql` and the number is the ledger key rather than the
filename:

| Version | File                           | Adds                                                          |
| ------- | ------------------------------ | ------------------------------------------------------------- |
| 0001    | `0001_schema_migrations.sql`   | The migration ledger itself                                   |
| 0002    | `0002_users.sql`               | `users`, including `security_version`                         |
| 0003    | `0003_user_emails.sql`         | `user_emails`                                                 |
| 0004    | `0004_user_identities.sql`     | `user_identities`, and the `(provider, subject)` unique index |
| 0005    | `0005_sessions.sql`            | `sessions`                                                    |
| 0006    | `0006_authenticators.sql`      | `authenticators`                                              |
| 0007    | `0007_otp_challenges.sql`      | `otp_challenges`, and the atomic consumption guard            |
| 0008    | `0008_applications.sql`        | `applications`, `application_secrets`                         |
| 0009    | `0009_application_grants.sql`  | `application_grants` (a granted application, per user)        |
| 0010    | `0010_consents.sql`            | `consents` (recorded OIDC consent)                            |
| 0011    | `0011_pkce_challenges.sql`     | `pkce_challenges`                                             |
| 0012    | `0012_nonces.sql`              | `nonces`                                                      |
| 0013    | `0013_outbox_events.sql`       | `outbox_events`                                               |
| 0014    | `0014_audit_events.sql`        | `audit_events`                                                |
| 0015    | `0015_idempotency_keys.sql`    | `idempotency_keys`                                            |
| 0016    | `0016_rate_limit_counters.sql` | `rate_limit_counters`                                         |

Renaming a file after it has been applied is safe, because the ledger keys on the
number. Changing the number, editing an applied file, or reordering is not, and
`wrangler` detects a changed checksum only if the file's content changed — which
is why the editing-an-applied-file rule is stated rather than enforced.

## The backward-compatibility rule

Constraint §21, ADR-0011: **a migration may add; it may never remove or
narrow.** The full statement is in the header of
`identity/migrations/0001_schema_migrations.sql`, and every file repeats a
two-line version of it in its own header, because that header is the artifact a
reviewer reads when a deploy goes wrong and it must not require scrolling up.

In practice, in this directory:

| Allowed                                                                | Refused                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `CREATE TABLE`                                                         | `DROP TABLE`                                         |
| `CREATE INDEX`                                                         | `DROP INDEX`                                         |
| `ALTER TABLE ... ADD COLUMN` nullable or defaulted                     | `ALTER TABLE ... DROP COLUMN`                        |
| Widening a `CHECK`'s vocabulary (`... IN (a, b)` → `... IN (a, b, c)`) | Narrowing one (`... IN (a, b, c)` → `... IN (a, b)`) |
| A new index on an existing table                                       | `ALTER TABLE ... RENAME` anything                    |

`ALTER TABLE ... RENAME COLUMN` deserves its own note because it is the change
most likely to be proposed by someone who has not thought about the rollback
window. A rename is a drop and an add wearing a disguise: the old Worker version,
still serving half the canary's traffic, reads the old name and finds nothing.

The reason the rule exists is mechanical, not aesthetic. Cloudflare Worker
rollback promotes a previously-uploaded **version id of the code**. It cannot
restore a database. So for the whole length of a production canary — smoke → 1%
→ 10% → HUMAN → 50% → 100% — two versions of the code read the same database,
and the schema has to be readable by both.

## What happens when a migration fails halfway

It leaves nothing behind. This is verified, not assumed.

`wrangler d1 migrations apply` wraps each migration file in a transaction. A
probe migration that created a table and then hit a PRIMARY KEY conflict left
only the created table and recorded **no** row in `schema_migrations`; the
following migration did not run. See
`tests/integration/migrations/half-failure/` for the probe, and
`tests/integration/schema.test.mjs` for the assertion that is part of the suite.

That behaviour is why `schema_migrations` exists at all. A database that claims
version 7 but does not have version 7's tables is strictly worse than one that
claims nothing: every later migration applies on top of a schema the runner
believes is whole, and the failure surfaces as a missing table three deploys
later instead of as a failed migration now.

The residual risk is the boundary, not the middle: D1's transaction is per
migration _file_, so a failure in file 9 leaves files 1–8 applied and 9
unapplied. That is a recoverable state — re-run `migrations apply`, which skips
1–8 — and it is why migrations are small and named per table. One migration per
table means the worst case is one table's worth of work re-applied.

The failure mode that is **not** protected against: an operator running
`wrangler d1 execute --local` with a hand-edited SQL file instead of
`migrations apply`. `execute` is not transactional across a file's statements in
the same way, and it does not update the ledger. Use `migrations apply` for
anything that is not a read.

## Running the migrations locally

```sh
# Apply to the local D1 replica.
pnpm exec wrangler d1 migrations apply IDENTITY_DB --local

# Or through the task the repo declares, once it exists:
moon run identity:db-migrate
```

`--local` writes to `.wrangler/state/`, never to a real database. There is no
production step in this document on purpose; the deployment procedure is
`docs/operations/deployment-model.md` and an operator follows it, not a
developer copying a line from a README.

## Fixtures and seeds

- `identity/seeds/` — **empty, on purpose.** Seeds are rows the platform itself
  would create. At bootstrap the platform creates no rows, because
  authentication is not implemented: there is no user to sign up, no
  application to register, no session to open. A seed file here would be a row
  that claims a fact the code cannot produce. The README in that directory says
  so, and it will stay until there is a real row to seed.
- `identity/fixtures/` — rows with deliberately chosen states, for the
  integration tests. Every fixture names the invariant or the test it exists for.
  The last-administrator fixture contains **exactly one** administrator, and its
  README explains at length why that is a fixture worth being paranoid about.

## What is deferred

Named, so a reader does not have to infer it from an absence:

- **No repository, no row constructor, no D1 adapter.** `identity-cloudflare`'s
  D1 module is mid-write and does not compile. Nothing in this schema is read or
  written by anything.
- **No `updated_at_ms` maintenance.** There is no trigger. Every writer must set
  it explicitly, and no writer exists yet.
- **No foreign key to `sessions` from `audit_events.actor_session_id`.** The
  column exists because `AuditEvent` carries it, but a foreign key there would
  mean audit rows disappear when a session is purged, which is the opposite of
  what an audit log is for. `audit_events` references `users` loosely for the
  same reason.
- **No partitioning, no archiving, no retention job.** `audit_events` grows
  without bound; `identity.audit.archive.v1` exists as a constructor and as
  nothing else.
- **No rate-limit table on the Identity Worker.** `rate_limit_counters` is
  declared here for the tables a Worker needs to survive a restart; the
  authoritative rate limiter is `ADMIN_RATE_LIMITER` on the Admin Worker, a
  separate binding entirely.
- **No test that runs in CI yet.** The integration tests shell out to `wrangler`
  and skip with a named reason when it is absent, rather than passing vacuously.
- **The unique index on `user_emails(address)` is not what `data-model.md`
  describes.** That document names a partial unique index on `(address) WHERE
is_primary = 1` plus a separate verified-only rule, and marks the exact rule
  `DEFERRED`. This schema enforces the stronger rule — one account per address,
  full stop — because a bare partial index would permit two accounts to hold the
  same address with neither of them primary, which is exactly the state that
  makes "which account does this reset mail belong to" ambiguous. The divergence
  is recorded here rather than papered over.

## Related

- `identity/migrations/0001_schema_migrations.sql` — the forward-only rule, in
  full, at the top of the file that has to exist before any of the others.
- `docs/architecture/data-model.md` — the type-to-table mapping this implements.
- `docs/architecture/event-model.md` — the outbox, and why `outbox_events.id` is
  the consumer's idempotency key.
- `docs/security/threat-model.md` — what an attacker gets out of each table;
  every security-relevant table here restates its own.
- `docs/operations/rollback.md` — why the schema is forward-only.
