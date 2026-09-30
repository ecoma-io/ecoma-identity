# Admin v1 contract

What this directory owns: the operator console's data path — the surface
`apps/identity-admin` uses to administer accounts, registrations and the audit
trail.

**No route in this directory serves anything.** `apps/identity-admin/worker/src/lib.rs`
is a one-line placeholder. The schemas below are derived from the Rust types and
are correct about shape; they are not evidence that anything works.

## The Admin Worker holds no database

This is the architectural invariant the whole surface is built around, and it
is not negotiable: **the Admin Worker may not hold `IDENTITY_DB`.** Not in code,
not in `wrangler.jsonc`, not "just for this one report". It reaches identity
through the `IDENTITY` service binding and nothing else.

The consequence for this contract is that **every operation below is a typed
application-layer command evaluated inside the Identity Worker**, not a query
the console runs. The Admin Worker forwards; it does not decide. The
authorisation decision — is this operator allowed to do this — is
`identity_application`'s, and it is re-derived at the Identity Worker from the
session rather than read from the request body.

## Two sessions, and neither is authority over identity

The Admin Worker has its **own** session (who is looking at the console). It
also forwards the administrator's **identity** session, and that second one is
what carries the authority. The console's own session says who is looking; it
does not say what they may change in the identity database. That second answer
is the Identity Worker's to give, and it is why `AdminContext` carries
`actor_session_id` on every command: **the AAL2 check has nowhere to happen
without it**, and a destructive administrative action reachable from a session
the actor merely logged into is the whole risk.

Every command that changes someone else's security posture requires the actor's
session to be at **AAL2**. The refusal is one named function
(`forbidden_reason_missing_aal2`, reason `administrative action requires an AAL2
session`) rather than an inline string per call site, so the audit of
_authorization failures_ has a single reason to group by.

## The operations

Paths are the ones the operator client already calls
(`apps/identity-admin/web/src/api/admin.ts`). Two of them compose a path
fragment the client concatenates a user id onto, and the effective path is
recorded here because the composition is the client's, not a Rust constant's.

| Method | Effective path                                       | Command / query              | Status                                | Phase            |
| ------ | ---------------------------------------------------- | ---------------------------- | ------------------------------------- | ---------------- |
| `GET`  | `/health`                                            | —                            | `IMPLEMENTED` in the route table only | —                |
| `GET`  | `/ready`                                             | —                            | `IMPLEMENTED` in the route table only | —                |
| `GET`  | `/admin/session`                                     | — (no query exists)          | `DEFERRED`                            | 6                |
| `GET`  | `/admin/users`                                       | `SearchUsersQuery`           | `DEFERRED`                            | 6                |
| `GET`  | `/admin/users/detail/{user_id}`                      | — (no query exists)          | `DEFERRED`                            | 6                |
| `POST` | `/admin/users/suspend/{user_id}`                     | `SuspendUserCommand`         | `DEFERRED`                            | 6                |
| `POST` | `/admin/users/suspend/{user_id}/unsuspend`           | `UnsuspendUserCommand`       | `DEFERRED`                            | 6                |
| `POST` | `/admin/users/role/{user_id}`                        | `ChangeUserRoleCommand`      | `DEFERRED`                            | 6                |
| `POST` | `/admin/sessions/revoke/{user_id}`                   | `RevokeUserSessionsCommand`  | `DEFERRED`                            | 6                |
| `GET`  | `/admin/audit`                                       | `QueryAuditQuery`            | `DEFERRED`                            | 6                |
| `GET`  | `/admin/applications`                                | — (no query exists)          | `DEFERRED`                            | 4, rendered in 5 |
| `POST` | `/admin/applications/{application_id}/rotate-secret` | `RotateClientCommand`        | `DEFERRED`                            | 4                |
| —      | —                                                    | `RegisterApplicationCommand` | `DEFERRED` — **no route calls it**    | 4                |
| —      | —                                                    | `UpdateApplicationCommand`   | `DEFERRED` — **no route calls it**    | 5                |

Three honest absences, stated rather than smoothed over:

- `GET /admin/users/detail/{user_id}` and `GET /admin/session` are paths the
  client calls and types, with **no Rust command or query behind them**. There is
  no `GetUserQuery` and no operator-session type in `identity-application`.
- `RegisterApplicationCommand` and `UpdateApplicationCommand` have no client
  method and no route at all. The commands exist as types with no body; the
  console has no screen wired to them yet.
- `/health` and `/ready` carry the same caveat as in the other two contracts:
  `Route::is_implemented()` returns `true` for them because they are the two
  routes this bootstrap intends to serve and are not protocol routes, but the
  Worker that would serve them is a placeholder.

Note that `/admin/*` paths are **not** in `identity_oidc::route::Route`. That
table is the OIDC surface. The administrative paths exist only as strings in
the console's client, and a Rust route table for them has to be written and
reconciled with those strings in one commit.

## The client secret is shown exactly once

