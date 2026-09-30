-- ===========================================================================
-- application_grants.sql + consents.sql — the two-question pair.
--
-- WHY THESE ARE IN ONE FILE
--
-- They answer different questions and that is the whole reason they are two
-- tables rather than one:
--
--   application_grants  CURRENT standing. One row per (user, application),
--                       updated in place when scopes widen. It answers "may I
--                       skip the consent screen for this client TODAY?" and it
--                       is read on every authorisation request.
--
--   consents            HISTORY. Append-only. One row per consent interaction,
--                       never updated. It answers "what did this person agree to,
--                       when, and after being shown what?" and it is read by
--                       nobody on a hot path.
--
-- Merging them would make the first question an append and the second an
-- update, and an audit trail that is updated in place is not an audit trail.
--
-- Both are `DEFERRED` in the sense that matters: no repository writes them, no
-- command creates them, and `GrantApplicationAccess` is a `SCAFFOLDED` trait
-- with no body. These rows exist so that a test of the UNIQUE rules and of the
-- granted/requested distinction can run, and so a reader can see what the two
-- shapes look like when they hold real data.
-- ===========================================================================

-- ===========================================================================
-- GRANT 1 — USER 2 granted APP 1 everything it registered for
-- ===========================================================================
--
-- `scopes = ["openid","profile","email"]` is EXACTLY `applications.allowed_
-- scopes` for APP 1. That equality is what `granted_scopes` produces when the
-- client asks for everything it registered for, and it is why the intersection
-- rule is stated as a narrowing rather than a failure.
--
-- The intersection itself is `Application::granted_scopes`' job, in Rust, and the
-- stored value is its RESULT. Storing the result rather than the request is the
-- decision the column comment makes and it is worth restating here: if this were
-- recomputed from `allowed_scopes` on every read, narrowing a client's
-- registration would retroactively shrink what a user consented to without them
-- ever being asked.
INSERT INTO application_grants (id, user_id, application_id, scopes)
VALUES ('90000000-0000-4000-8000-000000000001',
        'f0000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000001',
        '["openid","profile","email"]');

-- ===========================================================================
-- GRANT 2 — USER 2 granted APP 2 a SUBSET of what it registered for
-- ===========================================================================
--
-- APP 2 registered ["profile","email"] and this grant records exactly that, so
-- it is a full grant. The interesting version of a subset grant is GRANT 3.
INSERT INTO application_grants (id, user_id, application_id, scopes)
VALUES ('90000000-0000-4000-8000-000000000002',
        'f0000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000002',
        '["profile","email"]');

-- ===========================================================================
-- GRANT 3 — THE SUBSET GRANT, and the reason `consents` stores both lists
-- ===========================================================================
--
-- USER 2 granted APP 6 (the rotating client) ONLY `profile`. What was REQUESTED
-- was `["profile","email"]` and what APP 6 registered is also `["profile",
-- "email"]`, so the intersection would have been both — and the user agreed to
-- one.
--
-- THAT IS THE ROW that makes the two-column design in `consents` necessary.
-- `Application::granted_scopes` returns the intersection of requested and
-- registered and nobody narrowed it further. A consent screen that lets a person
-- deselect a scope is ordinary, and if only the granted list were stored then a
-- later question — "what was this person shown?" — would be unanswerable, and so
-- would "did they agree to email and we started sending it anyway?".
--
-- It also gives `assert_fixture_invariants.sql` something mechanical to check:
-- GRANT 3's `scopes` is a strict subset of APP 6's `allowed_scopes`, and
-- CONSENT 2's `granted_scopes` equals GRANT 3's `scopes` while its
-- `requested_scopes` does not. Three files, one relation, checked by a query.
INSERT INTO application_grants (id, user_id, application_id, scopes)
VALUES ('90000000-0000-4000-8000-000000000003',
        'f0000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000006',
        '["profile"]');

-- ===========================================================================
-- GRANT 4 — THE SUPPORT AGENT'S GRANT TO THE OIDC CLIENT
-- ===========================================================================
--
-- A different USER on the same APPLICATION as GRANT 1, so
-- ux_application_grants_user_application is exercised from both directions: two
-- users on one application, and one user on two applications. A unique index
-- tested only in one of those directions is an index nobody has looked at from
-- the other side.
--
-- `profile` only, while APP 1 registered all three scopes, so this is a second
-- subset grant — the same shape as GRANT 3 from a different pair of files.
INSERT INTO application_grants (id, user_id, application_id, scopes)
VALUES ('90000000-0000-4000-8000-000000000004',
        'f0000000-0000-4000-8000-000000000006',
        '80000000-0000-4000-8000-000000000001',
        '["profile"]');

-- ===========================================================================
-- THE ACCOUNTS DELIBERATELY LEFT WITH NO GRANT
-- ===========================================================================
--
-- USER 1 (the administrator), USER 3 (suspended), USER 4 (deactivated),
-- USER 5 (pending verification), USER 7 (service) and USER 8 (bumped) have none.
--
-- USER 5's absence is the one that matters. An account in
-- `pending_verification` has never proven an inbox, so it has never completed an
-- authorisation request, so it has no grant — and a grant on such an account
-- would be a standing third-party authorisation for an account that cannot sign
-- in to exercise it. `Allow` and `granted_scopes` would be meaningless without a
-- principal to bind them to.
--
-- USER 7 (service) has none because a machine identity does not complete a
-- consent screen. It is granted scopes by the platform, which is a different
-- mechanism that does not exist yet, and pretending it is a consent would be
-- inventing a consent flow nobody performs.
--
-- USER 1's absence is the fourth expression of the last-administrator caution:
-- an administrator with no third-party grants has fewer paths to be impersonated
-- by, and a test about revoking an operator's access to a client must start from
-- a row that exists, not from one that had to be created first.
-- ===========================================================================

