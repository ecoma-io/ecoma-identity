-- ===========================================================================
-- authenticators.sql — one row per `AuthenticatorKind`, and the row that makes
-- the "last remaining factor" rule testable.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- 1. `AuthenticatorKind` is `EmailOtp | Totp | Passkey | RecoveryCode`, and the
--    classification that matters is in the RUST, not here:
--      is_second_factor()  totp, passkey      -> can reach AAL2
--      is_primary_factor() email_otp           -> establishes the account
--      NEITHER             recovery_code       -> and that is deliberate
--    Every kind appears below, so a test can assert the classification against
--    real rows rather than against a hand-written struct.
--
-- 2. `recovery_code` being neither is the row worth writing down. `is_second_
--    factor()` returning false for a recovery code means "a stolen recovery code
--    cannot satisfy AAL2 forever"; being true would mean it could.
--    `is_primary_factor()` returning false means "a recovery code cannot stand in
--    for the account itself". Both are properties of a Rust method, and this
--    file supplies the rows that method would be called on.
--
-- 3. The "material matches the kind" CHECK in the table is demonstrated by rows
--    that SATISFY it. The rows that VIOLATE it cannot be here — a violating
--    INSERT aborts the file — and the demonstration is an assertion in
--    `tests/integration/schema.test.mjs`.
-- ===========================================================================

-- USER 2 (active member) — an email OTP authenticator, and NOTHING ELSE.
--
-- THIS IS THE ROW THE "LAST FACTOR" RULE NEEDS, and it is why this fixture is
-- as small as it is for this user.
--
-- `UnlinkIdentityCommand` refuses removing an account's last sign-in method, and
-- the analogous rule for a second factor is a lockout risk: "an account whose
-- only AAL2 factor is removed can never satisfy an AAL2-required operation
-- again — and if that operation is 'unlink', the account is permanently locked
-- out with no recovery."
--
-- THE DATABASE DOES NOT ENFORCE THAT RULE, because it is a COUNT across a
-- user's rows and SQLite CHECK constraints cannot see other rows; 0006 records
-- the decision. So the test that guards it has to load a fixture with EXACTLY
-- ONE authenticator for the account it is about. A fixture with two would make
-- that test pass for the wrong reason — the removal would be permitted, and a
-- test expecting a refusal would either fail or, worse, pass because the test
-- double hard-coded the count instead of reading the fixture.
--
-- THAT IS THE SAME CAUTION as the last-administrator fixture in `users.sql`, and
-- the same mechanical guard covers it: `assert_fixture_invariants.sql` asserts
-- that USER 2 has exactly one authenticator.
--
-- `kind = 'email_otp'` carries NO SECRET MATERIAL, and that is the point rather
-- than an omission: "email_otp: proves possession of an inbox, so it stores
-- nothing". The cross-column CHECK's third branch requires credential_id,
-- public_key, secret_ciphertext and secret_nonce ALL to be NULL for this kind,
-- and all four are NULL here.
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000002',
    'email_otp',
    'Fixture Inbox',
    1750000000000,
    1750000500000,
    NULL, NULL, 0,
    NULL, NULL, NULL
);

-- USER 2 — a TOTP authenticator, WITH encrypted material.
--
-- `secret_ciphertext` is 32 arbitrary bytes, `secret_nonce` is 12 bytes — the AES-GCM
-- nonce length — and `secret_key_id` names the key. These are NOT A TOTP SEED:
-- the seed itself exists in this table only as ciphertext produced by
-- `SecretCipher`, and constraint §25 forbids hand-rolled cryptography so the
-- AEAD is chosen in `identity-security` and this column only records that the
-- bytes are opaque.
--
-- The bytes are a fixture. A real ciphertext here would be a real secret and
-- would have to be rotated out of git the moment it landed, which is the reason
-- the schema makes the ciphertext's opacity explicit in the first place.
--
-- `last_used_at_ms > enrolled_at_ms`, which the schema CHECKs: "a factor used
-- before it existed is a corrupt row, not a state".
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002',
    'totp',
    'Fixture Authenticator App',
    1750000100000,
    1750000900000,
    NULL, NULL, 0,
    X'00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF',
    X'0102030405060708090A0B0C',
    'fixture-key-1'
);

-- USER 2 — a PASSKEY authenticator, with a public key and NO private key.
--
-- There is no private-key column and there must never be one. `PasskeyCredential`
-- says it: "The public key, and nothing private. A stored credential is a public
-- key and a signature counter; the private key never leaves the authenticator,
-- so there is nothing else to store and nothing to leak."
--
-- `sign_count = 0` MEANS "this authenticator does not implement counters", which
-- is common and must not be treated as a cloned credential — `PasskeyAssertion`'s
-- doc says exactly that. A fixture that used a large counter would make an
-- implementation that treats "counter did not advance" as a clone look correct
-- when tested against this row and wrong in production.
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000002',
    'passkey',
    'Fixture YubiKey 5',
    1750000200000,
    1750001000000,
    'fixture-credential-id-aaaa',
    'fixture-cose-public-key-bbbb',
    0,
    NULL, NULL, NULL
);

