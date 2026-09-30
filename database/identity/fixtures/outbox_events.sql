-- ===========================================================================
-- outbox_events.sql — one row per `OutboxEventType` constructor, plus the two
-- states the dispatcher owns.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- `event-model.md` names exactly three event types and they are the contract,
-- because the constructors exist "so that a consumer's match arm and a producer's
-- write site cannot drift apart by typo":
--
--   OutboxEventType::email_send_v1()          identity.email.send.v1
--   OutboxEventType::security_notification_v1()  identity.security.notification.v1
--   OutboxEventType::audit_archive_v1()       identity.audit.archive.v1
--
-- One row for each. The point is not that the rows exist — it is that the string
-- in each row is the one the constructor returns, so a future producer and a
-- future consumer are reading the same literal this fixture pins.
--
-- THE PAYLOADS BELOW ARE SHAPED BY `contracts/events/v1/`, which is `DEFERRED`.
-- That is a real dependency and it is stated in every payload comment rather than
-- glossed: the JSON here is the shape the contract will describe, written first
-- so the contract has something concrete to be checked against, NOT a claim that
-- the contract exists.
--
-- NONE OF THESE ROWS HAS A CONSUMER, because `identity-jobs` is a placeholder
-- and `event-model.md` says "The Jobs Worker's queue consumer | DEFERRED — the
-- Worker is a placeholder". These rows are the producer's side of a pipeline whose
-- other end does not run.
-- ===========================================================================

-- ===========================================================================
-- EVENT 1 — identity.email.send.v1, UNDISPATCHED
-- ===========================================================================

-- `dispatch_attempts = 0` and `dispatched_at_ms IS NULL`: written by a producer,
-- not yet picked up. This is the state a command handler leaves behind, and it is
-- the state the dispatcher's claim query looks for.
--
-- `dispatch_attempts` is 0 BECAUSE THE PRODUCER WROTE ZERO and never wrote it at
-- all: "The producer must not write dispatch_attempts. That column belongs to the
-- dispatcher. If a command could increment it, a command that failed to publish
-- would advance the retry counter itself, and a misconfigured queue would exhaust
-- its budget without the dispatcher ever having tried." The DEFAULT is 0 and this
-- INSERT does not name the column, which is how a producer's INSERT stays on the
-- right side of that rule by construction.
--
-- `occurred_at_ms` is STATED, not defaulted: "when the fact was committed", which
-- is not the same as "when the row was inserted" for a batching producer, and an
-- audit question about ordering depends on the difference.
--
-- The payload carries the RECIPIENT and the TEMPLATE, which is the whole of an
-- email-send event. It does NOT carry a code. `contracts/events/v1/` is the
-- authority and it is `DEFERRED`; the honest statement here is that the payload's
-- fields are a proposal this fixture pins so a consumer has something to read.
INSERT INTO outbox_events (id, event_type, payload, occurred_at_ms)
VALUES (
    'b0000000-0000-4000-8000-000000000001',
    'identity.email.send.v1',
    '{"to":"active@fixture.invalid","template":"login_code","locale":"en"}',
    1750000000000
);

-- ===========================================================================
-- EVENT 2 — identity.security.notification.v1, UNDISPATCHED
-- ===========================================================================
--
-- The second type, and the one whose delivery matters most: "a security-relevant
-- notice (a new factor enrolled, a session revoked elsewhere)".
--
-- THE PAYLOAD NAMES A SESSION. That is deliberate and it is the property
-- `event-model.md` spends a paragraph on: "For an event whose effect is *itself*
-- idempotent, the window closes... The dangerous case is only the outbound side
-- effect — the email." A duplicate security notification is a support ticket; a
-- silently dropped one is an incident where a user is not told their session was
-- revoked. So this consumer is the one that must record its progress AFTER the
-- effect, and the payload carrying a session id is what makes a duplicate visible
-- rather than invisible.
--
-- The `subject` names USER 8 — the account whose `security_version` was bumped in
-- `users.sql`. The three fixture files together tell one story: this account's
-- sessions are stale, its version was bumped, and somebody is going to be told.
INSERT INTO outbox_events (id, event_type, payload, occurred_at_ms)
VALUES (
    'b0000000-0000-4000-8000-000000000002',
    'identity.security.notification.v1',
    '{"user_id":"f0000000-0000-4000-8000-000000000008","kind":"all_sessions_revoked","revoked_session_count":2}',
    1750000600000
);

