-- ===========================================================================
-- pkce_challenges.sql — outstanding, redeemed and expired flows.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- THE REDEMPTION RACE, which is the same shape as the OTP one and exists for the
-- same reason, plus one property the OTP fixture cannot cover: a code can only be
-- redeemed once, and that has to be checked on a table whose primary key is a
-- HASH the client presents.
--
-- THE GUARD, verbatim from 0011's header:
--
--   UPDATE pkce_challenges SET consumed_at = :now
--    WHERE id = :id AND consumed_at IS NULL
--   RETURNING id;
--
-- One row is the first redemption; ZERO rows is a replay and the caller refuses.
--
-- WHAT IS HERE: one outstanding flow, one already-redeemed flow, one expired
-- flow, and one flow belonging to the public client. All of them share the same
-- redirect URI except the public client's, so nothing about the difference is a
-- difference in the callback — it is the challenge's own state, which is the only
-- thing the guard reads.
--
-- ===========================================================================
-- THE `code_challenge` VALUES: WHAT THEY ARE, AND HOW THEY WERE OBTAINED
-- ===========================================================================
--
-- EACH `code_challenge` BELOW IS A REAL BASE64URL(SHA256(code_verifier)) DIGEST,
-- and each one's verifier is stated immediately above it, so a test can re-derive
-- the digest and compare rather than take the fixture's word for it. They were
-- produced with:
--
--     python3 -c 'import base64,hashlib,sys;
--       print(base64.urlsafe_b64encode(
--         hashlib.sha256(sys.argv[1].encode()).digest()
--       ).rstrip(b"=").decode())' <verifier>
--
-- That is an OFFLINE FIXTURE-AUTHORING STEP and nothing else. It is not the
-- platform's PKCE: constraint §25 forbids self-implemented cryptography, and the
-- platform's is `identity_security::tokens::PkceService::verify`, which computes
-- this digest through WebCrypto inside the Worker and compares in constant time.
-- Authoring a fixture row is not a security operation, and no code path anywhere
-- in this repository contains the snippet above.
--
-- ALL FOUR VERIFIERS ARE INSIDE RFC 7636's 43..128 RANGE, which
-- `PkceService::derive_challenge` refuses anything outside ("the RFC 7636 length
-- range of 43–128 characters"). Their lengths are stated per flow.
--
-- THESE ARE NOT SECRETS. A challenge is published in the authorization request,
-- which by definition travels through the browser and the redirect URI. Their
-- verifiers are fixture strings, not credentials, and are written here so the
-- digest is reproducible.
-- ===========================================================================

-- ===========================================================================
-- FLOW 1 — OUTSTANDING, redeemable exactly once
-- ===========================================================================
--
-- code_verifier: 'fixture-verifier-one-which-is-43-characters-minimum-xx'
--                (54 characters — inside the 43..128 range)
-- code_challenge: cHkzhqPdnxmqXdJaWbfdWNyc0QUI-kiaWXPy_ffv5Wk
--                 (43 characters, unpadded base64url of a 32-byte SHA-256)
--
-- `code_challenge_method` is 'S256', which is the DEFAULT and is stated anyway
-- rather than omitted: the column's CHECK is `code_challenge_method = 'S256'`, so
-- `plain` is refused here as well as in Rust ("plain is not implemented, because
-- the discovery document does not advertise it").
--
-- `user_id` is SET: the person authenticated during the authorisation request,
-- so no login redirect intervened. `expires_at_ms` is 2030, so the row is
-- redeemable by any test run before then.
INSERT INTO pkce_challenges (id, code_hash, code_challenge, code_challenge_method,
                              client_id, redirect_uri, user_id, scopes, expires_at_ms)
VALUES (
    'e0000000-0000-4000-8000-000000000001',
    X'000A0B0C0D0E0F101112131415161718191A1B1C1D1E1F202122232425262728',
    'cHkzhqPdnxmqXdJaWbfdWNyc0QUI-kiaWXPy_ffv5Wk',
    'S256',
    'ecoma-fixture-oidc-client',
    'https://app.fixture.invalid/callback',
    'f0000000-0000-4000-8000-000000000002',
    '["openid","profile","email"]',
    1893456000000
);

-- ===========================================================================
-- FLOW 2 — ALREADY REDEEMED
-- ===========================================================================
--
-- code_verifier: 'fixture-verifier-two-which-is-43-characters-minimum-yy'
--                (54 characters)
-- code_challenge: yfP9EvE3yCRcquuDMPfJ8fMpa53T614HmlGLs2aDgsM
--
-- `consumed_at` is set. `user_id` is set as well, and it is USER 2's SECOND
-- session (SESSION B) rather than the one that performed the authorisation —
-- which is the realistic shape: the person authenticates in one session and
-- redeems the code in another, which is exactly why the redirect URI is stored on
-- this row and compared at redemption instead of the session being checked.
--
-- THE ROW A REPLAY ATTACKER WOULD REDEEM, and the guard's `consumed_at IS NULL`
-- is what makes it fail. `tests/integration/schema.test.mjs` runs the guard twice
-- against FLOW 1 and asserts one row then zero.
--
-- `consumed_at` (1750000700000) is AFTER this row's `created_at_ms` DEFAULT,
-- which is the real current time, so the column's `consumed_at >= 0` CHECK and
-- the fixture's own internal coherence cannot conflict.
INSERT INTO pkce_challenges (id, code_hash, code_challenge, code_challenge_method,
                              client_id, redirect_uri, user_id, scopes, expires_at_ms,
                              consumed_at)
VALUES (
    'e0000000-0000-4000-8000-000000000002',
    X'1A1B1C1D1E1F202122232425262728292A2B2C2D2E2F30313233343536373839',
    'yfP9EvE3yCRcquuDMPfJ8fMpa53T614HmlGLs2aDgsM',
    'S256',
    'ecoma-fixture-oidc-client',
    'https://app.fixture.invalid/callback',
    'f0000000-0000-4000-8000-000000000002',
    '["openid","profile","email"]',
    1893456000000,
    1750000700000
);

-- ===========================================================================
-- FLOW 3 — EXPIRED
-- ===========================================================================
--
-- code_verifier: 'fixture-verifier-three-which-is-43-characters-minimum-zz'
--                (56 characters)
-- code_challenge: HXjeIfawPJ66XnvJm1ILnBC3FLjKSog2Fc9Bnk8NAx8
--
-- An abandoned authorisation: the user was redirected to log in and never came
-- back. `expires_at_ms` is in the past and `consumed_at IS NULL`, so this is the
-- one shape a sweep has to find and the one an implementation that checked only
-- `consumed_at` would happily redeem.
--
-- `user_id IS NULL` for the same reason CHALLENGE E in `otp_challenges.sql` has
-- it: nobody authenticated during the authorisation request. The column's
-- nullability comment says a challenge "may stop at the login redirect and
-- outlive the user's absence" and that "nothing downstream may branch on whether
-- it is NULL in a way that is observable to the caller" — so this row exists to
-- make that shape real rather than theoretical.
--
-- `created_at_ms` is stated so the row's timestamps are coherent with its
-- expiry: issued in 2025, expired in 2025, never redeemed. (There is no CHECK
-- relating `consumed_at` to `created_at_ms` on this table — there is no
-- `consumed_at` here at all — but a fixture whose expiry precedes its creation
-- would be a fixture that lies about its own shape.)
INSERT INTO pkce_challenges (id, code_hash, code_challenge, code_challenge_method,
                              client_id, redirect_uri, user_id, scopes, expires_at_ms,
                              created_at_ms)
VALUES (
    'e0000000-0000-4000-8000-000000000003',
    X'2A2B2C2D2E2F303132333435363738393A3B3C3D3E3F40414243444546474849',
    'HXjeIfawPJ66XnvJm1ILnBC3FLjKSog2Fc9Bnk8NAx8',
    'S256',
    'ecoma-fixture-oidc-client',
    'https://app.fixture.invalid/callback',
    NULL,
    '["openid","profile"]',
    1750003600000,
    1750000000000
);

-- ===========================================================================
-- FLOW 4 — A FLOW FOR THE PUBLIC CLIENT, with no secret
-- ===========================================================================
--
-- code_verifier: 'fixture-verifier-four-which-is-43-characters-minimum-ww'
--                (55 characters)
-- code_challenge: d5hvaOCFFirotG7pFhXzD9YMwVo6Q2e7gws3notPCx8
--
-- APP 3 is `client_secret_hash IS NULL`, and this row is what an authorisation
-- request from a public client looks like: the code verifier is the ONLY thing
-- binding the token request to the authorisation request, because there is no
-- client secret to check. That is the entire reason PKCE exists for public
-- clients, and it is why the schema refuses `code_challenge_method != 'S256'`
-- rather than treating PKCE as optional.
--
-- `redirect_uri` is the SPA's, which is a single-element registered array on
-- that application — so the exact-match comparison at redemption has something to
-- compare against and cannot accidentally succeed against the OIDC client's URI.
INSERT INTO pkce_challenges (id, code_hash, code_challenge, code_challenge_method,
                              client_id, redirect_uri, user_id, scopes, expires_at_ms)
VALUES (
    'e0000000-0000-4000-8000-000000000004',
    X'003A3B3C3D3E3F40414243444546474849505152535455565758596061626364',
    'd5hvaOCFFirotG7pFhXzD9YMwVo6Q2e7gws3notPCx8',
    'S256',
    'ecoma-fixture-public-client',
    'https://spa.fixture.invalid/callback',
    'f0000000-0000-4000-8000-000000000002',
    '["openid","profile","email"]',
    1893456000000
);

-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ===========================================================================
--
-- No row with `code_challenge_method = 'plain'`. It is refused by the CHECK, and
-- a fixture file containing one would abort. The demonstration belongs in
-- `tests/integration/schema.test.mjs`.
--
-- No row whose `code_hash` duplicates another. `ux_pkce_challenges_code_hash` is
-- UNIQUE, and the same rule as `user_identities.sql` applies: the colliding row
-- would abort the file, so the single existing claim is what a test collides
-- with.
--
-- No `code_verifier` COLUMN and no value that could become one — the verifier
-- strings above are comments, not data. RFC 7636's verifier NEVER REACHES THE
-- DATABASE. `PkceService::verify` computes BASE64URL(SHA256(verifier)) in memory
-- and compares it against the `code_challenge` column in constant time. A column
-- for it would create a second copy of a secret whose entire purpose is to be
-- known to exactly two parties.
--
-- No `oauth_authorization_codes` table and no row in one, because there is no
-- `AuthorizationCode` type in this architecture. Inventing a table for a type that
-- does not exist would be a schema claiming a capability — which is why
-- `code_hash` here has NO FOREIGN KEY, with the comment saying where its target
-- goes when that table is written.
