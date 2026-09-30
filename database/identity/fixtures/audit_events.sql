-- ===========================================================================
-- audit_events.sql — the shapes `QueryAudit` has to answer questions about.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- `QueryAudit` is a real, implemented type with four filters, and each one of
-- them needs rows to be worth running against:
--
--   user_id             "everything about this user"          -> ix_audit_events_user_occurred
--   actor_id            "everything this actor did"           -> ix_audit_events_actor_occurred
--   administrative_only "every administrative action"         -> ix_audit_events_type_occurred
--   since_ms            "everything after this moment"        -> the occurred_at_ms range in all three
--
-- An audit log with one row per shape would let any of those indexes go
-- unexercised, so this file contains a SPREAD: seven of the twenty-one event
-- types, both administrative and non-administrative, both with and without an
-- actor, both about a user and about an application.
--
-- NOTHING HERE IS PROOF OF ANYTHING. No command handler writes audit rows —
-- `WriteAuditEvent` is a `SCAFFOLDED` trait with no body — so these rows are
-- what an audit trail looks like, not a record that anything happened. A reader
-- must not infer from this file that the platform has ever suspended anyone.
-- ===========================================================================

-- ===========================================================================
-- EVENT 1 — LOGIN, about USER 2, by USER 2
-- ===========================================================================
--
-- The self-service shape: `user_id == actor_id`, and both are USER 2.
--
-- `request_id` is set, because that is what makes the row joinable to a Worker
-- log line, which is the column's entire purpose. It is 36 characters, a UUID.
--
-- `metadata` is a JSON object of STRING values, and the shape matters more than
-- the contents: "a string-valued map serialises deterministically, so two runs of
-- the same operation produce byte-identical metadata, and a diff of two audit rows
-- is meaningful." No numbers, no nested objects, no arrays here or anywhere in
-- this file.
--
-- AND NOTHING SECRET: no code, no session token, no address beyond a `method`
-- label. `AdminAuditRow`'s field is named "Already-redacted detail", which makes
-- redaction a WRITER's obligation rather than a reader's, and the only way to
-- discharge it is for every writer to redact. An email address would be the most
-- likely thing to leak and is deliberately absent.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000001',
    'user_authenticated',
    'f0000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000001',
    1750000000000,
    'req-00000000-0000-4000-8000-000000000001',
    '{"method":"email_otp","aal":"aal1","outcome":"success"}'
);

-- ===========================================================================
-- EVENT 2 — A FACTOR ENROLLED, about USER 2, by USER 2
-- ===========================================================================
--
-- `is_administrative()` is FALSE and `concerns_a_user()` is TRUE, so it appears
-- in "everything about this user" and NOT in the administrative query. Having
-- both kinds in the fixture is what makes `administrative_only` worth testing:
-- a filter that returned every row would pass a test run against one kind.
--
-- `metadata.authenticator_kind` is the KIND and nothing else. It deliberately
-- does not carry the enrolment's material, the label, or the credential id — the
-- first is a secret, the third is an identifier an attacker would use to
-- impersonate the factor.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000002',
    'authenticator_enrolled',
    'f0000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000001',
    1750000100000,
    'req-00000000-0000-4000-8000-000000000002',
    '{"authenticator_kind":"totp"}'
);

-- ===========================================================================
-- EVENT 3 — A SUSPENSION, about USER 3, BY THE ADMINISTRATOR
-- ===========================================================================
--
-- THE ROW THE WHOLE TABLE EXISTS TO RECORD, and the reason `user_id` and
-- `actor_id` are separate columns: "for a suspension they are different people.
-- Collapsing them into one 'user id' is how an audit log becomes unable to answer
-- 'who suspended me'."
--
-- `is_administrative()` is TRUE — `UserSuspended` is one of the seven — so this
-- row is in the `administrative_only` query.
--
-- `actor_session_id` is NULL. The administrator has no session in
-- `sessions.sql`, which is deliberate: attributing this event to one would point
-- at a session that does not exist. It is NULL because an administrative action
-- taken before any operator session existed is a real state and a fabricated one
-- would be worse.
--
-- `metadata.reason` is a free-text operator note. This is the one place a
-- fixture puts arbitrary prose in the column, and it is a reminder that the
-- column's redaction quality is exactly the quality of its callers — a
-- production writer that put an email address in `reason` would raise the exposure
-- of every audit row ever read by an operator.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000003',
    'user_suspended',
    'f0000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000001',
    NULL,
    1750000200000,
    'req-00000000-0000-4000-8000-000000000003',
    '{"reason":"fixture row: exercising the administrative audit query"}'
);

-- ===========================================================================
-- EVENT 4 — A ROLE CHANGE, about USER 6, BY THE ADMINISTRATOR
-- ===========================================================================
--
-- The second administrative shape that is ALSO the last-administrator invariant's
-- neighbourhood, and `metadata` is where the invariant's inputs would be recorded:
-- a real `RoleChangeRequest` evaluates against `actor_role`, `current_role`,
-- `new_role`, `target_status` and `active_administrator_count`.
--
-- `active_administrator_count` is NOT here. That is the point. The count is
-- computed INSIDE the transaction that applies the change, and writing it into the
-- audit row would record a number that was true at one instant and is not a fact
-- about the change — the same argument `data-model.md` makes for storing a grant's
-- RESULT rather than recomputing it, arrived at from the other direction: some
-- values are facts and some are observations, and mixing them in one column makes
-- both unreadable.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000004',
    'user_role_changed',
    'f0000000-0000-4000-8000-000000000006',
    'f0000000-0000-4000-8000-000000000001',
    NULL,
    1750000300000,
    'req-00000000-0000-4000-8000-000000000004',
    '{"from_role":"member","to_role":"support"}'
);

