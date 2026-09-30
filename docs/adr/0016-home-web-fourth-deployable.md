# home-web is a fourth, independent deployable — the public web application

- **Status:** Accepted
- **Date:** 2026-10-01
- **Deciders:** John Martin
- **Technical story:** https://github.com/ecoma-io/ecoma-identity/issues/7
- **Constraints covered:** SC-7 (exactly three deployables — now four), SC-16 (automatic staging deploy), SC-19 (production requires two human gates)

## Context

Ecoma Identity has three deployables (`identity`, `identity-admin`, `identity-jobs`), all of which are Identity surfaces. None of them is a public website, and none of them may become one:

- `identity` owns the identity database and answers authentication requests.
- `identity-admin` is an operator console that reaches identity through a service binding.
- `identity-jobs` is a background worker that owns no identity state.

A public marketing site has different properties from every one of the three:

1. **It is public** — reachable on a route with no Identity involvement at all.
2. **It holds no Identity state** — no session, no user, no D1 binding.
3. **It has no availability coupling to login.** An Identity outage should not take down the public site, and the public site's deploy cadence is unrelated to Identity's.
4. **Its release cadence is content/marketing cadence, not protocol cadence.**

This is precisely the case ADR-0015 anticipated. Its Revisit-when clause reads:

> The frontend needs to ship without a server change… a static marketing page that is not tied to any API… The moment one of these exists, the coupling stops being a cost and starts being a constraint on something that has no reason to be coupled — and the answer is a fourth static surface on its own release, which is an ADR-0002 question and then this one.

That clause is met, so this ADR is the ADR-0002 question.

## Decision drivers

- **Authority separation.** Identity decides _who someone is_; a marketing page decides nothing about identity.
- **Data ownership.** The public site must not hold `IDENTITY_DB` and must not be reachable by anything that holds it.
- **Availability independence.** The public site must deploy and roll back on its own cadence.
- **Release independence.** A change only in `home-web` must not trigger an Identity release.
- **Rendering flexibility.** The site must support hybrid rendering from day one — prerender now, Nitro SWR cache regeneration for `news`/`blog` later, SSR only where genuinely needed.

## Decision

`home-web` is a fourth, independent deployable: the public-facing web application of the Ecoma organisation, running Nuxt 4 / Nitro on Cloudflare Workers + Workers Assets.

**What `home-web` is:**

- An independent Moon project (`home-web: apps/home-web`).
- An independent production deployable with its own release tag (`home-web-v*`).
- Runtime: Nuxt 4 → Nitro → Cloudflare Workers (Worker runtime + Workers Assets).
- Rendering: hybrid — prerender stable marketing pages now; Nitro SWR cache regeneration for future `news`/`blog` routes; SSR/server routes only where genuinely needed. No news/blog pages or content lifecycle exists yet.
- No separate backend or service. Nuxt/Nitro _is_ the runtime.
- No `apps/home-web/worker/` directory. This is not a Rust Worker.

**What `home-web` must never hold:**

- No `IDENTITY_DB` binding. Not in any wrangler config, not in any environment.
- No Identity service bindings (`IDENTITY`, `IDENTITY_ADMIN`, `IDENTITY_JOBS`). The public site does not call Identity.
- No dependency on `identity-domain`, `identity-application`, `identity-security`, `identity-cloudflare`, or any internal Identity crate.
- No session, no user, no authentication state.
- No business API logic. It may link to `https://identity.ecoma.io` for authentication flows, but it does not participate in them.

**Enforcement:**

- `tooling/scripts/check-architecture.mjs`: `DEPLOYABLES` gains `home-web`; check 4 examines home-web import specifiers and package dependencies for Identity implementation references, while check 5 reads every home-web Wrangler binding surface; `checkExactlyThreeDeployables` is renamed to `checkExactlyFourDeployables` and updated to recognise `home-web` as a public web application (no `worker/Cargo.toml`, but a `wrangler.jsonc` and a `nuxt.config.ts`).
- `module-boundaries.config.mjs`: a row judging `sourceTag: "home-web"` with `onlyDependOnLibsWithTags: ["home-web"]` and `notDependOnLibsWithTags: ["domain", "application", "oidc", "security", "adapter", "identity", "identity-admin", "identity-jobs", "identity-testkit"]`.
- `release-please-config.json`: `home-web` as its own component under `packages`.
- `.github/workflows/deploy-worker.yml`: build step branched for `home-web` (no Rust build, Nuxt/Nitro build only); smoke step branched for `home-web` (probes `/` not `/health` + `/ready`).
- `.moon/workspace.yml`: `home-web: apps/home-web` with its own `moon.yml`.

## Consequences

### Easier

- The public site ships on its own schedule without blocking on Identity releases.
- Marketing content changes do not touch the identity plane at all.
- Nitro SWR cache regeneration for `news`/`blog` can be implemented later without changing deployment topology.
- The architecture gate prevents accidental leakage of Identity crates into `home-web`.

### Harder or more expensive

- Four deployables to monitor, four release PRs, four staging deploys.
- The smoke test in `deploy-worker.yml` needs per-deployable branching (`home-web` serves `/`, not `/health` + `/ready`).
- `check-architecture.mjs` gains complexity: it must recognise a deployable that is not a Rust Worker.

### What a future maintainer will resent

- "Why does the architecture gate special-case `home-web`?" — because `home-web` is a Nuxt/Nitro deployable, not a Rust Worker, and the gate's original definition assumed all deployables are Rust Workers. The special case is the honest encoding of that difference.

## Alternatives considered

### Put the public site in `identity`'s Worker

Would give a public, unauthenticated page a route behind the plane that owns sessions and D1. Would make `identity`'s release tag carry website changes. Violates authority separation and availability independence.

### Put the public site in `identity-admin`'s Worker

`identity-admin` is an operator console. A public marketing page has no business being in the admin plane. Same release coupling problem.

### Deploy `home-web` as Cloudflare Pages

Pages is a different deployment model with different semantics. Workers + Workers Assets is the Nitro `cloudflare-module` preset, which is what Nuxt 4 targets. Pages would require the `cloudflare-pages` preset and a different workflow structure. The Workers path is simpler and matches the existing deploy pipeline.

### Use a static site generator outside this repository

Would lose the monorepo benefits: shared toolchain, shared CI, shared release process, architecture gate coverage. The public site is an Ecoma surface; it belongs in the Ecoma Identity repository.

## Revisit when

- If `home-web` needs to call an Identity API from the server side (would require a service binding and an ADR explaining why).
- If `home-web` needs a database (would require its own D1 binding and an ADR explaining what data it owns and why).
- If a fifth deployable is proposed (would require revisiting ADR-0002 and this ADR).

## Related

- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md) — superseded by this ADR on the count.
- [ADR-0015 — Frontend and BFF are one release unit](0015-frontend-and-bff-one-release-unit.md) — the revisit condition that triggered this ADR.
- `docs/architecture/overview.md` — the four-deployable topology.
- `docs/operations/deployment-model.md` — deployment naming and versioning.
