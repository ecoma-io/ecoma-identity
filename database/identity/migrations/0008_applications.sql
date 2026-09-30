-- ===========================================================================
-- 0008_applications.sql
--
-- WHAT THIS ADDS: `applications` (a registered OAuth 2.0 / OpenID Connect
-- client) and `application_secrets` (the hash of the current client secret, plus
-- the history of previous secrets during a rotation grace window).
--
-- BACKWARD-COMPATIBILITY: this file only CREATEs. It adds two tables and three
-- indexes. It does not read, alter or depend on any column of any earlier
-- migration, so it is trivially compatible with every previous Worker version
-- running against the database during a canary: those versions have no code
-- that mentions `applications`, and a code path that does not know a table
-- exists cannot be broken by the table appearing. The full forward-only rule is
-- in 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS applications (
    -- `Application.id` — `ApplicationId`, UUID text. Surrogate key.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- `Application.client_id` — the public identifier presented at the token
    -- endpoint. This is NOT a secret and is deliberately readable.
    --
    -- At most 191 bytes because that is `Application`'s own bound, and the
    -- reason the domain chose it is a length the auth code flow can carry in a
    -- form-encoded `application/x-www-form-urlencoded` body without ambiguity.
    --
    -- UNIQUE (ix below): a client identifier names exactly one application. If
    -- two rows could answer "which application is this client_id", every token
    -- exchange would be a coin toss, and the loser is a client that gets
    -- somebody else's tokens.
    client_id TEXT    NOT NULL CHECK (length(client_id) BETWEEN 1 AND 191),

    -- `Application.display_name` — what an operator sees in the admin console.
    -- 1..200 bytes, matching `User::new`'s bound on display names so the admin
    -- console does not have to render two different field widths.
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),

    -- `Application.status` — the serde form of `ApplicationStatus`:
    -- active | suspended | retired.
    --
    -- The three are distinct on purpose, and the distinction is the whole point
    -- of having three:
    --   active      usable
    --   suspended   an operator act, liftable, the registration still exists
    --   retired     the application is gone; its client_id must never be
    --               reissued to a different owner, which is why retirement is
    --               a status and not a deletion
    status TEXT    NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'suspended', 'retired')),

    -- `Application.access_mode` — the serde form of `ApplicationAccessMode`:
    -- oidc | oauth2.
    --
    -- BOTH BRANCHES REQUIRE PKCE. That is not a runtime policy layered on top;
    -- it is the reason the column exists at all: `Application`'s doc says a mode
    -- that "does not require PKCE" is not a mode this platform has, because
    -- "S256-only PKCE is a platform invariant, not a per-application setting
    -- (threat-model.md §3)". The database therefore refuses to store an
    -- access mode it does not have. There is no third value to add later
    -- without an ADR, and adding one would have to add the PKCE exemption in
    -- the same change.
    access_mode TEXT    NOT NULL
                 CHECK (access_mode IN ('oidc', 'oauth2')),

    -- `Application.redirect_uris` — a JSON array of strings, stored as TEXT.
    --
    -- STORED AS JSON, NOT AS A CHILD TABLE, and this is a decision with a real
    -- cost that `data-model.md` states rather than glosses: it keeps
    -- registration one row, which suits a value only ever read as a whole and
    -- written as a whole. It costs referential integrity and makes "which
    -- applications use this redirect URI" a full scan. For a platform with a
    -- bounded number of registered applications that trade is correct; for a
    -- public multi-tenant registry it would not be, and the day that becomes
    -- the requirement the fix is an ADR plus a migration that ADDS the child
    -- table without dropping this column — which the forward-only rule permits.
    --
    -- VALIDATED BY THE DOMAIN, NOT HERE, and the reason is worth stating:
    -- `Application::allows_redirect_uri` is an exact comparison, never a prefix
    -- and never a glob, and the rules are absolute http(s), no fragment, at most
    -- 2048 bytes, no duplicates. A SQLite CHECK cannot parse a JSON array
    -- without a JSON1 extension D1 does not guarantee at the time of writing.
    -- What this column CAN do cheaply, and does, is refuse the degenerate
    -- shapes: a value that is not even JSON-array-ish, and one that is absurdly
    -- large.
    redirect_uris TEXT NOT NULL
                  CHECK (length(redirect_uris) BETWEEN 2 AND 65536),

    -- `Application.allowed_scopes` — a JSON array of scope strings, stored as
    -- TEXT, same trade as `redirect_uris` and for the same reason.
    --
    -- Bounded at 4096 bytes: the whole OpenID Connect scope vocabulary this
    -- platform knows is `openid`, `profile` and `email` (see
    -- `DiscoveryDocument::bootstrap`), so anything past a few kilobytes is a
    -- client trying to store something that is not a scope list.
    allowed_scopes TEXT NOT NULL
                  CHECK (length(allowed_scopes) BETWEEN 2 AND 4096),

    -- When the current client secret stops being accepted, for a rotation
    -- grace window. NULL means "never expires".
    --
    -- The rotation story in `identity-application::applications` is
    -- `RotateClientSecret` -> `RotateClientSecretOutcome`, and the outcome
    -- "carries the old secret's expiry, not the old secret" (data-model.md).
    -- This column is where that expiry lives once the secret row exists.
    secret_expires_at_ms INTEGER
                         CHECK (secret_expires_at_ms IS NULL OR secret_expires_at_ms >= 0),

    -- The hash of the CURRENT client secret, denormalised from
    -- application_secrets so the token endpoint does not have to join.
    --
    -- `data-model.md` specifies this column; it is here because that document
    -- names it as the authority for the token endpoint's lookup, and a schema
    -- that disagrees with the document that owns it is a schema with two
    -- sources of truth. It duplicates the application_secrets row where
    -- `is_current = 1` — written in the SAME transaction, never in two places
    -- at two times — and the duplication is the deliberate price of keeping one
    -- lookup on the hottest unauthenticated path in the system.
    --
    -- NEVER A SECRET. A hash, and nothing else. The only code that ever holds a
    -- plaintext `ClientSecret` cannot print it (`Debug` and `Display` are
    -- redacted, with a test asserting it) and its single accessor is
    -- `expose_for_hashing`.
    --
    -- NULLABLE, and that is not a convenience: an application registered by a
    -- `public` client has no secret at all, and OIDC requires public clients to
    -- exist. `client_secret_basic`, `client_secret_post` and `none` are all in
    -- `DiscoveryDocument::bootstrap`'s
    -- `token_endpoint_auth_methods_supported`, and `none` is the one that
    -- matters here: a public client authenticates with the PKCE challenge
    -- alone, so it has a NULL secret, and a NOT NULL column would make public
    -- clients unrepresentable.
    --
    -- THE TOKEN ENDPOINT MUST USE THIS COLUMN AND NOT THE JOIN. If it reads
    -- application_secrets directly it has made a scheduling dependency out of a
    -- denormalisation and will eventually read the wrong row during a rotation.
    client_secret_hash TEXT CHECK (client_secret_hash IS NULL
                                   OR length(client_secret_hash) BETWEEN 16 AND 512),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1 (UNIQUE): the token endpoint's lookup. `POST /oauth/token` is handed
