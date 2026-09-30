# Deployment model

What this document is: how Cloudflare's model actually works, which command
does what, the three deployables, and the canary ladder with its two human gates.

What this document is **not**: a runbook. The step-by-step commands for the
first deploy are in
[../getting-started/first-deploy.md](../getting-started/first-deploy.md), and
the three rollback paths are in [rollback.md](rollback.md).

Every command here is `DEFERRED` in the sense that **no environment exists yet**.
The model is decided; nothing has been uploaded.

## Status

| Fact                                                                  | State                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three deployables named `identity`, `identity-admin`, `identity-jobs` | `IMPLEMENTED` — the count is enforced by `pnpm arch`, and all nine wrangler configs exist                                                                                                                   |
| The task names CI and the deploy workflows address                    | `IMPLEMENTED` — the root `moon.yml` defines them                                                                                                                                                            |
| The Version / Deployment / Promotion model                            | `PLANNED` — decided; nothing uploaded                                                                                                                                                                       |
| The canary ladder and its two human gates                             | `PLANNED` — decided in ADR-0014; the workflows carrying them are `DEFERRED`                                                                                                                                 |
| `wrangler` pinned at 4.144.0                                          | `IMPLEMENTED` — `package.json` devDependencies                                                                                                                                                              |
| Every environment                                                     | `SCAFFOLDED` — all nine configs exist under `infra/cloudflare/<environment>/<worker>/wrangler.jsonc`, and their binding matrices are judged by `pnpm arch`; nothing is deployed and no account ids are real |

## The Cloudflare model, exactly

This is the part that is easy to get wrong from memory, so it is worth stating
precisely. Cloudflare Workers has three objects and they are not the same thing.

| Object         | What it is                                                        | Created by                 | Changes traffic?                                         |
| -------------- | ----------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| **Worker**     | The name. A stable endpoint that always serves _something_.       | The first upload           | No — it serves whatever the current Deployment points at |
| **Version**    | An immutable snapshot: code, bindings, and configuration, hashed. | `wrangler versions upload` | **No**                                                   |
| **Deployment** | A routing rule: "send _p_% of requests to version _V_".           | `wrangler versions deploy` | **Yes**                                                  |
| **Promotion**  | The act of creating or changing a Deployment.                     | The same command           | **Yes**                                                  |

The two commands that matter, and the distinction the whole release process
rests on:

```bash
# Creates an immutable Version. Uploads bytes. Binds nothing. Sends no traffic.
wrangler versions upload

# Creates a Deployment: <percentage>% of requests now go to <version-id>.
# This is the only thing that changes what the Worker serves.
wrangler versions deploy --version-id <id> --percentage <p>
```

`wrangler versions upload` never changes traffic. Ever. It is a staging area.
A Worker that has been uploaded to and never deployed serves the previous
Deployment, or nothing.

The consequence, which is the single most important operational fact in this
document: **the version id is the unit of deployment and of rollback.** A
version is immutable, so a version id names exactly one set of bytes forever. A
rollback is "send traffic to that id again", which takes seconds and cannot
produce different bytes than the id names. A rebuild produces a _new_ version,
so a rebuild is not a rollback no matter how faithfully it reproduces the
original — see [rollback.md](rollback.md).

The third command, and the one with a trap:

```bash
# Re-promotes a previous version.
wrangler rollback [version-id]
```

`wrangler rollback` is a promotion of an existing version id. It does not
upload, build, or repackage. Its default form (no id) rolls back to the previous
version, which is convenient and is the wrong tool in an incident where you need
to name exactly which version — naming it is what makes the action reviewable
afterwards.

## The three deployables

| Deployable       | wrangler worker name | moon project     | Releases with                               |
| ---------------- | -------------------- | ---------------- | ------------------------------------------- |
| `identity`       | `identity`           | `identity`       | A frontend and its BFF are one release unit |
| `identity-admin` | `identity-admin`     | `identity-admin` | Same rule                                   |
| `identity-jobs`  | `identity-jobs`      | `identity-jobs`  | Its own; no frontend                        |

The names are identical across wrangler, moon, release-please, git tags and
Cloudflare version tags, deliberately. A tag, a version id and a worker name that
can be compared by eye are worth more than a consistent naming scheme that
includes the language a project happens to be written in. The moon project IDs
are `identity-worker` and friends; the _aliases_ are the deployable names, and
`moon run identity:dev` resolves through the alias.

## Per-project moon tasks

The root `moon.yml` defines the vocabulary, and per-project `moon.yml` files
override the JavaScript-flavoured defaults for Rust. CI, lefthook and the deploy
workflows all address tasks by name, so **renaming one is a cross-repo-visible
change.**

| Task                      | Root definition                | What CI uses it for                                      |
| ------------------------- | ------------------------------ | -------------------------------------------------------- |
| `format` / `format:check` | `prettier --write` / `--check` | The `format:check` gate                                  |
| `lint`                    | `eslint .`                     | The lint gate                                            |
| `typecheck`               | `tsc --noEmit`                 | The TypeScript gate                                      |
| `test` / `test-unit`      | per-project                    | The test gate                                            |
| `build`                   | per-project                    | Produces the artifact that gets uploaded                 |
| `dev`                     | `local: only`                  | Never in CI — a task that never returns hangs a pipeline |
| `package`                 | per-project                    | The deployable artifact                                  |
| `wrangler-validate`       | per-project                    | Validates each `wrangler.jsonc`                          |

