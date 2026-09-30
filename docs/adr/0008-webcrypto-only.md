# WebCrypto only; no self-implemented cryptography

<!--
What this file is: ADR-0008, the record of the absolute law on cryptography in
this repository, the list of primitives that are therefore delegated rather than
written, and the constant-time-comparison requirement that follows from it.

What this file is **not**: a crypto design, a key-management plan, or a threat
analysis of a specific primitive. It decides one thing: this repository contains
no cryptography.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `crates/identity-security/src/lib.rs`, the gate traits in
  `identity-security`
- **Constraints covered:** 6, 25, 29 — the restated form of SC-05 in
  [`docs/security/security-constraints.md`](../security/security-constraints.md),
  which is the owner document for the constraint and names the same check
  ("`Cargo.toml` names no cryptography crate")

## Context

Constraint 25 is short and absolute: **no self-implemented cryptography.
WebCrypto only.** No hand-rolled cipher, hash, MAC, padding, or constant-time
comparison. In a system that holds every credential in the organisation, this is
the constraint with the least tolerance for "probably fine".

The reason is not squeamishness, and the `identity-security` crate's module
documentation states it better than this section could: hand-rolled crypto fails
in ways that _pass review_. A non-constant-time comparison on a session token, a
nonce with 16 bits of entropy, a TOTP compared with `==` instead of a
constant-time equality, a padding scheme that is correct on the test vector and
wrong on the seventh byte — each of these is a plausible diff, each of them
survives a careful read, and each of them fails silently and remotely. The only
defence that has ever worked is not having the code.

There is a second reason specific to this platform. WebCrypto arrives through the
Workers runtime: `worker::crypto` wraps the platform's WebCrypto implementation, so
the primitives are in-process, constant-time by construction, and backed by
whatever the runtime uses. Anything self-implemented would be strictly worse than
the thing already present in the platform — which makes hand-rolling here not
merely risky but pointless, except as an expression of the decision to not use
what is available.

The consequence for the architecture is that `identity-security` owns **questions
rather than answers**. Every cryptography, secret-handling and
factor-verification decision is expressed as a trait with a typed interface:
`OtpService`, `TotpService`, `PasskeyService`, `SessionService`, `TokenSigner`,
`TokenVerifier`, `PkceService`, `NonceService`, `CsrfService`, `SecretCipher`. Not
one of them has a body today, and the crate's documentation says that is the point
of the phase: what is being locked down is the set of questions the system must be
able to ask, so the implementations can be reviewed separately from the decisions
that use them. Every method is fallible and every error is typed, because "an
interface that could only succeed is an interface that has not thought about what
happens when the key is wrong."

**The constant-time requirement needs its own statement,** because it is the one
primitive that has a name and is easy to get wrong accidentally. Comparing a
session token, a TOTP code, a PKCE verifier, a CSRF token or a nonce with `==` is
a hand-implemented primitive even though it is one character. Rust's `PartialEq`
for `&[u8]` and `str` short-circuits on the first differing byte, which leaks its
position through timing — a small, fast, unauthenticated oracle. The rule is
therefore not "use a good comparison" but **"the comparison is a delegated
primitive, always"**, and where the platform offers no constant-time comparison
through a typed API, the answer is a design change (see the revisit conditions),
not a loop.

## Decision drivers

- A cryptographic defect in this repository compromises every account on the
  platform, and it will be a defect that reads correctly.
- The platform already provides audited, constant-time primitives in-process;
  anything self-written is strictly worse.
- The security model must be reviewable as a set of _questions_ before any
  implementation exists, or the questions will be answered by whatever the first
  implementation happened to need.
- Every method must be able to fail in a typed way: an interface that can only
  succeed has not considered a wrong key, an expired challenge or a corrupt store.
- "No cryptography crate" must be a mechanical rule, not a style preference, or
  it will be relaxed under a deadline by someone adding a helper.

## Decision

**No cryptography is implemented in this repository. Not a hash, not a MAC, not
a cipher, not a key derivation, not a padding scheme, not a nonce generator, not
a constant-time comparison. Every primitive comes from the platform's WebCrypto
API through the `worker` crate, reached only behind a trait in
`identity-security`.**

