-- ===========================================================================
-- 0009_application_grants.sql
--
-- WHAT THIS ADDS: `application_grants` — an account's standing grant to an
-- application, so the authorisation screen can ask "did this person already say
-- yes to this client?" and the consent screen can ask "which of the requested
-- scopes are not covered yet?"
--
-- BACKWARD-COMPATIBILITY: additive only. This file CREATEs one table and two
-- indexes. It references `users` and `applications`, both created by earlier
-- migrations, and adds nothing to either, so a Worker version from before this
-- file ran is unaffected by it: it never mentions this table and a table
-- appearing is not something it can be broken by. Full rule: 0001.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS application_grants (
    -- Surrogate key. A fresh UUID rather than (application_id, user_id) as the
    -- primary key, because the pair is ALSO the unique constraint and having
    -- both is a two-index write for one invariant. See ix below.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- `GrantApplicationAccess`'s subject. The user who granted access.
    --
    -- ON DELETE CASCADE: a deleted account holds no grants, and an orphaned
    -- grant would re-authorise the application the moment the same
    -- (user_id, application_id) pair recurred. ON UPDATE RESTRICT.
    user_id TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- The application access was granted to.
    --
    -- ON DELETE CASCADE: a retired OR deleted application must not keep a grant
    -- row, and it is worth being precise that this fires for RETIREMENT too if
    -- retirement is implemented as a delete. It should not be: retirement is a
    -- status (`ApplicationStatus::Retired`) precisely so the client_id can never
    -- be reissued to a different owner. A cascade on a status change does not
    -- exist, so a retired application's grants survive — and that is the
    -- intended behaviour, because "this person granted Scopes to a client that
    -- no longer exists" is a fact an audit wants to keep.
    application_id TEXT NOT NULL
        REFERENCES applications (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- The scopes the user actually agreed to, as a JSON array of strings.
    --
    -- WHY STORED RATHER THAN RECOMPUTED: `Application::granted_scopes` returns
    -- the INTERSECTION of requested and registered scopes, not an error, "because
    -- a client asking optimistically for more than it registered for should get
    -- the narrower grant rather than a hard failure". This column is that
    -- intersection as it was agreed at the time of consent. If it were derived
    -- from `applications.allowed_scopes` on every read, narrowing a client's
    -- registration would retroactively shrink what a user consented to without
    -- them ever being asked — which is a consent the user did not give, and a
    -- consent that silently shrinks is how a client breaks in a way nobody can
    -- reproduce.
    --
    -- The intersection rule still applies at the moment of granting; this column
    -- records the result of applying it.
    scopes TEXT NOT NULL CHECK (length(scopes) BETWEEN 2 AND 4096),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1 (UNIQUE): one grant per (user, application).
--
-- This is the same class of rule as ux_user_identities_provider_subject in 0004
-- and ux_application_secrets_hash in 0008: the application layer must be able to
-- write "has this person already granted this client access?" as a lookup and
-- get an unambiguous answer. Without it, a double-consented account has two
-- rows with different scope sets and the authorisation screen has to decide
-- which one wins — a question whose wrong answer is a scope the user never
-- granted.
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_grants_user_application
    ON application_grants (user_id, application_id);

-- INDEX 2: "which applications has this person granted access to?" — the
-- account screen's connected-apps list, in grant order.
--
-- Needed because index #1 leads with user_id and so serves this by prefix, BUT
-- only as a scan of that user's grants. There are at most a handful per user,
-- which is why this index is listed as a judgement rather than a necessity: it
-- is here because the connected-apps screen orders by grant time, and the
-- duplicate rows in an index are cheap next to re-sorting them in the Worker.
-- If the row count per user grows, this is the index that stops paying and can
-- be dropped by a future migration — dropping an index is additive-compatible
-- only after no canaried Worker version queries it, which is the whole reason
-- the forward-only rule is about the SCHEMA and not only about data.
CREATE INDEX IF NOT EXISTS ix_application_grants_user_created
    ON application_grants (user_id, created_at_ms);

-- NO INDEX on application_id alone. The reverse query — "which users have
-- granted this application access?" — is an administrative enumeration that
-- `GrantApplicationAccess`'s operators would want and that an attacker with read
-- access wants more: it is a list of every account on the platform that talks to
-- a particular client. `data-model.md` does not name it as a required index, and
-- it is not added. The admin console's equivalent question is served through the
-- private service binding as a typed `identity-application` command, which is
-- where an operator-facing enumeration is supposed to live.

-- SECURITY: what an attacker gets from this table.
--
--   - The (user_id, application_id) pairs are a social graph edge: "these
--     people use these apps". Read-only, it is the shape of a tracking profile
--     keyed on a stable identifier, which is why `user_identities.subject` is
--     explicitly absent from every administrative view (see
--     `AccountIdentity`) while this row is present in the account's own view.
--   - `scopes` says how much of a profile each of those people has handed over
--     (email? profile?), which narrows the phishing target.
--
--   Nothing here is a credential and nothing here authenticates anything. A
--   grant is not an access token: it records a past agreement, and every
--   subsequent token request still runs the full authorisation check. The
--   property that makes this safe is that a grant can only be READ by the code
--   that is about to decide, and a grant written by anyone other than the user
--   through a `GrantApplicationAccess` command is an application-layer bug, not
--   a database bug.