-- ===========================================================================
-- users.sql — one row per `UserStatus`.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- `UserStatus::permits_authentication` is the rule that `active` is the only
-- status from which a user may authenticate, and that rule is `#[ignore]`d in
-- `identity-domain`'s `invariants.rs` with a named reason: the use case that
-- would enforce it does not exist yet. These rows are the database half of the
-- setup that test needs when it stops being ignored — a suspended user, a
-- deactivated user and a pending user, each with a row the enforcement code can
-- find.
--
-- THEY DO NOT TEST `permits_authentication`. They make it POSSIBLE to test it.
-- A row in a fixture table is not an assertion, and `tests/` is where
-- assertions live. The test that would consume these rows is
-- `tests/security/` and it is skipped with a named reason until the
-- authentication flow exists.
--
-- ===========================================================================
-- THE LAST-ADMINISTRATOR FIXTURE, and why this file is one row longer than it
-- looks
-- ===========================================================================
--
-- INVARIANT #2 in `invariants.rs` is "the last active administrator cannot be
-- demoted, suspended or deactivated", and it is `#[ignore]`d with the reason
-- that the rule is enforced by `RoleChangeRequest::evaluate` — which IS real and
-- IS tested in `identity-application` — but that the TRANSACTION that feeds it
-- `active_administrator_count` correctly is `DEFERRED`.
--
-- The fixture for that test is the dangerous one, and the danger is specific:
--
--   A FIXTURE WITH TWO ADMINISTRATORS MAKES THE TEST PASS FOR THE WRONG
--   REASON.
--
-- The assertion being guarded is "demoting the last active administrator is
-- refused". If the fixture contained two active administrators, a demotion would
-- be CORRECT and the test would need to expect success — so a fixture with two
-- administrators, combined with a test written to expect refusal, either fails
-- for the right reason or (worse) passes because the test double hard-coded a
-- count instead of reading the fixture. A green test would then be evidence
-- about a number in a test file rather than about the database.
--
-- THEREFORE, ACROSS THIS ENTIRE FIXTURE SET, EXACTLY ONE USER HAS
-- role = 'administrator'. That is asserted mechanically, not by convention —
-- see `assert_fixture_invariants.sql`, which is a query, not a comment. If a
-- future fixture file adds a second administrator, that query fails and names
-- the file that broke it.
--
-- The corollary, which is the reason the fixture is a single administrator
-- rather than "one administrator plus a suspended one": `evaluate` counts
-- ACTIVE administrators. A suspended administrator does not satisfy AAL2 — see
-- `forbidden_reason_missing_aal2()` and `AdminContext` — so a suspended
-- administrator is a row that exists to prove a *different* thing, and mixing it
-- into this set would put two rows in the table that a naive `COUNT(*) WHERE
-- role = 'administrator'` would count. The count that matters is
-- `COUNT(*) WHERE role = 'administrator' AND status = 'active'`, and that is the
-- one `ix_users_role_status` exists to make cheap.
-- ===========================================================================

-- USER 1 — the ONLY administrator in this fixture set.
--
-- status = 'active' is load-bearing. This is the row the last-administrator
-- invariant counts, and it is the ONLY row with both role = 'administrator' AND
-- status = 'active'. See the header.
--
-- security_version = 0 is `SecurityVersion::INITIAL`, and is stated explicitly
-- rather than left to the DEFAULT so that a reader of this fixture does not have
-- to know what the default is in order to know what the fixture contains.
--
-- id values are hand-written UUIDs, not generated. Determinism matters here: a
-- fixture that mints a new UUID on every run cannot be referenced by a second
-- file, and a test that has to discover an id by querying for it is a test whose
-- subject is "whatever came back" rather than "the last administrator". The
-- leading digit of each id encodes the fixture file and row for the same
-- reason.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000001',
    'Fixture Administrator',
    'administrator',
    'active',
    0
);

-- USER 2 — an ACTIVE member. The happy-path account: it authenticates, and it is
-- not an administrator.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000002',
    'Fixture Active Member',
    'member',
    'active',
    0
);

-- USER 3 — a SUSPENDED member.
--
-- Exercises `UserStatus::Suspended` as distinct from `Deactivated`, which is a
-- distinction `data-model.md` insists on: "suspension is an administrative act
-- that can be lifted, deactivation is a user act, and conflating them makes 'who
-- did this and can it be undone' unanswerable from the row alone."
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000003',
    'Fixture Suspended Member',
    'member',
    'suspended',
    0
);

-- USER 4 — a DEACTIVATED member. The user-act counterpart to USER 3.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000004',
    'Fixture Deactivated Member',
    'member',
    'deactivated',
    0
);

-- USER 5 — a PENDING_VERIFICATION member, which is what `User::new` produces
-- for every account before anyone has proven an inbox.
--
-- This is the status an account is born in, so it is the one the
-- "inactive users cannot authenticate" invariant is most about: an account that
-- has never been verified is the largest population of any identity system and
-- the one an attacker most wants to act as.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000005',
    'Fixture Pending Member',
    'member',
    'pending_verification',
    0
);

-- USER 6 — a SUPPORT-role member.
--
-- `PlatformRole::Support` "moderates accounts but does not promote":
-- `is_administrative()` is true for Support while `may_assign_roles()` is false,
-- and `RoleChangeRequest::evaluate` refuses a non-`may_assign_roles` actor
-- BEFORE the administrator count is consulted. This row is the fixture for that
-- ordering: a test that gave Support an actor role and two administrators would
-- pass whether or not the actor check ran first, and only a fixture with a
-- SINGLE administrator can tell "refused because Support may not assign roles"
-- apart from "refused because it was the last one".
--
-- NOT an administrator. See the header.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000006',
    'Fixture Support Agent',
    'support',
    'active',
    0
);

-- USER 7 — a SERVICE-role account: a machine identity.
--
-- `Service` is `DEFERRED` design per `data-model.md`, with the constraint that
-- "a service identity may not assign roles". This row is the fixture for the
-- shape without claiming any enforcement of that rule exists, because none does:
-- the column accepts the value and the rule lives in `RoleChangeRequest::evaluate`
-- as an input (`actor_role`) the caller supplies.
--
-- NOT an administrator. See the header.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000007',
    'Fixture Service Account',
    'service',
    'active',
    0
);

-- USER 8 — an active member whose security_version has been bumped.
--
-- THE ONE FIXTURE THAT EXISTS FOR A COLUMN RATHER THAN A STATUS.
--
-- Invariant #1 in `invariants.rs` is "an inactive user cannot authenticate", #2
-- is the last administrator, #3 is the security-version arithmetic — and #3 IS
-- enforced for real in the domain. The arithmetic: a session records the
-- `security_version` it was issued under, and every authenticated request
-- compares it against `users.security_version`; a mismatch refuses. Bumping the
-- column invalidates every older session with no write to `sessions` at all.
--
-- This row is the "before" side of that test. `sessions.sql` creates sessions
-- against BOTH USER 2 (security_version = 0) and USER 8 (bumped to 7), and the
-- assertion is that the first set stays usable while the second set does not —
-- which is the O(1) property `data-model.md` calls "the reason `SecurityVersion`
-- is a u32 column on `users`, not a table".
--
-- security_version = 7 rather than 1 so that the test cannot accidentally pass
-- by treating "non-zero" as the condition. The property is EQUALITY, not
-- presence.
INSERT INTO users (id, display_name, role, status, security_version)
VALUES (
    'f0000000-0000-4000-8000-000000000008',
    'Fixture Bumped Member',
    'member',
    'active',
    7
);