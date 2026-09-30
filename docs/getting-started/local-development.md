# Local development

What this document is: how to run the three Workers and the two web apps on this
machine, and what has to exist before any of them start.

What this document is **not**: a deploy procedure. Deploying to a real Cloudflare
account is [first-deploy.md](first-deploy.md).

**Read this first:** nothing in this document works yet, and it will not work
after you run the commands. All three Worker crates are one-line placeholders
(`apps/*/worker/src/lib.rs`) and both web apps have no source, so there is no
Worker to start and no app to serve. The commands below are the ones that _will_
work once the code is written; several of them will fail today, and this
document says which.

## Status

| Thing                                            | State                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| The Rust toolchain and workspace build           | `IMPLEMENTED` — `cargo test --workspace` passes                                                                  |
| `identity-domain`, `identity-oidc` (as shapes)   | `IMPLEMENTED`                                                                                                    |
| The moon project aliases and the task vocabulary | `IMPLEMENTED` — `.moon/workspace.yml`, `moon.yml`                                                                |
| The pnpm workspace covering the two web apps     | `IMPLEMENTED` — `pnpm-workspace.yaml` lists both, but neither has a `package.json` yet                           |
| `wrangler` and the workerd binary                | `DEFERRED` — pinned at 4.144.0 in `package.json`; `pnpm install` has not produced a usable tree for the web apps |
| Starting a Worker                                | `DEFERRED` — the entrypoint does not exist                                                                       |
| Building a web app                               | `DEFERRED` — no source                                                                                           |
| `.dev.vars` and its `.example`                   | `DEFERRED` — gitignore rules and example files are `DEFERRED`                                                    |
| The architecture gate                            | `DEFERRED` — `pnpm arch` names `tooling/scripts/check-architecture.mjs`, which is being written                  |

## Prerequisites

Pinned by the repository, not by your shell. `.prototools` declares the versions
the org uses, and two of them are enforced by the build.

| Tool                 | Version           | Pinned where                                                                                                                                          |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                 | 24.20.0           | `.node-version`; `.moon/toolchains.yml` verifies it before running a TS task                                                                          |
| pnpm                 | 12.8.1            | `package.json#packageManager`; `.moon/toolchains.yml`                                                                                                 |
| Rust                 | stable, MSRV 1.85 | `Cargo.toml`'s `rust-version`. There is deliberately **no** `rust-toolchain.toml` — the ambient stable toolchain is the toolchain, by org convention. |
| `wrangler`           | 4.144.0           | `package.json` devDependencies                                                                                                                        |
| `moon`               | 2.5.6             | `.prototools`; the `@moonrepo/cli` devDependency                                                                                                      |
| `proto`, `cocogitto` | 0.62.3, 7.0.0     | `.prototools`                                                                                                                                         |

`proto` installs the three tools it manages. If you use it:

```bash
proto activate   # or: proto use
proto install
```

If you do not, install the versions yourself. Node and pnpm being pinned matters
most: `.moon/toolchains.yml` verifies the ambient tool against the pin and
refuses to run a TypeScript task otherwise, which is deliberate — a task that
runs against a different Node than CI used is a task whose result does not
transfer.

## Install

```bash
pnpm install
```

Two things in `pnpm-workspace.yaml` make this fail rather than warn, and both are
intentional:

- **The `allowBuilds` map.** pnpm blocks install scripts by default, and a
  non-interactive install — CI — _fails outright_ when a dependency's scripts are
  left ignored, rather than warning. The allow-list has exactly two entries and
  both are load-bearing: `wrangler` (its postinstall fetches the
  platform-native `workerd` binary the Worker runtime needs) and `esbuild` via
  vite/vitest (the Vue builds). Keep the allow-list complete — every "Ignored
  build scripts" line in an install log is one missing entry.
- **pnpm 11+ key names.** pnpm 11 replaced `onlyBuiltDependencies` /
  `neverBuiltDependencies` / `ignoredBuiltDependencies` with the `allowBuilds`
  map and **silently ignores the old keys**. An old-style block here would leave
  a fresh clone with a broken wrangler while every install still "succeeded".

Rust needs no install step, but it does need a fetch:

```bash
cargo fetch --locked
```

`--locked` is not optional. `Cargo.lock` is committed and every command in this
repository that can take the flag gets it, because a command that silently
updates the lock is a command whose CI result does not mean what it says.

