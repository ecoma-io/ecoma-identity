# Rollback

What this document is: the three rollback paths, the exact commands, how to find
a version id, and the rule that a rebuild is not a rollback.

What this document is **not**: a deploy procedure. Deploying a new version is
[deployment-model.md](deployment-model.md).

**The one rule, stated first because everything else follows from it:**

> Rollback promotes an **already-uploaded version id**. It never rebuilds, never
> re-runs a pipeline, never repackages.

Constraint 14. If your rollback plan involves a build, it is not a rollback plan.
It is a redeploy plan with extra steps and an outage in the middle, and the
reason is in the next section.

## Status

| Fact                                              | State                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Three rollback paths, decided                     | `PLANNED` — this document is the decision                        |
| `wrangler versions upload` ≠ `versions deploy`    | `PLANNED` — the Cloudflare model                                 |
| Every command below                               | `DEFERRED` — **no version has been uploaded to any environment** |
| The rollback workflow                             | `DEFERRED` — `.github/workflows/` is empty                       |
| A "which version is live?" query that works today | **No.** There is nothing deployed to query.                      |

**Nothing in this document can be run today**, because there is no deployment.
It is written so that when there is one, the procedure is already correct rather
than being worked out during an incident.

## Why a rebuild is not a rollback

A Cloudflare Version is immutable: a version id names exactly one set of bytes,
forever. That is what makes it a good rollback target.

A rebuild is not that. Consider what has to go right for a rebuild of yesterday's
code to produce yesterday's bytes:

- Every dependency resolves to the same version. `Cargo.lock` is committed,
  which handles the Rust side — but a `cargo update` in a `package.json` that
  uses a range, a base image that moved, or a platform-native binary that
  `wrangler`'s postinstall re-fetched will not reproduce.
- The build environment is the same. A different toolchain patch version, a
  different `workerd` binary, a different CPU target — each produces different
  bytes from identical source.
- Nothing was force-pushed to a branch the build read from.

A rebuild is therefore _probably_ equivalent, and "probably" is the entire
problem. A rollback needs a guarantee, because you are making the decision under
pressure with incomplete information about why the current version is bad. A
guarantee is a version id. Everything else is a hope.

There is a second, worse failure. A rebuild takes minutes to tens of minutes —
compilation, asset bundling, a version upload, and then the canary ladder again
if you follow process. In those minutes the bad version keeps serving 100% of
traffic, because nothing has changed the Deployment. A rollback by promotion
takes seconds and changes the serving version immediately. The rebuild does not
merely fail to be a rollback; it keeps the outage running while it prepares.

And a third: **a rebuild under incident pressure re-runs a pipeline that is
currently the thing you least trust.** If the pipeline is deploying the bad
build, or if a secret was rotated mid-incident and the pipeline is now failing
for an unrelated reason, the rebuild fails too, and now the rollback depends on
the failure you are already debugging.

The honest framing: a rebuild is a _forward fix_. It is sometimes the right
thing to do — when the previous version cannot be promoted because a database
migration has already removed something it reads, or when the bug is in
configuration that is not in the version. Both are cases where you cannot roll
back and must move forward deliberately. Neither is the default.

## Finding a version id

You need this before you can roll back, and during an incident is the wrong time
to be learning the command. The three ways, in order of reliability.

### 1. What is live right now

```bash
# The current Deployment for the identity Worker: which version, what percentage.
wrangler deployments list --name identity --env production
```

The output names the version id, the percentage of traffic it serves, and the
time it was created. This is the authoritative answer to "what is live", and it
is the first thing to run — before deciding anything.

### 2. The version history

```bash
# Every version uploaded for this Worker, newest first.
wrangler versions list --name identity --env production
```

Every version id here is immutable, so every one of them is a valid rollback
target. Note the version's tag and its creation time; you are looking for the
version immediately before the one that is currently live.

### 3. The version that carried a known-good tag

Version tags come from git tags, so a known-good version can be found from the
git side:

```bash
git tag --list 'identity-v*' --sort=-creatordate | head -5
```

Then match the tag against the Cloudflare version tag in
`wrangler versions list`. This is why version tags must be the git tag: it makes
"which version had tag X" a lookup rather than an inference.

**Write the version id down before you need it.** In an incident, a version id is
the difference between a five-minute rollback and a ten-minute archaeology
exercise.

## The three paths

### Path 1 — Worker version rollback (the normal path)

**When:** a promoted Worker version is bad, and the previous version can still
read the current schema. This is the default and covers most incidents.

**Precondition — check this first:** the previous version is compatible with the
current database schema. Migrations are forward-only and there is no database
rollback (constraint 21, `AGENTS.md` cites ADR-0011), so the previous version is
running against a schema that has moved on. If the bad deploy included a
migration, this path may not be available — see Path 3.

```bash
# Name the version explicitly. Do not use the bare form during an incident.
wrangler rollback <version-id> --name identity --env production
```

Then verify:

```bash
wrangler deployments list --name identity --env production
```

and probe the version that is now live:

```bash
curl -fsS https://<identity-host>/health
```

**For `identity`, roll back through the ladder rather than straight to 100%.** A
rollback of a canaried version should re-canary, because the reason you are
rolling back may be a fault that only appears at a particular traffic share. In
practice this means: promote the previous version at 10% first, watch it, then
take it to 100%. If the previous version was healthy at 100% for a long time,
promoting it at 100% directly is defensible — but say in the incident log that
is what you did and why.

