-- ===========================================================================
-- assert_fixture_invariants.sql — the cross-file assertions, as queries.
--
-- WHY THIS FILE EXISTS
--
-- SIX FIXTURE FILES MAKE CLAIMS ABOUT EACH OTHER IN THEIR COMMENTS. Until this
-- file existed, every one of those claims was a promise, and the coordinator's
-- instruction on the last-administrator case was explicit: "a fixture that
-- accidentally creates two administrators and makes a test pass for the wrong
-- reason is worse than no fixture." A comment cannot enforce anything. This file
-- is the enforcement.
--
-- IT MAKES NO CHANGES. Every statement is a SELECT. Applying it to a database
-- that already has the fixtures loaded returns one row per check with a column
-- that is either the expected value or a value that must be zero, so a failure is
-- visible in the output rather than as an aborted transaction.
--
-- APPLIED TO AN EMPTY DATABASE IT FAILS, AND THAT IS THE POINT — measured, not
-- assumed. On a migrated-but-unseeded database this file returns 58 rows of which
-- 43 disagree with their `expected` value: the `COUNT(*)` checks return 0, the
-- scalar reads return NULL, and both compare unequal. So there is NO silent pass
-- for a forgotten fixture load, and no need for a "were the fixtures loaded?"
-- preamble in the header to guard one. `tests/integration/fixtures.test.mjs` loads
-- them in the order `database/identity/fixtures/README.md` states and reads all 58
-- rows.
--
-- ---------------------------------------------------------------------------
-- HOW TO READ THE OUTPUT, AND WHAT "FAILURE" LOOKS LIKE
-- ---------------------------------------------------------------------------
--
-- Each check is `SELECT '<name>' AS check_name, <actual> AS actual, <expected> AS
-- expected`. A reader compares the three columns. `tests/integration/
-- fixtures.test.mjs` does that comparison and fails the suite with the check
-- name, so the name is load-bearing: it is what a failing test prints.
--
--   actual = expected        the invariant holds
--   actual <> expected       THE INVARIANT IS BROKEN, and the `check_name` column
--                            says which claim in which fixture file is now false
--
-- WHERE A CLAIM NEEDS A NAME, THE CLAIM IS THE CLAUSE. `-- CLAIM:` on every
-- row is a pointer back into the comment that asserts it, so a broken fixture can
-- be traced to the sentence that promised otherwise rather than to a mystery
-- count.
--
-- ---------------------------------------------------------------------------
-- WHAT IS *NOT* HERE, and why, stated so its absence is a decision
-- ---------------------------------------------------------------------------
--
-- No assertion about USER 1's authenticator count. "The administrator has no
-- factors" is a property of a bootstrap command that does not exist yet, not an
-- invariant of this data set, and `authenticators.sql` says so.
--
-- No assertion that every FK target exists. SQLite enforces foreign keys
-- itself when `PRAGMA foreign_keys = ON` is set, and the migration files declare
-- the behaviour; re-asserting it here would be asserting SQLite's integrity check
-- rather than this fixture set's property. `tests/integration/schema.test.mjs`
-- sets that pragma and therefore DOES check it — on the fixture database, which
-- makes it a fixture check by another route.
--
-- No assertion about counts of rows per table. A fixture set that has to be
-- re-counted every time a file gains a row is a fixture set whose growth is
-- tracked instead of its meaning. The counts that carry meaning are the ones
-- below, and each of them exists because a fixture file claimed it.
--
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- CLAIM 1 — `users.sql`: "ACROSS THIS ENTIRE FIXTURE SET, EXACTLY ONE USER HAS
-- role = 'administrator'" AND that user is active.
--
-- THE CLAIM THAT MATTERS MOST IN THIS FILE. Invariant #2 in
-- `identity-domain/src/invariants.rs` is "the last active administrator cannot be
-- demoted, suspended or deactivated", and it is `#[ignore]`d only because the
-- transaction that feeds it a correct `active_administrator_count` is `DEFERRED`.
--
-- The failure this prevents is not hypothetical. If two active administrators
-- existed, a test asserting that demoting one is REFUSED would have to expect
-- success, and the two ways to reconcile that are both bad: the test fails for a
-- reason unrelated to the invariant, or the test double hard-codes a count and
-- passes for the wrong reason. This row makes the second impossible to hide.
--
-- COUNTS THE ACTIVE ADMISTRATORS, not the administrators — the second half of
-- `users.sql`'s argument that `evaluate` counts ACTIVE administrators, "a
-- suspended administrator does not satisfy AAL2", so a `role = 'administrator'`
-- count would put two rows in the table that the rule does not care about.
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_active_administrator' AS check_name,
       (SELECT COUNT(*) FROM users
         WHERE role = 'administrator' AND status = 'active') AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 2 — `users.sql`: "ACROSS THIS ENTIRE FIXTURE SET, EXACTLY ONE USER HAS
