# Frontend and BFF are one release unit

<!--
What this file is: ADR-0015, the record of why a single-page app and the Worker
behind it must not version independently, what "one release unit" means concretely
in release-please terms, and the honest answer to whether that is enforced or
merely intended.

What this file is **not**: a frontend architecture decision, a decision about Vue
or vite, and not a claim that the two are coupled by a build dependency. They are
not, and this ADR is partly about why they are not.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `pnpm-workspace.yaml`, the `assets.directory` in
  `infra/cloudflare/*/identity*.wrangler.jsonc`, the release-please components
- **Constraints covered:** 7, 8, 28, 29

## Context

There are two frontends and three Workers. `apps/identity/web` is the end-user
app and `apps/identity-admin/web` is the operator console. Each is shipped as
Cloudflare Static Assets through the `ASSETS` binding of the Worker behind it —
`assets.directory` in each `wrangler.jsonc` points at the web app's `dist/`, with
`not_found_handling: "single-page-application"`. So the SPA is served by the
same Worker, from the same version, out of the same immutable artifact.

That packaging is the whole of the enforcement, and it is worth being precise
about it because the mechanism is unusual. **The frontend and the BFF share no
code.** `pnpm-workspace.yaml` covers the TypeScript side; the Cargo workspace
covers the Rust side; `AGENTS.md` states that "the two meet nowhere directly: each
Worker ships its web app's `dist/` as Cloudflare Static Assets, so the Vue build
feeds the Rust build through a directory, not through a package dependency. That is
deliberate — it keeps 'frontend + worker is one release unit' a packaging fact
rather than a workspace graph edge." And `pnpm arch`'s
`boundary-4-no-frontend-in-backend` check enforces the other half: nothing in
`crates/**` or `apps/*/worker/**` may import from `apps/*/web/**`. The BFF is a
boundary, not a shared library.

So the coupling is neither a dependency nor a convention. It is a directory inside
one uploaded artifact.

