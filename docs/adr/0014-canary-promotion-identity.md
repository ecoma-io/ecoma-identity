# Canary promotion for Identity; automatic for Admin and Jobs

<!--
What this file is: ADR-0014, the record of the promotion ladder for `identity`,
the two human gates on it, and the reason `identity-admin` and `identity-jobs`
have none.

What this file is **not**: a runbook, and not a restatement of the ladder. The
owner documents are `docs/operations/deployment-model.md` (the ladder and the
gates) and `docs/operations/release-process.md` (who approves and when). This ADR
is the decision those two documents record, and it must not diverge from them.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** the `identity`, `identity-admin` and `identity-jobs`
  promoting jobs in `.github/workflows/`, the required-reviewer rules on the
  `production` GitHub environment
- **Constraints covered:** 9, 12, 13, 16, 18, 19, 20, 29

## Context

The three deployables do not deserve the same promotion policy, and the reason is
a property of what a compromise of each one gets. This is the same blast-radius
argument that decides the topology
([ADR-0002](0002-three-deployables-and-no-more.md)), applied to deployment.

`identity` is the end-user request path. It holds `IDENTITY_DB`, it decides who
every request is made by, and every other Ecoma repository authenticates through
it. A bad version of it is a bad version of the authentication service for the
whole organisation, and the failure modes that matter are exactly the ones that
only appear with real traffic: a cache that was warm in staging and is cold here,
an OIDC client that negotiates a grant no test exercised, a migration that meets
rows the fixtures did not have, a rate limiter that behaves differently at
production volume. A percentage ladder converts "all of those requests" into "a
bounded number of those requests", and a human decides whether to continue.

`identity-admin` is an internal surface with a small, enumerable set of operators
reaching it. `identity-jobs` has **no public route at all** — it consumes a
queue. Neither has the 1%-of-production-traffic failure mode, because neither
serves 1% of anything. Their smoke test is their gate. Adding a human approval to
an automatic deploy of a Worker with no public route buys nothing, and costs a
deployment that happens when somebody happens to be looking.

The constraints say both of these. Constraint 19: **Identity production canaries
automatically to the policy limit, but the final promotion requires human
approval.** Constraint 20: **Admin and Jobs production need no manual approval.**
The word "policy limit" in 19 is the part that defines 10%: automatic to 10%, and
10% is the largest share a human is still comfortable not watching.

The mechanism matters as much as the ladder. **The gates are GitHub
`environment:` keys configured to require reviewers, not workflow conditions.**
This is the decision that makes the gates real, and it is easy to get wrong by
instinct: a promotion gated by an `if:` in the workflow is a gate that anyone
who can push a workflow file can remove, and that includes the person whose change
would benefit from removing it. An environment with required reviewers is a
setting the runner refuses to pass without a named approval, it is recorded in
the repository settings rather than in a diff, and it cannot be changed by a pull
request. The promotion jobs for 50% and 100% on `identity` carry
`environment: production`; the jobs at 1% and 10% do not.

## Decision drivers

- A bad `identity` version must be caught on a fraction of production traffic,
  not on all of it, and by something that is not the same pipeline that built it.
- The decision to send 100% of the authentication service's traffic to a new
  version is not fully reversible without another decision, so it is a human's.
- A gate the person making the change could remove is not a gate.
- The gates must be proportional to blast radius: a deployable that cannot serve a
  request to an end user does not need the ladder, and paying for it produces
  deployments that happen when somebody happens to be looking, which is a
  availability improvement nobody asked for and an outage risk nobody needs.
- A failed ladder must be abandonable without damage, which is what makes it cheap
  enough to use ([ADR-0013](0013-immutable-worker-versions.md)).
- The whole policy must be one file to read, so that "what happens when I push
  this" has an answer that is not assembled from four workflows.

## Decision

**`identity` is promoted through a canary ladder with two human gates. Everything
up to and including 10% is automatic; 50% and 100% each require an approval on the
`production` GitHub environment. `identity-admin` and `identity-jobs` are uploaded,
smoke tested and promoted to 100% with no manual approval at any point.**