-- role = 'administrator'", with no exemption for a suspended one.
--
-- SEPARATE FROM CLAIM 1 ON PURPOSE, and the separation is the point: a fixture
-- that quietly added a suspended administrator would keep CLAIM 1 at 1 and pass
-- it, while making every naive `COUNT(*) WHERE role = 'administrator'` in a test
-- double return 2. Claim 1 says the invariant's input is unambiguous; this says
-- the naive query is unambiguous too. Both must hold for the fixture set to be
-- usable, and one of them failing is information rather than noise.
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_administrator_at_any_status' AS check_name,
       (SELECT COUNT(*) FROM users WHERE role = 'administrator') AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 3 — `users.sql`: the one administrator is USER 1, and USER 1 is active.
--
-- Pins the identity, not just the count. A count of 1 is satisfied equally by
-- USER 1 and by a newly added USER 9, and the demotion test names USER 1 by id —
-- so a fixture set where the count is right and the identity is wrong would let
-- a test run against an account it did not mean to. Returns 1 when USER 1 is the
-- active administrator, 0 otherwise.
-- ---------------------------------------------------------------------------
SELECT 'the_administrator_is_user_1' AS check_name,
       (SELECT CASE WHEN role = 'administrator' AND status = 'active'
                    THEN 1 ELSE 0 END
          FROM users
         WHERE id = 'f0000000-0000-4000-8000-000000000001') AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 4 — `users.sql`: security_version = 0 is `SecurityVersion::INITIAL` and
-- is stated explicitly on seven of the eight rows.
--
-- The one row that is not 0 is USER 8 at 7, and it is the whole reason the
-- security-version test has a subject. If a fixture file added a ninth user at a
-- non-zero version, the count of non-zero rows would be 2 and the property
-- "exactly one account has been bumped" would be false — which is exactly the
-- kind of drift that lets a test pass against "some account was bumped" instead
-- of "this account was".
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_user_with_a_bumped_security_version' AS check_name,
       (SELECT COUNT(*) FROM users WHERE security_version <> 0) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 5 — `users.sql` / `sessions.sql`: the bumped version is 7, and the two
-- stale sessions carry 3.
--
-- INVARIANT #3 IS ENFORCED FOR REAL in the domain, and this is the fixture half
-- of it. The assertion is that a session whose recorded `security_version`
-- differs from its user's is refused, and its truth is EQUALITY rather than
-- presence — which is why USER 8 is at 7 and not 1 ("so that the test cannot
-- accidentally pass by treating 'non-zero' as the condition").
--
-- Three rows are named: the user, and the two sessions. If any one of them moved,
-- the mismatch this fixture exists to demonstrate would either become a match or
-- stop being a mismatch, and CLAIM 4 alone would not notice which.
-- ---------------------------------------------------------------------------
SELECT 'bumped_user_is_at_7' AS check_name,
       (SELECT security_version FROM users
         WHERE id = 'f0000000-0000-4000-8000-000000000008') AS actual,
       7 AS expected;

SELECT 'exactly_two_sessions_carry_the_stale_version' AS check_name,
       (SELECT COUNT(*) FROM sessions
         WHERE user_id = 'f0000000-0000-4000-8000-000000000008'
           AND security_version = 3) AS actual,
       2 AS expected;

SELECT 'exactly_two_sessions_are_stale_against_their_user' AS check_name,
       (SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.security_version <> u.security_version) AS actual,
       2 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 6 — `authenticators.sql`: "USER 2 has exactly one authenticator".
--
-- THE SAME CAUTION AS CLAIM 1, applied to a factor instead of a role.
-- `UnlinkIdentityCommand` refuses removing an account's last sign-in method and
-- the analogous rule for a second factor is a lockout: "an account whose only AAL2
-- factor is removed can never satisfy an AAL2-required operation again". SQLite
-- cannot enforce it — a CHECK constraint cannot count rows in another table — so
-- the fixture has to BE the constraint, and it can only be that if the count is
-- exactly one.
--
-- USER 2 is the subject because it is the only account in the set with a single
-- factor. USER 6 has two (operator TOTP plus recovery code), USER 8 has two
-- (passkeys), so naming the id is load-bearing: a bare count over all users would
-- be 5 and would assert nothing.
-- ---------------------------------------------------------------------------
SELECT 'user_8_is_the_single_factor_account' AS check_name,
       (SELECT COUNT(*) FROM authenticators
         WHERE user_id = 'f0000000-0000-4000-8000-000000000008') AS actual,
       1 AS expected;

SELECT 'user_2_keeps_one_factor_of_each_kind' AS check_name,
       (SELECT COUNT(*) FROM authenticators
         WHERE user_id = 'f0000000-0000-4000-8000-000000000002') AS actual,
       4 AS expected;

SELECT 'no_two_accounts_share_a_single_factor_count' AS check_name,
       (SELECT COUNT(*) FROM (SELECT user_id FROM authenticators
                               GROUP BY user_id HAVING COUNT(*) = 1)) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 7 — `authenticators.sql`: all four kinds are present, because
-- 0006's cross-column CHECK has one branch per kind.
--
-- A CHECK that branches on `kind` is only exercised if every branch has a row
-- that satisfies it, and a fixture set containing one kind would let a CHECK
-- written for that one kind pass. The count per kind is asserted rather than the
-- total, so a file that added a second passkey would fail here rather than
-- silently changing what the fixture means.
-- ---------------------------------------------------------------------------
SELECT 'every_authenticator_kind_is_represented' AS check_name,
       (SELECT COUNT(DISTINCT kind) FROM authenticators) AS actual,
       4 AS expected;

SELECT 'the_email_otp_authenticator_stores_no_material' AS check_name,
       (SELECT COUNT(*) FROM authenticators
         WHERE kind = 'email_otp'
           AND credential_id IS NULL AND public_key IS NULL
           AND secret_ciphertext IS NULL AND secret_nonce IS NULL) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 8 — `application_secrets.sql`: "for the rotating client, the
-- `is_current = 1` row's `secret_hash` EQUALS `applications.client_secret_hash`,
-- and the `is_current = 0` row's does not."
--
-- THE DENORMALISATION'S SAFETY PROPERTY. `applications.client_secret_hash` is the
-- token endpoint's fast path — one lookup, no join — and `application_secrets` is
-- the rotation history. If the two ever diverged, the token endpoint would be
-- checking one secret while the history says another, and "no test in this
-- repository would notice", because nothing in the platform reads both tables.
-- This is the only place they are read together.
--
-- Asserted as a COUNT OF DISAGREEMENTS rather than as an equality, so the output
-- reads 0 when the invariant holds — the shape every other check in this file
-- uses for a "nothing may be true" claim.
-- ---------------------------------------------------------------------------
SELECT 'the_current_secret_equals_the_denormalised_hash' AS check_name,
       (SELECT COUNT(*) FROM applications a
         WHERE a.client_secret_hash IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1 FROM application_secrets s
                  WHERE s.application_id = a.id
                    AND s.is_current = 1
                    AND s.secret_hash = a.client_secret_hash)) AS actual,
       0 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 9 — `application_secrets.sql`: the superseded secret's expiry and the
