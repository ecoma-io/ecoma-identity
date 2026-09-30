# Immutable Worker versions; rollback never rebuilds

<!--
What this file is: ADR-0013, the record of the Version → Deployment → Promotion
model, the rule that upload is not promotion, and why a rebuild is a forward fix
wearing a rollback's name.

What this file is **not**: a rollback runbook and not a set of commands.
`docs/operations/rollback.md` owns the three paths and the exact invocations; this
ADR is the decision underneath them.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `.github/workflows/rollback.yml`,
  `docs/operations/deployment-model.md`
- **Constraints covered:** 9, 12, 13, 14, 21, 29

## Context

Cloudflare Workers has three distinct objects, and the difference between them is
the whole basis of this decision. `docs/operations/deployment-model.md` states it
precisely and this ADR does not restate it: a **Worker** is the name, a **Version**
is an immutable snapshot of code, bindings and configuration, and a **Deployment**
is a routing rule sending _p_% of requests to a version. Two commands matter:

```bash
wrangler versions upload                                    # creates a Version. No traffic.
wrangler versions deploy --version-id <id> --percentage <p> # creates a Deployment. This is what moves traffic.
```

`wrangler versions upload` never changes traffic. Ever. It is a staging area. This
is constraint 13, and it is the single most important operational fact in the
platform, because it is what makes a canary
([ADR-0014](0014-canary-promotion-identity.md)) cheap rather than risky: an
uploaded version that is not serving costs nothing and is still there, so a
half-finished promotion leaves no damage.

**A version id is therefore the unit of everything.** Because a version is
immutable, a version id names exactly one set of bytes forever. A rollback is
"send traffic to that id again", which takes seconds and _cannot_ produce
different bytes than the id names. And a rebuild produces a _new_ version with a
new id — so a rebuild is not a rollback, no matter how faithfully it reproduces
the original. That is constraint 14.

The load-bearing part of that is not "a rebuild is a different id". It is _when a
rebuild fails_. A rebuild takes minutes to tens of minutes: compilation, asset
bundling, a version upload, and the canary ladder again if you follow process.
During those minutes the bad version keeps serving 100% of traffic, because
nothing has changed the Deployment. So the rebuild does not merely fail to be a
rollback; **it keeps the outage running while it prepares.**

Three things have to go right for a rebuild of yesterday's code to produce
yesterday's bytes, and each is a thing that can be true on the day you need the
rollback and false the moment after: every dependency resolves to the same version
(`Cargo.lock` is committed, which handles the Rust side, but a range in a
`package.json`, a moved base image or a re-fetched platform binary will not
reproduce); the build environment is the same (a different toolchain patch, a
different `workerd` binary, a different CPU target); and nothing was force-pushed
to a branch the build read from. A rebuild is _probably_ equivalent. "Probably" is
the entire problem — a rollback needs a guarantee, because you are making the
decision under pressure with incomplete information about why the current version is
bad.

And there is a third failure, worse than the other two together: **a rebuild under
incident pressure re-runs a pipeline that is currently the thing you least
trust.** If the pipeline is deploying the bad build, or a secret was rotated
mid-incident and the pipeline is now failing for an unrelated reason, the rebuild
fails too — and now the rollback depends on the failure you are already debugging.

The honest framing, which `docs/operations/rollback.md` also makes: a rebuild is a
_forward fix_. It is sometimes correct — when the previous version cannot be
promoted because a migration has removed something it reads
([ADR-0011](0011-forward-only-migrations.md)), or when the fault is in
configuration that is not in the version. Both are cases where you cannot roll
back and must move forward deliberately. Neither is the default.

## Decision drivers

- A rollback must be a guarantee, not a hope, and only an immutable artifact
  provides one.
- A rollback must be fast enough to be used during an outage, and a rebuild is
  not.
- A rollback must not depend on the toolchain, the network or the pipeline that
  are already suspected.
- A bad version must be preserved as evidence: Cloudflare versions are immutable
  and retained, and the audit trail
  ([ADR-0007](0007-outbox-pattern.md)) holds the events it committed.
