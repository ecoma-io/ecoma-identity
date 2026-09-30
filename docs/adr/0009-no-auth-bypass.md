# No authentication bypass in any environment

<!--
What this file is: ADR-0009, the record of why there is no dev-mode flag, no
environment variable, and no test-only role — and what local development does
instead, which is the same code path with real secrets.

What this file is **not**: a secrets-management plan (that is
`docs/security/secrets-management.md`) and not a testing strategy. This ADR
decides that there is exactly one behaviour of the authentication path, in every
environment, including the developer's laptop.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `docs/getting-started/local-development.md`, the
  gitignored `.dev.vars`
- **Constraints covered:** 6, 26, 27, 29

## Context

Constraint 26 is short and absolute: **no authentication bypass for development.**
Not a flag, not an env var, not a test-only role. Local development runs the same
code path with real secrets from `.dev.vars`, which is gitignored. Constraint 27
is its companion: no production secrets are committed, and `.env*` is gitignored
in favour of `.example` files.

This is a constraint with a well-known failure mode, and the failure is always the
same shape. Someone needs to work on a flow that requires a signed-in user. The
obstacle is that establishing one requires an email round trip, a real secret, or
an authenticator. The bypass is a flag — `DEV_AUTH=true`, `ENV=dev`, a
`bypass_auth` middleware, a `Role::Developer` that skips the check. It is written
in ten minutes, it works, and the flow gets built. Then the flag is still there,
and the next person adds `if cfg!(debug_assertions)` or a staging variant, and
within two deployments a path that skips authentication exists on the internet.

The reason the failure is so reliable is that the bypass _looks like a
development-only concern_, and the danger is not that it exists in development —
it is that a development-only concern is a production concern one merge away. The
cost of the bypass is paid later, by someone who did not know it was there, at the
moment they are reasoning about whether a particular request path is
authenticated. A flag named `DEV_AUTH` does not read as "this request is
unauthenticated" in a diff; it reads as "this is the dev path", and a reviewer
skims past the branch that is not compiled in production.

The concrete risk in this repository is unusually high, because the bypass would
be bypassable in the environments that matter. Identity is the authentication
service for the whole organisation. A code path that skips authentication in an
identity service is not "a debug feature"; it is a way to mint a session for any
account, and if it is reachable in staging it is one configuration change from
production. `docs/security/threat-model.md` treats a login path with no limiter as
an open credential-stuffing target; a login path with no _check_ is worse than
that, because it does not require guessing.

There is also a testing variant of the same trap. A test that needs a signed-in
user can either construct the state it needs (a session row, a `security_version`
match, a test user created through the real flow) or it can call a bypass. The
second is faster, and it produces a test that passes in a way that tells you
nothing about whether authentication works — because the thing under test was
removed. `identity-domain` already models the honest version of this
(`crates/identity-domain/src/invariants.rs`): invariant tests are written,
`#[ignore]`d with a named reason, and there is a task to run them ignoring the
ignore. A skipped test with a named reason says "this is not covered"; a test that
asserts the opposite of the rule, or asserts only what the types already
guarantee, would go green in CI and would read as "this is covered".

The middle ground people propose, and why it fails: "a bypass that is _only_
available in a local dev environment, guarded by an environment check". The
environment check is a config value, and a config value is one mistaken
deployment away from production. The only variable that cannot be misconfigured
is a variable that does not exist.

## Decision drivers

- An authentication bypass in an identity service is the worst defect class
  available, and its danger comes from its _latency_: it is introduced by
  someone with good intentions and discovered by someone else.
- The bypass must not exist in any form, in any environment, including tests, so
  that no path in the repository ever contains a branch that skips a check.
- Local development must be fast and must not require a third-party provider to
  be usable; the resolution is real secrets with local values, not fewer checks.
- Tests must exercise the real path, so that "this is covered" means something; a
  test that bypasses the thing under test proves nothing and reads as proof.
