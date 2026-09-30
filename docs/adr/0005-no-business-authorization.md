# Identity holds no business authorization

<!--
What this file is: ADR-0005, the record of the line between *who is this request
made by* and *what they may do in a business system*, and of why the answer is
that the second question is never answered here.

What this file is **not**: a role design, a scope design, or a plan for how other
repositories will do authorization. This ADR decides what this repository refuses
to know, and the enforcement for that refusal.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `PlatformRole` in `crates/identity-domain/src/user.rs`,
  the `TokenResponse` shape in `crates/identity-oidc/src/response.rs`
- **Constraints covered:** 6, 28, 29

## Context

This repository answers exactly one question for every other Ecoma repository:
_who is this request made by?_ It owns users, identities, sessions,
authenticators and OAuth applications, and it is the only thing in the
organisation that can establish that a request came from a person who proved
something.

What it does **not** do is decide what that person may do. In Archkeep, in Loom,
in Release Craft and in Action Agents, permissions are a function of that
system's own data: which repositories a user administers, which modules a change
touches, which release a version belongs to, which issues are assigned. None of
that exists here, and none of it could be kept here correctly, because it changes
in those repositories and Identity would need a schema, an admin surface and a
migration for a concept it does not own.

The type system already encodes this. `PlatformRole` in
`crates/identity-domain/src/user.rs` has four variants — `Member`, `Support`,
`Administrator`, and a non-human service identity — and its documentation says
precisely what it is for: _"A role here says what an administrator may do to
accounts — it is never consulted to decide whether a user may, say, merge a pull
request in another Ecoma repository."_ An `Application` is an OAuth client plus
the policy around it, and its documentation says it is _not_ an Ecoma
organisation: "registering an application here says nothing about what that
application's users may do inside it."

The same reasoning reaches the token shape. The access token in
`crates/identity-oidc/src/response.rs` is opaque to the client in this design,
with the reason recorded in the field's own documentation: a JWT "would leak
claims to anything that can read it and would be validated by every client
separately." That is the business-authorization rule showing up at the wire: a
signed claim is a promise a client might treat as an authorization answer, and
each client would end up implementing its own claim interpretation — which is the
distribution problem this ADR exists to prevent.

There is also a scaling argument that is not about correctness. Identity is an
organisation-wide dependency. Every repository in Ecoma authenticates through it.
If it also answered authorization, then every authorization decision in the
organisation would be a request to the one service that holds every credential,
which would make it simultaneously the highest-availability requirement and the
highest-blast-radius service — for decisions it cannot possibly make correctly,
because the data lives elsewhere. The same coupling already produced one
non-negotiable: identity and that service share no release.

The rule is a _negative_, and negatives in a shared library are the ones that
erode. A field added here for one consumer, then another, then a general
permissions table, then a per-application role — each step is locally reasonable
and the aggregate is a distributed authorization service that four products now
depend on for decisions made from stale data. Nothing in a code review catches
that step, because each step is small.

## Decision drivers

- Identity is an organisation-wide dependency. Its coupling and its blast radius
  must not grow beyond _authentication_.
- The data that answers every real authorization question lives in the business
  system, and only there can it be kept current.
- A role or claim that a client may interpret becomes a contract with every
  client simultaneously, with no deprecation path that does not break production.
- The enforcement must be a thing a script can check, because a negative
  enforced only by a convention is a negative that erodes.
- This repository must not accumulate another product's data model — constraint 28
  makes that a hard rule, and "a permissions table for Archkeep" is exactly that
  failure in miniature.

## Decision

**Ecoma Identity decides who a request is made by and nothing else. A role in
this repository says what an _administrator may do to an account_; it is never
consulted about what a user may do in a business system.**

From now on:

1. **`PlatformRole` describes account administration only.** Its four values
   answer "may this administrator inspect, moderate, or change the role of
   another account". They are not permissions, they are not groups, and they are
   not consumable by another system.
2. **No repository, organisation, team, or permission from another Ecoma
   repository is stored, mirrored, or modelled here.** Not as a column, not as a
   role, not as a claim, not as a cache.
3. **OAuth scopes are about the identity API, not about the business system.**
   A scope says which identity data a client may read and which identity
   operations it may invoke on the user's behalf. It is never a business
   permission, and a client that needs one asks the business system.
4. **Access tokens stay opaque to the client.** The Identity Worker is the only
   thing that interprets what a token means, because the Identity Worker is the
   only thing that knows which of its own operations the token authorizes. A
   self-contained token that a client validates is a decision pushed out to every
   client, and it is not a decision this platform is making.
