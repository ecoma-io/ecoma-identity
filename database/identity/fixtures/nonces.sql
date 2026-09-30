-- ===========================================================================
-- nonces.sql — issued OpenID Connect nonces, and the two facts about each that
-- `NonceService::consume` has to read atomically.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- `NonceService` has exactly two methods, and the table serves them differently:
--
--   issue(&SessionId)          -> INSERT, one row per browser authentication
--   consume(&SessionId, nonce) -> the conditional UPDATE, at most one row
--
-- `consume` returns a `bool` rather than an error "because 'was this valid' and
-- 'tell me why not' are different needs". So the answer has to be ONE FACT read
-- atomically. The guard is, verbatim from 0012:
--
--   UPDATE nonces SET consumed_at = :now
--    WHERE nonce = :nonce AND session_id = :session_id AND consumed_at IS NULL
--   RETURNING nonce;
--
-- ONE ROW is the first consumption and the caller proceeds. ZERO ROWS means it was
-- already consumed and the caller returns `Ok(false)` — "Returning rather than
-- erroring", per the trait doc. Zero rows during a redeploy is the ordinary case,
-- not an incident.
--
-- WHAT IS HERE: one outstanding nonce per session in the fixture set, one already
-- consumed, one bound to a DIFFERENT session than the one that presented it (the
-- case a CSRF filter exists to refuse), and one issued by nobody that will ever
-- present it.
--
-- ===========================================================================
-- THE `nonce` VALUES ARE NOT DIGESTS, AND THAT IS THE POINT
-- ===========================================================================
--
-- 0012 stores the nonce IN THE CLEAR and argues at length why: a nonce's
-- security property is UNPREDICTABILITY and SINGLE USE, not the secrecy of a
-- replayable bearer credential. So these rows hold the nonce itself, which is
-- what makes this fixture able to state something a hashed fixture could not —
-- that a test can present one of these exact strings to `consume` and get a
-- deterministic answer.
--
-- THESE ARE READABLE FIXTURE STRINGS, NOT NONCES THE PLATFORM WOULD ISSUE.
-- Constraint §25 means the real generator is `crypto.getRandomValues`, and the
-- platform's `NonceService::issue` does not exist yet. Every value below is 40
-- characters of `fixture-nonce-...` text: inside 0012's `length BETWEEN 16 AND
-- 128`, carrying no entropy whatsoever, and safe to write down for the reason the
-- table's own comment gives — "an attacker who learns a nonce from a log or a URL
-- bar can consume it, but consuming it DENIES the legitimate browser its session,
-- which is a denial of service against themselves."
--
-- `assert_fixture_invariants.sql` asserts that every nonce here is distinct,
-- which is the property a real generator would have to guarantee and this table
-- cannot CHECK for free.
-- ===========================================================================

-- ===========================================================================
-- NONCES 1 TO 6 — ONE OUTSTANDING NONCE PER SESSION, ISSUED DURING A FLOW
-- ===========================================================================
--
-- SESSION A through SESSION E in `sessions.sql`, all of USER 2 except the last
-- one, which is SESSION E (USER 5, `pending_verification`).
--
-- WHY ONE PER SESSION RATHER THAN ONE PER USER: a nonce is issued DURING a
-- browser authentication and consumed at the callback, and the session is what
-- binds the two halves together — "a nonce bound to a session is what makes it a
-- CSRF filter and not a bearer token". Two outstanding nonces for one user in two
-- browsers is the normal case, not an anomaly, and a fixture that had one per
-- user would make the session binding look like a uniqueness rule it is not.
--
-- 0012 has NO INDEX on `session_id` and says so deliberately ("No query asks
-- 'every nonce issued to this session'"). These six rows therefore exist for a
-- test that iterates them by primary key, not for one that queries by session —
-- and a test that wanted to look them up by session would be the query the
-- migration argues does not exist.
--
-- `created_at_ms` is stated on the first two rows and left to the DEFAULT on the
-- rest, so both shapes are present: a flow that started at a known instant and a
-- flow whose issue time the fixture does not care about.
INSERT INTO nonces (nonce, session_id, created_at_ms)
VALUES ('fixture-nonce-0001-outstanding-session-a-00001',
        '51000000-0000-4000-8000-000000000001',
        1750000000000);

INSERT INTO nonces (nonce, session_id)
VALUES ('fixture-nonce-0002-outstanding-session-b-00002',
        '51000000-0000-4000-8000-000000000002');

INSERT INTO nonces (nonce, session_id)
VALUES ('fixture-nonce-0003-outstanding-session-c-00003',
        '51000000-0000-4000-8000-000000000003');

INSERT INTO nonces (nonce, session_id)
VALUES ('fixture-nonce-0004-outstanding-session-d-00004',
        '51000000-0000-4000-8000-000000000004');

INSERT INTO nonces (nonce, session_id)
VALUES ('fixture-nonce-0005-outstanding-session-e-00005',
        '51000000-0000-4000-8000-000000000005');

-- ===========================================================================
-- NONCE 6 — ALREADY CONSUMED: the row the second `consume` finds
-- ===========================================================================
--
-- The successful callback happened. `consumed_at` is set, so running the guard
-- against this row returns ZERO ROWS and the caller answers `Ok(false)`.
--
-- THE INTERESTING PART IS `consumed_at` = 1750000030000, which is AFTER the
-- issue time 1750000000000 stated on NONCE 1 and coincidentally equal to the
-- `occurred_at_ms` of EVENT 2 in `outbox_events.sql` — that is deliberate
-- cross-file coherence, not a coincidence: both describe the same callback, and a
-- fixture set whose two halves of one event disagreed about its instant would be
-- a fixture set nobody could reason about.
--
-- (This is a different session from NONCE 1, so the two rows do not need to be
-- ordered against each other. The comparison the platform would care about is on
-- one row, and `tests/integration/schema.test.mjs` asserts that one directly
-- rather than inferring it from two.)
INSERT INTO nonces (nonce, session_id, created_at_ms, consumed_at)
VALUES ('fixture-nonce-0006-consumed-after-callback-0006',
        '51000000-0000-4000-8000-000000000006',
        1750000000000,
        1750000030000);

-- ===========================================================================
-- NONCE 7 — THE CSRF CASE: A VALID NONCE PRESENTED BY THE WRONG SESSION
-- ===========================================================================
--
-- THIS ROW IS WHY `consume` TAKES TWO ARGUMENTS. `consume(&SessionId, nonce)`
-- looks the value up AND compares the session id as a predicate, and this is the
-- row that predicate refuses.
--
-- THE ATTACK, IN THE SHAPE THIS SCHEMA CAN REPRESENT: an attacker who can get a
-- browser to visit a callback URL — by embedding it in an `<img>`, a form post, or
-- a link the user clicks — supplies a nonce. If `consume` took only the nonce, the
-- attacker's value would be checked and consumed, the attacker's ID token would be
-- issued, and the browser would carry the result straight to the attacker's
-- `redirect_uri`. With the session predicate, the same value is refused because it
-- is not bound to the session that browser actually has.
--
-- THE ROW ITSELF IS PERFECTLY VALID. It is outstanding, unbound to nothing, and
-- `consumed_at IS NULL`. Nothing is wrong with it; what is wrong is the pairing
-- of this nonce with SESSION B rather than SESSION A. A fixture can only state the
-- valid half of that, so the comment above is what makes the fixture useful and
-- `tests/integration/schema.test.mjs` is where the assertion lives: run the guard
-- as ('session-a', nonce-7) — zero rows — then as ('session-a', nonce-1) — one
-- row, which is what proves the difference is the session and nothing else.
--
-- `user_id` DOES NOT EXIST ON THIS TABLE, which is what makes a nonce a CSRF
-- filter rather than a login: the row says which SESSION the value was issued to
-- and never says who that session belongs to. Binding to a user instead would put
-- a "who is logging in" fact inside the replay-protection record, and a login
-- form's CSRF token is not a place to store the subject.
INSERT INTO nonces (nonce, session_id)
VALUES ('fixture-nonce-0007-issued-to-session-a-00007',
        '51000000-0000-4000-8000-000000000001');

-- ===========================================================================
-- NONCE 8 — ORPHANED: ITS SESSION HAS NO ROW IN `sessions.sql`
-- ===========================================================================
--
-- `session_id` here is `51000000-0000-4000-8000-000000000009`, which appears
-- NOWHERE else in the fixture set, and 0012 has NO FOREIGN KEY from `session_id`
-- to `sessions.id` — "a deliberate departure from every other id-bearing column in
-- this schema", because "a session is disposable, and a foreign key would let a
-- session purge cascade into rows that are evidence of something having been
-- issued".
--
-- THIS ROW IS THE FIXTURE THAT MAKES THAT DECISION TESTABLE. With the foreign key
-- in place, this INSERT would abort and the migration's reasoning would be prose
-- nobody had ever exercised. Without it, the row exists and the platform's
-- tolerance for it is observable: `consume` requires the session id to match, and
-- "a session that no longer exists has no id any caller can present" — so the
-- orphan is inert, and an inert row is the correct end state rather than a
-- dangling reference to be cleaned up by a cascade.
--
-- 0012 also notes the consequence it is choosing not to avoid: "an orphaned nonce
-- row outlives its session". THIS IS THAT ROW.
INSERT INTO nonces (nonce, session_id)
VALUES ('fixture-nonce-0008-orphaned-session-000009',
        '51000000-0000-4000-8000-000000000009');

-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ===========================================================================
--
-- No `expires_at_ms`, and no row that pretends otherwise. 0012 has no deadline
-- column and says why: "a nonce that has not been consumed after a week is not
-- exploitable", and "IF a deadline is added later, that is a widening". A fixture
-- column that does not exist cannot be populated, which is the whole point.
--
-- No row for the revoked or expired sessions (C, D). Those flows did not reach a
-- callback, so no nonce was ever issued for them, and a fixture that put one there
-- would describe a flow the session fixture says did not happen.
--
-- No row for USER 8. Its sessions F and G are stale under the `security_version`
-- bump — they belong to a version of the account that no longer exists — and a
-- nonce issued during a flow those sessions cannot represent would be a fixture
-- claiming the bump did not revoke anything. The bump's own story is told by
-- `users.sql`, `sessions.sql` and `audit_events.sql` EVENT 5.
--
-- No duplicated `nonce` value. The primary key would refuse it and a fixture file
-- that aborts half way is not a fixture — the same rule `user_identities.sql`
-- follows for the duplicate `(provider, subject)`.
--
-- No row with `session_id` empty or shorter than 1 character; the column's CHECK
-- is `length(session_id) BETWEEN 1 AND 64`, and the demonstration belongs in
-- `tests/integration/schema.test.mjs`.
