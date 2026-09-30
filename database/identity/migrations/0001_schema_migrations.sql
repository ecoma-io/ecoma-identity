-- ===========================================================================
-- 0001_schema_migrations.sql
--
-- WHAT THIS IS: the Identity Worker's own record of which migrations have been
-- applied to this database. Created first, before any domain table.
--
-- WHAT THIS IS NOT: this is not a replacement for `wrangler d1 migrations`,
-- which keeps its own `d1_migrations` table. This table exists so the *Worker
-- itself* can answer "what schema version am I talking to?" without shelling
-- out to a migration tool it is not allowed to run. See the "Why this table
-- coexists with d1_migrations" note at the bottom.
--
-- BACKWARD-COMPATIBILITY RULE (applies to every file in this directory, this
-- one included):
--
--   Every migration is ADDITIVE ONLY. New tables, new nullable columns with
--   defaults, new indexes. Nothing else.
--
--   Specifically forbidden in this repository, permanently:
--     - DROP TABLE / DROP COLUMN / DROP INDEX
--     - ALTER TABLE ... RENAME, or RENAME COLUMN
--     - narrowing a column (tightening a CHECK, shortening a length bound,
--       adding a NOT NULL to a column that already holds rows)
--     - changing a column's type in place
--     - rewriting or reordering rows
--
--   WHY, and this is the whole reason the rule exists:
--
--   There is NO database rollback path in this platform (ADR-0011, and
--   founding constraint §21). Cloudflare Worker rollback promotes a
--   previously-uploaded *version id* of the code — it does not and cannot
--   restore a previous database. That means, for the entire duration of a
--   production canary, the OLD Worker version and the NEW Worker version are
--   both serving traffic against the SAME database.
--
--   The old Worker reads the schema as it understood it. So a migration that
--   removes or narrows anything will break the version that is still serving
--   half the traffic, mid-canary, with no way back other than a new migration
--   that undoes it by re-adding. This is not theoretical: the canary ladder is
--   smoke -> 1% -> 10% -> HUMAN -> 50% -> 100%.
--
--   So the rule is not stylistic. A non-additive migration is a deployment
--   that can strand the platform between two versions of its own code.
--
-- ROLLBACK STORY: there isn't one, and pretending otherwise is the mistake
-- this comment exists to prevent. The rollback story for migration N is a
-- forward migration N+1 that restores whatever shape N changed, deployed only
-- AFTER the Worker version that needed the old shape is no longer serving
-- traffic. For an additive migration, N+1 is usually "do nothing", because
-- additive changes are backwards-compatible by construction and the old code
-- ignores what it does not know about.
--
-- The failure mode this file's own design must avoid: if this table is created
-- and a later statement in the same migration fails, a half-migrated database
-- that claims a version it does not have would be worse than one that claims
-- nothing. D1 applies each migration file inside a transaction, so a failed
-- migration leaves this table untouched. Verified empirically, not assumed: a
-- probe migration containing a PRIMARY KEY conflict left only the table it had
-- already created and recorded NO version row. See database/README.md, "What
-- happens when a migration fails halfway".
-- ===========================================================================

-- WHY THE UNITS ARE DECLARED HERE, ONCE, FOR THE WHOLE SCHEMA
--
-- Every timestamp column in every table below is:
--
--   * an INTEGER, never a TEXT ISO-8601 string. One representation means one
--     comparison, one sort order, and no timezone parsing anywhere in the read
--     path. A TEXT timestamp is a comparison bug waiting for the first row
--     written by a host in a different timezone;
--   * MILLISECONDS since the Unix epoch, never seconds. `unixepoch()` returns
--     seconds; a column that defaults to seconds and a column whose name says
--     milliseconds must not be confused, and the name is the only thing that
--     catches it. Every Rust type that carries the same value calls it `*_ms`
--     (`Session::created_at_ms`, `AuditEvent::occurred_at_ms`) and every column
--     here now matches;
--   * suffixed `_ms` — INCLUDING the two generic row-timestamp columns. There
--     is no bare `created_at` or `updated_at` anywhere in this schema, and
--     there is deliberately no view layer to hide one behind;
--   * defaulted with `(unixepoch() * 1000)` rather than set by the application,
--     so a row that omits the column still gets a correct one. That makes the
--     default a backstop rather than the source of truth: an application that
--     computes its own timestamp must pass it explicitly.
--
-- There is no trigger maintaining `updated_at_ms`. `unixepoch()` is not
-- re-evaluated on UPDATE and no trigger exists to do it, so EVERY writer sets
-- `updated_at_ms` explicitly. That is a real obligation on application code
-- which does not exist yet, and it is listed in database/README.md under "What
-- is deferred" rather than left as a surprise for whoever writes the first
-- UPDATE.