-- ===========================================================================
-- CONSENTS — the history, and the two rows that show the two question shapes
-- ===========================================================================

-- CONSENT 1 — USER 2's FIRST INTERACTION WITH APP 1: the user approved.
--
-- requested_scopes == granted_scopes == ["openid","profile","email"], which is
-- the shape of a consent screen where the user approved everything they were
-- asked about. This is the ONLY consent in the fixture set with both lists
-- equal.
--
-- consent_mode = 1: "the user was shown the scope list and approved".
INSERT INTO consents (id, user_id, application_id,
                      requested_scopes, granted_scopes, consent_mode,
                      actor_session_id)
VALUES ('a0000000-0000-4000-8000-000000000001',
        'f0000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000001',
        '["openid","profile","email"]',
        '["openid","profile","email"]',
        1,
        '51000000-0000-4000-8000-000000000001');

-- CONSENT 2 — THE INTERACTION BEHIND GRANT 3, where the lists DIFFER.
--
-- requested = ["profile","email"], granted = ["profile"]. The user deselected
-- `email`.
--
-- `actor_session_id` is SESSION A from `sessions.sql` — USER 2's first session.
-- That is the attribution the column exists for, and it is a session id with NO
-- FOREIGN KEY, deliberately: "a consent is evidence. A session is disposable and
-- gets revoked and deleted. A foreign key here would let a session purge erase a
-- user's consent record."
INSERT INTO consents (id, user_id, application_id,
                      requested_scopes, granted_scopes, consent_mode,
                      actor_session_id)
VALUES ('a0000000-0000-4000-8000-000000000002',
        'f0000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000006',
        '["profile","email"]',
        '["profile"]',
        1,
        '51000000-0000-4000-8000-000000000001');

-- CONSENT 3 — A SECOND INTERACTION WITH AN EXISTING GRANT: nothing was asked.
--
-- consent_mode = 0: "the existing application_grants row was reused; the user
-- saw nothing, because they were not asked."
--
-- THIS ROW IS WHY `consent_mode` EXISTS. With consent_mode = 0 and the SAME
-- granted_scopes as GRANT 1, the two consents for (USER 2, APP 1) together say
-- "this person consented to these scopes, once by approving and once by not being
-- asked" — and an audit of that account can distinguish the two. Without the
-- column, a second authorisation request would either append an identical row
-- (indistinguishable from the first) or not append anything (indistinguishable
-- from no consent at all).
--
-- `actor_session_id` is SESSION B, USER 2's AAL2 stepped-up session. The point
-- of the choice is that the two consents are attributed to DIFFERENT sessions of
-- the same person, so an investigator can see both moments.
INSERT INTO consents (id, user_id, application_id,
                      requested_scopes, granted_scopes, consent_mode,
                      actor_session_id)
VALUES ('a0000000-0000-4000-8000-000000000003',
        'f0000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000001',
        '["openid","profile","email"]',
        '["openid","profile","email"]',
        0,
        '51000000-0000-4000-8000-000000000002');

-- CONSENT 4 — THE SUPPORT AGENT'S CONSENT TO APP 1, with NO SESSION.
--
-- `actor_session_id IS NULL`, and this is the case the column's nullability
-- exists for: a SYSTEM-INITIATED action has no session — "a dispatcher-driven
-- revocation, a scheduled sweep, a migration".
--
-- For a consent specifically, it means an action taken on the user's behalf by
-- something that is not a browser: a provisioning script, a migration, an
-- administrator acting through the service binding. The consent is real and
-- dated; there is simply no session to attribute it to, and pretending otherwise
-- would mean pointing at a session that never existed.
INSERT INTO consents (id, user_id, application_id,
                      requested_scopes, granted_scopes, consent_mode,
                      actor_session_id)
VALUES ('a0000000-0000-4000-8000-000000000004',
        'f0000000-0000-4000-8000-000000000006',
        '80000000-0000-4000-8000-000000000001',
        '["openid","profile","email"]',
        '["profile"]',
        1,
        NULL);

-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ===========================================================================
--
-- No consent for APP 3 (the public client), and no grant either. A SPA client is
-- a client whose users are typing a password-equivalent into a browser, and the
-- fixture set has no flow for that; a grant for a client with no secrets would
-- imply a registration path nobody performs.
--
-- No consent for APP 4 (suspended) or APP 5 (retired). A suspended application
-- cannot complete an authorisation request, and a retired one never will again.
-- Consent rows for either would be rows describing a moment that cannot recur —
-- and for APP 5 it would be actively wrong, because a retired client_id must
-- never come back to life with somebody else's consent attached.
--
-- `request_id` IS NOT USED because this schema has no inbound request to tie a
-- consent to: the column lives on `audit_events`, not on `consents`, and its
-- absence here is the correct shape rather than an oversight.