-- parent's `secret_expires_at_ms` are the SAME INSTANT.
--
-- Asserted as a timestamp COMPARISON rather than against the clock, which is what
-- makes it stable: the value 1750007200000 is in the past, so a test that
-- compared it to `now` would start failing on a fixed date with nothing having
-- changed. The files agree about WHEN THE WINDOW CLOSES; whether that instant is
-- still in the future is not a property of this fixture set.
-- ---------------------------------------------------------------------------
SELECT 'the_rotation_window_closes_at_the_same_instant_in_both_files' AS check_name,
       (SELECT COUNT(*) FROM applications a
          JOIN application_secrets s
            ON s.application_id = a.id AND s.is_current = 0
         WHERE a.secret_expires_at_ms IS NOT DISTINCT FROM s.expires_at_ms
           AND a.id = '80000000-0000-4000-8000-000000000006') AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 10 — `application_secrets.sql`: "the rotating client" has exactly two
-- secrets, one of them current, and APP 3 has ZERO secret rows.
--
-- TWO CLAIMS, TWO CHECKS, because they fail differently. `ux_application_
-- secrets_one_current` is a PARTIAL UNIQUE INDEX over `WHERE is_current = 1`, so
-- the schema guarantees at most one current secret and guarantees nothing at all
-- about superseded ones — a rotation that wrote two old rows would be legal. This
-- check makes the fixture assert the shape its comments claim.
--
-- The APP 3 count of 0 is the one worth its own line. `application_secrets.
-- application_id` is a foreign key with NO constraint tying it to a parent row
-- that HAS a secret, so the schema WOULD accept a secret row for the public
-- client. `application_secrets.sql` says exactly that and notes that proving the
-- schema refuses such a row "has a problem worth naming: the schema does not
-- refuse it". What refuses it is `RegisterApplication`, which is `SCAFFOLDED`.
-- So the fixture asserts the absence rather than claiming a constraint.
-- ---------------------------------------------------------------------------
SELECT 'the_rotating_client_has_two_secrets_one_of_them_current' AS check_name,
       (SELECT COUNT(*) FROM application_secrets
         WHERE application_id = '80000000-0000-4000-8000-000000000006') AS actual,
       2 AS expected;

SELECT 'the_public_client_has_no_secret_rows' AS check_name,
       (SELECT COUNT(*) FROM application_secrets
         WHERE application_id = '80000000-0000-4000-8000-000000000003') AS actual,
       0 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 11 — `applications.sql`: "every `client_secret_hash` is either NULL or a
-- non-empty opaque string between 16 and 512 characters", and exactly one
-- application has none.
--
-- The NULL-ability is the point (OIDC requires public clients, and
-- `token_endpoint_auth_methods_supported` includes `none`), so a fixture set where
-- no row had NULL would let a NOT NULL column pass. The count is 1 rather than
-- "at least 1" because `application_secrets.sql` names APP 3 as THE public
-- client and `pkce_challenges.sql` FLOW 4 as its outstanding flow; a second NULL
-- would make "the public client" ambiguous across three files.
--
-- The length check is re-stated here rather than left to the schema because the
-- fixture values are READABLE PLACEHOLDER STRINGS — the hash algorithm is
-- `DEFERRED` — and this is the assertion that says so mechanically rather than
-- only in a comment.
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_application_is_public' AS check_name,
       (SELECT COUNT(*) FROM applications WHERE client_secret_hash IS NULL) AS actual,
       1 AS expected;

