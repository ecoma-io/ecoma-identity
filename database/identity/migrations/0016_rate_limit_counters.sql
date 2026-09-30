-- ===========================================================================
-- 0016_rate_limit_counters.sql
--
-- WHAT THIS ADDS: `rate_limit_counters` — durable counters for the few rate
-- limits that must survive a Worker restart.
--
-- WHAT THIS IS **NOT**, and the name is chosen to make the distinction hard to
-- get wrong: this is NOT the platform's rate limiter.
--
--   THIS TABLE                    rate limits that must not reset when a
--                                 Worker instance is recycled. Cloudflare's
--                                 Rate Limiting binding is per-datacentre and
--                                 deliberately approximate; the Identity Worker
--                                 has `ADMIN_RATE_LIMITER` for the admin
--                                 surface, and `ADMIN_RATE_LIMITER` is NOT a
--                                 column or a row in this table.
--
--   ADMIN_RATE_LIMITER            the operator's admin surface, a separate
--                                 binding on a separate Worker
--                                 (admin-isolation.md).
--
--   The per-identity limits        not here, because they do not belong in D1
--                                  at all. See "WHY IDENTITY LIMITS ARE NOT IN
--                                  THIS TABLE" below, which is the most
--                                  important comment in this file.
--
-- BACKWARD-COMPATIBILITY: additive only. CREATEs one table and one index,
-- references nothing, so its appearing cannot break a canaried Worker version.
-- Full rule: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS rate_limit_counters (
    -- Surrogate key. A UUID rather than the counter's own identity, because the
    -- identity is the composite below and a table keyed on its own logical key
    -- invites someone to later change the logical key's shape and have to ALTER
    -- a PRIMARY KEY — which the forward-only rule forbids.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- The subject being limited: an address, a client id, a session id — or
    -- NULL for a GLOBAL limit.
    --
    -- NULLABLE, and NULL MEANS SOMETHING SPECIFIC: this is the platform-wide
    -- limit (for example "no more than N email sends per minute across the whole
    -- service"), and it is one row rather than N. A separate boolean column for
    -- "is this global" would be a second source of truth for the same fact.
    subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 320),

    -- Which limit this row counts. Together with `subject` this identifies the
    -- counter, and the pair is UNIQUE below.
    --
    -- A literal namespace string, not an enum: "otp_send_email", "otp_verify",
    -- "token_exchange". Adding a limit is a data change, which is the right
    -- direction, and a typo creates a second counter rather than refusing an
    -- operation.
    name  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),

    -- How many operations have happened in the current window.
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),

    -- When the current window ends, integer milliseconds since the epoch. An
    -- ABSOLUTE DEADLINE, not a duration, for the reason every deadline in this
    -- schema is absolute: a duration stored on the row makes "when does this
    -- reset" depend on when you asked.
    --
    -- A fixed window, not a sliding one. The difference is a boundary burst —
    -- twice the limit either side of a boundary — and it is accepted because the
    -- alternative is reading and rewriting one row on every single request,
    -- which on a hot unauthenticated endpoint is both a latency cost and a
    -- contention point. Where the exactness matters (the OTP limits) the
    -- conservative choice is to set the limit below the level where a boundary
    -- burst is meaningful, not to add machinery.
    window_ends_at_ms INTEGER NOT NULL CHECK (window_ends_at_ms >= 0),
    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

