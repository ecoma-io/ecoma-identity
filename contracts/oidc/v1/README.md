# OIDC v1 contract

What this directory owns: the machine-readable statement of what the OAuth 2.0
and OpenID Connect surface accepts and returns, and — per operation — whether
that behaviour exists today.

**The single most important sentence in this file: no route in this directory
serves a protocol document yet.** `apps/identity/worker/src/lib.rs` dispatches,
and every one of the seven protocol paths below answers **501** with a
`not_implemented` envelope. The schemas are derived from the Rust types and they
are correct about _shape_; they are not a claim about _behaviour_, and a 501 on
each of these paths is the observable proof that nothing here works.

## The route table, and the honest status of each route

The routes are data, not `match` arms: `identity_oidc::route::Route` is the
single list the Identity Worker dispatches from, and this contract is checked
against it. `Route::is_implemented()` is the one honest answer to "is OIDC
implemented", and the smoke test and the `/ready` probe both read it — so the
answer is the same one everywhere and cannot drift.

| Path                                | `Route` variant | Status                              | Phase             | Success body                     |
| ----------------------------------- | --------------- | ----------------------------------- | ----------------- | -------------------------------- |
| `/.well-known/openid-configuration` | `Discovery`     | `DEFERRED` — answers 501            | 4 — OIDC provider | `discovery-document.schema.json` |
| `/.well-known/jwks.json`            | `Jwks`          | `DEFERRED` — answers 501            | 4 — OIDC provider | `jwk-set.schema.json`            |
| `/oauth/authorize`                  | `Authorize`     | `DEFERRED` — answers 501            | 4 — OIDC provider | 302 redirect; see below          |
| `/oauth/token`                      | `Token`         | `DEFERRED` — answers 501            | 4 — OIDC provider | `token-response.schema.json`     |
| `/oauth/userinfo`                   | `UserInfo`      | `DEFERRED` — answers 501            | 4 — OIDC provider | `userinfo-response.schema.json`  |
| `/oauth/revoke`                     | `Revoke`        | `DEFERRED` — answers 501            | 4 — OIDC provider | RFC 7009 empty 200               |
| `/oauth/logout`                     | `Logout`        | `DEFERRED` — answers 501            | 4 — OIDC provider | 302 to a post-logout target      |
| `/health`                           | `Health`        | `IMPLEMENTED` — 200                 | —                 | probe body, `ok: true`           |
| `/ready`                            | `Ready`         | `IMPLEMENTED` — 200, `ready: false` | —                 | probe body, `ok: true`           |

Two rows in that table need a reader who will not flinch.

**`/health` and `/ready` are served, and neither claims a capability.**
`Route::is_implemented()` returns `true` for exactly these two routes, and that
is deliberate: they are the two routes this bootstrap _intends_ to serve, they
are not protocol routes, and asserting they were unimplemented would be asserting
a lie. The Identity Worker answers both with a 200. `/ready`'s body reports
`ready: false` and `authentication: "not_implemented"`, and its `protocol_routes`
block counts **protocol routes only** — `declared: 7, implemented: 0` — because
counting all nine entries of `Route::ALL` would put `"implemented": 2` on a
readiness report for a provider that authenticates nobody.

**Every protocol route is `DEFERRED`, and each answers 501 with a
`not_implemented` envelope** — not 404. A 501 tells a client to stop; a 404
tells a scanner an endpoint is missing. Silently 404-ing a declared route would
make an incomplete bootstrap indistinguishable from a wrong discovery document.
The envelope is `contracts/shared/v1/not-implemented-envelope.schema.json`, and
`cargo test -p identity-worker` asserts the status, the code and the exact message
of all seven.

## Authentication

- **Client authentication** at the token endpoint: `client_secret_basic`,
  `client_secret_post` or `none`, as advertised by
  `token_endpoint_auth_methods_supported`. `private_key_jwt` is **not** offered.
  `ClientMetadata` carries a `jwks_uri` field, and that field is `null` for every
  client this provider accepts — the shape exists, the capability does not.
- **End-user authentication** does not exist. `/oauth/authorize` would render
  the sign-in UI and redeem a credential; neither exists. There is no first
  factor until Phase 2 (Email OTP, and the first real authentication).

## The `/oauth/authorize` response is a redirect, not a body

