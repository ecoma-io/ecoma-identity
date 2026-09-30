-- ===========================================================================
-- 0005_sessions.sql
--
-- WHAT THIS IS: server-side session state. A session is a RECORD, not a token:
-- the cookie or bearer credential is transport, and this row is the state the
-- transport is checked against. Keeping the two apart is what makes "revoke
-- this session" instant and total rather than eventual.
--
-- WHERE THE RUST PUTS THIS: `identity_domain::session::Session`:
--   { id, user_id, status, security_version, created_at_ms, expires_at_ms,
--     aal, recently_authenticated }
-- and `identity_application::sessions::SessionView`:
--   { session_id, created_at_ms, expires_at_ms, aal, label, current }
--
-- Note the column-to-field mapping for the times. `Session.created_at_ms` is a
-- DOMAIN fact — "when the session began" — and `created_at_ms` is the generic
-- row-timestamp convention declared once in 0001. On a session row they are two
-- distinct numbers that happen to agree on the insert, and the schema keeps both
-- columns (and a comment on each) because an expiry sweep that rewrites one of
-- them must never be able to reach the other by a typo.
--
-- BACKWARD-COMPATIBILITY RULE: additive only, no DROP / RENAME / type change /
-- narrowing. No database rollback; the previous Worker version is still
-- serving traffic during a canary. Full statement: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS sessions (
    -- `Session.id` — `SessionId`, UUID text. Surrogate key.
    --
    -- NOT a credential. `Session`'s doc is explicit: "knowing it is not enough
    -- to authenticate, because the transport also carries a secret the server
    -- stores hashed." See otp_challenges and application_secrets for where
    -- hashed material lives; nothing hashed lives HERE, and that separation is
    -- deliberate so a `sessions` dump is not a set of login credentials.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- `Session.user_id` — who this session acts for.
    --
    -- ON DELETE CASCADE: a session for a user who no longer exists is a live
    -- credential for nobody. ON UPDATE RESTRICT.
    user_id TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- `Session.status`, the serde form of `SessionStatus`:
    -- active | revoked | expired.
    --
    -- DEFAULT 'active' matches `Session::new`.
    --
    -- NEVER DELETED IN PRACTICE, and that is the point of having three states
    -- instead of one boolean. `SessionStatus::Revoked`'s doc: kept "so that
    -- 'this credential was revoked' is answerable, and so replaying it is
    -- REFUSED rather than being mistaken for a session that never existed."
    --
    -- A deleted session is indistinguishable from one that never existed, and
    -- an attacker replaying a stolen credential learns nothing from a 404 —
    -- which is exactly the oracle you do not want while investigating.
    status   TEXT    NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'revoked', 'expired')),

    -- =======================================================================
    -- security_version: the half of "revoke every session" that lives per-row.
    -- =======================================================================
    --
    -- `Session.security_version` — the value of `users.security_version` in
    -- force when this session was issued.
    --
    -- The mechanism (see 0002_users.sql for the full statement): the access
    -- check compares this column against users.security_version and refuses a
    -- mismatch. Bumping the user column invalidates every session at once,
    -- with no enumeration and no per-row write.
    --
    -- Invariant #3 ("a stale security_version invalidates its sessions") is
    -- enforced for real in `identity-domain` today — `stale_security_version_
    -- does_not_match_the_current_account` is not `#[ignore]`d — and this column
    -- is where the comparison gets its second operand at runtime.
    --
    -- Why it is a plain INTEGER and not a foreign key to a version history
    -- table: the check is an inequality between two numbers. Storing the
    -- number is the whole mechanism; a history table would add a join to the
    -- hottest request path in the system for no additional decision power.
    security_version INTEGER NOT NULL DEFAULT 0 CHECK (security_version >= 0),

    -- `Session.created_at_ms` — when the session began, integer milliseconds.
    --
    -- NO DEFAULT, deliberately. The generic pair at the bottom of this table
    -- carries `(unixepoch() * 1000)` as a backstop; a session's own start time
    -- is a fact the caller states (a cookie restored from a pre-existing
    -- session has a real start time that is not "now"), so a default here would
    -- be a plausible-looking wrong value rather than an obvious error.
    --
    -- THIS IS ALSO THE GENERIC ROW TIMESTAMP, and the two having merged is the
    -- correct outcome rather than a collision. They are the same fact: a session
    -- row is created at the instant the session begins, never re-created, and
    -- never backdated. `data-model.md` lists exactly one `created_at_ms` on
    -- `sessions`, and SQLite has no way to hold two columns of the same name, so
    -- a table with both is not a table that can exist. The header comment
    -- explains the distinction the domain type draws — `Session::created_at_ms`
    -- is a domain field a caller must supply, the DEFAULT here is a backstop for
    -- a caller that does not — and this column is where both live.
    created_at_ms    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    -- `Session.expires_at_ms` — when it expires, integer milliseconds.
    --
    -- ABSOLUTE, NOT A DURATION. `Session`'s doc: "a duration stored on the row
    -- would make 'when does this expire' depend on when you asked." An absolute
    -- deadline answers the same for every reader regardless of when it reads.
    --
    -- The CHECK encodes the rule `Session::new` enforces in Rust: a session
    -- born expired is a caller bug. Reproducing it here means a fixture or a
    -- hand-written INSERT cannot produce one, and the Rust test
    -- (`a_session_that_is_born_expired_is_refused`) has a schema counterpart.
    expires_at_ms    INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),

    -- `Session.aal` / `SessionView.aal`, the wire form from `Aal::as_wire`:
    -- aal1 | aal2. NOT NULL DEFAULT 'aal1': an email code establishes AAL1 and
    -- nothing in the system may raise a session's AAL by omission.
    --
    -- Invariant #4 ("AAL1 cannot satisfy an AAL2 operation") is `>=` on this
    -- ordinal — `Aal::satisfies` — and is enforced for real in
    -- `identity-security`. The column stores the value that comparison reads.
    aal              TEXT    NOT NULL DEFAULT 'aal1' CHECK (aal IN ('aal1', 'aal2')),

    -- `Session.recently_authenticated` — did the user prove a second factor
    -- during THIS session, as a fact about the last few minutes.
    --
    -- Per-SESSION, never per-user. `invariants.rs` says exactly why: "if
    -- 'recently authenticated' were a property of the user, one account-wide
    -- flag would let an attacker with any session on the account make every
    -- other session step-up-eligible." The test
    -- `recently_authenticated_is_tracked_per_session_not_globally` exists to
    -- fail if anyone adds a `users` column for it.
    --
    -- DEFAULT 0: a session that has existed for zero minutes has proved
    -- nothing recently.
    recently_authenticated INTEGER NOT NULL DEFAULT 0
             CHECK (recently_authenticated IN (0, 1)),

    -- `SessionView.label` — a COARSE display label ("Chrome on Linux").
    --
    -- NOT a verbatim user-agent string, and there is no column for one.
    -- `SessionView`'s doc is explicit: the list is "displayed in a list an
    -- account-takeover attacker will be reading, and an unescaped user-agent is
    -- a stored-XSS vector." Bounded at 200 bytes when present.
    label            TEXT    CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),

    -- The credential HASH, not the credential. See the security note below.
    --
    --   - `credential_hash`  WebCrypto SHA-256 of the transport secret, hex or
    --                        base64url. NEVER the secret. Constraint §25
    --                        forbids self-implemented cryptography, so the
    --                        algorithm is named in the column comment and
    --                        selected in `identity-security`, never here.
    --   - `credential_type`  How the presented credential is verified, so a
    --                        future second kind is additive rather than a
    --                        migration. Values: cookie | bearer. Only these
    --                        two are written today.
    --
    -- Why the hash lives here at all rather than in a separate table: a
    -- session lookup IS "find the row whose credential hashes to this". Split
    -- across two tables that lookup becomes a join on the hottest path.
    --
    -- A lookup by credential hash is the reason for
    -- ux_sessions_credential_hash below.
    credential_hash  TEXT    CHECK (credential_hash IS NULL OR length(credential_hash) BETWEEN 43 AND 128),
    credential_type  TEXT    CHECK (credential_type IS NULL OR credential_type IN ('cookie', 'bearer')),

    -- When the row was last written, integer milliseconds. Separate from
    -- updated_at_ms: this one moves on every request that touches the session
    -- (last-seen tracking), and it is the input to "show me the sessions still
    -- in use" on the account screen.
    last_seen_at_ms  INTEGER,

    -- Generic updated_at_ms, integer milliseconds since the epoch (the rule is
    -- stated once in 0001). NO TRIGGER MAKES IT MOVE: `unixepoch()` is not
    -- re-evaluated on UPDATE, so every writer sets it explicitly. That
    -- obligation is listed in database/README.md under "What is deferred" rather
    -- than left for whoever writes the first UPDATE to discover.
    updated_at_ms     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves. This table is the hottest in the