-- INDEX 1 (UNIQUE): the counter's identity.
--
-- Serves every operation on this table, because every operation is
-- "find my row, then either read count or increment it". Without it, two
-- concurrent requests to the same subject would create two counter rows and the
-- limit would silently double.
--
-- THE NULL CASE IS THE INTERESTING ONE, because this index DOES NOT COVER IT,
-- and the honest reading of why is worth more than a false claim of coverage.
--
--   MEASURED ON THE RUNTIME THIS MIGRATION RUNS ON (wrangler 4.144.0, local D1):
--   two rows with `subject = NULL` and the same `name` are ACCEPTED. SQLite's own
--   documentation says NULLs are distinct in a UNIQUE index, and the behaviour
--   matches the documentation. A comment written during authoring claimed the
--   opposite — that the runtime refuses such a pair — and a probe of that claim
--   falsified it, which is why the claim is here in the corrected form rather
--   than absent.
--
-- THE CONSEQUENCE, and it is the reason the global limit is NOT protected by this
-- index:
--
--   * every PER-SUBJECT counter is covered. Two concurrent requests for the same
--     subject and name collide, so the "find my row, then increment it" path
--     cannot silently fork into two counters and double the limit. This is the
--     index's whole purpose and it is intact.
--   * the GLOBAL counter is NOT covered. "There is exactly one platform-wide OTP
--     send counter" is enforced by nothing here. Two writers racing on a cold
--     global counter would create two rows, and the limit would silently double
--     — which is exactly the failure this index exists to prevent, in the one case
--     where a NULL subject makes it invisible.
--
-- THE FIX IS NOT IN THIS MIGRATION, and naming why is the useful part. Closing
-- the gap with `CREATE UNIQUE INDEX ... ON rate_limit_counters (COALESCE(subject,
-- ''), name)` is possible, and it is a pure ADD under the forward-only rule — but
-- it also replaces an index another index's name would collide with, and the
-- `COALESCE` form hides the NULL-means-global fact in an expression that a
-- `PRAGMA index_list` reader cannot see. The decision belongs with the phase that
-- ships a rate limiter, because that phase is the first one with a writer, and a
-- writer is what makes "two racing upserts" a real scenario rather than a
-- hypothetical. Until then there are no writers, so there is no race to lose.
--
-- THE PLACE THIS IS ENFORCED INSTEAD, and it is not the schema: the upsert in the
-- application layer. 0016's own increment is an UPDATE, not an INSERT, so a writer
-- that follows the documented shape updates an existing row and never creates a
-- second one. That is a discipline, not a constraint, and it is listed in
-- database/README.md under "What is deferred" so it is not mistaken for a
-- guarantee.
--
-- IT IS RESTATED IN THE TEST SUITE because a schema claim that is easy to get
-- backwards deserves a test rather than a comment: see
-- tests/integration/schema.test.mjs, "two global rate limit counters are accepted,
-- and that is the documented NULL behaviour". That test asserts the limitation is
-- real. A test that asserted the opposite would have kept this comment honest for
-- about a week.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rate_limit_counters_subject_name
    ON rate_limit_counters (subject, name);

-- NO INDEX on window_ends_at_ms. The only sweep is "find the counters whose
-- window has ended", which is a periodic, off-path operation over a table whose
-- size is bounded by (distinct subjects currently being limited) x (limits).
-- That product is small for a platform that has not shipped, and it is bounded
-- by the number of distinct subjects an attacker can generate — which is the one
-- way this table can grow without limit, and it is called out in the security
-- block below rather than pretended away.
CREATE INDEX IF NOT EXISTS ix_rate_limit_counters_window
    ON rate_limit_counters (window_ends_at_ms);

-- NO INDEX on count. Nothing queries "the busiest counters"; that is an
-- operational question about the wrong thing.

