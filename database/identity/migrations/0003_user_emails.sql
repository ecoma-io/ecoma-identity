-- ===========================================================================
-- 0003_user_emails.sql
--
-- WHAT THIS IS: the email addresses on an account, each with its own
-- verification state and a primary flag.
--
-- WHAT THIS IS NOT: not a string column on `users`. The separation is what
-- makes "which address proved this account", "which address is the sign-in
-- address" and "which address may we send a reset to" three different
-- questions instead of one ambiguous boolean.
--
-- WHERE THE RUST PUTS THIS: `identity-domain` has NO `UserEmail` type. The
-- shape exists as `identity_application::accounts::AccountEmail`
-- (`{ address, verified, primary }`), a *view* type assembled by the
-- application layer. That is why this table stores `verified_at_ms` rather than
-- `verified`: the view's `verified` is derived (`verified_at_ms IS NOT NULL`),
-- and `email.rs` in the domain says so in as many words — "A `Verified` flag
-- does not live here. Verification is a fact about *when* a proof was
-- presented, and it belongs to the row that stores the address."
--
-- COLUMN NAMING RULE: columns match the serde field names of the types they
-- back where such a type exists (`AccountEmail.address`, `.primary`). Where no
-- Rust type owns the column yet, the column is named after the domain concept
-- and the comment says so.
--
-- BACKWARD-COMPATIBILITY RULE: additive only, no DROP / RENAME / type change /
-- narrowing. No database rollback; the previous Worker version is still
-- serving traffic during a canary. Full statement: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS user_emails (
    -- Surrogate key. UUID text, matching every other key in this schema.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- The owning account. ON DELETE CASCADE, because deleting an account must
    -- not leave its addresses behind: an orphaned verified address is a
    -- delivery target for someone else's reset mail. ON UPDATE RESTRICT, because
    -- a user id is never rewritten (see 0002's note on not renaming).
    user_id TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- `AccountEmail.address` — `EmailAddress::as_str()`.
    --
    -- STORED LOWERCASE. `EmailAddress::parse` lowercases the whole address on
    -- the way in, so the column only ever sees lowercase and the database can
    -- rely on it. That is what makes the UNIQUE index below correct: without
    -- folding, `Ada@example.com` and `ada@example.com` would be two accounts.
    -- The domain comment acknowledges this is a simplification — the local part
    -- is technically case-sensitive — and states the reason: treating it as
    -- case-insensitive is what every mainstream provider does, and the
    -- alternative invites two accounts differing only in local-part case.
    --
    -- 320 bytes is `EmailAddress::MAX_LEN`, the RFC 5321 path limit, and the
    -- comment in `email.rs` says the ceiling exists "because a column that can
    -- hold it must also hold it". That is this line.
    address     TEXT    NOT NULL CHECK (length(address) BETWEEN 3 AND 320),

    -- When the address was proven, as integer milliseconds since the epoch.
    --
    -- NULL means "not verified", and it is the ONLY definition of unverified.
    -- There is no separate `verified` boolean to fall out of sync with it.
    --
    -- The time is stored, not just the fact, because "when was this proven" is
    -- what an incident review asks and a boolean cannot answer it.
    verified_at_ms INTEGER,

    -- `AccountEmail.primary` — is this the account's sign-in address. The
    -- domain field is `primary`; the column is `is_primary` because PRIMARY is
    -- a reserved SQL keyword and an unquoted `primary INTEGER` is a syntax
    -- error in SQLite (verified — see the integration test
    -- `an_unquoted_primary_column_is_a_syntax_error`). The prefix is the price
    -- of not quoting the identifier at every call site, and it is what
    -- docs/architecture/data-model.md specifies. This one column is the only
    -- place in the schema where a column name departs from its serde field
    -- name, so the mapping is stated here and nowhere else assumes it.
    --
    -- INTEGER 0/1 rather than BOOLEAN: SQLite has no boolean type, every other
    -- boolean in this schema is 0/1, and CHECK (is_primary IN (0,1)) refuses
    -- anything else.
    --
    -- Exactly one per account, enforced by a partial unique index below rather
    -- than by this type — `AccountEmail`'s own doc comment says so.
    --
    -- THE CROSS-COLUMN CHECK AT THE BOTTOM is the second half of the rule and
    -- the half a partial index cannot express: only a VERIFIED address may be
    -- primary. A primary unverified address would mean "sign in as this
    -- address", which is precisely the account-takeover shape
    -- `UserInfoResponse::email_is_safely_usable` exists to refuse.
    is_primary    INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the epoch.
    created_at_ms   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    -- "primary = 1 implies verified_at_ms IS NOT NULL", as one constraint.
    --
    -- Written as an OR rather than an implication because SQLite CHECK
    -- constraints must be expressions and there is no implication operator
    -- that reads well here. The two branches:
    --
    --   (is_primary = 1 AND verified_at_ms IS NOT NULL)  -> primary, so it is proven
    --   (is_primary = 0)                              -> not primary, anything goes
    --
    -- Note this CONSTRAINS, it does not GUARANTEE existence: it is possible to
    -- store an account with zero primary addresses, which is what a
    -- pending_verification account looks like. That is correct. The "exactly
    -- one" half of the rule lives in ix_user_emails_one_primary below, and it
    -- is a uniqueness constraint rather than an existence one precisely because
    -- enforcing "exactly one" would require a deferred trigger, and triggers
    -- are not available in D1's migration model in a way worth the cost.
    CHECK ((is_primary = 1 AND verified_at_ms IS NOT NULL) OR is_primary = 0)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: "is this address already on the platform?"
--
-- Serves the signup and the login path: look up an account by address before
-- doing anything else. It is a plain UNIQUE index rather than a partial one
-- because the answer to "who owns this address" must be one account, full
-- stop, regardless of verification state. Two accounts holding the same
-- address is an account-takeover shape no verification state can excuse.
--
-- This is also the backstop `AccountEmail`'s doc comment alludes to when it
-- says the "exactly one primary" rule is "enforced by a partial unique index,
-- not by this type" — that index is #2 below.
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_emails_address
    ON user_emails (address);

-- INDEX 2: one primary address per account.
--
-- A PARTIAL unique index over `(is_primary)` WHERE is_primary = 1. SQLite
-- evaluates the WHERE first, so only primary rows are in the index at all,
-- which is what makes this cheap: the overwhelmingly common case is that the
-- index holds exactly one row per account.
--
-- WHY A PARTIAL INDEX rather than a UNIQUE(user_id, is_primary): the composite
-- version would put EVERY address row into the index and then refuse a second
-- unverified 0-row, i.e. it would enforce "at most one non-primary address" —
-- a bug, not a rule. The partial form says what it means: at most one row per
-- account where is_primary = 1.
--
-- Two accounts cannot share a primary address as well, because
-- ux_user_emails_address already forbids sharing the address at all.
CREATE UNIQUE INDEX IF NOT EXISTS ix_user_emails_one_primary
    ON user_emails (user_id) WHERE is_primary = 1;

-- INDEX 3: the account settings screen, and the "revoke this address" lookup.
--
-- Serves `SELECT ... FROM user_emails WHERE user_id = ? ORDER BY is_primary
-- DESC, created_at_ms` — the list a signed-in user sees, with the sign-in address
-- first. Indexing (user_id, is_primary) puts the primary row adjacent to the
-- account and leaves the rest in insertion order.
CREATE INDEX IF NOT EXISTS ix_user_emails_user_is_primary
    ON user_emails (user_id, is_primary);

-- INDEX 4: the periodic sweep for unverified addresses to expire.
--
-- A cleanup job finds addresses that were never proven and are older than a
-- threshold. Without this it scans every address row ever inserted.
CREATE INDEX IF NOT EXISTS ix_user_emails_unverified
    ON user_emails (created_at_ms) WHERE verified_at_ms IS NULL;

-- NO INDEX on (user_id) alone. ix_user_emails_user_is_primary leads with user_id,
-- so every lookup ix_user_emails_user_is_primary would serve is already served by
-- it, including prefix scans. A second index on the same leading column would
-- be a strict subset of the first and cost a second B-tree to maintain.

-- SECURITY: what an attacker gets from this table.
--
-- This table is the one that gets an attacker INTO an account, and the whole
-- invariant rests on two columns:
--
--   address       Readable -> the ability to send a reset or a verification
--                 mail to a person at will (harassment, phishing with a real
--                 sender, an account-existence oracle across the platform).
--
--   verified_at_ms   Readable -> the ability to know WHICH addresses are proven,
--                 which is the difference between attacking an address someone
--                 owns and attacking an address a real person is known to
--                 read. Combined with users.status, an unverified address on
--                 an active account is the highest-value row in the platform.
--
-- And in reverse: WRITE access to this table is account takeover. Setting
-- `is_primary = 1` on an address you control is enough to receive the platform's
-- resets for somebody else's account, provided the cross-column CHECK above has
-- been verified first — which is why it exists and why it is not deferrable.
-- ---------------------------------------------------------------------------
