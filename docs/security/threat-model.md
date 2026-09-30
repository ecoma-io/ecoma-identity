# Threat model

What this document is: the assets, the actors, the trust boundaries, and the
attacks that matter **specifically to this system** — with, for each, whether the
mitigation exists yet.

What this document is **not**: a list of everything that could go wrong, a
penetration test report, or a description of implemented defences. Most of the
mitigations below do not exist yet, and the table says which.

The honesty column is the point of this document. A threat model that lists
mitigations as if they were in place is worse than no threat model, because it
is read as a description of a system that is not there.

## Status

| Fact                                                    | State                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The asset and actor inventory below                     | `IMPLEMENTED` — this is analysis, not behaviour                                                          |
| The error vocabulary that distinguishes refusals        | `IMPLEMENTED` — `identity-security::SecurityError` is real, with `is_client_safe()` and `merits_audit()` |
| Every mitigation in the attacks table                   | `DEFERRED` or `SCAFFOLDED` — none is running                                                             |
| The security gates the mitigations will be expressed in | `SCAFFOLDED` — traits in `identity-security` with no bodies                                              |
| Rate limiting on any endpoint                           | `DEFERRED` — the bindings are named, nothing is wired                                                    |

## Assets

Ranked by what an attacker wants. The ranking is not a guess: it follows from
what the rest of the platform trusts.

| #   | Asset                                   | Where it lives                                                              | Why it matters                                                                                                                                                                                 |
| --- | --------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Client secrets**                      | `applications.client_secret_hash`, and the plaintext at the moment of issue | A client secret is a bearer credential for the whole authorization code flow. Its hash is the whole protection of the row.                                                                     |
| 2   | **Session tokens / the session cookie** | The `HttpOnly` cookie, the `sessions` row behind it                         | A live session is a completed authentication. There is no second factor at `aal1`.                                                                                                             |
| 3   | **TOTP secrets and recovery codes**     | `authenticators.secret`                                                     | A TOTP secret is a permanent second factor. Recovery codes are the bypass around it.                                                                                                           |
| 4   | **Passkey credentials**                 | The public key and credential id, `authenticators`                          | Losing the private key loses the factor; a stolen credential id plus a signature is a login.                                                                                                   |
| 5   | **The `users` table**                   | Identity D1                                                                 | Every row is a person. Email addresses, status, role.                                                                                                                                          |
| 6   | **`security_version`**                  | `users.security_version`                                                    | Low value on its own; it is the kill switch. Anyone who can read and write it can revoke or un-revoke every session on the platform.                                                           |
| 7   | **The audit trail**                     | `audit_events`                                                              | It is how an intrusion is detected after the fact, and how a compromised administrator is identified. Its integrity matters as much as the data's.                                             |
| 8   | **The outbox and `JOBS_KV`**            | `outbox_events`, `JOBS_KV`                                                  | An attacker who can enqueue can cause emails to arbitrary addresses. An attacker who can clear the idempotency record causes duplicate security notices, which is a social-engineering vector. |
| 9   | **Rate-limiter state**                  | `IDENTITY_KV`, `RATE_LIMITER`, `ADMIN_RATE_LIMITER`                         | Not a secret, but its absence is a credential-stuffing enabler.                                                                                                                                |

## Actors

| Actor                              | Trust level                                | What they can reach                                                                                                                                          |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anonymous caller**               | None                                       | Every public route: the OIDC endpoints, `/health`, `/ready`, the static assets, the sign-in UI.                                                              |
| **Authenticated end user**         | Their own account                          | Their own sessions, their own account, their own email addresses. `aal1`, or `aal2` after a step-up.                                                         |
| **Authenticated administrator**    | High, and audited                          | The admin surface, and through the service binding, the administrative use cases in `identity`.                                                              |
| **OAuth client**                   | Its own registration                       | `/oauth/token`, `/oauth/revoke`, and the scopes it registered.                                                                                               |
| **A queue publisher**              | None                                       | Whatever the Jobs Worker will act on. In practice that is the Identity Worker; in a threat model it is anyone who can publish.                               |
| **The third-party email provider** | Outside the boundary                       | Every email address and message body.                                                                                                                        |
| **A compromised Admin Worker**     | High, unaudited at the point of compromise | Whatever the internal endpoints expose — and _only_ that, which is the argument in [../architecture/admin-isolation.md](../architecture/admin-isolation.md). |
| **A Cloudflare account operator**  | Absolute                                   | Everything. Out of scope for this document; it is a different trust model.                                                                                   |

## Trust boundaries