From now on:

1. **`identity-security` declares the interfaces; `identity-cloudflare` implements
   them over `worker::crypto`.** Nothing else in the workspace computes a
   cryptographic value. The gate traits in
   `crates/identity-security/src/lib.rs` are the complete list of cryptographic
   questions this system knows how to ask, and a new question is a new trait and
   an ADR if it needs a new primitive.
2. **The allowed primitives are exactly what WebCrypto offers**, and the set is
   fixed by the platform rather than by us: HMAC, SHA-1/2/3 family digests as
   needed for OTP and key derivation, AES-GCM for `SecretCipher`, and the
   `subtle`-equivalent constant-time comparison that WebCrypto and the runtime
   expose. A design that needs a primitive outside this set is **wrong by
   construction** — the answer is to change the design, not to add a dependency.
3. **No cryptography crate is ever added to the Cargo workspace, for any
   reason, including "just for a constant-time comparison".** `AGENTS.md` states
   this in the dependencies-are-architecture section, and it is the rule most
   likely to be broken by a well-intentioned PR.
4. **Constant-time comparison is a delegated primitive, not a discipline.** A
   session token, TOTP code, PKCE verifier, CSRF token or nonce is never compared
   with `==`, `!=`, `matches!` on a string, or a hand-written loop. The gate
   trait that performs the comparison owns it, and the gate's implementation is
   the only place the comparison exists.
5. **The type-level discipline in `identity-security` is part of this law.** A
   secret is carried by a type that does not print it, and a method named for the
   one legitimate use (`expose_for_verification`) rather than for the data
   (`as_bytes`) is what a reviewer greps for. A `Debug` that would print a secret
   is a bug in a type, not a style choice.
6. **A key derivation that is not what the primitive is for is a design error.**
   The discipline is: if the design needs a KDF, it must be one the platform
   provides for that purpose; if it does not, the design is reworked.

**Enforcement:**

| Boundary                                                  | Enforced by                                                                                                                                                                                                                       | Exists today                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cryptography crate in the workspace                    | `AGENTS.md` "Dependencies are architecture"; the allowlist in `tooling/scripts/check-architecture.mjs` over `cargo metadata`'s resolved dependencies                                                                              | **Enforcement not yet built.** The script is landing concurrently; I have read its `CHECKS` array and it contains no cryptography allowlist, so this rule has **no mechanical enforcement at the time of writing** and rests on `AGENTS.md`, the workspace `Cargo.toml`, and review. A denied-crate check over the resolved dependency graph is what should land |
| No cryptographic primitive outside `identity-cloudflare`  | The layer law itself: `identity-domain` depends on nothing platform-shaped and `identity-security` declares traits with no bodies, so there is nowhere in the crate graph for a primitive to live except the adapter crate        | Layer law yes, and `pnpm arch`'s `boundary-3-domain-platform` reported `ok` with 0 violations when I ran it on this tree. The adapter crate `crates/identity-cloudflare/` declares a `crypto` module in its `lib.rs` documentation; **I have not read `crypto.rs` and it was being written concurrently, so nothing here claims it exists**                      |
| The full set of cryptographic questions is the trait list | `crates/identity-security/src/lib.rs`, whose module documentation enumerates the ten gates and says none has a body                                                                                                               | Yes — a real, tested module                                                                                                                                                                                                                                                                                                                                      |
| No secret is printed                                      | `#![deny(missing_docs)]` plus per-type `Debug` impls that print labels instead of values (`SigningKeyId` in `identity-security/src/tokens.rs`; `OtpChallenge`, which carries a challenge id and never the code)                   | Yes — real implementations                                                                                                                                                                                                                                                                                                                                       |
| Constant-time comparison is delegated                     | The gate traits: `TotpService`, `PkceService`, `NonceService`, `CsrfService` are the only places a comparison could be written, and their bodies are `DEFERRED`; the review rule is that no `==` on a secret appears outside them | **Enforcement not yet built**; it will be a lint or review rule over the authentication phase's code, and the gate bodies are `DEFERRED`                                                                                                                                                                                                                         |
| No `unsafe` anywhere                                      | `[workspace.lints.rust] unsafe_code = "forbid"`, inherited by every crate                                                                                                                                                         | Yes                                                                                                                                                                                                                                                                                                                                                              |

