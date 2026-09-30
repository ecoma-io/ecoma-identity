# There are no migrations here, and there will not be any

`database/admin/` has no migrations directory contents because **the Admin Worker
holds no database.** That is ADR-0004 and `docs/architecture/admin-isolation.md`,
and it is enforced mechanically by `pnpm arch`, not by this file.

Adding a migration here would be an architecture change, not a schema change: it
would need an ADR first, and the ADR would have to argue why a second path to
identity state is not a boundary escape.

The reasoning, and the one caveat worth stating, are in `../README.md`. The
short version: `database/admin/migrations/` being empty is the asymmetry that makes
the rule visible in the tree, and filling it in without the ADR would undo the
clearest statement of the boundary this repository has.

For the same reason there are no fixtures here either — see `../fixtures/`.
