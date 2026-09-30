# Secrets management

What this document is: what counts as a secret in this repository, where each one
lives, how it reaches a Worker, and how it is rotated.

What this document is **not**: a place to put a secret's value. This document
names **key names** and locations. A value that appears here is a leak.

## Status

| Fact                                                                 | State                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The classification of what is and is not a secret                    | `IMPLEMENTED` — this document and the `AGENTS.md` prohibitions         |
| `.dev.vars` gitignored, `.env*` gitignored, `.example` files instead | `PLANNED` — decided; the ignore rules and example files are `DEFERRED` |
| CI secret names                                                      | `PLANNED` — the workflows are `DEFERRED`                               |
| Every secret's runtime home                                          | `PLANNED` — decided; the `wrangler.jsonc` files are `DEFERRED`         |
| Secret values in any environment                                     | none exist — nothing is deployed                                       |

**There is no secret in this repository and no deployed environment.** The
question this document answers is where each one will live when there is one.

## What is a secret

A value is a secret if knowing it lets someone do something they are not already
entitled to do. That definition, applied:

| Classification                         | Examples                                                                                                                                                    | Handling                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Secret**                             | Client secret (at issuance), TOTP enrolment secret, recovery code batch, session token, the D1 database credentials, the signing key material, any CI token | Never in a tracked file. Never in a log. Never in an error message. Never in a URL.                                                           |
| **Secret-adjacent, treat as a secret** | The session cookie's value, an authorization code, an OTP, a passkey assertion, a `Set-Cookie` header, an `Authorization` header                            | Same handling. These are bearer credentials for the duration of their life, and their lifetime is not under the holder's control.             |
| **Configuration, not a secret**        | The issuer URL, the account id, a database id, a queue name, a KV namespace id, the OIDC signing algorithm, an environment name                             | Public by construction. **But see the note below: resource ids are injected rather than committed, which is stricter than this row implies.** |
| **Public by definition**               | A `client_id`, a `UserId`, a `SessionId`, a redirect URI, a scope name, an email address _as a field name_                                                  | In tracked code and in responses. `client_id` identifies the client; it does not authenticate it.                                             |

### Resource ids: configuration that this repository still does not commit

The table above classifies a database id, a queue name and a KV namespace id as
configuration, and that classification is correct — they are resource _names_,
not bearer credentials, and Cloudflare's own API discloses them to anyone who
can authenticate. It is recorded here because the deploy behaviour is stricter
than the classification implies, and a reader comparing this document against
`infra/cloudflare/production/*/wrangler.jsonc` will notice the difference and
should not have to guess which one is wrong.

**The behaviour: resource ids are injected at deploy time and are not
committed**, in every environment including production. The reason is not that
the values are secret; it is that publishing the production identity database's
id during an incident hands an attacker the one thing they would otherwise have
to guess. The cost is one injection step; the benefit is that a leaked clone, a
fork, a CI log or a screenshot of a diff names no production resource at all.

So: **classification is "configuration", handling is "injected".** Both are
deliberate and they answer different questions — the first is what the value
_is_, the second is what an attacker learns from seeing it. If a future change
wants to commit these ids, the change belongs in this document first, and it
should say explicitly what is given up.

The line that gets crossed most often is the third-to-second one: a
configuration value that "looks sensitive" and is therefore kept out of git,
until someone needs to know what it was and finds it in a developer's shell
history. If a value is genuinely public, committing it is correct. If it is
genuinely a secret, `.example` with a placeholder is the only tracked form. The
uncomfortable middle — "we are not sure, so we will keep it out of git" —
produces a value nobody can reconstruct and everybody is afraid to rotate.

## Where each secret lives