5. **A request that arrives from a business system carrying an identity claim is
   checked against identity's own records, not accepted on the caller's word.**
   The same rule that appears in
   [ADR-0004](0004-admin-worker-holds-no-database.md) for the Admin Worker's
   actor identity applies here to every internal caller: a service binding
   authenticates the _Worker_, not the _user_.
6. **A request for a business permission is a request for a feature in the system
   that owns the data.** The answer in this repository is the same as the answer
   for a report that needs D1: an escalation path through an ADR, not a field.

**Enforcement:**

| Boundary                                                                                                  | Enforced by                                                                                                                                                                                                                                                 | Exists today                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlatformRole`'s variants are account-administration only, and no business vocabulary exists in the model | The `identity-domain` type and its documentation; the crate has no module, type or field naming another Ecoma repository, and `missing_docs` is denied at the crate root so the boundary is stated where the type is                                        | Yes — types and docs exist, and `pnpm arch`'s `boundary-4-no-frontend-in-backend` reported `ok` with 0 violations when I ran it on this tree. The vocabulary half is reviewable rather than mechanical: a check cannot tell a business noun from a domain noun, it can only report the words it knows |
| No other Ecoma repository's source lives in this monorepo (constraint 28)                                 | `tooling/scripts/check-architecture.mjs`'s `monorepo-self-contained`, which walks the tree for a path segment naming another Ecoma repository; plus `.moon/workspace.yml`'s explicit project map with no globs, so a new project must be added deliberately | Yes. I ran the script on this tree and `monorepo-self-contained` reported `ok` with 0 violations. Its own `doesNotCatch` clause is the honest limit: another repository's source vendored under a neutral directory name is not a path this check can recognise                                       |
| No business permission reaches a token or a claim                                                         | The `TokenResponse` shape in `identity-oidc` (opaque access token, scopes documented as identity-API scopes) and the `DiscoveryDocument` in `identity-oidc`, whose fields are promises the provider will keep                                               | Yes — the shapes exist; the _bodies_ are `DEFERRED` to the authentication phase                                                                                                                                                                                                                       |
| A business permission request does not become a new field here                                            | Process: it becomes an ADR if it changes a constraint, and the escalation path in [ADR-0004](0004-admin-worker-holds-no-database.md) if it is a new read                                                                                                    | Process                                                                                                                                                                                                                                                                                               |

## Consequences

### Easier

- **Other repositories keep their own permission models, which they can keep
  current.** Archkeep knows which repositories a user administers because that
  is Archkeep's data. No synchronisation, no cache invalidation, no "the
  directory is stale" bug.
- **The API surface stays small and identity-shaped.** Tokens, sessions,
  applications, OIDC. Not a permissions model, not a role hierarchy, not a group
  tree — none of which Identity could keep correct anyway.
- **Blast radius stops growing.** A compromise of Identity is a compromise of
  authentication: an attacker can mint tokens for accounts. It is _not_ a
  compromise of every authorization decision in the organisation, because those
  decisions were never made here.
- **Clients cannot accidentally become authorization clients.** An opaque token
  means a consuming service has exactly one way to learn about a user: ask
  identity, and accept identity's answer about _who_, not about _what_.
- **The `Application` type stays honest.** Registering an OAuth client here is a
  protocol fact, not a tenancy fact, and the documentation says so at the type.

### Harder or more expensive

- **Every business system has to implement its own authorization.** Four
  systems, four models, four places to get it wrong. There is no central place to
  fix a permission bug, and no "list all administrators of X" query that
  Identity can answer.
- **A user who is an administrator here is not an administrator there, and the
  distinction has to be explainable in a support conversation.** "You are an
  administrator of accounts, not of Archkeep" is a sentence that will have to be
  said more than once.
- **More round trips.** A business system authenticates against Identity and then
  decides authorization from its own data; some flows that a single combined
  answer would have served now take two steps. This is the cost of not being a
  single point of truth for permissions, and it is a cost paid in latency and
  complexity, not in correctness.
- **A tempting, small feature request.** "Just add a `can_merge_prs` flag" is
  one field, it is one field _per system_, and the third one is a permissions
  engine. There is no code-review signal for the third one, which is why the
  enforcement is a named negative in an ADR rather than a convention in a
  style guide.

### What a future maintainer will resent

- **The requests will keep arriving, and they will be reasonable.** "Loom needs
  to know if this user is a maintainer" is a real need with a real user, and the
  answer here is always "that is Loom's data". Expect this to feel like a wall
  more than once, and expect the wall to be right.
- **The absence of a central role will be cited as a limitation in comparisons
  with other identity providers**, which ship group and role sync. It is a
  limitation, and it is the limitation that keeps four products from depending on
  this one's availability for every request.
- **The temptation to make the service-identity variant of `PlatformRole` the
  general "machine user" answer.** It exists for the Jobs Worker's own actions
  ([ADR-0006](0006-jobs-worker-owns-no-identity-state.md)). Generalising it into
  a way for one repository to act as another is the first step of the failure this
  ADR rules out.

## Alternatives considered

### Identity issues business roles and permissions that other repositories read

**Rejected**, and it is the most common identity-platform design, so it deserves
the full argument. The appeal is obvious: one place to manage access, one
answer to "who can do this", and the other products become simpler.

It loses on three counts. First, correctness: the data would have to be pushed
here, and a push is a copy, and a copy of "which repositories this user
administers" is wrong the moment someone is added to a team in Archkeep. Every
product would then either trust a stale copy or call back to ask anyway, in which
case the copy is pure cost. Second, blast radius: every authorization decision in
the organisation would now be a decision made by the service that holds every
credential, which makes the highest-availability requirement in the
organisation also the one that can produce a wrong answer for every product. Third,
coupling: business vocabulary arriving here means this repository grows another
product's model, which is constraint 28's failure in miniature and the thing the
monorepo boundary exists to prevent.

What would have changed the answer: if the organisation had exactly one product,
or if the business permissions were genuinely _about accounts_ rather than about
product data. Neither is the situation.

### Identity as an OIDC provider that also publishes a directory of groups and roles for sync

**Rejected**, and it is the same decision with better packaging. Group and role
sync is how this becomes an authorization service without anyone saying so: the
groups arrive through a standard protocol, the sync runs on a schedule, and the
consumers come to depend on it. The timing problem is identical and the
correctness problem is worse, because a scheduled sync is stale by construction
and nothing in the protocol says "this is a hint, not an authority". The
`DiscoveryDocument` in `identity-oidc` is where this would have to be promised,
and its own documentation says why it is careful about promising things it does
not serve.

### Self-contained JWT access tokens carrying the user's roles

**Rejected**, and it was close, because signed tokens are attractive for
performance and they are the obvious implementation of "identity answers who is
this". The three problems are the three already recorded in the code. A JWT's
payload is readable by anything that can read it, so every holder learns the
user's account-administration role. It must be validated by every client
separately, which means N interpretations of one claim set, and the interpretations
will not all be the same. And it cannot be revoked before it expires, which
[ADR-0010](0010-server-side-sessions.md) rules out for sessions for the same
reason it rules it out there. The performance argument is real and small; the
interpretation problem is permanent.

### A "permissions" contract published by Identity for other systems to call, with no data stored here

**Rejected** as a variant of the first alternative. Identity would become the
_evaluator_ of business rules it has never seen, from data it does not have. The
only thing such a service can do is forward the question to the system that has
the data, at which point it is a proxy — and a proxy that every business decision
waits on is the coupling this ADR exists to prevent.

## Revisit when

- **Two or more Ecoma repositories need to agree on a permission that is genuinely
  a property of the account rather than of product data** — for example "an
  account may hold a signing key at all", which is about the account. That is
  `PlatformRole` territory and it may be a legitimate widening of
  [ADR-0010](0010-server-side-sessions.md)'s neighbouring rules; it is not this
  ADR reopening, because this ADR's rule is about _business_ authorization and
  that example is about account administration.
- **A product's permission data is provably not that product's** — that is, some
  other system would own it and be the authority. That inverts the argument, and
  it is worth an ADR if it ever happens.
- **The organisation adopts an external policy engine (OPA, Cedar, a
  cloud IAM provider) as the authorization authority**, with Identity
  authenticating into it. That does not make Identity an authorization service —
  it makes Identity a client of one — but it does change what this ADR's Context
  should say about where the "one question" boundary sits, and it is worth
  revisiting so the ADR describes the new topology rather than a stale one.
- **A product asks for a role here and the answer is genuinely "we do not have
  that data anywhere".** At that point the honest options are: the product's data
  is missing, or it is elsewhere. Neither is a reason to add it here, and if the
  third time this happens the argument is about the organisation's data ownership
  rather than about this repository.

## Related

- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — the other reason other systems come here: to be told who someone is
- [ADR-0004 — The Admin Worker holds no database](0004-admin-worker-holds-no-database.md)
  — the same confused-deputy argument applied to a caller rather than to a query
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — what the service-identity variant of `PlatformRole` is for
- [ADR-0010 — Sessions are server-side records, not tokens](0010-server-side-sessions.md)
  — why revocation rules out the self-contained token
- `AGENTS.md` — the "what this repository is and is not" paragraph this ADR is the long form of
- `crates/identity-domain/src/user.rs` — `PlatformRole`, where the rule is stated at the type
- `crates/identity-oidc/src/response.rs` — the opaque access token, and why