- Upload must be separable from promotion, or a half-finished promotion is
  destructive and a canary is expensive.
- Every deployed version must name its commit, or a rollback decision is an
  archaeology exercise.

## Decision

**Worker versions are immutable. `wrangler versions upload` creates a version and
changes no traffic. `wrangler versions deploy --version-id <id> --percentage <p>`
is the only thing that moves traffic. `wrangler rollback` re-promotes an
already-uploaded version id. A rollback never rebuilds, never re-runs a pipeline
and never repackages; a rebuild produces a new version and is a forward fix, named
as one.**

From now on:

1. **Upload is never promotion.** A version that is uploaded and not promoted
   serves no traffic, costs nothing and is still there. Every workflow in this
   repository separates the two, and the separation is a constraint on the shape
   of the workflow, not a habit.
2. **A rollback names an existing version id and promotes it.** It does not check
   out, build, test, package or upload. `AGENTS.md` lists this under Prohibited
   shortcuts: "No rollback that checks out, builds, tests or packages."
3. **A rebuild is a forward fix and is labelled one.** When there is no version to
   go back to — the previous version cannot read the current schema, the fault is
   in a configuration or secret change rather than a code change, or no good
   version ever existed — the correct act is a new version promoted through the
   normal ladder, with the reason recorded in the incident log. The two are the
   same commands and different things, and the label is the difference.
4. **A rollback decision is "which version id", found before it is needed.**
   `wrangler deployments list` answers "what is live", `wrangler versions list`
   answers "what else exists", and a version's Cloudflare version tag is its git
   tag (`identity-v0.1.0`), which makes "which version had tag X" a lookup rather
   than an inference.
5. **The bad version is not deleted.** Cloudflare versions are immutable and
   retained; the bad version is the evidence, and the audit trail shows what it
   did while it was live.
6. **A rollback changes which code serves requests. It does not un-write
   anything the bad version committed.** A bad version may have committed outbox
   rows and audit events; those are real facts in D1 and the dispatcher will
   deliver them regardless of which version is live. A rollback is not a data
   rollback, and
   [ADR-0011](0011-forward-only-migrations.md) means there is no mechanism that
   would make it one.
7. **For `identity`, a rollback re-canaries; for `identity-admin` and
   `identity-jobs`, it promotes straight to 100%.** The reason you rolled back may
   be a fault that only appears at a particular traffic share, and a background
   consumer that creeps is a consumer that takes ten minutes to roll back.

**Enforcement:**

| Boundary                                                    | Enforced by                                                                                                                                                                                                                                                                                                                 | Exists today                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A rollback workflow contains no checkout and no build step  | `.github/workflows/rollback.yml`: its steps are `wrangler deployments list` / `wrangler versions list` / `wrangler rollback <version-id>`, and it takes a version id as an input rather than discovering one by building. The absence of an `actions/checkout` and a `moon run :build` step in that file is the enforcement | **Enforcement not yet built.** `.github/workflows/` is empty at the time of writing; the file is `DEFERRED` to the release phase |
| Upload is never promotion                                   | The two-step shape in the deploy workflow: `wrangler versions upload` in one job, `wrangler versions deploy --version-id` in a later one, with the version id passed between them                                                                                                                                           | **Enforcement not yet built**; the workflow is `DEFERRED` to the release phase                                                   |
| Every promotion names an uploaded version id                | The deploy and rollback workflows' inputs, and `docs/operations/rollback.md` Path 3 being the only build-then-promote path, named a forward fix                                                                                                                                                                             | **Enforcement not yet built**; see above                                                                                         |
| The version tag is the git tag                              | The release workflow's tagging step and the version tag passed to `wrangler versions upload`                                                                                                                                                                                                                                | **Enforcement not yet built**; the release workflow is `DEFERRED` to the release phase                                           |
| The architecture gate does not claim a rollback path exists | `pnpm arch` reports a check that could not run as `skipped` rather than as a pass; no check in `tooling/scripts/check-architecture.mjs` judges rollback, and the ADRs say so                                                                                                                                                | Yes — the `skipped` reporting is implemented in the script, and the script is landing concurrently                               |

