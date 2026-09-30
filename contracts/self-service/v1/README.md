# Self-service v1 contract

What this directory owns: the surface a signed-in end user acts on their **own**
account through — the Identity Worker's BFF for `apps/identity/web`.

**No route in this directory serves anything.** `apps/identity/worker/src/lib.rs`
is a one-line placeholder. The schemas below are derived from the Rust types and
are correct about shape; they are not evidence that anything works.

## The self-service boundary is mechanical, not a convention

Every command in `identity_application::accounts` and
`identity_application::sessions` **carries no actor**. There is no `actor_id`,
no `actor_session_id`, and no `user_id` on any of them. That absence is the
boundary: an operation that changes _someone else's_ account is
`identity_application::administration`, and the types there all name an actor
explicitly.

It is enforced two ways over. Structurally, there is nowhere on
`UpdateProfile`, `ChangeEmail`, `LinkIdentity`, `UnlinkIdentity` or
`RevokeAllSessions` to put "as whom", so a field cannot be added without the
type changing. And a test asserts the serialised bodies contain none of
`actor_id`, `actor`, `as_user`, `admin`.

`RevokeAllSessions` is stronger still: it is a **unit struct**, so
`RevokeAllSessions { user_id }` does not compile and `RevokeAllSessions {}`
does not either. A body that names a user is _refused_ by the deserialiser, not
ignored — ignoring it and revoking the caller's own sessions would be a silent,
successful, wrong action.

## Authentication

