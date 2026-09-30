-- ===========================================================================
-- 0014_audit_events.sql
--
-- WHAT THIS ADDS: `audit_events` — the append-only record of every
-- security-relevant change. One row per fact, in the same transaction as the
-- change.
--
-- WHERE THE RUST PUTS THIS: `identity_domain::audit::AuditEvent`:
--   { id, event_type, user_id, actor_id, actor_session_id, occurred_at_ms,
--     request_id, metadata }
-- plus `AuditEventType`'s twenty-one snake_case variants and its two
-- classification methods, `is_administrative()` and `concerns_a_user()`.
--
-- BACKWARD-COMPATIBILITY: additive only. CREATEs one table and three indexes.
-- Nothing references it yet, so its appearing cannot break a canaried Worker
-- version. Full rule: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS audit_events (
    -- `AuditEvent.id` — `AuditEventId`, UUID text. Surrogate key.
    --
    -- Unlike `outbox_events.id`, this one is NOT an idempotency key: nothing
    -- consumes an audit event for effect, and the Jobs Worker's
    -- `identity.audit.archive.v1` consumer copies rows by id rather than
    -- deduplicating by them. It is a surrogate in the ordinary sense.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- `AuditEvent.event_type` — one of the twenty-one `AuditEventType`
    -- variants, in serde snake_case:
    --
    --   user_authenticated            authentication_failed
    --   session_created               session_revoked
    --   all_sessions_revoked          authenticator_enrolled
    --   authenticator_removed         identity_linked
    --   identity_unlinked             email_added
    --   email_removed                 profile_updated
    --   user_suspended                user_unsuspended
    --   user_role_changed             application_registered
    --   application_updated           application_secret_rotated
    --   application_access_granted    application_access_revoked
    --   security_version_bumped       (and the twenty-first)
    --
    -- ENFORCED AS A CLOSED SET, and the reason for enforcing it here is
    -- narrower than it first looks. `AuditEventType` has twenty-one variants
    -- today; if the CHECK listed them, adding a twenty-second event would need a
    -- migration that WIDENS the CHECK — which the forward-only rule explicitly
    -- permits and which is a normal, reviewable thing to do. So the closed set
    -- is not the interesting property.
    --
    -- The interesting property is the OPPOSITE: this column is a NAME, never a
    -- versioned wire type. `outbox_events.event_type` carries `.vN` because it
    -- crosses to a separately-promoted consumer. An audit row never crosses a
    -- deployment boundary, so it carries no version, and that asymmetry is
    -- deliberate — a `.vN` suffix here would imply a compatibility guarantee
    -- between an old and a new reader that nobody has designed for.
    event_type TEXT NOT NULL
              CHECK (
                    length(event_type) BETWEEN 1 AND 128
                    AND event_type = lower(event_type)
                    AND event_type GLOB '[a-z]*'
                    AND event_type NOT GLOB '*[^a-z_]*'
                    AND event_type NOT LIKE '% %'
              ),

    -- `AuditEvent.user_id` — who the event is ABOUT.
    --
    -- NULLABLE, and NULL is meaningful: `concerns_a_user()` returns false for
    -- `application_registered`, `application_updated` and
    -- `application_secret_rotated`, so those three events name an application
    -- or a system rather than a person. A NOT NULL column would make the
    -- application-lifecycle events unrepresentable, which is the most common way
    -- an audit log ends up quietly only auditing logins.
    --
    -- NO FOREIGN KEY, and this is the second table in this schema to make that
    -- choice deliberately (see `consents.actor_session_id` in 0010). An audit
    -- row is evidence. Deleting an account must not cascade into deleting the
    -- record that the account was suspended, and a GDPR erasure request against
    -- an account must not erase the record that an administrator suspended it.
    -- The right answer for an audit log is to retain the row with the user
    -- reference redacted to NULL, and that redaction is a deliberate
    -- application-layer act rather than a cascade nobody can audit.
    user_id TEXT REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT,

    -- `AuditEvent.actor_id` — who PERFORMED it.
    --
    -- SEPARATE FROM `user_id` ON PURPOSE, and `data-model.md` gives the reason in
    -- one sentence: "for a suspension they are different people. Collapsing them
    -- into one 'user id' is how an audit log becomes unable to answer 'who
    -- suspended me'."
    --
    -- NO FOREIGN KEY, for the reason given on `user_id` above.
    actor_id TEXT REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT,

    -- `AuditEvent.actor_session_id` — under which session, for attribution.
    --
    -- NO FOREIGN KEY, and here it is not a reticence but an argument.
    -- `QueryAudit` and `AdminAuditRow` both carry it, and an investigator
    -- reading a row wants to know which session was used. But a session is
    -- DISPOSABLE — it is revoked, it expires, and a privacy request may
    -- physically delete it — while the audit row is PERMANENT. A foreign key
    -- here would do one of three things, all wrong: cascade (erase the audit row
    -- when a session is purged), restrict (block session deletion because an
    -- audit row mentions it), or set null (lose exactly the attribution the
    -- column exists for, silently, at the moment someone purges sessions).
    --
    -- The `ON DELETE SET NULL` on the two columns above is the opposite choice
    -- and is right for a different reason: there, redacting the reference is the
    -- correct erasure behaviour. Here, retaining a dangling session id is
    -- strictly better than losing the fact that a session did something.
    --
    -- NOT NULLABLE-DECLARED, i.e. NULL is legal, because a system-initiated
    -- action has no session: a dispatcher-driven revocation, a scheduled sweep, a
    -- migration. `AuditEvent.actor_session_id` is an `Option` in the domain for
    -- the same reason.
    actor_session_id TEXT CHECK (actor_session_id IS NULL OR length(actor_session_id) BETWEEN 1 AND 64),

    -- `AuditEvent.occurred_at_ms` — when it happened, integer milliseconds since
    -- the epoch.
    --
    -- SET BY THE PRODUCER, and this table has the same no-DEFAULT rule the
    -- outbox has, for the same reason: a batched writer that lets the database
    -- stamp "now" produces an audit trail that is wrong about ordering, and an
    -- audit trail wrong about ordering cannot answer "what did the operator do
    -- after they read my profile".
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),

    -- `AuditEvent.request_id` — ties the event to a log line.
    --
    -- THE WHOLE POINT OF THE COLUMN is the join from a database row to whatever
    -- the Worker logged for the same request, and it is nullable because a
    -- scheduled job has no inbound request. Bounded at 128 bytes so a caller
    -- cannot turn a request trace into a megabyte of storage per event.
    --
    -- It is NOT a foreign key and NOT unique: one request can legitimately
    -- produce several audit events (a role change writes a role-change event and
    -- a security-version-bumped event), and the log line it points at is in the
    -- Worker's log, not in this database.
    request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),

    -- `AuditEvent.metadata` — JSON object, `BTreeMap<String, String>`, stored as
    -- TEXT.
    --
    -- STRING-VALUED, NOT ARBITRARY JSON, and `data-model.md` calls this "a
    -- constraint rather than an accident: a string-valued map serialises
    -- deterministically, so two runs of the same operation produce byte-identical
    -- metadata, and a diff of two audit rows is meaningful." A JSON object with
    -- arbitrary values would serialise its keys in whatever order the producing
    -- map happened to have, and two identical operations would produce two
    -- rows that do not compare equal — which is how an audit log quietly stops
    -- being diffable.
    --
    -- THE COLLECTION IS ENFORCED AT THE WRITER, NOT HERE, because a SQLite
    -- CHECK cannot verify that every value in a JSON document is a string
    -- without JSON1. `WriteAuditEvent` is the boundary and it is `SCAFFOLDED`,
    -- not written; until it is, this column can hold anything a caller puts in
    -- it. That is stated rather than pretended away, and the constraint belongs
    -- to the code that will own the column.
    --
    -- WHAT MUST NEVER GO IN HERE is stated next to the column instead of in a
    -- policy document nobody reads: no password, no TOTP seed, no recovery code,
    -- no client secret, no session token, no full email address. The reason is
    -- not that `metadata` is secret — it is not, it is shown to administrators —
    -- but that an audit table with a free-text blob is read by people who did not
    -- write it, and a credential that reaches one is a credential that has been
    -- in a screenshot. `AdminAuditRow`'s field is named "Already-redacted
    -- detail", which makes the obligation a writer's rather than a reader's.
    metadata TEXT NOT NULL DEFAULT '{}'
            CHECK (length(metadata) BETWEEN 2 AND 16384),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    --
    -- FOR AN APPEND-ONLY TABLE THESE ARE INERT. `created_at_ms` equals
    -- `occurred_at_ms` on the insert and `updated_at_ms` never moves, because
    -- nothing updates the row. They are here to satisfy the repository-wide
    -- convention that every table carries the pair, and this comment is the
    -- admission that on this table the convention carries no information. That
    -- is a better outcome than omitting them and having a tool that requires the
    -- pair flag every audit query, and it is better than leaving a reader to
    -- guess whether the absence was an oversight.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: "everything about this user", newest first. `QueryAudit { user_id }`
