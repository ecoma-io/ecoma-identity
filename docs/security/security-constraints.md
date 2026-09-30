# Security constraints

What this document is: the security invariants of Ecoma Identity, each stated as
something a reviewer can **check**, each with the ADR that decided it.

What this document is **not**: a restatement of the ADRs. A decision record and a
document that repeats it are two things that drift, so this file states the
_invariant_ and links the ADR _by number_ for the reasoning.

The constraints here are drawn from §2 of the founding brief. They are not all
29 of them: these are the ones that are about security. A change to any of them
requires an ADR first (founding constraint 29).

## How to read the status column

| Marker        | Meaning here                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `IMPLEMENTED` | The rule is enforced by code that exists, and a test fails if it stops being enforced.              |
| `SCAFFOLDED`  | The rule is expressed as a type, a trait, or a configuration entry. Nothing enforces it at runtime. |
| `PLANNED`     | Decided. Nothing is built.                                                                          |
| `DEFERRED`    | Named with the phase that will build it.                                                            |

A `PLANNED` invariant is a promise to the future, not a control. A
`SCAFFOLDED` one is a shape that makes the eventual control harder to get wrong
— worth having, not worth relying on.

## The constraints

### SC-01 — One source of truth for identity state

**Invariant.** Identity D1 is accessed by the Identity Worker and by nothing
else. No other Worker, no script, no migration runner outside the Worker.

**Check.** `grep -rn "IDENTITY_DB" infra/cloudflare/` returns hits in exactly
one `wrangler.jsonc`. No migration tooling outside the Worker has D1
credentials.

**What breaks if violated.** Every other constraint in this file becomes
advisory, and [../architecture/admin-isolation.md](../architecture/admin-isolation.md)
loses its argument.

**ADR:** founding constraint 2. **State:** `PLANNED` — decided, configuration
`DEFERRED`.

### SC-02 — The Admin Worker holds no identity database

**Invariant.** `identity-admin` has no `IDENTITY_DB` binding, in code and in
configuration, and reaches identity through the `IDENTITY` service binding and
nothing else. "Just for this one report" is not a category of exception.

**Check.** The Admin Worker's `wrangler.jsonc` has no D1 binding and no D1
credentials. Its `Cargo.toml` names no identity D1 adapter. `pnpm arch` passes.

**What breaks if violated.** A compromised admin surface becomes full read/write
access to every user, credential and session. Full argument in
[../architecture/admin-isolation.md](../architecture/admin-isolation.md).

**ADR:** founding constraint 3 and 4. **State:** `PLANNED`.

### SC-03 — The Jobs Worker owns no identity state

**Invariant.** `identity-jobs` has no `IDENTITY_DB` binding and depends on
neither `identity-domain` nor `identity-application`. It may depend on
`identity-oidc` (wire types) and `identity-security` (error vocabulary) and
`identity-cloudflare` (adapters).

**Check.** The Jobs Worker's manifest names no domain or application crate. Its
`wrangler.jsonc` has no D1 binding. `pnpm arch` passes.

**What breaks if violated.** A background worker can evaluate identity rules,
and a queue message is not a trustworthy caller.

**ADR:** founding constraint 5. **State:** `IMPLEMENTED` for the manifest
absence; the binding absence is `PLANNED`.

### SC-04 — Identity holds no business authorization

**Invariant.** Identity decides who a user **is**. It never decides what they may
do in Archkeep, Loom, Release Craft or Action Agents. A `PlatformRole` says what
an administrator may do to an **account** and is never consulted about a merge.
No token issued by this system carries a business permission for a system this
repository does not own.

**Check.** No `id_token` claim set contains a business permission. The
`PlatformRole` enum has no business-system variant. No route accepts a
"permission" input from a non-identity system.

**What breaks if violated.** Identity becomes the authorisation service for four
systems it cannot see the data of, and a change to a business permission model
becomes a change to a security-critical token.

**ADR:** founding constraint 6. **State:** `PLANNED`.

### SC-05 — No self-implemented cryptography

