# Sessions are server-side records, not tokens

<!--
What this file is: ADR-0010, the record of why a session is a row and the
credential is a reference to it, and of the `security_version` counter that makes
account-wide revocation O(1).

What this file is **not**: a session schema, a cookie specification, or a token
format. This ADR decides what a session *is*, and the honesty cost that decision
carries.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `crates/identity-domain/src/session.rs`,
  `crates/identity-domain/src/security.rs`
- **Constraints covered:** 6, 5, 25, 29

## Context

A session is the fact that some request is being made by a proven user. The
question this ADR answers is where that fact lives: in a credential the client
carries, or in a record the server holds.

`crates/identity-domain/src/session.rs` states the decision in its module
documentation, and the framing is the important part: "a session is a
server-side record, not a token. The token that references it (a cookie, a bearer
credential) is transport; this is the state the transport is checked against.
Keeping the two apart is what makes 'revoke this session' instant and total rather
than eventual."

The alternative — a self-contained, signed session token — is the common design,
and its properties are what the constraints rule out. A signed token is valid
until it expires, and nothing the server can say in between changes that: a
revocation list is a list the server maintains for exactly the tokens it cannot
stop using, and a client that does not check it is still authenticated. Logout is
therefore _eventual_ — it takes effect when the token expires, or when the client
next checks, or never. A compromised session cannot be cut off; the account owner
is relying on a window measured in hours, and a session that was stolen is a
session that keeps working for the length of the window.

That window is the whole problem. In an identity system, "I logged out and it is
still working" and "someone else is logged in as me" are the same defect, and the
window during which they are the same defect is the one that matters.

The constraints make the decision rather than merely favour it:

- **No self-implemented cryptography**
  ([ADR-0008](0008-webcrypto-only.md)) means a self-contained token is signed with
  WebCrypto primitives and validated by every client — which is
  [ADR-0005](0005-no-business-authorization.md)'s reason for opaque tokens: a
  claim set that clients interpret is a contract with every client at once, with no
  deprecation path.
- **No business authorization** means the token's claims cannot be a permission
  answer, so a token that a client validates is a client that has been given a
  rule to enforce. A session token should carry an _identifier_, and the only
  thing that should know what an identifier means is the thing that issued it.
- **No authentication bypass**
  ([ADR-0009](0009-no-auth-bypass.md)) means a dev session must be a real row, and
  a row is a thing the local database has. A token-shaped dev session would be
  exactly the bypass that ADR forbids.

The second half of the decision is the part that is easy to get wrong.
"Sessions are server-side records" alone gives per-session revocation, which is
necessary and not sufficient. The trigger for account-wide revocation is a
_suspected compromise_, and the operation an operator actually needs at that
moment is "kill everything for this account", not "find the session and kill it".
Enumerating sessions to revoke them is O(n) at the worst possible time, it races
with new sessions being created, and it is a loop that has to be correct under
concurrency.

`SecurityVersion` in `crates/identity-domain/src/security.rs` is the answer, and
its documentation states the design: it is "the account-wide counter that
invalidates stale sessions", stored on the user, with every session recording the
value in force when it was issued. "A request whose session's value is behind the
user's is refused without the server enumerating or touching that session at all.
Bumping the user's counter is therefore 'revoke every session' — O(1) rather than
O(n), which matters when the trigger is a suspected compromise."

The `bumped()` method is worth reading as a design document: it uses
`checked_add` and returns a `DomainError` on exhaustion, with the comment that
saturating instead "would make the bump a silent no-op that _looks_ like it
revoked every session and did not — the worst possible failure for this type." A
security control that silently stops working when a counter reaches its maximum is
worse than one that fails loudly, and this is the small piece of code where that
decision is recorded.

The `SessionStatus` enum is the other half: `Active`, `Revoked`, `Expired`, with
`Revoked` kept distinct from `Expired` "so that 'this credential was revoked' is
answerable, and so replaying it is _refused_ rather than being mistaken for a
session that never existed". Both non-`Active` states fail
`permits_authentication`, so the distinction is for reporting and not for the
access decision — which is the correct place to put it.

## Decision drivers

- Revocation must be immediate and total, not eventual. "Log out everywhere" that
  takes effect when a token expires is not logout.
- Account-wide revocation must be O(1) and must not race with session creation.
  The trigger is a suspected compromise, which is the worst time for an O(n) loop
  that has to be correct under concurrency.
