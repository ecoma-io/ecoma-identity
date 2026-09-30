# home-web

The public-facing web application of the Ecoma organisation.

## What this is

An independent deployable running Nuxt 4 / Nitro on Cloudflare Workers + Workers
Assets, designed for hybrid rendering from day one:

- **Prerender** now for stable marketing pages. `/` is prerendered today and
  ships a rendered landing page.
- **Nitro SWR** later for `/news` and `/blog`. The route rules are configured;
  no content, CMS, blog engine, or news engine exists, so those paths 404 today.
- **SSR/server routes** only where genuinely needed.

Note the terminology: this is Nitro's own stale-while-revalidate route rule, not
Vercel's ISR. Nothing here is deployed on Vercel and nothing here calls an ISR
API — Nitro owns the caching behaviour in `nuxt.config.ts`.

No separate backend or service. Nuxt/Nitro _is_ the runtime. There is no
`apps/home-web/worker/` directory — this is not a Rust Worker.

## What this must never hold

Per ADR-0016, `home-web` is forbidden from:

- Holding `IDENTITY_DB` or any Identity D1 binding.
- Holding Identity service bindings (`IDENTITY`, `IDENTITY_ADMIN`,
  `IDENTITY_JOBS`).
- Depending on `identity-domain`, `identity-application`,
  `identity-security`, `identity-cloudflare`, or any internal Identity crate.
- Storing session, user, or authentication state.

The architecture gate enforces these constraints. See
`tooling/scripts/check-architecture.mjs` and `module-boundaries.config.mjs`.

## Development

```bash
# From the repository root
pnpm install

# Start the Nuxt dev server (via moon)
pnpm exec moon run home-web:dev

# Or call the package script directly
pnpm --filter @ecoma-io/home-web dev
```

The dev server runs at `http://localhost:3000` by default.

The dev server introduces **no authentication bypass**. There is no dev auth
mode, no dev role, and no flag that skips a check — not here, and not anywhere
else in this repository (ADR-0009). If a page behind a login ever exists, it
will be unreachable in development for exactly the reason it is unreachable in
production, because there is no authentication to develop against yet.

## Build

```bash
# Build for Cloudflare Workers
pnpm exec moon run home-web:build

# Build and verify the artefact in one task (what CI and deploy run)
pnpm exec moon run home-web:package
```

The output lands in `.output/`:

- `.output/server/index.mjs` — the Worker entry point.
- `.output/public/` — static assets served by the `ASSETS` binding.

`home-web:package` builds and then verifies that both of those exist and that
the public directory is nonempty. Use it in CI rather than `build`: a build that
produces no output should fail the task, not the deploy that discovers it.

## Test

```bash
pnpm exec moon run home-web:test
```

The test starts a local Cloudflare-compatible Worker runtime via
`wrangler dev --local`, then asserts that it serves the rendered landing page and
that one emitted `/_nuxt/` client asset is served as nonempty JavaScript. It is
the same contract the remote smoke test in `deploy-worker.yml` enforces after a
deployment; if you change one, change both.

## Validating the deployment config

```bash
pnpm exec moon run home-web:wrangler-validate
```

Renders the development config from `infra-topology/topology.json` and runs
`wrangler deploy --dry-run` against the generated file — wrangler's own
validation, with no upload and no traffic. It is the local check that the
deployment config is well-formed and that only the `ASSETS` binding is declared.

There is no `preview` task. To exercise the built Worker rather than the Nuxt dev
server, run `home-web:test`, which is what starts `wrangler dev --local` against
`.output/`.

## Deployment

Staging and production deployment is handled by the reusable workflow at
`.github/workflows/deploy-worker.yml`. See `docs/operations/deployment-model.md`
for the deployment model.

**Nothing here has been deployed.** No Cloudflare upload, staging deployment,
production deployment, release, promotion, or rollback of `home-web` has run. The
build, the local Worker smoke test, and a `wrangler deploy --dry-run` have all
passed; that is the whole of the evidence, and it is not evidence that a
deployment is verified.

Deployment configs are **generated**, not tracked. `infra-topology/topology.json`
declares the Worker name per environment, and `pnpm infra:render` projects it
into `.generated/cloudflare/<environment>/home-web/wrangler.jsonc` — script name
`home-web` for development and production, `home-web-staging` for staging.
`.generated/` is gitignored and is what the deploy workflows upload.

There is no app-local `apps/home-web/wrangler.jsonc`. It was a fourth
declaration of the same facts that had already drifted away from the other
three.

## Architecture

See `docs/adr/0016-home-web-fourth-deployable.md` for the full ADR.

Key points:

- **Independent deployable.** `home-web` releases on its own schedule with its
  own tag (`home-web-v*`), and a change here does not release `identity` unless
  the dependency graph requires it.
- **No Identity coupling.** The public site does not call Identity from the
  server side. It may link to `https://identity.ecoma.io` for authentication
  flows, but it does not participate in them.
- **Hybrid rendering.** Route rules in `nuxt.config.ts` configure prerender for
  `/` and Nitro SWR for `/news/**` and `/blog/**` as future extension points.

## Scope at scaffold time

This is a scaffold, not product implementation. Deliberately **not** built:

- Authentication, SSO, or any identity integration.
- CMS, blog engine, or news engine.
- Database, content API, or analytics platform.
- Complex design system, i18n framework, or search.

The foundation is designed to grow into these without changing deployment
topology.