## Consequences

### Easier

- **The attack surface of this repository's cryptography is a short list of trait
  names.** A reviewer asking "what crypto does this do" reads a list of ten
  questions and a list of WebCrypto calls, rather than auditing a diff.
- **Nothing to get wrong.** There is no nonce-generation bug to find, no padding
  bug, no comparison bug. The classes of defect that have caused the worst
  incidents in authentication systems are absent by construction rather than by
  review.
- **WebCrypto is audited, constant-time, and in-process.** No JNI, no syscall, no
  serialization of a key across a boundary, no timing difference between "the token
  matched" and "the token was 40 bytes".
- **The security model is reviewable before the implementation exists.** The
  interfaces are the artefact under review in the platform phase, and the
  implementation can be reviewed separately when it arrives. This is the main
  practical payoff of the trait-based shape.
- **The `Debug` discipline makes secrets safe to log by default.** A type that
  prints "sha256:…" rather than the bytes is a type that can go in a `tracing`
  field without a second thought, and the incident surface shrinks accordingly.

### Harder or more expensive

- **Some designs are not available.** WebCrypto has no Argon2, no bcrypt, no
  scrypt, no Ed25519 signing in all environments, no custom padding, no
  "encrypt with a key derived from the user's password using my favourite KDF". A
  design that needs one has to be reworked — usually towards a platform primitive
  or towards a flow that does not need it. This is the intended pressure and it is
  a real tax.
- **Password hashing has no obvious home.** The gate list has `SecretCipher` and
  `OtpService` but no password-hash trait, because the answer depends on what
  WebCrypto offers and the phase in which the authentication flows are built. That
  is a genuine open question, and it is named in the revisit conditions rather
  than papered over.
- **"Constant-time" is not something you can see in the diff.** A delegated
  comparison looks identical to a naive one from a distance. The review
  discipline is "the comparison only exists inside a gate", which is a rule about
  _where_, not about _how_, and it needs the gate bodies to be the only legal
  location.
- **The `worker` crate's WebCrypto surface is narrower than a crypto library's,**
  so some calls take two steps and some are not available in the Workers
  runtime at all. Each of those is a design conversation, and the conversations
  recur.
- **Every fallible method is verbose.** `TokenSigner`, `TokenVerifier`,
  `SecretCipher` — every method returns a typed error, so the happy path is
  buried in error handling. That is a deliberate trade: an interface that could
  only succeed is one that has not thought about a wrong key.

### What a future maintainer will resent

- **"Just use `subtle` for the comparison"** is the sentence, and it will arrive
  in a PR that is otherwise careful. The answer is that a constant-time
  comparison is still a primitive we are delegating, and the place to delegate it
  is a gate. Adding one crate for one function is how the list of "no crypto
  crates" becomes negotiable, and a negotiable list is a list.
- **The occasional redesign caused by WebCrypto's limits.** Someone will design a
  flow around a primitive the platform does not have, get most of the way through
  it, and have to start again. That is the cost working as intended, and it is
  worth saying so when it happens rather than leaving the next person to wonder
  whether the constraint is negotiable.
- **The gate traits are a lot of ceremony for something that is ultimately
  WebCrypto.** They will look like over-abstraction to someone who has not read why
  they exist. They exist because the questions are worth reviewing before the
  answers, and because they are the mechanical form of the "no crypto here" rule.

## Alternatives considered

### Use audited Rust crypto crates (`argon2`, `subtle`, `ring`, `aes-gcm`)

**Rejected**, and it is the strongest alternative, because these crates are
maintained, reviewed, and used by millions. The argument against is not that they
are unsafe; it is three specific things.

First, **constraint 25 says no**, and the constraint exists because the failure mode
is a plausible diff rather than a bad library. Second, **the platform already
provides the primitives in-process**, so the crates would be a worse version of
something present. Third, and most concretely, **the boundary would blur into the
workspace**: a crypto crate in `Cargo.toml` is a dependency that every future
review has to evaluate, in a workspace where the whole point is that
`identity-domain` has no platform and `identity-security` has no implementation.

