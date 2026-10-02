# Release is not deployment

<!--
What this file is: ADR-0012, the record that Release Please owns the version, the
release PR and the tag, and nothing else — and that cutting a release and
promoting a version to production are two acts with two owners.

What this file is **not**: a release runbook, and not a description of the
GitHub Actions workflows. Those are `docs/operations/release-process.md` and
`.github/workflows/`. This ADR is the decision underneath both.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** the release and deploy workflows in `.github/workflows/`,
  `.release-please-manifest.json`
- **Constraints covered:** 9, 10, 12, 16, 17, 18, 29

## Context

Two words in this repository mean different things and have different owners, and
conflating them is the most consequential conflation available.

A **release** is a version number, a changelog and a git tag. A **deployment** is
a Cloudflare Deployment sending a percentage of requests to an immutable
[Version](0013-immutable-worker-versions.md). The first is cheap and frequent; the
second is neither. The constraints separate them absolutely: constraint 9 says
release ≠ deployment, constraint 10 says Release Please owns version, release PR
and tag and does **not** own production promotion, and constraint 17 says the
release PR is merged **by a human**.

The argument for separating them is a blast-radius argument about frequency. The
temptation to couple them is real and the coupling feels good: a tag appears, CI
builds, everything deploys, done. What that produces is a single pipeline whose
friction is whatever the most dangerous step in it costs. If the tag also
promoted, then either release is slow and infrequent — because production promotion
deserves a human and a health ladder
([ADR-0014](0014-canary-promotion-identity.md)) — or promotion is fast and
ungated, which is the thing the two human gates exist to prevent. You cannot have
both from one event. Every repository that tries ends up choosing a release
cadence that is either slower than its work or a production path with no gate in
it.

The specific mechanism that makes this decision necessary is that **a tag is the
trigger for the automated half of production.** Constraint 18 makes the post-tag
build, version upload and smoke test automatic, and constraint 19 makes identity's
canary automatic to 10%. So the tag does start a production pipeline — it starts
one that stops at 10% and waits for a human. If Release Please also owned the
promotion, the only remaining question would be whether the human gates were
real. Separating the two keeps the gates in a place that has nothing to do with
the release tooling: Release Please does not call `wrangler`, does not know a
Cloudflare account exists, and holds no credentials. That is the property, and it
is worth more than the convenience of one command doing everything.

There is also a traceability requirement pulling the same way.
`docs/operations/deployment-model.md` says version tags must be the git tag,
"because it makes 'which version had tag X' a lookup rather than an inference",
and a rollback decision is only decidable if each version names its commit. A
deployment with no release behind it is untraceable; a release with no deployment
behind it is merely unreleased, and that is a normal, unalarming state.

## Decision drivers

- Version numbers must be cut often, or they stop meaning anything and a rollback
  decision stops being decidable.
- Production promotion must be gated on the version's own health, not on when
  someone got round to cutting it.
- The release tooling must hold no production credentials and no Cloudflare
  access, so that the un-gated part of the pipeline cannot be widened by
  configuring a release tool.
- Every deployed version must be traceable to a commit, through a tag.
- The human gates must live in a mechanism that cannot be edited by the same PR
  that would benefit from removing them.
- A maintainer must be able to cut a release during an incident without that act
  itself being a production change.

## Decision

**Release Please owns the version number, the changelog, the release PR and the
tag. It owns nothing else. A human merges the release PR. Promotion to
production is a separate act, with its own approval, triggered by the tag and
performed by GitHub Actions and Wrangler.**

From now on:

1. **Release Please's only outputs are the version, the changelog, the release PR
   and the tag.** It calls no deployment tool, holds no Cloudflare credential and
   does not know a Cloudflare account exists. A release PR that contains a
   workflow change is a review finding, not a detail.
2. **The release PR is merged by a human** (constraint 17). This is the one point
   in the sequence where automation stops and asks, and it is the point at which a
   human chooses to say yes to a version existing.
3. **The tag is the trigger for the production pipeline**, and the pipeline
   stops where the health policy says it stops: `identity-admin` and
   `identity-jobs` go to 100% automatically (constraint 20), `identity` canaries
   automatically to 10% and waits for a human there
   ([ADR-0014](0014-canary-promotion-identity.md)).
