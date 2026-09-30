-- ===========================================================================
-- otp_challenges.sql — outstanding, consumed, and never-issued challenges.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- THE RACE. This file is the setup for the one test in the repository that
-- actually races two verifications rather than asserting that the code looks
-- atomic, and its shape is dictated by that test:
--
--   * CHALLENGE A is OUTSTANDING: `consumed_at IS NULL`, `attempts_remaining > 0`,
--     and `expires_at_ms` in the future. Every predicate in the guard is
--     satisfied, so the FIRST conditional UPDATE must return exactly one row.
--   * CHALLENGE B is ALREADY CONSUMED: `consumed_at` set. Its `attempts_remaining`
--     is 0 as well, so both of the guard's predicates fail and it demonstrates
--     the exhausted-and-consumed case.
--   * CHALLENGE C is UNEXPIRED-AND-UNCONSUMED but with `attempts_remaining = 1`,
--     which is the adjacent race the guard closes by setting the counter to 0 in
--     the SAME UPDATE rather than in a second statement. See below.
--   * CHALLENGE D is EXPIRED: `expires_at_ms` in the past with `consumed_at IS
--     NULL`, so a stale challenge is refused by the time predicate alone.
--
-- THE GUARD UNDER TEST, verbatim from 0007's header:
--
--   UPDATE otp_challenges
--      SET consumed_at = :now, attempts_remaining = 0, updated_at_ms = :now
--    WHERE id = :challenge_id
--      AND consumed_at IS NULL        -- still outstanding
--      AND attempts_remaining > 0     -- not exhausted
--      AND :now < expires_at_ms       -- not stale
--   RETURNING id;
--
-- One row returned is the first redemption. ZERO rows is the failure, and the
-- caller's answer is to refuse — not to retry, not to check again.
-- ===========================================================================

-- ===========================================================================
-- CHALLENGE A — the outstanding one, and the row the race test races on
-- ===========================================================================
--
-- `user_id` is SET. This is the "email login for a KNOWN address" branch, and
-- `StartEmailLoginOutcome::CodeSent` is the outcome this challenge corresponds
-- to.
--
-- `code_hash` is 32 arbitrary bytes standing in for SHA-256(output). It is a
-- fixture and NOT a code: `OTP_LENGTH` is 6, so the code space is a million
-- values, and the honest note in 0007 is that a fast hash over a six-digit code
-- is NOT protection against database read access — about twenty bits, which a
-- GPU exhausts in under a second. The real defences are the short lifetime, the
-- attempt ceiling and the rate limiter, and none of them is this column.
--
-- `attempts_remaining = 5` is the default and the shape every challenge starts
-- in.
--
-- `expires_at_ms` is 2030-01-01. A fixture that expired this row would make the
-- race test prove that stale challenges are refused, which is a different claim.
INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                            expires_at_ms, attempts_remaining)
VALUES (
    '70000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000002',
    'email',
    'active@fixture.invalid',
    X'00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF',
    1893456000000,
    5
);

-- ===========================================================================
-- CHALLENGE B — CONSUMED. The "already redeemed" half of the race.
-- ===========================================================================
--
-- `consumed_at` is set and `attempts_remaining = 0`, so BOTH of the guard's
-- second and third predicates fail. A challenge the guard leaves in exactly this
-- state after a successful redemption, which is what makes it the correct
-- fixture for "a second redemption of the SAME row returns zero rows".
--
-- `consumed_at >= created_at_ms` is the CHECK on this column, and it is not
-- vacuous. A caller that computed "now" in SECONDS where the column is
-- milliseconds writes a value around 1.7 billion and the CHECK refuses it — see
-- 0007's comment for the reasoning.
--
-- `updated_at_ms` is set to the same value, because the guard sets both in one
-- statement.
--
-- `created_at_ms` IS SET EXPLICITLY HERE AND IN CHALLENGE D, and that is not
-- tidiness — it is the CHECK below refusing to be lied to. `consumed_at >=
-- created_at_ms` compares against THIS ROW'S OWN creation time, so a fixture
-- claiming "consumed at 2025-06-15" on a row the database believes was created
-- moments ago is refused. That is the CHECK working: it catches a caller that
-- computed "now" in seconds where the column is milliseconds, and it catches a
-- fixture that was written by hand without its timestamps in order.
--
-- So this row's creation time is stated, and it is the SAME instant as its
-- consumption: a challenge that was issued and redeemed within the same
-- millisecond is a legal row and is the honest shape for "consumed almost
-- immediately".
INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                            expires_at_ms, attempts_remaining,
                            consumed_at, created_at_ms, updated_at_ms)
VALUES (
    '70000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002',
    'email',
    'active@fixture.invalid',
    X'11223344556677889900AABBCCDDEEFF11223344556677889900AABBCCDDEEFF',
    1893456000000,
    0,
    1750000000000,
    1750000000000,
    1750000000000
);

