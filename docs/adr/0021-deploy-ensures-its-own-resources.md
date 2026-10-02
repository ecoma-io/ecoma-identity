# A deploy ENSURES the Cloudflare resources its topology declares, and never stores their ids

<!--
Supersedes the CREATE-OR-FAIL policy that `tooling/scripts/reconcile-infra.mjs`
carried from its first version. That policy was argued in the script's own header
comment and it was not wrong in its terms — it was wrong about who pays. See
"Alternatives considered / Create or fail", which is the decision this reverses.
-->

- **Status:** Accepted
- **Date:** 2026-10-02
- **Deciders:** John Martin
- **Technical story:** #19 (the reconciler this decides), #22 (the migration step that depends on a real database existing)
- **Constraints covered:** SC-29 (meta: a change to a constraint requires an ADR)

## Context

`infra-topology/topology.json` names every Cloudflare resource a deployable
binds — `ecoma-identity-staging`, `identity-staging-kv`, `identity-staging`,
`identity-staging-dlq`, `jobs-staging-kv` — and deliberately carries no ids.
Its own `$comment` explains why: "Cloudflare RESOURCE IDs are absent — and so is
any way of naming one." A generated wrangler config cannot name an id either,
so between a topology that knows a name and a config that needs the id,
something has to ask Cloudflare.

`tooling/scripts/reconcile-infra.mjs` is that something. Its first version
looked every name up by exact name and **failed** when one was absent. The
header argued for this at length: "a deploy that silently creates the database
it is about to write to turns a typo in a name into an empty production database
rather than a failed run."

Account `406bdb82319b162b09bf5f137a156600` has zero D1 databases, zero KV
namespaces and zero queues. Every staging deploy therefore stopped at
`no d1 named "ecoma-identity-staging" exists in this account`, and no deploy
had ever succeeded.

The argument in that header is a real argument. It was answering the wrong
question. It weighed a typo's cost against the benefit of a failing deploy, and
never asked what the alternative to provisioning is — which is not a failed run,
it is **no run at all, ever**. The purity had no beneficiary: nobody was
protected by it, because nobody could ship with it.

## Decision drivers

- **An account is empty until something creates its first resource.** That is
  what an account is before its first deploy, and this repository had never
  completed one. A reconciler that refuses to provision is a deploy path that
  cannot be exercised, which means it is untested and untrustworthy for a
  different and worse reason.
- **The typo argument is real but narrow.** A name in topology.json is read from
  one tracked file, in a diff a reviewer reads, and the four staging jobs run in
  parallel against disjoint resource sets so a typo provisions a resource nothing
  else binds.
- **The cost is paid on a typo; the alternative is paid on every deploy.** One is
  a review failure that surfaces as a created resource with a wrong name. The
  other is the state this repository was actually in.
- **No id may be stored anywhere**, so a run that cannot ask Cloudflare is a run
  that cannot deploy — which makes asking the load-bearing part of the design,
  not a detail of it.
- **No Cloudflare create has an idempotency key**, so "ensure" cannot mean
  "create unconditionally". Create-when-absent plus a duplicate refusal is the
  narrowest correct reading.

## Decision

**A deploy ENSURES the resources `infra-topology/topology.json` declares: a name
this account does not have is created, then rediscovered by exact name.**

Specifically:

1. **Reconcile never stores an id.** Every id is rediscovered from Cloudflare by
   exact name on the run that needs it, into `$RUNNER_TEMP`. Nothing is
   committed, and there is no second copy anywhere including GitHub. This is
   unchanged and remains the property `docs/security/secrets-management.md` buys
   with "a second copy is a second thing to be wrong".

2. **A name absent from the account is created** by the run that needs it,
   through the Cloudflare API, using that kind's create operation: `POST`
   `/accounts/{account}/d1/database` with `{name}`, `POST`
   `/accounts/{account}/storage/kv/namespaces` with `{title}`, `POST`
   `/accounts/{account}/queues` with `{queue_name}`.

3. **The bound id comes from a re-list, never from the create response.** A
   create response is what Cloudflare says it made; a re-list is what the
   account contains. Both then pass through one duplicate check.

4. **The whole write set is decided before any of it is written.** Every missing
   name across every deployable in scope is collected first, printed as a
   notice, then created. Creating inside the resolve loop would leave an account
   half-provisioned when the fifth create fails.

5. **Ensuring never deletes, adopts, renames or repairs.** Create is the whole
   of the write surface. A name that resolves to two resources is an error, and
   so is a create that somehow produced a duplicate — two resources answering to
   one name is evidence the account is not the account the topology believes it
   is.

6. **A deployable that declares no resources makes no API call at all.**
   `identity-admin` and `home-web` declare none, and the four staging jobs run in
   parallel, so each reconciles its own deployable rather than listing the whole
   environment.

