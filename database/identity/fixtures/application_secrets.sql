-- ===========================================================================
-- application_secrets.sql — the rotation history that `applications.sql` needs.
--
-- WHAT THIS FIXTURE EXISTS FOR
--
-- A ROTATION IS AN OVERLAP, NOT AN UPDATE, and one column cannot express an
-- overlap. For the grace window BOTH the old secret and the new one must verify,
-- and only after the window the old one must stop. The moment a single column is
-- overwritten the old hash is already gone, and a client that had not finished
-- rotating is broken with no way to tell whether it is broken or was revoked.
--
-- That is why 0008 has BOTH shapes, and this fixture is where the relationship
-- between them is made checkable:
--
--   applications.client_secret_hash  the fast path. One lookup, no join. The
--                                    token endpoint matches a presented secret
--                                    against this and stops.
--   application_secrets              the history. One row per secret ever issued
--                                    to this client, with the superseded ones
--                                    carrying an expiry.
--
-- `assert_fixture_invariants.sql` asserts the relationship that makes the
-- denormalisation safe: for the rotating client, the `is_current = 1` row's
-- `secret_hash` EQUALS `applications.client_secret_hash`, and the `is_current = 0`
-- row's does not. If those ever diverge, the token endpoint would be checking one
-- secret while the history says another, and no test in this repository would
-- notice.
--
-- THE ALGORITHM IS `DEFERRED`, so these are readable placeholders rather than
-- digests. See `applications.sql`'s header for the full statement of why, and
-- 0008's `secret_hash` column for what the missing hasher means for the security
-- of the column.
-- ===========================================================================

-- ===========================================================================
-- ONE CURRENT SECRET PER CONFIDENTIAL APPLICATION
-- ===========================================================================
--
-- Five rows for five confidential clients. The suspended and retired ones get
-- secrets too, because suspension is not revocation and retirement is not
-- deletion — see the reasoning on those applications' rows.
--
-- `is_current = 1` and `expires_at_ms = NULL`: the current secret never expires
-- on its own, so it is not inside a rotation window. A value of NULL here means
-- "still valid indefinitely", NOT "no expiry recorded because the column was
-- forgotten" — and the partial index below only helps the other case.

INSERT INTO application_secrets (id, application_id, secret_hash, is_current, expires_at_ms)
VALUES ('82000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
        'fixture-app1-oidc-client-secret-hash-0001', 1, NULL);

INSERT INTO application_secrets (id, application_id, secret_hash, is_current, expires_at_ms)
VALUES ('82000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002',
        'fixture-app2-oauth2-client-secret-hash-0001', 1, NULL);

INSERT INTO application_secrets (id, application_id, secret_hash, is_current, expires_at_ms)
VALUES ('82000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000004',
        'fixture-app4-suspended-client-secret-hash-01', 1, NULL);

INSERT INTO application_secrets (id, application_id, secret_hash, is_current, expires_at_ms)
VALUES ('82000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000005',
        'fixture-app5-retired-client-secret-hash-00001', 1, NULL);

-- ===========================================================================
-- THE ROTATING CLIENT — TWO SECRETS, ONE CURRENT AND ONE INSIDE ITS WINDOW
-- ===========================================================================
--
-- This is the row pair the whole table exists for.
--
-- SECRET R1 (the NEW one, `is_current = 1`): its `secret_hash` is CHARACTER FOR
-- CHARACTER `applications.client_secret_hash` for APP 6. They are written in the
-- same transaction by the rotation command, never in two places at two times, and
-- the equality is the property `assert_fixture_invariants.sql` checks. If the
-- token endpoint read this table directly it would have made a scheduling
-- dependency out of the denormalisation and would eventually read the wrong row
-- during a rotation; the column exists so it does not have to.
--
-- SECRET R0 (the OLD one, `is_current = 0`, `expires_at_ms = 1750007200000`):
-- still inside its grace window, and therefore STILL VERIFIES. `expires_at_ms` is
-- the SAME instant as `applications.secret_expires_at_ms` for APP 6, so the two
-- files cannot disagree about when the window closes — and that agreement is what
-- makes "the column says the window ends here and the history says the same"
-- checkable rather than assumed.
--
-- 1750007200000 is 2025-06-15T22:26:40Z, which is in the past relative to
-- `created_at_ms` on these rows (the default is "now"), and that is a problem
-- worth being honest about rather than papering over: a fixture whose rotation
-- window closed long ago does not demonstrate an OPEN window.
--
-- So the fixture states its own dependency: these two rows are only meaningful
-- while 1750007200000 is in the future, and the assertion in
-- `assert_fixture_invariants.sql` compares the two timestamps against each other
-- rather than against the clock, which is what makes it stable. A test that needs
-- an OPEN window should not use these rows; it should set `expires_at_ms`
-- relative to its own `now`, which is what
-- `tests/integration/schema.test.mjs` does for the two-current-secrets case.

INSERT INTO application_secrets (id, application_id, secret_hash, is_current, expires_at_ms)
VALUES ('82000000-0000-4000-8000-000000000006', '80000000-0000-4000-8000-000000000006',
        'fixture-app6-rotating-client-NEW-secret-hash', 1, NULL);

INSERT INTO application_secrets (id, application_id, secret_hash, is_current, expires_at_ms)
VALUES ('82000000-0000-4000-8000-000000000007', '80000000-0000-4000-8000-000000000006',
        'fixture-app6-rotating-client-OLD-secret-hash', 0, 1750007200000);

-- ===========================================================================
-- THE PUBLIC CLIENT HAS NO SECRET ROWS AT ALL
-- ===========================================================================
--
-- APP 3 is `client_secret_hash IS NULL` in `applications.sql`, and there is
-- deliberately no row for it here. A public client authenticates with the PKCE
-- challenge alone (`token_endpoint_auth_methods_supported` includes `none`), so
-- a secret row for it would be a row asserting something about a client that has
-- no secret.
--
-- This is worth stating as an invariant rather than as a gap, because the shape
-- of the schema INVITES the mistake: `application_secrets.application_id` is a
-- foreign key with no constraint tying it to a parent row that has a secret, so
-- a public client's secret table COULD be populated, and nothing here would
-- refuse it. `assert_fixture_invariants.sql` asserts that APP 3 has zero secret
-- rows, so the fixture set itself is checked rather than merely described.
--
-- A test that needs to prove the schema REFUSES such a row has a problem worth
-- naming: the schema does not refuse it, and pretending otherwise would be a test
-- that asserts a capability the platform does not have. What would refuse it is
-- the `RegisterApplication` command, which is `SCAFFOLDED`.