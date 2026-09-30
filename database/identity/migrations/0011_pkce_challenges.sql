-- ===========================================================================
-- 0011_pkce_challenges.sql
--
-- WHAT THIS ADDS: `pkce_challenges` — an outstanding S256 code challenge, held
-- between `GET /oauth/authorize` and `POST /oauth/token`.
--
-- WHY THIS IS A TABLE AND NOT A COLUMN ON A CODE: because in the authorisation
-- code flow the code itself is not a row in this schema. There is no
-- `authorization_codes` table, because the architecture has no
-- `AuthorizationCode` type and inventing a table for a type that does not exist
-- would be a schema that claims a capability. What exists — and what
-- `identity-security` names — is a `PkceService` with `derive_challenge` and
-- `verify`, and the challenge has to be remembered between two requests made by
-- two different endpoints.
--
-- WHERE THE RUST PUTS THIS: `identity_security::tokens::PkceService` and
-- `NonceService`. Neither type appears in `identity-security`'s own structs —
-- they are TRAITS, and the trait doc is the contract the table serves:
-- `verify(challenge, verifier)` compares BASE64URL(SHA256(verifier)) against the
-- challenge in constant time, and `derive_challenge` refuses a verifier outside
-- "the RFC 7636 length range of 43–128 characters".
--
-- BACKWARD-COMPATIBILITY: additive only. CREATEs one table and two indexes, adds
-- no column to any existing table, references nothing. A Worker version from
-- before this file ran never mentions this table and cannot be broken by its
-- appearing. Full rule: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS pkce_challenges (
    -- Surrogate key.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- The hash of the authorisation code this challenge belongs to.
    --
    -- THE CODE IS NEVER STORED. A delivered code is a live credential for the
    -- space of one token exchange, and the storage rule for this schema is that
    -- anything a holder can replay is stored hashed — the same rule
    -- `otp_challenges.code_hash` follows in 0007, for the same reason and with
    -- the same honesty note about a fast hash on a low-entropy secret.
    --
    -- NO FOREIGN KEY, because there is no `authorization_codes` table to point
    -- at. That is stated here rather than papered over with a table: the code
    -- row does not exist yet, and this column is where its key will go when it
    -- does. Adding the table later is a pure ADD under the forward-only rule.
    code_hash BLOB NOT NULL CHECK (length(code_hash) BETWEEN 32 AND 64),

    -- `code_challenge` — BASE64URL(SHA256(code_verifier)), as sent by the client
    -- on the authorisation request.
    --
    -- STORED IN THE CLEAR, and the reason is worth being precise about, because
    -- it looks wrong next to a hashed code column. RFC 7636 §4.2: "the
    -- authorization server ... stores the code challenge". The challenge is not
    -- a secret — it is published in the authorization request, which by
    -- definition travels through the browser and the redirect URI. Anyone who
    -- can read it still cannot produce a verifier that hashes to it. What is
    -- secret is the VERIFIER, and the verifier never reaches this database at
    -- all: it arrives at the token endpoint, is hashed, and is compared.
    code_challenge TEXT NOT NULL CHECK (length(code_challenge) BETWEEN 43 AND 128),

    -- `code_challenge_method`. There is exactly one legal value.
    --
    -- CHECKed rather than defaulted. `SUPPORTED_CODE_CHALLENGE_METHOD` in
    -- `identity-oidc` is "S256", `DiscoveryDocument::bootstrap`'s
    -- `code_challenge_methods_supported` is ["S256"], and `PkceService::verify`'s
    -- doc says "plain is not implemented, because the discovery document does
    -- not advertise it".
    --
    -- A `plain` challenge is BASE64URL(verifier) — the verifier itself, sent in
    -- the clear through the browser. Allowing one here would make the whole
    -- mechanism decorative for any client that asked for it. Making this a
    -- CHECK and not a constant column is deliberate: `PRAGMA table_info` should
    -- be able to tell a reader that the invariant is stored, not merely
    -- conventional.
    code_challenge_method TEXT NOT NULL DEFAULT 'S256'
                         CHECK (code_challenge_method = 'S256'),

    -- The client this challenge was issued to.
    --
    -- NO FOREIGN KEY to `applications.client_id`, and this is deliberate rather
    -- than an oversight. `client_id` is UNIQUE, so a foreign key would work
    -- mechanically — but the token endpoint's flow is: resolve the code, find
    -- its challenge, THEN resolve the client, and it must confirm the client it
    -- was given is the client the challenge was issued to. Storing the client
    -- identifier itself makes that comparison a row-to-row check in the same
    -- query, instead of a second lookup whose ordering a bug could get wrong.
    -- A code redeemed by a different client is a code stolen from another
    -- client, and the database is where that mismatch is refused.
    client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 191),

    -- The redirect URI the authorisation request carried.
    --
    -- STORED BECAUSE RFC 7636 AND RFC 6749 §4.1.3 BOTH REQUIRE IT: if the
    -- redirect_uri was included in the authorization request, the token request
    -- MUST include an identical one, or the server MUST refuse. `Application::
    -- allows_redirect_uri` is exact-match only — "a registered
    -- https://app.example.com/ does not license
    -- https://app.example.com/steal" — and this column is what the comparison
    -- is made against, so the token endpoint is comparing a request value
    -- against the value the authorization request actually carried, not merely
    -- against the registered set. Bounded at 2048, which is `Application`'s own
    -- bound on a redirect URI.
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),

    -- The user who authenticated during the authorisation request, or NULL when
    -- nobody did.
    --
    -- NULLABLE, and NULL IS THE NORMAL CASE IN THIS FLOW: the authorisation
    -- endpoint may stop at the login redirect and the challenge outlives the
    -- user's absence. `StartEmailLoginOutcome`'s two variants (`CodeSent` and
    -- `Accepted`) exist so the response is identical whether or not the address
    -- is registered, and this column's nullability is the storage half of the
    -- same tolerance. Nothing downstream may branch on whether it is NULL in a
    -- way that is observable to the caller.
    user_id TEXT REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- The scopes the client asked for, as a JSON array. Same shape and same
    -- "read as a whole, written as a whole" trade as `applications.
    -- allowed_scopes` in 0008.
    scopes TEXT NOT NULL CHECK (length(scopes) BETWEEN 2 AND 4096),

    -- When this challenge stops being usable, integer milliseconds since the
    -- epoch.
    --
    -- THIS IS A DEADLINE, NOT A DURATION, and `Session`'s doc gives the reason
    -- to state it that way for every deadline in this schema: "a duration stored
    -- on the row would make 'when does this expire' depend on when you asked".
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),

    -- Has it been spent?
    --
    -- NULL until the token endpoint redeems the code, then a timestamp. The
    -- rule is the same single-statement conditional update as
    -- `otp_challenges.consumed_at` in 0007, and for the same reason: a
    -- SELECT followed by an UPDATE is a race with extra steps. The exact SQL is
    -- in 0007's header comment and it applies here verbatim, because the
    -- property is identical — one authorisation code, one token exchange.
    --
    -- What is different here is the OBJECT. An OTP is a possession proof and
    -- replaying it is an authentication bypass; an authorisation code replay
    -- after a legitimate exchange is the code-replay case RFC 6749 §10.5 exists
    -- to make visible, and the threat model is that a stolen code beats a
    -- one-time-use rule. The row is not deleted on redemption for the same
    -- reason 0007's is not: the evidence is worth more than the space.
    consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: the token endpoint's lookup. "Which challenge does this code belong