CREATE TABLE IF NOT EXISTS schema_migrations (
    -- The migration's numeric prefix, e.g. 7 for 0007_*.sql. An INTEGER rather
    -- than the filename: filenames get reworded ("0007_add_sessions.sql" ->
    -- "0007_create_sessions.sql") and a ledger that keys on the filename then
    -- loses track of what has run. A number cannot be reworded.
    version     INTEGER PRIMARY KEY,

    -- The filename exactly as it appeared in database/identity/migrations/,
    -- for a human reading this row during an incident. Informational only;
    -- never joined against.
    name        TEXT    NOT NULL,

    -- The Git commit that introduced the migration. Lets an operator map a
    -- database to a code version, which is the question "is this version
    -- deployed here yet?" turns into at 2am.
    --
    -- Populated by the migration runner, not by a DEFAULT: there is no SQL
    -- expression that can see the Git commit. A deployment pipeline that does
    -- not fill it in leaves an empty string, which is honest, rather than a
    -- fabricated timestamp.
    applied_git_sha  TEXT,

    -- When it was applied, as integer milliseconds since the Unix epoch, for
    -- the same reason every timestamp in this schema is integer milliseconds:
    -- one representation, one comparison, no timezone and no string parsing.
    applied_at_ms    INTEGER NOT NULL DEFAULT 0,

    -- Generic created_at_ms / updated_at_ms pair, per the repository-wide rule.
    -- created_at_ms is the apply time; updated_at_ms only moves if a row is edited,
    -- and migration ledger rows are never edited, so it exists to satisfy the
    -- convention rather than to carry information.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    -- The worker that wrote this row. Not an actor id: the Identity Worker is
    -- the only thing permitted to touch Identity D1 (constraint §2), so this is
    -- a deployment label ("local", "staging", "production") and not a user.
    --
    -- SECURITY: a table listing which migrations have been applied tells an
    -- attacker exactly which code paths exist in the running platform. This is
    -- not a credential and not a secret; it is reconnaissance material, and it
    -- is stored here because an operator's "which schema is this?" question
    -- has to have an answer that does not require guessing.
    applied_by TEXT NOT NULL DEFAULT 'unknown'
);

-- Why this table coexists with `d1_migrations`.
--
-- `wrangler d1 migrations apply` maintains its own `d1_migrations` table
-- (name, applied_at). That is the migration *tool's* ledger and the tool is
-- the only writer. This table is the application's ledger.
--
-- They are not redundant:
--   - `d1_migrations` is written by the migration tool, which runs from CI or
--     from a developer laptop. It is not readable by the Worker in a way the
--     Worker can trust, and constraint §2 forbids the Worker from shelling out
--     to a migration runner.
--   - `schema_migrations` is written by the Worker and read by the Worker,
--     which is what lets `identity` answer "can this request be served yet?"
--     during startup and what lets `/ready` report the schema version rather
--     than just "the process is up".
--
-- Both are additive. This table has one index and it is the PRIMARY KEY,
-- because the only query made against it is `SELECT MAX(version)`, which the
-- primary key's b-tree already answers in O(log n) at the right-hand edge.
-- There is deliberately no index on `applied_at_ms`: nothing sorts by apply
-- time, and an index nothing queries is write amplification on every deploy.
