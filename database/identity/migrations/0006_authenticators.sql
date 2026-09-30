-- ===========================================================================
-- 0006_authenticators.sql
--
-- WHAT THIS IS: an enrolled factor — which factor, for whom, since when,
-- whether it has been used, and (only for the kinds that need it) the
-- encrypted material that proves it.
--
-- WHAT THIS IS NOT: it is NOT the API shape. `identity_domain::authenticator::
-- Authenticator` is `{ id, user_id, kind, label, enrolled_at_ms,
-- last_used_at_ms }` and holds no secret, by design and by test — the test
-- `the_record_of_enrolment_holds_no_secret` asserts that none of its field
-- names contains secret, seed, private_key or credential, because the type is
-- Serialize and anything added to it lands in logs and API responses.
--
--   So there are two different objects here and the difference matters:
--
--     the DOMAIN TYPE  what the platform is willing to talk about, and the
--                      only thing serialised into an API response
--     THIS TABLE       what the platform has to store
--
--   The secret columns below are NOT fields of the domain type and must never
--   become ones. They are storage for material that belongs to
--   `identity-security` (constraint §25: no self-implemented cryptography;
--   WebCrypto only, ADR-0008), and they are deliberately named with a
--   `secret_` prefix so that a reviewer reading a query, a log line or a
--   `SELECT *` result can tell at a glance which columns must never be
--   projected anywhere.
--
-- WHY THEY ARE HERE RATHER THAN IN A SEPARATE TABLE:
-- a passkey sign-in names a credential and must find which account it belongs
-- to; a TOTP check loads a secret by the enrolment's id. Both are primary-key
-- lookups when the material is colocated and joins when it is not, on the two
-- hottest security paths in the system. The separation that matters is not
-- table boundaries — it is that the DOMAIN TYPE stays secret-free, which the
-- test above enforces mechanically.
--
-- BACKWARD-COMPATIBILITY RULE: additive only, no DROP / RENAME / type change /
-- narrowing. No database rollback; the previous Worker version is still
-- serving traffic during a canary. Full statement: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS authenticators (
    -- `Authenticator.id` — `AuthenticatorId`, UUID text. Surrogate key.
    id       TEXT    PRIMARY KEY NOT NULL,

    -- `Authenticator.user_id` — who enrolled it.
    --
    -- ON DELETE CASCADE: a factor for a user who no longer exists is material
    -- nobody can present and nobody can administratively remove. ON UPDATE
    -- RESTRICT: a user id is never rewritten.
    user_id  TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- `Authenticator.kind`, the serde form of `AuthenticatorKind`:
    -- email_otp | totp | passkey | recovery_code.
    --
    -- The classification that matters is in the Rust, not here, and it is worth
    -- recording which way it goes:
    --
    --   is_second_factor()  totp, passkey     -> can reach AAL2
    --   is_primary_factor() email_otp          -> establishes the account
    --   neither             recovery_code      -> NEITHER, and that is deliberate
    --
    -- `recovery_code` being neither is a security decision, not an omission.
    -- Calling it a second factor "would let a stolen recovery code satisfy AAL2
    -- forever"; calling it primary "would let it stand in for the account
    -- itself". The column stores the kind; `identity-security` owns the
    -- classification, and there is deliberately NO `is_second_factor` column —
    -- a stored copy of that decision is a stored copy that can go stale.
    kind     TEXT    NOT NULL
             CHECK (kind IN ('email_otp', 'totp', 'passkey', 'recovery_code')),

    -- `Authenticator.label` — a user-chosen name so two authenticator apps are
    -- distinguishable ("Work phone"). Optional; 1..200 bytes when present,
    -- matching `Authenticator::with_label`.
    label    TEXT    CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),

    -- `Authenticator.enrolled_at_ms` — when enrolment happened, integer
    -- milliseconds since the epoch.
    enrolled_at_ms INTEGER NOT NULL CHECK (enrolled_at_ms >= 0),

    -- `Authenticator.last_used_at_ms` — when it was last successfully used, or
    -- NULL for never.
    --
    -- This is the input to the "recent authentication" window a step-up reads.
    -- `Authenticator::was_used_recently(now_ms, window_ms)` is half-open and
    -- looks BACKWARDS only: a clock reading before the use can never make it
    -- "recent", because "that would turn clock skew into an authentication
    -- bypass". The schema half of that rule is the CHECK below —
    -- last_used_at_ms may never precede enrolled_at_ms. A factor used before it
    -- existed is a corrupt row, not a state.
    last_used_at_ms INTEGER CHECK (last_used_at_ms IS NULL OR last_used_at_ms >= enrolled_at_ms),

    -- -----------------------------------------------------------------------
    -- SECRET MATERIAL — never a field of the domain type, never projected into
    -- an API response, never logged. See the file header for why.
    --
    -- Every column in this block is NULL for kinds that need no material
    -- (email_otp has none: possession of the inbox is the factor, and the
    -- proof-of-possession challenge for it lives in otp_challenges, 0007).
    --
    -- The cross-column CHECK at the bottom states which kinds need what, so a
    -- `recovery_code` row with a passkey's public key cannot be written by
    -- accident.
    -- -----------------------------------------------------------------------

    -- The WebAuthn credential id, base64url without padding.
    --
    -- UNIQUE when present, because a credential belongs to exactly one
    -- enrolment: two rows carrying the same credential id would make "which
    -- account does this authenticator belong to?" ambiguous, and an ambiguous
    -- answer there is a sign-in as somebody else.
    --
    -- Not global across kinds: an `email_otp` row never has one.
    credential_id TEXT,

    -- The WebAuthn COSE public key, base64url without padding.
    --
    -- A PUBLIC key. `PasskeyCredential`'s doc: "The public key, and nothing
    -- private. A stored credential is a public key and a signature counter;
    -- the private key never leaves the authenticator, so there is nothing else
    -- to store and nothing to leak." There is no private-key column here and
    -- there must never be one; `PasskeyCredential` is `deny_unknown_fields` so
    -- a body carrying `private_key` is refused rather than silently dropped.
    public_key TEXT,

    -- The WebAuthn signature counter. 0 means the authenticator does not
    -- implement counters — common, and must not be treated as a cloned
    -- credential (`PasskeyAssertion`'s doc says exactly this).
    sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),

    -- The TOTP shared seed or a recovery code, CIPHERTEXT.
    --
    -- The seed never exists in this table in the clear and never exists in a
    -- domain struct: `TotpSecret` is a newtype with a hand-written redacting
    -- Debug and Display precisely so it cannot reach a log line. Constraint §25
    -- forbids hand-rolled crypto, so the AEAD is chosen in `identity-security`
    -- (webauthn-rs / a maintained AEAD over WebCrypto, ADR-0008); this column
    -- only records that the bytes are opaque.
    --
    -- BLOB, not TEXT: ciphertext is binary, and SQLite's TEXT affinity would
    -- not corrupt it but would misrepresent it. Hex would double the size and
    -- add an encode/decode step to the hot path for nothing.
    secret_ciphertext BLOB,

    -- The AEAD nonce for `secret_ciphertext`.
    --
    -- A SEPARATE column and not a prefix of the ciphertext because
    -- `SecretCipher`'s security note is a hard requirement, not advice: "must
    -- never reuse a nonce with the same key. A TOTP seed stored under a single
    -- static IV is readable by anyone who obtains two rows." Storing the nonce
    -- per row is what makes per-encryption nonces possible.
    secret_nonce BLOB,

    -- Which key the ciphertext is under, so a rotation can decrypt old rows and
    -- encrypt new ones (`SecretCipher::current_key_id`). Bounded at 128 bytes
    -- because a `kid` is attacker-influenced — `SigningKeyId::new` bounds it
    -- for exactly that reason.
    secret_key_id TEXT CHECK (secret_key_id IS NULL OR length(secret_key_id) BETWEEN 1 AND 128),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the epoch.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    -- =======================================================================
    -- "the material matches the kind" — the only cross-column rule here.
    -- =======================================================================
    --
    --   passkey          -> credential_id AND public_key must both be present
    --   totp,
    --   recovery_code    -> secret_ciphertext AND secret_nonce must both be
    --                      present
    --   email_otp        -> no material at all
    --
    -- WHY THIS IS A CHECK AND NOT A RULE IN RUST: the write site is
    -- `identity-security`'s enrolment code, which is not written yet. A schema
    -- constraint is the half that can be real now, and it stops the specific
    -- failure that is hardest to notice later — a passkey row with no public
    -- key, which fails every sign-in with an error that looks like a wrong
    -- credential rather than a corrupt enrolment.
    --
    -- Both branches must be present: a ciphertext with no nonce, or a nonce
    -- with no ciphertext, is a partial write that would decrypt to garbage.
    --
    -- SECRET MATERIAL AS A CONSISTENT SET: this CHECK also means a torn write
    -- (ciphertext committed, nonce not) is refused at the database rather than
    -- discovered when a user cannot log in.
    CHECK (
        -- passkey: credential material is all-or-nothing.
        (kind = 'passkey'
            AND credential_id IS NOT NULL
            AND public_key    IS NOT NULL)
        OR
        -- totp and recovery_code: encrypted material is all-or-nothing.
        (kind IN ('totp', 'recovery_code')
            AND secret_ciphertext IS NOT NULL
            AND secret_nonce      IS NOT NULL)
        OR
        -- email_otp: proves possession of an inbox, so it stores nothing.
        (kind = 'email_otp'
            AND credential_id      IS NULL
            AND public_key         IS NULL
            AND secret_ciphertext  IS NULL
            AND secret_nonce       IS NULL)
    )
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: "what may this user present?"
--
-- The single most frequent read on this table: every step-up check, every login
-- screen, every AAL decision loads the account's factors. Plain (user_id) — the
-- kind is filtered after and it is a handful of rows per user, so a composite
-- key would only make the index wider.
CREATE INDEX IF NOT EXISTS ix_authenticators_user
    ON authenticators (user_id);