-- to?" is the first query of an exchange and it is keyed on `code_hash`, a
-- BLOB. UNIQUE, because two challenges for one code would make the redemption
-- ambiguous, and an ambiguous redemption is a token issued against a challenge
-- the client never proved.
--
-- The single hottest authenticated path in the system, and it is why this is a
-- UNIQUE index and not a plain one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pkce_challenges_code_hash
    ON pkce_challenges (code_hash);

-- INDEX 2: "which outstanding challenges does this user have?" — the
-- authorisation screen's outstanding-request list, and the sweep for abandoned
-- flows.
--
-- PARTIAL (WHERE consumed_at IS NULL), because a redeemed challenge is never
-- queried by user again and must not occupy the index. The same reasoning as
-- ix_otp_challenges_user in 0007.
CREATE INDEX IF NOT EXISTS ix_pkce_challenges_user
    ON pkce_challenges (user_id) WHERE consumed_at IS NULL;

-- INDEX 3: the expiry sweep — "which challenges have outlived their window?"
--
-- PARTIAL on the same reasoning: the sweep only ever wants un-redeemed rows,
-- and the redeemed ones are evidence, not work.
CREATE INDEX IF NOT EXISTS ix_pkce_challenges_expiry
    ON pkce_challenges (expires_at_ms) WHERE consumed_at IS NULL;

