# Why the Admin Worker has no database

What this document is: the argument for a single hard negative — the
`identity-admin` Worker holds **no `IDENTITY_DB` binding, in code and in
configuration**, and reaches identity through the private `IDENTITY` service
binding and nothing else.

What this document is **not**: a description of the admin surface, a list of
admin routes, or a plan for the admin database. If the Admin Worker has an
administrative database of its own, it is not identity state, and this document
does not authorise reading it as if it were.

This document exists because this is the constraint most likely to be broken by
a well-meaning change. "This query is simpler through D1" is a sentence someone
will say, and it will be said about a report an operator needs.

## Status

| Fact                                                                 | State                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The Admin Worker holds no `IDENTITY_DB` binding                      | `PLANNED` — decided (`AGENTS.md`, the brief's constraint 3); the configuration that proves it is `DEFERRED` |
| The Admin Worker reaches identity through `IDENTITY`                 | `DEFERRED` — the binding is named, the client is `DEFERRED`                                                 |
| An admin database distinct from identity state                       | `DEFERRED` — the `database/admin/` directory exists; what it holds is `PLANNED`                             |
| Every admin action is an application-layer command inside `identity` | `DEFERRED` — the commands are `SCAFFOLDED` as traits in `identity-application`                              |
| A rate limiter and static assets on the Admin Worker                 | `DEFERRED`                                                                                                  |

Every claim here is a decision, not a running behaviour. Nothing about the admin
surface is implemented.

## The constraint

From the founding constraints (see the ADR this belongs to; the record is
[`../adr/`](../adr/)):

> The **Admin Worker MUST NOT** access Identity D1 directly.
>
> The Admin Worker reaches identity through a **private service binding** to the
> Identity Worker.

The manifest says the same thing, in the only form that cannot be worked
around. `apps/identity-admin/worker/Cargo.toml` does not name a D1 adapter for
identity, and its own comment says why: a manifest-level omission is the only
kind of boundary that cannot be bypassed by a careless import.

## The binding set, so there is no ambiguity

The Admin Worker's bindings are `IDENTITY` (service binding to the Identity
Worker), `ADMIN_RATE_LIMITER`, and `ASSETS` (its static web UI). There is no
`IDENTITY_DB`. The full table, and the two other Workers' bindings, are in
[worker-architecture.md](worker-architecture.md).

An absent binding is not a policy you can configure. It is a capability the
runtime does not hand the isolate. Even a determined bug in the Admin Worker —
a traversal, an injection in a filter, a confused deputy in a request handler —
stops at the edge of a capability the Worker was never given. This is why the
constraint is written as "no binding" rather than "do not query it": the first
is a control, the second is a request.

## The two arguments

### 1. The confused deputy

A deputy is someone who acts with another party's authority. The classic
confused deputy appears the moment a component is asked to answer a question it
is not the authority on, and answers it in terms of what it can see.

Suppose the Admin Worker could read D1. An operator-level request arrives:
"list users matching this filter, as a CSV report." If the report is built with a
SQL query written in the Worker, then the report generator — a function whose job
is formatting — now decides which columns of which rows are visible. The person
who wrote that function was thinking about CSV column order. They were not
thinking about the fact that they had just become an authorisation decision.

The same shape appears in the ordinary cases:

- A report that joins `users` to `sessions` to `audit_events` will, in the
  ordinary course of finishing the feature, include the columns that make the
  report useful. Session identifiers, last-used timestamps, and audit metadata
  are all things an operator legitimately wants in a report, and all things
  that are credentials-adjacent.
- A "count the sessions for this user" widget becomes a per-user activity
  signal. In an identity system, knowing when a specific person is active is the
  first half of an account-takeover attempt.
- A filter that ends up parameterised as `${filter}` rather than a bound
  parameter is not an attack anyone has to attempt; it is a maintenance
  accident waiting for a feature request that mentions a specific email address.

None of these require an attacker. That is the point: each is a plausible
feature that is one line away from turning the Admin Worker into an
unauthenticated-in-practice read path over the user table, guarded by whatever
the report's own access check happens to be. Once the query is in the Worker,
the _audit trail for the read_ is the report writer's own logging, not the
Identity Worker's. There is a hole in the audit trail exactly where the system
is least likely to be looking.

The service binding removes the category. The Admin Worker cannot write the
query, because it cannot reach the table. The decision about what an operator
may see is made inside the component that owns the data, is reviewed as an
identity decision, and is written to the same audit trail as everything else.

### 2. Blast radius

The Admin Worker is the component most likely to be compromised, and the least
likely to be the target of a careful attack. It is an internal-facing surface
with a small, enumerable set of routes. It is where a new report goes. It is
where a "temporary" script gets wired in during an incident. It has the
lowest-quality inputs of the three Workers, because its inputs are partly
free-text search terms typed by people in a hurry.

Given that, the question is what an attacker who reaches it gets.

| Admin Worker can reach                             | Blast radius                                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity state through reviewed internal endpoints | Whatever those endpoints were designed to expose, and every read is attributable to an actor in the audit trail.                                                                                                                            |
| Identity D1 directly                               | The entire user table: every user, every identity, every authenticator, every session, every application registration and its client-secret hash. Password-equivalent for every account on the platform, immediately, with no further work. |

