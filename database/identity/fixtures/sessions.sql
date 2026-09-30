-- ===========================================================================
-- sessions.sql — one row per `SessionStatus`, plus the two rows that make the
-- `security_version` mechanism provable.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- TWO PROPERTIES, and the second one is the reason this file has a
-- `-- for the security-version test` section that looks like duplication:
--
-- 1. `Session::is_usable_at` requires status AND expiry. All three statuses
--    appear below, and one row is deliberately EXPIRED-AND-ACTIVE so that the
--    two conditions cannot be conflated — a fixture where every active session
--    is unexpired makes "status is active" and "has not expired" the same
--    predicate, and a test against it proves nothing about either.
--
-- 2. `SecurityVersion` arithmetic (invariant #3, one of the three that IS
--    enforced for real). A session records the version it was issued under, and
--    every authenticated request compares it against `users.security_version`;
--    a mismatch refuses. Two sessions for USER 2 at version 0 and two for
--    USER 8 at version 7, where USER 8's user row carries `security_version =
--    7`, is the setup for the assertion "bumping the column invalidated every
--    session issued under the old version, with no write to `sessions`".
--
-- The second property is why USER 8 has `security_version = 7` in `users.sql`.
-- The two files have to agree and the cross-file test in `assert_fixture_
-- invariants.sql` is what checks they do.
-- ===========================================================================

-- ===========================================================================
-- USER 2 (active member) — security_version 0, the version its user row carries.
-- ===========================================================================

-- SESSION A — ACTIVE, unexpired, AAL1. The ordinary case: this session is usable.
--
-- expires_at_ms is an ABSOLUTE deadline far in the future, and
-- `Session::new` refuses `expires_at_ms <= created_at_ms` — which the schema
-- CHECKs as well, so a fixture with a session born expired cannot be written.
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES (
    '51000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000002',
    'active',
    0,
    1750000000000,
    1893456000000,          -- 2030-01-01T00:00:00Z, in milliseconds
    'aal1',
    0,
    'Fixture Browser on Linux',
    'fixture-credential-hash-user2-session-a-000000000000000',
    'cookie',
    1750000500000
);

-- SESSION B — ACTIVE, AAL2, RECENTLY AUTHENTICATED.
--
-- `recently_authenticated` is the step-up flag and it is PER SESSION. The reason
-- it cannot be per-user is in `invariants.rs` and the test name that guards it is
-- `recently_authenticated_is_tracked_per_session_not_globally`: "if 'recently
-- authenticated' were a property of the user, one account-wide flag would let an
-- attacker holding ANY session on the account make EVERY OTHER session
-- step-up-eligible at once."
--
-- THIS IS THE FIXTURE FOR THAT. USER 2 now has two sessions, one of which has
-- recently authenticated and one of which has not. A step-up check must pass on
-- SESSION B and FAIL on SESSION A. A per-user implementation would pass on both,
-- and this fixture is what makes the difference visible: a test that only ever
-- used step-up-eligible sessions could not tell the two implementations apart.
--
-- aal = 'aal2' is `Aal::as_wire()`, and invariant #4 ("AAL1 cannot satisfy an
-- AAL2 operation") is the `>=` ordinal comparison on this column.
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES (
    '51000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002',
    'active',
    0,
    1750000000000,
    1893456000000,
    'aal2',
    1,
    'Fixture Authenticator App on Android',
    'fixture-credential-hash-user2-session-b-000000000000000',
    'bearer',
    1750000900000
);

-- SESSION C — REVOKED, still unexpired.
--
-- The pairing with SESSION D is the point: C and D have the SAME status
-- (`revoked`) and the SAME expiry, and differ only in `credential_hash`. So a
-- query that filters on expiry finds both and a query that filters on status
-- finds both, and the only predicate that separates them is the credential. A
-- lookup by credential hash is ux_sessions_credential_hash's reason to exist.
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES (
    '51000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000002',
    'revoked',
    0,
    1750000000000,
    1893456000000,
    'aal1',
    0,
    'Fixture Revoked Browser',
    'fixture-credential-hash-user2-session-c-000000000000000',
    'cookie',
    1750001000000
);

-- SESSION D — EXPIRED, and the status is ALSO 'expired'.
--
-- `SessionStatus::Expired` exists alongside the timestamp, and the two are
-- expected to agree. A sweeper that marks rows expired is what keeps them in
-- agreement; nothing in this schema enforces it, because `is_usable_at` refuses
-- the row on the timestamp regardless of which of the two said so. The status is
-- there so a query can find expired sessions without comparing a timestamp.
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES (
    '51000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000002',
    'expired',
    0,
    1750000000000,
    1750003600000,          -- 2025-06-16T02:26:40Z — in the past
    'aal1',
    0,
    'Fixture Expired Browser',
    'fixture-credential-hash-user2-session-d-000000000000000',
    'cookie',
    1750003000000
);

-- SESSION E — ACTIVE, AAL1, ALREADY PAST ITS EXPIRY.
--
-- THE ROW THAT KEEPS STATUS AND EXPIRY FROM BEING THE SAME PREDICATE.
--
-- `status = 'active'` and `expires_at_ms` in the past is a perfectly writable
-- row, and it is the shape a sweeper leaves behind in the window between a
-- session's deadline passing and the sweeper running. `is_usable_at` refuses it
-- on the timestamp. A fixture set in which every active session is unexpired
-- would let an implementation that checked only `status` pass every test in this
-- file, which is the failure mode `Session::is_usable_at`'s own signature exists
-- to rule out.
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES (
    '51000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000002',
    'active',
    0,
    1750000000000,
    1750003600000,
    'aal1',
    0,
    'Fixture Overdue Browser',
    'fixture-credential-hash-user2-session-e-000000000000000',
    'cookie',
    1750003000000
);

-- ===========================================================================
-- FOR THE SECURITY-VERSION TEST: USER 8's sessions, issued under a STALE version
-- ===========================================================================
--
-- USER 8's `users` row carries `security_version = 7`. Every session below
-- carries `security_version = 3` — the version the account had BEFORE the bump.
--
-- THE ASSERTION THIS SET EXISTS FOR: all of these are refused, because 3 ≠ 7.
-- Not because their status is not 'active', and not because they have expired —
-- every row below is `active` with an expiry in 2030. The refusal must be
-- attributable to the version comparison ALONE, and that is only true because
-- every other refusal condition is held constant across these rows and USER 2's.
--
-- This is the O(1) property `data-model.md` calls the reason `SecurityVersion` is
-- a u32 column on `users` and not a table: "Bumping the column invalidates every
-- older session at once, with no write to `sessions` at all." Nothing in the
-- fixture set UPDATEs a sessions row to express a revocation, because in the
-- real system nothing does.
--
-- THE VERSION IS 3 AND NOT 0, so the test cannot pass by treating "non-zero" as
-- the condition — the property is EQUALITY against `users.security_version`, and
-- USER 2's sessions are at 0 against a user row at 0.
--
-- AND ONE OF THEM IS AAL2 WITH recently_authenticated = 1, so that the fixture
-- also proves the version comparison is not short-circuited by a step-up-eligible
-- session. "Recently authenticated" must not mean "exempt from revocation".
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES
    -- SESSION F: stale version, AAL1, active, unexpired. The plain case.
    ('51000000-0000-4000-8000-000000000006',
     'f0000000-0000-4000-8000-000000000008',
     'active', 3, 1750000000000, 1893456000000, 'aal1', 0,
     'Fixture Stale Browser',
     'fixture-credential-hash-user8-session-f-000000000000000',
     'cookie', 1750000500000),

    -- SESSION G: stale version, AAL2, RECENTLY AUTHENTICATED, active, unexpired.
    -- Every excuse a session can have, and still stale.
    ('51000000-0000-4000-8000-000000000007',
     'f0000000-0000-4000-8000-000000000008',
     'active', 3, 1750000000000, 1893456000000, 'aal2', 1,
     'Fixture Stale Stepped-Up Session',
     'fixture-credential-hash-user8-session-g-000000000000000',
     'bearer', 1750000900000);

-- ===========================================================================
-- ONE SESSION WITH NO CREDENTIAL COLUMNS AT ALL
-- ===========================================================================

-- SESSION H — for the support agent, with `credential_hash = NULL`.
--
-- `credential_hash` and `credential_type` are nullable, and the partial unique
-- index ux_sessions_credential_hash is `WHERE credential_hash IS NOT NULL`. A row
-- with no credential is a session established through a channel this schema does
-- not model — and the reason the index is PARTIAL is that such a row exists.
-- With a plain UNIQUE index, two NULL-credential sessions would collide on the
-- NULL and neither could be written, which is why the index's own comment says
-- "Partial (WHERE credential_hash IS NOT NULL)" and why the partial form is not
-- merely an optimisation here.
INSERT INTO sessions (id, user_id, status, security_version,
                      created_at_ms, expires_at_ms, aal,
                      recently_authenticated, label, credential_hash,
                      credential_type, last_seen_at_ms)
VALUES (
    '51000000-0000-4000-8000-000000000008',
    'f0000000-0000-4000-8000-000000000006',
    'active',
    0,
    1750000000000,
    1893456000000,
    'aal2',
    1,
    'Fixture Operator Console',
    NULL,
    NULL,
    1750000900000
);

-- ===========================================================================
-- THE ACCOUNTS DELIBERATELY LEFT WITH NO SESSION
-- ===========================================================================
--
-- USER 3 (suspended), USER 4 (deactivated), USER 5 (pending verification) and
-- USER 7 (service) have no sessions.
--
-- USER 5's absence is the point rather than an omission: invariant #1 — "an
-- inactive user cannot authenticate" — is `#[ignore]`d because the use case that
-- would enforce it does not exist. A `pending_verification` account with a live
-- session is the row that invariant exists to forbid, so the fixture does not
-- contain one. When that invariant stops being ignored, the test will need to
-- assert the REFUSAL for a session that a hypothetical buggy implementation
-- would have issued; it will not be able to write that row, and that is the
-- correct outcome.
--
-- USER 3 and USER 4 are the accounts whose sessions were revoked or expired, and
-- USER 7's absence says a service account has no browser session — which is the
-- whole reason `Service` is a distinct role rather than a member with a flag.