The map is in [../architecture/trust-boundaries.md](../architecture/trust-boundaries.md).
The three that this document's attacks live on:

1. **Anonymous → Identity Worker.** Every request here is attacker-controlled in
   full.
2. **Admin Worker → Identity Worker.** A private service binding authenticates
   _which Worker_ is calling, not _which operator_.
3. **Queue → Jobs Worker.** A message is an untrusted input that performs a real
   side effect.

## The attacks

### 1. Account takeover via session confusion

**Asset:** #2, the session.

**The attack.** The system has two ways to be a user in it: an OIDC session
cookie for a human, and a bearer access token for a machine client. These are
different credentials with different lifetimes, different revocation semantics,
and different audiences. A confused-deputy bug — a request path that accepts
either, a middleware that reads a header before it reads the cookie, a session
table shared between the two flows — lets an attacker present a stolen access
token somewhere a session cookie is expected, or present a session cookie to an
endpoint that assumed a bearer token, and end up authenticated as the wrong
principal.

The variant that matters most here: **the Admin Worker's session and an
end-user's session are different sessions in the same system.** If any code path
can satisfy an administrative request with an ordinary end-user session, that is
privilege escalation, not authentication. The mitigation is that the Admin Worker
is a separate deployable with a separate session, and `AdminContext` carries both
an `actor_id` and an `actor_session_id` so the command that acts on the request
can see which session authorised it.

**Current mitigation:** partially real as a _type_. `AdminContext` exists and
`auditing` is a compile-time property of the administration traits. **Not
exist as a runtime control** — there is no runtime, so nothing distinguishes the
two sessions yet.

**State:** `SCAFFOLDED` for the type; `DEFERRED` for the runtime check.

### 2. The `security_version` invalidation gap

**Asset:** #6, and by extension #2.

**The attack, and why the mechanism is subtle.** `security_version` is a single
integer on the user row. A session records the version it was issued under, and
every authenticated request compares it against the user's current version,
refusing on a mismatch. Bumping the column invalidates every older session in one
write, with no enumeration.

The gap: **the comparison is only as good as the moment it is enforced.** Three
ways it fails:

- **The check is missing on some route.** One handler that trusts the cookie
  without comparing the version is a complete bypass of "log out everywhere",
  because the attacker does not need the _old_ session's cookie to stay valid —
  they need _any_ route that does not check. A system that checks on nine routes
  and forgets the tenth has no kill switch at all.
- **The check is cached.** A request-level check is fine. A check memoised in a
  Worker isolate, a KV entry, or a CDN cache header is not, because a bump must
  take effect immediately and a cache cannot be invalidated from D1.
- **The bump is not atomic with the reason for it.** If a password change
  revokes sessions by bumping the version, and the password write and the bump
  are separate transactions, an attacker racing the second one keeps a live
  session with a new password.

There is a fourth, quieter one: **an attacker who can write `security_version`
can un-revoke.** The column is symmetric. Bumping it revokes everything; lowering
it back to the value the attacker's stolen session recorded makes that session
valid again. This is why `security_version` is a write-once-in-one-direction
value from the application's point of view and why the `UPDATE` that bumps it
should never accept a caller-supplied value.

**Current mitigation:** the _arithmetic_ is real and tested in `identity-domain`:
`SecurityVersion::bumped()`, the comparison of a session's recorded version
against the current one, and the assertion that every older version differs after
a bump. That is half the mechanism. The **enforcement point is `DEFERRED`**,
and so is the discipline of "every authenticated route checks".

**State:** `IMPLEMENTED` for the comparison; `DEFERRED` for the enforcement.

### 3. OTP replay between two concurrent verifications

**Asset:** #2, and the integrity of the login flow.

**The attack.** An OTP is a one-time credential. The vulnerability is not
reusing one code twice; it is two verification requests for the _same_ challenge
arriving concurrently, and both being accepted. If the verification path reads
the challenge, checks the code, and then marks the challenge consumed in three
separate steps, two in-flight requests both see "not yet consumed" and both mint
a session.

This matters more than a duplicate code would: a leaked OTP that is being raced
produces **two independent sessions**, not one. The attacker does not need the
code twice, only the window. In the second-factor case it is worse still: two
concurrent verifications produce two `aal2` sessions, and the step-up flag is
per-session, so both are individually valid.

The mitigation is a single atomic consume — a conditional `UPDATE otp_challenges
SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL` whose affected-row
count is the answer, inside the same transaction that issues the session. A
`SELECT` followed by an `UPDATE` is not a consume; it is a race with extra steps.