- Secrets must be gitignored, with `.example` files carrying the shape. The
  bypass rule and the secrets rule are the same rule seen from two sides: the
  developer's machine has real secrets and no shortcuts.

## Decision

**There is no authentication bypass in this repository — not a flag, not an
environment variable, not a middleware, not a test-only role, not a debug
`cfg`. The authentication path is the same code in every environment. Local
development runs that path with real secrets loaded from `.dev.vars`, which is
gitignored.**

From now on:

1. **No configuration value, in any environment, weakens an authentication or
   authorization check.** Not to "allow", not to "skip", not to "simulate", not to
   "bypass". If a check can be turned off, it will be.
2. **A test that needs a signed-in user constructs the state it needs through the
   real path** — a session row, a matching `security_version`, a test user created
   by the real flow — or it is `#[ignore]`d with a named reason. `identity-testkit`
   exists for exactly this: a test-only helper crate that may depend on anything
   and is never a production dependency. It builds fixtures; it does not bypass.
3. **The web apps have no dev-mode auth bypass either.** No button, no query
   parameter, no client-side shortcut. `AGENTS.md` states this in the TypeScript
   section, because a UI-level bypass is the same defect with a nicer affordance.
4. **Local development uses real secrets from `.dev.vars`,** gitignored, with
   `.example` files carrying the shape and never a value. `.dev.vars` holds
   secrets for the _development_ environment; a developer is not running the
   authentication path with no secrets, they are running it with their own.
5. **Third-party providers are deferred, not stubbed with a bypass.** The email
   provider is a `fetch` binding that is `DEFERRED`; a local developer without
   provider access does not get a fake "email sent" path that bypasses the
   challenge — they get a `DEFERRED` route that says so, which is the same honesty
   `Route::is_implemented()` encodes for the protocol surface
   ([ADR-0001](0001-rust-and-cloudflare-workers.md) and the bootstrap status in
   `docs/README.md`).
6. **When a developer needs a test user, the answer is a real one,** created
   through the real flow against the local database. If that is inconvenient, the
   inconvenience is a signal that the flow is hard to use, and the fix belongs in
   the flow. The escalation path for a genuinely blocked case is an ADR, not a
   flag.

**Enforcement:**

| Boundary                                        | Enforced by                                                                                                                                                                                                                                                       | Exists today                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No configuration value weakens a check          | `tooling/scripts/check-architecture.mjs`'s `no-auth-bypass`, which scans source, manifests and scripts outside tests, the testkit, a canary fixture and documents for a bypass token (`dev_auth_bypass`, `skip_auth`, `mock_user`, `insecure`, `DISABLE_AUTH`, …) | Yes. I ran the script on this tree and `no-auth-bypass` reported `ok` with 0 violations. Its own `doesNotCatch` clause is the honest limit: a bypass spelled with a name not on that list is a list change, not a mechanism change, and a Rust `#[cfg(feature)]` whose feature name is not a listed token is not seen                                                                    |
| No secret in a tracked file                     | `.gitignore` covering `.dev.vars` and `.env*`, with `.example` files; the architecture script's `no-committed-secrets`, which reads the git index rather than the working tree                                                                                    | Partially. The root `.gitignore` exists, and I have read the check's entry in the `CHECKS` array: it fails on a tracked `.dev.vars`, a tracked non-`.example` `.env`, and tracked `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.keystore`. I have **not** been able to observe it passing — on this tree it reports `SKIPPED`, because the repository has no commits and the index is empty |
| The web apps have no bypass                     | `AGENTS.md`'s TypeScript section: "There is no dev-mode auth bypass anywhere, including in the UI"; the same `no-auth-bypass` check over `apps/*/web/**`                                                                                                          | Yes for the tree as it stands — the script's scan includes the web apps and found nothing. The apps' _authentication behaviour_ is `DEFERRED`, and nothing here claims otherwise                                                                                                                                                                                                         |
| Tests exercise the real path or say they do not | `identity-testkit` is a test-only helper that may depend on anything and is never a production dependency; the `#[ignore]`d invariant skeletons with named reasons in `identity-domain`; a test task that fails a suite running zero tests                        | Yes — the crate, the mechanism, and the documented rule exist                                                                                                                                                                                                                                                                                                                            |
| The development secrets flow                    | `docs/getting-started/local-development.md` documents the `.dev.vars` shape; `infra/cloudflare/development/.dev.vars.example` is the committed example the local server reads                                                                                     | The example file exists. I have not read `docs/getting-started/local-development.md`, so this cell does not claim what it says — reference it as a path                                                                                                                                                                                                                                  |

