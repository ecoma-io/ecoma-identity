# There are no fixtures here, and there will not be any

A fixture is data for a table. There is no admin database (ADR-0004,
`../README.md`), so there is no table to write rows into.

The fixture set you want is `database/identity/fixtures/`, including the
administrative rows: `users.sql` has exactly one active administrator, and
`audit_events.sql` has the four administrative event types that
`AuditEventType::is_administrative()` returns true for. An operator's view of the
identity database is served from Identity D1 through the private service binding,
so its fixture data belongs on the identity side.

`contracts/admin/v1/` describes the binding's shape, and is where a check on the
_response_ belongs — not a row here.