A weaker version of this alternative — _one_ crypto crate, `subtle`, for the
comparison — is the version that will actually be proposed, and it is the one to
refuse. If the comparison is not available from the platform, the design is
wrong; that is `AGENTS.md`'s rule and it is the rule here.

### Let the platform's edge (Turnstile, rate limiting, WAF) do the factor work

**Rejected**, as a _substitute_ rather than as a complement. Cloudflare's Turnstile
is genuinely good and genuinely relevant to credential-stuffing, and the
`RATE_LIMITER` binding is on `identity` for exactly that. But a CAPTCHA is a
signal, not a factor: it cannot produce a key, cannot sign a token, cannot derive
a session secret, and cannot be the authority for a WebAuthn assertion. It is an
input to the rate limiter, and that is all.

### Self-implement, and rely on review

**Rejected.** This is the one that has no defence beyond "that is the constraint",
so it is worth being explicit about why: review of cryptographic code is the thing
the constraint is designed to route around, because the code reads correctly. A
maintainer who reviews a diff will correctly identify that an HMAC is an HMAC, and
will not reliably identify a timing leak in a comparison, a nonce with too little
entropy, or a padding oracle. The code passes the only check we have, which is
exactly why it must not exist.

### Post-quantum or hybrid signing for tokens

**Not rejected; out of scope for now.** Cloudflare's WebCrypto surface is what it
is today. If the platform ships an ML-DSA or hybrid primitive, `TokenSigner` is the
trait that absorbs it with no change to the decision, which is a good property of
the current design and worth noting. Nothing in this ADR needs revisiting for it.

## Revisit when

- **WebCrypto gains a primitive that removes a real design constraint** — for
  example a proper password KDF. Then the gate list changes and this ADR should be
  amended (not superseded) to record which primitive is now the answer for
  `SecretCipher`'s password case. The constraint itself does not change: still no
  self-implementation, still no crypto crate.
- **A maintainer finds themselves wanting a comparison the platform does not
  expose as a typed API.** This is the sharpest revisit condition in the set. The
  answer, in order: (1) change the design so the comparison is not needed in this
  repository, (2) put the comparison behind a gate and let the gate use whatever
  the runtime provides, (3) revisit this ADR with a specific primitive named. It is
  not answered by adding a dependency.
- **A cryptographic defect in a _managed_ dependency is found** — WebCrypto's
  implementation, or the `worker` crate's wrapper. This ADR's answer is that the
  platform primitives are a different trust decision from a dependency, and the
  response is to raise it with Cloudflare and, if it is severe, treat it as a
  platform-security problem rather than a change to this rule.
- **The secret-handling model is superseded** by a platform feature (a secrets
  manager, a Workers binding for key material). Then `SecretCipher` and the secret
  type discipline may be replaced, and this ADR should be amended to say where
  key material now lives.
- **A second consumer of identity's tokens needs to verify a signature itself**,
  which is the case that made self-contained tokens
  ([ADR-0005](0005-no-business-authorization.md)) attractive. Then the decision
  to sign is being made outside this ADR, and the answer remains that this
  repository issues opaque tokens and the verifier asks Identity.

## Related

- [ADR-0001 — Rust and Cloudflare Workers on the platform](0001-rust-and-cloudflare-workers.md)
  — the runtime whose WebCrypto surface is the only source of primitives
- [ADR-0005 — Identity holds no business authorization](0005-no-business-authorization.md)
  — why access tokens are opaque, and the claim-interpretation problem this avoids
- [ADR-0009 — No authentication bypass in any environment](0009-no-auth-bypass.md)
  — the other absolute "no shortcut" law, and the reason a dev key is not an option
- [ADR-0010 — Sessions are server-side records, not tokens](0010-server-side-sessions.md)
  — sessions are random server-side records precisely so no token is self-verifying
- `AGENTS.md` — the "no cryptography crate, ever" rule, under Prohibited shortcuts
- `crates/identity-security/src/lib.rs` — the ten gates, and the law in the module docs
- `docs/security/threat-model.md` — the assets this law protects
