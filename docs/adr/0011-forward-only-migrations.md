# Forward-only, backward-compatible database migrations

<!--
What this file is: ADR-0011, the record of why there is no database rollback
path, what "a migration may add, never remove or narrow" means as a rule, and
what a partial failure does.

What this file is **not**: a schema, a migration tool choice, or a statement that
`wrangler d1 migrations` does the work. The migrations are `DEFERRED`; the rule
is in force now.
-->

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** the maintainer
- **Technical story:** `database/identity/migrations/`, `AGENTS.md` "Prohibited
  shortcuts"
- **Constraints covered:** 9, 12, 14, 21, 29

## Context

The database holding every credential in the organisation has a schema, and the
schema changes as the system is built. This ADR decides what happens when a
migration is wrong.

The obvious answer — a down migration, and a rollback path that runs it — is the
one that a database host makes easy and that this system refuses. The reason is
that **the code and the schema are deployed independently and are not rolled back
together.** Cloudflare Worker versions are immutable and promoted by id
([ADR-0013](0013-immutable-worker-versions.md)); a rollback promotes a previous
version, which was written against a previous schema. The database is not a Worker
version and cannot be promoted to a previous state. So the moment a schema change
is live, the previous code is one promotion away from being live again, and it was
written against the old schema.

That asymmetry is the whole problem. A rollback of the code is a first-class,
fast, rehearsed operation; a rollback of the data is neither, and the two cannot be
coordinated. Any plan that depends on reversing a data change is a plan whose
second step is "restore from a backup", which is a disaster-recovery plan wearing
the costume of a deployment plan.

The constraint says it directly: **database migrations are backward-compatible.
There is no database rollback path; a migration may add, never remove or narrow.**

The word "narrow" is doing real work in that sentence, and it is the clause that is
easiest to violate without noticing. A migration that _adds_ a column is safe: the
old code does not know about it and ignores it. A migration that _removes_ a column
is not, because the old code selects it. A migration that _adds a NOT NULL column
with no default_ is not, because the old code inserts rows without it — that is a
narrowing, and it fails on the first write from the old version. A migration that
_renames_ a table is a remove and an add, and the add fails. A migration that
changes a type in a way that loses information is a narrowing, and the loss is not
in the schema, it is in the data.

**Why apply before the code is live, then?** Because the rule is not "the database
is frozen"; it is "the database only ever moves forward, and every intermediate
state is one the previous version of the code can still run against." That is what
makes `wrangler d1 migrations apply` in the deploy pipeline
([ADR-0003](0003-identity-d1-single-owner.md)) safe: the migration lands first, the
new code lands second, and between them the old code is still correct.

The honest part of this decision is the part nobody likes: it means a bad schema
change is corrected by a _second_ migration, not by undoing the first. Every
forward-only discipline has that cost, and it is real — a mistake costs a
corrective migration and a piece of awkwardness that stays in the schema forever.
What it buys is that there is never a moment when the system cannot be brought
back to a working state, and that moment is the one that causes outages.

## Decision drivers

- Code and schema are deployed and rolled back independently; a rollback that
  requires reversing data is not a rollback, it is a restore.
- A previous Worker version is one promotion away from being live at any time
  ([ADR-0013](0013-immutable-worker-versions.md)), and it was written against the
  previous schema. Every intermediate schema must be runnable by it.
- The alternative — "roll back the data too" — has a step that is untested, slow
  and lossy, and it is the step that is needed exactly when the system is already
  in trouble.
- A migration that only adds means a bad change is corrected forward, which is
  always possible; a migration that removes or narrows can leave data that no
  future migration can recover.
- The rule must be reviewable by a human reading a SQL file, because a migration
  is the artifact where a `DROP COLUMN` looks like a reasonable cleanup.

## Decision

**There is no database rollback path. Migrations are forward-only: a migration may
add — a table, a column, an index, a constraint, a new value in an existing
enumeration, a new event type — and may never remove or narrow. There are no down
migrations, and no code in this repository reverts a migration.**

From now on:

1. **A migration is applied by the deploy pipeline, before the code that needs it**
   is promoted, and through the Identity Worker's deploy path
   ([ADR-0003](0003-identity-d1-single-owner.md) — no migration runner outside the
   Worker). The migration path is **per Worker**: the `identity` deployable's
   `wrangler.jsonc` declares `migrations_dir` pointing at
   `database/identity/migrations/`, and that is the only `migrations_dir` in the
   repository. `database/admin/migrations/` exists and is empty, because the Admin
   Worker holds no database and therefore has nothing to migrate
   ([ADR-0004](0004-admin-worker-holds-no-database.md)).
2. **Every migration is backward-compatible with the currently deployed version.**
   If the currently live Worker version cannot run against the post-migration
   schema, the migration is wrong, not the version.
3. **A rename is `add new, copy, stop using old` across three deployments** — add
   the new column, backfill and dual-write, and only then, in a later migration,
   stop using the old one. The old column may be dropped only when no deployable
   version that reads it can be promoted, which is a judgement about which versions
   still exist.
4. **Adding a NOT NULL column requires a default or a backfill first.** A
   migration that adds a NOT NULL column with no default narrows the schema and
   breaks the currently deployed version's writes. Backfill, then add the
   constraint, in separate migrations.
5. **A new value in an existing enumeration is additive and is added before any code
   emits it.** This is the same rule the event model applies to message types
   ([ADR-0007](0007-outbox-pattern.md)): `identity.email.send.v2` is a new type, and
   a consumer deployed to understand `v1` is never handed a `v2` body.
6. **A mistake is corrected by a second migration, never by reverting the first.**
   A corrective migration is a normal, expected artifact; a schema that has been
   "rolled back" is a state the system has no path to.
7. **Destructive change — dropping a column, purging data — happens only when the
   old code cannot be promoted again**, and that is a judgement about which version
   ids still exist in Cloudflare and are eligible for
   [rollback](0013-immutable-worker-versions.md), not a judgement about the current
   release. It is a separate, deliberate act.

**Enforcement:**

| Boundary                                                           | Enforced by                                                                                                                                                                                                                          | Exists today                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No down migrations are written                                     | Review of every file in `database/identity/migrations/`: a `DROP`, a `RENAME`, or a `NOT NULL` without a default is a review failure                                                                                                 | **Enforcement not yet built**; the directory exists and the rule is stated in `AGENTS.md` "Prohibited shortcuts" and here. A lint over the migration files is a candidate for `check-architecture.mjs` in the platform phase                                                                                                              |
| A migration is backward-compatible with the live version           | The same review, plus the deploy order in `.github/workflows/` (migrations before promotion)                                                                                                                                         | **Enforcement not yet built**; the workflows are being written in the platform phase                                                                                                                                                                                                                                                      |
| Migrations run only through the Worker deploy path                 | The `migrations_dir` in the `identity` wrangler configs, which points at `database/identity/migrations/`; the migration step in the deploy workflow; and the absence of any other credential that can reach a production D1 database | **Partially built.** The `migrations_dir` is committed in each `identity` config — `.generated/cloudflare/{development,staging,production}/identity/wrangler.jsonc` — and is the only one in the tree; the two non-production configs name the same `database/identity/migrations/`. The workflow step is `DEFERRED` to the release phase |
| The Admin Worker has no migration path, because it has no database | `database/admin/migrations/` is empty, and `.generated/cloudflare/<env>/identity-admin/wrangler.jsonc` declares no `d1_databases` block at all                                                                                       | Yes. Read from the three admin configs and the empty directory. `pnpm arch`'s `boundary-1-admin-d1` check is what keeps it that way                                                                                                                                                                                                       |
| The rule reaches code, not just SQL                                | `AGENTS.md`: "No forward-incompatible database migration. There is no database rollback; a migration may only add"                                                                                                                   | Prose — in force now                                                                                                                                                                                                                                                                                                                      |

## Consequences

### Easier

- **The previous code always runs.** At every point, the currently live Worker
  version works against the current schema. Rollback is a version promotion and
  nothing else ([ADR-0013](0013-immutable-worker-versions.md)), which is what
  makes rollback a two-minute operation rather than a restore.