**Current mitigation:** the _error vocabulary_ is real. `SecurityError` has a
distinct `AlreadyRedeemed` variant, precisely so a replay is its own outcome
rather than another wrong code, and there is a comment saying single-use is the
property that makes a leaked OTP harmless. **The atomic consume is `DEFERRED`**,
and no OTP is issued or verified at all today.

**State:** `SCAFFOLDED` for the error; `DEFERRED` for the consume.

### 4. PKCE downgrade

**Asset:** #2, via an intercepted authorization code.

**The attack.** PKCE exists so that an intercepted authorization code is useless
without the verifier that only the client holds. The downgrade: an attacker
intercepts the redirect and re-issues the token request **without** a
`code_verifier`, or with one that does not match. If the server accepts a
`code_challenge_method` it did not require, or accepts a request with no
challenge at all for a client that registered one, the protection is gone while
both the client and the documentation still believe it is on.

The specific traps:

- **`plain` as an accepted method.** `plain` gives an attacker who can see the
  authorization request everything they need. `S256` is the only acceptable
  value.
- **Conditional PKCE.** If PKCE is required only for public clients, or only
  when the client "supports" it, the decision is made by the client — which is
  the party an attacker may be impersonating.
- **Per-request rather than per-client policy.** The requirement has to be a
  property of the client registration, decided at registration time, not a
  parameter of the authorization request.
- **Verifier comparison that is not constant-time.** A `==` on a secret is a
  timing oracle. This is banned by constraint 25.

**Current mitigation:** the _policy_ is real and partly enforced as data. The
crate exposes only `SUPPORTED_CODE_CHALLENGE_METHOD: "S256"`, the discovery
document advertises only `["S256"]` via
`code_challenge_methods_supported`, and there is a test asserting `plain` is not
advertised. `AuthorizationRequest::uses_supported_pkce()` is the helper the
authorization path will use. **The token endpoint does not exist**, and the
`PkceService` gate that will do the comparison is a trait with no body.

**State:** `SCAFFOLDED` for the policy; `DEFERRED` for enforcement.

### 5. Redirect-URI substitution

**Asset:** the authorization code, and therefore the session.

**The attack.** The authorization code is delivered to a `redirect_uri` the
client registered. If the server matches a _presented_ redirect URI loosely —
by prefix, by path glob, by host suffix, by "starts with the registered one" —
then a URI that passes the check is not the URI that was registered, and the code
goes somewhere the registrant did not choose. The classic form is
`https://app.example.com.attacker.test/`, which starts with the string
`https://app.example.com`.

Two adjacent variants worth naming:

- **Wildcard registration.** Registering `https://*.example.com/callback` and
  matching by suffix hands the code to any subdomain an attacker can get
  delegated, which is most of the interesting ones.
- **Open redirect composition.** Even with an exact match, if the registered URI
  itself contains a redirect parameter the server will follow, the exact match
  is not protection. A registered URI with a fragment is refused for exactly
  this family of reasons.

The mitigation is exact string equality against the registered set, and refusing
to register anything that is not absolute, is not `http://` or `https://`, or
carries a fragment. The reason the comparison must be exact and not "same origin"
is that same-origin matching permits path confusion, and same-_site_ matching
permits subdomain takeover.

**Current mitigation:** **real and tested.** `Application::add_redirect_uri`
enforces blank-check, 2048-byte limit, no fragment, absolute with an `http`/`https`
scheme, and no duplicates. `Application::allows_redirect_uri` is an exact
comparison over the registered set, with a comment naming the
`app.example.com.attacker.test` case. These are value-level rules and they are
enforced today, at construction, for any `Application` that exists. They are not
enforced against a _request_, because no request is served.

**State:** `IMPLEMENTED` for registration; `DEFERRED` for the request-time
check.

### 6. Privilege escalation through the self-service surface

**Asset:** #5 and #6; ultimately an administrator's authority.

**The attack.** The self-service surface is the largest anonymous-adjacent
attack surface in the system, because it is the only one where an authenticated
unprivileged user supplies input about _their own_ record, and the temptation
is to trust that "about their own record" is a safe assumption. Three concrete
escalations:

- **A mass-assignment on a profile update.** If `POST /api/account/profile`
  binds its body onto the `User` struct, a body containing `role` or
  `security_version` sets them. The field is public on the struct, so nothing
  about the type stops it. `UpdateProfile` exists as an input type with a
  specific set of fields, which is the mitigation's shape.
