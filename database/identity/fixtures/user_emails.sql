-- ===========================================================================
-- user_emails.sql — every `user_emails` shape the schema's constraints need.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- Two rules, and one of them is enforced by a partial index that no amount of
-- reasoning about application code would substitute for:
--
-- 1. "exactly one primary address per account" — enforced by
--    ix_user_emails_one_primary, a PARTIAL unique index over (user_id) WHERE
--    is_primary = 1. `AccountEmail`'s own doc says the rule is "enforced by a
--    partial unique index, not by this type", which means the type does NOT
--    enforce it and this fixture is what makes the index testable.
--
-- 2. "only a VERIFIED address may be primary" — the cross-column CHECK, because
--    a primary unverified address means "sign in as this address", which is
--    exactly the account-takeover shape `UserInfoResponse::email_is_safely_
--    usable` exists to refuse.
--
-- Rule 2 cannot be demonstrated by a row that satisfies it. It is demonstrated
-- by an INSERT that FAILS. That attempt is NOT in this file, because a fixture
-- file that aborts half way leaves the rest of the file unapplied and the
-- resulting test output depends on statement order. It lives in
-- `../tests/integration/schema.test.mjs`, which asserts the refusal. A fixture
-- that cannot be loaded is not a fixture.
--
-- ===========================================================================
-- THE USER_IDS HERE ARE THE ones FROM users.sql AND THE CROSS-FILE RULE
-- ===========================================================================
--
-- Every user_id below is one of the eight ids in `users.sql`. This file is NOT
-- self-contained: it applies after `users.sql` in the order given in
-- `README.md`, and every row here FAILS the foreign key if that order is
-- changed. That is deliberate and it is the cheapest available assertion that
-- the two files agree about which accounts exist — a fixture file that
-- generated its own ids would have no such property, and a mismatch between two
-- fixture files is exactly the kind of thing that makes a test pass for the
-- wrong reason.
-- ===========================================================================

-- USER 1 (the administrator) — one primary, verified address.
--
-- `is_primary = 1` REQUIRES `verified_at_ms IS NOT NULL`, so this row cannot be
-- written without a verification timestamp. There is no way to make this
-- administrator's sign-in address unproven and primary at the same time, which
-- is the property being fixed.
INSERT INTO user_emails (id, user_id, address, verified_at_ms, is_primary)
VALUES (
    'e1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000001',
    'admin@fixture.invalid',
    1750000000000,
    1
);

-- USER 1 — a second address that is verified but NOT primary.
--
-- Without this row, "exactly one primary" would be indistinguishable from "only
-- one address exists", and a fixture that cannot distinguish the two would make
-- the partial index look like it is doing the wrong job. It is the row that
-- proves the index counts PRIMARY addresses rather than addresses.
--
-- `.invalid` is a reserved TLD (RFC 2606) and can never resolve. Every address
-- in this fixture set uses it, so nothing here can accidentally deliver mail to a
-- real person — which matters because `ux_user_emails_address` is UNIQUE and a
-- real address would collide with a real account's.
INSERT INTO user_emails (id, user_id, address, verified_at_ms, is_primary)
VALUES (
    'e1000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000001',
    'admin-alt@fixture.invalid',
    1750000001000,
    0
);

-- USER 2 (active member) — one primary, verified address.
INSERT INTO user_emails (id, user_id, address, verified_at_ms, is_primary)
VALUES (
    'e1000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000002',
    'active@fixture.invalid',
    1750000002000,
    1
);

-- USER 5 (pending_verification) — an address that has NOT been proven, and is
-- therefore NOT primary.
--
-- This is the shape `User::new` produces for a brand-new account: a row exists,
-- it is not the sign-in address, and `verified_at_ms IS NULL` is the ONLY
-- definition of unverified in this schema — there is no `verified` boolean to
-- fall out of sync with it.
--
-- THE RULE THIS ROW CANNOT BREAK is the point: `is_primary = 0` with
-- `verified_at_ms IS NULL` satisfies the cross-column CHECK's second branch.
-- The first branch (`is_primary = 1 AND verified_at_ms IS NOT NULL`) is the only
-- other way through, and this row is deliberately in the second one.
INSERT INTO user_emails (id, user_id, address, verified_at_ms, is_primary)
VALUES (
    'e1000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000005',
    'pending@fixture.invalid',
    NULL,
    0
);

-- USER 6 (support agent) — one primary address.
INSERT INTO user_emails (id, user_id, address, verified_at_ms, is_primary)
VALUES (
    'e1000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000006',
    'support@fixture.invalid',
    1750000003000,
    1
);

-- ===========================================================================
-- THE ACCOUNTS DELIBERATELY LEFT WITH NO EMAIL ROW AT ALL
-- ===========================================================================
--
-- USER 3 (suspended), USER 4 (deactivated), USER 7 (service) and USER 8
-- (security-version bumped) have no address rows.
--
-- USER 8's absence is worth one line on its own, because USER 8 is otherwise the
-- richest row in `users.sql`: it has no email address at all. An account can
-- exist with no address, which is what a passkey-only or SAML-only account looks
-- like — `IdentityProvider::subject_is_globally_unique()` is true for `Passkey`
-- alone, so a passkey-primary account has an identity row and no inbox. A
-- fixture set where every user has an email would make the schema look like it
-- requires one, and it does not: the "exactly one" half of the primary-address
-- rule is a UNIQUENESS constraint and cannot express existence, which is
-- precisely why a `pending_verification` account with zero primary addresses is
-- a legal row.
--
-- USER 7 (service) has none for a different reason: a machine identity does not
-- receive mail, and a service account with a sign-in address is a shape that
-- invites somebody to log in as a service account with a password they should
-- not have.