## Consequences

### Easier

- **Rollback is a two-minute operation with a guarantee.** A version id names one
  set of bytes forever, so a rollback cannot produce different bytes than the id
  names, whatever happened to the toolchain in the meantime.
- **Rollback does not depend on the thing you are debugging.** No build, no
  network, no pipeline, no checkout. If the pipeline is what is broken, the
  rollback still works — which is the whole point of the third failure mode being
  named.
- **A canary is cheap and reversible.** An uploaded version that is not serving
  costs nothing and is still there, so 1% and 10% are genuinely low-stakes
  ([ADR-0014](0014-canary-promotion-identity.md)) and a failed promotion is
  abandoned rather than cleaned up.
- **"What is live?" is a Cloudflare question with a one-command answer**, and the
  git tag tells you which commit that version was built from. Traceability from a
  deployed version back to a commit is a lookup.
- **The evidence survives.** A bad version is retained and immutable; the audit
  trail shows what it committed; an incident review can reconstruct the timeline
  from both.
- **The rule is checkable by reading one file.** `rollback.yml` either contains a
  build step or it does not. That is a review a human can do in thirty seconds,
  which is the right cost for the operation you will use under pressure.

### Harder or more expensive

- **A rollback that rebuilds is a decision someone has to be talked out of
  every time.** The conversation is always "but I can just rebuild it", and the
  answer is a three-part argument about minutes, probability and pipeline trust.
  Expect to have it during an incident, which is the worst time for a
  three-part argument.
- **The previous version may not be promotable**, because a migration has
  forward-only moved past it
  ([ADR-0011](0011-forward-only-migrations.md)). That is the case
  `docs/operations/rollback.md` Path 3 exists for, and the precondition check —
  "has a migration landed since the version you would roll back to?" — is a step
  people skip under pressure.
- **Finding the version id is separate work.** Nobody memorises a version id, and
  the guidance is to write it down before it is needed, which is a discipline
  rather than a tool. `docs/operations/rollback.md` spends a section on it for
  that reason.
- **The deployed version is not necessarily the latest release.** A rollback puts
  an older version live while the newest tag exists, which is legitimate and
  necessary and does need explaining to someone who has not read the
  release-process document.
- **The rollback workflow's correctness is not exercised by anything.** There is
  no rehearsal, because rehearsing a rollback means rolling back. The mitigation
  is the narrowness of the file — few steps, no build, a version id as an input —
  rather than a test, and that is a weaker guarantee than it looks.

### What a future maintainer will resent

- **"But I can just rebuild it."** It is the sentence, and it is the reason this
  ADR exists. The answer is that a rebuild keeps the outage running while it
  prepares, is only _probably_ equivalent, and re-runs the pipeline you least
  trust. If a forward fix is genuinely the right move, that is Path 3 and the
  reason goes in the incident log.
- **A rollback across a migration that was applied between the two versions.** The
  rollback appears to work — traffic moved — and the cause is different from the
  one you diagnosed. This is the single most confusing incident in this system
  and it is entirely foreseeable, which is why the migration check is a step
  rather than a hope.
- **A rollback that does not undo a bad version's committed writes.** People
  expect a rollback to be a rewind, and this one is only a change of traffic. The
  outbox rows and audit events a bad version wrote are real facts; correcting them
  is a forward fix.

## Alternatives considered

### Roll back with `git revert`, rebuild, and re-publish

**Rejected.** It is a forward fix wearing a rollback's name, and it is the
alternative most repositories actually use. It fails on the three counts
established in the Context: minutes during which the bad version keeps serving,
"probably" rather than "guaranteed" byte-equivalence, and a dependency on a
pipeline that may be the thing you are debugging. It also has a specific extra
failure here: if the bad version is what broke the pipeline, or if the pipeline is
failing for an unrelated reason during the incident, the revert-and-redeploy path
is unavailable at the moment you need it — so the one time you need a rollback is
the time it is most likely to fail. It is retained as Path 3, the legitimate
forward fix, and it is labelled as such.