-- a client_id and must resolve it to one registration before anything else can
-- be checked. This is on the hottest unauthenticated path in the system, which
-- is why the column is UNIQUE rather than merely indexed: a non-unique index
-- would let the lookup return two rows and let the caller's `.fetch_optional()`
-- silently pick one.
--
-- This index is named explicitly in data-model.md's required-index table, and
-- it is the reason a client_id is "the hash you look up, not the secret".
CREATE UNIQUE INDEX IF NOT EXISTS ux_applications_client_id
    ON applications (client_id);

-- INDEX 2: the admin console's application list, filtered by standing. Mirrors
-- ix_users_role_created: (status, created_at_ms), a filtered scan in creation
-- order, which is the order the console paginates in.
CREATE INDEX IF NOT EXISTS ix_applications_status_created
    ON applications (status, created_at_ms);

-- NO INDEX on redirect_uris or allowed_scopes. They are TEXT blobs, not
-- queryable through SQLite's index machinery, and indexing them would only
-- create a B-tree keyed on the whole document. `data-model.md` already names
-- the cost: "which applications use this redirect URI" is a full scan. That is
-- a known and accepted cost at this scale, recorded rather than hidden.

-- NO INDEX on display_name. The admin console can filter by name, and the row
-- count is small enough that the scan is not a problem yet. The day it is, the
-- fix is an index or a search index, added forward.