SELECT 'every_secret_hash_is_a_readable_placeholder_of_legal_length' AS check_name,
       (SELECT COUNT(*) FROM applications
         WHERE client_secret_hash IS NOT NULL
           AND length(client_secret_hash) NOT BETWEEN 16 AND 512) AS actual,
       0 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 12 — `application_grants_and_consents.sql`: "GRANT 3's `scopes` is a
-- strict subset of APP 6's `allowed_scopes`".
--
-- THIS IS THE ONLY CROSS-FILE CLAIM IN THE SET THAT THE SCHEMA CANNOT CHECK AT
-- ALL. `scopes` and `allowed_scopes` are JSON arrays stored as TEXT, and 0008
-- says so: "a SQLite CHECK cannot read inside a JSON array." So a grant could
-- name a scope the client never registered for and nothing in the schema would
-- refuse it.
--
-- The comparison is done with `json_each`, which reads the arrays properly rather
-- than with LIKE, because a LIKE over the text would also match a scope that is a
-- SUBSTRING of a registered one — and a substring is exactly the mistake a
-- prefix-matching implementation of `Application::allows_redirect_uri` would make,
-- which is the class of bug this fixture file is built to expose.
--
-- `0` means every granted scope is registered. `NOT EXISTS` on the second half
-- asserts the other direction — APP 6 registered `email` and this grant did not
-- take it — which is what makes it a STRICT subset rather than an equal one.
-- ---------------------------------------------------------------------------
SELECT 'every_granted_scope_is_a_registered_scope' AS check_name,
       (SELECT COUNT(*)
          FROM application_grants g
          JOIN applications a ON a.id = g.application_id
          JOIN json_each(g.scopes) AS gs
         WHERE NOT EXISTS (SELECT 1 FROM json_each(a.allowed_scopes) AS as_
                            WHERE as_.value = gs.value)) AS actual,
       0 AS expected;

SELECT 'grant_3_is_a_strict_subset_of_app_6' AS check_name,
       (SELECT CASE WHEN EXISTS (
            SELECT 1 FROM json_each(a.allowed_scopes) AS as_
             WHERE as_.value NOT IN (SELECT gs.value
                                        FROM json_each(g.scopes) AS gs))
            THEN 1 ELSE 0 END
          FROM application_grants g
          JOIN applications a ON a.id = g.application_id
         WHERE g.id = '90000000-0000-4000-8000-000000000003'
           AND a.id = '80000000-0000-4000-8000-000000000006') AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 13 — `application_grants_and_consents.sql`: "CONSENT 2's
-- `granted_scopes` equals GRANT 3's `scopes` while its `requested_scopes` does
-- not."
--
-- THE CLAIM THE TWO-COLUMN DESIGN IN `consents` EXISTS TO SATISFY. A consent
-- screen that lets a person deselect a scope is ordinary, and if only the granted
-- list were stored then "what was this person SHOWN?" would be unanswerable, and
-- so would "did they agree to email and we started sending it anyway?".
--
-- Three equalities, asserted separately, because each can break alone. The
-- granted-to-grant equality is what a test of `Application::granted_scopes` reads;
-- the requested-to-registered equality is what makes the narrowing a choice
-- rather than an intersection the client forced; and requested-vs-granted
-- DIFFERING is the only assertion in the set whose failure would be a fixture that
-- no longer demonstrates anything.
--
-- `json_each` again, and element-wise, so a reordering of either array does not
-- read as a difference — the two are SETS, and `scopes` has no ordering to
-- preserve.
-- ---------------------------------------------------------------------------
SELECT 'consent_2_granted_equals_grant_3_scopes' AS check_name,
       (SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM json_each(c.granted_scopes) AS x
             WHERE x.value NOT IN (SELECT y.value FROM json_each(g.scopes) AS y))
             AND NOT EXISTS (
            SELECT 1 FROM json_each(g.scopes) AS y
             WHERE y.value NOT IN (SELECT x.value FROM json_each(c.granted_scopes) AS x))
            THEN 1 ELSE 0 END
          FROM consents c
          JOIN application_grants g
            ON g.id = '90000000-0000-4000-8000-000000000003'
           AND g.application_id = c.application_id
           AND g.user_id = c.user_id
         WHERE c.id = 'a0000000-0000-4000-8000-000000000002') AS actual,
       1 AS expected;

SELECT 'consent_2_requested_is_wider_than_granted' AS check_name,
       (SELECT CASE WHEN EXISTS (
            SELECT 1 FROM json_each(c.requested_scopes) AS x
             WHERE x.value NOT IN (SELECT y.value FROM json_each(c.granted_scopes) AS y))
            THEN 1 ELSE 0 END
          FROM consents c
         WHERE c.id = 'a0000000-0000-4000-8000-000000000002') AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 14 — `application_grants_and_consents.sql`: exactly one consent has