The reason the coupling has to exist is that **the client's call and the server's
route change together, and a half-applied pair is a broken product rather than a
degraded one.** A SPA that calls an endpoint which does not exist gets an error at
the point of use; a SPA that calls an endpoint whose _shape_ changed gets a
response it cannot parse, and the failure is in the code that consumes it, not in
the code that produced it. Neither is a degradation that a user would describe as
"the site is being updated". The specific cases: an added request field the older
server ignores, which is usually fine; a removed or renamed field, where the older
client's read is `undefined` and the failure surfaces in whichever component
happens to touch it; a route that moves, where the newer client requests a path
the older server answers with its 501 envelope — and note that at this stage _every_
declared protocol route answers 501 anyway
(`docs/README.md`'s status vocabulary), so a half-applied pair during bootstrap
looks exactly like "the platform is not implemented yet", which is the one state
this repository is most careful never to confuse with a working one.

The argument is not only about API shape. The frontend and the BFF also share the
**session cookie**, the error envelope, the health probe, the request-id
plumbing, and the CORS and CSRF posture. A frontend deployed ahead of its BFF is
running a client whose assumptions about cookie attributes, error shape and
request-id propagation are the ones from a version of the BFF that is not live.
The admin console's `wrangler.jsonc` comment says this about itself: "There is no
separate CDN origin and no separate version: a console older than its BFF is not a
supportable state."

## Decision drivers

- A client and the server behind it change together, and half of that pair is a
  broken product rather than a degraded one.
- The pairing must be structural, not procedural, so that "did you remember to
  deploy both" is not a step in a checklist.
- The pairing must survive the two-toolchain split: a Rust backend and a
  TypeScript frontend have two build systems, two dependency trees and two
  test suites, and a coupling mechanism that requires them to share a build would
  force one of those to be merged into the other.
- The pairing must not turn the BFF into a shared library, because a shared type
  package is exactly the thing that lets a backend change a wire shape without a
  frontend change.
- A hotfix to either must be shippable, and the cost of that has to be visible
  rather than discovered.

## Decision

**A frontend and the BFF behind it are one release unit. They are versioned
together, built together, uploaded together, and promoted together as a single
Cloudflare Version. Neither is independently deployable, and there is no mechanism
in this repository by which one of them can reach a user without the other.**

From now on:

1. **Each web app is a release component of its Worker, not its own.** The
   release-please components are the three deployables; the two web apps are built
   by moon tasks invoked as part of building those components and are never
   released, tagged or promoted on their own. There is no `identity-web` tag and
   no `identity-web` component.
2. **The `assets.directory` in the Worker's `wrangler.jsonc` points at the web
   app's `dist/`,** which is why the constraint is a packaging fact: the compiled
   SPA is inside the uploaded artifact, and there is no CDN origin and no separate
   deployment target that could serve a different version of it.
3. **The two sides share no code.** No shared type package, no import from
   `apps/*/web/**` inside `crates/**` or `apps/*/worker/**`, no generated client
   that either side imports at build time. A wire contract lives in
   `contracts/<surface>/v1/` and is read by both, not compiled into both.
4. **A hotfix to either side ships both.** A fix to a Vue component, a fix to a
   route handler, a fix to the error envelope — each deploys the pair. That is the
   cost, and it is deliberate: the alternative is a hotfix path that can ship half
   a change.
5. **Promotion is a single Version id.** The canary
   ([ADR-0014](0014-canary-promotion-identity.md)) moves traffic for the Worker
   and its assets together, because they are in the same version. There is no
   state in which 10% of users get a new API and 10% get an old SPA, or the other
   way round.
6. **Rollback is a single Version id.**
   ([ADR-0013](0013-immutable-worker-versions.md)) A version that is rolled back
   rolls back the SPA with it, which is the property that makes the pair
   coherent rather than two things that happen to be in the same bucket.
7. **The pnpm workspace and the Cargo workspace stay separate**, and the only
   thing crossing between them is a build-output directory. This is what makes
   constraint 8 achievable without a polyglot build.

**Enforcement, and where it stops:**

| Boundary                                                   | Enforced by                                                                                                                                                                                                                                                                                  | Exists today                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing in the backend imports or names a frontend package | `tooling/scripts/check-architecture.mjs`, check `boundary-4-no-frontend-in-backend`, judging `crates/**` and `apps/*/worker/**` against `apps/*/web/**` and a named frontend-package list; `pnpm arch` in `package.json#scripts.arch`                                                        | Yes. I ran the script on this tree and `boundary-4-no-frontend-in-backend` reported `ok` with 0 violations. The check states its own gap: a frontend package not in its explicit name list is a gap in the list, not a false negative in the mechanism                                                                                                                                               |
| The SPA is inside the uploaded artifact                    | `assets.directory` in the deployable's `wrangler.jsonc`, pointing at the web app's `dist/`; the value is committed and is a path, so a change to it is a visible diff                                                                                                                        | Yes for the console. `infra/cloudflare/production/identity-admin/wrangler.jsonc` declares `assets.directory` → `apps/identity-admin/web/dist`, `binding: ASSETS`, `not_found_handling: single-page-application`, with a comment naming [ADR-0015](0015-frontend-and-bff-one-release-unit.md)'s own rule. The end-user SPA's config is being written by another agent; I have read only the admin one |
| There is no separate release component for a web app       | The release-please configuration naming exactly the three deployables; `boundary-5-worker-registration` treats `release-please-config.json` as one of the four places a Worker must be registered, and `deploymentable-count` treats `apps/identity-admin/web` as a known **non**-deployable | **Partially built.** The `release-please-config.json` does not exist yet at the time of writing and is `DEFERRED` to the release phase. The two checks above are named in the script, which is landing concurrently                                                                                                                                                                                  |
| The frontend build runs as part of the Worker's build      | The `assets.directory` path plus the moon task graph: the root `moon.yml`'s `build` task and the per-project override for a Rust project run the web app's build before the Worker's package step                                                                                            | **Enforcement not yet built.** `apps/*/worker/` have no `moon.yml` of their own at the time of writing — `pnpm arch`'s `boundary-5-worker-registration` reports that absence as 3 violations, and the root `moon.yml` carries only the generic task vocabulary. I have not read a `dist/` directory into existence or a build task that produces one                                                 |
| A promotion moves the Worker and its assets together       | The fact that both are in one Version; there is no separate command to promote assets, because there is no separate artifact                                                                                                                                                                 | Structural — the packaging above is the enforcement                                                                                                                                                                                                                                                                                                                                                  |

## Consequences

### Easier

- **A half-applied pair is not a reachable state.** The client and the server
  behind it are in the same artifact, so "the frontend is newer than the API"
  requires two deployments that the packaging does not offer.
- **A version id names a whole product surface.** Tracing "which version is live"
  also answers "which UI is live", which is the question a support conversation
  actually asks. `docs/operations/deployment-model.md`'s traceability argument
  applies to the pair.
- **The canary and the rollback act on the whole product.** 1% of traffic gets the
  new API _and_ the new SPA, and a rollback takes the old SPA with it. Neither
  operation has a partial form.
- **The two toolchains stay separate.** Rust and TypeScript keep their own
  workspaces, their own lints and their own test suites, and the coupling is a
  directory. A shared type package — the thing that would have made this a
  _dependency_ — is the thing this decision exists to prevent.
- **The architecture gate has an enforceable version of the rule.** "The BFF is a
  boundary, not a shared library" is checkable: no backend import resolves into a
  web directory.
- **A frontend-only change is a small change, not a small release.** There is no
  separate deploy target to think about, so "can I ship just the UI?" has the
  answer "yes, and the Worker ships with it, unchanged".

### Harder or more expensive

- **A one-line CSS fix redeploys the Worker.** The build runs, the version is
  uploaded, and the canary runs. For a change that touches no server code, that is
  a real and recurring tax, and it is the single most likely source of pressure to
  split the release units.
- **A hotfix to either side drags the other.** If the SPA has a bug that needs
  fixing now, the fix ships with a Worker that is fine. If the Worker has a bug,
  the fix ships with an SPA that is fine. Both are correct; neither is fast in the
  way a two-deployment split would be.
- **The release cadence is set by the slower side.** The Identity Worker cannot
  release without its SPA being healthy, including the SPA's test suite, and the
  SPA's suite runs in the same PR CI.
- **The coupling is invisible in the build graph.** "Is this frontend releaseable?"
  has no answer in `pnpm-workspace.yaml` or in the Cargo manifests, because neither
  knows the other exists. A reader has to read the `assets.directory` to see the
  coupling at all, and that is a weaker property than a dependency edge.
- **"One release unit" is a release-please configuration fact, not a constraint on
  what a human may do.** The per-deployable components prevent a _separate_ release
  from being cut; they do not prevent a human from building and uploading a web
  app's `dist/` by hand and pointing a wrangler config at it. That is the honest
  limit of this decision's enforcement and it is stated here rather than left for
  someone to discover.

### What a future maintainer will resent

- **"Can we just deploy the frontend?"** It is the sentence this ADR is written
  against, and it will be said about a CSS fix and about a marketing page. The
  answer is step 4: a hotfix to either ships both, because a client and the server
  behind it change together.
- **The CSS-fix redeploys-the-Worker tax.** It will recur, it will be
  disproportionate, and the answer is not to split the release unit but to make
  the build cheap enough that nobody minds. If the cost is still unacceptable
  after that, the revisit condition below is what the decision looks like.
- **A half-applied pair during bootstrap looks like "authentication is not
  implemented".** Every declared protocol route answers 501, so a client talking
  to an older server gets the 501 envelope and the failure is indistinguishable
  from the honest bootstrap state. This is one more reason the pairing is
  structural rather than procedural.

## Alternatives considered

### Version the SPA and the Worker independently, with the SPA behind a CDN

**Rejected**, and it is the alternative with real appeal: a CDN is the natural home
for static assets, it removes the SPA from the Worker version, it makes a CSS fix
a cache purge, and it decouples the release cadences. It loses on the pairing.
A client and the server behind it change together, and a CDN that can put a new
SPA in front of an old API can also put a new SPA in front of a _rolled-back_
API — and then the version id no longer names a coherent product surface, which
breaks the traceability that
([ADR-0013](0013-immutable-worker-versions.md)) and
([ADR-0014](0014-canary-promotion-identity.md)) both depend on. It also makes
the 1% canary meaningless for the UI: you can serve 1% of the SPA to 1% of
requests, and that is a much harder thing to reason about than a version
percentage. And it introduces a second artifact with its own cache-invalidation
failure modes, which is a different class of incident to add to a system that
holds every credential.

### Share a generated type package between the SPA and the Worker

**Rejected**, and this is the tempting middle: generate the wire types once from
`contracts/`, publish them as a package both sides depend on, and let the compiler
catch a shape change on one side. It is genuinely good engineering in almost any
other system, and it fails here for a specific reason. A shared type is a
_dependency_, and a dependency means the backend can change a wire shape and have
CI fail only on the frontend — or, worse, succeed because the frontend was not
updated in a way that the generated type catches. It also makes the BFF a client
of the frontend's package, or the frontend a consumer of a backend-published
artifact, and either direction erodes the boundary `boundary-4-no-frontend-in-backend`
exists to keep. The contract lives in `contracts/<surface>/v1/` and is read by
both; it is not compiled into a shared library.

### Publish the SPA and the Worker as two versions behind one release, promoted

separately

**Rejected** as the worst of the available options: the release is coupled but the
promotion is not, so the release tag says "these go together" while production can
run one of them. The result is a system that _looks_ like it satisfies constraint 8
and can still serve a new SPA to an old API. If the coupling is going to be real,
it has to be real at the artifact level, because that is the only level at which it
cannot be violated by a reasonable-looking deployment sequence.

### Server-render the frontend, so there is no SPA to pair

**Rejected**, and it deserves a paragraph because it eliminates the problem rather
than managing it. It loses on the platform: the deliverable is a Cloudflare
Static Assets bundle plus a Worker, and a framework that renders per request is a
different architecture, a different deployment shape and a different latency
profile. It also moves the contract from "a version" to "a deployment", which
collides with [ADR-0013](0013-immutable-worker-versions.md) — the SSR framework's
output is not the same artifact as the Worker's bundle, so the version id stops
naming a single immutable thing. And the two existing frontends are SPAs with a
`dist/` directory, a vite build and `not_found_handling:
"single-page-application"`, so this would be a rewrite of a decision already made
and shipped in packaging.

## Revisit when

- **The frontend needs to ship without a server change.** This is the condition
  that changes the sign of the decision, and it has three recognisable forms: a
  static marketing page that is not tied to any API, an independently versioned
  widget or component SDK published to third parties, or a documentation site. The
  moment one of these exists, the coupling stops being a cost and starts being a
  constraint on something that has no reason to be coupled — and the answer is a
  fourth static surface on its own release, which is a
  [ADR-0002](0002-three-deployables-and-no-more.md) question and then this one.
- **The frontend's release cadence diverges measurably from the Worker's** —
  observable as CSS-only or copy-only changes being a large fraction of the
  releases, and the rebuild-and-recandisary tax dominating the cost of a UI
  change. The first answer is to make the build cheap. If the second answer is
  decoupling, the reason will be cadence and it should be argued in those terms
  rather than as "the two are really independent".
- **A Wire-contract change that the pairing cannot cover** — for example a
  long-lived experimental API that one SPA version and one Worker version must
  serve simultaneously in a stable way. That is a version-negotiation problem, and
  the honest answer is usually a versioned route (`/v2/…`) with both
  implementations live for a deprecation window, rather than a split release unit.
- **Cloudflare's Static Assets gain an independent versioning or edge-cache
  primitive** that makes "roll the SPA back without the Worker" a single atomic
  operation. That would move the cost rather than remove it, and the question would
  become whether traceability survives. It is named here so the answer is not
  improvised.
- **A second backend appears in front of the same SPA** — for example the admin
  console beginning to serve a function the Identity Worker does not. Then "the
  BFF behind it" is no longer a single Worker, and this ADR's packaging fact
  becomes ambiguous in a way that needs resolving.

## Related

- [ADR-0012 — Release is not deployment](0012-release-is-not-deployment.md)
  — the release whose components are the three deployables, each including its
  frontend
- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — the single version id that acts on the Worker and its assets together
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — the promotion whose percentage moves the pair as one
- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md)
  — why each BFF is a deployable, and what a fourth surface would need
- `docs/operations/deployment-model.md` — **the owner document**: "What is
  deployed from what", and why the coupling is a directory rather than a
  workspace edge
- `docs/operations/release-process.md` — the three release components and the
  sequence
- `docs/architecture/worker-architecture.md` — the `ASSETS` binding each deployable
  holds
- `contracts/` — the four wire contracts both sides read
- `pnpm-workspace.yaml` — the TypeScript-side workspace, which covers the two web
  apps and nothing else
- `tooling/scripts/check-architecture.mjs` — `boundary-4-no-frontend-in-backend`