- **A role change through the account endpoint.** Same mechanism, aimed at
  `role`. The `RoleChange` rule refuses `SelfChange` before anything else, and
  there is a test for it — but that rule is in the _administration_ layer, and a
  self-service endpoint that reached it with the actor as the target would still
  be refused. The point is that the rule must be the _only_ path to a role
  change, not merely one path among several.
- **A session id from the body.** If `POST /api/sessions/revoke` takes a
  `session_id` from the request body, the check must be "this session belongs to
  the caller" and not "this session exists". The `SessionView` and
  `RevokeSession` types are shaped so that the operation names a session and the
  caller separately.

The general rule this document is asserting: **on the self-service surface, every
input is attacker-controlled, including the parts of it that look like the
caller's own data.** The caller's identity comes from the session, never from a
body, a header, or a path parameter.

**Current mitigation:** the _input types_ are real. `UpdateProfile`, `RevokeSession`,
`ChangeEmail` and their siblings are structs with named fields, and the
`no_account_command_carries_an_actor` test asserts that an account command has no
actor field at all — the actor comes from the session, structurally. **There is
no self-service HTTP endpoint yet**, so the runtime check is `DEFERRED`.

**State:** `SCAFFOLDED` for the shapes; `DEFERRED` for the endpoint.

### 7. What happens when the rate limiter is unavailable

**Asset:** #9, and transitively #2 and #3.

**The attack.** The rate limiter is a Workers binding, and a binding can fail: a
misconfigured namespace, an outage, a deploy with the binding missing. The
question the threat model must answer is what the login and verification paths do
when `RATE_LIMITER` throws, because the two answers have opposite outcomes:

- **Fail open:** the request proceeds. A limiter outage becomes a
  credential-stuffing window, and the attacker does not need to notice it — the
  absence of rate limiting is invisible to them.
- **Fail closed:** the request is refused. Every user is locked out during the
  outage, and the login endpoint is down. The attacker gains nothing and a support
  queue forms.

The answer here is **fail closed**, and it is not a judgement call: a login path
with no limiter is an open credential-stuffing target, and a locked-out user
complaining is a recoverable incident while a breached account is not.

The same applies to `ADMIN_RATE_LIMITER` on the admin surface, and it applies to
the `IDENTITY_KV` counters. A missing counter is a lost limit, not a bypassed
one — but the _decision_ to enforce must not depend on KV being readable, or
"read the counter" becomes the single point at which rate limiting fails open.

**Current mitigation:** the _vocabulary_ is real and unambiguous.
`SecurityError::RateLimiterUnavailable` exists, its doc comment says in as many
words that every implementation must fail closed here, its `code()` is
`temporarily_unavailable` rather than a security code, `is_client_safe()` is
`false` so the reason is never shown to a caller, and `merits_audit()` is `false`
because a limiter outage is not an attack. `is_client_safe()` being false is the
part that matters operationally: an outage is ours, and the reason string is for
our logs. `identity-cloudflare`'s `rate_limit` module now makes that decision
concrete — a missing binding or a failed platform call becomes
`RateLimiterUnavailable`, not a pass, and there is a test for the outage case.
**No endpoint uses it yet**: there is no binding wired into a Worker, and the
crate is mid-write and does not currently compile.

**State:** `SCAFFOLDED` for the vocabulary; `DEFERRED` for enforcement.

### 8. Queue poisoning (specific to this system)

**Asset:** #8, and the email addresses in it.

**The attack.** A message on `IDENTITY_QUEUE` causes an email to be sent to an
address the message names. Anyone who can publish to the queue can therefore use
the platform as a mail relay, and can produce a mail that appears to come from
the identity service — a security notice, a password reset. There is no
authentication step in the flow that would stop this, because the Jobs Worker
does not evaluate identity rules; that is [../architecture/jobs-isolation.md](../architecture/jobs-isolation.md).

The mitigation is at three points, and only the first exists: the publisher must
be the Identity Worker (a binding-level fact, `PLANNED`); the payload's email
address must be one the system actually holds for the user in question, not an
arbitrary string (requires the consumer to ask identity over the service binding
— `PLANNED`); and the rendered message must not be a path for content injection
(`DEFERRED`, and it is a template-escaping concern at minimum).

The residual risk that no mitigation removes: **a legitimate, correctly
constructed notification is still a notification an attacker can induce by
performing the underlying action.** That is inherent to any notification system
and is the reason the messages must be unambiguous about being automated.

**Current mitigation:** the event type's versioned name means a consumer refuses
a type it does not understand, which limits the blast radius of a _malformed_
message. Nothing addresses a _well-formed_ hostile one, because the threat is
upstream of the queue and the platform is not yet built.