-- `consent_mode = 0`, and exactly one has no `actor_session_id`.
--
-- BOTH ARE THE SHAPES THE COLUMN EXISTS FOR, and each would be invisible if it
-- were the only row of its kind in the set.
--
-- `consent_mode = 0` is "the existing application_grants row was reused; the user
-- saw nothing, because they were not asked". With ONE such row beside one
-- `consent_mode = 1` row for the same (user, application), the two consents
-- together say "this person consented to these scopes, once by approving and once
-- by not being asked" — which is what the column is for. With none, a test
-- asserting the distinction would be asserting it against an absence.
--
-- `actor_session_id IS NULL` is "a system-initiated action has no session". A
-- consent with a session would imply a browser; without one it can be a
-- provisioning script, a migration, or an administrator acting through the service
-- binding. The column has NO FOREIGN KEY to `sessions` — "a consent is evidence. A
-- session is disposable and gets revoked and deleted. A foreign key here would let
-- a session purge erase a user's consent record" — and CONSENT 4 is the row that
-- makes that decision testable.
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_consent_reused_an_existing_grant' AS check_name,
       (SELECT COUNT(*) FROM consents WHERE consent_mode = 0) AS actual,
       1 AS expected;

SELECT 'exactly_one_consent_has_no_session' AS check_name,
       (SELECT COUNT(*) FROM consents WHERE actor_session_id IS NULL) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 15 — `nonces.sql`: "every nonce here is distinct, which is the property
-- a real generator would have to guarantee and this table cannot CHECK for free."
--
-- The PRIMARY KEY already guarantees it, and this check is about the fixTURE rather
-- than the schema: it counts the rows against the distinct values so a fixture
-- file that lost a row shows up as a count mismatch rather than as a silently
-- smaller data set that a test's `WHERE nonce = ?` quietly misses.
--
-- `session_id` is asserted to be distinct-per-row NO WHERE IT IS NOT: NONCES 1 AND
-- 7 share SESSION A deliberately, because two outstanding nonces for one browser
-- across two flows is the normal case and 0012 has no index on `session_id` at all.
-- That sharing is the reason the column carries no index, so the fixture has to
-- contain it or the argument goes untested.
-- ---------------------------------------------------------------------------
SELECT 'every_nonce_is_distinct' AS check_name,
       (SELECT COUNT(*) FROM nonces) AS actual,
       (SELECT COUNT(DISTINCT nonce) FROM nonces) AS expected;

SELECT 'two_nonces_share_session_a' AS check_name,
       (SELECT COUNT(*) FROM nonces
         WHERE session_id = '51000000-0000-4000-8000-000000000001') AS actual,
       2 AS expected;

SELECT 'exactly_one_nonce_is_consumed' AS check_name,
       (SELECT COUNT(*) FROM nonces WHERE consumed_at IS NOT NULL) AS actual,
       1 AS expected;

SELECT 'nonce_8_is_orphaned' AS check_name,
       (SELECT COUNT(*) FROM nonces n
         WHERE n.session_id = '51000000-0000-4000-8000-000000000009'
           AND NOT EXISTS (SELECT 1 FROM sessions s
                            WHERE s.id = n.session_id)) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 16 — `pkce_challenges.sql`: every `code_challenge` is a real
-- BASE64URL(SHA256(verifier)) digest of a verifier stated in that file's
-- comments, and every `code_challenge_method` is 'S256'.
--
-- THE FIRST CLAIM IN THIS FILE THAT CANNOT BE CHECKED BY SQL AT ALL. SQLite has
-- no SHA-256 and no base64url function, so "the digests in this fixture are real"
-- is asserted by `tests/integration/fixtures.test.mjs`, which re-derives all four
-- from the verifiers named in the comments using Node's `crypto`. Asserting it
-- here would mean asserting a string is a string.
--
-- What IS checkable here, and is: the shape the schema bounds. `code_challenge`
-- is `length BETWEEN 43 AND 128`, and a base64url SHA-256 digest is exactly 43
-- characters unpadded — so a fixture row at any other length is not a digest of
-- anything, whatever its provenance. And `code_challenge_method = 'S256'` is the
-- column's CHECK, asserted here so that a fixture relying on the DEFAULT is
-- visibly relying on it.
--
-- The expired row is NOT excluded from any of these. A fixture whose deadline has
-- passed is the shape the sweep exists to find, and every instant in this section
-- is compared against a STATED value rather than the clock, so none of these checks
-- starts failing on a fixed date.
-- ---------------------------------------------------------------------------
SELECT 'every_code_challenge_is_43_characters' AS check_name,
       (SELECT COUNT(*) FROM pkce_challenges
         WHERE length(code_challenge) NOT BETWEEN 43 AND 128) AS actual,
       0 AS expected;

SELECT 'every_code_challenge_method_is_S256' AS check_name,
       (SELECT COUNT(*) FROM pkce_challenges
         WHERE code_challenge_method <> 'S256') AS actual,
       0 AS expected;

SELECT 'exactly_one_pkce_flow_is_redeemed' AS check_name,
       (SELECT COUNT(*) FROM pkce_challenges WHERE consumed_at IS NOT NULL) AS actual,
       1 AS expected;

SELECT 'exactly_one_pkce_flow_is_expired_and_unredeemed' AS check_name,
       (SELECT COUNT(*) FROM pkce_challenges
         WHERE consumed_at IS NULL AND expires_at_ms < 1893456000000) AS actual,
       1 AS expected;