The ladder, exactly as `docs/operations/deployment-model.md` records it:

```text
identity:
  wrangler versions upload
  → smoke test against the uploaded version
  → 1%   traffic        (automatic)
  → health gate         (automatic; aborts on a failed probe)
  → 10%  traffic        (automatic — the policy limit)
  ═══ HUMAN GATE 1 ═══
  → 50%  traffic        (requires environment: production approval)
  ═══ HUMAN GATE 2 ═══
  → 100% traffic        (requires environment: production approval)

identity-admin, identity-jobs:
  wrangler versions upload
  → smoke test against the uploaded version
  → 100% traffic        (fully automatic, no approval)
```

From now on:

1. **Everything through 10% is automatic.** Upload, smoke test, 1%, health gate,
   10%. The health gate aborts on a failed probe and the ladder does not continue
   to the human gates; a failed probe is an answer, not a delay.
2. **50% and 100% each require an approval on the `production` environment.** Two
   gates, two approvals, two records. The gates are GitHub environments with
   required reviewers, not workflow conditions.
3. **The two gates are not arbitrary.** The one at 10% exists because by the time
   10% of production traffic has been through a new version, the failures that
   only appear with real data are visible, and the purpose is to convert a
   percentage of a bad deploy into a bounded number of bad requests. The one at
   50% exists because at 50% a rollback is unambiguous — half the requests
   failed — whereas above 50% rolling back is no longer obviously correct, because
   the split is a coin flip and the incident has already lasted long enough to
   matter. "Is this version healthy enough to be the majority" is a judgement
   about duration as much as correctness, and it is not automatable.
4. **`identity-admin` and `identity-jobs` have no approval step.** Not at 100%,
   not at any percentage. They are not on the end-user request path; the admin
   console is reached by a small number of operators and the jobs Worker has no
   public route. Their gate is the smoke test.
5. **A promotion step is a `wrangler versions deploy --version-id` with a
   percentage.** Never a build. A failed ladder is abandoned by promoting a
   different version id, and an uploaded-but-not-promoted version costs nothing
   and is still there
   ([ADR-0013](0013-immutable-worker-versions.md)).
6. **Staging is a rehearsal, not a gate.** Staging deploys automatically on merge
   to the default branch (constraint 16) with no approval, and its value is that it
   runs the real authentication path — there is no dev-only path that could be
   stale ([ADR-0009](0009-no-auth-bypass.md)). A staging pass is evidence for the
   gate decision, not a substitute for it.
7. **The gate decision belongs to a human, and the two gates are separable.** It
   is legitimate to approve 50% and not 100%, and legitimate to abandon at 50% and
   promote the previous version id instead. The ladder's granularity is what makes
   the judgement worth making.

**Enforcement:**

