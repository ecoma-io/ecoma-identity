# First deploy

What this document is: taking Ecoma Identity from nothing to a running
Cloudflare account, once, by hand — no pipeline, no tags, no CI.

What this document is **not**: the ongoing deploy process. That is
[../operations/release-process.md](../operations/release-process.md) and
[../operations/deployment-model.md](../operations/deployment-model.md). This is
the one-time setup, and it is deliberately manual so that every step is
understandable before a pipeline does it for you.

**This document cannot be followed today.** There is no Worker to deploy: all
three `apps/*/worker/src/lib.rs` files are one-line placeholders. The procedure
below is written so it is correct when the code exists, and so that the plan is
reviewable now. Every step that would fail today is marked.

## Status

| Fact                                                                          | State                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Three deployables and their names                                             | `IMPLEMENTED` for the count; the wrangler configs are `DEFERRED` |
| The binding set per deployable                                                | `PLANNED` — decided; the configs are `DEFERRED`                  |
| The canary ladder                                                             | `PLANNED` — constraint 19; the workflow is `DEFERRED`            |
| `wrangler` 4.144.0                                                            | `IMPLEMENTED` — pinned in `package.json`                         |
| A Cloudflare account, an API token, a D1 database, two KV namespaces, a queue | **None exist.** This document creates them.                      |
| Every `wrangler.jsonc` in this repository                                     | `DEFERRED` — none written                                        |
| Every step below                                                              | `DEFERRED` — cannot be executed until the code exists            |

## Before you start

You need:

- A Cloudflare account with Workers enabled.
- A Workers API token, scoped to the account, with permission to create
  Workers, D1, KV and Queues. Treat it as a secret: it goes in your shell
  environment or `wrangler`'s login, never in a tracked file.
- A hostname in that account if you want the custom domain rather than the
  `*.workers.dev` name.
- The toolchain from
  [local-development.md](local-development.md), installed and verified.

Authenticate. `wrangler login` opens a browser for a local session; for CI or a
headless machine, an API token in `CLOUDFLARE_API_TOKEN` is the route — the name
wrangler itself reads, locally and in a workflow alike. That token is a secret
by
[../security/secrets-management.md](../security/secrets-management.md)'s
definition.

In GitHub Actions the same token is stored once, as `ECOMA_CLOUDFLARE_API_TOKEN`.
There is deliberately no per-environment variant: one account has one token, and
staging is kept away from production by topology, naming and policy rather than
by holding a second credential.

```bash
wrangler whoami
```

If this does not print your account, stop. Every step below operates on whatever
account this reports, and "the wrong account" is the failure mode that creates a
resource nobody remembers deleting.

## Decide the naming first

Everything downstream is named, and names are compared by eye during an incident.
The names are already fixed, by the naming templates and the
`environments.production` block of
[../../infra-topology/topology.json](../../infra-topology/topology.json):

| Thing                               | Name                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Worker, production                  | `identity`, `identity-admin`, `identity-jobs`, `home-web`              |
| Worker, staging                     | The same four with `-staging` appended                                 |
| Configuration file, per environment | Generated: `.generated/cloudflare/<environment>/<name>/wrangler.jsonc` |
| Version tag                         | The git tag: `identity-v0.1.0`                                         |
| release-please component            | `identity`, `identity-admin`, `identity-jobs`                          |

**Nothing here is written by hand.** Change the topology and re-run
`pnpm infra:render`; a name that is typed into a config file is a name that can
disagree with the declaration it is supposed to come from.

**The Worker name is the same in development and in production.** That is not
an oversight; it is the decision the topology records: "`identity` in
development and `identity` in production are the same script name in the same
account but different environments", selected by which generated config wrangler
is pointed at. Staging is the exception and is named `identity-staging`.

The name alone therefore cannot tell you where a Worker is running, and two
properties follow from that, both worth stating because the alternative is easy
to accidentally adopt:

- **A staging deploy cannot be a production deploy**, because a promotion names a
  version id and the version id belongs to the Worker the config declared. The
  isolation comes from the declared name and the account namespace, not from a
  file path somebody typed.
- **The `-c` path is no longer a thing to get wrong.** The renderer writes
  `.generated/cloudflare/<environment>/<deployable>/`, the environment is an
  argument rather than a directory a human chose, and `pnpm arch` judges what it
  wrote. A staging promotion pointed at a production config is a mistake in the
  _promotion_, naming a version id, and not in a path.

So when you create the production resources, create them under the declared
names in the production account or namespace, and keep the per-environment
binding sets apart in the topology. The Workers must never share a D1 database, a
KV namespace, or a queue.

## Create the state, in dependency order