SELECT 'two_pkce_flows_are_outstanding_past_2030' AS check_name,
       (SELECT COUNT(*) FROM pkce_challenges
         WHERE consumed_at IS NULL AND expires_at_ms >= 1893456000000) AS actual,
       2 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 17 — `otp_challenges.sql`: the guard's predicates split the six
-- challenges into exactly the sets the header names, and the consumed one has no
-- attempts left.
--
-- THE OTP GUARD'S FIXTURE SHAPE. The guard is a conditional UPDATE whose zero-row
-- result IS the failure, and a fixture that had two consumed challenges would let a
-- test pass by finding a consumed row without ever exercising the guard's WHERE
-- clause. One outstanding row is what makes the first redemption return one row
-- and the second return zero.
--
-- `attempts_remaining = 0` on the consumed challenge is the terminal state of the
-- same guard: consumption and the last attempt happen in ONE statement, so a
-- challenge cannot be consumed while an attempt remains. This is the row a test
-- reads to prove the column and the guard agree.
--
-- THE SECOND COUNT IS 4, NOT 5, and the arithmetic is the point. Six challenges
-- total: one is consumed (B), one is expired (D), and one is unredeemable because
-- it has its LAST attempt left rather than a spare one — CHALLENGE C, at
-- `attempts_remaining = 1`, which the header calls "the adjacent race the guard
-- closes by setting the counter to 0 in the SAME UPDATE rather than in a second
-- statement". That leaves A, E and F plus C as the four every guard predicate
-- admits. A count of 5 would mean C had silently become ordinary, and C's entire
-- reason for existing is that it is the one row where a test can observe whether
-- consumption and decrement were one statement or two.
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_otp_challenge_is_expired_and_unconsumed' AS check_name,
       (SELECT COUNT(*) FROM otp_challenges
         WHERE consumed_at IS NULL AND expires_at_ms < 1893456000000) AS actual,
       1 AS expected;

SELECT 'exactly_one_otp_challenge_is_redeemable_now' AS check_name,
       (SELECT COUNT(*) FROM otp_challenges
         WHERE consumed_at IS NULL AND attempts_remaining > 0
           AND expires_at_ms >= 1893456000000) AS actual,
       4 AS expected;

SELECT 'the_consumed_otp_challenge_has_no_attempts_left' AS check_name,
       (SELECT COUNT(*) FROM otp_challenges
         WHERE consumed_at IS NOT NULL AND attempts_remaining = 0) AS actual,
       1 AS expected;

SELECT 'exactly_one_otp_challenge_is_bound_to_no_user' AS check_name,
       (SELECT COUNT(*) FROM otp_challenges WHERE user_id IS NULL) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 18 — `sessions.sql`: SESSION E is ACTIVE AND PAST ITS EXPIRY, and it is
-- the only row in that state.
--
-- THE REASON `sessions.sql` IS ONE ROW LONGER THAN A STATUS ENUM NEEDS. Status
-- and deadline are DIFFERENT PREDICATES, and a fixture where every active row is
-- also unexpired makes them indistinguishable — an implementation that checked
-- only `status` would pass every other row here, and the row that separates them
-- is the one that would catch it.
--
-- The deadline is compared to a STATED INSTANT (1750000000000) rather than to the
-- clock, for the same reason as claim 9: this file's value is in the past and
-- always will be, and a fixture whose correctness expires is a fixture that
-- fails on a date instead of on a change.
-- ---------------------------------------------------------------------------
SELECT 'exactly_one_active_session_is_past_its_expiry' AS check_name,
       (SELECT COUNT(*) FROM sessions
         WHERE status = 'active' AND expires_at_ms < 1893456000000) AS actual,
       1 AS expected;

SELECT 'two_sessions_hold_a_stepped_up_flag_without_being_stale' AS check_name,
       (SELECT COUNT(*) FROM sessions
         WHERE recently_authenticated = 1
           AND security_version = (SELECT security_version FROM users
                                     WHERE id = sessions.user_id)) AS actual,
       2 AS expected;

SELECT 'every_aal2_session_is_either_stepped_up_or_stale' AS check_name,
       (SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.aal = 'aal2'
           AND NOT (s.recently_authenticated = 1
                    OR s.security_version <> u.security_version)) AS actual,
       0 AS expected;

SELECT 'exactly_one_session_has_no_credential_hash' AS check_name,
       (SELECT COUNT(*) FROM sessions WHERE credential_hash IS NULL) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 19 — `outbox_events.sql`: all three `OutboxEventType` constructors are
-- represented, and the producer never wrote `dispatch_attempts`.
--
-- THE FIRST HALF IS THE EVENT CONTRACT. `event-model.md` names exactly three
-- types and the constructors exist "so that a consumer's match arm and a producer's
-- write site cannot drift apart by typo". A fixture set that carried only one
-- would let a second constructor go unexercised, and the string in each row is the
-- one the constructor returns.
--
-- THE SECOND HALF IS THE PRODUCER RULE: "The producer must not write
-- dispatch_attempts. That column belongs to the dispatcher." The three UNDISPATCHED
-- rows are at 0, and EVENT 4 is at 3 having actually been dispatched — so the two
-- states are distinguishable, which is what a dispatcher query needs. Asserted as
-- an exact distribution because the file names each of the five rows individually.
--
-- The dead letter is at 25, the ceiling `OutboxEvent::MAX_DISPATCH_ATTEMPTS` names
-- and 0013's CHECK enforces. It is not 26: "a dead letter is a row sitting AT the
-- ceiling that nobody will pick up again, not a row counting past it."
-- ---------------------------------------------------------------------------
SELECT 'all_three_outbox_event_types_are_represented' AS check_name,
       (SELECT COUNT(DISTINCT event_type) FROM outbox_events) AS actual,
       3 AS expected;

