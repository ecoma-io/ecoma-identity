# `database/identity/fixtures/` — loadable data for tests, and the queries that check it

## What this directory is

Fourteen SQL files that insert rows, and one that only reads them. Together they
are a small, internally consistent population of the Identity D1 database: eight
users, five addresses, five external identities, eight sessions, seven
authenticators, six OTP challenges, six applications, seven secrets, four grants,
four consents, four PKCE flows, eight nonces, five outbox events, seven audit
events, three rate-limit counters.

**Nothing here is a test.** A row in a fixture table is a fact about storage. The
assertions live in `tests/`, and `assert_fixture_invariants.sql` is the one place
where a fixture file's claims about itself become queries rather than comments.

## The application order, and why it is not alphabetical

```
users.sql
user_emails.sql
user_identities.sql
sessions.sql
authenticators.sql
otp_challenges.sql
applications.sql
application_secrets.sql
application_grants_and_consents.sql
pkce_challenges.sql
nonces.sql
outbox_events.sql
audit_events.sql
rate_limit_counters.sql
assert_fixture_invariants.sql      ← reads only, always last
```

Four of these files have foreign keys into `users.sql`, and every one of them
fails to apply if it is loaded first. That is deliberate: **the order is the
assertion that the files agree about which accounts exist.** A fixture that
generated its own ids would have no such property, and a mismatch between two
files is exactly what makes a test pass for the wrong reason.

`application_secrets.sql` follows `applications.sql` for the same reason;
`application_grants_and_consents.sql` follows both.

## Running them

Against a local D1, from the repository root:

```sh
pnpm exec wrangler d1 migrations apply identity-development --local   # once, from empty
for f in users user_emails user_identities sessions authenticators \
         otp_challenges applications application_secrets \
         application_grants_and_consents pkce_challenges nonces \
         outbox_events audit_events rate_limit_counters; do
  pnpm exec wrangler d1 execute identity-development --local \
    --file "database/identity/fixtures/$f.sql"
done
pnpm exec wrangler d1 execute identity-development --local \
  --file database/identity/fixtures/assert_fixture_invariants.sql
```

`tests/integration/fixtures.test.mjs` does exactly this and asserts the result.

## What `assert_fixture_invariants.sql` is, precisely

**58 `SELECT`s, no writes.** Each returns one row of
`(check_name, actual, expected)`. Read the output: where `actual = expected` the
invariant holds, and where they differ the `check_name` names the claim in the
fixture comments that is now false.

Applied to a **migrated but unseeded** database it reports 43 of 58 failing, which
was measured rather than assumed. There is therefore no silent pass for a
forgotten load, and no need for a preamble in the file guarding one.

Three checks are worth singling out, because each of them is a hazard the
coordinator's brief called out by name:

| Check                                                      | What it prevents                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `exactly_one_active_administrator`                         | A fixture with two administrators makes the last-administrator test pass for the wrong reason |
| `user_8_is_the_single_factor_account`                      | The same hazard for the last-factor lockout rule                                              |
| `exactly_two_rows_stand_in_for_the_one_global_otp_counter` | Asserting a schema guarantee that does not exist — see the note below                         |

## Three things in here that look like mistakes and are not

**1. Two rows for one global rate-limit counter.** `rate_limit_counters.sql` has
two `subject IS NULL` rows for the name `otp_send_email`, at `count = 0` and
`count = 40`. They are the same counter at two moments, so a reader can see the
increment shape rather than a frozen frame. This does **not** mean the schema
allows two global counters — it means the fixture file depicts one counter twice,
and the schema-level assertion (that a second such row is refused) is _not_ here
because a demonstration cannot live in a file that aborts on it.

**2. `authenticators.sql` gives USER 2 four factors and USER 8 one.** Both counts
are load-bearing and they are for different rules: USER 2's four exercise the
`is_second_factor()` / `is_primary_factor()` partition of `AuthenticatorKind`,
and USER 8's single row is what the "last remaining factor" lockout test needs.
A file that gave one account both properties would satisfy neither.

**3. No primary address is unverified.** `user_emails.sql` says the rule it
cannot demonstrate is "only a VERIFIED address may be primary", and the honest
consequence is that there is no violating row to find. The check asserts `0`, and
the unverified-address fixture row (USER 5's) is unverified **and not primary**,
which is the branch the schema's CHECK allows.

## The rule every fixture file follows

**A fixture file that aborts half way is not a fixture.** Every demonstration of
a refusal — a colliding unique pair, a `plain` code challenge, a
material-doesn't-match-kind row — lives in `tests/integration/schema.test.mjs`,
where a failure is an expected result rather than a broken load. Three files
(`user_identities.sql`, `pkce_challenges.sql`, `nonces.sql`) say so explicitly
where they omit such a row.

## Placeholder values, stated rather than hidden

| Column                                                               | What the values are                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `users` / `user_emails` display names, `sessions` labels             | readable text                                                                                                                                |
| `applications.client_secret_hash`, `application_secrets.secret_hash` | **readable placeholders, not digests** — the hash algorithm is `DEFERRED` and no hasher exists in this repository                            |
| `otp_challenges.code_hash`, `pkce_challenges.code_hash`              | arbitrary bytes of legal length, standing in for SHA-256 output                                                                              |
| `authenticators.secret_ciphertext` / `secret_nonce`                  | arbitrary bytes; **not** a TOTP seed and not a real ciphertext                                                                               |
| `pkce_challenges.code_challenge`                                     | **real** `BASE64URL(SHA256(verifier))` digests, with the verifiers stated per row                                                            |
| `nonces.nonce`                                                       | readable fixture strings with **no entropy** — the platform's generator is `crypto.getRandomValues` and `NonceService::issue` does not exist |
| every id                                                             | hand-written, so a second file can reference it                                                                                              |

Addresses and URIs all use RFC 2606 reserved names (`.invalid`, `example.com`), so
no fixture can deliver mail or complete a callback.

## Id prefixes, so a failure names its file

| Prefix                                     | File                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `f0000000-…`                               | `users.sql`                                    |
| `e1000000-…`                               | `user_emails.sql`                              |
| `51000000-…`                               | `sessions.sql`                                 |
| `60000000-…`                               | `authenticators.sql`                           |
| `70000000-…`                               | `otp_challenges.sql`                           |
| `80000000-…` / `82000000-…`                | `applications.sql` / `application_secrets.sql` |
| `90000000-…` / `a0000000-…`                | grants / consents                              |
| `e0000000-…` / `b0000000-…` / `d0000000-…` | PKCE / outbox / audit                          |
| `c1000000-…`                               | `rate_limit_counters.sql`                      |

## Related

- `../README.md` — why this directory exists separately from `database/admin/`
- `../migrations/0001_schema_migrations.sql` — the forward-only rule every
  migration states, and what happens when one fails halfway
- `../../../tests/integration/fixtures.test.mjs` — loads these files in order and
  asserts all 58 checks
- `../../../tests/integration/schema.test.mjs` — every refusal a fixture cannot
  contain