Order matters: a binding that names a resource which does not exist fails at
deploy time, not at create time, and the error is a deploy failure you have to
read rather than a create failure you could have avoided.

### 1. The D1 database — Identity only

```bash
wrangler d1 create identity
```

The output contains a `database_id`. **This is the only D1 database this
platform has.** Record it nowhere: the next deploy discovers it by name.

The constraint that matters: **Identity D1 is accessed only by the Identity
Worker.** The Admin Worker gets no D1 database — not a read-only one, not a
second one for reports. It reaches identity through the `IDENTITY` service
binding. The Jobs Worker gets no D1 binding at all. Full argument:
[../architecture/admin-isolation.md](../architecture/admin-isolation.md) and
[../architecture/jobs-isolation.md](../architecture/jobs-isolation.md).

Do not record the `database_id` anywhere — not in a shell history you will
lose, not in a tracked secret, not in a GitHub variable. A deploy resolves it
from the name `identity` by asking Cloudflare, and a copy written down somewhere
is a copy that can go stale and point a Worker at a database that has been
replaced.

### 2. The KV namespaces

```bash
wrangler kv namespace create IDENTITY_KV
wrangler kv namespace create JOBS_KV
```

Two, and both are **not authoritative**. `IDENTITY_KV` holds rate-limit and
counter state on the Identity Worker; `JOBS_KV` holds scratch and idempotency
state on the Jobs Worker. Neither is a source of truth for anything, and a
namespace that disagrees with D1 is a lost rate limit, not a lost account. If a
design ever needs KV to be authoritative, that is a constraint change and needs
an ADR — founding constraint 24 says no KV as authoritative identity state in
bootstrap.

Note what does **not** get a namespace: the Admin Worker has no KV. It has a
rate limiter, which is a different binding entirely.

### 3. The queue

```bash
wrangler queues create identity
```

One queue, `IDENTITY_QUEUE`. It is produced by the Identity Worker and consumed
by the Jobs Worker. The Jobs Worker may **not** also publish to it — a producer
and a consumer on one queue is a loop, and a loop with no owner is an outage
nobody can point at.

Do not configure a dead-letter queue on the first pass. The outbox's own attempt
ceiling (`OutboxEvent::MAX_DISPATCH_ATTEMPTS` = 25) dead-letters a row into a
`outbox_events` row you can query, which is more useful than a queue DLQ you
have to learn to read, and it keeps the fact. Add the queue DLQ when the volume
makes the dead letters worth an operator workflow.

### 4. The email provider

**Skip this step.** `EMAIL_PROVIDER` is explicitly `DEFERRED`. There is no
provider, and a binding naming a fetch handler that does not exist will fail at
deploy time. It is named in the binding table so the design is visible, not so
it is created. See
[../architecture/worker-architecture.md](../architecture/worker-architecture.md).

## Write the configuration

There is no configuration file to write. The per-environment configuration lives
in [../../infra-topology/topology.json](../../infra-topology/topology.json), and
`pnpm infra:render` turns it into the twelve `wrangler.jsonc` files the deploy
workflows upload. A generated config is not a secret file either: it names
bindings, and the credentials behind a Cloudflare binding live in Cloudflare.

The binding set per environment, from the table in
[../architecture/worker-architecture.md](../architecture/worker-architecture.md):

| Binding         | `identity`                  | `identity-admin`     | `identity-jobs`             |
| --------------- | --------------------------- | -------------------- | --------------------------- |
| D1              | `IDENTITY_DB`               | **none**             | **none**                    |
| KV              | `IDENTITY_KV`               | —                    | `JOBS_KV`                   |
| Queue           | `IDENTITY_QUEUE` (producer) | —                    | `IDENTITY_QUEUE` (consumer) |
| Service binding | —                           | `IDENTITY`           | `IDENTITY`                  |
| Rate limiter    | `RATE_LIMITER`              | `ADMIN_RATE_LIMITER` | —                           |
| Assets          | `ASSETS`                    | `ASSETS`             | —                           |

**Do not put a credential in the topology.** If a value there looks like a
secret, it is in the wrong place: either it is a binding name (fine) or it
belongs in `wrangler secret put` (not in a file). A binding's credentials are
Cloudflare's to hold, and the declaration only names them. `pnpm topology:validate`
refuses a credential-shaped value.

One check, and it is a real one:

```bash
pnpm arch
```

`boundary-1-admin-d1` reports `IDENTITY_DB` for `identity` and for nobody else,
in every environment. If it reports it twice, the Admin Worker has a database and
[../architecture/admin-isolation.md](../architecture/admin-isolation.md) no
longer applies. Stop and fix it before deploying.

## Set the secrets

Secrets go in via `wrangler secret put`, never in a tracked file.