4. **Staging deploys on merge to the default branch** (constraint 16), which is a
   different trigger from the tag. A merge is not a release and a tag is not a
   merge; if production deployed on merge, constraints 16 and 19 would be in
   direct conflict.
5. **A version id is named before it is promoted.** A deployment always names a
   version that was uploaded; there is no path that builds and promotes in one
   step, because that path would make every promotion a rebuild and destroy the
   meaning of a version id
   ([ADR-0013](0013-immutable-worker-versions.md)).
6. **A `chore` or `docs` change that reaches the default branch does not force a
   version bump.** A version per commit makes the version number stop meaning
   anything. The version is the unit a rollback decision is made against, and it
   has to correspond to a coherent set of changes.
7. **The three deployables are versioned as three release components** under one
   tag scheme, and the internal crates are not release units and are never
   tagged. The root `Cargo.toml` sets `version = "0.0.0"` for every crate and says
   in a comment that this exists only to satisfy Cargo's manifest and is not the
   deployed version of anything; `docs/operations/release-process.md` attributes
   that comment to this set of ADRs. The _versioning_ of the three deployables
   is Release Please's job, per
   [ADR-0015](0015-frontend-and-bff-one-release-unit.md); what this ADR
   constrains is that Release Please's job stops at the tag.
8. **A release is a normal, frequent act and an incident is not the time to
   hesitate over it.** Cutting a release during an incident changes nothing about
   production; promoting does.

**Enforcement:**

| Boundary                                                            | Enforced by                                                                                                                                                                                                                                                                                                       | Exists today                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release Please holds no Cloudflare credentials and no deploy step   | The release-please configuration: no `extraFiles` that could rewrite a workflow, and no release-time deploy step. `pnpm arch`'s `boundary-5-worker-registration` treats `release-please-config.json` as one of the four registration points, which makes the config a place a fourth deployable could be declared | **Partially built.** I ran `pnpm arch` on this tree: the `release-please-config.json` step reports `skipped — release-please-config.json does not exist yet`, which is the script refusing to pass a check it could not run. The config itself is `DEFERRED` to the release phase                                                                                                                                           |
| A human merges the release PR                                       | The branch protection ruleset on the default branch, and the merge queue: no direct merges, no direct pushes                                                                                                                                                                                                      | **Built.** Verified live: `GET /repos/ecoma-io/ecoma-identity/rulesets` returns the `main` ruleset with `deletion`, `non_fast_forward`, `pull_request` (merge commits only) and `merge_queue`. Merge policy matches: merge commits only, auto-merge on, delete-branch-on-merge on. The merge queue is required, so every pull request lands through it and neither a direct merge nor a direct push to `main` is possible   |
| A tag starts the production pipeline and not a merge                | The deploy workflow's `on:` trigger, keyed to the tag; the staging workflow's trigger is the default branch                                                                                                                                                                                                       | **Built.** `deploy-production.yml:74-79` triggers on a `push` of the tags `identity-v*`, `identity-admin-v*`, `identity-jobs-v*`, `home-web-v*`; `deploy.yml:42-43` triggers on a `push` to `branches: [main]`. Its `workflow_dispatch` is the only other way into production and its own comment says why it must stay that way: no "deploy whatever is on main" input, because that is a promotion with no release behin  |
| The human gates are not removable in the same PR that would benefit | The promoting jobs carry `environment: production`; the required-reviewer rule lives in repository settings, not in a workflow file                                                                                                                                                                               | **Built.** `GET /repos/ecoma-io/ecoma-identity/environments` returns `production` with a required-reviewer rule and `prevent_self_review`. Environment protection rules cannot be changed by a pull request at all, which is the property this row exists to assert. See [ADR-0014](0014-canary-promotion-identity.md), which names the same enforcement point                                                              |
| Promotion names an uploaded version id                              | The deploy workflow's two-step upload-then-deploy; `docs/operations/rollback.md` Path 3 being the only build-then-promote path, named a forward fix                                                                                                                                                               | **Built.** `build_and_upload` runs `wrangler versions upload` (`deploy-worker.yml:738`) and exposes the resolved id as a job output (`:347`, from a step that writes it at `:779`). Every promotion job consumes it as `needs.build_and_upload.outputs.version-id` (`:1118`, `:1450`, `:1629`, `:1783`) and passes it to `wrangler versions deploy --version-id` (`:994`, `:1561`, `:1736`, `:1886`). No promotion job redi |