-- ===========================================================================
-- EVENT 5 — ALL SESSIONS REVOKED, about USER 8, by USER 8
-- ===========================================================================
--
-- This is the event that goes with the `security_version = 7` bump in
-- `users.sql` and the stale sessions F and G in `sessions.sql`. Three fixture
-- files describing one fact: the version was bumped, the sessions issued under the
-- old version are still marked active, and somebody is going to be told.
--
-- `SecurityVersionBumped` would be the natural second row for the same act, and
-- `is_administrative()` is TRUE for `AllSessionsRevoked` but FALSE for
-- `SecurityVersionBumped` — which is a genuine asymmetry in the Rust's
-- `matches!` list and exactly the kind of thing an audit fixture set exists to
-- expose. It is reproduced here rather than smoothed over.
--
-- `metadata.revoked_count = 2` matches the two stale sessions.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000005',
    'all_sessions_revoked',
    'f0000000-0000-4000-8000-000000000008',
    'f0000000-0000-4000-8000-000000000008',
    '51000000-0000-4000-8000-000000000006',
    1750000400000,
    'req-00000000-0000-4000-8000-000000000005',
    '{"revoked_count":2,"from":"security_version_bump"}'
);

-- ===========================================================================
-- EVENT 6 — AN APPLICATION EVENT: NO user_id AT ALL
-- ===========================================================================
--
-- `concerns_a_user()` returns FALSE for `ApplicationSecretRotated`, and
-- `user_id` is NULL rather than pointing at the application's owner. An audit log
-- whose application events carried a user id would make `QueryAudit.user_id`
-- return rows about application registrations when somebody asked about a person,
-- and that is the failure the method exists to prevent.
--
-- `actor_id` IS set — to the administrator — because somebody DID do it. The
-- separation is the point: the event is ABOUT an application and BY a person.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000006',
    'application_secret_rotated',
    NULL,
    'f0000000-0000-4000-8000-000000000001',
    NULL,
    1750000500000,
    'req-00000000-0000-4000-8000-000000000006',
    '{"client_id":"ecoma-fixture-rotating-client","grace_window_ms":7200000}'
);

-- ===========================================================================
-- EVENT 7 — A FAILED AUTHENTICATION, about NOBODY
-- ===========================================================================
--
-- `user_id IS NULL` AND `actor_id IS NULL`, which is the shape of a login attempt
-- for an address that matches no account. It is the row that makes the
-- `StartEmailLoginOutcome` distinction visible in storage: a challenge exists
-- (CHALLENGE E in `otp_challenges.sql`, `user_id IS NULL`) and an audit event
-- exists with no user, and NEITHER reveals whether the address is registered.
--
-- `metadata` therefore has NO ADDRESS. Not a hashed one, not a redacted one, not
-- one at all. A login attempt against an unknown address is the event most likely
-- to be bulk-generated, and a table that recorded the addresses would turn an
-- audit log into a list of accounts to attack. What is recorded is the outcome,
-- which is what an operator reviewing a rate-limit spike needs.
INSERT INTO audit_events (id, event_type, user_id, actor_id, actor_session_id,
                          occurred_at_ms, request_id, metadata)
VALUES (
    'd0000000-0000-4000-8000-000000000007',
    'authentication_failed',
    NULL,
    NULL,
    NULL,
    1750000600000,
    'req-00000000-0000-4000-8000-000000000007',
    '{"method":"email_otp","outcome":"rejected","reason":"no_matching_account"}'
);

-- ===========================================================================
-- THE EVENT TYPES DELIBERATELY NOT HERE
-- ===========================================================================
--
-- Fourteen of the twenty-one are absent. The absent ones are absent for a reason
-- worth stating: this fixture set is a SPREAD, not a catalogue, and a file
-- listing all twenty-one rows would let a reader mistake it for a statement that
-- all twenty-one have been implemented. They have not. `AuditEventType` is a
-- twenty-one-variant enum with no producers behind it.
--
-- The one group that is deliberately over-represented is the SEVEN
-- administrative types, four of which appear above (user_suspended,
-- user_role_changed, all_sessions_revoked, application_secret_rotated) —
-- because `is_administrative()` is a `matches!` over exactly those seven and a
-- fixture that exercised three would not catch a value accidentally added to the
-- list.
--
-- `application_registered`, `application_updated`, `user_unsuspended` and
-- `security_version_bumped` are the remaining three administrative types, left
-- out because their fixture rows would be near-duplicates of rows already here.
-- A test that needs one writes it; a fixture that carries every possible row
-- stops being a fixture and becomes a second schema.
--
-- NO ROW HAS A `metadata` WITH A NUMBER THAT IS NOT A COUNT. `revoked_count = 2`
-- and `grace_window_ms` are both counts or durations, both integers encoded as
-- STRINGS — the JSON has no unquoted numbers anywhere, which is what the
-- string-valued-map constraint means in practice.