- **Migrations are ordinary deployments.** They go out the same gated path as the
  code, so "the migration is applied but the code is not" is a state the system
  passes through on purpose, automatically, and not a state anyone has to
  remember to clean up.
- **A mistake is always correctable.** Nothing is lost that a forward migration
  cannot fix, because nothing is removed.
- **The deploy order is simple and one-directional.** Migrate, then promote. There
  is no ordering to get wrong between two data steps and no coordination with a
  rollback.
- **The schema tells the truth about what happened.** Every corrective migration is
  in the history, so the schema's awkwardness is a record of what went wrong, which
  is more useful than a history that has been rewritten.

### Harder or more expensive

- **A rename costs three deployments.** Add, backfill, dual-write, and only then
  stop using the old column. That is a slow, slightly embarrassing way to change a
  column's name, and it is the single most complained-about consequence of this
  ADR.
- **A mistake is permanent.** A bad column type, a bad index, a bad constraint
  stays in the schema until a later migration corrects it, and the correction
  costs a migration. The system has no "undo", and by design.
- **Schemas grow.** Columns that are no longer used are retained indefinitely,
  because dropping one requires proving that no promotable version reads it. The
  database accumulates historical shape, and every future reader has to work out
  which columns are live. `docs/architecture/data-model.md` owns the answer, and
  keeping it accurate is a real cost.
- **Reviewing a migration needs more than reading the SQL.** "Is this
  backward-compatible" is a question about the currently deployed version, not
  about the file. That is a harder review than a diff, and it is the review that
  matters.
- **Some changes are genuinely impossible.** Deleting a user's data on request —
  a right-to-erasure flow — is a narrowing. It has to be done as "the row is gone"
  with a forward migration plus a runtime path, and there is a point at which a
  table has to be dropped and the argument for keeping it is purely historical.

### What a future maintainer will resent

- **"Just rename the column."** It is a three-deployment change and it will be
  asked for repeatedly, because the correct answer is not obviously correct to
  someone who has just looked at a table with a badly named column. The answer is
  add, backfill, dual-write, and leave the old one alone.
- **Dropping a now-unused column.** This will look like pure hygiene and it is the
  constraint's sharpest edge: an unused column is not unused if a promotable
  version reads it, and a version can be promoted for as long as it exists in
  Cloudflare. Expect the argument, and expect to lose it.
- **A schema with five versions of the same concept in it.** The accumulated shape
  is the visible cost of this decision, and it is the thing that will make someone
  eventually propose a "clean up the schema" migration that is not
  backward-compatible. The correct response is to do it when the old versions are
  genuinely unreachable, and not before.

## Alternatives considered

### Down migrations, and a rollback that runs them

**Rejected**, and it is the option a database host is designed around, and the
reason it loses is the asymmetry established in the Context: a Worker rollback
promotes a previous version immediately, and a down migration is a separate, slow,
data-touching operation that must be sequenced against that promotion. Two
rollback mechanisms that must agree, do not. In practice the down migration is the
one that gets skipped, because it is the slow one and the incident is happening
now — and the system ends up with the new code's expectations on the old schema,
which is worse than either rollback.

### A rollback that restores a point-in-time database snapshot

**Rejected** as a database rollback path, and this is the one that needs the
clearest reasoning, because it _is_ a real capability and it is the right tool for
some events. The distinction is scope: **restoring a snapshot is disaster recovery,
not deployment rollback.** It loses every write since the snapshot, which for an
identity system means losing real accounts, real sessions and real audit events.
Using it as a rollback mechanism means accepting data loss as a routine part of
recovering from a bad deploy, and the discipline that follows — "we can always
restore" — is precisely what leads to somebody doing it. The correct path for a bad
deploy is a version promotion ([ADR-0013](0013-immutable-worker-versions.md)); the
correct path for data corruption is a restore, and it is an incident, not a
rollback.

### Expand-and-contract, with a hard rule that nothing is ever dropped