| Secret                      | Development                                                                | Staging          | Production       | How it reaches the Worker                                                                               |
| --------------------------- | -------------------------------------------------------------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| D1 database credentials     | `.dev.vars`, from `wrangler d1` local state                                | Wrangler-managed | Wrangler-managed | The `IDENTITY_DB` binding. **No credential in `wrangler.jsonc`.**                                       |
| Cloudflare account id       | `.dev.vars`                                                                | CI secret        | CI secret        | Variable; not a secret at rest, but environment-scoped                                                  |
| Signing key material        | `.dev.vars`                                                                | Wrangler secret  | Wrangler secret  | `wrangler secret put`                                                                                   |
| Client secret (at issuance) | Never persisted; returned once in the response body                        | Same             | Same             | It exists in one response and in the user's password manager. There is no copy to rotate on the server. |
| TOTP enrolment secret       | Generated at enrolment, stored hashed-encrypted in `authenticators.secret` | Same             | Same             | Written through the Identity Worker; the plaintext exists in one request and one response               |
| Recovery code batch         | Generated at issuance, returned once, stored hashed                        | Same             | Same             | Same as a client secret                                                                                 |
| CI deploy token             | n/a                                                                        | CI secret        | CI secret        | GitHub Actions secret, masked in logs                                                                   |
| Email provider API key      | `.dev.vars`                                                                | Wrangler secret  | Wrangler secret  | The `EMAIL_PROVIDER` binding's configuration; `DEFERRED`                                                |

**The load-bearing rule:** a Cloudflare _binding_ is not a place to put a secret's
value in a config file. `wrangler.jsonc` names `IDENTITY_DB` and
`IDENTITY_QUEUE`; the credentials behind them live in Cloudflare and are never
in the repository. The only secrets a repository may hold are in a `.example`
file, as a placeholder.

## Local development

`.dev.vars` is gitignored and holds **real** secrets, because constraint 26
forbids an authentication bypass: local development runs the same code path as
production, with real secrets, and there is no dev-mode shortcut that widens
anything. A local environment that authenticates differently from production is
not a convenience; it is an environment where the deployed path is never
exercised.

The corresponding `.example` file is tracked and lists the **key names** with
values that are visibly placeholders:

```ini
# .dev.vars.example — the key names local development needs, and nothing more.
# Copy to .dev.vars and fill in real values. .dev.vars is gitignored; this file
# is tracked. A real value must never appear in this file.
#
# The values below are placeholders, not defaults. There is no "development
# signing key" that works everywhere: the local key pair is generated per
# machine by `wrangler secret put` in the local environment, and it is not
# shared with anybody.

CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000
CLOUDFLARE_API_TOKEN=replace-me-with-a-local-development-token
```

**What must never appear in a tracked `.example`:** a working credential, a real
account id, a real signing key, or a value copied from a running environment.
The purpose of the example file is to tell a developer _what to go and fetch_,
not to make a developer's life easier by carrying the value.

## Rotation

Every secret has a named rotation procedure, and the procedure is part of the
definition. A secret with no documented rotation is a permanent credential.

| Secret                  | Rotation procedure                                                                                                                                                                                                                                                                                | Blast radius if leaked                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| D1 database credentials | Cloudflare-managed. The binding follows the database; rotate at the Cloudflare account level.                                                                                                                                                                                                     | Full read/write on identity state. The whole platform.                          |
| Signing key             | Generate a new key, add it to the JWK set with a **new** `kid`, promote, then remove the old key once no live token carries the old `kid`. Never replace in place: a token signed with the old key must remain verifiable until it expires, and removing the key early invalidates live sessions. | Forge any `id_token`. Total compromise of the trust chain.                      |
| Client secret           | The `RotateClientSecret` command returns a new secret plus `previous_secret_valid_until_ms` — the old secret's **expiry**, not the old secret. Both are valid until that expiry, so a rotation is a grace window, not a cutover.                                                                  | Act as that client: authorize as any user who has authorized it.                |
| TOTP secret             | Re-enrol. The old secret stops working when the authenticator row is replaced, and the user's other factors must be re-checked, because re-enrolment is a security-posture change.                                                                                                                | A permanent second factor for that account.                                     |
| Recovery codes          | Regenerate the whole batch. Single-use means a partially-leaked batch is bounded, but a full batch is a full second-factor bypass.                                                                                                                                                                | Bypass the second factor entirely.                                              |
| CI deploy token         | Revoke in GitHub, re-issue, update the Actions secret.                                                                                                                                                                                                                                            | Deploy arbitrary code to production, which is arbitrary code execution.         |
| Email provider key      | Revoke with the provider, issue a new one, `wrangler secret put` in each environment.                                                                                                                                                                                                             | Send mail as this service, to anyone, with this service's domain in the `From`. |