## Consequences

### Easier

- **One behaviour to reason about.** Every environment runs the same path, so
  "does this work in production" and "does this work on my machine" are the same
  question, and a bug cannot hide in one.
- **A review of the authentication path is complete.** There is no second path
  that has to be checked for the same guarantee, so a reviewer reads one flow.
- **The staging environment is a real rehearsal.** It exercises the real
  authentication path, so a deployment that works in staging is a deployment that
  works in production, which is what
  [ADR-0014](0014-canary-promotion-identity.md)'s canary assumes.
- **Tests mean something.** A passing test exercised the real path, so "this is
  covered" is a statement about code rather than about a stub.
- **Secrets are handled once.** `.dev.vars` gitignored, `.example` files
  committed, no exceptions to remember, no "I put it in the wrangler config just
  for this environment" ([ADR-0001](0001-rust-and-cloudflare-workers.md)'s
  manifest discipline applies to secrets too).

### Harder or more expensive

- **Building a flow is slower.** To work on a signed-in feature, a developer sets
  up `.dev.vars`, points at a local database, and creates a user through the real
  flow. That is more than flipping a flag, and it will be the most complained-about
  consequence of this ADR.
- **Tests need fixtures.** A signed-in test needs a session and a
  `security_version` that matches, built through `identity-testkit`. That is more
  setup than calling a bypass, and the setup has to be right for the test to mean
  anything.