There is no middle option and no "read-only" D1 binding. D1 credentials are
read/write authority over the whole database. A read-only report capability
built on a read-write credential is not a reduced-privilege design; it is a
reduced-privilege _convention_, and conventions are what fail at 2am.

The second row is the reason the constraint is absolute. Blast radius is not a
function of how careful the code is. It is a function of what the component can
reach.

## The design pattern that satisfies the constraint

The intended shape, which is `DEFERRED` end to end:

1. An administrator authenticates **to the Admin Worker**, through the Admin
   Worker's own session. The Admin Worker is a BFF behind its own web app;
   constraint 8 makes the frontend and the BFF one release unit.
2. The Admin Worker calls a named internal endpoint on `identity` through the
   `IDENTITY` service binding. The request is typed — it is a
   `identity-application` command, not an ad-hoc HTTP call — and it names the
   operation.
3. `identity` performs its own authorisation for the operation. It does not take
   the operator's word for who they are, and it does not take the Admin Worker's
   word either; see the warning in
   [trust-boundaries.md](trust-boundaries.md) about actor identity on a private
   binding, which is an open `PLANNED` design.
4. `identity` writes the state and the audit event in the same transaction.
   The audit trail is a property of the mutation, not of the caller's logging.

Everything the Admin Worker does to identity state is therefore a use case in
`identity-application`, with a typed input, an actor, a rule, and an audit
event. The Admin Worker is a renderer of results.

## What to do when a query genuinely cannot be served

The honest failure mode: an operator needs something the internal endpoints do
not expose, and the temptation is to reach past the service binding. **Do not.**
The escalation path is an ADR, not an exception. In order:

1. **Write down the need.** What does the operator want to see, and why can they
   not get it another way? A need that cannot be stated in one sentence is
   usually a UI problem, not a data problem.
2. **Check whether the need is a new _endpoint_, not a new _binding_.** Most
   "D1 would be simpler" cases are an endpoint that does not exist yet. A new
   internal endpoint keeps the constraint and costs one reviewed use case.
3. **If it really needs a new read path, it gets a new internal endpoint with
   its own audit event.** Not a bypass. Not a report flag. An endpoint.
4. **If the need genuinely cannot be served by `identity` at all**, then it is
   not identity data, and it belongs in the Admin Worker's own database
   (`database/admin/`) — if such a database is ever created, and what it may
   contain is a `PLANNED` decision with its own ADR. Identity state is never
   copied into it. A copy is a second source of truth, and
   [event-model.md](event-model.md) exists to explain why that is worse than
   it sounds.
5. **If none of the above is possible**, write an ADR that proposes changing the
   constraint, and take it through review. Constraint 29 of the founding list
   says changes to constraints 1–28 need an ADR first. There is no path where
   the answer is "this one query is an exception".

## The legitimate escape hatch, and why it is narrow

There is one place the Admin Worker legitimately touches a database, and it is
not identity state: its own administrative storage, if the design ever creates
any. Two rules bound it.

- It is a **different database**, with different credentials, that contains no
  user, session, credential or authentication record.
- It is bound through a **differently named binding**, so that a
  `grep IDENTITY_DB` in `infra/cloudflare/` finds the identity binding exactly
  once.

The second rule is what makes the first enforceable by a reviewer. A binding
name is the cheapest possible way to make a promise greppable, and the entire
architecture check is built on the premise that these promises should be
checkable by a script rather than by a reader's memory.

## How a reviewer checks this

In order, cheapest first:

1. `grep -rn "IDENTITY_DB" infra/cloudflare/` returns hits in exactly one
   `wrangler.jsonc`, the `identity` one.
2. `apps/identity-admin/worker/Cargo.toml` names no D1 adapter for identity.
3. `pnpm arch` passes — the architecture gate judges the dependency graph from
   `cargo metadata`, not from source-text heuristics, so an import that reaches
   past the binding fails too.
4. There is no admin route whose handler is anything other than a typed
   application-layer command or a formatter.

If any of those fails, the change is wrong, regardless of how good the report
would have been. That is the intended friction. The report is not the
deliverable; the operator getting their data is. If the two come into conflict,
the report loses, because the report is the thing that is easy to add and hard
to remove.

## What breaks, stated once more

If the Admin Worker gains a path to identity state, the following stop being
true, and each is a control the system currently relies on:

- One component decides who may see identity data.
- Every identity read and write is attributable to an operator in the audit
  trail, because the audit trail is written by the component that performs the
  mutation.
- A compromise of an internal-facing surface with low-quality inputs does not
  become a compromise of every account on the platform.
- The last-administrator invariant is enforced in one place, inside the
  transaction that applies the change, rather than in two places that can drift.

None of those has a compensating control.

## Related

- [trust-boundaries.md](trust-boundaries.md) — the full boundary map.
- [worker-architecture.md](worker-architecture.md) — the binding tables.
- [jobs-isolation.md](jobs-isolation.md) — the other negative boundary.
- [crate-dependency-law.md](crate-dependency-law.md) — why the Admin Worker's
  manifest omission is the enforceable form of this.
