# The topology owns the frontend's cookie namespace, and the frontends read a projection of it

- **Status:** Accepted
- **Date:** 2026-10-02
- **Deciders:** John Martin
- **Technical story:** https://github.com/ecoma-io/ecoma-identity/issues/9, https://github.com/ecoma-io/ecoma-identity/issues/17, https://github.com/ecoma-io/ecoma-identity/issues/31, https://github.com/ecoma-io/ecoma-identity/issues/32, https://github.com/ecoma-io/ecoma-identity/issues/36
- **Constraints covered:** SC-3 (one account, one zone), SC-16 (automatic staging deploy), SC-17 (every preview is isolated and disposable), SC-24 (secrets never in a tracked file), SC-27 (no credential in a frontend build)

## Context

Three frontends ship in this repository — `apps/identity/web`,
`apps/identity-admin/web` and `apps/home-web` — and each answered "what does
this visitor prefer" independently, with values written into the source:

- `packages/shared-i18n/src/types.ts` hardcoded the cookie name `ecoma_locale`,
  which exists in **no** environment, and branched on a boolean called
  `isProduction` to choose between `.ecoma.io` and `localhost`.
- `apps/home-web/nuxt.config.ts` hardcoded the same name, the same domain and
  `baseUrl: "https://ecoma.io"`, and `packages/*/moon.yml` `deps` lines plus a
  comment were the only things relating the two copies. The comment said they
  had to stay in step. **A comment is not a constraint.**
- The locale list existed in two more files.
- `apps/*/web/src/plugins/i18n.ts` used `import.meta.env.PROD` as a proxy for
  environment. That is wrong in a specific way: the same bundle is uploaded to
  staging and to production, so `PROD` is true in both, and a staging build
  writes the production cookie.

Meanwhile `infra-topology/topology.json` **already owned every one of those
answers** under `cookie_namespaces`, and `render-wrangler-config.mjs` already
projected them into a per-environment descriptor with a comment saying the
frontends should read it. Nothing read it.

Three properties make the obvious fixes wrong, and each one is a decision
rather than an implementation detail.

**1. The frontend may not read the deployment descriptor.** It is the obvious
file to read — it is already generated per environment, and deleting the fields
a browser must not see would take minutes. It also carries `account.id` and the
D1, KV and queue identifiers. Any scheme that lets a browser bundle read it, or
that derives the bundle's config from it by subtraction, has to be correct about
the subtraction forever. A field added to the descriptor next year is in every
bundle that ships the week after, in production, because nobody remembered a
deletion list.

**2. The locale vocabulary was in TypeScript and the cookie namespace was in
JSON.** Moving the cookie name into a projection is easy. The locale list is
the harder half: the renderer is a zero-dependency `.mjs`, so the obvious
resolution — declare the list there — creates a _second_ owner, in a file whose
whole purpose is to be the single resolver. Two resolvers for one topology is
worse than the bug.

**3. `import.meta.env.PROD` is not an environment.** It is a build-mode flag,
and this repository ships the same artefact to four environments.

## Decision drivers

- **One owner per value.** A value with two owners is a value that will
  disagree with itself, and the disagreement is invisible until a preview writes
  production's cookie.
- **A browser bundle must not be able to see an identifier it has no use for**,
  by construction rather than by review.
- **A gate, not a convention.** Issue #17 was kept in step by a comment for as
  long as it existed. Nothing about a second copy is a compile error.
- **Builds stay credential-free.** No Cloudflare token, no account id, and no
  D1/KV/queue name may be needed to produce a frontend artefact.

## Decision

**The topology owns the cookie namespace. The frontends read a browser-safe
projection of it, rendered by the existing renderer, and the shared package is
renamed to own preference mechanics.**

**What the topology owns.** `infra-topology/topology.json` keeps
`cookie_namespaces` — one name per environment, four distinct values — and the
hosts, the account zone and the environment list. `infra-topology/frontend-support.json`
is a new tracked file beside it and owns the locale vocabulary, the default
locale and the default colour mode. Nothing else may restate either.

**What the renderer emits.** `render-wrangler-config.mjs` gains a `frontend`
projection built **by whitelist**: `{ environment, baseUrl, cookie: { name,
domain, secure }, supportedLocales, defaultLocale, defaultColorMode }`. It is
written per environment to `.generated/frontend/<environment>.json`, copied to
`.generated/frontend/config.json` — the only path any application imports, so no
application knows which environment it is building — and the vocabulary is copied
into `packages/frontend-preferences/frontend-support.json`.

**Why the vocabulary copy is generated rather than imported.** The package must
answer "which locales exist" in a unit test with no rendered config present. A
hand-maintained copy is a second owner. A generated one is a _product_ of the
first, so the duplication is never maintained and only ever re-derived;
`check-frontend-config.mjs` fails if the copy and the source disagree.

**Why the projection is not the descriptor, minus fields.** See driver 2 above
and "Alternatives". The projection is assembled from `resolved` and the support
file, and `render-frontend-config.test.mjs` asserts against the real topology
values that all four environments are free of `account.id`, resource names and
`EMAIL_PROVIDER`. The test is the backstop; the whitelist is the mechanism.

**`FRONTEND_ENVIRONMENT` is a real build input.** Every task that reads the
config renders it inline, in the same task, immediately before reading it, and
deletes any previous render first. `home-web:build` sets `options: { cache:
false }` because an inline shell command is not a `deps:` edge and moon's content
hashing cannot see the file it produces.

**The package is renamed `shared-i18n` → `frontend-preferences`.** A package
that owns a locale cookie, a colour-mode cookie and a timezone detector is not
an i18n library, and `cookie.ts` was never one. The invariant it is renamed to
enforce: **a shared frontend package owns preference mechanics, not translation
catalogs and not business or user data.** Catalogs stay application-owned.

