-- ===========================================================================
-- 0004_user_identities.sql
--
-- WHAT THIS IS: external and platform identities — the ways a user proves they
-- are that user. A federated OAuth provider's assertion, a passkey's user
-- handle, an email address used as a direct login factor. One user may hold
-- several.
--
-- WHAT THIS IS NOT: not a session and not a credential. This table holds the
-- FACT of linkage, never a secret material. A passkey row would hold a public
-- key (see `PasskeyCredential`, which is `deny_unknown_fields` and holds no
-- private key); an OAuth row holds a subject, which is the provider's public
-- identifier and not a secret.
--
-- WHERE THE RUST PUTS THIS: `identity_domain::identity::Identity`
-- ({ id, user_id, provider, subject, label }) and
-- `identity_application::accounts::AccountIdentity` ({ provider, subject,
-- label }). Both serde-tagged snake_case; column names below match them
-- exactly.
--
-- BACKWARD-COMPATIBILITY RULE: additive only, no DROP / RENAME / type change /
-- narrowing. No database rollback; the previous Worker version is still
-- serving traffic during a canary. Full statement: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS user_identities (
    -- `Identity.id` — `IdentityId`, UUID text. Surrogate key.
    id       TEXT    PRIMARY KEY NOT NULL,

    -- `Identity.user_id` — who this identity authenticates.
    --
    -- ON DELETE CASCADE: an identity without an owner is an orphaned assertion,
    -- and the next signup through that provider would attach to it. ON UPDATE
    -- RESTRICT: a user id is never rewritten.
    user_id  TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,

    -- `Identity.provider`, the serde form of `IdentityProvider`: oauth |
    -- passkey | email | saml.
    --
    -- `saml` is "Reserved, not implemented in bootstrap" per the enum's own
    -- doc comment. It is allowed here so a future federation is additive, but
    -- nothing writes it yet.
    provider TEXT    NOT NULL
             CHECK (provider IN ('oauth', 'passkey', 'email', 'saml')),

    -- `Identity.subject` — the provider's identifier for the user.
    --
    -- NOT NULL and 1..512 bytes, matching `Identity::new` exactly (blank and
    -- padded refused; 512 is generous — Google's `sub` is 21 — and bounded so
    -- a hostile provider cannot write an unbounded row).
    --
    -- NOT stored case-folded. A provider's subject is an opaque identifier, not
    -- an address: lowercasing it would corrupt subjects that are genuinely
    -- case-distinct. `user_emails.address` folds because it IS an address;
    -- this does not, because it is not.
    --
    -- SECURITY: this is PII in most providers' case. Google's `sub` is opaque,
    -- but a GitHub numeric id and an email-as-subject are directly identifying.
    -- `Identity`'s own doc says it: "A user's email address is often this
    -- value, which is why it is not logged." It must not appear in Worker log
    -- lines either, and `AccountIdentity` is careful to say `subject` is present
    -- in the user's OWN view and absent from every administrative view.
    subject   TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),

    -- `Identity.label` / `AccountIdentity.label` — a user-chosen name for this
    -- identity in their account's list ("Work account"). Optional, and bounded
    -- at 200 bytes when present, matching `Identity::with_label`.
    --
    -- The bound is not expressible as a column CHECK without rejecting NULL
    -- (SQLite CHECK passes on NULL), so the length test is `label IS NULL OR
    -- length(label) BETWEEN 1 AND 200`. Blank and padded labels are refused by
    -- the domain constructor; this is the backstop, not the first line.
    label     TEXT    CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the epoch.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ===========================================================================
-- INVARIANT 6 — "a user subject cannot be reused by another user".
--
-- This index IS the invariant. Not a description of it, not a first line of
-- defence behind an application check: the storage-layer enforcement point that
-- holds even when two concurrent requests race past the application.
--
-- `identity-domain`'s invariants table says the rule belongs to
-- `identity-application`'s `identities::link`, and its test for it is
-- `#[ignore]`d with the reason: "the database unique index on
-- (provider, subject) is part of the claim; until a repository exists, nothing
-- checks it." This file is that index. It is the half of the invariant that is
-- real today.
--
-- WHY THE KEY IS THE PAIR, (provider, subject), AND NEVER `subject` ALONE:
--
-- `IdentityProvider::subject_is_globally_unique` answers the question
-- directly. For Passkey it returns true — the user handle is minted by us and
-- is unique here. For OAuth, Email and Saml it returns false, with the
-- reasoning: "two providers may mint the same string."
--
-- So a user with a Google account whose subject is "12345" and a GitHub
-- account whose subject is "12345" is a normal, legitimate state. A UNIQUE
-- index on subject alone would make it impossible to link both, and — worse —
-- the correct-looking workaround, "add the provider to the subject before
-- indexing", is a re-implementation of the composite key in string form that
-- will drift. Two constraints, one on (provider, subject), one per-provider if
-- the platform ever needs one. Not one on the subject alone.
--
-- WHAT THE INDEX REFUSES:
--   INSERT of ("oauth", "12345") for user B when ("oauth", "12345") already
--   belongs to user A. That is the account-takeover shape: an attacker who can
--   get a provider to assert a subject that is already linked walks into
--   somebody else's account. `accounts::LinkIdentityCommand` documents the
--   refusal as Domain/Invalid, and names why a silent no-op is not acceptable
--   ("it would leave the user believing a link exists that does not").
--
-- WHY A UNIQUE INDEX RATHER THAN AN APPLICATION CHECK:
-- Two concurrent "link this identity" requests both read "no such identity",
-- both decide to insert, and both succeed unless the database refuses one. The
-- check-then-insert is a race; the unique index is the arbiter. This is the
-- same reasoning as otp_challenges' consumption guard, and it is the reason
-- this invariant is the one of the six that the schema can enforce for real.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_identities_provider_subject
    ON user_identities (provider, subject);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX: "what identities does this account have?"
--
-- The account settings screen and, more importantly, the login path: having
-- resolved a provider assertion to (provider, subject) and found the user, the
-- server loads the rest of that user's identities. Leads with user_id, so it
-- is also what any "unlink the last sign-in method" count runs on.
--
-- This is index #1 on the table's most frequent access pattern, and it is
-- separate from ux_user_identities_provider_subject above because that one is
-- keyed by (provider, subject) and cannot serve a user_id lookup at all.
CREATE INDEX IF NOT EXISTS ix_identities_user
    ON user_identities (user_id);

-- NO INDEX on `label`. It is display-only, searched by nothing, and indexing a
-- nullable free-text column for a query that does not exist is pure write
-- amplification.

-- NO INDEX on `provider` alone. Every provider-scoped query in the system is
-- really a (provider, subject) lookup, which ux_user_identities_provider_subject
-- already answers.

-- SECURITY: what an attacker gets from this table.
--
-- Read access:
--   subject   A list of which external accounts belong to which Ecoma
--             accounts. That is a pre-authentication correlation map: given
--             one known account, it says what every other account's provider
--             identities look like, which turns a single confirmed email
--             address into a set of in-progress account-takeover attempts.
--   provider  Which federation partners this platform uses, and which
--             accounts came from which — useful for choosing an attack path.
--
-- Write access:
--   Full account takeover of any linked account. INSERT a row you do not own
--   and, if your provider can be made to assert that subject, you have
--   authenticated. That is why ux_user_identities_provider_subject exists and why
--   it is on (provider, subject) and not on subject.
--
-- Deletion is the quiet one: unlinking an identity removes the account's only
-- remaining sign-in method. `UnlinkIdentityCommand` requires AAL2 and refuses
-- the last method for exactly this reason.
-- ---------------------------------------------------------------------------