## Consequences

### Easier

- **Releases can be frequent, and therefore meaningful.** Cutting a release costs
  one review of one PR, so releases happen when the work lands rather than when
  someone remembers. A version number that moves when the product moves is a
  version number a rollback decision can be made against.
- **Production promotion is gated on the version's own health**, on a ladder with
  two human gates, rather than on when the release was cut. The two decisions are
  independent, so a release can be cut during an incident and promoted when
  someone is actually looking at the dashboards.
- **The release tooling cannot become a production credential.** Release Please
  does not call `wrangler` and has no account access. The blast radius of a
  compromised release tool is a bad version number, not a production deployment —
  and that is a structural property, not a review outcome.
- **Every deployed version traces to a commit**, through the git tag and the
  Cloudflare version tag matching it. "Which version had tag X" is a lookup
  ([ADR-0013](0013-immutable-worker-versions.md)).
- **The two environments have different triggers, which is what lets both
  constraints hold.** Staging on merge is fast; production on tag is deliberate.
  If production deployed on merge, constraint 16 and constraint 19 would be in
  direct conflict — which is the sharpest statement of why this separation is
  necessary rather than merely tidy.
- **Cuts during an incident are free.** A forward fix
  ([ADR-0013](0013-immutable-worker-versions.md) Path 3) is a release plus a
  promotion, and only the second is risky.

### Harder or more expensive

- **Two acts, two things to go wrong.** A release PR can be merged with a bad
  version bump or a changelog that does not match the commits; a promotion can
  proceed on a version whose health nobody is watching. The first is caught by
  review, the second by the ladder
  ([ADR-0014](0014-canary-promotion-identity.md)); neither is caught by a single
  step that did both.
- **There is a window where a released version is not deployed.** This is normal
  and not a problem — and it is worth saying so explicitly, because a
  not-yet-promoted release reads as an oversight to someone who has not read
  `docs/operations/release-process.md`. The window is also the reason a release
  does not need to be cut during an incident: nothing about production depends
  on it.
- **And the mirror-image window: a deployed version is not the release.** A
  rollback
  ([ADR-0013](0013-immutable-worker-versions.md)) puts an older version live
  while the newest tag exists. That is legitimate and necessary, and it does mean
  the deployed version is not always the latest release. The audit trail and
  `docs/operations/observability.md` are what make that legible after the fact.
- **"What is running in production?" is now a Cloudflare question, not a git
  question.** The answer lives in `wrangler deployments list`, and the git tag
  tells you which commit that version was built from. The indirection is the cost
  of having both facts at once.
- **A chore-only change rides along.** No version bump means the tag does not
  correspond one-to-one with merge activity, and a maintainer occasionally has to
  explain why the last release contains three weeks of commits. That is the right
  trade, and it is occasionally annoying.

### What a future maintainer will resent

- **"Can't Release Please just deploy it?"** is the sentence, and it is the whole
  argument. The answer is that a tag that promotes has a single pipeline whose
  friction is its most dangerous step, and that means either slow releases or an
  un-gated production. Both are worse than two acts.
- **The gap between "released" and "deployed".** It will be asked about, probably
  during an incident, and the answer is in
  `docs/operations/release-process.md`. Expect to give it more than once.
- **A release PR that is purely a version bump.** The friction of a human merging
  a PR that changes one number will recur every release, and the temptation to
  auto-merge it is the same temptation as auto-deploying it.

## Alternatives considered

### Release Please deploys production on tag

**Rejected**, and it deserves the fullest treatment because it is simpler, it is
what a well-meaning person proposes, and it is exactly the mechanism that turns a
bad tag into a production incident with no gate in it.

The appeal is real: one event, one pipeline, no window, no "is the release
deployed yet" question. What it costs is the fusion of the two friction values.
Release PR merge is cheap and should be frequent; production promotion of
`identity` deserves a canary ladder and two human approvals. One trigger means one
friction, so one of the two has to be sacrificed. The version that survives the
fusion is the automated one, because the automated one is faster and a bad tag is
a rarer event than a merge — and the result is exactly the failure this repository
forbids: a production deployment with no human in it. It also puts Cloudflare
credentials in the hands of the release tooling, so a misconfigured or compromised
release tool becomes a production deployer, and it removes the ability to cut a
release during an incident without that cut being a production change.