### Roll back by checking out the previous tag and rebuilding

**Rejected**, and the distinction from the above is worth being precise about,
because both are "a rebuild". This one additionally pins the source, so the
failure surface narrows to the toolchain and the dependency resolution. It is
still a rebuild: still minutes, still "probably", still a pipeline dependency, and
`AGENTS.md` names it explicitly — "No rollback that checks out, builds, tests or
packages." The two look the same to a person in a hurry and the difference is
only the size of the gap between "probably" and "guaranteed", which is why
neither is permitted.

### Re-run the deploy workflow to "just get back to a known state"

**Rejected** for the same reasons plus one: the deploy workflow is the pipeline
that built the version you are rolling back _from_. Re-running it is a rebuild
whose inputs are the current state of the default branch, not the previous
version. It is a redeploy of whatever is at the tip, which may be a third thing
entirely.

### Cloudflare's own automatic version rollback (Traffic Splits / automatic

failback to the previous deployment)

**Rejected**, and it deserves a careful answer because it is the platform's
default behaviour and it is genuinely good for availability. It loses on the two
things this platform's decision turns on. First, **auditability and
deliberateness**: an automatic failback moves traffic without naming a version id,
so the incident timeline records "it went back" rather than "it went back to
`<version-id>`", and a half-failed promotion leaves two deployments with
ambiguous percentages. Second, **the ladder does not apply to a failback**: the
rollback path in `docs/operations/rollback.md` re-canaries `identity` precisely
because the reason for rolling back may be traffic-share-dependent, and an
automatic failback typically goes straight to the previous version at 100%. It is
retained conceptually as the reason a human decides, and the decision to roll back
is a human's per `docs/operations/release-process.md`.

## Revisit when

- **Cloudflare offers a first-class, audited rollback that names the version id
  and is a single promotion.** That would be this ADR's tool, and the
  implementation would not change — the decision is that a rollback is a promotion
  of an existing id, and `wrangler rollback` already is one. The condition is
  observable as: `wrangler rollback` becoming available with the version id in its
  output and an audit record.
- **The identity Worker is no longer on the end-user request path** — retired, or
  replaced by a surface with a different failure profile. Then the re-canary rule
  (step 7) and possibly the whole promotion strategy are re-examined, and this ADR
  is a [ADR-0014](0014-canary-promotion-identity.md) question as much as its own.
- **A deployment ever needs to be withdrawn rather than rolled back** — for
  example a version that was mis-uploaded with a secret in its bindings. Cloudflare
  versions are immutable and retained, so this would be a new question, and the
  answer would have to reconcile "immutable" with "must not remain promotable".
- **The gap between "the bad version" and "the previous version" grows** — the
  canary has been in production for a long time and each release adds a version,
  so "the previous one" is ambiguous under time pressure. The answer is a written
  record of the live version id, not a change to this ADR.
- **A rollback itself is suspected of having caused an incident** — for example a
  promotion to 50% of a version that was already known to be traffic-share
  dependent. That is evidence for the re-canary rule being right, and it is also
  the first case for Cloudflare's automatic failback above.

## Related

- [ADR-0012 — Release is not deployment](0012-release-is-not-deployment.md)
  — the tag that starts the pipeline, and why the promotion act is separate
- [ADR-0011 — Forward-only, backward-compatible database migrations](0011-forward-only-migrations.md)
  — why the previous version may not be promotable, and the forward fix that is
  sometimes the only option
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — the ladder, and why a `identity` rollback re-canaries
- `docs/operations/deployment-model.md` — the owner document: Version /
  Deployment / Promotion, and the command that does each
- `docs/operations/rollback.md` — the three paths, the version-id lookup, and the
  forward-fix labelling
- `docs/operations/release-process.md` — who decides to promote, and the two
  human gates
- `docs/operations/observability.md` — the audit trail a rollback decision is
  made from
