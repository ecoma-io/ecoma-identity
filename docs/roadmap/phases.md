# Roadmap — what lands in which phase

What this document owns: **the phase number that every `DEFERRED` marker in
`docs/` points at.** `docs/README.md` defines the status vocabulary, and it
defines `DEFERRED` as "named, with the phase that will build it". This file is
where the name lives. A `DEFERRED` marker whose phase is not in the table below
is a broken marker, and `pnpm verify` will not catch it — it is caught by
reading.

## What this document is not

It is **not** a schedule. There are no dates here, and adding one would be a
claim this repository cannot make: it is a single-maintainer project whose
capacity is not a function of the calendar, and a dated plan that slips teaches
everybody to ignore the plan. A phase here means _ordered work with a defined
exit condition_, not a quarter.

It is also **not** permission to start early. A phase is not "unblocked" because
its predecessor is done; it is unblocked when its exit condition is met. The
ordering is a dependency argument, not a queue.

## The rule that governs the order

**A phase may not begin until every earlier phase's exit condition is met, and a
phase is not done until its exit condition is met.** Not "mostly". The exit
conditions below are written so that "mostly" is not a possible reading.

The reason is specific to this repository rather than to project management in
general: the security model is a set of invariants that reference each other. A
partial authentication flow is not a partially-working feature, it is an
authentication system with a hole, and the hole's shape depends on which pieces
are present. Shipping email OTP before the session model is the example that
matters — the first version of every identity system has a "temporary" session
path, and the temporary path is what everyone uses.

## The phases

### Phase 0 — Platform bootstrap (this commit)

The deliverable is the platform: the toolchain, the architecture law, the gates,
the three deployables' shapes, the contracts, the schema, and the three Workers
answering `/health` and `/ready` while every protocol route answers 501.

**Exit condition — all of these, and none of them may be waived:**

- `cargo test --workspace`, `cargo clippy --workspace --all-targets` and
  `cargo doc --workspace --no-deps` are all silent.
- `pnpm arch` passes on the real tree, and `pnpm arch:canary` proves the guard
  still fails on a deliberately-violating fixture tree.
- Both frontends typecheck and their suites pass.
- `docs/README.md`'s status table is accurate as of the commit it sits in.
- Every declared protocol route returns 501, and `/ready` reports that
  authentication is not implemented. A `/ready` that reports readiness is a
  failure of this phase, not of a later one.

**Deliberately not in this phase:** every authentication flow. Naming them here
is the point of listing them as absent from Phase 0.

### Phase 1 — Sessions and the request context

Sessions as server-side records, the `security_version` invalidation counter,
the cookie transport, and the authenticated-request context every later flow
builds on.

This is first among the flows because it is the one every other flow depends on
and the one that is hardest to change later. `security_version` in particular:
changing its meaning after sessions exist means every outstanding session is
either valid against the wrong rule or invalid against the right one, and
neither is detectable from the database.

**Exit condition:**

- Issue, validate, revoke and expire a session end to end against a real
  session cookie.
- `security_version` invalidation demonstrated: bump the counter, and every
  earlier session is refused on its next request, without enumerating them.
- The domain invariants currently `#[ignore]`d in
  `crates/identity-domain/src/invariants.rs` that this phase can express are
  implemented and un-ignored. The others stay ignored with a reason naming the
  phase that will take them — the ignore is not a debt to be cleared quietly, it
  is a live statement about what is not enforced.
- No token exists in `localStorage` or in any JavaScript-readable store, and a
  test says so.

### Phase 2 — Email OTP, and the first real authentication

The first factor. One-time codes, the outbox-driven send, rate limiting, and
consumption enforcement.

**Exit condition:**

- An OTP can be requested, sent through the `EMAIL_PROVIDER` binding, and
  consumed exactly once — including under two concurrent verifications of the
  same code, which is the race the schema's consumption guard exists to lose.
- Enumeration-safe responses: a request for an unknown address and a request for
  a known one are indistinguishable in status, body and timing. The
  `StartEmailLoginOutcome` shape in `identity-application` already carries a
  `retry_after_seconds` on both arms for exactly this reason.
- The rate limiter fails **closed**, and the failure is demonstrated rather than
  asserted.
- Delivery is real. A "send" that logs and returns success is a finding under
  `SECURITY.md`, not a phase gate.

### Phase 3 — Second factor, and the assurance model

TOTP and recovery codes, the step-up flow, and AAL2-gated operations.

**Exit condition:**

- TOTP with the window and drift behaviour documented in
  `identity-security`, using WebCrypto only. No cryptography crate, and no
  hand-rolled comparison (ADR-0008).
- A step-up is scoped to the session that performed it and to its own validity
  window. An account-wide "recently authenticated" flag is a privilege-escalation
  primitive and is a review finding.
- AAL1 is refused on every AAL2 operation, and the refusal is tested at the
  layer that enforces it rather than only in the domain.