| Boundary                                                   | Enforced by                                                                                                                                                                                                         | Exists today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The two gates cannot be removed by a PR                    | The required-reviewer rules on the `production` GitHub environment, in repository settings rather than in a workflow file; the promoting jobs carry `environment: production`                                       | **Built.** Verified live, not read off a file: `GET /repos/ecoma-io/ecoma-identity/environments` returns `production` with a `required_reviewers` protection rule, `prevent_self_review: true`, and reviewer `johnitvn` — which no pull request can change. The six promoting jobs carrying `environment: production` exist (`.github/workflows/deploy-production.yml:125,192,224,260` and `.github/workflows/deploy-worker.yml:1614,1768`). `.github/repository-settings.json` records the environment, and `prevent_self_review` means the named reviewer cannot approve their own deployment: **in this single-maintainer repository both gates will wait for a second reviewer who does not yet exist.** That is the gate working. The gate is satisfied by adding a reviewer, not by weakening the rule.  |
| 50% and 100% are gated; 1% and 10% are not                 | The `environment:` key on the 50% and 100% jobs of the `identity` deploy workflow, and its absence on the 1% and 10% jobs                                                                                           | **Built.** The `environment: production` key is on exactly `promote_to_policy_limit` (`deploy-worker.yml:1618`) and `promote_to_full_percentage` (`:1772`), and is absent from `canary` (`:805`) and `promote_to_f                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `identity-admin` and `identity-jobs` have no approval step | The `identity-admin` and `identity-jobs` promoting jobs carry no `environment:` key with required reviewers                                                                                                         | **Built.** `identity-admin` and `identity-jobs` are called with a direct-to-100% lane: `canary` skips on `fromJson(inputs.canary) != fromJson('[]')` and `promote_to_final` (`deploy-worker.yml:1422`) carries no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The smoke test is the gate for admin and jobs              | The smoke-test step in the deploy workflow, probing the routes that are supposed to answer and reading `Route::is_implemented()` so a version that uploads but does not serve is caught before promotion            | The route contract is `IMPLEMENTED` in `crates/identity-oidc/src/route.rs` — and it is honest about the state: it returns true for `Health` and `Ready` and false for everything else, with a sibling `is_declared_but_unimplemented()` whose own documentation says a 501 is deliberate over a 404 so an incomplete bootstrap is never mistaken for a wrong discovery document. **The smoke step is `Built`** (`deploy-worker.yml:1340-1402`), but it does NOT read `Route::is_implemented()`: it probes `/health` and `/ready` over HTTP and asserts the body with `jq`. That is a deliberate weakening of what this column originally claimed, and the honest statement is that this half of the row is unenforced. What the step does enforce is the per-deployable contract — `/health` 200 everywhere, ` |
| The ladder's commands do what this ADR says                | The deploy workflow's steps: `wrangler versions upload` then `wrangler versions deploy --version-id <id> --percentage <p>`, never a build-and-promote                                                               | **Built.** `wrangler versions upload` in `build_and_upload`, then `wrangler versions deploy --version-id <id> --percentage <p>` in each promotion job, with the version id passed between jobs. No job both builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| No policy in this ADR is claimed as running                | `pnpm arch` reports any check it could not run as `skipped` rather than as a pass, and prints a coverage banner; no check in `tooling/scripts/check-architecture.mjs` judges the canary policy, and the ADRs say so | Yes — the `skipped` reporting is implemented in the script, and the script is landing concurrently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Consequences

### Easier

- **A bad `identity` version is caught on 1% to 10% of real traffic**, by a
  health gate reading real signals, before 90% of it is affected. The percentage
  ladder is cheap because upload and promotion are separate operations, and the
  separation is what makes abandoning a ladder non-destructive.
- **The gate is a thing the runner refuses to pass.** It cannot be removed by the
  pull request that would benefit from removing it, and it leaves a record of who
  approved what and when.
- **A human's judgement is spent where it changes the outcome.** 50% and 100% are
  the decisions that are not fully reversible; a build step is not a judgement, and
  a human performing it adds latency without adding judgement.
- **Admin and jobs deploy without waiting for anybody.** A background consumer fix
  goes out the moment the tag exists, which matters for a deployable whose whole
  job is doing side effects in the background.
- **The policy is readable in one place.** "What happens when this merges" is
  answered by a ladder diagram rather than by reconstructing four workflows.
- **A failed promotion is evidence, not cleanup.** The bad version stays uploaded
  and immutable, and the audit trail
  ([ADR-0007](0007-outbox-pattern.md)) shows what it did while it was live.

### Harder or more expensive

- **A solo maintainer gives up the ability to ship `identity` at 3am.** The merge
  queue stalls when they are asleep, and a fix that needs two approvals waits for
  a person. That is the real cost of this decision for an organisation of one, and
  it is a cost paid in availability during exactly the hours a security incident
  is most likely to be worked on.
- **Which creates a specific, predictable temptation: widen what auto-publishes.**
  The pressure does not arrive as "let me remove the gate" on the first incident;
  it arrives as "let me make 50% automatic too", and then as "let me make
  `identity` behave like `identity-admin`", and each step is individually
  defensible. The gates are 10% and 50% precisely because they are the two
  numbers that are hard to argue away.
