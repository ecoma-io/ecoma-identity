# Worker architecture

What this document is: the three Workers, the bindings each one holds, the
routes each one serves, and the specific things each one may never do.

What this document is **not**: a handler-by-handler description. None of the
handlers exist yet.

## Status

| Fact                                                                  | State                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Three deployables named `identity`, `identity-admin`, `identity-jobs` | `PLANNED` — decided; the configuration that proves it is `DEFERRED`                            |
| The binding set of each Worker                                        | `PLANNED` — decided; the `wrangler.jsonc` files are `DEFERRED`                                 |
| The OIDC route table and its 501 contract                             | `IMPLEMENTED` — `identity-oidc`'s `Route` enum is real and tested                              |
| The health routes `/health` and `/ready`                              | `IMPLEMENTED` on `identity` and `identity-admin`; `DEFERRED` on `identity-jobs`                |
| The `identity` Worker `lib.rs`                                        | `IMPLEMENTED` — the `fetch` entrypoint, the route dispatch, the two probes and the 501 surface |
| The `identity-admin` and `identity-jobs` Worker `lib.rs`              | `DEFERRED` — one-line placeholders                                                             |

The route table below is `IMPLEMENTED` as **data**, and the thing that dispatches
on it is `IMPLEMENTED` on `identity` and `DEFERRED` on the other two.

## The three deployables

Constraint 7 of the founding list: **exactly three deployables**. A fourth
Worker requires an ADR and proof it cannot live in one of the three.

| Deployable       | Crate                        | Role                                                                                                                              | Public?                                              |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `identity`       | `apps/identity/worker`       | The single source of truth for identity state. OIDC, authentication, sessions, self-service, and the sole owner of `IDENTITY_DB`. | Yes — the OIDC and self-service routes               |
| `identity-admin` | `apps/identity-admin/worker` | The administrative BFF and its own session. Reaches identity only through a private service binding.                              | Yes, but only to its own session and its own web app |
| `identity-jobs`  | `apps/identity-jobs/worker`  | A background side-effect worker: email, security notifications, audit archival. Owns no identity state.                           | No — no public route at all                          |

The moon project aliases match the deployable names, not the language: in
`moon.yml`, `identity`, `identity-admin` and `identity-jobs` alias
`identity-worker`, `identity-admin-worker` and `identity-jobs-worker`. A
deployable is called `identity` everywhere that matters — wrangler worker name,
release-please component, git tag, Cloudflare version tag — so that a tag, a
version and a wrangler name can be compared by eye.

## The binding table

This is the table to read when deciding whether a Worker may do something. If
the capability is not in a Worker's row, the Worker does not have it.

| Binding                      | `identity`            | `identity-admin`      | `identity-jobs`   | What it is                                             |
| ---------------------------- | --------------------- | --------------------- | ----------------- | ------------------------------------------------------ |
| `IDENTITY_DB`                | **D1**                | **none, ever**        | **none**          | The authoritative identity store                       |
| `IDENTITY_KV`                | KV                    | —                     | —                 | Rate-limit and counter state only; never authoritative |
| `IDENTITY_QUEUE`             | producer              | —                     | consumer          | The outbox transport                                   |
| `EMAIL_PROVIDER`             | fetch, `DEFERRED`     | —                     | fetch, `DEFERRED` | Third-party email; a `fetch` binding, not a library    |
| `RATE_LIMITER`               | Workers rate limiting | —                     | —                 | Fail-closed limiter for auth endpoints                 |
| `ADMIN_RATE_LIMITER`         | —                     | Workers rate limiting | —                 | Fail-closed limiter for admin endpoints                |
| `JOBS_KV`                    | —                     | —                     | KV                | Scratch and idempotency state; never authoritative     |
| `IDENTITY` (service binding) | —                     | **yes**               | **yes**           | Private, intra-account call to the Identity Worker     |
| `ASSETS`                     | identity web UI       | admin web UI          | —                 | Static assets, each Worker its own                     |

The two cells reading **none, ever** are not an oversight and not a policy. See
[admin-isolation.md](admin-isolation.md) and [jobs-isolation.md](jobs-isolation.md).

Note also what the Jobs Worker has **no** `RATE_LIMITER`. It is a queue
consumer, not an endpoint that a browser can reach, so it is not a rate-limit
target; its protection is the queue's own at-least-once delivery and the
consumer's idempotency check, neither of which is implemented.