-- ===========================================================================
-- EVENT 3 — identity.audit.archive.v1, UNDISPATCHED
-- ===========================================================================
--
-- The third type, and the one whose effect IS idempotent: "an `audit.archive.v1`
-- that copies a settled row to cold storage is naturally idempotent, and the
-- two-orders question does not arise."
--
-- The payload names an audit event id. It does not have to EXIST — there is no
-- FK from outbox_events into audit_events, and there should not be: the outbox is
-- written in the same transaction as the fact it announces, but the CONSUMER runs
-- later, and a consumer that refused to copy a row whose source had been archived
-- would be a consumer that loses data.
--
-- (Not that an audit row is ever deleted: `audit_events` is append-only and
-- "there is no update path and no delete path". The row named here is a fixture
-- reference to an event id that exists in `audit_events.sql`.)
INSERT INTO outbox_events (id, event_type, payload, occurred_at_ms)
VALUES (
    'b0000000-0000-4000-8000-000000000003',
    'identity.audit.archive.v1',
    '{"audit_event_id":"d0000000-0000-4000-8000-000000000001","cold_storage_bucket":"audit-2025"}',
    1750001200000
);

-- ===========================================================================
-- EVENT 4 — ALREADY DISPATCHED: the row the dispatcher has finished with
-- ===========================================================================
--
-- `dispatch_attempts = 3` and `dispatched_at_ms` set. Three attempts, not one:
-- a dispatcher that always succeeds on the first try is not the thing
-- at-least-once delivery is designed around, and an index that claimed to serve
-- "what has been sent" while every row in the fixture set had `dispatch_attempts
-- = 1` would not be exercised by the data it claims to index.
--
-- `dispatched_at_ms` is LATER than `occurred_at_ms` and the gap is large, which
-- is the whole reason there are two columns: "a message that sat in the outbox for
-- two hours during a queue outage describes a fact that happened two hours ago".
--
-- `ix_outbox_events_dispatched` is `WHERE dispatched_at_ms IS NOT NULL`, so this
-- row and only this row is in it.
INSERT INTO outbox_events (id, event_type, payload, occurred_at_ms,
                           dispatch_attempts, dispatched_at_ms)
VALUES (
    'b0000000-0000-4000-8000-000000000004',
    'identity.email.send.v1',
    '{"to":"support@fixture.invalid","template":"security_alert","locale":"en"}',
    1750001800000,
    3,
    1750009000000
);

-- ===========================================================================
-- EVENT 5 — THE DEAD LETTER: dispatch_attempts AT THE CEILING OF 25
-- ===========================================================================
--
-- `OutboxEvent::MAX_DISPATCH_ATTEMPTS` is 25, and this row is AT 25. It is the
-- row `ix_outbox_events_dead_letter` exists for — a PARTIAL index over
-- `dispatch_attempts = 25`, holding at most one row per dead event for the
-- entire life of the database.
--
-- THE NUMBER IS 25 AND NOT 26 BECAUSE THE SCHEMA CHECKS
-- `dispatch_attempts BETWEEN 0 AND 25`. A dead letter is a row sitting AT the
-- ceiling that nobody will pick up again, not a row counting past it. The CHECK's
-- job is to refuse the value a careless increment past the ceiling would produce,
-- so that a dispatcher's off-by-one is a constraint violation on a single row
-- rather than a column of numbers that quietly means "attempt 26" when the code
-- believes it means "dead".
--
-- `dispatched_at_ms IS NULL` even though it was attempted twenty-five times,
-- because it was NEVER SUCCESSFULLY DISPATCHED. That is the state an operator
-- looks at and has to make a decision about: "Replaying a dead letter is an
-- operator action, deliberately, on a row someone looked at." A dead letter is
-- NOT silently dropped.
INSERT INTO outbox_events (id, event_type, payload, occurred_at_ms,
                           dispatch_attempts, dispatched_at_ms)
VALUES (
    'b0000000-0000-4000-8000-000000000005',
    'identity.email.send.v1',
    '{"to":"nobody-here@fixture.invalid","template":"login_code","locale":"en"}',
    1750002400000,
    25,
    NULL
);

-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ===========================================================================
--
-- No row with an unversioned event_type, and no row with `dispatch_attempts =
-- 26`. Both are refused by the schema and the demonstration of each is an
-- assertion in `tests/integration/schema.test.mjs` rather than a row here — a
-- fixture file that aborts half way is not a fixture, which is the same rule
-- `user_identities.sql` follows for the duplicate subject.
--
-- No row for a second producer. The `GLOB 'identity.*'` half of the event_type
-- CHECK exists so a queue carrying events from more than one producer can tell
-- them apart without a registry, and this platform is the only producer today.
-- A second one would need a namespace of its own and a decision about who
-- subscribes to what.
--
-- No `consumed` flag. There is no column for one and there is no reason to add
-- one: the consumer's idempotency record lives in `JOBS_KV` and is a cache of the
-- consumer's OWN PROGRESS, not a property of the outbox row. D1 holds the
-- record of the FACT; the queue may deliver it many times; the consumer decides
-- once. Putting a `consumed_at` here would create a second source of truth for
-- "has this had its effect", which is precisely the copy `event-model.md` warns
-- against.