- **Two approvals for one release means the gate is a queue, and a queue has a
  latency distribution.** A deployment that is healthy at 10% may wait an hour for
  the approval that matters most.
- **The ladder makes `identity` releases slower than `identity-admin` and
  `identity-jobs` releases**, and they share a tag. A change to jobs can be live
  while a change to identity is still at 10%, which is correct and occasionally
  confusing.
- **A rollback of `identity` re-canaries**, because the reason for rolling back may
  be traffic-share-dependent, which lengthens the worst hour
  ([ADR-0013](0013-immutable-worker-versions.md)).
- **The environment-configuration is invisible in the repository's history.** A
  required-reviewer rule lives in repository settings, so a reader of the git log
  cannot see that a gate was added or removed. That is the price of making the gate
  un-removable by a PR, and it is a price worth paying; the mitigation is that the
  workflow's `environment:` key is visible and the rules behind it are recorded in
  `.github/repository-settings.json`, which now records the environment and its
  required-reviewer rule alongside the merge queue.

### What a future maintainer will resent

- **The 3am fix that waits for an approval.** This will happen, probably during a
  security event, and it will feel like the gate is the problem rather than the
  incident. It is the cost, stated honestly, and the answer is not "make 50%
  automatic" — it is a shorter ladder, a better health gate, or accepting the
  wait.
- **"50% is already most of the traffic; does it need its own gate?"** It is the
  gate that most often gets removed under schedule pressure, and it is the one
  that is hardest to remove by accident because it is a separate environment
  approval.
- **The asymmetry itself.** Why does the Admin Worker deploy with nobody watching
  when it holds an operator's administrative session? The answer is in step 4 and
  in [ADR-0004](0004-admin-worker-holds-no-database.md): its blast radius is a
  service binding and an audit trail, not the credential store. It is a real
  question and it has a real answer, but the answer is not obvious enough that it
  will not be asked.

## Alternatives considered

### No canary; promote every deployable to 100% automatically

**Rejected**, and it is the simpler option, and it is the one a service without
real users would choose. It loses on the specific failure mode the ladder exists
for: the things that only appear with production traffic, which are by definition
the things the test suite and staging did not reproduce. For an end-user
authentication service, "100% of login traffic to an unproven version" is not a
deployment, it is a bet on the test suite having covered production's data. The
ladder is cheap precisely because upload and promotion are separate
([ADR-0013](0013-immutable-worker-versions.md)), so the cost of the policy is two
approvals, not two deployments.

### No human gates; canary to 100% automatically

**Rejected**, and this one is close, because the automatic part of the ladder
already runs a health gate and one could argue the human adds nothing. The
argument against is that a health gate reads signals, and the signals available
are error rate, latency and probe results — none of which is a signal about a
failure that is _correctly reporting success_, or about a failure that takes four
minutes of sustained load to appear, or about a migration that only breaks at
2am. The 50% gate is explicitly a judgement about duration as much as
correctness, and that is not a thing a probe can answer. Making 100% automatic
also removes the last human decision in the entire deployment path, which for a
service that holds every credential in the organisation is the wrong thing to
remove.

### Human approval on all three deployables, for symmetry

**Rejected**, because symmetry here would be a mistake dressed as a principle.
`identity-jobs` has no public route; a human approving its promotion is a
deployment that waits for a person to have a reason, and the thing being approved
is a background consumer that nobody's login depends on. Constraint 20 says these
two need no manual approval, and the argument for it is the blast-radius
asymmetry, not convenience: a bad admin Worker is an outage on an internal surface
with a service binding and an audit trail behind it, and a bad jobs Worker is a
duplicate email, whereas a bad `identity` Worker is a compromise of every account
on the platform. Making the policy uniform would make it uniform in the wrong
direction.

### Gates as workflow conditions (`if:` on an approval input) instead of GitHub

environments