**For `identity-admin` and `identity-jobs`, promote at 100% directly.** Neither
has the request-path exposure that motivates a ladder, and a jobs rollback that
creeps is a jobs rollback that takes ten minutes for a queue consumer.

### Path 2 — Traffic percentage rollback (the partial path)

**When:** a version is canaried and the fault appears below 100%, or the fault is
traffic-share-dependent — a cache cold-start, a rate limiter that behaves
differently at scale, a connection pool that exhausts under load.

**What it is:** change the Deployment's percentage, not the version. The bad
version stays uploaded and can be promoted again later once it is understood.

```bash
# Send 0% to the bad version: all traffic goes to the current other version.
wrangler versions deploy \
  --name identity --env production \
  --version-id <known-good-version-id> \
  --percentage 100
```

Or, to hold the bad version at a low share while investigating:

```bash
wrangler versions deploy \
  --name identity --env production \
  --version-id <new-version-id> \
  --percentage 1
```

**This is cheaper and faster than Path 1** and it loses nothing, because upload
and deploy are separate operations (constraint 13). A version that is uploaded
but not serving costs nothing and is still there. This is the direct operational
consequence of that constraint, and it is the reason the canary ladder is
practical at all.

**Which to prefer:** Path 2 when the previous version is _known good and
currently has traffic_; Path 1 when you want the previous version at 100% and do
not care about the bad version's Deployment entry. They produce the same serving
state in the common case. Path 2 is more explicit about which version is which.

### Path 3 — Forward fix (when there is no version to go back to)

**When** — all of these are cases where Path 1 and Path 2 are unavailable:

- The previous version cannot read the current schema. A migration removed or
  narrowed something it reads. Migrations are forward-only, so this is possible
  by construction and is the main reason the migration rule exists.
- The bad "version" is a configuration or secret change rather than a code
  change — a rotated signing key, a changed rate-limiter setting.
- The fault is in a dependency resolved at build time, and no good version
  exists because the first release was already bad.

**What it is:** a new version, uploaded and promoted like any other. It is a
redeploy, not a rollback, and it is legitimate here precisely because there is
nothing to roll back _to_. Every consequence follows: it goes through the
canary ladder, and the identity gates apply.

```bash
# Fix the code, then: build, upload, smoke, and promote through the ladder.
wrangler versions upload --name identity --env production
```

**Say so in the incident log.** A forward fix has a different risk profile from a
rollback — traffic stays on the bad version until the new one is live — and
someone reading the timeline afterwards needs to know which happened.

## What is not a rollback

| Action                                 | Why it is not a rollback                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `git revert` and re-push               | A forward fix. It produces a _new_ version. Legitimate, but it is a redeploy, and it takes minutes during which the bad version keeps serving. |
| `git checkout <old-tag> && pnpm build` | A rebuild. Probable, not guaranteed, and slow. See the section above.                                                                          |
| Re-running the deploy workflow         | Same problem, plus it re-runs a pipeline that may itself be the failure.                                                                       |
| `wrangler versions upload`             | Uploads bytes. Changes **no** traffic. Constraint 13.                                                                                          |
| Restoring a database from a backup     | There is no database rollback path, and this is not one. Migrations are forward-only; the schema moves forward and the Worker moves with it.   |
| Deleting the bad version               | Cloudflare versions are immutable and retained. You cannot delete history, and you should not want to — the bad version is the evidence.       |

## Before you roll back: is it the Worker?

Roughly half the incidents that look like a bad deploy are not one. The
diagnostic worth having in the same terminal as the rollback command:

```bash
# What is live, and since when?
wrangler deployments list --name identity --env production

# Is the version that is live the version you think is live?
wrangler versions list --name identity --env production

# Has a migration landed since the version you would roll back to?
ls database/identity/migrations/ | tail -5
```

That last one is the question Path 1 depends on. A version rolled back across an
incompatible migration is an outage with a different cause, and the rollback
looked like it worked because traffic moved.

## After you roll back

1. **Confirm the serving state**, not the command's exit code. Run
   `wrangler deployments list` and probe the live version.
2. **Write down the version id you rolled back to**, and the version id you
   rolled back from. Both are needed to reconstruct the timeline, and the bad
   one is evidence.
3. **Do not roll forward again until the cause is understood.** A second
   promotion of a version that was already rolled back is a version that is
   known to be bad under conditions nobody has characterised.
4. **Check the audit trail** for what the bad version did while it was live. See
   [observability.md](observability.md) — this is what an append-only,
   attributable audit trail is for, and it is the reason a rollback decision can
   be made from evidence rather than from a dashboard.
5. **Check the outbox.** A bad version may have committed outbox rows. Those rows
   are real facts in D1 and the dispatcher will deliver them regardless of which
   Worker version is live. If the bad version wrote events that should not have
   been written, that is a data problem and a forward fix, not something a
   rollback undoes.

That last point is the one people miss. A rollback changes which code serves
requests. It does not un-write anything the bad version already committed, and
the schema is forward-only by design, so there is no mechanism that would undo
it.

## Related

- [deployment-model.md](deployment-model.md) — the Version / Deployment /
  Promotion model, and why upload is not deploy.
- [release-process.md](release-process.md) — who decides to deploy, and the two
  human gates a rollback also passes through.
- [../architecture/data-model.md](../architecture/data-model.md) — the
  forward-only migration rule that makes Path 1's precondition necessary.
- [observability.md](observability.md) — the audit trail, for step 4.