**Invariant.** WebCrypto only. No hand-rolled cipher, hash, MAC, padding, key
derivation, nonce, or constant-time comparison. If WebCrypto does not offer it,
the design is wrong. TOTP and WebAuthn come from maintained libraries behind the
`identity-security` interfaces — never from a local implementation.

**Check.** `Cargo.toml` names no cryptography crate. A hand-written comparison
of a secret is a review failure, not a style note. The `ConstantTimeComparable`
sealed trait in `identity-security` exists so that a comparison type must be
adopted deliberately.

**What breaks if violated.** Hand-rolled crypto fails in ways that pass review —
a non-constant-time comparison on a session token, a low-entropy nonce, a TOTP
compared with `==` — and the failure is silent and remote. The only defence that
has worked is not having the code.

**ADR:** founding constraint 25; also cited in `AGENTS.md` as ADR-0008. **State:**
`PLANNED` for the enforcement, and the crate's own documentation states the law
today.

### SC-06 — No authentication bypass for development

**Invariant.** No flag, no environment variable, no test-only role, no
development-only code path. Local development runs the **same code path** as
production, with real secrets from `.dev.vars`.

**Check.** `grep` for a bypass-shaped identifier across the Workers and the web
apps. A dev-mode branch that widens authorisation is a production branch that
somebody will enable.

**What breaks if violated.** The bypass is in production, because the difference
between the environments is a variable and a variable gets set. And the
development environment is where the code path is actually exercised, so the
tested path and the deployed path are different code.

**ADR:** founding constraint 26; `AGENTS.md` cites ADR-0009. **State:**
`PLANNED`.

### SC-07 — No production secret in a tracked file

**Invariant.** `.dev.vars`, `.env*` and every secret-bearing file are gitignored.
An `.example` file exists in their place and carries the **key names** with
non-secret placeholder values. A secret never appears in a tracked file, in a CI
log, in a test fixture, or in a commit message.

**Check.** The ignore rules cover `.dev.vars` and `.env*`. `git ls-files` over
the repository finds no `.dev.vars` and no `.env` that is not an `.example`. The
committed `.example` values are visibly placeholders.

**What breaks if violated.** A committed secret is in every clone, every fork,
and every CI cache, and rotating it is the only remedy. Where each secret lives
and how it is rotated is [secrets-management.md](secrets-management.md).

**ADR:** founding constraint 27; `AGENTS.md` cites ADR-0009. **State:**
`PLANNED`.

### SC-08 — The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`

**Invariant.** No token ever reaches `localStorage` or any JavaScript-readable
storage. The session cookie is `HttpOnly` + `Secure` + `SameSite=Lax`. Every
authenticated call from a web app is a `credentials: "include"` fetch. CSRF
protection is a **server** responsibility, through the `CsrfService` gate — not a
token in a header the client chooses to send.

**Check.** `grep` for `localStorage` and `sessionStorage` in
`apps/*/web/src` finds no session token. The cookie is set with all three
attributes. The `sendBeacon` logout path still carries the CSRF token, because a
path that looks different is a path that misses the check.

**What breaks if violated.** Any XSS in either web app becomes a full session
theft; any CORS or CSRF hole becomes an authenticated request from a browser the
user did not intend. `HttpOnly` is what makes XSS not immediately fatal, and it
is a one-attribute change with a large blast radius.

**ADR:** founding constraint 1, applied at the browser edge. **State:**
`SCAFFOLDED` — the web apps are written and both declare the rule in their own
source: no `localStorage` or `sessionStorage` for a session token, and every
authenticated call goes through a `credentials: "include"` client. Nothing
serves them yet, so nothing enforces it at runtime.

### SC-09 — Redirect URIs match exactly, and only absolute ones may be registered

**Invariant.** A presented `redirect_uri` is compared for **exact string
equality** against the client's registered set — never a prefix, never a glob,
never a host suffix. A registered URI must be absolute, must be `http://` or
`https://`, must carry no fragment, and is at most 2048 bytes.