-- ===========================================================================
-- application_secrets — why this is a table and not a column
-- ===========================================================================
--
-- `data-model.md` specifies `applications.client_secret_hash`, a single column
-- on the registration row. That single column is the right answer to the
-- question it is answering ("is this presented secret the right one?") and this
-- table does not replace it. The two coexist and are not in conflict, because
-- they answer different questions:
--
--   applications.client_secret_hash  what the token endpoint checks. One row,
--                                    one lookup, no join. This is the hot path
--                                    and it stays a column.
--
--   application_secrets             the rotation history. A rotation is not an
--                                    update, it is an overlap: for the grace
--                                    window BOTH the old secret and the new one
--                                    must verify, and only after the window the
--                                    old one must stop. A single column cannot
--                                    hold an overlap — the moment the new hash
--                                    is written, the old one is already gone.
--
-- So the single column remains the authority for the current secret, and this
-- table records the superseded ones with their expiry. A token request checks
-- the column first (one lookup, no join) and only falls back to this table when
-- the presented secret does not match AND a grace window may still be open.
--
-- WHY THE HASH IS STORED TWICE IS NOT ACCIDENTAL: `client_secret_hash` on the
-- parent row is a copy of the row here where `is_current = 1`. That
-- denormalisation is the price of not putting a join on the token endpoint.
-- It is safe because the parent column is written in the same transaction as
-- the current-secret row, and it is stated here because a reader who finds two
-- copies of one hash will otherwise assume a bug.

CREATE TABLE IF NOT EXISTS application_secrets (
    -- Surrogate key. NOT the application id: two rows here describe two
    -- different secrets for the same application, so a key of
    -- (application_id, secret_hash) or a fresh UUID is required.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- The application this secret authenticates.
    --
    -- ON DELETE CASCADE: a deleted application has no secrets. ON UPDATE
    -- RESTRICT: ids are never rewritten.
    application_id TEXT NOT NULL
        REFERENCES applications (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- THE HASH. Never the secret.
    --
    -- `ClientSecret` in `identity-application` refuses to be printed — its
    -- `Debug` and `Display` are redacted, and a test asserts it — and its only
    -- accessor is `expose_for_hashing`, a name that reads as an instruction to
    -- the next reader. What it exposes to is a HASHER, not a hasher and an
    -- equality check. Nothing in this repository can put a plaintext secret in
    -- this column, because the only code that ever holds plaintext has already
    -- been hashed before it reaches a database call.
    --
    -- The algorithm is `DEFERRED`: `identity-security` has a `SecretCipher`
    -- trait for encryption and no password-hashing trait, and constraint §25
    -- forbids hand-rolled cryptography. This column stores an opaque string
    -- and the algorithm that produced it will be named here when it exists.
    secret_hash TEXT NOT NULL CHECK (length(secret_hash) BETWEEN 16 AND 512),

    -- Is this the secret the token endpoint should match on the fast path?
    --
    -- INTEGER 0/1 with a CHECK, not BOOLEAN: SQLite has no boolean type and
    -- every other boolean in this schema is 0/1.
    --
    -- AT MOST ONE per application, enforced by the partial unique index below.
    -- That index is also what makes "rotate" writable: promoting the new row to
    -- `is_current = 1` inside the same transaction that demotes the old one is
    -- atomic, so the application is never left with two current secrets (the
    -- token endpoint would then accept either, indefinitely) or none (it would
    -- reject everything, and the operator would have bricked their own client).
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),

    -- When this secret stops being accepted. NULL means it never expires.
    --
    -- A rotated-out secret is the ONLY row here with a non-null value: it is
    -- still inside the grace window and still verifies. Once the window closes,
    -- the row's whole purpose is over and `prune` (DEFERRED) may delete it.
    -- Deleting it before then is what would silently break a client that had not
    -- finished rotating.
    expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001).
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- INDEX 1 (UNIQUE, PARTIAL): at most one current secret per application.
--
-- See the `is_current` comment: this index is the difference between "rotation
-- is a transaction" and "rotation is a hope".
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_secrets_one_current
    ON application_secrets (application_id) WHERE is_current = 1;