```bash
pnpm infra:render   # writes .generated/cloudflare/production/identity/wrangler.jsonc
wrangler secret put SIGNING_KEY -c .generated/cloudflare/production/identity/wrangler.jsonc
```

Which secrets exist is `DEFERRED` — there is no signing key, because there is no
code that uses one. The full classification, the per-environment location of each
secret, and the rotation procedure for each is
[../security/secrets-management.md](../security/secrets-management.md). Read that
document before you invent a key: a secret with no documented rotation is a
permanent credential, and a local signing key that gets shared is a production
compromise waiting for the day someone promotes it.

## Apply the schema

**Skip this step.** The seven migrations in `database/identity/migrations/` are
not applied by a first deploy. Wrangler applies them on the first
`wrangler d1 migrations apply` against the named database, and the deployable's
`migrations_dir` points at that directory; nothing in a deploy step runs them,
because a deploy that migrates is a deploy whose rollback story nobody has read
(ADR-0011).

The rule you are implementing when you do, and it is the one constraint that has
no rollback path: migrations are **backward-compatible and forward-only**. A
migration may add a table, a column, an index, or a value to a check
constraint's vocabulary. It may widen a constraint. It may not remove or rename
anything a not-yet-rolled-back version reads, narrow anything it satisfies, or
change a value's meaning. A rename is a drop and an add wearing a disguise.

The reason is the rollback window: when you roll a Worker back by promoting an
older version id, that version is running against the current schema. If the
schema moved in a way it cannot read, the rollback turns a five-minute recovery
into a restore. See [../operations/rollback.md](../operations/rollback.md).

**And apply the schema through the Worker, not through a script.** Constraint 2
forbids a migration runner outside the Identity Worker. `wrangler d1 execute` is
a legitimate operator tool for inspecting and for the initial load; it is a
violation when a script or a pipeline uses it to apply migrations.

## Build and upload

**Skip this step.** There is nothing to build: all three Worker crates are
placeholders, and neither web app has a source tree.

The sequence, when the code exists:

```bash
# 1. Build the web app first. Its dist/ is static assets inside the version.
pnpm --filter ecoma-identity-web build

# 2. Build all three Workers.
pnpm build          # moon run identity:build identity-admin:build identity-jobs:build

# 3. Upload. This creates an immutable Version. It changes NO traffic.
wrangler versions upload -c .generated/cloudflare/production/identity/wrangler.jsonc
wrangler versions upload -c .generated/cloudflare/production/identity-admin/wrangler.jsonc
wrangler versions upload -c .generated/cloudflare/production/identity-jobs/wrangler.jsonc
```

Step 3 is the one that gets misread. **`wrangler versions upload` never changes
traffic.** A Worker you have uploaded to and never deployed serves its previous
Deployment, or nothing at all. Upload is staging a version; promotion is what
makes it live. Constraint 13, and the reason a version id is a meaningful thing
to hold.

## Smoke test the uploaded version

Do this **before** promoting anything, on every deployable.

What it should check, and what it will find today: the Identity Worker's
`Route::is_implemented()` says `false` for all seven protocol routes and `true`
for `/health` and `/ready`. A correct smoke test therefore expects **501 on
every OIDC route** and a 200 on the two health routes. A smoke test that expects
200 on `/oauth/authorize` is a smoke test that will pass once the code is wrong.

That expectation is the reason the route table exposes `is_implemented()` as one
function: the smoke test, the `/ready` probe, and a unit test all read the same
answer, so it cannot drift between the three.

```bash
# After uploading, before promoting: point the smoke test at the uploaded version.
# The concrete invocation depends on the wrangler config; the invariant is that it
# runs against the uploaded version, not against production.
```

**A note on the health routes.** `Route::is_implemented()` claims `/health` and
`/ready` are live, but the Worker crates are placeholders, so nothing serves
them yet. When the first deploy happens, these two probes are the first real
endpoints, and `/ready` must report that authentication is **not implemented** —
the same thing the documentation says. If `/ready` says otherwise, the
documentation is wrong or the probe is lying, and both are serious.

## Promote: admin and jobs first

```bash
# Read the version ids of what you just uploaded. Every id here is immutable and
# therefore a valid rollback target.
wrangler versions list -c .generated/cloudflare/production/identity-admin/wrangler.jsonc
wrangler versions list -c .generated/cloudflare/production/identity-jobs/wrangler.jsonc

# No human approval needed for these two (constraint 20). Straight to 100%.
# --version-id is always explicit: a promotion that lets wrangler guess which
# version you meant is a promotion you cannot describe afterwards.
wrangler versions deploy \
  -c .generated/cloudflare/production/identity-admin/wrangler.jsonc \
  --version-id <version-id> --percentage 100
wrangler versions deploy \
  -c .generated/cloudflare/production/identity-jobs/wrangler.jsonc \
  --version-id <version-id> --percentage 100
```