A confidential client's secret is returned by **exactly two** operations — the
registration and the rotation — and is never retrievable afterwards. It is never
persisted in cleartext. `ApplicationView`, which is what every later read
returns, has no `client_secret` field at all.

The type system enforces the leak side, not just convention:
`RegisterApplicationOutcome` carries `#[derive(Clone, PartialEq, Eq, Serialize)]`
and **no `Debug`**, and its hand-written `Debug` prints `"<redacted>"` for the
secret. `ClientSecret` is a newtype with **no `Debug` impl at all**, so
`{:?}` on one is a compile error. Deleting that `Debug` breaks every call site
that formats the outcome, including the ones nobody remembers adding.

## The one implemented rule

`RoleChangeRequest::evaluate` is a **real function**, not a trait signature — the
only implemented rule in `identity-application`. It encodes "the last
administrator cannot be removed or demoted" and lives there rather than in
`identity-domain` because the rule needs a _count of administrators_: a fact
about the current state of the store, not a property of a single user.

It is a pure function, which is what makes it testable without a database, and
which is why the count is a field: **the count must be computed inside the same
transaction that applies the change.** Two simultaneous demotions must not both
see two administrators. Phase 6's exit condition requires the test to actually
race them.

The evaluation order is load-bearing and is recorded in
`role-change.schema.json`: self-change is reported before the last-administrator
rule, so a lone administrator demoting themselves gets the honest reason rather
than the misleading one.

**The console does not pre-empt any of this client-side.** A client-side "you
cannot demote the last administrator" check is a check the client can be wrong
about, and a disabled control is a control that explains nothing. The console
shows the server's refusal when it arrives.

## Status codes

Errors are the platform envelope (`contracts/shared/v1/error-envelope.schema.json`).

| Status | When                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| 501    | Every declared-but-unimplemented route, `code: "not_implemented"`              |
| 400    | `invalid_request` and the other 400-mapped codes                               |
| 401    | `unauthorized` — the operator's identity session is absent, expired or revoked |
| 403    | `forbidden` (not an administrator, or not at AAL2), `insufficient_assurance`   |
| 404    | `not_found` — including a session that is not the caller's                     |
| 409    | `illegal_transition` — for example reinstating an already-active user          |
| 500    | `internal_error`, and any code not in the table                                |
| 503    | `temporarily_unavailable`                                                      |

`ErrorEnvelope::status()` maps `not_implemented` to **500**, but a declared route
answers **501** from the route table, so the envelope's mapping does not predict
the wire status. See `contracts/shared/v1/not-implemented-envelope.schema.json`.

## Every administrative action is audited, including the refusals

Phase 6's exit condition requires it, and the reason is specific: **a trail that
records only successes records which accounts were successfully attacked**, which
is not the same question. A refused role change, a refused suspension and an
unauthorised lookup all leave a row.

`WriteAuditEvent` participates in the transaction the calling use case is
already inside. An implementation that opens and commits its own transaction has
silently converted an atomic write into a best-effort one — and a state change
that succeeded but could not be audited is worse than one that did not happen,
because the system now holds a change nobody can explain.

## What an empty list must not mean

Two screens have a rule written into the client, and it belongs in the contract
because it is a statement about what a response _is not claiming_:

- An empty user table means "this platform has no users", which a console
  showing it is asserting. A `DEFERRED` query must render its deferred state
  instead.
- An empty audit log means "nothing has ever been recorded", which is a specific
  and alarming claim. During the bootstrap phase events **are** being recorded
  server-side while only the _query_ is deferred — so saying "no events" would be
  the worst thing an operator investigating an incident could be told.

## Phase 6's exit condition, as it bears on this contract

The Admin Worker still holds no D1 binding, and
`tooling/scripts/check-architecture.mjs` still fails on a tree where it does. The
last-administrator rule holds under concurrency. Every administrative action
writes an audit event, including the refusals.

## Files

| File                                       | Rust type                                      |
| ------------------------------------------ | ---------------------------------------------- |
| `admin-user-row.schema.json`               | `administration::AdminUserRow`                 |
| `search-users.schema.json`                 | `administration::SearchUsers`                  |
| `admin-audit-row.schema.json`              | `administration::AdminAuditRow`                |
| `query-audit.schema.json`                  | `administration::QueryAudit`                   |
| `admin-context.schema.json`                | `administration::AdminContext`                 |
| `role-change.schema.json`                  | `administration::RoleChange` — **implemented** |
| `change-user-role-request.schema.json`     | `administration::ChangeUserRole`               |
| `suspend-user-request.schema.json`         | `administration::SuspendUser`                  |
| `unsuspend-user-request.schema.json`       | `administration::UnsuspendUser`                |
| `revoke-user-sessions-request.schema.json` | `administration::RevokeUserSessions`           |
| `application-view.schema.json`             | `applications::ApplicationView`                |
| `register-application-request.schema.json` | `applications::RegisterApplication`            |
| `update-application-request.schema.json`   | `applications::UpdateApplication`              |
| `rotate-client-secret-request.schema.json` | `applications::RotateClientSecret`             |