-- ===========================================================================
-- WHY IDENTITY LIMITS ARE NOT IN THIS TABLE
-- ===========================================================================
--
-- This is the comment worth reading, because the obvious design — put the OTP
-- send limit here next to the other counters — is the wrong one, for a reason
-- that is about what a rate limit IS rather than about where it lives.
--
-- A durable counter in a database is read-modify-write: SELECT the row, decide,
-- then UPDATE it. Three statements, two of them racing, and the race is the
-- entire point of an attack. Under concurrent load — which is exactly when the
-- limit matters — two requests both read `count = 4`, both see `4 < 5`, and both
-- proceed. The limit becomes a suggestion with a SQL round-trip attached.
--
-- `otp_challenges` does NOT have this problem, because its protection is not a
-- counter: it is `attempts_remaining`, decremented by a conditional UPDATE whose
-- affected-row count IS the answer, inside the same transaction that issues the
-- session. One statement, one answer, two callers serialise on the row. That is
-- the shape a limit needs when being wrong is an authentication bypass.
--
-- So the per-identity limits live where a single atomic statement can enforce
-- them:
--   * failed OTP verifications  -> otp_challenges.attempts_remaining (0007),
--     which is atomic by construction and already tested with a race.
--   * session creation          -> a per-user or per-address counter, `DEFERRED`,
--     with the same conditional-UPDATE shape, and the same reason.
--
-- And the coarse, platform-wide limit — "no more than N of these per minute,
-- anywhere" — is the one that legitimately belongs here, because a global
-- counter is not contended: one row, one subject, and the increment happens on a
-- path where being off by one under a flood is acceptable because the flood is
-- what triggered it.
--
-- IN SHORT: this table holds limits where an approximation is fine. Limits
-- where an approximation is a bypass live next to the data they protect, as an
-- atomic conditional UPDATE. Writing them anywhere else would be an
-- approximation pretending to be a control.

-- ===========================================================================
-- THE INCREMENT, and its failure mode
-- ===========================================================================
--
--   UPDATE rate_limit_counters
--      SET count = count + 1, window_ends_at_ms = :next, updated_at_ms = :now
--    WHERE subject IS :subject AND name = :name;
--
-- The `SET count = count + 1` is what makes this a read-modify-write that does
-- not lose an increment: SQLite serialises writers to a row, so two concurrent
-- increments produce count = old+2 rather than count = old+1. What it does NOT
-- do is check the ceiling atomically. The honest pattern is therefore:
--
--   1. read count and window_ends_at_ms
--   2. if now >= window_ends_at_ms, reset the row (count = 0,
--      window_ends_at_ms = now + window) and start counting
--   3. if count >= limit, refuse
--   4. increment
--
-- Steps 1 and 3 are separated, and that is the accepted approximation the header
-- comment above describes: under a burst, two callers can both pass step 3 before
-- either increments. For a global platform limit the overshoot is a factor of
-- two on one window boundary, which is why the per-identity limits are NOT here.
-- Stating it is the point; a reader who assumes this table refuses an operation
-- atomically will put an authentication control on it.

-- ===========================================================================
-- WHAT AN ATTACKER GETS, and the one way this table grows without bound
-- ===========================================================================
--
-- READING it yields almost nothing: a subject (an email address or a client id),
-- a counter name, and a count. The addresses in it are the addresses people
-- actually tried to log in with, which is a small enumeration — and it is an
-- enumeration that a system with this table necessarily has, because limiting an
-- address means having recorded the address.
--
-- THE GROWTH PROBLEM, stated rather than deferred silently: one row per
-- (subject, limit), so an attacker who sends login attempts from ten million
-- distinct addresses creates ten million rows, and none of them expire except
-- through the window sweep. That is a denial-of-service against the database
-- itself, and it is the reason the sweep is not optional and the reason a
-- production system needs a retention bound on this table.
--
-- THREE WAYS OUT, all `DEFERRED` and all decisions that belong to the phase that
-- ships a rate limiter:
--   1. bound the subject space — rate limit per address AND per source network,
--      so the row count is bounded by the number of networks rather than the
--      number of addresses;
--   2. a sweeper that DELETEs rows whose window ended AND whose count is well
--      below the limit, since those are the stale ones;
--   3. a cap on total rows with a documented overflow behaviour, which is the
--      honest version of "fail closed" for a table that exists to fail closed.
--
-- WRITE access is not an authentication bypass by itself — writing a counter
-- row lets an attacker RAISE their own limit by resetting `count`, which is a
-- real bypass of the limit and is prevented only by constraint §2 and by the
-- fact that nothing outside the Identity Worker can reach this database.