What would have changed the answer: if `identity` were not on the end-user
request path — if the only deployable were a background worker — then the
promotion decision would be as cheap as the release decision and coupling them
would be fine. That is very nearly the case for `identity-admin` and
`identity-jobs` today, which is why they have no manual gate
([ADR-0014](0014-canary-promotion-identity.md)) and not because the process
differs.

### A human runs `wrangler versions deploy` by hand for every production promotion

**Rejected**, for a different reason: it is the same separation without the
automation, and it loses the things automation provides. The canary ladder
becomes a terminal command an operator types, which means the percentages, the
health gate and the smoke test are steps somebody has to remember at 3am. It also
makes the promoting actor a shell rather than a run, so there is no record of the
decision in the repository. The rule this ADR states — automation owns the steps
whose failure mode duplicates the step above, a human owns the steps whose
failure mode is irreversible — is the better division: automate through 10%,
require a human for 50% and 100%, and let the gate be a repository setting rather
than a person's judgement at the keyboard.

### SemVer-per-component releases, with a tag per deployable

**Accepted in shape, and this is not a rejection.** The three deployables carry
three release-please components and their tags are named after them
(`identity-v0.1.0`), which `docs/operations/deployment-model.md` records and
`docs/operations/release-process.md` relies on for traceability. What this ADR
fixes is that the same rule applies to all three: the tag is the end of the
release, not the start of a deployment.

### Trunk-based, deploy every merge to production, release only for the public

contract

**Rejected.** It is the other honest way to separate the two events, and for a
service whose consumers are other services in the same organisation it is
defensible. It loses on two things specific to this system. First, the
end-user-facing surface changes with a version, and a version number that does not
track what a user is running is not a useful support tool. Second — and this is
the one that matters — it makes every merge a production candidate for the
end-user surface, which is a much higher-frequency event than a release, and the
canary ladder
([ADR-0014](0014-canary-promotion-identity.md)) would then run on most merges. The
separation in this ADR is what keeps the ladder's cost proportional to how often
production actually changes.

## Revisit when

- **The time from tag to 100% production exceeds the time from merge to the next
  release** — observable as a maintainer routinely having two unreleased versions
  in flight. That is the friction the separation was meant to avoid, and the
  answer is either a faster promotion path (a better health gate, a shorter
  ladder) or accepting a longer release cadence, not coupling the two acts.
- **Only one deployable is on the end-user request path in practice**, and
  `identity` is retired or becomes a non-public surface. Then the promotion
  friction is as low as the release friction and coupling the two stops being a
  cost. That is a real revisit condition, and it would be a new ADR rather than an
  amendment to this one.
- **A release needs to carry a migration that cannot be forward-compatible with
  the currently deployed version.** Then release and promotion are no longer
  independent events — the promotion _is_ the only safe moment for the migration
  — and this ADR's separation has to be revisited in favour of
  [ADR-0011](0011-forward-only-migrations.md)'s rule rather than in favour of
  coupling. Observable as a migration that has to be applied in the same act as the
  code.
- **The release tooling ever needs a credential to do its job** — for example to
  run a hook that touches an external system. That is the moment this ADR's
  structural property is at risk, and the correct response is to move the hook out
  of the release tool rather than to grant the credential.
- **A tag is created outside Release Please** (a manual tag, a hotfix tag). Then
  the version numbering has two writers and the traceability property is at risk;
  the answer is a policy about manual tags, not about this ADR.

## Related

- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — what a tag produces, and why a version id is the unit of promotion
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — the health ladder the promotion act follows
- [ADR-0011 — Forward-only, backward-compatible database migrations](0011-forward-only-migrations.md)
  — a migration applied in the deploy path, which is a promotion-time act
- [ADR-0015 — Frontend and BFF are one release unit](0015-frontend-and-bff-one-release-unit.md)
  — why a release unit is the frontend plus its BFF, not a crate
- `docs/operations/release-process.md` — the owner document: who does what, and
  the sequence diagram
- `docs/operations/deployment-model.md` — Version / Deployment / Promotion, and
  the version tag that makes a rollback decidable
- `docs/operations/rollback.md` — the three paths, and why a forward fix is not a
  rollback
- `commitlint.config.mjs` — the commit-message authority that makes the changelog
  trustworthy