-- with `since_ms` and pagination is the incident-review query, and it is named
-- in data-model.md's required-index table as
-- `audit_events (user_id, occurred_at_ms)`.
--
-- Leading with user_id puts one account's entire history contiguous; carrying
-- occurred_at_ms makes the ORDER BY and the `since_ms` range predicate the same
-- index walk, so a two-year-old event and a two-minute-old event are both found
-- by the same seek.
CREATE INDEX IF NOT EXISTS ix_audit_events_user_occurred
    ON audit_events (user_id, occurred_at_ms);

-- INDEX 2: `is_administrative()` queries. Named in data-model.md as
-- `audit_events (event_type, occurred_at_ms)`, and the reason it exists is that
-- "show me every administrative action" is a question an auditor asks on a
-- schedule rather than on an incident, so it needs to be cheap enough that
-- nobody is tempted to narrow it to "the last few".
--
-- Seven of the twenty-one event types are administrative — `user_suspended`,
-- `user_unsuspended`, `user_role_changed`, `all_sessions_revoked`,
-- `application_registered`, `application_updated`,
-- `application_secret_rotated` — and the index serves all seven by leading with
-- event_type, in occurred_at_ms order within each.
CREATE INDEX IF NOT EXISTS ix_audit_events_type_occurred
    ON audit_events (event_type, occurred_at_ms);