**State:** `DEFERRED`.

### 9. Client-secret handling

**Asset:** #1.

**The attack surface** is not the hash, it is the lifecycle: issuance, storage,
rotation, and comparison. Four things go wrong, and only the last has a real
mitigation today.

- **Logging the secret at issue.** The one moment the plaintext exists. A secret
  that reaches a log is a secret in a log aggregator, in every backup of it, and
  in the access log of whoever can read logs.
- **A secret in a query string.** Client credentials in a `POST` body or an
  `Authorization` header are not in a URL. A URL is logged by the proxy, the
  Worker, and the browser.
- **Comparing with `==`.** A non-constant-time comparison of a secret is a
  timing oracle. Banned by constraint 25.
- **A weak or unsalted hash.** The `client_secret_hash` column must be a hash
  appropriate for a high-entropy random secret, not a bare fast hash. A
  high-entropy secret does not need a slow KDF — it needs a fast one, because
  the entropy is in the secret, not the password — but the choice is a decision
  with an ADR behind it.

**Current mitigation:** the _shape_ is real. `ClientSecret`'s `Debug` and
`Display` are redacted and a test asserts a secret cannot be printed; the only
accessor is `expose_for_hashing`, whose name reads as an instruction; and
`RotateClientSecretOutcome` carries the old secret's **expiry**, not the old
secret, so a rotation has a grace window without the old value ever being
re-obtainable. `ApplicationSecretRotated` is one of the 21 `AuditEventType`
values, so a rotation is auditable by design. **No secret is ever issued**, and
the hash function is `DEFERRED`.

**State:** `SCAFFOLDED` for the shape; `DEFERRED` for the lifecycle.

### 10. Administrator compromise, and the last-administrator rule

**Asset:** #5, #6, #7.

**The attack.** A compromised administrator session is the highest-value
compromise in the system, and the one most likely to be used to persist: bump
`security_version` to revoke the real administrators, then act. The defence is
the **last-administrator rule** — demoting or deactivating the final active
administrator is refused — plus the `security_version` bump as the recovery
lever.

The rule is genuinely subtle, and the reason is in the domain crate's own test:
it is not "an administrator may not be demoted". A second administrator may be
created and the first demoted normally. It is a **count check** against
`role = 'administrator' AND status = 'active'`, evaluated **inside the same
transaction** as the demotion. Two concurrent demotions that each observe two
administrators and both proceed leave zero, and a platform with zero
administrators is a platform that can only be recovered by direct database
access — which, by [../architecture/admin-isolation.md](../architecture/admin-isolation.md),
no other component is allowed to have.

The same rule must count only _active_ administrators: a suspended administrator
does not count toward the check, which is why `RoleChangeRequest` takes
`target_status` as an input rather than re-reading it.

**Current mitigation:** **the rule is real and fully tested.**
`RoleChangeRequest::evaluate` is a pure function with a typed outcome —
`Permitted`, `LastAdministrator`, `SelfChange`, `NotPermitted` — and there are
tests for each: a lone administrator may not be demoted, an administrator may be
demoted while another remains, demoting a non-administrator is never the
last-administrator case, a suspended administrator does not count, a non-administrator
actor is refused before the count is consulted, a user cannot change their own
role, self-change is reported before the last-administrator rule, and a service
actor may not assign roles. **The transaction that computes the count and applies
the change is `DEFERRED`**, and the domain crate's own ignored test says so.

**State:** `IMPLEMENTED` for the decision; `DEFERRED` for its transactional
enforcement.

## What is not in this document

- **Cloudflare account compromise.** Out of scope; a different trust model with
  different controls.
- **Availability and cost.** A queue loop and a full `IDENTITY_KV` are real
  problems, covered in [../operations/observability.md](../operations/observability.md)
  and [../architecture/event-model.md](../architecture/event-model.md).
- **Physical and supply-chain.** Not modelled.
- **Social engineering of an administrator.** The one mitigation that matters is
  the audit trail, covered in
  [../operations/observability.md](../operations/observability.md).

## Related

- [security-constraints.md](security-constraints.md) — the invariants a reviewer
  checks.
- [../architecture/trust-boundaries.md](../architecture/trust-boundaries.md) —
  the boundary map these attacks cross.
- [../architecture/admin-isolation.md](../architecture/admin-isolation.md) — the
  confused-deputy argument in full.
- [secrets-management.md](secrets-management.md) — where each asset above lives
  and how it is rotated.