SELECT 'the_dispatcher_state_distribution_is_exactly_as_described' AS check_name,
       (SELECT CASE WHEN
            (SELECT COUNT(*) FROM outbox_events
              WHERE dispatch_attempts = 0  AND dispatched_at_ms IS NULL) = 3
        AND (SELECT COUNT(*) FROM outbox_events
              WHERE dispatch_attempts = 3  AND dispatched_at_ms IS NOT NULL) = 1
        AND (SELECT COUNT(*) FROM outbox_events
              WHERE dispatch_attempts = 25 AND dispatched_at_ms IS NULL) = 1
            THEN 1 ELSE 0 END) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 20 — `audit_events.sql`: `user_id` and `actor_id` are SEPARATE COLUMNS,
-- and the separation is exercised.
--
-- The one row that proves the table is not one "user id" column is EVENT 3: a
-- suspension, where the subject and the actor are different people. "Collapsing
-- them into one 'user id' is how an audit log becomes unable to answer 'who
-- suspended me'."
--
-- Asserted as: at least one row where they differ, at least one where they are
-- equal (the self-service shape), and at least one with `user_id IS NULL` for an
-- APPLICATION event — `concerns_a_user()` returns FALSE for
-- `ApplicationSecretRotated`, "and `user_id` is NULL rather than pointing at the
-- application's owner. An audit log whose application events carried a user id
-- would make `QueryAudit.user_id` return rows about application registrations when
-- somebody asked about a person".
--
-- The NULL-for-an-application-event count is 1 exactly rather than >= 1, because a
-- second one would mean the fixture had two application events and the claim
-- above is about exactly the one in EVENT 6.
-- ---------------------------------------------------------------------------
SELECT 'an_audit_event_exists_whose_actor_is_not_its_subject' AS check_name,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM audit_events
                                  WHERE user_id IS NOT NULL
                                    AND actor_id IS NOT NULL
                                    AND user_id <> actor_id)
                   THEN 1 ELSE 0 END) AS actual,
       1 AS expected;

SELECT 'a_self_service_audit_event_exists' AS check_name,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM audit_events
                                  WHERE user_id IS NOT NULL
                                    AND user_id = actor_id)
                   THEN 1 ELSE 0 END) AS actual,
       1 AS expected;

SELECT 'exactly_one_application_event_has_no_user' AS check_name,
       (SELECT COUNT(*) FROM audit_events
         WHERE user_id IS NULL AND actor_id IS NOT NULL) AS actual,
       1 AS expected;

SELECT 'exactly_one_failed_authentication_is_about_nobody' AS check_name,
       (SELECT COUNT(*) FROM audit_events
         WHERE user_id IS NULL AND actor_id IS NULL) AS actual,
       1 AS expected;

SELECT 'every_audit_metadata_object_has_only_string_values' AS check_name,
       (SELECT COUNT(*) FROM audit_events a
         WHERE json_valid(a.metadata) = 0
            OR json_type(a.metadata) <> 'object') AS actual,
       0 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 21 — `user_identities.sql`: every `(provider, subject)` is distinct, and
-- `subject` never appears under two providers for the same person.
--
-- THE FILE RECORDS THAT IT OMITS a colliding row ON PURPOSE: the unique index
-- refused it during authoring, and "that refusal IS invariant #6" — so a fixture
-- containing the collision would abort rather than demonstrate anything. This
-- check is what makes the ABSENCE assertable instead of merely asserted.
--
-- `ux_user_identities_provider_subject` is UNIQUE over the pair, so the count of
-- distinct pairs equals the count of rows by construction. It is asserted anyway
-- because the second half is the property that matters and is NOT guaranteed by
-- that index: a person with a `google` subject `123` and a `github` subject `123`
-- are different identities, and a lookup keyed on `subject` ALONE would collapse
-- them. Here every subject happens to be unique across providers too, which is
-- the state that makes a subject-keyed lookup safe here — and only here.
-- ---------------------------------------------------------------------------
SELECT 'every_provider_subject_pair_is_distinct' AS check_name,
       (SELECT COUNT(*)
          FROM user_identities
         WHERE id IN (SELECT id FROM user_identities
                       GROUP BY provider, subject HAVING COUNT(*) > 1)) AS actual,
       0 AS expected;

SELECT 'every_subject_appears_under_exactly_one_provider' AS check_name,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM user_identities
                                  GROUP BY subject HAVING COUNT(*) > 1)
                   THEN 0 ELSE 1 END) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 22 — `user_emails.sql`: the unverified address is NOT primary, and no user
