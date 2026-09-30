-- ===========================================================================
-- user_identities.sql — one row per `IdentityProvider`, and the row that makes
-- invariant #6 provable.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- INVARIANT #6 in `invariants.rs` is "a provider subject cannot be claimed by a
-- second user", and it is `#[ignore]`d with this exact reason: "the database
-- unique index on (provider, subject) is part of the claim; until a repository
-- exists, nothing checks it."
--
-- The `#[ignore]` cannot be lifted by this file, for two reasons and both are
-- honest. What this file CAN do is provide the single existing claim a second
-- insert has to collide with, so that a test can demonstrate the refusal. The
-- demonstration is an assertion, so it lives in `tests/integration/`; the row it
-- needs lives here (USER 2's first OAuth row).
--
-- 1. There is no repository. The `#[ignore]`'s stated blocker is "until a
--    repository exists, nothing checks it" — and while the INDEX now checks it,
--    the invariant has to hold through the write path that will be built on top
--    of the index, and that path does not exist. An `#[ignore]` removed because a
--    test happens to insert a duplicate by hand is an `#[ignore]` removed for the
--    wrong reason.
-- 2. The rule as stated in `invariants.rs` is about a repository refusing a
--    write, not about a database refusing one. Those are different claims.
--
-- WHY THE PAIR AND NEVER `subject` ALONE, restated because it is the single most
-- likely misreading of this schema: `subject_is_globally_unique()` is true for
-- `Passkey` only. "An OAuth provider's `sub` is only stable and unique *within
-- that provider* — Google's and GitHub's identifiers are both only meaningful
-- paired with the provider. A unique index on `subject` alone would refuse a
-- legitimate user who has both a Google and a GitHub account whose identifiers
-- happen to collide."
--
-- USER 2 and USER 8 below therefore carry THE SAME subject string under TWO
-- DIFFERENT providers. A `UNIQUE(subject)` index would refuse both of those
-- rows. `UNIQUE(provider, subject)` accepts them, and refuses the same subject
-- under the same provider — which is the row USER 8's duplicate is there to set
-- up.
-- ===========================================================================

-- USER 2 (active member) — an OAUTH identity.
--
-- provider = 'oauth' IS THE FOURTH VARIANT AND IT IS THE DEFAULT ONE:
-- `IdentityProvider` is `OAuth | Passkey | Email | Saml`, so there is one
-- variant for every external OAuth provider rather than one per provider. The
-- pair (provider, subject) is what scopes a subject, and for OAuth the scoping
-- is inside the subject itself — a Google `sub` and a GitHub `id` are both just
-- an opaque string under the same provider value, so the schema CANNOT tell them
-- apart and the uniqueness rule cannot be stricter than "these two strings
-- differ". That is a real property of the design rather than a gap in this
-- fixture, and it is why a real deployment would carry the issuer inside the
-- subject when it needs to distinguish two OAuth providers from one another.
--
-- subject = '100000000000000000001' is Google's numeric user-id shape, used
-- here as an opaque string.
INSERT INTO user_identities (id, user_id, provider, subject, label)
VALUES (
    'a1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000002',
    'oauth',
    '100000000000000000001',
    'Fixture OAuth Account (Google)'
);

-- USER 2 — a SECOND OAUTH identity with a DIFFERENT subject.
--
-- Included so that a multi-provider account exists in the fixture set: one
-- person linked to two external accounts.
--
-- THIS ROW IS ALSO THE PROOF THAT `provider` CANNOT CARRY THE OAUTH PROVIDER'S
-- NAME. Both OAuth rows above and below are `provider = 'oauth'`, so they are
-- distinguished by their SUBJECT and nothing else. Any design that wanted
-- "a user cannot link the same GitHub account twice" has to encode the issuer
-- in the subject, and this fixture says so by containing two rows that a reader
-- would otherwise expect to be the same provider.
INSERT INTO user_identities (id, user_id, provider, subject, label)
VALUES (
    'a1000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002',
    'oauth',
    'gh_fixture_user_2',
    'Fixture OAuth Account (GitHub)'
);

-- USER 8 (the security-version-bumped member) — an OAUTH identity carrying the
-- SAME subject as USER 2's first row.
--
-- THE UNIQUE INDEX MUST REFUSE THIS ROW, and that refusal aborts this file.
-- So this row is NOT HERE, and the reason is worth stating precisely because a
-- fixture that cannot be applied is not a fixture:
--
--   * The subject `100000000000000000001` already belongs to USER 2 under
--     provider 'oauth'.
--   * `ux_user_identities_provider_subject` is UNIQUE(provider, subject).
--   * ('oauth', '100000000000000000001') is therefore taken, and this INSERT
--     fails with SQLITE_CONSTRAINT_UNIQUE.
--
-- And that failure IS invariant #6, demonstrated. It is not recorded as a
-- comment because a comment is not evidence; `tests/integration/schema.test.mjs`
-- inserts the colliding pair and asserts the refusal, and it is the assertion
-- that lifts the `#[ignore]`'s stated blocker ("the database unique index on
-- (provider, subject) is part of the claim; until a repository exists, nothing
-- checks it"). The index now checks it. The `#[ignore]` itself stays, because
-- its second half — that the invariant must hold through the repository's own
-- write path — is still `DEFERRED`.
--
-- WHAT THE FIXTURE SET THEREFORE PROVIDES FOR THIS INVARIANT is USER 2's first
-- row: a single existing claim on a subject, which is what a second insert has
-- to collide with.
--
-- ===========================================================================

-- USER 8 — a PASSKEY identity.
--
-- `subject_is_globally_unique()` is TRUE for `passkey` "because a passkey's
-- user handle is minted here", which means a passkey's subject alone would be
-- safe to index. The schema indexes (provider, subject) for ALL providers anyway,
-- and this row is why that is not over-cautious: the passkey case is the one
-- where a single-column index would ALSO have worked, so the composite choice is
-- validated on the cases where it is REQUIRED rather than on the case where it
-- is convenient.
--
-- subject = 'fixture-user-handle-8' is the shape `PasskeyCredential` carries as a
-- user handle. It is NOT a secret and NOT a credential: the private key never
-- leaves the authenticator, so what is stored is a public key and an identifier.
INSERT INTO user_identities (id, user_id, provider, subject, label)
VALUES (
    'a1000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000008',
    'passkey',
    'fixture-user-handle-8',
    'Fixture YubiKey'
);

-- USER 6 (support agent) — an EMAIL identity.
--
-- provider = 'email' is a legitimate value here and it is worth saying why,
-- because it looks like duplication with `user_emails`: they answer different
-- questions. `user_emails` answers "which addresses does this account have and
-- are they proven", and it is where a proof of possession is recorded.
-- `user_identities` answers "which subject at which provider is linked to this
-- account", and for `email` the subject is the address as the provider knows it
-- — a link, not an assertion that the inbox was ever verified. An address can
-- be linked and unproven.
INSERT INTO user_identities (id, user_id, provider, subject, label)
VALUES (
    'a1000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000006',
    'email',
    'support@fixture.invalid',
    NULL
);

-- USER 7 (the service account) — a SAML identity.
--
-- SAML subjects are issuer-scoped, which is the same reason an OAuth `sub` is
-- provider-scoped and the reason the index is a composite: two SAML issuers in
-- a federated environment can mint the same NameID, and a single-column index
-- would refuse both.
--
-- The format `https://idp.fixture.invalid/saml|service-account-7` is the usual
-- issuer|NameID shape and is under 512 bytes, which is `Identity`'s bound.
INSERT INTO user_identities (id, user_id, provider, subject, label)
VALUES (
    'a1000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000007',
    'saml',
    'https://idp.fixture.invalid/saml|service-account-7',
    'Fixture IdP'
);

-- ===========================================================================
-- THE ACCOUNTS DELIBERATELY LEFT WITH NO IDENTITY ROW
-- ===========================================================================
--
-- USER 1 (the administrator), USER 3 (suspended) and USER 4 (deactivated) have
-- no linked identity.
--
-- USER 1's absence is deliberate and is the second half of the last-administrator
-- caution in `users.sql`. An administrator who cannot be deprovisioned by
-- revoking their identity provider link is a platform that cannot remove its own
-- operators — but the rule that says so (`UnlinkIdentityCommand` refusing the
-- account's last sign-in method) is an application-layer rule, not a schema one.
-- A fixture that gave the administrator a linked identity would make a future
-- "can the last administrator be deprovisioned" test ambiguous between "no, and
-- correctly" and "no, because this fixture forgot to give them a way in".
--
-- USER 3 and USER 4 have none for the same reason in reverse: they are the
-- accounts whose sign-in method was already taken away, which is the state the
-- deactivation path produces.