## The routes the Identity Worker serves

Declared in `crates/identity-oidc/src/route.rs` as `Route`, one list shared by
the Worker (which dispatches on it) and the contract fixtures in
`contracts/oidc/v1/`. Declaring routes as data rather than as `match` arms in a
handler is what makes it impossible for a route to exist in the dispatcher and
be missing from the discovery document.

| Route       | Path                                | Access mode                  | State                                                                                                                           |
| ----------- | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Discovery` | `/.well-known/openid-configuration` | public                       | `DEFERRED` — 501 on a real binary. The document is built by `DiscoveryDocument::bootstrap` as data, but there is no signing key |
| `Jwks`      | `/.well-known/jwks.json`            | public                       | `DEFERRED` — 501 on a real binary. The JWK set is a type; there is no key material                                              |
| `Authorize` | `/oauth/authorize`                  | browser, session             | `DEFERRED` — 501                                                                                                                |
| `Token`     | `/oauth/token`                      | public, client-authenticated | `DEFERRED` — 501                                                                                                                |
| `UserInfo`  | `/oauth/userinfo`                   | bearer token                 | `DEFERRED` — 501                                                                                                                |
| `Revoke`    | `/oauth/revoke`                     | client-authenticated         | `DEFERRED` — 501                                                                                                                |
| `Logout`    | `/oauth/logout`                     | session                      | `DEFERRED` — 501                                                                                                                |
| `Health`    | `/health`                           | public                       | `IMPLEMENTED` — 200 with a liveness body. It claims liveness and nothing else                                                   |
| `Ready`     | `/ready`                            | public                       | `IMPLEMENTED` — 200, and the body reports `ready: false` and `authentication: "not_implemented"`                                |

`Route::is_implemented()` returns `false` for every protocol route and `true` for
exactly `Health` and `Ready`. Four things read that one function, so the answer
cannot drift:

- the dispatcher in `apps/identity/worker/src/lib.rs`,
- the `/ready` probe's own count of the protocol routes,
- the smoke test that runs after a version upload,
- a test in `identity-oidc` that fails if anyone marks a protocol route
  implemented without updating the discovery document and the probe together.

**The distinction between the two health routes and the protocol routes is
load-bearing, and the readiness report draws it.** `is_implemented()` says `true`
for `/health` and `/ready` because they are live _in the protocol surface_: they
are the two routes this bootstrap does intend to serve, they are not protocol
routes, and asserting they were unimplemented would be asserting a lie. The
`protocol_routes` block in the `/ready` body counts **protocol routes only** and
reports `implemented: 0`, because counting all nine entries of `Route::ALL`
would put `"implemented": 2` on a readiness report for a provider that
authenticates nobody. A test asserts that exclusion.

The two `Health` and `Ready` answers are 200 while `ready` is `false`, and that
is deliberate rather than contradictory: the deploy ladder's smoke step and
health gate require a 2xx from both probes, and the 200 means **the Worker is up
and answered**. "This instance may authenticate someone" is the separate `ready`
field, and it is `false`.

**What is still `DEFERRED`:** the `identity-admin` and `identity-jobs`
composition roots. Their `lib.rs` files are one-line placeholders, so those two
deployables serve nothing.

### The 501 contract

A declared-but-unimplemented route answers **501**, not 404. A client that sees
501 knows to stop, and a scanner that sees 404 records a missing endpoint.
Silently 404-ing a declared route would make an incomplete bootstrap
indistinguishable from a wrong discovery document.

The envelope is `ApplicationError::NotImplemented`, whose `code()` is
`not_implemented`. Nothing is inferred from this that is not true: the response
does not claim an authentication flow exists.

**`identity` implements this contract today, and here is the exact routing
table it dispatches on** (`plan()` in `apps/identity/worker/src/lib.rs`, resolved
through `identity_oidc::route::find_by_path`):

| Path                                | Status | Body                                                            |
| ----------------------------------- | ------ | --------------------------------------------------------------- |
| `/.well-known/openid-configuration` | 501    | `not_implemented` envelope naming the path                      |
| `/.well-known/jwks.json`            | 501    | `not_implemented` envelope naming the path                      |
| `/oauth/authorize`                  | 501    | `not_implemented` envelope naming the path                      |
| `/oauth/token`                      | 501    | `not_implemented` envelope naming the path                      |
| `/oauth/userinfo`                   | 501    | `not_implemented` envelope naming the path                      |
| `/oauth/revoke`                     | 501    | `not_implemented` envelope naming the path                      |
| `/oauth/logout`                     | 501    | `not_implemented` envelope naming the path                      |
| `/health`                           | 200    | liveness body — `ok`, `service`, `detail`                       |
| `/ready`                            | 200    | readiness body — `ready: false`, `authentication`, route counts |
| anything else                       | 404    | `not_found` envelope naming the entity, not echoing the path    |

Two details of that table are decisions rather than defaults. The 501 body is
`TransportError::Unimplemented` rather than `ApplicationError::NotImplemented`,
because only the former renders the message the contract pins in
`contracts/shared/v1/not-implemented-envelope.schema.json`. And the 404 body does
**not** echo the requested path: the client supplied it, so echoing it tells
them nothing they did not know, while a body that reflects probe input is a body
that can be pushed around.

The 501 is also deliberately **not** `ErrorEnvelope::status()`, which maps the
`not_implemented` code to 500. The status on the wire is 501; a client that sees
500 retries, and retrying an endpoint that will never exist is a retry storm
against a route that cannot be fixed by retrying. A test pins the divergence so a
future change to either side is noticed.

## What each Worker may never do

### `identity` may never

- **Hold another service's state.** The Identity Worker is the source of truth
  for identity, and it is not the source of truth for Archkeep, Loom, Release
  Craft or Action Agents. It decides who a user _is_; those systems decide what
  that user may do, from their own data. A `PlatformRole` here says what an
  administrator may do to an **account**. It is never consulted about a merge.
- **Carry business authorization in a token.** An `id_token` claims who the
  subject is and what assurance they reached. It does not carry a permission
  graph for a system this repository does not own.
- **Trust `IDENTITY_KV` for an authorisation decision.** KV holds counters. A
  counter that disagrees with D1 is a lost rate limit, not a lost account.
- **Issue a 200 on a route it has not implemented.** See above.

### `identity-admin` may never

- **Hold `IDENTITY_DB`.** Not in code, not in `wrangler.jsonc`, not "just for
  this one report". Full argument: [admin-isolation.md](admin-isolation.md).
- **Decide authorisation itself.** It forwards a typed application-layer command
  to `identity`; it does not evaluate whether the operator may perform it.
  `identity-application`'s administration traits exist so that the decision has
  one home.
- **Treat its own session as sufficient authority over identity.** Its session
  says who is looking at the admin UI. It does not say what they may change in
  the identity database. That second answer is `identity`'s to give.

### `identity-jobs` may never

- **Hold `IDENTITY_DB`.** It has no D1 binding at all in the bootstrap
  configuration.
- **Depend on `identity-domain` or `identity-application`.** It must not be able
  to evaluate identity rules. Full argument:
  [jobs-isolation.md](jobs-isolation.md).
- **Own identity state.** "It only needs the `User` type" is the sentence that
  starts the erosion, and the manifest names it as the reason for the absence.
- **Publish to the queue.** It is a consumer. A producer and a consumer on the
  same queue is a loop, and a loop with no owner is an outage nobody can point
  at.
- **Assume at-most-once delivery.** It will see duplicates. See
  [event-model.md](event-model.md).

## Composition roots, not policy

The three Worker crates are allowed to name the `worker` crate and the binding
names, because that is what wiring is. They are not allowed to contain policy:
the health routes, the OIDC route table, the error envelope and the
request-id plumbing all come from `identity-cloudflare`, precisely so the three
Workers cannot drift apart on any of them.

This is a real cost, and it is paid on purpose. Three independent routers mean
three places for a security fix to land in two of them. The shared adapter
crate is why a fix lands in all three or none.

## Related

- [trust-boundaries.md](trust-boundaries.md) — where the lines are.
- [crate-dependency-law.md](crate-dependency-law.md) — what the roots may
  depend on.
- [admin-isolation.md](admin-isolation.md), [jobs-isolation.md](jobs-isolation.md)
  — the two negative boundaries in full.
- [overview.md](overview.md) — the request paths through all three.