-- INDEX 3: "everything this actor did", newest first. `QueryAudit.actor_id` is
-- a separate filter from `user_id` and it is the question "what has this
-- administrator been doing?", which is the other half of an access review.
--
-- This index is NOT in data-model.md's required-index table. It is here because
-- `QueryAudit` has the field and an incident query that falls back to a scan is
-- an incident query somebody narrows until it is fast and no longer complete.
CREATE INDEX IF NOT EXISTS ix_audit_events_actor_occurred
    ON audit_events (actor_id, occurred_at_ms);

-- NO INDEX on request_id, deliberately, and this is the one that most deserves
-- its comment, because it is the index an engineer reaches for first.
--
-- `request_id` exists to join an audit row to a log line. That join happens
-- from the LOG SIDE: an operator has a log line, has the request id, and types
-- it into a search. In that direction the query is `WHERE request_id = ?`,
-- which a table scan can serve — at the cost of scanning the whole table.
--
-- A full scan of an unbounded append-only audit log is not acceptable forever,
-- and when it stops being acceptable the right answer is NOT this index. It is
-- retention: `identity.audit.archive.v1` exists as a constructor for exactly
-- this, and a bounded hot table plus an index on `request_id` beats an unbounded
-- table with or without one. So this schema records the decision — no index now,
-- retention and then an index later — and names the migration that would add
-- it as a pure CREATE INDEX, which the forward-only rule permits at any time
-- because no existing Worker version's correctness depends on it.
--
-- The cost of NOT having it today, stated plainly: the by-request-id lookup is
-- O(rows). It is acceptable while the table is small and it will stop being
-- acceptable, and it is listed in database/README.md under "What is deferred".
--
-- NO INDEX on occurred_at_ms alone. Every time-ordered query in this schema
-- filters on user_id, actor_id or event_type first — "the twenty most recent
-- events" with no other filter is not a question anything asks, and an
-- admin console that offers it is offering an unbounded read of the entire
-- audit history to anyone who can click.
--
-- NO INDEX on metadata. Same reason as every other JSON column in this schema:
-- a B-tree over a document is a B-tree over the document.

