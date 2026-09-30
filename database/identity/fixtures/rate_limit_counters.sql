-- ===========================================================================
-- rate_limit_counters.sql — the platform-wide counters, and the two states they
-- have a meaning in.
--
-- WHY THIS FILE IS SHORT
--
-- 0016 argues at length that this table is NOT where the platform's rate limits
-- live, and that argument is the reason this fixture has three rows rather than
-- forty:
--
--   failed OTP verifications  ->  otp_challenges.attempts_remaining (0007), which
--     is atomic by construction and already raced by a test
--   session creation          ->  DEFERRED
--   everything in THIS table  ->  limits where an approximation is acceptable
--
-- So a fixture that invented per-address OTP counters would be depicting a
-- mechanism the architecture deliberately rejected, and `otp_challenges.sql` is
-- already carrying the shape that matters.
--
-- WHAT IS HERE: two GLOBAL counters (`subject IS NULL`, one per limit name) in the
-- two states a windowed counter has, and one PER-SUBJECT counter so the composite
-- UNIQUE index is exercised from the side that is not the global one.
--
-- ===========================================================================
-- THE `subject IS NULL` ROWS ARE THE POINT, and they are NOT a gap
-- ===========================================================================
--
-- "NULLABLE, and NULL MEANS SOMETHING SPECIFIC: this is the platform-wide limit
-- (for example 'no more than N email sends per minute across the whole service'),
-- and it is one row rather than N. A separate boolean column for 'is this global'
-- would be a second source of truth for the same fact."
--
-- So the global counters are rows with no subject, and `assert_fixture_
-- invariants.sql` asserts there is exactly one of each — which is what makes "there
-- is exactly one platform-wide OTP send counter" a fact about the database rather
-- than about whoever writes the upsert.
--
-- THE `window_ends_at_ms` VALUES ARE 2030 ON PURPOSE. A fixture counter whose window
-- closed in 2025 would be indistinguishable from an expired one, and the reset path
-- ("if now >= window_ends_at_ms, reset the row") is a property of the WRITER,
-- which does not exist yet. Holding the window open keeps these rows describing a
-- counter in its current window rather than a counter that needs sweeping.
-- ===========================================================================

-- ===========================================================================
-- COUNTER 1 — otp_send_email, GLOBAL, IDLE, WINDOW OPEN
-- ===========================================================================
--
-- `count = 0` and `created_at_ms`/`updated_at_ms` stated as the same instant, so
-- the row says "the window opened and nothing has happened in it yet".
--
-- `window_ends_at_ms` is 2030, and `id` is stated for the same reason every other
-- fixture id is: a fixture that mints its key at load time cannot be referenced by
-- a second file.
INSERT INTO rate_limit_counters (id, subject, name, count, window_ends_at_ms,
                                 created_at_ms, updated_at_ms)
VALUES (
    'c1000000-0000-4000-8000-000000000001',
    NULL,
    'otp_send_email',
    0,
    1893456000000,
    1750000000000,
    1750000000000
);

-- ===========================================================================
-- COUNTER 2 — otp_send_email has been used: THE INCREMENT, WRITTEN BY A DISPATCHER
-- ===========================================================================
--
-- WAIT. THIS IS THE SAME COUNTER NAME AS COUNTER 1. That is deliberate and it is
-- what `ux_rate_limit_counters_subject_name` is FOR.
--
-- 0016's increment is:
--
--   UPDATE rate_limit_counters
--      SET count = count + 1, window_ends_at_ms = :next, updated_at_ms = :now
--    WHERE subject IS :subject AND name = :name;
--
-- and the reason it is an UPSERT rather than an INSERT is precisely that two
-- writers racing on a cold counter must not create two rows. THIS PAIR IS THE
-- EVIDENCE THAT IT DOES NOT: the second row is what the first would have BECOME
-- after 40 sends inside the same window, and the window is the SAME one — the
-- counter was not reset, it was incremented.
--
-- `count = 40` is "the limit is 50 and a flood is underway", which is the state an
-- operator looks at when a rate-limit spike turns into a support ticket. It is not
-- over the limit: 0016 says the OTP limits are set "below the level where a
-- boundary burst is meaningful", and a counter sitting exactly at its ceiling would
-- make the fixture assert a threshold nobody has chosen.
--
-- `updated_at_ms` is 700 ms after `created_at_ms`, so the row is internally
-- coherent about having been written to rather than merely created.
INSERT INTO rate_limit_counters (id, subject, name, count, window_ends_at_ms,
                                 created_at_ms, updated_at_ms)
VALUES (
    'c1000000-0000-4000-8000-000000000002',
    NULL,
    'otp_send_email',
    40,
    1893456000000,
    1750000000000,
    1750000700000
);

-- ===========================================================================
-- COUNTER 3 — A PER-SUBJECT COUNTER, so the composite UNIQUE index has two sides
-- ===========================================================================
--
-- THE ONLY ROW WITH A SUBJECT, and it is `token_exchange` for APP 1 — a client
-- identifier, which is the other subject 0016 names ("an address, a client id, a
-- session id").
--
-- IT EXISTS TO EXERCISE THE INDEX FROM THE NON-GLOBAL SIDE. `ux_rate_limit_
-- counters_subject_name` is UNIQUE over the PAIR, so its non-trivial behaviour is
-- only visible when two rows differ in subject — with every row being
-- `subject IS NULL`, the index would be tested only on the case 0016 says behaves
-- surprisingly and would never be tested on the ordinary one.
--
-- `count = 2` and the window is open. Nothing here asserts that the limit is
-- enforced; `identity-application`'s limiter is `DEFERRED`, and a fixture row is a
-- fact about storage, not about enforcement.
INSERT INTO rate_limit_counters (id, subject, name, count, window_ends_at_ms,
                                 created_at_ms, updated_at_ms)
VALUES (
    'c1000000-0000-4000-8000-000000000003',
    'ecoma-fixture-oidc-client',
    'token_exchange',
    2,
    1893456000000,
    1750000000000,
    1750000200000
);

-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ===========================================================================
--
-- No OTP VERIFICATION counter. That limit is `otp_challenges.attempts_remaining`,
-- and 0016 is explicit that "limits where an approximation is a bypass live next to
-- the data they protect, as an atomic conditional UPDATE. Writing them anywhere
-- else would be an approximation pretending to be a control." A fixture with a
-- durable `otp_verify` counter would depict the rejected design.
--
-- No counter whose window has ENDED. A closed window is the shape a sweeper exists
-- to find, and the sweeper does not exist. The reset path is also a WRITER
-- behaviour rather than a schema one, so a row demonstrating it would be claiming a
-- command that is `SCAFFOLDED`.
--
-- No per-EMAIL counter. 0016 names the growth problem this would make concrete:
-- "an attacker who sends login attempts from ten million distinct addresses
-- creates ten million rows, and none of them expire except through the window
-- sweep". One row is enough to make `subject` a populated column; ten thousand
-- would be a demonstration of the DoS rather than of the schema.
--
-- No second row for APP 1 with a different `name`, and none with the same pair.
-- The colliding row would abort the file — the same rule `user_identities.sql`
-- follows for the duplicate `(provider, subject)` — and the assertion that the pair
-- is unique belongs in `tests/integration/schema.test.mjs`, which can observe a
-- refusal without leaving the fixture database half-loaded.