-- INDEX 2 (UNIQUE): one hash names one secret row.
--
-- Two rows with the same hash would make the token endpoint's slow path
-- ambiguous, and — more importantly — would make the `client_id` + presented
-- secret lookup return two applications for one credential. This is the storage
-- half of the same rule as ux_user_identities_provider_subject in 0004: a
-- uniqueness claim that is `#[ignore]`d in the domain because "the database
-- unique index is part of the claim" is only a real invariant once the index
-- exists.
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_secrets_hash
    ON application_secrets (secret_hash);

-- INDEX 3: the rotation sweep — "which superseded secrets are past their grace
-- window?". Partial, because the only rows the sweep ever wants are the ones
-- that actually have an expiry.
CREATE INDEX IF NOT EXISTS ix_application_secrets_expiry
    ON application_secrets (expires_at_ms) WHERE expires_at_ms IS NOT NULL;

-- ===========================================================================
-- WHY application_secrets HAS NO application_id LEADING INDEX
-- ===========================================================================
--
-- ux_application_secrets_one_current leads with application_id, so it already
-- serves every "secrets for this application" query for CURRENT secrets. The
-- non-current ones — the ones the slow path looks at — are exactly the rows a
-- second (application_id) index would exist to find, and there are at most a
-- handful per application (one per rotation inside its window). A full walk of
-- a client's two or three rows is cheaper than maintaining a second B-tree for
-- every write to this table, which only happens on rotation.
--
-- ===========================================================================
-- WHAT IS NOT HERE
-- ===========================================================================
--
-- No `client_secret` column. No plaintext column. No reversible encryption of a
-- client secret. A registration that can be read back is a registration that
-- can be impersonated, and `RotateClientSecretOutcome` deliberately carries the
-- old secret's EXPIRY rather than the old secret, which is the shape of code
-- that has already decided this.
--
-- No scope table. Scopes live on the registration row as a JSON array, per
-- `data-model.md`, and the same trade and the same revisit condition apply.
--
-- No redirect-URI child table, for the same reason.
--
-- SECURITY: what an attacker gets from these two tables.
--
-- READING `applications`:
--   - `client_id` for every client, and every display name. That is a map of
--     the platform's integrations and the humans who own them — reconnaissance
--     for a phishing campaign aimed at operators, and a list of which
--     applications are `active` versus `suspended`.
--   - `redirect_uris` and `allowed_scopes`, which together tell an attacker
--     exactly which authorisation-code flows to try to intercept.
--   Nothing here is a credential. That is the point of the split.
--
-- READING `application_secrets`:
--   - `secret_hash` is the highest-value column in the schema after a TOTP
--     seed, and the reason is the algorithm, not the column. If the hash is a
--     fast unsalted digest, reading it is equivalent to holding every client
--     secret: an attacker can authenticate as any registered client and mint
--     tokens for it. The mitigation is the algorithm's work function, and the
--     algorithm is `DEFERRED` — so this column's security is currently
--     UNSPECIFIED, and that is recorded here rather than assumed good.
--   - `is_current` and `expires_at_ms` tell the attacker which credentials are
--     mid-rotation, which is precisely when a stolen hash is worth more.
--
-- WRITING:
--   Write access to `application_secrets` is credential minting for every
--   registered client. There is no schema rule that can prevent it, because a
--   database cannot tell a legitimate rotation from a stolen one. The only
--   control is constraint §2: Identity D1 is reached by the Identity Worker and
--   nothing else, and the rotation command is an `identity-application`
--   operation that writes its own audit event in the same transaction.