**Check.** `Application::allows_redirect_uri` is `self.redirect_uris.iter().any(|r| r == presented)`.
`Application::add_redirect_uri` refuses a blank, padded, over-long, relative, or
fragmented URI and refuses a duplicate. A test names the
`https://app.example.com.attacker.test/` case.

**What breaks if violated.** The authorization code — the bearer credential for
the whole flow — is delivered to an attacker, and the protection PKCE provides is
irrelevant because the attacker holds the code.

**ADR:** OAuth 2.1; the error is `DomainError::Invalid` with `code()` `invalid`.
**State:** `IMPLEMENTED` for registration. The request-time check is `DEFERRED`,
because no request is served.

### SC-10 — PKCE is `S256` only, and it is required

**Invariant.** `SUPPORTED_CODE_CHALLENGE_METHOD` is `"S256"`. `plain` is never
accepted. The discovery document advertises only `S256`. The requirement is a
property of the **client registration**, not a parameter of the request.

**Check.** `AuthorizationRequest::uses_supported_pkce()`; the discovery
document's `code_challenge_methods_supported`; a test asserting `plain` is not
advertised. The token endpoint refuses a request whose `code_verifier` is
absent or mismatched for a client that registered PKCE.

**What breaks if violated.** An intercepted authorization code becomes
redeemable, and both the client and the documentation still report PKCE as
enabled.

**ADR:** the discovery document is the contract. **State:** `SCAFFOLDED` — the
policy is real as data, the `PkceService` gate has no body, and the token
endpoint does not exist.

### SC-11 — Client secrets are hashed, never printed, never in a URL

**Invariant.** A `client_secret` is stored only as a hash. It is never logged,
never placed in a query string, never compared with `==`, and never returned by
an API after issuance. Rotation returns the **old secret's expiry**, not the old
secret, so a grace window does not require the old value to be recoverable.

**Check.** `ClientSecret`'s `Debug` and `Display` are redacted; a test asserts
a secret cannot be printed. The only accessor is `expose_for_hashing`.
`RotateClientSecretOutcome` carries an expiry. `ApplicationSecretRotated` is an
`AuditEventType`, so a rotation is auditable. Secrets travel in a body or an
`Authorization` header, never a query parameter.

**What breaks if violated.** A leaked client secret is a bearer credential for
every user who authorizes the client, and it does not expire on a schedule anyone
controls.

**ADR:** SC-05 covers the comparison; the lifecycle is
[secrets-management.md](secrets-management.md). **State:** `SCAFFOLDED` for the
shape; issuance is `DEFERRED`.

### SC-12 — The rate limiter fails **closed**

**Invariant.** When `RATE_LIMITER` or `ADMIN_RATE_LIMITER` is unavailable, the
request is **refused**. It is never permitted because the limiter could not be
reached. `SecurityError::RateLimiterUnavailable` is the answer, its code is
`temporarily_unavailable`, its reason is not client-safe, and it does not merit an
audit event — an outage is ours, not an attack.

**Check.** No login or verification path treats a limiter error as a pass. The
`is_client_safe()` assertion for `RateLimiterUnavailable` is `false`, so the
reason string cannot reach a client.

**What breaks if violated.** A limiter outage becomes an open
credential-stuffing window, invisible to the attacker and to the operator.

**ADR:** founding constraint 25's counterpart, and
[threat-model.md](threat-model.md) §7. **State:** `SCAFFOLDED` — the vocabulary
is real, and `identity-cloudflare`'s `rate_limit` module now implements the
fail-closed decision itself: a binding that is absent or a platform call that
fails becomes `RateLimiterUnavailable`, and there is a test for the outage case.
What does not exist yet is a login endpoint that calls it, and the crate is
mid-write and does not currently compile, so nothing enforces it at runtime
today.

### SC-13 — A credential is single-use, consumed atomically