**Rejected**, and it is the alternative most likely to be proposed by someone
trying to keep the gate in version control where it is visible. It is genuinely
more reviewable — a diff shows whether the gate exists. It is also removable by
the same pull request that would benefit from removing it, which makes it a
convention rather than a control. An environment with required reviewers is a
setting the runner refuses to pass; a workflow `if:` is a line somebody can delete
in the same commit. Both facts matter, and the second one matters more, which is
why the gate lives in repository settings and the workflow carries the
`environment:` key that points at it.

### Canaries for admin and jobs as well, just at a lower percentage

**Rejected**, and it is a reasonable-sounding middle. There is no lower percentage
that helps a Worker with no public route: 1% of nothing is nothing. A jobs
canary would be 1% of queue messages, which is not a traffic share, and a queue
consumer at 100% and a queue consumer at 1% differ only in how fast they drain —
there is no subset of production requests to observe the new version against, so
the canary has nothing to measure. The smoke test is the observable check that
exists.

## Revisit when

- **A deployable that currently has no manual gate acquires something worth
  gating for.** The concrete threshold: **the day `identity-admin` or
  `identity-jobs` holds a credential, or writes to a database other than scratch,
  it earns an approval gate.** That is an observable change to a binding set, and
  it is checkable — `pnpm arch`'s `no-authoritative-kv-or-do` and
  `boundary-1-admin-d1` checks are what would flag it. An admin-owned database
  ([ADR-0004](0004-admin-worker-holds-no-database.md), step 4) is the likely first
  instance, and a durable job state is the likely second. Both would make the
  asymmetry wrong, and the fix is to give that deployable a ladder.
- **The solo-maintainer latency cost becomes a real incident** — observable as a
  production fix that waited hours for an approval. The answer is a shorter ladder
  or a better automatic health gate, and only if those are exhausted, a
  reconsidered gate placement. It is _not_ the answer "remove the gate", and the
  difference between those two is the whole decision.
- **The health gate proves able to answer what the 50% gate is asked.** If
  telemetry plus a synthetic probe can distinguish a healthy version from an
  unhealthy one within seconds at every stage, the 50% gate loses its justification
  as a human judgement and becomes a delay. That is falsifiable, which is the
  right shape for a revisit condition.
- **`identity` leaves the end-user request path** — retired, or split so that the
  credential-holding component is not the one serving user requests. Then the
  asymmetry's justification changes and this ADR should be rewritten rather than
  amended.
- **A fourth deployable appears**
  ([ADR-0002](0002-three-deployables-and-no-more.md)). The new one has to be
  classified by blast radius, and this ADR is where the classification lands.
- **Cloudflare adds a first-class automatic failback to a named version id.** That
  changes the value of the 50% gate, because the "unambiguous rollback" property
  that motivates it is partly provided by the platform instead
  ([ADR-0013](0013-immutable-worker-versions.md)).

## Related

- [ADR-0012 — Release is not deployment](0012-release-is-not-deployment.md)
  — the tag that starts this pipeline, and why promotion is a separate act
- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — upload ≠ promotion, which is what makes a ladder cheap and a rollback fast
- [ADR-0002 — Three deployables and no more](0002-three-deployables-and-no-more.md)
  — the three deployables this policy classifies
- [ADR-0004 — The Admin Worker holds no database](0004-admin-worker-holds-no-database.md)
  — why the admin surface's blast radius is a service binding, which is why it has
  no gate
- [ADR-0006 — The Jobs Worker owns no identity state](0006-jobs-worker-owns-no-identity-state.md)
  — why a bad jobs version is a duplicate email rather than a compromise
- [ADR-0009 — No authentication bypass in any environment](0009-no-auth-bypass.md)
  — why staging is a real rehearsal and the ladder's evidence is worth having
- `docs/operations/deployment-model.md` — **the owner document**: the ladder, the
  two gates and why each exists, the environments table, and the `environment:`
  key as the mechanism
- `docs/operations/release-process.md` — **the owner document**: what is
  automatic and what is not, and the sequence
- `docs/operations/rollback.md` — the three paths, and why an `identity` rollback
  re-canaries
- `docs/operations/observability.md` — the signals the health gate reads