## Verify the toolchain before you touch anything

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
cargo doc --workspace --no-deps
pnpm arch
```

Expected right now: the three `cargo` commands pass. **`pnpm arch` fails**,
because `tooling/scripts/check-architecture.mjs` is being written and is not yet
in the tree. That is a known gap, not a mistake you made.

## The project layout

Eleven projects in `.moon/workspace.yml`, each registered under the name it is
addressed by:

| moon project           | Path                          |
| ---------------------- | ----------------------------- |
| `identity-domain`      | `crates/identity-domain`      |
| `identity-application` | `crates/identity-application` |
| `identity-oidc`        | `crates/identity-oidc`        |
| `identity-security`    | `crates/identity-security`    |
| `identity-cloudflare`  | `crates/identity-cloudflare`  |
| `identity-testkit`     | `crates/identity-testkit`     |
| `identity`             | `apps/identity/worker`        |
| `identity-web`         | `apps/identity/web`           |
| `identity-admin`       | `apps/identity-admin/worker`  |
| `identity-admin-web`   | `apps/identity-admin/web`     |
| `identity-jobs`        | `apps/identity-jobs/worker`   |

**A deployable's moon project ID is its deployable name** — `identity`, not
`identity-worker` — so `moon run identity:dev` resolves, and so a tag, a version
id, a wrangler worker name and a project id can be compared by eye. The
`*‑worker` spellings are the _crate_ names (`apps/identity/worker/Cargo.toml`),
which is a different namespace and says nothing about which commands work.

They used to be the moon ids, with the deployable names declared as aliases in a
`projects:` block in the root `moon.yml`. Moon 2.5.6 does not have that
mechanism and silently ignored the block, so none of those commands resolved
until the ids were renamed.

There is **no per-project `moon.yml` in any project yet.** The root `moon.yml`
defines the task vocabulary with JavaScript-flavoured defaults; a Rust project
overrides `format` with `cargo fmt` in its own `moon.yml`, and until that file
exists, `moon run identity:format` runs `prettier` on a Rust project. Adding a
project means adding its `moon.yml` in the same commit — the "new module = one
commit, four files" rule in `AGENTS.md`.

## Running a Worker

The intended form, once the entrypoints exist:

```bash
# The Identity Worker: OIDC, authn, sessions, self-service, the sole D1 owner.
moon run identity:dev

# The Admin Worker: the admin BFF and its own session.
moon run identity-admin:dev