Do the Jobs Worker and the Admin Worker **before** the Identity Worker on a first
deploy. Neither can be useful without identity, and deploying identity first
means a first promotion with no consumers and no admin surface to observe it —
so the only thing the first deploy can tell you is what the identity routes do,
which you already know from the smoke test.

## Promote: identity, with the two gates

This is the ladder from [../operations/deployment-model.md](../operations/deployment-model.md).
**On a first deploy, the first gate is effectively automatic, because you are
the human and you are watching.** The ladder is still the right shape: deploy to
1%, then 10%, then 50%, then 100%, and stop at each step long enough to look.

```bash
# 1%. Watch.
/ready, /health, error rate, latency.

# 10%. The policy limit for automatic promotion.
# Look again. Then: HUMAN GATE 1.

# 50%. Then: HUMAN GATE 2.

# 100%.
```

What to look at between steps, given that there is almost nothing to see yet:

| Signal                                 | Where                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| The version actually serving           | `wrangler deployments list -c .generated/cloudflare/production/identity/wrangler.jsonc` |
| `/ready` answering truthfully          | probe it                                                                                |
| 501 on the OIDC routes                 | probe one; it is the expected state                                                     |
| 5xx                                    | the Worker log stream                                                                   |
| No unexpected 4xx on the admin surface | the admin Worker log stream                                                             |

The first thing that will be surprising is how little there is to see. That is
correct for a bootstrap, and it is the reason the ladder exists: a percentage of
requests that all 501 is not a detectable fault, and a percentage of requests that
were supposed to 200 and did not is. The ladder distinguishes the two.

## Wire the CI path, and verify it against what you did by hand

Everything above was manual. The pipeline must do the same things in the same
order, or the manual path and the automated path will drift and the manual path
will become a fiction.

The rules the pipeline must follow — all from
[../operations/release-process.md](../operations/release-process.md):

- GitHub Actions + Moon + Wrangler own CI and deployment (constraint 11).
- PR CI is affected-first, using Moon's affected graph (constraint 15).
- A merge to the default branch deploys **staging** automatically (constraint 16).
- The release PR is merged **by a human** (constraint 17).
- A tag triggers build, upload and smoke test, all automatic (constraint 18).
- Production promotion of `identity` needs the two human gates, implemented as
  `environment: production` on the 50% and 100% jobs (constraint 19).
- `identity-admin` and `identity-jobs` need no approval (constraint 20).
- **Release Please does not deploy anything** (constraint 10). It has no
  Cloudflare credentials and no `wrangler` invocation.

The verification that matters: deploy a no-op change through the pipeline to
staging, and confirm it produces the same artifacts the manual path produced. If
you cannot tell them apart, one of them is wrong and you do not know which.

## Add the custom domain

```bash
wrangler routes custom <identity-host> -c .generated/cloudflare/production/identity/wrangler.jsonc
```

Optional — the `*.workers.dev` subdomain works. Add it when you want the
environment to be identifiable from the hostname, which in production it
genuinely is: an incident where two environments share a hostname pattern is an
incident where someone tests against the wrong one.

The custom domain is also a trust decision. The issuer in the discovery document
must match the hostname clients will see, exactly, because `id_token` validation
compares the `iss` claim. A document served from `*.workers.dev` while clients are
told an `https://identity.ecoma.io` issuer is a mismatch every client will
reject — or, worse, a configuration where someone relaxes the check.

## What "done" looks like at the end of this

- Three Workers deployed, each serving the version you uploaded.
- `identity` at 100% of the new version, past both gates.
- `/health` and `/ready` answering 200, with `/ready` reporting that
  authentication is not implemented.
- The seven OIDC routes answering 501, which is correct.
- The Admin Worker holding no `IDENTITY_DB` — verified by `grep`, not by memory.
- The pipeline deployed to staging, producing the same artifacts as your manual
  build.
- A rollback rehearsed: promote the previous version id by hand, confirm traffic
  moved, promote forward again. **Rehearse it now**, while nothing is at stake.
  The first time anyone does a rollback should not be the first time anyone runs
  the command.

## Related

- [local-development.md](local-development.md) — the same setup locally.
- [../operations/deployment-model.md](../operations/deployment-model.md) — the
  Cloudflare model and the canary ladder.
- [../operations/rollback.md](../operations/rollback.md) — rehearsing the
  rollback is part of this document's definition of done.
- [../architecture/worker-architecture.md](../architecture/worker-architecture.md)
  — the binding table you are creating resources for.
- [../security/secrets-management.md](../security/secrets-management.md) — the
  secrets step.