**Invariant.** An OTP challenge, an authorization code, a nonce, and a recovery
code are each consumed by a **single atomic operation** whose affected-row count
is the answer, inside the transaction that issues the resulting session. A
`SELECT` followed by an `UPDATE` is not a consume. A replay is reported as
`SecurityError::AlreadyRedeemed`, which is a distinct outcome from a wrong code.

**Check.** The consume is a conditional write. The tests for two concurrent
verifications of one challenge exist before the implementation does — an ignored
test naming the race is honest; a passing test asserting the opposite is a lie.

**What breaks if violated.** Two concurrent verifications produce two valid
sessions, so a leaked OTP that is being raced yields an attacker a durable
session even after the legitimate user has consumed the code.

**ADR:** the `AlreadyRedeemed` variant in `identity-security::error`. **State:**
`SCAFFOLDED` for the error; the consume is `DEFERRED`.

### SC-14 — Assurance is per session, and step-up is per session

**Invariant.** AAL is a property of a session, not of a user. A session records
the `aal` it reached. `Session::satisfies(required)` refuses an AAL1 session for
an AAL2 operation. `recently_authenticated` is a **per-session** flag, never a
column on the user.

**Check.** `Session::satisfies` is the only place an AAL requirement is
evaluated, and there is a test that an AAL1 session does not satisfy an AAL2
operation. There is a test that a step-up on one session does not lift another
session of the same user.

**What breaks if violated.** If step-up lived on the user, one attacker session
with a second factor would make **every other session on that account**
step-up-eligible, including sessions an attacker has stolen and cannot
authenticate.

**ADR:** the `Aal` type and `Session` field, both `IMPLEMENTED`. **State:**
`IMPLEMENTED` for the model; enforcement is `DEFERRED`.

### SC-15 — `security_version` is checked on every authenticated request

**Invariant.** Every authenticated request compares the session's recorded
`security_version` against `users.security_version` and refuses on a mismatch.
The comparison is never cached, never memoised in an isolate, and never skipped
for speed. The `UPDATE` that bumps the version is in the **same transaction** as
the change that caused it, and it never accepts a caller-supplied value — the
column is monotonic.

**Check.** Every route that reads a session performs the comparison. A
memoisation or a cache that skips it is a review failure. The bump statement
takes no parameter from the request.

**What breaks if violated.** "Log out everywhere" stops working, on one route
at a time, and it fails silently — nothing looks broken, the sessions are simply
still valid.

**ADR:** the column and the comparison are `identity-domain::security` and
`Session::security_version`. **State:** `IMPLEMENTED` for the comparison;
`DEFERRED` for the enforcement discipline.

### SC-16 — No fourth deployable without an ADR

**Invariant.** There are exactly three: `identity`, `identity-admin`,
`identity-jobs`. A fourth Worker requires an ADR and proof it cannot live in one
of the three.

**Check.** The moon project list, the three `wrangler.jsonc` files, and the
release-please components are the same three names. A new Worker appears with its
ADR in the same change.

**What breaks if violated.** The blast-radius argument in
[../architecture/admin-isolation.md](../architecture/admin-isolation.md) and
[jobs-isolation.md](../architecture/jobs-isolation.md) is per-Worker; a Worker
with no documented boundary has no argument at all.

**ADR:** founding constraint 7 and 23. **State:** `IMPLEMENTED` for the count
(the three crates exist); `PLANNED` for the gate.

### SC-17 — Migrations are backward-compatible and forward-only

**Invariant.** A migration may add a table, a column, an index, or a value to a
check constraint's vocabulary. It may widen a constraint. It may **not** remove
or rename anything a not-yet-rolled-back version reads, narrow anything it
satisfies, or change a value's meaning. **There is no database rollback path** —
rollback is a Worker version promotion, and the previous version is running
against the current schema for the whole rollback window.

**Check.** Every migration is reviewed against the rollback window, not only
against the current version. A rename is a drop and an add.

**What breaks if violated.** A rollback promotes a version that cannot read the
schema, which turns a five-minute recovery into a restore.

**ADR:** founding constraint 21; `AGENTS.md` cites ADR-0011. Operational
procedure in [../operations/rollback.md](../operations/rollback.md). **State:**
`PLANNED`.

