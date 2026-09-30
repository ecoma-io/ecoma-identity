-- ===========================================================================
-- 0012_nonces.sql
--
-- WHAT THIS ADDS: `nonces` — issued OpenID Connect nonces, bound to a session,
-- awaiting single consumption.
--
-- WHERE THE RUST PUTS THIS: `identity_security::tokens::NonceService`. Two
-- methods, and the table serves each one differently:
--
--   issue(&SessionId)         -> one row here, holding the nonce
--   consume(&SessionId, nonce) -> at most one row here claims it, or none does
--
-- THE CONSUME IS THE WHOLE POINT of the table, and the trait doc for `consume`
-- is what this schema is built around. It returns a `bool` rather than an error
-- "because 'was this valid' and 'tell me why not' are different needs and a
-- callback that has already been invalidated should not care why" — so the
-- answer to "is this nonce valid" must be a SINGLE FACT read atomically, not a
-- pair of statements whose answer could differ from their write.
--
-- BACKWARD-COMPATIBILITY: additive only. CREATEs one table and one index, adds
-- no column to any existing table, and references `users` without altering it.
-- Full rule: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS nonces (
    -- The nonce itself as the PRIMARY KEY, not a surrogate key.
    --
    -- This is the one table in the schema where the natural key is the primary
    -- key, and the reason is the shape of the query. `consume(session_id, nonce)`
    -- looks the value up directly; with a surrogate it would be a lookup, a
    -- delete, and a second lookup to report "was it valid", which is three
    -- statements and three chances to disagree with itself.
    --
    -- STORED IN THE CLEAR, which is correct and worth justifying, because a
    -- nonce is not a bearer credential in the way a password or a TOTP seed
    -- is. A nonce's security property is UNPREDICTABILITY and SINGLE USE, not
    -- secrecy of a value an attacker could otherwise replay:
    --
    --   * its unpredictability is a property of how it was generated, not of
    --     this table — 128+ bits from `crypto.getRandomValues`, and constraint
    --     §25 means no `Math.random`;
    --   * its single-use property is exactly what the `consumed_at` column and
    --     the conditional UPDATE below enforce;
    --   * it travels to the client inside an ID token, and it comes back inside
    --     an id_token hint, so it is not a value an attacker holds and replays
    --     for its own benefit — an attacker who learns a nonce from a log or a
    --     URL bar can consume it, but consuming it DENIES the legitimate browser
    --     its session, which is a denial of service against themselves.
    --
    -- Hashed storage would be defensible too. It would also mean the consume is
    -- two operations — hash, then conditional delete — instead of one, and this
    -- table is on the authentication hot path. When the choice is between two
    -- defensible designs, this schema picks the one that keeps the invariant in
    -- a single statement and says why.
    nonce TEXT PRIMARY KEY NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),

    -- The browser session this nonce was issued to.
    --
    -- A nonce bound to a session is what makes it a CSRF filter and not a
    -- bearer token: `consume` takes the session id as well as the nonce, so
    -- presenting a nonce from another session's flow fails.
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 64),

    -- Has it been consumed?
    --
    -- The SAME single-statement conditional update as `otp_challenges.consumed_at`
    -- (0007) and `pkce_challenges.consumed_at` (0011), for the same reason and
    -- with the same SQL:
    --
    --   UPDATE nonces SET consumed_at = :now
    --    WHERE nonce = :nonce AND session_id = :session_id AND consumed_at IS NULL
    --   RETURNING nonce;
    --
    -- One row returned is the first consumption and the caller proceeds. Zero
    -- rows means a second consumption, and the caller returns `Ok(false)` —
    -- "Returning rather than erroring", per the trait doc. The zero-row case is
    -- the ordinary case during a redeploy, not an incident.
    --
    -- DELETING ON CONSUMPTION LOSES THE RACE for the same reason 0007 spells
    -- out: two callers both SELECT, both match, both proceed, and the second
    -- DELETE affects zero rows that nobody inspects. Two replay protections in
    -- one schema, the same mistake waiting to be made twice, so the reasoning is
    -- written out in full in 0007 rather than as a cross-reference here.
    consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

-- NO INDEX BEYOND THE PRIMARY KEY, and this is the one place in the schema
-- where an absent index is the design.
--
-- Every read is `WHERE nonce = ?`, served by the primary-key B-tree. Every write
-- is a conditional UPDATE on that same key. The sweep for stale nonces is
-- `WHERE consumed_at IS NULL AND created_at_ms < ?` — a table scan — and that
-- scan is accepted on purpose:
--
--   * the rows are short-lived (a nonce outlives one authentication flow), so
--     the live set is small;
--   * the sweep runs off the request path;
--   * an index on `created_at_ms` would have to be PARTIAL
--     (WHERE consumed_at IS NULL) to be worth anything, because consumed rows
--     are the majority by volume and never swept again — and a partial index
--     whose only purpose is to speed up a periodic sweep on a small table is
--     write amplification paid on every issue for no real latency win.
--
-- If the live set ever grows large enough for the scan to matter, the right
-- answer is a TTL sweep that DELETEs consumed rows, after which a plain
-- `(created_at_ms)` index becomes worth having. Adding it later is a pure ADD.

-- NO INDEX on session_id. No query asks "every nonce issued to this session";
-- `consume` already has the nonce and compares the session id as a predicate on
-- the row it found. An index here would speed up a query nobody writes, at the
-- cost of a second B-tree on every issue.

-- NO FOREIGN KEY from session_id to sessions.id, and this is a deliberate
-- departure from every other id-bearing column in this schema.
--
-- The reason is the same one that keeps `consents.actor_session_id` and
-- `audit_events.actor_session_id` unconstrained: a session is disposable, and a
-- foreign key would let a session purge cascade into rows that are evidence of
-- something having been issued. Deleting a session must not erase the record
-- that a nonce was bound to it — and equally, deleting a session must not be
-- blocked by a nonce row, which is a deadlock an FK would create.
--
-- The cost of the decision: an orphaned nonce row outlives its session. That is
-- harmless, because `consume` requires the session id to match and a session that
-- no longer exists has no id any caller can present.

-- NO `expires_at_ms` COLUMN, and that is worth naming because its absence looks
-- like an oversight next to every other table here.
--
-- A nonce does not need a deadline. It is consumed within one authentication
-- flow or it is abandoned, and both outcomes are handled correctly without a
-- clock: a consumed nonce stays consumed forever, and an abandoned nonce is
-- never consumed by anyone because no browser ever completes the flow that
-- carries it. The TTL sweep in the comment above is about keeping the table
-- small, not about security — a nonce that has not been consumed after a week
-- is not exploitable, because exploiting it requires being the party the
-- browser hands the resulting ID token to.
--
-- IF a deadline is added later, that is a widening: `ALTER TABLE nonces ADD
-- COLUMN expires_at_ms INTEGER` is nullable and therefore backward-compatible
-- with every canaried Worker version, exactly as the forward-only rule promises.

-- SECURITY: what an attacker gets from this table.
--
--   - `session_id` in bulk is a list of live sessions, and a session id is not a
--     credential on its own — `Session`'s doc is explicit that "knowing it is
--     not enough" — but it is half of one and it narrows an attack from
--     "every session on the platform" to "these sessions", which is the
--     difference between a scan and a targeted attempt.
--   - The nonces themselves are useless without the session they are bound to,
--     so a database read does not yield a replay. The threat that remains is a
--     denial of service: consuming a browser's nonce early denies that browser
--     its own authentication, which an attacker does to themselves first.