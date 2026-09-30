# Security Policy

## Supported versions

Ecoma Identity is **pre-release**. No version has been released yet — the
repository carries no tags, and nothing is deployed to a production account.
There is therefore no supported-version matrix to publish, and publishing one
would be a claim about a release that does not exist.

**What is supported: the current `main` branch.** Security fixes land there.
If you are running Ecoma Identity at all, you are running it from source, and
updating means pulling `main`. This will be replaced by a real support policy
when the first version ships, not amended into place.

## What actually runs today

Read this section before deciding whether a finding is a bug or a
non-existent-surface report. A claim in this file about a product surface is a
claim about code that executes; treat a mismatch between this section and the
code as a bug in this file.

**Live and executing:**

- Three Cloudflare Workers — `identity`, `identity-admin`, `identity-jobs` —
  with health and readiness endpoints, a routing table, and a binding surface.
  They perform no authentication. Every declared protocol route answers
  `501 Not Implemented`, and `/ready` reports that authentication is not
  implemented rather than reporting a service that is ready to authenticate
  anyone.
- The architecture guard (`tooling/scripts/check-architecture.mjs`), the CI
  workflows, and the build, release and rollback paths.
- The migrations under `database/migrations/`, which are forward-only and
  additive.

**Present as types and contracts, executing nothing:**

- The domain model, the use-case ports, the OIDC wire types, the ten security
  service interfaces, the WebCrypto adapters that satisfy them, and the D1,
  Queue and KV adapters.
- The four API contracts under `contracts/`, the two Vue frontends, and the
  operator console.

**Not present at all:** no email is sent, no message is consumed into a real
side effect, no token is signed or verified on a live path, no user can
authenticate, and no third-party OAuth or OIDC provider is contacted.

That boundary is the most important thing in this file. The interesting
vulnerabilities in an identity system are the ones in the flows; the flows do
not run yet. A finding in a type, a port signature or a contract is a real
finding, but it is not an exploitable vulnerability in a deployed service, and
saying so plainly is more useful than inflating it.

## Reporting a vulnerability

**Do not open a public issue.** A public disclosure gives an attacker a head
start, and in an identity system the disclosure window is the whole game.

Email **john.itvn@gmail.com** with:

- a description of the vulnerability,
- steps to reproduce, or a proof of concept,
- your assessment of the impact,
- which layer it is in — a live endpoint, the build and release path, or a
  type or contract that does not execute yet.

You will receive an acknowledgement within 48 hours. If you have not heard back
in that time, follow up by email.

If a fix requires changing one of the repository's hard constraints — the three
deployables, the Admin Worker's lack of a database, the Jobs Worker's lack of
identity state, the no-rollback migration rule, the no-rebuild rollback rule —
the fix needs an ADR, and the process will be slower on purpose.

## What counts as a vulnerability here

The threat surface is narrow and specific. The classes below are the ones this
repository can actually have, roughly in order of how much they would matter.

**A gate that reports nothing when it should report something.** This is the
most dangerous class of defect in this repository. The whole architecture is
held up by `tooling/scripts/check-architecture.mjs` and the wrangler
configuration, and both are static text over a package tree that whoever opens a
pull request controls. If you can make the guard produce an empty result
where a real violation exists — by supplying a crafted `Cargo.toml`, a
directory name, a `wrangler.jsonc` comment, a `.gitignore`d file, a path the
YAML or JSONC reader mishandles — that is a security-relevant false negative,
not an ordinary bug. Report it here rather than as a public issue.

**The `identity-jobs` crate gaining a dependency it must not have.** The Jobs
Worker is a background side-effect worker. The moment it can name
`identity-domain` or `identity-application`, a queue message becomes a
path to evaluating identity rules, and a message is not a trustworthy caller.
The guard checks the `Cargo.toml`; if you find a way around it — a re-export, a
build script, a path dependency, a `dev-dependencies` that leaks into a release
build — that is the finding.

**The Admin Worker reaching the identity database.** It has no D1 binding and
must not acquire one. The guard checks the source and the wrangler
configuration; a binding introduced under a name the check does not recognise,
or a service binding pointed at the database rather than the Worker, is the
finding.

**A forward-incompatible migration.** There is no database rollback. A
migration that drops, renames or narrows anything the previous Worker version
reads will break the running version during a canary, and the rollback that
would fix it cannot restore the schema. The rule is that a migration may only
add.

**A rollback that rebuilds.** A rollback promotes an existing immutable Worker
version id. A rollback workflow that checks out the repository, builds, tests or
packages has not rolled anything back — it has deployed a new version with a
different artifact and called it a restore. This is a correctness failure with
an availability consequence, and it is the kind of thing that looks right in
review.

**Secrets reaching a tracked file.** `.dev.vars`, any `.env` that is not an
`.example`, `*.pem`, `*.key`, `*.p12`, or a real Cloudflare resource id in
`wrangler.jsonc`. Note that a resource id is not a credential, but publishing
one for a production account still tells an attacker where to aim.

**Cryptography that is not WebCrypto.** Any hand-rolled cipher, hash, MAC,
padding scheme or constant-time comparison, and any cryptography crate added to
`Cargo.toml`. A `==` over secret-derived bytes is a timing side channel even
when it is written to look constant-time.

**Supply chain in GitHub Actions.** Every workflow pins its actions. A mutable
reference (`@v4`) where the org convention calls for a commit SHA is a finding,
because a tag can be moved. Report which workflow and which action.

**A boundary that is only in prose.** If a constraint in `AGENTS.md` or in
`docs/architecture/` has no mechanical enforcement, and you find the way around
whatever enforcement does exist, that is the finding. The inverse — a
constraint with enforcement that is quietly weakened, suppressed or made
tolerable — is equally a finding. Never weaken a constraint to make a gate
green; that is the failure mode this repository is most exposed to, because it
looks like progress.

## What is not a vulnerability

- **The 501s.** Every protocol route answering `501` is the designed state of
  the bootstrap, documented in `contracts/` and reported by `/ready`. A missing
  `404` for a declared route is intentional: a client that sees `501` knows to
  stop.
- **No authentication existing.** Not a bug. It is the phase.
- **The `#[ignore]`d domain invariants.** They are named, reasoned and runnable
  with `moon run identity-domain:test-invariants`. Their being ignored is the
  honest state, not an oversight.
- **Placeholder adapters that return a documented "unimplemented" error.** A
  method that refuses with a named error is doing its job. A method that returns
  a plausible fake success is a finding, and this repository treats it as one.