**Enforcement:** `tooling/scripts/reconcile-infra.mjs` — `findExact` decides
absence, `createResource` performs the create and the re-list, and `exactMatch`
is the single duplicate check both paths share.
`tooling/scripts/reconcile-infra.test.mjs` holds 15 tests against a fake written
to Cloudflare's published contract; the four that guard this decision specifically
are "a name that does not exist is CREATED", "every missing kind is created with
the verb, path and body field Cloudflare requires", "the bound id comes from a
re-list", "a create that leaves a duplicate name is refused", "a deployable
declaring no resources makes no API call at all" and "an account with nothing in
it reconciles to a complete descriptor and exits zero".

## Consequences

### Easier

- A deploy onto an account that has never been deployed to works, which is what
  "bootstrap" means. The empty account stops being a state the pipeline cannot
  leave.
- A reviewer checks one file. `topology.json` names everything a deployable
  binds, so adding a deployable's resource is one tracked-file diff, not a
  dashboard operation plus a re-run.
- The write set is one place. Every resource a deploy can create is enumerable
  from topology, so there is no second inventory of Cloudflare state to keep in
  step.

### Harder or more expensive

- **A typo in a topology name now provisions a resource instead of failing a
  run.** This is the cost the original header was about, and it is real. It is
  paid on a diff a reviewer reads, and a resource named after a typo binds
  nothing.
- **Every create needs the token to carry write scope**, not only read. A token
  scoped `Account:Workers Scripts:Read` that could once reconcile will now fail
  at the create with Cloudflare's own 403, which is a legible failure.
- **No idempotency key exists on any of the three endpoints.** Two concurrent
  runs creating the same name can both succeed, and the loser is caught by the
  duplicate check on the next re-list — as a failed run with a legible message,
  not as a silent wrong binding. That is the intended outcome and it is still a
  failure.
- One more round trip per created resource. Creating 5 resources on a first
  deploy costs 5 extra listings, against a pipeline that was not deploying at
  all.

### What a future maintainer will resent

"The reconciler created a resource instead of failing, so a typo in
topology.json provisioned something nobody asked for." — That sentence is the
cost of this decision, and it is smaller than "the reconciler refused to run
against an account that had never been deployed to, so nothing has ever
deployed". If the second sentence is the one you would rather have said, the
conditions under which that trade flips are in "Revisit when".

## Alternatives considered

### Create or fail (the policy this ADR replaces)

Look up by exact name; a missing name is a failed run; provision by hand through
the dashboard or `wrangler d1 create`. **It lost because it was untested.** A
deploy path that has never completed is not a conservative deploy path, it is an
unknown one, and this repository spent twenty consecutive red staging runs
establishing that. The reasoning in its favour was sound and is recorded here
rather than deleted, because it is the strongest argument against this decision
and a future maintainer should not have to reconstruct it from a diff.

### Store the ids in the topology, and commit them

The ids would live in `infra-topology/topology.json` next to the names. **Rejected
outright**: it is a second copy of a fact Cloudflare owns, it is a second thing
to be wrong, and deleting this repository would delete the record of which
database it deploys to. `docs/security/secrets-management.md` is the owner of
that reasoning and does not need restating here.

### `wrangler d1 create` / `wrangler kv namespace create` / `wrangler queues create` as a step

Wrangler already knows how to create all three, so the reconciler would not have
to. **Rejected** because parsing an id out of wrangler's human-facing output is
the exact fragility this repository already paid for once: the version id had to
be recovered from `wrangler versions list --json` rather than scraped from a log
line, and the first version of this script's mock was built from an assumption
about the API rather than its contract and agreed with the assumption for a full
deploy cycle. One HTTP client, one place where the response shape matters, and
one set of tests that can disagree with the code.

### Provision once by hand, then only ever discover

Keep the original script and provision the five staging resources by hand.
**Genuinely close**, and it would have unblocked the pipeline the same afternoon.
Rejected because it makes every future environment — production, and every
preview the moment it is real — a manual step that a new operator has to know
about, and because nothing then tests the create path at all.

## Revisit when

- **if the account ever holds a resource the topology does not declare**, the
  ensure path is not the whole problem any more and an ownership question
  (adopt, prune, or fail) has to be answered explicitly.
- **if a concurrency incident ever produces two resources under one declared
  name**, the duplicate check has caught a real race rather than a hypothetical
  one, and the fix is a lock in the deploy workflow rather than a resolver change.
- **if topology names stop being the complete inventory** — a resource named
  anywhere else — the premise that a deployable binds only what topology says is
  false, and so is this decision.
- **if a deploy is ever run against an account that must not be written to**, a
  read-only reconcile mode is needed and the token needs a scope narrower than
  this one assumes.

## Related

- [ADR-0003 — Identity D1 has a single owner](0003-identity-d1-single-owner.md) —
  why `identity` owns the D1 and the others do not, which is what makes the four
  parallel staging jobs race-free against the create path
- [ADR-0011 — Migrations are forward-only](0011-forward-only-migrations.md) —
  the rule the migration step this unblocks operates under
- `docs/operations/deployment-model.md` — the owner document for what a deploy
  does, in order
- `infra-topology/README.md` — the owner document for what topology names and
  what it deliberately does not carry
- `docs/security/secrets-management.md` — the owner document for why no id is
  stored anywhere
