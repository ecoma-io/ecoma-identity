-- ===========================================================================
-- 0010_consents.sql
--
-- WHAT THIS ADDS: `consents` — the recorded history of what a user was shown
-- on the authorisation screen and when they agreed to it.
--
-- WHY THIS IS A SEPARATE TABLE FROM application_grants (0009), which is a real
-- design decision and not a duplicate:
--
--   application_grants  CURRENT standing. One row per (user, application),
--                       updated in place when scopes widen. It answers "may I
--                       skip the consent screen for this client today?" and it
--                       is read on every authorisation request.
--
--   consents            HISTORY. Append-only. One row per consent interaction,
--                       never updated. It answers "what did this person agree
--                       to, when, and after being shown what?" and it is read
--                       by nobody on a hot path, ever.
--
-- Merging them would make the first question an append and the second an
-- update, and an audit trail that is updated in place is not an audit trail.
--
-- BACKWARD-COMPATIBILITY: additive only. This file CREATEs one table and two
-- indexes, adds no column to any existing table, and is readable by no version
-- of the code that predates it. Full rule: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS consents (
    -- Surrogate key. Fresh UUID, and deliberately NOT the same value as the
    -- session or the request: a consent is its own fact with its own lifetime,
    -- and tying its id to a request id would make it impossible to record a
    -- consent granted by any flow that has no request (a future one).
    id      TEXT    PRIMARY KEY NOT NULL,

    -- The user who consented.
    user_id TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- The client the consent was given to.
    application_id TEXT NOT NULL
        REFERENCES applications (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- The scopes the user was SHOWN, as a JSON array.
    --
    -- Both "shown" and "granted" are stored, and the difference between them is
    -- the reason this table is not just the grant row again. `Application::
    -- granted_scopes` returns the intersection of what was requested and what
    -- the client registered for. A user can therefore be shown a scope list and
    -- agree to a smaller one without the UI ever having to explain why — and the
    -- record of what they were shown is what makes a later "I never agreed to
    -- that email address" question answerable.
    requested_scopes TEXT NOT NULL CHECK (length(requested_scopes) BETWEEN 2 AND 4096),

    -- The scopes the user actually agreed to, as a JSON array.
    --
    -- A SUBSET of `requested_scopes`. The database cannot check that: it would
    -- have to parse two JSON arrays, and it says so here rather than pretending
    -- a CHECK exists. The rule is enforced where the intersection is computed,
    -- in `identity-domain`'s `Application`.
    granted_scopes TEXT NOT NULL CHECK (length(granted_scopes) BETWEEN 2 AND 4096),

    -- Did the user actively approve, or was the existing grant reused?
    --
    -- `consent_mode` is an INTEGER 0/1 rather than a text enum for a reason that
    -- is easy to state and worth stating: OIDC Core calls this the difference
    -- between `prompt=consent` yielding a fresh interaction and it being
    -- skipped, and this platform is deciding the vocabulary now. Growing the
    -- vocabulary later is a WIDENING of a CHECK, which the forward-only rule
    -- explicitly permits; adding a column or a table is likewise additive. What
    -- the forward-only rule forbids is narrowing this CHECK, which is exactly
    -- the mistake a later reader must not make when they discover the values
    -- were too few.
    --
    --   0  the existing application_grants row was reused; the user saw
    --      nothing, because they were not asked
    --   1  the user was shown the scope list and approved
    consent_mode INTEGER NOT NULL CHECK (consent_mode IN (0, 1)),

    -- The session the consent was given under, for attribution.
    --
    -- NO FOREIGN KEY, on purpose, and this is the one place in this schema
    -- where a nullable id deliberately does not reference its table. A consent
    -- is evidence. A session is disposable and gets revoked and deleted. A
    -- foreign key here would let a session purge erase a user's consent record,
    -- which is both a way to make a consent screen reappear unasked and a way
    -- to destroy evidence of an agreement. The same reasoning, for the same
    -- reason, keeps `audit_events.actor_session_id` unconstrained in 0014.
    actor_session_id TEXT CHECK (actor_session_id IS NULL OR length(actor_session_id) <= 64),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001). For a table like this one,
    -- `created_at_ms` IS the event time — there is no separate `occurred_at_ms`
    -- because a consent row is never backdated.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: "what has this person agreed to, in order?" — the consent history
-- on the account screen, and the question a privacy export answers.
--
-- Leads with user_id so the whole history for one account is contiguous, and
-- carries created_at_ms so the ordering does not need a sort.
CREATE INDEX IF NOT EXISTS ix_consents_user_created
    ON consents (user_id, created_at_ms);

-- INDEX 2: "which clients does this person have standing agreements with?" —
-- the consent screen's skip check.
--
-- This overlaps ix_consents_user_created exactly, and it is here anyway because
-- the query behind it is on the authorisation hot path while the other is not.
-- The authorisation screen's own source of truth is `application_grants`; this
-- index serves the "has there EVER been an interaction" question, which is a
-- different question and occasionally the one a UI needs first.
--
-- This is the one index in this file whose cost is paid on a request-path
-- table for a screen that is not yet written. It is a judgement, and the
-- judgement is reversible in the cheap direction: a later migration can drop it
-- once no canaried Worker version reads it.
CREATE INDEX IF NOT EXISTS ix_consents_user_application
    ON consents (user_id, application_id);

-- NO INDEX on application_id alone. "Which users consented to this client?" is
-- the same administrative enumeration 0009 declines to index, for the same
-- reason: it is a list of every person on the platform who talks to a given
-- client. It is served through the private service binding as a typed
-- `identity-application` command if an operator needs it, which is also where
-- it gets an audit event.

-- APPEND-ONLY, and the database is what makes that true.
--
-- There is no trigger forbidding an UPDATE or a DELETE, because D1's migration
-- model has no trigger story worth relying on (see database/README.md). The
-- guarantees are therefore:
--
--   1. No `identity-domain` or `identity-application` operation has an update or
--      delete path for this table. Widening a consent writes a NEW
--      application_grants row; it does not rewrite the record of the old
--      agreement. That is an application-layer property, and it is the one that
--      matters.
--   2. Nothing reads this table on a request path, so a wrong write to it cannot
--      change anyone's access. The blast radius of corrupting this table is a
--      wrong consent screen, not a wrong authorisation decision.
--
-- SECURITY: what an attacker gets from this table.
--
--   - A timestamped map of which account has granted which client access to
--     which scopes, and when. Read with users, it is a dated activity log: which
--     people signed a client into which third parties on which days. That is a
--     targeting profile, and it is the reason this table is never joined into an
--     administrative view.
--
--   - `actor_session_id` ties a consent to a session. A session identifier on
--     its own is not a credential — `Session`'s doc says "knowing it is not
--     enough" — but it narrows a later compromise, and it is the join key an
--     investigator would reach for. It is bounded at 64 bytes here only to
--     refuse a value that is obviously not a session id; the real control is
--     that sessions are HttpOnly cookies and this column never leaves a server
--     log boundary.