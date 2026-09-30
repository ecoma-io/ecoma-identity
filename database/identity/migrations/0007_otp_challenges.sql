-- ===========================================================================
-- 0007_otp_challenges.sql
--
-- WHAT THIS IS: outstanding one-time-code challenges — a code that was sent
-- somewhere, the proof of possession of which is still outstanding.
--
-- WHERE THE RUST PUTS THIS: `identity_security::factors::OtpChallenge`
-- ({ challenge_id, destination, ttl_seconds, attempts_remaining }) plus
-- `DeliveryDestination` (`{ via, address }`, serde-tagged).
--
-- Note the seam: the DOMAIN TYPE carries no code, no code hash, no user id
-- and no expiry timestamp. Its doc is explicit — "the code itself is
-- deliberately not a field of anything that gets logged. A delivered code is a
-- live credential, and the types here carry the challenge's identity and its
-- destination." So, as with `authenticators`, the domain type is the API shape
-- and this table is the storage shape. `challenge_id` is a String in both and
-- a UUID here.
--
-- BACKWARD-COMPATIBILITY RULE: additive only, no DROP / RENAME / type change /
-- narrowing. No database rollback; the previous Worker version is still
-- serving traffic during a canary. Full statement: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS otp_challenges (
    -- `OtpChallenge.challenge_id` — the identifier a verification request
    -- names. UUID text. The code is never echoed back into a request that could
    -- be logged, so this id is the only handle that travels.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- Which account the challenge is for.
    --
    -- NULLABLE, and the null case is load-bearing rather than an oversight.
    -- `StartEmailLoginOutcome` exists so that an unknown address and a known
    -- inactive one return *identically*, "for both branches to be
    -- timing-indistinguishable as well as content-indistinguishable". An
    -- always-accounted challenge row would make the two branches differ in
    -- storage writes, and the difference would show up as a timing oracle the
    -- moment anybody looked. So: a challenge issued for a KNOWN address has a
    -- user_id; a challenge issued for an UNKNOWN address has none, and the
    -- mail still goes out so that the branches are indistinguishable from the
    -- outside too.
    --
    -- ON DELETE CASCADE: a challenge for a user who no longer exists must not
    -- outlive them. ON UPDATE RESTRICT.
    user_id TEXT    REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- `DeliveryDestination`, stored flat rather than as its serde-tagged shape.
    --
    --   via      the serde name of the variant: email | sms
    --   address  the String inside the variant
    --
    -- Flat because a CHECK is the only way this schema can say "an sms
    -- destination must look like a phone number and an email destination must
    -- contain an @", and a CHECK cannot see inside a JSON blob. The
    -- mapping between the two columns and the enum is stated here rather than
    -- enforced by structure, and the reason the enum is tagged at all is that
    -- "a single `String` would make `sms:+1555…` and an unverifiable pair
    -- ambiguous at the call site".
    via      TEXT    NOT NULL CHECK (via IN ('email', 'sms')),
    address  TEXT    NOT NULL CHECK (length(address) BETWEEN 3 AND 320),

    -- The expected code, HASHED. Never the code.
    --
    --   WebCrypto SHA-256, per constraint §25 and ADR-0008: no self-implemented
    --   cryptography, no hand-rolled hash. The algorithm is chosen in
    --   `identity-security` (OtpService::verify); this column records only that
    --   the stored bytes are a digest and not a code.
    --
    -- BLOB because a digest is binary. Lower bound 32 bytes is SHA-256 output;
    -- upper bound 64 allows a future algorithm to widen without a type change.
    code_hash BLOB    NOT NULL CHECK (length(code_hash) BETWEEN 32 AND 64),

    -- When the challenge stops being redeemable, integer milliseconds since the
    -- epoch.
    --
    -- ABSOLUTE, not a TTL. The domain type carries `ttl_seconds` because the
    -- CHALLENGE does; the ROW carries a deadline because a row that stored a
    -- duration would make "is this still valid" depend on when you asked, and
    -- the same reasoning as `Session.expires_at_ms`.
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),

    -- `OtpChallenge.attempts_remaining` — how many verification attempts are
    -- left.
    --
    -- "Every attempt decrements it, whether or not the code was right, so a
    -- six-digit code cannot be found by guessing inside its window." A 6-digit
    -- code is 10^6; without a hard ceiling and a real decrement, that is a
    -- six-digit brute force against an endpoint that is supposed to be
    -- rate-limited by policy.
    --
    -- NOT NULL DEFAULT 5. The value is a policy decision recorded once here; the
    -- rate limiter in front of the endpoint is the other half and neither is
    -- sufficient alone.
    attempts_remaining INTEGER NOT NULL DEFAULT 5 CHECK (attempts_remaining >= 0),

    -- =======================================================================
    -- THE CONSUMPTION GUARD. THIS IS THE PART THAT MUST NOT BE GOT WRONG.
    -- =======================================================================
    --
    -- consumed_at: when this challenge was redeemed, integer milliseconds, or
    -- NULL while it is still outstanding.
    --
    -- The verification step is a CONDITIONAL UPDATE, and its row count IS the
    -- answer to "was this the first redemption?":
    --
    --   UPDATE otp_challenges
    --      SET consumed_at = :now, attempts_remaining = 0, updated_at_ms = :now
    --    WHERE id = :challenge_id
    --      AND consumed_at IS NULL        -- still outstanding
    --      AND attempts_remaining > 0     -- not exhausted
    --      AND :now < expires_at_ms       -- not stale
    --    RETURNING id;
    --
    --   1 row returned  -> this caller was the first. Proceed.
    --   0 rows returned -> already consumed, exhausted or stale. REFUSE.
    --
    -- WHY "DELETE THE ROW ON VERIFY" IS NOT AN OPTION, which is the whole
    -- reason this column exists in this form:
    --
    --   Deleting is a read-then-write and loses the race by construction. Two
    --   simultaneous verifications of the same six-digit code both SELECT the
    --   row (both see it, it exists), both compare the hash (both match), and
    --   both proceed — the second DELETE then affects zero rows and *nobody
    --   checks*, because a delete that removed nothing is not an error in SQL.
    --   The OTP is spent twice.
    --
    --   That is not a hypothetical. It is what happens when a user double-taps
    --   "resend" and then types the first code, and it is what happens when an
    --   attacker who phished a code races the victim using it. Single-use is the
    --   property that makes a leaked OTP harmless after one use —
    --   `SecurityError::AlreadyRedeemed` exists precisely because "a code that
    --   verifies twice is a permanent bypass" (RecoveryCodeService's doc). A
    --   delete-based implementation would report AlreadyRedeemed for a
    --   sequential replay and permit a concurrent one.
    --
    -- WHY THE CONDITIONAL UPDATE WINS THE RACE:
    --
    --   The `consumed_at IS NULL` predicate is evaluated and the write applied
    --   atomically, by SQLite, under the transaction that opened the
    --   verification. Two callers issuing the same UPDATE at the same instant
    --   serialise on the row: the first evaluates the predicate as true and
    --   sets consumed_at; the second then evaluates it as FALSE — because the
    --   first's write is visible to it — matches zero rows, and is told so by
    --   its own row count. There is no window in which both see NULL.
    --
    --   That is the difference between a guard that is checked and a guard that
    --   is merely present. The application code must therefore treat "0 rows
    --   changed" as a REFUSAL, not as a no-op, and must not re-read the row to
    --   find out why — re-reading after losing the race is how a caller ends up
    --   distinguishing consumed from expired from unknown, which
    --   `OtpService::verify`'s contract forbids ("Each [error] decrements the
    --   attempt budget" and none of them may be told apart by an outsider).
    --
    -- WHY THE ROW IS NOT DELETED ON CONSUMPTION:
    --   the same reason `sessions` keeps revoked rows. A consumed challenge is
    --   the evidence that the code was spent; deleting it makes a replayed code
    --   indistinguishable from one that was never issued, and the attempt
    --   budget's usefulness depends on being able to count attempts.
    --
    -- WHY `attempts_remaining = 0` IS SET IN THE SAME UPDATE:
    --   so that a consumed row is also an exhausted one. It closes the
    --   adjacent race where two callers both pass `attempts_remaining > 0` on a
    --   challenge with one attempt left.
    consumed_at INTEGER,

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the epoch.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    -- =========================================================================
    -- CROSS-COLUMN CONSTRAINTS
    -- =========================================================================

    -- consumed_at may never precede the challenge's creation. A code consumed
    -- before it was sent is a corrupt row, and "corrupt" is a conclusion the
    -- database can reach cheaply here.
    -- A consumption cannot be backdated before the challenge was issued.
    --
    -- The >= is not >= 0, because >= 0 would accept any positive integer and a
    -- caller computing "now" wrongly — in seconds where the column is
    -- milliseconds, which is the single most likely mistake given that
    -- `unixepoch()` returns seconds — would be accepted rather than caught.
    -- Comparing against this row's own creation time catches it: a
    -- seconds-based timestamp in 2026 is a billion, a milliseconds-based one is
    -- a trillion, and the CHECK refuses the former.
    --
    -- VERIFIED, not asserted: see tests/integration/schema.test.mjs,
    -- "the OTP consumption guard refuses a timestamp from before the challenge
    -- was issued". The column comment above is worth keeping because the reason
    -- is not visible in the predicate.
    CHECK (consumed_at IS NULL OR consumed_at >= created_at_ms),

    -- A challenge with an account is an email login for a KNOWN address; a
    -- challenge with no account is the account-enumeration-safe branch. Both
    -- are legitimate, so neither is constrained — the reason is in the file
    -- header and it must not be "fixed" by adding a NOT NULL here.
    --
    -- (recorded as a comment because SQLite has no comment-only constraint and
    -- an empty CHECK is a syntax error.)
    CHECK (user_id IS NULL OR length(user_id) >= 36)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: "is this challenge still outstanding?"
