# Admin has no database, and its fixtures are the proof

## The directory exists, and it has no migrations in it

```
database/admin/
├── README.md          ← this file
├── migrations/        ← a README explaining why it is empty, and nothing else
└── fixtures/          ← a README explaining the same, and nothing else
```

This is deliberate, and it is the single clearest statement of ADR-0004 in the
repository: **the Admin Worker holds no database binding.** Not "not yet" — the
architecture law, the binding table and the mechanical gate all say it never
will, and `pnpm arch` fails the build if a D1 binding named for identity appears
in the Admin Worker's generated config.

The split exists so that the difference is visible in the directory tree rather
than only in prose. `database/identity/migrations/` has sixteen files and
`database/admin/migrations/` has none, and a reader who has not read ADR-0004 can
see the asymmetry before they read either README.

## Why this is not an oversight

An empty migrations directory with a README saying "coming later" would be a lie
in the direction this repository cares about most: it would suggest an Admin
database is planned and merely unbuilt. It is not planned. The Admin Worker
reaches identity state through the private `IDENTITY` service binding and through
nothing else, so an admin database would be a second path to the same rows — which
is the boundary escape the whole design exists to prevent.

## The escape hatch, and why it does not apply here

`docs/architecture/admin-isolation.md` does permit the Admin Worker to hold its
own administrative storage: a _different_ database, with different credentials,
containing no user, session, credential or authentication record, bound through a
_differently named_ binding so that grepping for the identity binding finds it
exactly once.

**This directory does not contain that database, and there is no fixture for it.**
Nothing in the current architecture assigns the Admin Worker any state of its own.
`applications`, `application_secrets`, `consents` and `audit_events` all live in
Identity D1, and an operator action against them is a service-binding call to the
identity Worker rather than a write here. Inventing an admin-owned copy of any of
that would create exactly the second source of truth the isolation rule forbids.

So: if a future phase gives the Admin Worker its own storage, it arrives as a new
migration in this directory, under its own ADR, and it will be about operator
workflow state — not about identity. Nothing in the bootstrap anticipates its
shape, and this README will be replaced rather than extended when it exists.

## Why there are no fixtures either

A fixture for a table that must not exist is the same mistake in a different
file. `database/identity/fixtures/` exists because Identity D1 exists and is
written to by the identity Worker; this directory's fixtures would exist because
a table exists, and none does.

What the Admin Worker _does_ have is a contract — `contracts/admin/v1/` — and that
contract's own README states the same thing from the other side: it is the
private service binding's shape, it is not a database, and the route set is
contracted to answer `501 Not Implemented` in this phase.

## Related

- `../../../contracts/admin/v1/README.md` — the service binding's contract
- `../../../docs/architecture/admin-isolation.md` — the rule and its rationale
- `../../../docs/adr/0004-admin-worker-has-no-database.md`
- `../README.md` — why the top-level split exists