A successful authorization response is a **302** whose `Location` carries
`code`, `state` and `iss`. There is no route that emits
`authorization-response.schema.json` as a JSON body; that schema documents the
query-parameter set _inside_ the `Location`, and the Rust type is the one that
builds it. `AuthorizationResponse::location` chooses `?` or `&` depending on
whether the redirect URI already carries a query, and URL-encodes all three
components — a client-supplied `state` carrying `&` would otherwise come back
as a different set of parameters.

Note that `iss` here is **not** a serde rename. The Rust field is `issuer`, and
serde serialises `issuer`; the name `iss` is what the query string carries. The
ID token's own `iss` claim is a different type with a Rust field that is already
named `iss`.

## Two error shapes, and which one answers where

| Where                             | Shape                                             | Rust type                                      |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `/oauth/*` error responses        | RFC 6749 §5.2                                     | `identity_oidc::response::OAuthErrorResponse`  |
| Everything else                   | `code` / `message` / `request_id` / `client_safe` | `identity_cloudflare::error::ErrorEnvelope`    |
| A declared route in the bootstrap | `code: "not_implemented"`, **HTTP 501**           | `ErrorEnvelope`, hand-built at the route table |

These are deliberately different types. The OAuth endpoints must answer in the
shape a third-party OAuth client library can parse; the rest of the API answers
in the shape Ecoma's own clients can parse. One envelope for both would break
one of them.

A subtlety a client must handle: `ErrorEnvelope::status()` returns **500** for
the code `not_implemented`, because 501 is outside the closed `HttpStatus` set
and is answered by the route table rather than through the envelope. The status
on the wire for a declared route is 501. Do not expect the envelope's status
mapping to predict it.

## What these types can and cannot do

`identity-oidc` knows the **shape** of the protocol messages. It cannot sign
anything, verify anything, mint a token, or check an expiry — those are
`identity-security`'s, and the crate is not allowed to depend on it. There is no
function in `crates/identity-oidc/src/jwt.rs` that takes a secret or a key, by
construction. `IdTokenClaims::is_expired_at` is _only_ the expiry check: a
signature, issuer, audience and nonce check are the verifier's job, and a caller
that treats a `false` from it as "this token is good" has skipped four checks.

Discovery and JWKS are `DEFERRED` rather than implemented for a specific
reason: both have well-defined bodies, and this phase cannot produce them,
because **there is no signing key yet**.

## Phase 4 exit condition, as it bears on this contract

From `docs/roadmap/phases.md`, Phase 4 (OIDC provider): the authorization code
flow only, S256-only PKCE, `request_parameter_supported: false`, RS256 only,
public subject type — the constraints already encoded in `identity-oidc`,
tested rather than asserted. `Route::is_implemented()` flips to true per route,
and the discovery document, the `/ready` probe and `docs/README.md`'s status
table are updated **in the same commit**. A route that works while the table
says it does not is a lie in one of the two.

The `acr` and `amr` values in `id-token-claims.schema.json` are this provider's
own (`urn:ecoma:loa:1`, `urn:ecoma:loa:2`), not the ISO or OIDC AAL claim
values. A client matching the raw AAL string will not find one.

## Files

| File                                 | Rust type                         |
| ------------------------------------ | --------------------------------- |
| `authorization-request.schema.json`  | `request::AuthorizationRequest`   |
| `authorization-response.schema.json` | `response::AuthorizationResponse` |
| `token-request.schema.json`          | `request::TokenRequest`           |
| `token-response.schema.json`         | `response::TokenResponse`         |
| `oauth-error-response.schema.json`   | `response::OAuthErrorResponse`    |
| `userinfo-response.schema.json`      | `response::UserInfoResponse`      |
| `revocation-request.schema.json`     | `request::RevocationRequest`      |
| `discovery-document.schema.json`     | `discovery::DiscoveryDocument`    |
| `jwt-header.schema.json`             | `jwt::JwtHeader`                  |
| `id-token-claims.schema.json`        | `jwt::IdTokenClaims`              |
| `jwk-set.schema.json`                | `jwt::JwkSet`                     |
| `json-web-key.schema.json`           | `jwt::JsonWebKey`                 |

`identity_oidc::client::ClientMetadata` is registered client data, not a
protocol message this directory serves: it mirrors an application row for the
authorization endpoint's use, and it is not reachable over HTTP in the
bootstrap, so it has no schema here.

The shared envelopes live in `contracts/shared/v1/` rather than being duplicated
per surface, because one error envelope is the platform's and three copies of
it would be three answers to "what does an error look like".