-- INDEX 2 (UNIQUE): "which account does this passkey belong to?"
--
-- A WebAuthn assertion names the credential and the server must resolve it to
-- an enrolment without scanning. This is the inverse of index #1 and cannot be
-- served by it.
--
-- UNIQUE: a credential id belongs to exactly one enrolment. Two rows carrying
-- the same credential would make that resolution ambiguous, and an ambiguous
-- answer to "who signed this" is a sign-in as the wrong person. This is the
-- storage half of the same class of rule as
-- ux_identities_provider_subject in 0004.
--
-- PARTIAL (WHERE credential_id IS NOT NULL): email_otp, totp and
-- recovery_code rows have no credential id and must not occupy the index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_authenticators_credential_id
    ON authenticators (credential_id) WHERE credential_id IS NOT NULL;

-- NO INDEX on (kind). No query asks "every TOTP authenticator on the
-- platform" — that is a platform-wide enumeration an attacker wants and no
-- operator needs.

-- NO INDEX on (user_id, kind). Every (user_id, kind) query is a prefix scan of
-- ix_authenticators_user over a handful of rows, and a second index leading
-- with the same column would be a strict subset paying a second B-tree.

-- NO INDEX on last_used_at_ms. Nothing sweeps by last use; the value is read
-- only after a row has been found by user_id, at which point it is a field
-- fetch.