-- schema: every authenticated request touches exactly one of these rows.
-- ---------------------------------------------------------------------------

-- INDEX 1 (UNIQUE): "which session does this presented credential belong to?"
--
-- This is the query behind every single authenticated request. A UNIQUE index
-- because two sessions sharing a credential hash means one of them is
-- forgeable, and there is no legitimate reason for the collision.
--
-- PARTIAL (WHERE credential_hash IS NOT NULL): rows without a hash are not
-- searchable by credential and must not occupy the index. They exist for the
-- administrative enumeration paths and for the window between "row inserted"
-- and "credential issued" inside one transaction.
--
-- SECURITY: an index on a credential hash is an offline guessing oracle for
-- anyone who obtains the index. That is the accepted trade — SHA-256 of a
-- 256-bit random secret is not guessable, and storing the secret instead would
-- be catastrophic rather than merely worse. The requirement is therefore that
-- credential_hash is a hash of high-entropy random material, never of a
-- user-chosen value; see `identity-security::SessionService::issue_credential`,
-- which mandates "at least 256 bits of entropy".
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_credential_hash
    ON sessions (credential_hash) WHERE credential_hash IS NOT NULL;

-- INDEX 2: "sign out everywhere", and the account's session list.
--
-- Serves BOTH of:
--   - RevokeAllSessionsCommand  (the self-service unit struct with no user_id:
--     "there is no `user_id` field. That absence is the boundary.")
--   - GetUserSessionsQuery      (the admin's count and last-activity summary)
--
-- Both are "every session for user X", so user_id leads. status is second so
-- that "every ACTIVE session for X" — the revocation query's WHERE clause — is
-- answered from a contiguous range rather than filtering.
--
-- The `(user_id, status)` shape also covers the plain "list my sessions"
-- query from ListSessionsQuery, which has no status filter: a prefix scan on
-- user_id.
CREATE INDEX IF NOT EXISTS ix_sessions_user_status
    ON sessions (user_id, status);

-- INDEX 3: the expiry sweep.
--
-- A maintenance job deletes or marks expired rows. Without this it scans every
-- session ever created, including the vast majority that are long dead.
-- `expires_at_ms` is absolute (see above), so the sweep is a range scan and
-- not an arithmetic pass over durations.
--
-- PARTIAL on status = 'active': only unrevoked rows are candidates, and revoked
-- rows are retained deliberately as evidence, so they must NOT be swept away
-- by this job. Filtering them out of the index is what keeps the index small
-- and keeps the sweep from destroying the audit trail.
CREATE INDEX IF NOT EXISTS ix_sessions_expiry_active
    ON sessions (expires_at_ms) WHERE status = 'active';

-- NO INDEX on (user_id, security_version).
--
-- Tempting — it looks like it would help "revoke all sessions". It must not
-- exist, and this is the single most important non-index in the schema.
--
-- The whole point of the security_version mechanism is that revocation does
-- NOT enumerate sessions. If a query existed that found "this user's sessions
-- at version N", it would be a query someone would eventually run inside a
-- request path, and then revocation is O(n) again and the guarantee is gone.
-- Revocation is `UPDATE users SET security_version = security_version + 1`.
-- Nothing reads sessions BY security_version. The column is only ever compared
-- against users.security_version for one session the caller already holds.
--
-- NO INDEX on aal or recently_authenticated. Both are read only AFTER a
-- session row has already been located by index #1 or the primary key. An
-- index on either would not be used by any query and would cost a write on
-- every AAL change.

-- SECURITY: what an attacker gets from this table.
--
--   credential_hash   Read access to the hashes. They are not the credentials,
--                     and the material hashed is 256 bits of CSPRNG output, so
--                     this is not offline-crackable. It IS enough to confirm
--                     that a particular credential is live, which is why the
--                     value never appears in a log or an API response —
--                     `SessionView`'s test asserts `hash` never serialises.
--
--   security_version  Reveals how many security-relevant events a session's
--                     account has had, by comparing against the user's. Low
--                     value to an attacker; mentioned so the column list is
--                     complete.
--
--   recently_authenticated + aal  Together these say how strongly this
--                     session is currently authenticated. Useful for choosing
--                     which of a victim's sessions to target.
--
--   The session LIST is the real exposure: user_id, aal, label and expiry for
--     every live session is a map of a person's devices, and it is the list an
--     attacker reads AFTER a successful takeover. That is why the admin path
--     to it requires AAL2 (`RevokeUserSessionsCommand`) and why the self-
--     service path deliberately has no user_id.
--
-- WRITE access to this table is a login: INSERT a row with a chosen
-- user_id, security_version equal to that user's current value, status
-- 'active', and a hash of a credential you control, and you are authenticated
-- as them. There is no field in this table that a database constraint can
-- defend against that — the defence is that constraint §2 makes this table
-- reachable only from the Identity Worker.
-- ---------------------------------------------------------------------------