-- ===========================================================================
-- APPEND-ONLY, and the three things that are true about that
-- ===========================================================================
--
-- 1. THERE IS NO UPDATE PATH AND NO DELETE PATH, and there is no
--    `identity-domain` or `identity-application` operation that would produce
--    one. `data-model.md` says exactly this. It is an application-layer
--    property, and the one that actually matters.
--
-- 2. THE DATABASE DOES NOT ENFORCE IT. A CHECK constraint cannot forbid an
--    UPDATE — SQLite has no such constraint, and D1's migration model has no
--    trigger story worth relying on (database/README.md). A trigger per table
--    raising on UPDATE and DELETE would be the mechanism, and it is declined for
--    the same reason the "last factor" rule in 0006 is declined here: a trigger
--    that breaks the moment the table is ALTERed is a worse dependency than a
--    documented obligation. Stated rather than faked.
--
-- 3. THE ONE EXCEPTION IS DELETION, and it is deliberate. See
--    `ON DELETE SET NULL` on `user_id` and `actor_id`: an erasure request
--    redacts the reference and keeps the row. An audit log whose rows can
--    vanish is not an audit log; an audit log that retains a person's id after
--    they asked for it to be forgotten is a different failure, and the
--    resolution here is that the SECOND failure is handled by a deliberate,
--    visible, application-layer redaction rather than by accident.
--
-- ===========================================================================
-- THE TRANSACTION RULE, restated because this table is where it bites
-- ===========================================================================
--
-- `WriteAuditEvent`'s doc is unambiguous: the write "must NOT open its own
-- transaction". An audit event and the state change it describes must be in the
-- SAME transaction, or one of them exists without the other:
--
--   * the change commits and the audit row does not -> an administrator
--     suspended somebody and there is no record that it happened;
--   * the audit row commits and the change does not -> an audit trail that
--     reports actions nobody took.
--
-- The second is the worse one and it is the one a naive "log it after" produces.
-- Neither is detectable by reading this table.
--
-- That is also why the outbox exists in the same transaction (`WriteAuditEvent`
-- and the outbox insert are both written by the command handler, per
-- `event-model.md`'s sequence diagram), and it is why `identity-jobs` is barred
-- from writing here at all: a queue consumer cannot join the transaction that
-- committed the fact it was told about. `identity.audit.archive.v1` COPIES
-- settled rows to cold storage and does not author them.

-- SECURITY: what an attacker gets from this table.
--
-- READ is the interesting direction, and this is the only table in the schema
-- where a read is a reconnaissance gift rather than a credential:
--
--   - a complete, dated, per-account history of every security-relevant change:
--     when each factor was enrolled, when each session was created and revoked,
--     when each address was added, when the security version was last bumped.
--     That is a target's security-posture timeline, and every field in it is
--     exactly the field an attacker wants to know before choosing a method. A
--     recovery code enrolled and never used (`authenticator_removed` absent,
--     `authenticator_enrolled` present, nothing since) is the single most
--     actionable inference this table supports.
--   - `request_id` joins it to Worker logs, which widens the read from the
--     database to whatever else those logs contain.
--   - `metadata` is a free-text blob written by whoever wrote the event, so its
--     redaction quality is exactly the quality of that caller. One caller that
--     puts an email address in metadata raises the exposure of every row.
--
-- WRITE is the direction that matters for integrity rather than for access:
-- an audit row written by an attacker is a fabricated alibi, and a fabricated
-- alibi is only useful if the attacker can also suppress the real row — which
-- they cannot, because nothing deletes. The control is constraint §2: Identity
-- D1 is reached by the Identity Worker and nothing else, and every write to this
-- table is an `identity-application` command that writes its own state change
-- alongside it.