-- ===========================================================================
-- THE "LAST FACTOR" CONSTRAINT IS NOT HERE, and its absence is deliberate.
--
-- `UnlinkIdentityCommand` refuses removing an account's last sign-in method,
-- and the analogous rule for a second factor is a lockout risk: an account
-- whose only AAL2 factor is removed can never satisfy an AAL2-required
-- operation again — and if that operation is "unlink", the account is
-- permanently locked out with no recovery.
--
-- Why it is not a CHECK here: it is a COUNT across a user's rows, and SQLite
-- CHECK constraints cannot see other rows. It would need a trigger, and D1's
-- migration model does not have a trigger story worth relying on (see
-- database/README.md, "What triggers this schema deliberately does not use").
-- The rule therefore lives in `identity-application`, and the best this schema
-- can do is make the count cheap — which is ix_authenticators_user.
--
-- FIXTURE CONSEQUENCE: because the database does not enforce it, the
-- "last remaining authenticator cannot be removed" test must load a fixture
-- with EXACTLY ONE authenticator and assert the refusal. A fixture with two
-- would make that test pass for the wrong reason. See
-- database/identity/fixtures/.
-- ===========================================================================

-- SECURITY: what an attacker gets from this table.
--
-- This is the most sensitive table in the schema, and it is sensitive for two
-- different reasons that must not be confused.
--
-- (1) READING THE ENROLMENT RECORD — moderately revealing:
--     - WHICH factors an account has. No second factor is a single-password
--       target and a priority for every credential attack.
--     - `last_used_at_ms`, which separates a factor in active use from a stale
--       enrolment. A factor never used is often one the user set up and forgot,
--       and a forgotten recovery code is a standing bypass.
--     - `enrolled_at_ms`, which dates the account's security posture.
--
-- (2) READING THE SECRET BLOCK — catastrophic, and irreversible:
--     - `secret_ciphertext` for a `totp` row IS the TOTP seed. Anyone who
--       reads it can generate valid codes for that account forever, with no
--       second factor and no rate limit on their own generation. This is the
--       single highest-value read in the entire database.
--     - A `recovery_code` row's `secret_ciphertext` is a password that bypasses
--       every other factor — `RecoveryCodeService`'s doc says consumption "must
--       be part of the same atomic step as the verification", and a stolen
--       ciphertext is a code that will verify once against whoever spends it
--       first.
--     - `public_key` is a public key and leaks nothing. The asymmetry between
--       these two columns is the reason the naming convention exists.
--
-- (3) WRITING:
--     Enrolling a factor you control requires first proving a factor you
--     control. That check is `identity-security`'s — `PasskeyService::
--     finish_registration` and `TotpService::generate_enrolment` — and it is
--     not in this schema. A database cannot verify that a recorded enrolment
--     was honestly earned; it can only refuse a row whose material does not
--     match its kind. The defence against a forged enrolment is the enrolment
--     code, and the defence against reaching this table at all is constraint
--     §2: Identity D1 is accessed by the Identity Worker and nothing else.
-- ---------------------------------------------------------------------------