# The Jobs Worker: the queue consumer. No public route.
moon run identity-jobs:dev
```

Each is `local: only` at the root, and that is deliberate: `dev` starts a
long-running process, so it is never cached and never part of `moon ci`. A task
that never returns is a task that hangs a pipeline.

**None of these commands works today.** `wrangler dev` needs a `wrangler.jsonc`
in the project directory and an entrypoint the Worker crate exports. Neither
exists: `infra/cloudflare/` has three empty directories, and each
`apps/*/worker/src/lib.rs` is a single line of module documentation.

What `wrangler dev` will do once those exist: start `workerd` locally, apply the
project's bindings — the local D1, the local KV, the local queue — and watch for
changes. The Identity Worker's `IDENTITY` service binding resolves locally
through wrangler's multi-worker mode, so the Admin Worker can reach it in
development exactly as it does in production. That is the point: constraint 26
forbids a development-only code path, and a local setup where the service
binding does not work is a local setup that would push you toward one.

## Running a web app

The intended form:

```bash
cd apps/identity/web && pnpm dev
cd apps/identity-admin/web && pnpm dev
```

**Neither works today.** Both directories are in `pnpm-workspace.yaml` and both
contain only an empty `src/`, so `pnpm install` will not find a `package.json`
for them.

The relationship between a web app and its Worker is a **directory**, not a
package dependency, and this is the load-bearing detail:

- The pnpm workspace covers the TypeScript side only.
- The Cargo workspace covers the Rust side only.
- "The two meet nowhere directly": the Vue build's `dist/` becomes the Worker's
  static assets.

That is what makes "a frontend and the BFF behind it are one release unit"
(constraint 8) a **packaging fact** rather than a workspace graph edge. The Vue
build output feeds the Rust build output, and both end up inside the one
Cloudflare Version. Nothing in `crates/**` or `apps/*/worker/**` may import from
`apps/*/web/**` — the BFF is a boundary, not a shared library.

In development the two run as separate processes: Vite on its own port,
`wrangler dev` on another, and the web app's dev server proxies its API calls to
the Worker. The proxy is a development convenience, not a trust boundary —
production serves the built assets from the same origin, which is why the session
cookie is `SameSite=Lax` and CSRF protection is a server responsibility.

## Secrets in development

`.dev.vars` is gitignored and holds **real** secrets. A tracked `.example` file
lists the key names with visibly-placeholder values.

```bash
cp .dev.vars.example .dev.vars
# then fill in real values
```

Both files are `DEFERRED` — the gitignore rules and the example file are part of
what is being written. The rule they will implement: a tracked `.example` with
the key names, a gitignored `.dev.vars` with the values, and **no real value in
any tracked file**. Full classification in
[../security/secrets-management.md](../security/secrets-management.md).

**Why real secrets locally.** Constraint 26 forbids an authentication bypass for
development — no flag, no env var, no test-only role. Local development runs the
**same code path** as production, with real secrets. A local environment that
authenticates differently is an environment where the deployed path is never
exercised, and the bypass variable is one `NODE_ENV` mistake away from
production. If a flow cannot run locally with real secrets, the flow is
misdesigned.

## The local Cloudflare state

`wrangler dev` keeps its state in `.wrangler/state/` in the project directory
by default — a local SQLite file for D1, local KV, local queues. It is
gitignored.

Two rules for it:

- **It is not schema-managed by a migration runner outside the Worker.**
  Constraint 2: Identity D1 is accessed only by the Identity Worker — no script,
  no migration runner outside it. `wrangler d1 execute` is a legitimate operator
  tool and a violation when a script uses it. That distinction is why local
  schema application is the Worker's business.
- **It is disposable.** It is a cache of development state, not a record. If it
  is confusing, delete the directory. It is not the only copy of anything:
  `database/seeds/` and `database/fixtures/` are the tracked inputs, and they
  are `DEFERRED`.

## Running the checks

The full gate, and what each part is:

```bash
pnpm format        # prettier --write --ignore-unknown
pnpm format:check  # prettier --check
pnpm lint          # eslint
pnpm typecheck     # moon run :typecheck -> tsc --noEmit
pnpm test          # moon run :test
pnpm build         # moon run identity:build identity-admin:build identity-jobs:build
pnpm arch          # node tooling/scripts/check-architecture.mjs
pnpm wrangler:validate  # moon run :wrangler-validate
```

`AGENTS.md` names `pnpm verify` as the full definition-of-done gate (format,
lint, typecheck, tests, architecture check) and `pnpm arch:canary` as the proof
that the architecture gate fires on a deliberately-violating fixture tree.
**Neither script exists in `package.json` yet** — `verify` and `arch:canary` are
not among the scripts listed there, so the gate is partly named and partly
written. Use the list above, and treat `pnpm arch` failing as a known gap.

Of these, only the three `cargo` commands and `pnpm format` are usable today.

## Running the ignored invariants

The most useful command in this document, and the one that answers "how much of
the security model is actually real yet?":

```bash
moon run identity-domain:test-invariants
```

It runs the whole set ignoring the `#[ignore]` attribute. Most of them will
**fail**, and that is the point: each is `#[ignore]`d with a named reason saying
which rule is not enforced yet and why. The two that are not ignored — the AAL
ordering and the session revocation/expiry rules — pass, because the domain
crate can enforce those on its own.

A failing run here is a list of the security rules this repository has named and
not yet built. That is more useful than a green suite, and it is the honest
encoding of bootstrap state rather than a stubbed-out passing test.

## The `.moon` cache

`.moon/cache/` is a local tool cache. It is not a build cache you can trust for
the cargo tasks — those have `cache: false` deliberately, because cargo's own
`target/` and the committed `Cargo.lock` are the cache of record, and a
moon-cached cargo task that missed an input would report a stale verdict as
green. If moon behaves strangely, `moon clean` and try again.

## A first-session checklist

```bash
# 1. Toolchain
proto activate && proto install     # or install the pinned versions yourself
rustc --version && node --version && pnpm --version

# 2. Install
pnpm install
cargo fetch --locked

# 3. Verify the Rust workspace — these three pass today
cargo test --workspace
cargo clippy --workspace --all-targets
cargo doc --workspace --no-deps

# 4. Read the state before you change anything
moon run identity-domain:test-invariants   # expect failures; they are the backlog
pnpm arch                                   # expect failure; the script is being written

# 5. Read the law before you touch a boundary
cat AGENTS.md
```

Step 5 is not optional. The authority map in `AGENTS.md` says which document owns
which fact, and `docs/README.md` says what is real. Reading them before an edit
is cheaper than discovering afterwards that a change contradicted a constraint.

## Related

- [first-deploy.md](first-deploy.md) — the same thing against a real Cloudflare
  account.
- [../README.md](../README.md) — what is real today, and the status vocabulary
  this document uses.
- [../architecture/worker-architecture.md](../architecture/worker-architecture.md)
  — the bindings a Worker will have when `wrangler dev` runs.
- [../security/secrets-management.md](../security/secrets-management.md) — what
  goes in `.dev.vars`.