Two rules that apply to every rotation:

- **Rotation is not deletion.** In every case above, the old value has a
  lifetime during which it still works, and the procedure names what ends that
  lifetime. A rotation that leaves the old value valid indefinitely is a
  rotation that did not happen.
- **Rotation is auditable.** `ApplicationSecretRotated` is one of the 21
  `AuditEventType` values, so a client-secret rotation is a queryable fact, not
  a line in a deploy log. A rotation with no audit record is a rotation an
  investigator cannot see.

## What is never logged

A restatement of SC-24 from [security-constraints.md](security-constraints.md),
because the failure mode is specific: logs are longer-lived, wider, and less
protected than the system they describe, and a session token in a log aggregator
is a session that **cannot be invalidated by revoking the session**.

Never logged, at any level, including at `debug`:

- client secrets, TOTP secrets, recovery codes;
- session cookie values, `Set-Cookie`, `Authorization` headers, `Cookie`
  headers;
- authorization codes, OTPs, refresh tokens, `code_verifier` values;
- passkey assertions and challenges;
- the `token`, `code`, `code_verifier`, `client_secret` and `state` request
  parameters.

Never forwarded to a client:

- `ApplicationError::Dependency` reasons — a `Dependency` reason can carry a
  database error string, and its code is deliberately the single
  `internal_error`;
- `SecurityError::MissingSecret` — the variant carries the **name** of the
  absent secret, which tells a caller which key is misconfigured;
- `SecurityError::Cryptographic` — the message can carry a key name;
- `SecurityError::RateLimiterUnavailable` — the reason is operator-facing.

The redaction is in the types, not at the call sites. `ClientSecret`,
`TotpSecret` and `RecoveryCodeBatch` have redacted `Debug` and `Display`
implementations, and there are tests asserting it. This is deliberate: a
`{:?}` of a value that holds a secret is a leak, and relying on every call site
to remember is a discipline problem rather than a control.

## A `Debug` derivation is a leak

The specific failure, worth naming because it is common and because it looks
like a debugging aid:

```text
Wanted:   rotating secret for client 7f3c…  (value hidden by the redacted Display)
Leaked:   rotating secret for client 7f3c…  old=sk_live_9a41…  (derived Debug)
```

The two lines are what the same call site produces with and without a redacted
`Debug`. A `#[derive(Debug)]` on a type that holds secret material is the second
line, in every log statement, forever.

The redaction means the second line prints a placeholder. The rule is therefore
not "be careful with `Debug` at the call site" — it is "a type that holds
secret material must not have a `Debug` that reveals it", and the same for
`Display`.

## If a secret is exposed

The procedure, because the time between exposure and rotation is the whole
problem:

1. **Revoke first, investigate second.** Rotate or revoke the credential before
   reading logs. A leaked credential that is still live while an incident is
   discussed is still live.
2. Work out the blast radius from the table above. It is not uniform: a leaked
   `client_id` is not a leaked `client_secret`, and a leaked session cookie is
   the one case where the answer is to revoke the sessions.
3. For a signing key, follow the key-rotation procedure above and do **not**
   remove the old key until every live token carrying the old `kid` has
   expired.
4. Write it down. A secret exposure that is not recorded is one that recurs.
5. Never open a public issue. `SECURITY.md` — a private advisory to the
   maintainer — is the route, per `AGENTS.md`.

## Related

- [security-constraints.md](security-constraints.md) — SC-05 (no
  self-implemented cryptography), SC-07 (no secret in a tracked file), SC-11
  (client-secret handling), SC-24 (never logged).
- [threat-model.md](threat-model.md) — what an attacker wants each of these
  values for.
- [../getting-started/local-development.md](../getting-started/local-development.md)
  — how `.dev.vars` is filled in locally.