- **Some tests will be harder to write and some will be `#[ignore]`d.** The honest
  encoding of "this is not implemented yet" is a skipped test with a reason
  ([ADR-0001](0001-rust-and-cloudflare-workers.md)'s honesty rule), and a skipped
  test is less satisfying than a passing one. The `test-invariants` task is how
  the satisfaction is recovered.
- **The first developer to hit this will propose a flag**, and the conversation
  will happen more than once. The answer is this ADR.
- **A real third-party provider may be needed to do real work.** Sending an email
  from a laptop needs provider access or a local stand-in that is _itself_ a real
  SMTP sink, not a bypass. That is a dependency, and it is a deliberate one.

### What a future maintainer will resent

- **The friction at the start of every new feature branch.** Setting up `.dev.vars`
  and a local database to see a signed-in screen, when a flag would take a minute.
  This is the cost, it is the correct cost, and it is the thing that will be
  proposed as an exception.
- **The occasional test that is `#[ignore]`d rather than green.** A skipped test is
  honest, and a green test that asserts the opposite of the rule is a lie that
  costs a debugging session later. The resentment is real and the choice stands.
- **"How do I test the failure path?"** is a question with no bypass answer. The
  answer is a fixture in the wrong state, and if that is hard, the fixture builder
  needs work — which is a real task in `identity-testkit`.

## Alternatives considered

### A `DEV_AUTH` environment variable, off by default

**Rejected**, and it is the alternative that will be proposed most often, so it
is worth being specific. An environment variable is a config value, and a config
value is one mistaken deployment away from production; the environment is a
runtime decision, and the _right_ environment is often the one under time pressure.
The variable also appears in a diff as a line in a config file rather than as a
branch in the authentication path, so a reviewer does not see it as
"this request is unauthenticated". And the moment it exists, the second thing
exists — a staging-only variant, a "temporary" production enable during an
incident, a `*_AUTH_BYPASS` for one specific service. The constraint is absolute
because the failure mode is not the flag but the negotiation that follows the
flag.

### A `Role::Developer` that skips the check for one account

**Rejected.** It is worse than a flag, because it is a _role_, and roles are
legitimate. A developer role that skips authentication is a role that
authentication does not apply to, which is a role that can be granted to a real
account, which is a backdoor with an audit trail. It also violates
[ADR-0005](0005-no-business-authorization.md)'s sibling rule that
`PlatformRole` describes account administration and nothing else — this role
would be about access to the authentication system itself, which is a different
kind of authority and the one place Identity must not have a shortcut.

### A test-only middleware compiled in under `cfg(test)`

**Rejected.** It is narrower than a flag and still wrong, for a reason that has
nothing to do with production: a test that runs with authentication removed is a
test that cannot fail on the thing it is about. It also tends to leak — the
middleware becomes a helper that integration tests use, then a fixture that
`identity-testkit` exposes, then something a developer wires into `wrangler dev`
because it is right there. The honest alternative — construct the state, or
`#[ignore]` the test with a reason — is already the mechanism
(`crates/identity-domain/src/invariants.rs`), and it is better because a skipped
test is visible.

### `wrangler dev --local` with a local D1 seeded with a test user, and no bypass

**Accepted in spirit; this is the decision.** The developer's local environment
has real secrets, a real (local) database, and real sessions. Nothing is skipped;
only the third-party dependencies are local. This is not an alternative to the
decision, it is the decision.

### A separate "insecure" build of the Identity Worker, deployed only to a personal

Cloudflare account

**Rejected.** It is a bypass with a deployment story, and the deployment story is
where it goes wrong: a personal account, a different account id, a wrangler profile
that is the wrong one. It is also more work than a local environment and gives a
developer a _remote_ identity service holding real sessions, which is a worse
place to be experimenting with an authentication flow than a laptop.

## Revisit when

- **A flow becomes genuinely impossible to develop against** without a shortcut,
  after the fixture path has been tried and is not sufficient. This is the honest
  version of the condition and the answer is still not a flag: it is a `DEFERRED`
  route that says the behaviour does not exist
  ([ADR-0001](0001-rust-and-cloudflare-workers.md)'s honesty rule), or an ADR.
- **The platform provides a first-class, _unforgeable_ local identity** for
  Workers development — something that cannot be enabled in production by
  construction. That is the only shape of a bypass that would be safe, and it would
  be a platform capability rather than a configuration value. Until it exists, the
  answer stands.
- **CI needs to run an end-to-end test that requires an authenticated session.**
  The answer is a real user against a real local environment in CI, created
  through the real flow. If that proves too slow, the fix is a faster fixture
  builder, not a bypass.
- **A test-only role becomes genuinely necessary** for a test that is about role
  behaviour. The answer is a role in the _test fixture_ — a user created with that
  role in a test database — not a role that skips a check. That distinction is the
  whole reason this rule is stated as absolute.

## Related

- [ADR-0008 — WebCrypto only; no self-implemented cryptography](0008-webcrypto-only.md)
  — the other absolute "no shortcut" law, and why "just a test key" is not an option
- [ADR-0005 — Identity holds no business authorization](0005-no-business-authorization.md)
  — why there is no developer role with extra authority
- [ADR-0010 — Sessions are server-side records, not tokens](0010-server-side-sessions.md)
  — sessions are real server-side rows, so a test user is a real row and a bypass
  is not needed
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — staging is a real rehearsal because there is no dev-only path to be stale
- `AGENTS.md` — the Prohibited shortcuts section, and the TypeScript rule about no UI bypass
- `docs/security/threat-model.md` — why an unlimitable, unchecked login path is the worst target
- `docs/getting-started/local-development.md` — the `.dev.vars` flow this ADR commits to