**Rejected** as stated, because "never dropped" is not sustainable: a table with
every historical column of every concept is one nobody can read. The
expand-and-contract _discipline_ is exactly this ADR's rule (add, backfill,
dual-write, then stop using); what this ADR rejects is only the absolute "never
drop". Dropping is allowed once no promotable version reads the old shape, and
that is a deliberate act with a named condition, not a routine cleanup.

### Schema-per-version, where each Worker version brings its own schema

**Rejected** because a Worker version is a promotion, not a deployment with its
own database. Three versions at 50% traffic would need three schemas, the D1
binding is one, and the "rollback promotes the old version" story
([ADR-0013](0013-immutable-worker-versions.md)) stops being a promotion. It also
makes the D1 binding a per-version capability, which undoes
[ADR-0003](0003-identity-d1-single-owner.md)'s single-writer story.

### Accept forward-incompatible migrations and require code and schema to be

promoted together, atomically

**Rejected** because Cloudflare does not offer an atomic code-and-schema
promotion, and a process that depends on one is a process that will eventually
skip the ordering. Even if it were offered, "the previous version can never be
promoted again" would be a much stronger constraint than "the previous version
still works", and it would make
[ADR-0014](0014-canary-promotion-identity.md)'s canary ladder — which deliberately
runs the old and new versions simultaneously at 1%, 10%, 50% — impossible.

## Revisit when

- **A change cannot be expressed as add-then-stop-using** — observable as a
  feature that genuinely requires removing a column that is still read by a
  promotable version, or a narrowing that no three-deployment sequence can avoid.
  At that point the options are: wait for the old versions to expire from
  Cloudflare, or change the constraint with an ADR. Both are legitimate; doing
  neither and dropping the column is not.
- **The data model needs a different kind of change** — for example a table that
  must be dropped and rebuilt for a storage-level reason, or a data correction
  that has to rewrite history (a right-to-erasure flow that a forward migration
  cannot express). This is a data-protection requirement colliding with a
  deployment discipline, and it needs its own ADR, because one of them has to
  give.
- **Cloudflare ships a per-Worker-version database binding or a schema migration
  that is atomic with a promotion.** That would remove the asymmetry the whole ADR
  rests on, and the ADR should be superseded rather than amended.
- **The accumulated schema becomes a real burden** — observable as
  `docs/architecture/data-model.md` no longer being able to state which columns are
  live. The answer is a drop migration gated on version eligibility, not a
  relaxation.
- **A migration has to be applied to a database that has already drifted** — for
  example after an out-of-band change
  ([ADR-0003](0003-identity-d1-single-owner.md) forbids this, so reaching this
  condition means a control failed, not that the ADR is wrong).

## Related

- [ADR-0003 — Identity D1 is reachable only by the Identity Worker](0003-identity-d1-single-owner.md)
  — why a migration is a deployment and runs through the Worker
- [ADR-0007 — The outbox pattern and the absence of atomicity](0007-outbox-pattern.md)
  — the same add-only discipline applied to event types in a message name
- [ADR-0012 — Release is not deployment](0012-release-is-not-deployment.md)
  — the general rule this ADR is the database instance of
- [ADR-0013 — Immutable Worker versions; rollback never rebuilds](0013-immutable-worker-versions.md)
  — the asymmetry that makes a down migration unusable
- [ADR-0014 — Canary promotion for Identity; automatic for Admin and Jobs](0014-canary-promotion-identity.md)
  — the canary runs two versions at once, which is only possible because both
  run against the same schema
- `AGENTS.md` — "No forward-incompatible database migration" in Prohibited shortcuts
- `database/identity/migrations/` — the migrations, and the ones that are being
  written. The tree is split by **data owner**, not by convenience:
  `database/identity/{migrations,seeds,fixtures}/` and
  `database/admin/{migrations,fixtures}/`. `database/admin/migrations/` is empty,
  and that emptiness is [ADR-0004](0004-admin-worker-holds-no-database.md)'s
  direct consequence — the Admin Worker has no database, so it has nothing to
  migrate
- `docs/architecture/data-model.md` — the owner document for the schema's consequences