-- NO INDEX on client_id. No query asks "every outstanding challenge for this
-- client"; the client is checked as a value on the row the token endpoint
-- already found by `code_hash`.
--
-- NO INDEX on code_challenge. It is stored in the clear and read by primary-key
-- lookup; a B-tree over it would make a public value look like a lookup key and
-- invite someone to build a query on it.
--
-- NO INDEX on scopes, a JSON array, for the same reason as 0008.

-- ===========================================================================
-- THE VERIFIER NEVER REACHES THIS TABLE
-- ===========================================================================
--
-- The most important thing to say about this schema is a negative. The
-- `code_verifier` from `POST /oauth/token` is never persisted, not even hashed.
-- `PkceService::verify(challenge, verifier)` computes BASE64URL(SHA256(verifier))
-- in memory and compares it against the `code_challenge` column in constant
-- time. There is no column for it because a column for it would create a second
-- copy of a secret whose entire purpose is to be known to exactly two parties.
--
-- This is also why `code_hash` and `code_challenge` are different things and
-- both exist. The code hash answers "which outstanding flow is this?"; the
-- challenge answers "did this party prove it?" They have different lifetimes, so
-- they get different columns, and a migration that merged them would have to
-- keep one of them alive too long.
--
-- The constant-time comparison is `identity-security`'s and cannot be
-- implemented here: constraint §25 forbids hand-rolled cryptography and a
-- database string comparison is not constant-time. SQLite's `=` on two TEXT
-- values is an early-exit memcmp, and a timing side channel on a PKCE verifier
-- is a real attack — but it is an attack on a value that expires in the length
-- of one authorisation flow and is only ever compared once. The rule that
-- actually protects this is architectural: there is no constant-time primitive
-- in the database, so the comparison must happen in Rust, and the column layout
-- above is arranged so the value handed to Rust is the one and only copy.

-- SECURITY: what an attacker gets from this table.
--
--   - `code_hash` and a stolen `code_challenge` together are NOT enough to
--     redeem anything: the verifier is the secret, and it is not here.
--   - `redirect_uri` plus `scopes` plus `user_id` on an un-consumed row is a
--     complete description of an authorisation flow that is in flight RIGHT
--     NOW — a target, a window, and the person who is about to approve it.
--     That is a live phishing kit for a redirect-URI interception attack, and it
--     is the reason these rows must be short-lived.
--   - `expires_at_ms` is bounded by the same TTL the OAuth spec calls for on
--     authorization codes, and this table has no column to make it longer.

-- FIXTURE CONSEQUENCE: an integration fixture for the "a code cannot be
-- redeemed twice" test needs a pkce_challenges row with `consumed_at IS NULL`
-- and an `expires_at_ms` in the future. A fixture with `consumed_at` already set
-- would make the test pass by proving that a consumed row stays consumed, which
-- is not the claim. See database/identity/fixtures/.