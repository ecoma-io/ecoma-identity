# Deployment topology

`topology.json` is the one place a Cloudflare Worker name, a hostname, a binding
slot, a D1/KV/queue name, a rate-limit namespace or a cookie name is declared.
Nothing else in the repository may declare any of those things, and the
wrangler configuration is generated from this file rather than written by hand.

## Why it is generated rather than tracked

It used to be both. Twelve tracked configs restated this file's facts by hand and
drifted: `staging/identity` set `ISSUER_BASE_URL` where the code reads
`IDENTITY_ISSUER`, carried production's rate-limit namespace id `1001`, and named
`https://identity-staging.ecoma.io` for a Worker whose canonical hostname is
`stg-identity.ecoma.io`. None of that was caught, because a fact written twice is
judged by nobody.

So the tracked copies are gone. `pnpm infra:render` writes
`.generated/cloudflare/<environment>/<deployable>/wrangler.jsonc` — three
environments by four deployables — and `.generated/` is not tracked. `pnpm arch`
reads the generated tree, so **CI validates the exact shape that deploys** rather
than a hand-maintained approximation of it.

`.generated/` is in `.gitignore` on purpose. In the renderer's `--stage resolve`
mode the generated files contain real Cloudflare identifiers discovered from the
API. An offline render contains an unmistakable
`UNRESOLVED_REQUIRES_CLOUDFLARE_CREDENTIAL` sentinel wherever an id is required
and no descriptor was supplied, so an offline config can never be uploaded by
accident: wrangler will not accept the sentinel as a resource id.

## What is declared here, and what is not

**Declared** — everything logical: names, hosts, bindings, limits, naming
templates, the preview grammar, the never-delete list, the deletion order, and
the fail-closed evidence policy.

**Not declared** — any Cloudflare-generated identifier, and any indirection for
obtaining one. There is no `id_env_var`, no `id_source`, no `database_id`, no
`namespace_id`, no `$TOKEN` placeholder, and no reference to a GitHub variable or
secret name. `validate-topology.mjs` fails on all of them by name, and the
mutation tests in `validate-topology.test.mjs` add each one back to prove the
gate still refuses it.

The one identifier that _is_ here is `account.id`. Cloudflare does not mint it and
it does not change, so it is account context rather than a generated resource id —
and it is pinned here so that no workflow, repository variable or secret can
become a second source of truth for it.

**The exception, stated because it looks like a contradiction:**
`environments.*.ratelimits.*.namespace_id` is a bare integer in this file. A
rate-limit namespace has no create, list or delete API, so its id can only be
chosen once by a human and then referenced. It is the one identifier-like value
that must be declared, and the validator requires each environment to have its
own.

## What a deploy does about the names declared here

Naming a resource here is not a declaration that somebody must go and create it.
A deploy **ensures** every name in scope: `tooling/scripts/reconcile-infra.mjs`
looks each one up in the account by exact name, **creates the ones that are
absent**, and binds the id it then finds by listing again. The id is never taken
from the create response and never stored — it lives in the runner's temp
directory and dies with the job. [ADR-0021](../docs/adr/0021-deploy-ensures-its-own-resources.md)
records that decision and what it costs.

The two things that is not:

- **It never deletes.** Create is the whole write surface. A name that resolves
  to two resources is an error, never a tie to break.
- **It never guesses a name.** A resource this file does not declare is never
  bound, adopted, renamed or cleaned up.

Which means a name added here and a resource left behind by a removed name are
different problems, and only the first one is solved automatically.

## Status

| Fact                                                | State                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| One topology, twelve generated configs              | `IMPLEMENTED` — `pnpm infra:render`, judged by `pnpm arch`                                                |
| Every generated config parses and passes wrangler   | `IMPLEMENTED` — `moon run :wrangler-validate` runs `wrangler deploy --dry-run` against the generated file |
| Resource ids are rediscovered, never stored         | `IMPLEMENTED` — `reconcile-infra.mjs`, 15 tests against a fake built to Cloudflare's published contract   |
| A deploy ensures the names declared here            | `IMPLEMENTED` — same script; absent names are created, then re-listed by exact name                       |
| Real Cloudflare resource ids                        | **none exist.** No environment has ever been deployed; the account holds no D1, KV namespace or queue     |
| Reconciliation by logical name against the live API | `DEFERRED` — `check-deployment-topology.mjs` is named by this manifest's comments and does not exist yet  |
| Live verification (`pnpm infra:verify`)             | **not run.** Nothing has been deployed, so there is nothing to verify against                             |

## Status vocabulary

`IMPLEMENTED` means it exists and a named gate judges it. `DEFERRED` means it is
decided but not built. Anything describing a Cloudflare account, a resource id or
a running service is **not** `IMPLEMENTED`, because none of those things exists.

## Related

- [docs/operations/deployment-model.md](../docs/operations/deployment-model.md)
  — the Version / Deployment / Promotion model and who does what. The owner.
- [docs/security/secrets-management.md](../docs/security/secrets-management.md)
  — where secrets live. GitHub holds API tokens and nothing else; resource ids
  are discovered from Cloudflare at deploy time and never stored.
- [topology.schema.json](./topology.schema.json) — the shape, enforced with
  `unevaluatedProperties: false` so a new key cannot appear without someone
  writing down why.
- [tooling/scripts/render-wrangler-config.mjs](../tooling/scripts/render-wrangler-config.mjs)
  — the only thing in the repository that writes a wrangler config.