--
-- The verification UPDATE's WHERE clause begins with id, which is the PRIMARY
-- KEY — no index needed for the primary path, and this table's hot query is
-- exactly a primary-key lookup. There is deliberately no extra index for it.

-- INDEX 2: "which challenges belong to this account?"
--
-- The account's "challenges in flight" view, and the cleanup of a user's
-- outstanding challenges when an administrator revokes everything. Plain
-- (user_id); there are at most a handful of outstanding challenges per user
-- and they are short-lived.
--
-- PARTIAL on consumed_at IS NULL: consumed rows are evidence and are never
-- queried by this path, so keeping them out of the index keeps it to the rows
-- that can still be redeemed.
CREATE INDEX IF NOT EXISTS ix_otp_challenges_user
    ON otp_challenges (user_id) WHERE consumed_at IS NULL;

-- INDEX 3: the expiry sweep.
--
-- A maintenance job burns outstanding challenges whose deadline has passed, so
-- that a stale row cannot be redeemed by a caller whose clock is behind.
-- Without this the sweep is a full scan of every challenge ever issued.
--
-- PARTIAL on consumed_at IS NULL, and for the same reason as above: only
-- unconsumed rows are candidates.
CREATE INDEX IF NOT EXISTS ix_otp_challenges_expiry
    ON otp_challenges (expires_at_ms) WHERE consumed_at IS NULL;