-- has two primary addresses.
--
-- THE COUNT HERE IS 0, NOT 1, and that is the correction worth reading.
-- `user_emails.sql` says the rule it cannot demonstrate is "only a VERIFIED
-- address may be primary", and its own header is honest that a row violating that
-- rule "cannot be here" because a violating INSERT would abort the file. So there
-- is NO primary-unverified row to find — and asserting a count of 1 would have been
-- asserting that the schema does not refuse, which is the failure this file exists
-- to prevent.
--
-- WHAT IS ASSERTED INSTEAD is the shape the fixture set actually has and the file
-- actually describes: USER 5's address is unverified (`verified_at_ms IS NULL`,
-- the only definition of unverified in this schema — there is no `verified`
-- boolean) and it is NOT primary, which is `is_primary = 0` taking the
-- cross-column CHECK's SECOND branch. A fixture set with no unverified row at all
-- would let that branch go unexercised.
--
-- `user_emails.sql` puts the demonstration of the FIRST branch's refusal in
-- `tests/integration/schema.test.mjs`, and it stays there: a demonstration cannot
-- live in a file that aborts on it.
-- ---------------------------------------------------------------------------
SELECT 'no_primary_address_is_unverified' AS check_name,
       (SELECT COUNT(*) FROM user_emails
         WHERE is_primary = 1 AND verified_at_ms IS NULL) AS actual,
       0 AS expected;

SELECT 'exactly_one_address_is_unverified_and_not_primary' AS check_name,
       (SELECT COUNT(*) FROM user_emails
         WHERE is_primary = 0 AND verified_at_ms IS NULL) AS actual,
       1 AS expected;

SELECT 'every_user_with_an_address_has_exactly_one_primary' AS check_name,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM user_emails
                                  WHERE is_primary = 1
                                  GROUP BY user_id HAVING COUNT(*) <> 1)
                   THEN 0 ELSE 1 END) AS actual,
       1 AS expected;

SELECT 'no_user_has_two_primary_addresses' AS check_name,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM user_emails
                                  WHERE is_primary = 1
                                  GROUP BY user_id HAVING COUNT(*) > 1)
                   THEN 0 ELSE 1 END) AS actual,
       1 AS expected;

-- ---------------------------------------------------------------------------
-- CLAIM 23 — `rate_limit_counters`: the platform-wide counter is the ONLY one in
-- the fixture set, and its window has not ended before it began.
--
-- The global limit is "no more than N of these per minute, anywhere", and it is
-- `subject IS NULL` because NULL means the platform-wide limit and "a separate
-- boolean column for 'is this global' would be a second source of truth for the
-- same fact".
--
-- TWO GLOBAL ROWS, NOT ONE, and that is the subtlety: `rate_limit_counters.sql`
-- has two `subject IS NULL` rows for the SAME name, `otp_send_email`, at `count =
-- 0` and `count = 40`. They are the same counter at two moments — the row the
-- upsert found, and the row it wrote — and both are loaded so a reader can see the
-- increment shape rather than a single frozen frame. 0016 says the increment is an
-- UPSERT precisely so two racing writers cannot create two rows, which means a
-- fixture holding two rows for one identity is depicting something the schema
-- prevents.
--
-- SO THE COUNT IS 2 and not 1, and this is worth being explicit about: it is NOT a
-- claim that the schema allows two global counters. It is a claim about what the
-- FIXTURE file contains, and the schema-level assertion — that a second
-- `subject IS NULL, name = 'otp_send_email'` row is REFUSED — lives in
-- `tests/integration/schema.test.mjs`, where a refusal can be observed without
-- leaving the fixture database half-loaded. Asserting `= 1` here would make this
-- check contradict its own file.
--
-- 0016's other claim is not asserted at all: that the limit is ENFORCED. The
-- limiter is `DEFERRED`, and a fixture row is a fact about storage, not about
-- enforcement.
--
-- `window_ends_at_ms` is an ABSOLUTE DEADLINE, which is why the second check is
-- the one worth having: a counter whose window ends before it starts is a row that
-- would refuse every operation for the rest of time, and no CHECK constraint in
-- 0016 catches it, because the column's CHECK is `>= 0`.
-- ---------------------------------------------------------------------------
SELECT 'exactly_two_rows_stand_in_for_the_one_global_otp_counter' AS check_name,
       (SELECT COUNT(*) FROM rate_limit_counters WHERE subject IS NULL) AS actual,
       2 AS expected;

SELECT 'the_global_otp_counter_appears_at_two_points_in_its_window' AS check_name,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM rate_limit_counters
                                  WHERE subject IS NULL AND count = 0)
             AND EXISTS (SELECT 1 FROM rate_limit_counters
                                  WHERE subject IS NULL AND count = 40)
            THEN 1 ELSE 0 END) AS actual,
       1 AS expected;

SELECT 'exactly_one_counter_is_scoped_to_a_subject' AS check_name,
       (SELECT COUNT(*) FROM rate_limit_counters WHERE subject IS NOT NULL) AS actual,
       1 AS expected;

SELECT 'no_rate_limit_counter_window_ends_before_it_started' AS check_name,
       (SELECT COUNT(*) FROM rate_limit_counters
         WHERE window_ends_at_ms < created_at_ms) AS actual,
       0 AS expected;
