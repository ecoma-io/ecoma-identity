# Seeds

## What this directory is

The place where rows the _platform itself_ would create will live.

## What is in it right now

**Nothing. There are no seed files, and the directory is empty on purpose.**

That is not an unfinished task dressed as a decision — here is the reasoning, so
the emptiness is not mistaken for an oversight and is not "fixed" by somebody
dropping in a `INSERT INTO users` statement.

A seed is a row that stands in for something the running system would have
created. Its job is to give a local database a starting state that resembles a
deployed one. At bootstrap there is no deployed state to resemble:

- **No user exists**, because there is no signup. `UserStatus::PendingVerification`
  is where `User::new` puts everyone, and the route that would move them out of it
  is `GET /oauth/authorize`, which answers **501 Not Implemented**.
- **No application exists**, because registration is a `identity-application`
  command trait that is `SCAFFOLDED` — declared, no body.
- **No session exists**, because nothing authenticates anybody.
- **No event exists**, because no command handler commits a state change, and an
  outbox row without the transaction that produced it is a lie about a fact.

A seed file here would be a row asserting a fact the code cannot produce. The
moment one exists, `pnpm verify` passes locally against a database that the
platform itself could never have built, and every later test runs against that
fiction. The database would look more useful and be less true.

## What belongs here instead, and when

The first real seed will be a row the platform can genuinely create — most
plausibly the bootstrap administrator, created by a `BootstrapCommand` that
exists. It will be added in the same commit as that command, with an audit event,
so that "who created the first administrator" is a question the schema can
answer.

That is the rule for this directory: **a seed may only state a fact the code can
create.** Everything else belongs in `database/identity/fixtures/`, where the
rows exist to exercise a specific invariant and are labelled as such.

## Related

- `../fixtures/` — deliberately-constructed rows for tests, one per invariant.
- `../migrations/` — the schema those rows are written against.
- `../../README.md` — the forward-only rule and what a half-failed migration
  leaves behind.