-- INDEX 4: the delivery audit — "where did we send this challenge's code?".
--
-- SECURITY: this index makes the address column reachable by a single lookup
-- for anyone who can query this table, which is already true of the table
-- itself. It is justified because the legitimate query is real and frequent —
-- rate-limiting by destination is the primary defence against spraying one
-- address with codes, and `OtpService` is required to fail closed when the
-- limiter is unavailable. Note the lookup is (via, address) rather than
-- (address) so that a hypothetical sms/email collision cannot merge two
-- transports' rate-limit buckets.
CREATE INDEX IF NOT EXISTS ix_otp_challenges_destination
    ON otp_challenges (via, address);

-- NO INDEX on (code_hash). A lookup by hash would mean "find every challenge
-- with this code", which is not a query this system makes: verification is
-- always challenge-id-first, and an index on the hash would put a per-challenge
-- digest in a second B-tree on the table that receives a row for every login
-- attempt including the ones that are pure credential stuffing.

-- NO INDEX on attempts_remaining. Nothing sweeps by budget; the value is only
-- read inside the conditional UPDATE, after the primary-key lookup.

-- NO INDEX on consumed_at alone. Every path that filters on it also filters on
-- user_id or expires_at_ms, and indexes #2 and #3 are both partial on it —
-- adding a general index would duplicate both.

-- SECURITY: what an attacker gets from this table.
--
-- (1) READING `code_hash`:
--     A digest of a SIX-DIGIT code is not protected by the code's entropy. There
--     are 10^6 possible codes; anyone who can read this table can compute
--     SHA-256 for all million of them and match. Six digits is ~20 bits, and a
--     GPU does that in well under a second.
--
--     So `code_hash` here must be understood as NOT a defence against an
--     attacker with database read access. It exists so that a leaked BACKUP or
--     a mis-scoped query does not hand out live codes directly, and so that the
--     stored row is not the code. It is not, and cannot be, protection against
--     this read.
--
--     The real defences against offline recovery of a live code are:
--       - the challenge's SHORT lifetime (expires_at_ms, minutes not hours),
--       - `attempts_remaining`, which bounds online guessing,
--       - the rate limiter in front of the endpoint, which `OtpService` must
--         treat as mandatory and fail closed on.
--     All three matter and none of them is this column.
--
-- (2) READING `via` and `address`:
--     A list of every address the platform has recently sent a code to, with
--     timestamps. That is a targeting list — it says who has an account here,
--     who recently tried to sign in, and how often. `address` is PII; combined
--     with `user_id` it is an account-existence oracle.
--
-- (3) WRITING:
--     INSERT a row with a code_hash you chose and you have manufactured a
--     challenge that will accept a code you know. This is why the challenge id
--     is a UUID the SERVER mints rather than anything client-supplied — a
--     caller-chosen challenge is a caller-chosen nonce.
--
--     UPDATE a row's consumed_at to NULL and a spent code is spendable again,
--     and this schema cannot stop it: there is no predicate in the guard that
--     distinguishes a legitimate consumption from an un-consumption. The
--     defence is constraint §2 — only the Identity Worker writes here.
--
-- The invariant this table exists to make true is single-use, and the column
-- that makes it true against a CONCURRENT replay is `consumed_at` and the
-- conditional UPDATE above. It must never be replaced by a DELETE.
-- ---------------------------------------------------------------------------
