-- ===========================================================================
-- applications.sql — one row per `ApplicationStatus`, one per
-- `ApplicationAccessMode`, and a public client with no secret at all.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- 1. `ApplicationStatus` is `Active | Suspended | Retired`, and the three are
--    distinct for a reason worth restating: "suspended an operator act that can
--    be lifted, retired the application is gone; its client_id must never be
--    reissued to a different owner, which is why retirement is a status and not
--    a deletion". All three appear below.
--
-- 2. `ApplicationAccessMode` is `Oidc | OAuth2` and BOTH REQUIRE PKCE. There is
--    no third value in the schema's CHECK, and that is the point: "S256-only
--    PKCE is a platform invariant, not a per-application setting". A fixture set
--    that only contained an OIDC application would let a schema CHECK written for
--    one value pass, so both modes are here.
--
-- 3. THE PUBLIC CLIENT. `client_secret_hash` is NULLABLE, and it has to be: OIDC
--    requires public clients to exist, and `DiscoveryDocument::bootstrap`'s
--    `token_endpoint_auth_methods_supported` is
--    ["client_secret_basic", "client_secret_post", "none"], where `none` is a
--    public client authenticating with the PKCE challenge alone. A NOT NULL
--    column would make public clients unrepresentable.
--
-- 4. THE ROTATION HISTORY. `application_secrets.sql` has a superseded secret
--    inside its grace window, and this file's ROTATED application's parent row is
--    the one whose `client_secret_hash` must equal the `is_current = 1` row and
--    NOT the expired one. That relationship is what
--    `assert_fixture_invariants.sql` checks.
-- ===========================================================================

-- ===========================================================================
-- APP 1 — ACTIVE, OIDC, CONFIDENTIAL
-- ===========================================================================
--
-- `access_mode = 'oidc'`, so `openid` is in scope and an ID token is issued.
-- That is the only difference between this row and APP 2 as far as the schema is
-- concerned — the column records the mode and the difference is enforced
-- elsewhere.
--
-- THE CLIENT SECRET HASHES BELOW ARE READABLE PLACEHOLDER STRINGS AND NOT
-- DIGESTS OF ANYTHING. The hash algorithm is `DEFERRED` (see 0008's column
-- comment: `identity-security` has a `SecretCipher` trait for encryption and no
-- password-hashing trait, and constraint §25 forbids hand-rolled
-- cryptography), so no hasher exists in this repository that could produce a real
-- hash. A fixture containing something that looked like a real digest would be
-- claiming a capability the platform does not have.
--
-- What these values DO exercise is the shape the schema checks — a non-empty
-- opaque string between 16 and 512 characters — and the uniqueness rules around
-- them. `application_secrets.sql` asserts that the rotating application's
-- `client_secret_hash` equals its `is_current = 1` row and not its superseded
-- one, which is the relationship that makes the denormalisation worth having.
--
-- `redirect_uris` and `allowed_scopes` are JSON arrays stored as TEXT. They are
-- '["..."]' rather than a bare string because the column has to hold a list, and
-- `CHECK (length(...) BETWEEN 2 AND 65536)` refuses an empty string. The JSON
-- is not parsed by the schema — the redirect URI rules are enforced by
-- `Application::allows_redirect_uri`, which is exact-match, never a prefix and
-- never a glob.
--
-- The redirect URIs use RFC 2606 reserved names (`example.com`,
-- `fixture.invalid`) so no fixture can ever be a live callback.
INSERT INTO applications (id, client_id, client_secret_hash, display_name,
                           status, access_mode, redirect_uris, allowed_scopes,
                           secret_expires_at_ms)
VALUES (
    '80000000-0000-4000-8000-000000000001',
    'ecoma-fixture-oidc-client',
    'fixture-app1-oidc-client-secret-hash-0001',
    'Fixture OIDC Client',
    'active',
    'oidc',
    '["https://app.fixture.invalid/callback","http://localhost:8080/callback"]',
    '["openid","profile","email"]',
    NULL
);

-- ===========================================================================
-- APP 2 — ACTIVE, OAUTH2, CONFIDENTIAL
-- ===========================================================================
--
-- Same client shape, different access mode. `allowed_scopes` has NO `openid`,
-- because `openid` is what makes a request an OIDC request and an OAuth2-only
-- client has no ID token. That is the whole semantic difference the column
-- records.
--
-- A SECOND redirect URI in the same array, because a single-element array would
-- let an implementation that reads only the first element pass every test in
-- this file.
INSERT INTO applications (id, client_id, client_secret_hash, display_name,
                           status, access_mode, redirect_uris, allowed_scopes,
                           secret_expires_at_ms)
VALUES (
    '80000000-0000-4000-8000-000000000002',
    'ecoma-fixture-oauth2-client',
    'fixture-app2-oauth2-client-secret-hash-0001',
    'Fixture OAuth2 Client',
    'active',
    'oauth2',
    '["https://api.fixture.invalid/callback","https://api.fixture.invalid/v2/callback"]',
    '["profile","email"]',
    NULL
);

-- ===========================================================================
-- APP 3 — ACTIVE, OIDC, PUBLIC: NO SECRET AT ALL
-- ===========================================================================
--
-- `client_secret_hash IS NULL`, and the schema permits it. This is the row that
-- makes the column nullable rather than an oversight, and a fixture set without
-- it would let a NOT NULL column — which would make every public OIDC client
-- unrepresentable — pass.
--
-- The application therefore authenticates with the PKCE challenge alone
-- (`token_endpoint_auth_method = none`). A SPA or a mobile app is this row.
INSERT INTO applications (id, client_id, client_secret_hash, display_name,
                           status, access_mode, redirect_uris, allowed_scopes,
                           secret_expires_at_ms)