- A session's meaning must be known to exactly one component, the one that issued
  it. A claim set a client validates is a contract with every client
  ([ADR-0005](0005-no-business-authorization.md)) and a deprecation problem.
- Revocation must be answerable: an administrator has to be able to say "this
  credential was revoked", which means the record survives revocation.
- A replayed revoked credential must be _refused_, not mistaken for one that never
  existed, or an attacker learns something from the difference.
- A dev session must be a real row, because there is no bypass
  ([ADR-0009](0009-no-auth-bypass.md)).

## Decision

**A session is a server-side record. The credential a client carries — a cookie or
a bearer token — is transport: an opaque reference to that record, checked against
it on every authenticated request. The Identity Worker is the only component that
interprets what a session reference means. Account-wide invalidation is a
`security_version` counter on the user, and bumping it invalidates every session
issued under the previous value, in O(1), without enumerating them.**

From now on:

1. **A session reference carries an identifier and nothing else.** No claims about
   the user, no role, no scope, no AAL, no expiry that the server treats as
   authoritative. The server looks the session up and decides.
2. **The session record is authoritative for `status`.** `Active` authenticates;
   `Revoked` and `Expired` do not, and both are retained so that revocation is
   answerable and a replayed revoked credential is refused rather than treated as
   unknown.
3. **The session records the `security_version` in force when it was issued.**
   A request whose session's value is behind the user's is refused, and the
   refusal does not touch the session. A stale session is not deleted; it is
   refused.
4. **Bumping the user's `security_version` is "revoke every session."** It is the
   operation an operator performs on a suspected compromise, it is O(1), and it
   does not depend on enumerating or locking the session set. It is the only
   account-wide revocation mechanism; there is no bulk-delete path as an
   alternative.
5. **`SecurityVersion::bumped()` fails rather than saturating.** Counter exhaustion
   is an error that names the migration it requires, never a silent no-op. A
   security control that looks like it worked and did not is the worst outcome
   this system has, and the type is where that is decided.