-- USER 2 — a RECOVERY CODE authenticator, and this row is the interesting one.
--
-- NEVER USED (`last_used_at_ms IS NULL`). A recovery code is single-use, so a batch is consumed row
-- by row and a partially-used batch is a normal state — but a row for a whole
-- BATCH that has never been used is the honest starting point.
--
-- "A recovery code is single-use. The batch is stored hashed; redemption
-- consumes a row." The table stores ONE row per batch rather than one per code,
-- which is a `DEFERRED` decision — `RecoveryCodeBatch` in `identity-security` is
-- a set, and whether each code gets its own row is a question this schema does
-- not answer. What is real here is that the row exists, carries ciphertext for
-- the hashed batch, and its `kind` is what `is_second_factor()` returns false
-- for.
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000002',
    'recovery_code',
    'Fixture Recovery Codes',
    1750000300000,
    NULL,
    NULL, NULL, 0,
    X'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899',
    X'0D0E0F101112131415161718',
    'fixture-key-1'
);

-- ===========================================================================
-- USER 8 — the passkey-only account, with NO email_otp AUTHENTICATOR
-- ===========================================================================
--
-- This is the counterpart to USER 2. USER 2 has four factors and an inbox;
-- USER 8 has one factor and no email_otp at all.
--
-- IT EXISTS BECAUSE A PASSKEY-PRIMARY ACCOUNT IS A REAL SHAPE, and it is the
-- shape the platform's own docs describe: `IdentityProvider::
-- subject_is_globally_unique()` is true for Passkey because the user handle is
-- minted here, and `user_identities.sql` gives USER 8 a passkey subject and no
-- email address. A fixture set where every account had an email_otp would let a
-- schema or implementation that quietly assumed "every account can receive a
-- code" pass every test in this directory.
--
-- `last_used_at_ms IS NULL` — enrolled and never used, which is the "a user set
-- it up and forgot it" state 0006's security note calls out as a standing
-- bypass risk when it is a RECOVERY code. Here it is a passkey, which is the
-- benign version of the same state.
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000008',
    'passkey',
    'Fixture Passkey (never used)',
    1750000400000,
    NULL,
    'fixture-credential-id-cccc',
    'fixture-cose-public-key-dddd',
    0,
    NULL, NULL, NULL
);

-- ===========================================================================
-- USER 6 (support agent) — an operator whose factor set is AAL2-ONLY
-- ===========================================================================
--
-- A support agent has NO email_otp authenticator and only a TOTP. That is the
-- shape an administrative account should have: the second factor is what
-- `forbidden_reason_missing_aal2()` is about, and a fixture where every
-- operator also had an inbox would make an implementation that forgot to require
-- AAL2 look correct, because every operator's session in `sessions.sql` is aal2.
--
-- The last session for USER 6 (SESSION H in `sessions.sql`) is aal2 with
-- `recently_authenticated = 1`, which is the only way that session could exist.
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000006',
    'f0000000-0000-4000-8000-000000000006',
    'totp',
    'Fixture Operator Token',
    1750000500000,
    1750001500000,
    NULL, NULL, 0,
    X'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
    X'1A1B1C1D1E1F1A1B1C1D1E1F',
    'fixture-key-1'
);

-- USER 6 — a recovery code for that operator, never used.
--
-- The row that makes `is_second_factor() == false` concrete for an operator,
-- which is the case where it matters most: a stolen operator recovery code must
-- not satisfy the AAL2 requirement that protects the admin surface.
INSERT INTO authenticators (id, user_id, kind, label,
                            enrolled_at_ms, last_used_at_ms,
                            credential_id, public_key, sign_count,
                            secret_ciphertext, secret_nonce, secret_key_id)
VALUES (
    '60000000-0000-4000-8000-000000000007',
    'f0000000-0000-4000-8000-000000000006',
    'recovery_code',
    'Fixture Operator Recovery',
    1750000600000,
    NULL,
    NULL, NULL, 0,
    X'FEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACE',
    X'2B2C2D2E2F30',
    'fixture-key-1'
);

-- ===========================================================================
-- THE ACCOUNTS DELIBERATELY LEFT WITH NO AUTHENTICATOR
-- ===========================================================================
--
-- USER 1 (the administrator), USER 3 (suspended), USER 4 (deactivated),
-- USER 5 (pending verification) and USER 7 (service) have none.
--
-- USER 1's absence is the third expression of the last-administrator caution and
-- the most important of them: an administrator with no factors at all cannot be
-- locked out by a careless removal, but also cannot be given one by a test that
-- was written to assume it. `assert_fixture_invariants.sql` asserts the
-- invariants that matter here and does not assert anything about USER 1's factor
-- count, because "the administrator has no factors" is a property of a bootstrap
-- command that does not exist yet rather than an invariant.
--
-- USER 7 (service) has none because a machine identity presents a signed token
-- rather than a factor. If a service account ever needs an authenticator row, the
-- honest model is a platform-signed token in `identity-security`'s `TokenSigner`,
-- not a TOTP nobody can enrol.