Two of those deserve a note because they look like mistakes and are not:

- **`cache: false` on the cargo tasks.** Cargo's own `target/` and the committed
  `Cargo.lock` are the cache of record. A moon-cached cargo task that misses an
  input — a workspace-level dependency change, a lint config — would report a
  stale verdict as green. Slow and honest beats fast and wrong.
- **`dev` is `local: only`.** It starts a long-running process, so it is never
  cached and never part of `moon ci`.

## The canary ladder

Constraint 19: **Identity production canaries automatically to the policy limit,
but the final promotion requires human approval.** Constraint 20: **Admin and
Jobs production need no manual approval.**

`identity`:

```
wrangler versions upload
  → smoke test against the uploaded version
  → 1%   traffic        (automatic)
  → health gate         (automatic; aborts on a failed probe)
  → 10%  traffic        (automatic — the policy limit)
  ═══ HUMAN GATE 1 ═══
  → 50%  traffic        (requires environment: production approval)
  ═══ HUMAN GATE 2 ═══
  → 100% traffic        (requires environment: production approval)
```

`identity-admin` and `identity-jobs`:

```
wrangler versions upload
  → smoke test against the uploaded version
  → 100% traffic        (fully automatic, no approval)
```

**The two human gates, and what they are for.** The ladder is not ceremony; each
gate exists because of a specific failure the percentage below it cannot catch.

- **The gate at 10%.** By the time 10% of production traffic has been through
  the new version, the failure modes that only appear with real data are visible:
  a cache that was warm in staging and is cold here, an OIDC client that
  negotiates a way no test did, a migration that meets rows the fixtures did not
  have. The first 10% is fast — minutes, not hours — and its purpose is to
  convert a percentage of a bad deploy into a bounded number of bad requests
  rather than all of them.
- **The gate at 50%.** This is the one that costs the most to get wrong and the
  one most often removed under schedule pressure. At 50%, a rollback is
  unambiguous: half the requests failed. Above 50%, rolling back is no longer
  obviously correct, because the split is a coin flip and the incident has
  already lasted long enough to matter. A human deciding "is this version
  healthy enough to be the majority" is a judgement about _duration_ as much as
  correctness, and it is not automatable.

**Why Admin and Jobs do not get gates.** They are not on the request path for
end users. `identity-admin` is an internal surface reached by a small number of
operators, and `identity-jobs` has **no public route at all** — it consumes a
queue. Neither has the 1%-of-production-traffic failure mode that motivates the
ladder. Their smoke test is the gate. Adding a human approval to an automatic
deploy of a worker with no public route buys nothing and costs a deployment that
happens when somebody happens to be looking.

**The gate is a CI environment, not a convention.** In GitHub Actions this is an
`environment:` key on the promoting job, configured to require reviewers. That
matters because a convention is a decision somebody makes under time pressure,
and an environment is a thing the runner refuses to pass. The identity
promotion jobs for 50% and 100% carry `environment: production`; the jobs at 1%
and 10% do not.

## Environments

Three environments, one per directory under `infra/cloudflare/`:

| Environment | Directory                       | Deployed by                                                             | Approval                 |
| ----------- | ------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| development | `infra/cloudflare/development/` | `wrangler dev` locally                                                  | none                     |
| staging     | `infra/cloudflare/staging/`     | Automatically, after a merge to the default branch (constraint 16)      | none                     |
| production  | `infra/cloudflare/production/`  | Post-tag, automatic build/upload/smoke (constraint 18), then the ladder | Two gates, identity only |

Staging deploys automatically after a merge; that is the constraint, and it is
why a merge to the default branch is not a local event but the trigger for a
deployment. The staging environment has its own database and its own KV; nothing
is shared with production, because a shared staging database is a staging
environment that can corrupt production data through a test.

## What is deployed from what

A Worker version is built from three inputs, and all three are in the version:

1. The Worker binary.
2. The bindings and their configuration — which databases, which queues, which
   service bindings.
3. **The static assets**, because each Worker ships its web app's `dist/` as
   Cloudflare Static Assets.

Point 3 is why constraint 8 says a frontend and the BFF behind it are one
release unit. They are not coupled by a workspace dependency — the pnpm workspace
covers the TypeScript side and the Cargo workspace covers the Rust side, and
"the two meet nowhere directly". They are coupled by a **directory**: the Vue
build output feeds the Rust build output, and both are inside the one version. A
version that serves a new API with an old UI, or an old API with a new UI, is a
version that was built from the wrong directory, and the packaging is what makes
that a packaging failure rather than a judgement call.

## Version identity and traceability

Every version id should be traceable to a commit. The tag that triggered the
build is the version's identity: `identity-v0.1.0` produces a version whose
Cloudflare version tag is the same string, and the commit is recoverable from
the tag.

This matters for rollback more than it does for deploy. A rollback decision is
"go back to the version before the one that broke", and that is only a decidable
question if each version names its commit. See [rollback.md](rollback.md) for
how to find a version id, and [release-process.md](release-process.md) for who
creates the tags.

## Related

- [release-process.md](release-process.md) — who cuts a release, who promotes
  it.
- [rollback.md](rollback.md) — the three rollback paths, and the no-rebuild
  rule.
- [../architecture/worker-architecture.md](../architecture/worker-architecture.md)
  — the bindings each deployable has, which is what a version binds.
- [../getting-started/first-deploy.md](../getting-started/first-deploy.md) —
  doing this once, by hand, with no pipeline.