-- ===========================================================================
-- CHALLENGE C — ONE ATTEMPT REMAINING, unconsumed, unexpired
-- ===========================================================================
--
-- THE ADJACENT RACE, and the reason the guard sets `attempts_remaining = 0` in
-- the SAME UPDATE rather than decrementing it in a second statement.
--
-- The failure it prevents: a verify step that does
--
--   UPDATE otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
--
-- and separately does
--
--   UPDATE otp_challenges SET attempts_remaining = attempts_remaining - 1
--
-- Two concurrent callers at ONE attempt remaining both pass the consumed
-- predicate? No — only one can win `consumed_at IS NULL`. But the moment the
-- consumed guard is written as a plain UPDATE without the attempts predicate,
-- the sequence "mark consumed, then decrement" has a window: the first caller
-- commits the consume, the second caller's decrement lands, and the attempt
-- budget is off by one against a row nobody will read again.
--
-- Writing `attempts_remaining = 0` in the same statement makes the attempt budget
-- and the consumption ONE fact, so there is no window and no second statement to
-- race. This fixture is the row that makes the distinction testable: a
-- verification that decrements separately would leave this row at 1 or 0
-- depending on how many callers arrived, and a test that races two verifications
-- of it can observe which.
--
-- The row is UNCONSUMED and UNEXPIRED on purpose — every predicate the guard
-- checks is true except attempts_remaining, which is 1 and therefore still
-- passes. This challenge is REDEEMABLE exactly once, which is the claim.
INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                            expires_at_ms, attempts_remaining)
VALUES (
    '70000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000002',
    'email',
    'active@fixture.invalid',
    X'22334455667788990011AABBCCDDEEFF22334455667788990011AABBCCDDEEFF',
    1893456000000,
    1
);

-- ===========================================================================
-- CHALLENGE D — EXPIRED, unconsumed, with attempts left
-- ===========================================================================
--
-- The time predicate's case. `consumed_at IS NULL` and `attempts_remaining > 0`
-- both hold, so ONLY `:now < expires_at_ms` can refuse this row. A fixture set
-- where every stale challenge was also exhausted would let an implementation that
-- dropped the expiry check pass every test in this directory.
--
-- The expiry is in 2025, which is in the past relative to any `now` a test will
-- pass. Nothing here uses `unixepoch()`: the value is fixed so the fixture does
-- not change meaning in a year, and so the row's staleness is a fact rather than
-- a computation.
--
-- `created_at_ms` is set for the same reason as CHALLENGE B's, and it is EARLIER
-- than its expiry, so the row is internally coherent: issued in 2025, expired in
-- 2025, never redeemed.
INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                            expires_at_ms, attempts_remaining, created_at_ms)
VALUES (
    '70000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000002',
    'email',
    'active@fixture.invalid',
    X'3344556677889900AABBCCDDEEFF3344556677889900AABBCCDDEEFF00112233',
    1750003600000,
    5,
    1750000000000
);

-- ===========================================================================
-- CHALLENGE E — user_id IS NULL: the enumeration-safe branch
-- ===========================================================================
--
-- This is the row that matters most for the property nobody can see, and it is
-- the one the schema comment on `user_id` says must not be "fixed":
--
--   `StartEmailLoginOutcome` has two variants — `CodeSent` and `Accepted` —
--   which exist so the RESPONSE is identical whether or not the address is
--   registered. The challenge row is the storage half of that indistinguishability,
--   and `user_id` is NULLABLE precisely so an unrecognised address still gets a
--   challenge.
--
-- A NOT NULL column here would force the flow to look up the account before
-- sending, which is exactly the enumeration oracle the two-variant outcome
-- exists to remove. So: NULL, and a comment saying why it must stay that way.
--
-- `via = 'email'` and a real-looking address, because the flow still sends
-- SOMETHING — the point is that the response, the timing and the row's shape are
-- all indistinguishable from CHALLENGE A's except for the null user_id.
INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                            expires_at_ms, attempts_remaining)
VALUES (
    '70000000-0000-4000-8000-000000000005',
    NULL,
    'email',
    'nobody-here@fixture.invalid',
    X'44556677889900AABBCCDDEEFF11223344556677889900AABBCCDDEEFF112233',
    1893456000000,
    5
);

-- ===========================================================================
-- CHALLENGE F — via SMS, for the `via` CHECK
-- ===========================================================================
--
-- `DeliveryDestination` is serde-tagged as `{ via, address }` with `via`
-- internal or external, and the schema stores `via` as 'email' or 'sms'. The
-- fixture covers the second value so the CHECK is exercised from both sides —
-- though note this platform has no SMS PROVIDER and the column is here because
-- `DeliveryDestination`'s enum has the variant, not because SMS is planned.
--
-- `via = 'sms'` with an email-shaped address is deliberate nonsense that the
-- schema permits, and it is worth a line: the column cannot know whether an
-- address is a phone number, and a schema that tried would be re-implementing
-- validation the application layer owns. What the schema DOES check is that the
-- address is non-empty and plausible in length.
INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                            expires_at_ms, attempts_remaining)
VALUES (
    '70000000-0000-4000-8000-000000000006',
    'f0000000-0000-4000-8000-000000000006',
    'sms',
    '+15555550100',
    X'556677889900AABBCCDDEEFF11223344556677889900AABBCCDDEEFF11223344',
    1893456000000,
    5
);