### Phase 4 — OIDC provider

`/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, JWKS, discovery,
introspection, revocation, and logout.

**Exit condition:**

- The authorization code flow only, S256-only PKCE,
  `request_parameter_supported: false`, RS256 only, public subject type — the
  constraints already encoded in `identity-oidc`, tested rather than asserted.
- `Route::is_implemented()` flips to true per route, and the discovery document,
  the `/ready` probe and `docs/README.md`'s status table are updated **in the
  same commit**. A route that works while the table says it does not is a lie in
  one of the two.
- Client registration and the confidential/public distinction, with a
  `client_secret` shown exactly once and never persisted in cleartext.

### Phase 5 — Applications, grants, and the self-service surface

Registered applications, redirect-URI exact matching, grants and consent, and
the account, session and authenticator management the web app renders.

**Exit condition:**

- Exact redirect-URI matching with no prefix, wildcard or normalisation escape.
  `Application::allows_redirect_uri` already implements the strict form.
- Consent is recorded, and revoking a grant revokes the tokens issued under it.
- The self-service web app drives every screen against a live Worker. The
  deferred-state UI this phase replaces is deleted in the same commit, not
  left behind behind a capability flag.

### Phase 6 — Administration

The operator console's data path: search, suspend, role change, session
revocation, audit query — all through the private service binding.

**Exit condition:**

- The Admin Worker still holds no D1 binding, and
  `tooling/scripts/check-architecture.mjs` still fails on a tree where it does.
- The last-administrator rule holds under concurrency: two simultaneous demotions
  must not both see two administrators. The count and the change belong in one
  transaction, and the test must actually race them.
- Every administrative action writes an audit event, including the refusals.

### Phase 7 — Background work

The Jobs Worker's real side effects: email delivery from the outbox, audit
archival, retention.

**Exit condition:**

- Every handler is idempotent by message id, and the tests demonstrate it by
  delivering the same message twice.
- A handler that fails a side effect records the failure and does not claim
  success, because a caller who sees success believes the mail went out.
- `JOBS_KV` remains scratch. Nothing in it is authoritative, and the architecture
  guard still fails on a Worker that treats it otherwise.

### Phase 8 — Passkeys

WebAuthn, as the phishing-resistant second factor.

Last, deliberately: a passkey is a second factor, and building it before
sessions and a first factor would mean building it against a session model that
is still changing.

**Exit condition:**

- Registration and assertion, with the stored credential holding a public key
  and nothing private. `PasskeyCredential` already carries
  `#[serde(deny_unknown_fields)]` for exactly this reason; a payload carrying a
  private key must be refused, not ignored.
- A cloned-authenticator signal, with the documented handling for an
  authenticator that does not implement counters — common, and not by itself
  evidence of cloning.

## The phase table

The one-glance version. `docs/` markers point here.

| Area                                                                  | Phase | Marker today                 |
| --------------------------------------------------------------------- | ----- | ---------------------------- |
| Domain model, invariants, use-case ports, contracts, schema, gates    | 0     | `IMPLEMENTED` / `SCAFFOLDED` |
| Health and readiness on all three Workers                             | 0     | `IMPLEMENTED`                |
| 501 contract on every declared protocol route                         | 0     | `IMPLEMENTED`                |
| Sessions, `security_version`, cookie transport, request context       | 1     | `DEFERRED`                   |
| Email OTP, delivery, rate limiting, enumeration safety                | 2     | `DEFERRED`                   |
| TOTP, recovery codes, step-up, AAL2 gating                            | 3     | `DEFERRED`                   |
| OIDC provider: authorize, token, userinfo, JWKS, discovery            | 4     | `DEFERRED`                   |
| Applications, redirect-URI matching, grants, consent, self-service UI | 5     | `DEFERRED`                   |
| Administration through the private service binding                    | 6     | `DEFERRED`                   |
| Background side effects, outbox dispatch, idempotency                 | 7     | `DEFERRED`                   |
| Passkeys / WebAuthn                                                   | 8     | `DEFERRED`                   |

## What is deliberately not in the plan

- **SAML.** `IdentityProvider` has a `Saml` variant because the domain is
  expected to need it, not because anything implements it. Adding it is a new
  phase, not an extension of Phase 4.
- **Social login as a first factor.** Linking a provider identity is Phase 5's
  `LinkIdentity`; treating a third-party assertion as _proof of identity_ is a
  different decision with a different threat model, and it is not in the plan at
  all.
- **Business authorization.** Not a phase, not a deferral, not a later
  version of this roadmap. Identity does not do it, and no phase of this
  document will add it (ADR-0005).
- **Multi-tenancy, organisation membership, and delegated administration.**
  These are real features of a real identity system and they are genuinely
  absent. Their absence is not an oversight and this document does not
  apologise for it; each would need its own ADR before its first line, because
  each changes who may act on whose account.