Session cookie only. `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, named
`__Host-ecoma_session` (`identity_cloudflare::request::SESSION_COOKIE_NAME`).
Every authenticated call is `credentials: "include"`.

**No token ever reaches `localStorage` or readable JavaScript**, and no schema
in this directory returns one. `SameSite=Lax` is the browser's baseline; the
real CSRF check is the server's, through a gate this contract does not describe
because the gate has no body yet.

A request body is bounded at 64 KiB (`MAX_JSON_BODY_BYTES`); above that the
transport refuses with `payload_too_large`, which is not a row in the status
table and therefore falls through to 500.

## The operations

Paths and methods are the ones the end-user client already calls
(`apps/identity/web/src/api/self-service.ts`), which is the only place in the
repository where these route names exist as strings — the self-service routes
are **not** in `identity_oidc::route::Route`, which is the OIDC table. When the
Worker implements them, these strings and a Rust route table must be reconciled
in one commit.

| Method   | Path                                             | Command / query            | Status                                | Phase            |
| -------- | ------------------------------------------------ | -------------------------- | ------------------------------------- | ---------------- |
| `GET`    | `/health`                                        | —                          | `IMPLEMENTED` in the route table only | —                |
| `GET`    | `/ready`                                         | —                          | `IMPLEMENTED` in the route table only | —                |
| `GET`    | `/self-service/account`                          | `GetAccountQuery`          | `DEFERRED`                            | 5                |
| `PUT`    | `/self-service/account/profile`                  | `UpdateProfileCommand`     | `DEFERRED`                            | 5                |
| `POST`   | `/self-service/account/email`                    | `ChangeEmailCommand`       | `DEFERRED`                            | 5                |
| `POST`   | `/self-service/account/identities`               | `LinkIdentityCommand`      | `DEFERRED`                            | 5                |
| `DELETE` | `/self-service/account/identities/{identity_id}` | `UnlinkIdentityCommand`    | `DEFERRED`                            | 5                |
| `GET`    | `/self-service/sessions`                         | `ListSessionsQuery`        | `DEFERRED`                            | 1, rendered in 5 |
| `POST`   | `/self-service/sessions/{session_id}/revoke`     | `RevokeSessionCommand`     | `DEFERRED`                            | 1, rendered in 5 |
| `POST`   | `/self-service/sessions/revoke-all`              | `RevokeAllSessionsCommand` | `DEFERRED`                            | 1, rendered in 5 |
| `GET`    | `/self-service/factors`                          | — (no query exists)        | `DEFERRED`                            | 3, rendered in 5 |
| `POST`   | `/self-service/factors/totp`                     | — (no command exists)      | `DEFERRED`                            | 3                |
| `DELETE` | `/self-service/factors/{authenticator_id}`       | — (no command exists)      | `DEFERRED`                            | 3                |
| `GET`    | `/self-service/applications`                     | — (no query exists)        | `DEFERRED`                            | 5                |
| `DELETE` | `/self-service/applications/{client_id}/grant`   | — (no command exists)      | `DEFERRED`                            | 5                |
| `POST`   | `/oauth/logout`                                  | `LogoutCommand`            | `DEFERRED`                            | 4                |

`/health` and `/ready` carry the same caveat as in the OIDC contract:
`Route::is_implemented()` returns `true` for them because they are the two
routes this bootstrap intends to serve and are not protocol routes, but the
Worker that would serve them is a placeholder, so the status column says "in the
route table only" rather than `IMPLEMENTED`.

**Sign-out lives on the OIDC route table.** `signOut()` in the end-user client
calls `POST /oauth/logout`, which is `Route::Logout` — not a `/self-service/*`
path. It is listed here because it is the operation an end user reaches, and
the OIDC contract owns its body.

**Rows with "no query exists" / "no command exists" are honest absences**, not
oversights. `identity_application` declares nothing for listing or removing
factors, or for listing or withdrawing grants. `GET /self-service/factors` and
`GET /self-service/applications` are paths the client calls and shapes the
client types, with no Rust command behind them. The response schemas here are
projections declared by the client, and each says so.

## Status codes

Errors are the platform envelope (`contracts/shared/v1/error-envelope.schema.json`)
— **not** the OAuth shape. Only the OAuth endpoints use the RFC 6749 §5.2
envelope, because only they are parsed by a third-party OAuth library.

| Status | When                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 501    | Every declared-but-unimplemented route, with `code: "not_implemented"`                                                                                                           |
| 400    | `invalid_request`, `verification_failed`, `expired`, `already_redeemed`, `challenge_mismatch`, `malformed_token`, `invalid_token`                                                |
| 401    | `unauthorized` — the real signed-out state. Absent, expired or revoked cookie; all three mean the same thing to a client.                                                        |
| 403    | `forbidden`, `insufficient_assurance`                                                                                                                                            |
| 404    | `not_found` — including a session that is not the caller's. "Not found" rather than "forbidden", because confirming that someone else's session _exists_ is itself a disclosure. |
| 409    | `illegal_transition`                                                                                                                                                             |
| 500    | `internal_error`, and any code not in the table                                                                                                                                  |
| 503    | `temporarily_unavailable` — the rate limiter failing closed                                                                                                                      |

Two notes a client must not get wrong. `ErrorEnvelope::status()` maps
`not_implemented` to **500**, but a declared route answers **501** from the route
table, so the envelope's mapping does not predict the wire status. And the
rate limiter fails **closed** with `temporarily_unavailable` (503), never with a
429: a 429 would tell the caller they did something wrong when in fact a
dependency is unavailable.

## Why some refusals are indistinguishable on purpose

`StartEmailLoginOutcome` is not in this directory — it is the sign-in surface,
and it has no route — but its shape is the reason one rule here reads oddly.
Its two arms are `code_sent` and `accepted`, and **both carry
`retry_after_seconds`**. A caller that got `accepted` with no retry hint would
let a user hammer the endpoint, and one that got `code_sent` with no hint would
do the same on a real address. The backoff is on the enum rather than on one
variant for exactly that reason, and the two branches are
timing-indistinguishable as well as content-indistinguishable, so neither
response is an account-enumeration oracle.

`ChangeEmailOutcome` follows the same discipline in a smaller way: a
`retry_after_seconds` in seconds, never a duration, because a duration is
ambiguous across the clock the server and the clock the browser think it is.

## Phase 5's exit condition, as it bears on this contract

The self-service web app drives every screen against a live Worker, and **the
deferred-state UI this phase replaces is deleted in the same commit**, not left
behind behind a capability flag. A screen that keeps rendering "coming soon"
next to a working screen is a screen that will keep saying it after the feature
lands.

## Files

| File                                  | Rust type                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `account-view.schema.json`            | `accounts::AccountView`, `AccountEmail`, `AccountIdentity`                 |
| `session-view.schema.json`            | `sessions::SessionView`                                                    |
| `update-profile-request.schema.json`  | `accounts::UpdateProfile`                                                  |
| `change-email-request.schema.json`    | `accounts::ChangeEmail`                                                    |
| `change-email-outcome.schema.json`    | `accounts::ChangeEmailOutcome`                                             |
| `link-identity-request.schema.json`   | `accounts::LinkIdentity`                                                   |
| `unlink-identity-request.schema.json` | `accounts::UnlinkIdentity`                                                 |
| `enrolled-authenticator.schema.json`  | projection of `authenticator::Authenticator` — no Rust type of this shape  |
| `connected-application.schema.json`   | projection of `applications::ApplicationView` — no Rust type of this shape |
| `totp-enrolment.schema.json`          | **none** — declared by the web client only, and marked as such             |
