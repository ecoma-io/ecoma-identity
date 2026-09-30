# Cloudflare infrastructure

What this file is: the map of what lives under `infra/cloudflare/`, which
workflow uses each piece, and which facts are decided versus which are deferred.

What this file is **not**: a runbook. The step-by-step commands are in
[docs/operations/deployment-model.md](../../docs/operations/deployment-model.md)
and [docs/operations/rollback.md](../../docs/operations/rollback.md), and this
file deliberately restates none of them.

## Status

| Fact                                                                      | State                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Nine wrangler configs, three environments by three Workers                | `IMPLEMENTED` — all nine exist, and `pnpm arch` judges their binding matrices            |
| Every config parses and passes wrangler's own validation                  | `IMPLEMENTED` — `moon run :wrangler-validate` compiles each one in CI against a dry run  |
| Staging deploys automatically on merge to `main`                          | `IMPLEMENTED` — `.github/workflows/deploy.yml`                                           |
| Production deploys on a release tag, `identity` through a two-gate ladder | `IMPLEMENTED` — `.github/workflows/deploy-production.yml`                                |
| Placeholder ids in production configs are injected at deploy time         | `IMPLEMENTED` — `deploy-worker.yml` generates a copy, validates it, and deletes it       |
| A Cloudflare account                                                      | **none exists.** No config below has ever been uploaded                                  |
| Production resource ids                                                   | **none exist.** Every production id is a placeholder                                     |
| A `production` GitHub environment with required reviewers                 | **not configured yet** — see [The two gates are not armed](#the-two-gates-are-not-armed) |

**No environment has ever been deployed.** Everything below describes a shape
that exists and a process that would run, not a service that is running.

## The nine configs

Three environments by three Workers, and the directory layout is what the deploy
workflows address — `deploy-worker.yml` builds its path from
`infra/cloudflare/<environment>/<worker>/wrangler.jsonc`, so renaming a
directory breaks both workflows at once.

| Environment    | `identity`         | `identity-admin`         | `identity-jobs`         |
| -------------- | ------------------ | ------------------------ | ----------------------- |
| `development/` | `identity`         | `identity-admin`         | `identity-jobs`         |
| `staging/`     | `identity-staging` | `identity-admin-staging` | `identity-jobs-staging` |
| `production/`  | `identity`         | `identity-admin`         | `identity-jobs`         |

**The staging suffix is a safety property, not a naming convention.** Staging is
a separate Cloudflare script rather than a separate environment of the
production script, because without the suffix the two configs would name the same
script and deploying from the staging file would put staging code on
production. This is why `deploy-worker.yml` takes `worker` and `worker-name` as
separate inputs: the component name selects the directory and the moon project,
while the script name selects what actually gets promoted, and in staging the two
differ.

Development is for `moon run identity:dev` and nothing else. No workflow
deploys it — local `wrangler dev` serves it directly.

## The two document classifications of a resource id

The production configs and the secrets document disagree about what a Cloudflare
resource id is, and the disagreement is recorded here rather than resolved by
quietly picking one.

- **The production configs** say a `database_id`, a KV namespace `id`, a queue
  name and a service name are **bearer-grade production secrets**, on the grounds
  that "anyone holding the production D1 id plus any credential that can reach it
  has the identity database". They carry `PRODUCTION_…` placeholders.
- **[docs/security/secrets-management.md](../../docs/security/secrets-management.md)**
  lists "a database id, a queue name, a KV namespace id" under **"Configuration,
  not a secret … In a tracked `wrangler.jsonc`. Public by construction."**

The authority map in `AGENTS.md` makes `secrets-management.md` the owner of
"where secrets live", so `.github/workflows/deploy-production.yml` currently
takes the injected values from **repository variables** (`vars:`), matching the
owner document.

What is _not_ in dispute, and is what the placeholder mechanism actually
protects against: **no production id is committed, and no id is ever printed.**
`deploy-worker.yml` substitutes into a generated copy that is deleted in the same
job, and the substitution is a text replacement, so a value never reaches a log
line, a process listing or an artefact upload. The unresolved part is only
whether GitHub should hold these in its variable store or its secret store.

Whoever reconciles the two should change **both documents in one commit**, in
the direction they decide, and say which one moved — per the "one fact, one
owner, fix the other in the same commit" rule in `AGENTS.md`.

## How the production placeholders are injected

The nine placeholder tokens that appear in the production configs:

| Token                                        | Config                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| `PRODUCTION_IDENTITY_DB_DATABASE_ID`         | `production/identity`                                   |
| `PRODUCTION_IDENTITY_KV_NAMESPACE_ID`        | `production/identity`                                   |
| `PRODUCTION_IDENTITY_QUEUE`                  | `production/identity`, `production/identity-jobs`       |
| `PRODUCTION_RATE_LIMITER_NAMESPACE_ID`       | `production/identity`                                   |
| `PRODUCTION_IDENTITY_WORKER`                 | `production/identity-admin`, `production/identity-jobs` |
| `PRODUCTION_ADMIN_RATE_LIMITER_NAMESPACE_ID` | `production/identity-admin`                             |
| `PRODUCTION_EMAIL_PROVIDER`                  | `production/identity-jobs`                              |
| `PRODUCTION_IDENTITY_QUEUE_DLQ`              | `production/identity-jobs`                              |
| `PRODUCTION_JOBS_KV_NAMESPACE_ID`            | `production/identity-jobs`                              |

Two properties make this fail loudly rather than quietly:

1. The generation step **exits non-zero** if a `PRODUCTION_…` token survives the
   substitution, or if any token was given an empty value. A config that kept a
   placeholder would upload a Worker bound to nothing and then promote it.
2. The generated copy is validated by `wrangler deploy --dry-run` **before** the
   upload, so an unreadable config fails before a version exists rather than two
   approvals later.

The generated file is `wrangler.generated.jsonc`, written **into the config's own
directory** so that `main`, `assets.directory` and `$schema` keep resolving
relative to the config, and it is deleted with `if: always()` so a mid-job
failure cannot leave it on the runner.

### `infra/cloudflare/vars.example` does not exist

The production config comments point at `infra/cloudflare/vars.example` as the
list of what an operator must set. **That file does not exist**, and this file
says so rather than treating the reference as satisfied. It belongs to whoever
owns `infra/cloudflare/`, and it is a small piece of work: the token list is
already the table above.

## The two gates are not armed

`deploy-worker.yml` promotes `identity` to 50% and then to 100% in **two
separate jobs**, each carrying `environment: production`. That is the shape
ADR-0014 requires, and the separation is the point: approving 50% is not
approving 100%, and a release that is healthy at 50% may legitimately stop there.

**A `production` GitHub environment with required reviewers is not configured
yet.** The environment key is correct and becomes a real gate the moment the
setting exists, but until an administrator adds the reviewers, both gates pass
on click-through. ADR-0014's own enforcement table records this as
"enforcement not yet built", and `.github/repository-settings.json` carries no
environment entry. Until then, the two approvals are a UI step rather than a
control, and this file will not claim otherwise.

## What each deploy workflow does with these files

| Workflow                                                               | Trigger                                   | Configs it uses                           | Injects ids                       | Approval                                       |
| ---------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | --------------------------------- | ---------------------------------------------- |
| [deploy.yml](../../.github/workflows/deploy.yml)                       | merge to `main`                           | all three `staging/`                      | no — ids are in the tracked files | none, anywhere                                 |
| [deploy-production.yml](../../.github/workflows/deploy-production.yml) | a release tag, or dispatch with a tag     | all three `production/`                   | yes — into a generated copy       | two gates on `identity`; none on admin or jobs |
| [rollback.yml](../../.github/workflows/rollback.yml)                   | dispatch only, never automatic            | **none — it reads no config at all**      | no                                | n/a — a human always                           |
| [ci.yml](../../.github/workflows/ci.yml)                               | pull request, merge queue, push to `main` | all nine, via `wrangler deploy --dry-run` | no                                | n/a — CI never deploys                         |

The CI row is the one that is easy to misread: `wrangler-validate` compiles each
Worker against its **development** config on every pull request. It proves a
config is loadable and a Worker compiles. It uploads nothing and promotes
nothing, and it says so in the config it validates.

The `rollback.yml` row is the one worth reading twice, because "uses none of
these files" is the enforcement rather than an omission. A rollback promotes an
existing version id, which is a routing rule over a Worker name — so it needs
`--name` and a version id and nothing else. **It has no `checkout` step at all**,
which means no source tree exists on its runner and a build cannot happen there
even by accident (ADR-0013).

## Adding an environment or a Worker

Neither is a small change and neither is a config edit:

- **A fourth Worker** needs an ADR before any code lands
  ([ADR-0002](../../docs/adr/0002-three-deployables-and-no-more.md)), because
  the count of three is enforced by `pnpm arch`.
- **A fourth environment** needs its own row in every table in this file, its own
  `vars` block, and an answer to "which Cloudflare account" — staging and
  production must be different accounts or visibly different ids, because a
  shared database between them is how a staging deploy destroys production data.

## Related

- [docs/operations/deployment-model.md](../../docs/operations/deployment-model.md)
  — the Version / Deployment / Promotion model and the ladder. The owner.
- [docs/operations/rollback.md](../../docs/operations/rollback.md) — the three
  rollback paths, and why none of them rebuilds.
- [docs/operations/release-process.md](../../docs/operations/release-process.md)
  — who releases and who deploys, and why those are different people.
- [docs/architecture/worker-architecture.md](../../docs/architecture/worker-architecture.md)
  — which bindings each Worker may hold. `boundary-1-admin-d1` and
  `boundary-2-jobs-isolation` judge these nine files.
- [ADR-0013](../../docs/adr/0013-immutable-worker-versions.md) — upload is not
  promotion, which is why these files are addressed by version id.