### SC-18 — A private service binding does not authenticate an operator

**Invariant.** A service binding authenticates _which Worker_ is calling. It does
**not** authenticate _which human or session_ is behind that Worker. No internal
endpoint may trust an actor identity supplied by the caller in a header or a
body. The actor must be re-derived by the Identity Worker from something the
Identity Worker issued and can verify.

**Check.** No internal endpoint reads an actor from a request header. The
`IdentityAdminClient` port's types carry an actor only in a form the Identity
Worker can check.

**What breaks if violated.** Any Admin Worker session becomes any administrator.
The Admin Worker's own authentication becomes the authorisation primitive for the
whole identity database, and the audit trail attributes every action to nobody in
particular.

**ADR:** founding constraints 3 and 4; the design for the actor re-derivation is
`PLANNED` and the ADR is not yet written — see the explicit warning in
[../architecture/trust-boundaries.md](../architecture/trust-boundaries.md). **State:**
`PLANNED` — **this is the largest open security design in the repository.**

### SC-19 — A queue message is untrusted input

**Invariant.** A message on `IDENTITY_QUEUE` is not a trustworthy caller. It is
validated against the event type's own versioned schema before anything is done
with it. An event type without a `.vN` suffix is refused at parse time. A consumer
refuses a version it does not implement, counting and skipping it rather than
guessing.

**Check.** `OutboxEventType::parse` rejects `identity.email.send` with no
suffix — there is a test. `OutboxEventType::version()` returns `0` for an
unparseable suffix and no consumer supports `0`. The Jobs Worker's manifest names
no domain or application crate, so it cannot evaluate a rule off the message.

**What breaks if violated.** The security question becomes structural validity,
which anyone who can publish to the queue satisfies for free.

**ADR:** founding constraint 5 and 22;
[../architecture/event-model.md](../architecture/event-model.md). **State:**
`IMPLEMENTED` for the type-level refusals; the consumer is `DEFERRED`.

### SC-20 — Nothing reaches the frontends

**Invariant.** `crates/**` and `apps/*/worker/**` may not import from
`apps/*/web/**`. The BFF is a boundary, not a shared library. The frontend and its
BFF are one release unit, and they are still two languages and two trust
positions.

**Check.** `pnpm arch` passes. There is no shared TypeScript package between a
web app and a Worker.

**What breaks if violated.** Browser-reachable code ends up on the server side of
a trust line, and a type that both the Vue app and the Worker use is a type whose
shape is now constrained by whichever side is stricter — which is the wrong
pressure.

**ADR:** founding constraint 8; `AGENTS.md` names the BFF as a boundary.
**State:** `PLANNED` for the gate.

### SC-21 — An error's message is not its contract; its code is

**Invariant.** Every error carries a stable machine-readable `code()`, and the
`code()` is the contract. Whether the message is client-safe is a **separate,
explicit question** the transport must ask — `is_client_safe()`. Operator-facing
variants (`Dependency`, `MissingSecret`, `Cryptographic`,
`RateLimiterUnavailable`) are never forwarded to a client. `ApplicationError`
holds no HTTP status code; the transport mapping lives in `identity-cloudflare`.

**Check.** Every error enum has a `code()`. Every error enum has an
`is_client_safe()`. No transport forwards a `Display` of an error that has
answered `false`. `ApplicationError` has no status field, and a test asserts a
dependency failure is not client-safe.

**What breaks if violated.** A `Dependency` reason string reaching a client
leaks a database error to the internet; a `MissingSecret` name leaks which key
is absent. And a per-transport status mapping is three mappings that drift.

**ADR:** the `code()`/`is_client_safe()` pair, both `IMPLEMENTED`. **State:**
`IMPLEMENTED`.

### SC-22 — Error responses do not become an oracle