6. **The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`,** and no token ever
   reaches `localStorage` or readable JavaScript. Every authenticated call is a
   `credentials: "include"` fetch, and CSRF protection belongs to the server.
   `AGENTS.md` states this for the TypeScript side; it is a property of the design,
   not a frontend convention.
7. **A session reference is `HttpOnly` transport, so the "which session is this
   browser" question is a server-side one.** The web app never holds a token it
   can read, and the admin console's session is the Admin Worker's own session, not
   an identity session ([ADR-0004](0004-admin-worker-holds-no-database.md)).

**Enforcement:**

| Boundary                                            | Enforced by                                                                                                                                                                                                                                             | Exists today                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A stale `security_version` invalidates its sessions | `SecurityVersion` in `crates/identity-domain/src/security.rs`; `SessionStatus::permits_authentication` in `session.rs`; the invariant "A stale `security_version` invalidates its sessions" is listed in `invariants.rs` with its enforcing layer named | Types and the comparison yes; the request-path check that joins them is `DEFERRED` to the sessions phase     |
| Bumping fails rather than saturating                | `SecurityVersion::bumped`, which returns a `DomainError` on `u32::MAX` exhaustion and says so in the error's reason                                                                                                                                     | Yes — a real method, tested                                                                                  |
| A revoked session cannot authenticate               | `SessionStatus::permits_authentication` returns true only for `Active`; the invariant "A revoked session cannot authenticate" is listed in `invariants.rs`                                                                                              | Yes — the type enforces it; the application-layer check that consults it is `DEFERRED`                       |
| AAL ordering                                        | `Aal::satisfies` is a total comparison with the direction in the parameter names, tested in `crates/identity-security`                                                                                                                                  | Yes                                                                                                          |
| No session claims a role or a scope                 | `TokenResponse.access_token` is documented as opaque precisely so no client interprets claims; `SessionStatus` carries no payload                                                                                                                       | Types yes; the OIDC bodies are `DEFERRED` to the authentication phase                                        |
| No token in `localStorage` or readable JS           | `AGENTS.md`'s TypeScript conventions; reviewable as "no `localStorage.setItem('token'…)` anywhere in `apps/*/web/**`"                                                                                                                                   | **Enforcement not yet built**; the apps are `DEFERRED` and the rule is a named convention plus a review rule |
| A dev session is a real row                         | [ADR-0009](0009-no-auth-bypass.md); `identity-testkit` builds fixtures, never bypasses                                                                                                                                                                  | Yes — the mechanism                                                                                          |

## Consequences

### Easier

- **Revocation is immediate.** Logout, "sign out everywhere", a moderator
  suspending an account, an administrator bumping `security_version` after a
  suspected compromise — all of them take effect on the next request. There is no
  window in which a revoked credential still works.
- **Account-wide revocation is one integer.** "Revoke everything for this account"
  is `users.security_version = users.security_version + 1`. No enumeration, no
  loop, no lock on the session set, no race with a session being created
  concurrently. The operation is safe to perform at 3am under the assumption that
  the caller is panicking.
- **The credential is opaque, so the meaning lives in one place.** The Identity
  Worker is the only thing that knows what a session reference means, and a
  change to the session model does not break every client
  ([ADR-0005](0005-no-business-authorization.md)).
- **Revocation is answerable.** Because `Revoked` is a distinct retained state, an
  administrator can say "this credential was revoked at this time", and a replayed
  revoked credential is refused rather than mistaken for one that never existed.
- **A dev session is just a row.** Local development and tests create sessions
  through the real path, which is what makes
  [ADR-0009](0009-no-auth-bypass.md)'s no-bypass rule workable rather than
  merely strict.
- **The cookie discipline falls out of the design.** An opaque `HttpOnly` cookie
  means an XSS in a web app is not automatically a session theft, which removes a
  whole class of frontend concern.

### Harder or more expensive

- **Every authenticated request costs a lookup.** A session reference is checked
  against a record, so there is no "validate the signature and proceed" fast path.
  For an organisation's request volume that is a non-issue; for a high-traffic
  endpoint it is the reason an edge cache or a rate limit is in front of it rather
  than after it.
- **The frontend cannot see who it is.** With an `HttpOnly` cookie, the web app
  cannot read the session, so "who am I" is a request. That is a round trip on
  page load, and it is the cost of not having the token in readable JavaScript.
- **`security_version` is a second thing to keep correct.** A session's
  `security_version` must be written at issuance and compared on every
  authenticated request, and a bug that writes the _current_ value at
  authentication time rather than at issuance would defeat the whole mechanism
  silently. The invariant skeleton in `invariants.rs` exists for this rule and is
  `#[ignore]`d.
- **A stale session is refused, not deleted.** That is correct for
  answerability, and it means a user who has been "logged out everywhere" may see
  rows for sessions that are refused rather than gone. A support question about
  "why is this still here" is answered by the status, and the UI has to show it.
- **More rows.** Server-side sessions are a table with retention and growth. A token
  has no storage. Retention is a correctness parameter in one direction (a session
  row's absence is indistinguishable from a revoked one, which is exactly why
  `Revoked` is retained) and a housekeeping one in the other.

### What a future maintainer will resent

- **"The JWT would avoid the lookup."** It would, and it would also make
  revocation eventual ([ADR-0005](0005-no-business-authorization.md) and
  [ADR-0008](0008-webcrypto-only.md) both explain why the tokens are opaque). The
  sentence will arrive with a latency measurement attached, and the measurement
  will be real; the answer is that the window of a revocable session is the thing
  being bought.
- **The "who am I" round trip in the web app**, and the temptation to put a token
  in `localStorage` to avoid it. That is the one shortcut in this ADR that is both
  easy and catastrophic, and it is worth naming every time it appears.
- **A security event that wants to revoke one session, where the operator reaches
  for `security_version` because it is the easy path.** Bumping the counter
  revokes _every_ session, which is almost always what a security event wants and
  occasionally not. The per-session path exists; it is just less interesting.

## Alternatives considered

### Self-contained signed session tokens (JWT) with a short lifetime

**Rejected**, and it is the standard choice, and its appeal is real: no lookup per
request, horizontal scale for free, and the session store is small. It loses on
the one property this ADR is about. A signed token is valid until it expires, and
nothing in the meantime makes it invalid, so "revoke this session" becomes "wait".
A revocation list is the honest version and it is a list the server maintains for
the tokens it cannot stop, checked by clients that may not check it. A short
lifetime makes the window small; it does not close it, and it trades the window for
re-authentication frequency, which is a user-visible cost to mitigate a
correctness problem.

It also fails [ADR-0005](0005-no-business-authorization.md) independently: a claim
set a client validates is a contract with every client simultaneously, and the
claims in it are authorization-shaped whether or not anyone says so. And
[ADR-0008](0008-webcrypto-only.md) means the signature is WebCrypto, validated by
each client separately — N interpretations of one token format.

### Opaque tokens with a revocation list, without a session record

**Rejected** as a half-measure. It fixes the client-interpretation problem
(opaque, good) and keeps a server-side list, which reintroduces the store without
the record: the list is a second structure, the "is this revoked" check is the
same lookup, and the list needs its own retention and its own answer to "was this
ever revoked". A session record _is_ the list, with the status, the actor, the
assurance level and the timestamps already in it.

### Server-side sessions with account-wide revocation by enumerating and deleting

**Rejected**, and this is the tempting simplification. It produces the same
observable outcome in the simple case and is wrong in the ones that matter. It is
O(n) at the moment of a suspected compromise, which is the moment the operator
wants it to be instant; it races with session creation, so a session created
during the sweep survives an operation that was supposed to end "every session";
and it destroys the answerability that retaining a `Revoked` row provides. A
counter is one integer, has no race, and refuses rather than saturates
(`SecurityVersion::bumped`).

### `security_version` compared as a timestamp

**Rejected**, and `SecurityVersion`'s documentation rejects it explicitly: "It is
a plain `u32` wrapped in a newtype, not a timestamp: ordering is all that is
needed, and a timestamp would invite someone to compare it to a clock and reason
about skew." A clock comparison in a revocation check is a bug waiting for a DST
change, a NTP correction, or a device with a wrong time.

## Revisit when

- **The per-request session lookup becomes a measured bottleneck** — observable as
  the Identity Worker's database latency dominating authenticated request latency
  under the organisation's own load, not under a synthetic one. The answer is a
  cache or a read replica with an explicit staleness bound
  ([ADR-0003](0003-identity-d1-single-owner.md)'s revisit conditions), not a
  self-contained token.
- **A session reference is needed somewhere that cannot reach the Identity
  Worker** — a webhook that must verify a request came from identity, or a
  third-party that must call a callback. That is a _different_ credential (a
  signing key, an mTLS assertion), not a session, and it is a new question for
  `identity-security`'s gate list
  ([ADR-0008](0008-webcrypto-only.md)) rather than a change to this ADR.
- **A requirement appears for "stay signed in for 30 days with no re-auth".**
  That is a long-lived refresh credential, and it is a session-shaped question:
  whether it is a session with a long expiry and a `security_version` check (this
  ADR already answers it) or a separate token (a new ADR). The default answer is
  the first.
- **Session volume makes the retention policy a correctness problem** — e.g. a
  replayed credential whose row has been cleaned up is now indistinguishable from
  one that never existed, which is the confusion `Revoked` was retained to avoid.
  At that point the record needs a tombstone rather than a deletion, and this ADR
  should be amended to say so.
- **The `u32` counter becomes a practical concern.** It will not — a `u32` is four
  billion bumps — but `bumped()` already names the migration it requires on
  exhaustion, and that is the right shape for the day.

## Related

- [ADR-0005 — Identity holds no business authorization](0005-no-business-authorization.md)
  — why the access token is opaque and no client interprets a claim
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — the Jobs Worker's platform service identity acts on its own behalf and holds
  no session
- [ADR-0007 — The outbox pattern and the absence of atomicity](0007-outbox-pattern.md)
  — the other decision touching the same idempotency and session machinery, deliberately
  cross-linked
- [ADR-0008 — WebCrypto only; no self-implemented cryptography](0008-webcrypto-only.md)
  — why a self-contained token would be signed with a primitive from the platform
  and validated by every client
- [ADR-0009 — No authentication bypass in any environment](0009-no-auth-bypass.md)
  — why a dev session is a real row
- `crates/identity-domain/src/session.rs` — `Session`, `SessionStatus`, and the
  "server-side record, not a token" framing in the module docs
- `crates/identity-domain/src/security.rs` — `SecurityVersion`, `Aal`, and the
  O(1) revocation argument in the module docs
- `crates/identity-domain/src/invariants.rs` — the two session-related invariant skeletons
- `docs/security/security-constraints.md` — the non-negotiable rules this ADR's
  decision produces