**Colour mode is scoped to the two Vue apps.** `home-web` has no token system,
so a toggle there would change nothing; that is a defect under `AGENTS.md`'s
honesty rule, not a placeholder. **DEFERRED** for `home-web`.

**Timezone is detected per session and never persisted.** The locale cookie
lives for a year; a traveller's zone stored beside it would be stale for a year.

**Backend preference persistence is `DEFERRED`.** `RemotePreferenceAdapter` is a
declared seam and nothing else — no endpoint, no table, no Rust type, no
`UserPreferences` in the domain, no migration. The frontend change does not
touch `crates/**` or `database/**` at all.

**Enforcement:**

- `tooling/scripts/check-frontend-config.mjs` — a frontend source that hardcodes
  a cookie name, the zone apex, a canonical URL, a colour-mode literal or a
  locale literal fails the build. Wired into `ci.yml`'s `checks`, so it runs on
  every pull request including one that touches no frontend path.
- `module-boundaries.config.mjs` — a row per frontend application; the direction
  is application → `frontend-preferences`, never the reverse.
- `tooling/scripts/render-frontend-config.test.mjs` — the secret-leak audit.

## Consequences

### Easier

- Adding an environment means editing the topology. No frontend source changes,
  and no frontend source can disagree.
- A preview cannot write production's cookie: its name is different, and its
  `domain` is `null` so it cannot even set a cookie the zone would accept.
- Staging and preview cannot emit production canonicals, because `baseUrl` is
  derived from the topology rather than written down.
- The gate turns #17 from a comment that says "keep these in step" into a build
  failure when they are not.

### Harder or more expensive

- A frontend build now depends on a render step. A task that reads the config
  without rendering it first gets a loud error rather than a default, which is
  the correct trade and is still an extra thing to get right in every new task.
- `home-web:build` is no longer cached. A cached build would serve a frontend
  config built against a topology the cache never looked at.
- `packages/frontend-preferences/frontend-support.json` is a generated file that
  lives inside a package directory and must not be hand-edited or formatted. It
  is in `.prettierignore` for the same reason `pnpm-lock.yaml` is: its owner
  writes bytes prettier would rewrite, and a formatting gate that reports the
  order two tools happened to run in has stopped being able to say anything.

### What a future maintainer will resent

- **"Why is there a JSON file that only exists to be read by a renderer?"** —
  because the cookie name already lived in `topology.json` and the locale list
  lived in TypeScript. Two files for one set of platform facts is the shape that
  produced #17; one file for the facts and one projection for the readers is
  the fix.
- **"Why does a frontend build run a wrangler renderer?"** — because the renderer
  is the only thing that already resolves an environment, and a second resolver
  is a second source of truth. The name is now a slight misnomer; the correct
  name would be "render the platform configuration".
- **"Why is the vocabulary copied into the package rather than imported?"** —
  because the package's tests must run with no render step, and a copy that is
  generated rather than maintained cannot drift.

## Alternatives considered

### Have the frontends read `.generated/deployment/<env>.json` directly

Rejected on security grounds, not taste. The descriptor carries `account.id` and
the D1, KV and queue names. A frontend bundle that can read it is one build
misconfiguration away from shipping those, and "we deleted the fields" is a
policy no gate enforces.

### Derive the frontend config from the descriptor by subtracting keys

Rejected because subtraction is a list someone has to remember to update. A
whitelist is a list someone has to remember to _extend_, and extending it is an
act that requires naming the new field — which is the review you want. The
`render-frontend-config.test.mjs` audit exists as the backstop for the case where
even the whitelist is wrong.

### Declare the locale vocabulary as a constant inside `render-wrangler-config.mjs`

Rejected: it puts a fact about the product in a file whose job is to resolve the
topology, creating a second resolver for one platform. `frontend-support.json`
keeps the vocabulary beside the cookie namespace that names it, which is the
same category of thing, and the renderer reads both.

### Have each application keep its own locale list

Rejected, and this is what exists today. The three applications would ship
three lists, a locale added to one would render missing keys in another, and the
"supported" set would be the union in one and the intersection in another. The
`zh` case in `~/ecoma-io/ecoma/languages.config.json` is the live example of a
locale declared somewhere no catalog implements it.

### Persist the display timezone in the same cookie as the locale

Rejected on a one-year horizon. The locale cookie's max-age is a year; a stored
timezone would be a year stale for anyone who crossed a timezone, and the
symptom reads as a calendar bug rather than a stale preference. Display timezone
is re-detected per session; the business timezone is a separate, backend-owned
fact this document does not read.

## Revisit when

- A preference gains a **second cookie**, at which point the "cookie name" row in
  `frontend-support.json` becomes a plural and the naming convention needs
  stating rather than following.
- Authenticated preference persistence is designed. That is a backend change —
  a `UserPreferences` type, a migration, an endpoint — and needs its own ADR; the
  `RemotePreferenceAdapter` seam exists so that decision does not have to touch
  the frontends again.
- A frontend is added to the repository. It inherits the projection and the gate,
  and needs its own row in `module-boundaries.config.mjs`.
- `home-web` grows a token system. Colour mode becomes implementable there and
  its `DEFERRED` status is wrong.

## Related

- [ADR-0015 — Frontend and BFF are one release unit](0015-frontend-and-bff-one-release-unit.md) — why the package is not a release unit.
- [ADR-0016 — home-web is a fourth deployable](0016-home-web-fourth-deployable.md) — why the public application reads the same projection without gaining an edge to the identity plane.
- [ADR-0009 — No authentication bypass](0009-no-auth-bypass.md) — SC-27, why a frontend build configuration may never hold a credential.
- `docs/architecture/frontend-preferences.md` — the model this decision produces.