VALUES (
    '80000000-0000-4000-8000-000000000003',
    'ecoma-fixture-public-client',
    NULL,
    'Fixture Public OIDC Client',
    'active',
    'oidc',
    '["https://spa.fixture.invalid/callback"]',
    '["openid","profile","email"]',
    NULL
);

-- ===========================================================================
-- APP 4 — SUSPENDED
-- ===========================================================================
--
-- An administrative act that can be lifted. The registration still exists, so
-- the client_id is still taken and still refuses; what changes is whether a
-- token endpoint accepts it.
--
-- It KEEPS a client_secret_hash, because suspension is not revocation: a
-- suspended application that has been reactivated should not need its secret
-- rotated as a side effect of somebody else's mistake. `secret_expires_at_ms`
-- is NULL — never expires — so there is no time bomb hiding behind the
-- suspension.
INSERT INTO applications (id, client_id, client_secret_hash, display_name,
                           status, access_mode, redirect_uris, allowed_scopes,
                           secret_expires_at_ms)
VALUES (
    '80000000-0000-4000-8000-000000000004',
    'ecoma-fixture-suspended-client',
    'fixture-app4-suspended-client-secret-hash-01',
    'Fixture Suspended Client',
    'suspended',
    'oidc',
    '["https://suspended.fixture.invalid/callback"]',
    '["openid","profile"]',
    NULL
);

-- ===========================================================================
-- APP 5 — RETIRED
-- ===========================================================================
--
-- The distinction `data-model.md` insists on: retirement is a STATUS, not a
-- deletion, and that is what keeps this client_id from ever being reissued to a
-- different owner. A deleted application row would leave the client_id free for
-- anybody to claim, and a client_id that has been reissued is a client whose old
-- tokens now belong to somebody else.
--
-- No `secret_expires_at_ms` either — a retired application has no secret
-- rotation to schedule.
INSERT INTO applications (id, client_id, client_secret_hash, display_name,
                           status, access_mode, redirect_uris, allowed_scopes,
                           secret_expires_at_ms)
VALUES (
    '80000000-0000-4000-8000-000000000005',
    'ecoma-fixture-retired-client',
    'fixture-app5-retired-client-secret-hash-00001',
    'Fixture Retired Client',
    'retired',
    'oauth2',
    '["https://retired.fixture.invalid/callback"]',
    '["profile"]',
    NULL
);

-- ===========================================================================
-- APP 6 — ACTIVE, OAUTH2, WITH A SECRET EXPIRING INSIDE ITS ROTATION WINDOW
-- ===========================================================================
--
-- THE ROW `application_secrets.sql`'s history hangs off, and the one that makes
-- the denormalisation worth having checkable.
--
-- `client_secret_hash` holds the CURRENT secret's hash. `application_secrets`
-- holds BOTH secrets: one `is_current = 1` (whose `secret_hash` MUST equal this
-- column) and one `is_current = 0` with an `expires_at_ms` in the future — the
-- superseded secret still inside its grace window.
--
-- `secret_expires_at_ms` on THIS row is the boundary the grant is measured
-- against, and it is set to the same instant as the superseded secret's expiry so
-- the two files cannot disagree about when the window closes.
--
-- WHY BOTH EXIST, restated because it is the question the pair invites: a
-- rotation is an OVERLAP, not an update. For the grace window both the old and
-- the new secret must verify, and only after the window the old must stop. A
-- single column cannot hold an overlap — the moment the new hash is written the
-- old one is gone. The column is the fast path for the token endpoint; the table
-- is the history.
INSERT INTO applications (id, client_id, client_secret_hash, display_name,
                           status, access_mode, redirect_uris, allowed_scopes,
                           secret_expires_at_ms)
VALUES (
    '80000000-0000-4000-8000-000000000006',
    'ecoma-fixture-rotating-client',
    'fixture-app6-rotating-client-NEW-secret-hash',
    'Fixture Rotating Client',
    'active',
    'oauth2',
    '["https://rotating.fixture.invalid/callback"]',
    '["profile","email"]',
    1750007200000
);

-- ===========================================================================
-- THE TWO SCOPE VOCABULARIES THIS FILE USES, and why there is no third
-- ===========================================================================
--
-- `DiscoveryDocument::bootstrap` advertises exactly ["openid", "profile",
-- "email"], so every `allowed_scopes` array above is a subset of that. A scope
-- outside that set would be a scope no discovery document declares, and the
-- schema does not CHECK for it — validating the array's contents is the domain's
-- job (`Application` bounds each scope), and a SQLite CHECK cannot read inside a
-- JSON array. Stated so the absence is a decision rather than a gap.
--
-- THE MINIMUM ARRAY IS NOT EMPTY. `granted_scopes` returns the INTERSECTION of
-- requested and registered rather than an error, "because a client asking
-- optimistically for more than it registered for should get the narrower grant
-- rather than a hard failure" — and an application registered for NO scopes is a
-- client that can never obtain a token. The schema's `length(...) BETWEEN 2 AND
-- N` refuses the empty string but not `'[]'`; whether `'[]'` is a legal
-- registration is an application-layer question this schema does not answer.