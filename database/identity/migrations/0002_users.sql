-- ===========================================================================
-- 0002_users.sql
--
-- WHAT THIS IS: the person. One row per account on the platform. Every other
-- identity table hangs off `users.id`.
--
-- WHAT THIS IS NOT: not a profile record and not a credential store. There is
-- no password column, and there will never be one: the founding constraints
-- forbid a self-implemented credential store (constraint §25, ADR-0008) and
-- every factor that does exist is an `authenticators` row.
--
-- COLUMN NAMING RULE (this schema's contract with the Rust):
-- Every column name below is the serde field name of the type it stores.
-- That is not a convention, it is the mapping: a row is turned into a
-- `identity_domain::user::User` field by field, and a column renamed away
-- from its serde name breaks that mapping silently — the read succeeds and
-- every field is empty.
--
--   User.display_name     -> display_name
--   User.role             -> role
--   User.status           -> status
--   User.security_version -> security_version
--
-- BACKWARD-COMPATIBILITY RULE: additive only, no DROP / RENAME / type change /
-- narrowing. There is no database rollback; the previous Worker version is
-- still serving traffic during a canary, so it must keep working against this
-- schema. See the full statement of the rule in 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS users (
    -- Surrogate key: the UUID from `UserId`, stored as its canonical hyphenated
    -- text form because `UserId::as_string()` is what the contracts and the
    -- queue envelopes carry, and storing the same representation means no
    -- conversion step can get it wrong.
    id          TEXT    PRIMARY KEY NOT NULL,

    -- `User.display_name`. Human-chosen, NOT unique, and never a login key:
    -- `identity-domain`'s `User::new` explicitly says two users may share one.
    -- Bounded at 200 bytes because `User::new` refuses longer, and the bound
    -- here is the backstop the Rust comment names.
    --
    -- SECURITY: a display name is PII. It is what an attacker sees on an
    -- account-takeover page and what a spear-phisher puts in a message.
    display_name TEXT   NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),

    -- `User.role`, the serde form of `PlatformRole`
    -- (#[serde(rename_all = "snake_case")]): member | support | administrator
    -- | service. A CHECK rather than a lookup table because the set is closed
    -- in the type and a fourth role requires a code change anyway.
    --
    -- NOT NULL DEFAULT 'member' so a row inserted by a migration or a fixture
    -- that forgets the column is a Member, not an invalid state. The default is
    -- the LEAST privileged value on purpose: the safe failure mode for an
    -- omitted role is "no privileges", never "all privileges".
    role         TEXT    NOT NULL DEFAULT 'member'
                 CHECK (role IN ('member', 'support', 'administrator', 'service')),

    -- `User.status`, the serde form of `UserStatus`: active | suspended |
    -- deactivated | pending_verification.
    --
    -- DEFAULT 'pending_verification' and NOT NULL, matching
    -- `User::new` exactly. A fresh account that proved nothing cannot
    -- authenticate, and that has to be true of the *stored* default too —
    -- defaulting to 'active' here would be the classic "unverified email is a
    -- login" bug written into the schema, where `User::new`'s careful default
    -- is bypassed by the first INSERT that omits the column.
    status       TEXT    NOT NULL DEFAULT 'pending_verification'
                 CHECK (status IN ('active', 'suspended', 'deactivated',
                                   'pending_verification')),

    -- =======================================================================
    -- security_version: THE O(1) "REVOKE EVERY SESSION" MECHANISM.
    -- =======================================================================
    --
    -- `User.security_version`. A plain INTEGER, deliberately NOT a timestamp
    -- and NOT an enum.
    --
    -- Why a plain integer: `identity_domain::security::SecurityVersion`
    -- documents the choice. A timestamp would invite someone to compare it to
    -- a clock and reason about skew, and ordering is the only property the
    -- mechanism needs.
    --
    -- How it works. Every row in `sessions` records the value in force when it
    -- was issued, in `sessions.security_version`. On every authenticated
    -- request the server compares the session's recorded value against this
    -- column. A mismatch refuses the request.
    --
    --   "Revoke every session for this account" == `UPDATE users SET
    --   security_version = security_version + 1 WHERE id = ?`
    --
    -- One indexed row updated. It does NOT enumerate sessions, does not
    -- write N rows, and does not depend on a background job finishing. That is
    -- the entire point: the trigger for this bump is usually a suspected
    -- compromise, and O(1) means the moment of suspicion is the moment every
    -- session dies.
    --
    -- WHY THE INDEX-FREE LOOKUP PATH IS CORRECT here, stated explicitly
    -- because "no index" reads like a mistake until it is explained:
    --
    --   This column is read as part of "resolve this session's user", which
    --   begins from `sessions.id` — already a primary key lookup. The `users`
    --   row is then fetched by `users.id`, also the primary key. Both are
    --   O(log n) on indexes that must exist for unrelated reasons.
    --
    --   An index on `security_version` would only ever serve "find every user
    --   at version N", which is a question nobody asks, and which returns
    --   nearly every row. It would be pure write amplification on the one
    --   column that must stay fast to update.
    --
    --   WHERE IT IS NOT COVERED, said plainly so nobody assumes otherwise:
    --   there is no query in this schema that finds "sessions belonging to
    --   version N", and one should never be added — that is the O(n) scan this
    --   design exists to avoid. Revocation is a comparison at request time,
    --   not a sweep.
    --
    -- `SecurityVersion::bumped()` refuses at u32::MAX rather than saturating,
    -- on the grounds that a silent no-op that *looks like* it revoked every
    -- session is the worst possible failure for this value. The CHECK below is
    -- the schema half of that: the column cannot hold a negative number, and
    -- an application that somehow arrives at a wrapped value is caught here.
    --
    -- DEFAULT 0 == `SecurityVersion::INITIAL`. A fresh account has no sessions
    -- yet, so no session can carry anything else.
    security_version INTEGER NOT NULL DEFAULT 0 CHECK (security_version >= 0),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the epoch.
    -- `identity-domain` stores every time as milliseconds (created_at_ms,
    -- occurred_at_ms, ...) precisely so there is one representation to
    -- compare and one to parse.
    created_at_ms  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES on users — each with the query it serves. An index nothing queries is
-- write amplification paid on every INSERT and every security_version bump.
-- ---------------------------------------------------------------------------

-- NO INDEX ON id. It is the PRIMARY KEY; SQLite gives it a b-tree and an
-- implicit rowid lookup. An explicit index here would be a second copy of the
-- whole table for no query.

-- INDEX 1: the admin user list, filtered by standing.
--
-- Serves `SearchUsers { role, status, limit, offset }` from
-- `identity-application::administration`, which is the console's main table.
-- It is filtered by role and ordered by nothing in particular, so the useful
-- shape is (role, created_at_ms): a filtered scan over the members of one role,
-- in creation order, which is the order the console paginates in.
--
-- Deliberately NOT (role, status): an administrator list is overwhelmingly
-- Members who are Active. A three-column key puts the selective third column
-- last and gains almost nothing over the two-column one.
CREATE INDEX IF NOT EXISTS ix_users_role_created
    ON users (role, created_at_ms);

-- INDEX 2: the last-administrator count.
--
-- `RoleChangeRequest::evaluate` refuses a demotion that would leave zero
-- active administrators, and the count it compares against is
--
--   SELECT COUNT(*) FROM users WHERE role = 'administrator' AND status = 'active'
--
-- That is invariant #2, and it is evaluated INSIDE the same transaction as the
-- demotion. Two concurrent demotions must not each see two administrators and
-- both succeed. The count is small (administrators are a handful of rows), so
-- this index is not about speed — it is about the count being a bounded,
-- consistent read rather than a full scan whose cost grows with the user base
-- and widens the window in which the race lives.
--
-- (role, status) rather than (status, role): the query pins the role and
-- varies the status check, so the role leads and each role's rows are adjacent.
CREATE INDEX IF NOT EXISTS ix_users_role_status
    ON users (role, status);

-- NO INDEX ON display_name. Login is never keyed on it — `User::new` says so
-- explicitly — and a substring search over display names is a table scan by
-- nature. `SearchUsers.query` matches display name *and* email across two
-- tables; when that ships it needs an FTS index or a denormalised search
-- column, and that is a migration with a plan, not a speculative index here.

-- SECURITY: what an attacker gets from this table.
--
-- `users` on its own is the least sensitive table in the schema. There is no
-- credential material in it, so reading it does not let anyone log in. What it
-- does leak is:
--
--   - WHO HAS AN ACCOUNT, and their display names (PII, spear-phishing fuel)
--   - the ROLES, i.e. which accounts can reach the admin console
--   - the STATUSES, i.e. who is currently locked out
--   - security_version, which reveals how many security-relevant events an
--     account has had. A version of 0 on a long-lived account and a version of
--     14 on another is a signal about which account is worth attacking.
--
-- Because roles are here, this table is a privilege map. It must be readable
-- only by the Identity Worker, which is the whole of constraint §2.
-- ---------------------------------------------------------------------------