**Invariant.** A caller must not be able to distinguish outcomes that help it.
`SecurityError::TokenRejected` is **one** variant for wrong audience, wrong
issuer, already revoked, and outside the validity window, because a caller that
could tell "wrong audience" from "revoked" could probe for which tokens exist.
`ApplicationError::Dependency` is a single `internal_error` code. The message for
a verification failure is identical whether the code was wrong, the challenge
was unknown, or the credential had expired — except that the **audit** record
distinguishes them, because the audit trail is not visible to the attacker.

**Check.** `SecurityError::code()` maps `TokenRejected` to `invalid_token` for
all four cases. `AlreadyRedeemed` is a distinct variant — that exception is
deliberate and is SC-13's business, not an oracle: telling a legitimate client
that its own code was already used is a usability requirement, and the scenario
requires the attacker to already possess a valid code.

**What breaks if violated.** An error-message oracle turns a failed guess into a
confirmed one. In an identity system that is the difference between a rate-limited
brute force and a targeted account takeover.

**ADR:** the `SecurityError` variant set, which is `IMPLEMENTED`. **State:**
`IMPLEMENTED`.

### SC-23 — Audit events are append-only, with three distinct identities

**Invariant.** There is no update path and no delete path for `audit_events`, and
no operation in the domain or application layer that would produce one.
`user_id` (who the event concerns), `actor_id` (who did it) and
`actor_session_id` (under which session) are three separate nullable columns and
are never collapsed. Every administrative mutation writes its audit event in the
**same transaction** as the state change.

**Check.** No `UPDATE` or `DELETE` against `audit_events` appears anywhere. A
mutation and its audit event share a transaction. `AuditEventType` has
`is_administrative()` and `concerns_a_user()` so the log is queryable without
scanning metadata.

**What breaks if violated.** An audit trail that can be edited is not evidence, and
one that collapses actor into subject cannot answer "who suspended me".

**ADR:** the `AuditEvent` type, which is `IMPLEMENTED`. See
[../operations/observability.md](../operations/observability.md). **State:**
`IMPLEMENTED` for the type; the transactional write is `DEFERRED`.

### SC-24 — No secret material reaches a log, and no token reaches a client that

is not entitled to it

**Invariant.** Never logged: client secrets, TOTP secrets, recovery codes,
session tokens, authorization codes, OTPs, passkey assertions, `Authorization`
headers, `Cookie` headers, and `token`/`code`/`client_secret` request
parameters. `metadata` on an audit event is a `BTreeMap<String, String>` and its
keys are drawn from a fixed vocabulary, so an arbitrary string cannot be smuggled
into it as a "label". Debug and `Display` for `ClientSecret`, `TotpSecret` and
`RecoveryCodeBatch` are redacted, and a test asserts each.

**Check.** Grep the logging call sites for the names above. A
`Debug`-derived log of a type that holds a secret is a leak, which is why the
`Debug` impls are redacted rather than relying on call-site discipline.

**What breaks if violated.** Logs are longer-lived, wider, and less protected than
the system they describe. A session token in a log aggregator is a session that
cannot be invalidated by revoking the session.

**ADR:** the redacted `Debug` impls, `IMPLEMENTED` in
`identity-security::factors`. Full list in
[../operations/observability.md](../operations/observability.md). **State:**
`IMPLEMENTED` for the redactions; the call sites are `DEFERRED`.

## The one that is still open

**SC-18** is the only invariant in this list with no decided design behind it.
Every other entry links to a decision that exists. SC-18 does not, and the gap
is deliberate and named: the actor re-derivation across a private service binding
has not been designed, and the failure mode — any Admin Worker session becoming
any administrator — is severe enough that the constraint is recorded here before
the design rather than after.

If you are about to write the internal endpoints, SC-18 is the constraint you
cannot design around. If you cannot satisfy it, that is an ADR.

## Related

- [threat-model.md](threat-model.md) — the attacks behind these constraints, and
  which mitigations exist.
- [secrets-management.md](secrets-management.md) — where each secret lives and
  how it is rotated.
- [../architecture/trust-boundaries.md](../architecture/trust-boundaries.md) —
  the boundaries these invariants protect.
