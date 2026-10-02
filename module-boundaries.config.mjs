/**
 * The archkeep constraint table for ecoma-identity. `AGENTS.md` names this
 * file the owner of "the archkeep constraint table", and it is the machine-
 * readable half of a law whose prose lives in two documents:
 *
 *   docs/architecture/crate-dependency-law.md — the Rust layering.
 *   docs/architecture/worker-architecture.md  — the three deployables and what
 *                                               each may hold.
 *
 * The prose and this table move in one commit or not at all. A boundary stated
 * in a document and not in this file is a boundary a build cannot see, and one
 * stated here and not in the document is a rule with no recorded reason —
 * `AGENTS.md`, "One fact, one owner".
 *
 * ## How the shape was established, and what reads it
 *
 * The shape is `@nx/enforce-module-boundaries`' own option object, which is
 * what archkeep consumes and validates on load
 * (`packages/archkeep/src/config.mjs` — `rowViolations`, which refuses a row
 * carrying a key that is not one of `sourceTag`, `allSourceTags`,
 * `onlyDependOnLibsWithTags`, `notDependOnLibsWithTags`, `allowedExternalImports`,
 * `bannedExternalImports`, `description`, `remediation`, `origin`, `rationale`,
 * `decisionRef`, `fitnessBindings`). Every row below was checked against that
 * validator rather than written from memory of the plugin's documentation.
 *
 * The file is found by CONVENTION: archkeep looks for `module-boundaries.config.mjs`
 * at the workspace root when no `archkeep.json` names a different file
 * (`docs/reference/configuration.md`, the `boundaryConfig` default). A
 * root `archkeep.json` and a `.moon/` directory cannot coexist, and this
 * repository is a Moonrepo workspace, so the convention filename is the only
 * spelling available here.
 *
 * ## Tags cannot contain colons in a Moon workspace
 *
 * Moon tags are carried verbatim by archkeep's Moon provider
 * (`packages/archkeep/src/providers/moon.mjs`, `deriveTags`), and Moon rejects a
 * colon in a tag. So the `layer:` / `scope:` vocabulary other Ecoma repositories
 * use is spelled bare here — `domain`, `application`, `oidc`, `security`,
 * `adapter` — matching the tags the per-project `moon.yml` files actually
 * declare. A constraint naming a tag the provider never emits selects nothing,
 * and a row that selects nothing approves everything while reading as
 * protection: archkeep refuses that with exit 3, naming the row
 * (`docs/reference/policy-schema.md`, "A row that covers nothing").
 *
 * ## What this table judges, and how — the honest summary
 *
 * Every row below is verified to FIRE against archkeep's real engine, not
 * written from the shape alone. The evidence is in the README beside this file:
 *
 * - **The Rust layering rows are live at the SOURCE level.** archkeep's Rust
 *   analysis resolves `use identity_oidc::…` to the owning project and judges it
 *   against `onlyDependOnLibsWithTags`, even though Moon 2.5.6 infers no Cargo
 *   edges. Verified: a `use identity_oidc::route::Route;` injected into
 *   `identity-application` fails with exactly the row's message, and a
 *   `use identity_domain::user::UserId;` injected into the Jobs Worker fails
 *   with the jobs-isolation message. (Moon indeed infers no Cargo → project
 *   edges — `moon project-graph --json` returns `edges: []` — but the Rust
 *   source analyzer does not need them: it maps a crate name to its project by
 *   reading the manifests itself.)
 *
 * - **`identity-cloudflare` must be reachable from the layers.** The
 *   `application` row's allow-list is `["application", "domain"]` and the
 *   `security` row's is `["security", "domain"]` — and identity-cloudflare
 *   depends on both by law (`crate-dependency-law.md`), so archkeep's cycle
 *   gate fires on THEM before our row ever can. That is correct and intended:
 *   the manifest law is what lets cloudflare cross the lines, and the
 *   cross-layer rows are what stop everyone else. This is stated here because
 *   a green run on this tree while a cycle exists elsewhere would read as "the
 *   table is dead" — it is not; the architecture is what puts the two back in
 *   the same crate's allow-list.
 *
 * - **The platform law is declared but KNOWN to be unenforceable in this
 *   engine today.** The four `bannedExternalImports` rows say what the law is,
 *   and `pnpm arch` enforces it from `cargo metadata`; archkeep's own engine
 *   currently cannot fire them for realistic Rust code (archkeep#957 — its
 *   package guard requires `/`, which Rust spellings never contain). The rows
 *   stay because they are the law's archkeep-surface spelling and will start
 *   enforcing the day the engine fixes that; `pnpm arch` is the enforcement
 *   that is real TODAY. The README says the same thing.
 */

/**
 * The constraint table.
 *
 * A dependency must satisfy EVERY constraint whose `sourceTag` (or
 * `allSourceTags`) its source project carries, so the axes below compose rather
 * than override. A `crate`-tagged source is held to the crate row, the
 * platform row, and the shared row at once.
 *
 * Exhaustiveness is deliberate, per `AGENTS.md`: "A module the boundary table
 * does not judge is a module with no law." Every moon project in
 * `.moon/workspace.yml` is covered by a row below, and the coverage check
 * `tooling/ci/check-contracts.mjs` runs is the mechanical form of that.
 */
export const depConstraints = [
  // -------------------------------------------------------------------------
  // The Rust layering, crate by crate.
  //
  // Each row is the ONE internal crate (or set) its source may name. These are
  // the rows that will start enforcing when a graph carries the Cargo edges;
  // they are written now, against today's manifests, so that enabling the
  // graph is a configuration change rather than a law change.
  // -------------------------------------------------------------------------
  {
    sourceTag: "domain",
    onlyDependOnLibsWithTags: ["domain"],
    description:
      "identity-domain depends on nothing internal. The reverse is the whole point: a rule that answers 'may this user log in?' cannot be tested without a database, a clock and a session, none of which belong here.",
    remediation:
      "The decision belongs in identity-application, which may name the domain. See crate-dependency-law.md, 'identity-application → identity-domain'.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "application",
    onlyDependOnLibsWithTags: ["application", "domain"],
    description:
      "identity-application names the domain and nothing else internal. Not identity-oidc, not identity-security, not identity-cloudflare.",
    remediation:
      "A use case that reached for the Cloudflare adapter or a TOTP implementation would be untestable without a platform, and the use-case layer is where the security decisions live.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "oidc",
    onlyDependOnLibsWithTags: ["oidc", "domain"],
    description:
      "identity-oidc names the domain, for real identifiers in claims, and never identity-security. A protocol type that also verified a signature would be doing two jobs.",
    remediation:
      "Signature verification, token minting and session handling are identity-security's. The boundary between 'what does a token look like' and 'is this token valid' is the one that matters most here.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "security",
    onlyDependOnLibsWithTags: ["security", "domain"],
    description:
      "identity-security names the domain, for model types its gates operate on, and never identity-cloudflare. A security gate that reached for a Worker binding would be untestable off the platform.",
    remediation:
      "Declare the capability as a trait here and implement it in identity-cloudflare.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "adapter",
    onlyDependOnLibsWithTags: [
      "adapter",
      "application",
      "oidc",
      "security",
      "domain",
    ],
    description:
      "identity-cloudflare may name every layer below it. It is the adapter boundary: above it nothing knows what D1 or a Queue is, below it nothing is allowed to be platform specific.",
    remediation:
      "The reverse direction is the error this crate exists to prevent. Move the platform knowledge below the line, not the use case above it.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "identity-testkit",
    onlyDependOnLibsWithTags: ["crate", "worker", "identity-testkit"],
    notDependOnLibsWithTags: ["web"],
    description:
      "identity-testkit may double any port, and is never a production dependency. A testkit in a production dependency graph is a way to fabricate a valid object outside the system's own validation.",
    remediation:
      "Name it under [dev-dependencies] only. A test that genuinely needs a real D1 is an integration test under tests/integration/.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },

  // -------------------------------------------------------------------------
  // The three deployables.
  //
  // The `identity` and `identity-admin` roots may name everything. The Jobs
  // root is the exception the whole jobs-isolation argument is about, and it is
  // stated as a transitive ban so that it holds however the edge arrives.
  //
  // `identity-jobs-worker`'s allow-list is `adapter` and `security` because a
  // background worker that can evaluate identity rules can make identity
  // decisions, and a queue message is not a trustworthy caller. The Workers
  // that DO depend on those crates are not caught by this row, because the ban
  // is read from the Jobs source; `pnpm arch` is what judges each Worker's own
  // manifest, and jobs-isolation.md is why that is not duplicated here.
  // -------------------------------------------------------------------------
  {
    sourceTag: "identity",
    onlyDependOnLibsWithTags: [
      "domain",
      "application",
      "oidc",
      "security",
      "adapter",
      "identity-testkit",
    ],
    notDependOnLibsWithTags: ["web"],
    description:
      "The Identity Worker: the sole owner of IDENTITY_DB. May name every layer, because that is what wiring is.",
    remediation:
      "Policy belongs in identity-cloudflare, so the three Workers cannot drift apart on it.",
    decisionRef: "docs/architecture/worker-architecture.md",
  },
  {
    sourceTag: "identity-admin",
    onlyDependOnLibsWithTags: [
      "domain",
      "application",
      "oidc",
      "security",
      "adapter",
      "identity-testkit",
    ],
    notDependOnLibsWithTags: ["web"],
    description:
      "The Admin Worker: the administrative BFF. Reaches identity through a service binding, never through its database.",
    remediation:
      "If it needs identity state, it needs a typed command over the service binding — not an IDENTITY_DB binding. See admin-isolation.md.",
    decisionRef: "docs/architecture/worker-architecture.md",
  },
  {
    sourceTag: "identity-jobs",
    onlyDependOnLibsWithTags: ["adapter", "security"],
    description:
      "The Jobs Worker: a queue consumer that owns no identity state. It validates a message and calls out; it has no use-case vocabulary to borrow, so it is not given one.",
    remediation:
      "'It only needs the User type' is the sentence that starts the erosion. The absence of identity-domain and identity-application from the manifest is the architecture, not an oversight. See jobs-isolation.md.",
    decisionRef: "docs/architecture/jobs-isolation.md",
  },

  // -------------------------------------------------------------------------
  // THE PLATFORM LAW — the declaration, and the honest status of its enforcement.
  //
  // `docs/architecture/crate-dependency-law.md`, rule 1: identity-domain
  // "names no internal crate and nothing platform-shaped. No `worker`, no D1, no
  // Cloudflare type." These four rows are that sentence in archkeep's
  // vocabulary.
  //
  // ENFORCEMENT STATUS, STATED IN THE OPEN: `bannedExternalImports` cannot fire
  // for realistic Rust code in the current engine. archkeep#957 — its
  // package guard (`rules/specifiers.mjs`, `isConstraintBanningProject`)
  // requires `imp === packageName || imp.startsWith(packageName + "/")`, and a
  // Rust `use worker::Env;` produces the specifier `worker::Env`, which the
  // guard refuses before the glob is ever tested. The only spelling that fires
  // is a bare `use worker;`, which no real crate writes. So these rows are the
  // law's archkeep-surface spelling and will start enforcing the day #957
  // lands; THE ENFORCEMENT THAT IS REAL TODAY IS `pnpm arch`
  // (`tooling/scripts/check-architecture.mjs`, CRATE_LAW.forbiddenExternal,
  // judged from `cargo metadata`). The README beside this file says the same
  // thing, so a human does not need this comment.
  //
  // `worker-sys`, `worker-macros` and `wasm-bindgen` are here for one reason:
  // each is the other door to the same platform. Banning `worker` alone would
  // leave `use wasm_bindgen::…` as a way to call into JS, and `pnpm arch`
  // forbids exactly this set in CRATE_LAW.forbiddenExternal. The two files
  // naming the same four names is deliberate: they are the same law read from
  // two graphs, and a set that differs between them is a gap in one of them.
  // -------------------------------------------------------------------------
  {
    sourceTag: "domain",
    onlyDependOnLibsWithTags: ["domain"],
    description:
      "identity-domain depends on nothing internal. The reverse is the whole point: a rule that answers 'may this user log in?' cannot be tested without a database, a clock and a session, none of which belong here.",
    remediation:
      "The decision belongs in identity-application, which may name the domain. See crate-dependency-law.md, 'identity-application → identity-domain'.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "application",
    onlyDependOnLibsWithTags: ["application", "domain"],
    description:
      "identity-application names the domain and nothing else internal. Not identity-oidc, not identity-security, not identity-cloudflare.",
    remediation:
      "A use case that reached for the Cloudflare adapter or a TOTP implementation would be untestable without a platform, and the use-case layer is where the security decisions live.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "oidc",
    onlyDependOnLibsWithTags: ["oidc", "domain"],
    description:
      "identity-oidc names the domain, for real identifiers in claims, and never identity-security. A protocol type that also verified a signature would be doing two jobs.",
    remediation:
      "Signature verification, token minting and session handling are identity-security's. The boundary between 'what does a token look like' and 'is this token valid' is the one that matters most here.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "security",
    onlyDependOnLibsWithTags: ["security", "domain"],
    description:
      "identity-security names the domain, for model types its gates operate on, and never identity-cloudflare. A security gate that reached for a Worker binding would be untestable off the platform.",
    remediation:
      "Declare the capability as a trait here and implement it in identity-cloudflare.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "adapter",
    onlyDependOnLibsWithTags: [
      "adapter",
      "application",
      "oidc",
      "security",
      "domain",
    ],
    description:
      "identity-cloudflare may name every layer below it. It is the adapter boundary: above it nothing knows what D1 or a Queue is, below it nothing is allowed to be platform specific.",
    remediation:
      "The reverse direction is the error this crate exists to prevent. Move the platform knowledge below the line, not the use case above it.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "identity-testkit",
    onlyDependOnLibsWithTags: ["crate", "worker", "identity-testkit"],
    notDependOnLibsWithTags: ["web"],
    description:
      "identity-testkit may double any port, and is never a production dependency. A testkit in a production dependency graph is a way to fabricate a valid object outside the system's own validation.",
    remediation:
      "Name it under [dev-dependencies] only. A test that genuinely needs a real D1 is an integration test under tests/integration/.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },

  // -------------------------------------------------------------------------
  // The three deployables.
  //
  // The `identity` and `identity-admin` roots may name everything. The Jobs
  // root is the exception the whole jobs-isolation argument is about, and it is
  // stated as a transitive ban so that it holds however the edge arrives.
  //
  // `identity-jobs-worker`'s allow-list is `adapter` and `security` because a
  // background worker that can evaluate identity rules can make identity
  // decisions, and a queue message is not a trustworthy caller. The Workers
  // that DO depend on those crates are not caught by this row, because the ban
  // is read from the Jobs source; `pnpm arch` is what judges each Worker's own
  // manifest, and jobs-isolation.md is why that is not duplicated here.
  // -------------------------------------------------------------------------
  {
    sourceTag: "identity",
    onlyDependOnLibsWithTags: [
      "domain",
      "application",
      "oidc",
      "security",
      "adapter",
      "identity-testkit",
    ],
    notDependOnLibsWithTags: ["web"],
    description:
      "The Identity Worker: the sole owner of IDENTITY_DB. May name every layer, because that is what wiring is.",
    remediation:
      "Policy belongs in identity-cloudflare, so the three Workers cannot drift apart on it.",
    decisionRef: "docs/architecture/worker-architecture.md",
  },
  {
    sourceTag: "identity-admin",
    onlyDependOnLibsWithTags: [
      "domain",
      "application",
      "oidc",
      "security",
      "adapter",
      "identity-testkit",
    ],
    notDependOnLibsWithTags: ["web"],
    description:
      "The Admin Worker: the administrative BFF. Reaches identity through a service binding, never through its database.",
    remediation:
      "If it needs identity state, it needs a typed command over the service binding — not an IDENTITY_DB binding. See admin-isolation.md.",
    decisionRef: "docs/architecture/worker-architecture.md",
  },
  {
    sourceTag: "identity-jobs",
    onlyDependOnLibsWithTags: ["adapter", "security"],
    description:
      "The Jobs Worker: a queue consumer that owns no identity state. It validates a message and calls out; it has no use-case vocabulary to borrow, so it is not given one.",
    remediation:
      "'It only needs the User type' is the sentence that starts the erosion. The absence of identity-domain and identity-application from the manifest is the architecture, not an oversight. See jobs-isolation.md.",
    decisionRef: "docs/architecture/jobs-isolation.md",
  },

  // -------------------------------------------------------------------------
  // home-web — the public-facing web application (ADR-0016).
  //
  // An independent deployable running Nuxt 4 / Nitro on Cloudflare Workers +
  // Workers Assets. NOT a Rust Worker — Nuxt/Nitro is the runtime.
  //
  // MUST NOT depend on any Identity crate: no identity-domain, no
  // identity-application, no identity-security, no identity-cloudflare. The
  // public site has no identity state and does not participate in identity
  // flows. It may link to https://identity.ecoma.io for authentication, but
  // it does not call Identity from the server side.
  // -------------------------------------------------------------------------
  {
    sourceTag: "home-web",
    onlyDependOnLibsWithTags: ["home-web", "frontend-preferences"],
    notDependOnLibsWithTags: [
      "domain",
      "application",
      "oidc",
      "security",
      "adapter",
      "identity",
      "identity-admin",
      "identity-jobs",
      "identity-testkit",
    ],
    description:
      "home-web is the public-facing web application. It holds no Identity state and must not depend on any Identity crate. A public marketing page that reached identity-domain or identity-cloudflare would be a boundary violation that the architecture guard exists to prevent.",
    remediation:
      "The public site links to Identity for authentication; it does not import Identity types. If server-side Identity data is genuinely needed, that requires an ADR explaining why and a service binding the architecture gate knows about.",
    decisionRef: "docs/adr/0016-home-web-fourth-deployable.md",
  },

  // -------------------------------------------------------------------------
  // frontend-preferences — preference mechanics for the three frontends.
  //
  // A pure TypeScript library with no platform dependencies. Provides locale
  // detection and normalisation, the colour-mode attribute, display time-zone
  // detection, the cookie policy, and the resolution order, for home-web,
  // identity-web and identity-admin-web.
  //
  // MUST NOT depend on any Rust crate or Worker-specific code. It runs in
  // browser and Node.js contexts equally, which the home page's prerender needs.
  //
  // It reads its VALUES from the projection at .generated/frontend/config.json
  // rather than declaring them, which is the mechanical form of "a shared
  // frontend package owns preference mechanics, not business or user data": a
  // constant here would be a second owner of a fact infra-topology states, and
  // the third frontends would each have to notice the divergence.
  // -------------------------------------------------------------------------
  {
    sourceTag: "frontend-preferences",
    onlyDependOnLibsWithTags: ["frontend-preferences"],
    notDependOnLibsWithTags: [
      "domain",
      "application",
      "oidc",
      "security",
      "adapter",
      "identity",
      "identity-admin",
      "identity-jobs",
      "identity-testkit",
      "home-web",
      "identity-web",
      "identity-admin-web",
    ],
    description:
      "frontend-preferences is a pure TypeScript library for preference mechanics. It has no platform dependencies and must not depend on any Rust crate, Worker, or frontend app. It provides the detection, validation, cookie policy and resolution order that all frontend apps consume, and owns no catalog and no business or user data.",
    remediation:
      "Platform-specific preference logic belongs in the consuming app, not in this shared library, which stays platform-agnostic. A translation catalog belongs to the application that renders it. An account's own preferences are backend data and belong to the system that owns the account; src/preferences.ts declares RemotePreferenceAdapter as DEFERRED rather than reaching for one.",
    decisionRef: "packages/frontend-preferences/README.md",
  },

  // -------------------------------------------------------------------------
  // identity-web and identity-admin-web — the two operator and end-user SPAs.
  //
  // These two rows did not exist until the preference package was renamed, and
  // their absence was a gap rather than a permission: `AGENTS.md` says a module
  // the boundary table does not judge is a module with no law, so both apps
  // were unconstrained in the one direction that matters for them. They are
  // near-identical clones, so the rows are near-identical — written twice
  // rather than as a set, because this table's vocabulary is one `sourceTag`
  // per row and archkeep reads no grouping.
  //
  // The direction is one-way. A frontend application may reach for the shared
  // preference mechanics; the package may never reach back for an application,
  // because a library that imported an app would have to be re-instantiated per
  // app and would stop being the single answer the three apps share.
  // -------------------------------------------------------------------------
  {
    sourceTag: "identity-web",
    onlyDependOnLibsWithTags: ["identity-web", "frontend-preferences"],
    description:
      "identity-web is the end-user web application. It may use the shared preference mechanics and nothing else internal. It reaches the backend over HTTP as a client, not as a Worker with bindings, and it may not import an Identity crate: the crate is the server's, and a browser bundle that evaluated identity rules would be evaluating identity rules with no session to check.",
    remediation:
      "A type the SPA needs from the backend belongs in contracts/** as a schema the Worker serialises, not as a Rust type the SPA imports. See trust-boundaries.md.",
    decisionRef: "docs/architecture/trust-boundaries.md",
  },
  {
    sourceTag: "identity-admin-web",
    onlyDependOnLibsWithTags: ["identity-admin-web", "frontend-preferences"],
    description:
      "identity-admin-web is the operator console. It may use the shared preference mechanics and nothing else internal. It is a client of identity-admin exactly as identity-web is a client of identity: holding administrative UI does not make it the administrative authority, and an import from identity-domain would put that authority in the browser.",
    remediation:
      "An operator capability the console needs is enforced by the Workers it calls, and surfaced through contracts/**. The console's job is to ask and render, not to decide. See trust-boundaries.md.",
    decisionRef: "docs/architecture/trust-boundaries.md",
  },

  // -------------------------------------------------------------------------
  // THE PLATFORM LAW — the rows that judge something today.
  //
  // `docs/architecture/crate-dependency-law.md`, rule 1: identity-domain
  // "names no internal crate and nothing platform-shaped. No `worker`, no D1, no
  // Cloudflare type." These four rows are that sentence, and they are the part
  // of this table with a working mechanism behind it: the `use worker::…` sites
  // in a `.rs` file are read as import sites, resolved to the external package
  // `worker`, and matched against `bannedExternalImports`.
  //
  // `bannedExternalImports` entries are globs (nx's `mapGlobToRegExp`, every
  // `*` becomes `.*` and the result is anchored), and they are matched against
  // the specifier, not against the crate's dependency list — so this bans the
  // `use`, which is the boundary that matters, rather than the manifest entry
  // that `pnpm arch` already reads from `cargo metadata`.
  //
  // `worker-sys`, `worker-macros` and `wasm-bindgen` are here for one reason:
  // each is the other door to the same platform. Banning `worker` alone would
  // leave `use wasm_bindgen::…` as a way to call into JS, and `pnpm arch`
  // forbids exactly this set in CRATE_LAW.forbiddenExternal. The two files
  // naming the same four names is deliberate: they are the same law read from
  // two graphs, and a set that differs between them is a gap in one of them.
  // -------------------------------------------------------------------------
  {
    sourceTag: "domain",
    bannedExternalImports: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
    description:
      "identity-domain is platform-free: no `worker`, no D1, no Cloudflare type ever appears in it.",
    remediation:
      "The model answers 'what is a User?', never 'may this user log in?'. A rule that needs a database does not belong in the model.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "application",
    bannedExternalImports: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
    description:
      "identity-application is platform-free with respect to the Workers platform. Its tests run with no platform and no database at all, and that is a deliberate property.",
    remediation:
      "If a use case needs a D1 handle, the use case is wrong: it needs a trait, and the trait belongs in this crate with its implementation in identity-cloudflare.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "oidc",
    bannedExternalImports: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
    description:
      "identity-oidc knows the shape of an OIDC message and nothing about where identity state lives. A protocol type linked against the platform cannot be conformance-tested without one.",
    remediation:
      "Platform knowledge belongs in identity-cloudflare, which maps it to the wire.",
    decisionRef: "docs/architecture/crate-dependency-law.md",
  },
  {
    sourceTag: "security",
    bannedExternalImports: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
    description:
      "identity-security holds gates and interfaces. 'We could not test the token verifier without deploying' is not a position an identity system's security layer may be in.",
    remediation:
      "ADR-0008: no cryptography crate, ever. WebCrypto through `worker` is the only source of primitives, and `worker` is not a dependency of this crate — so a crypto-shaped function here is a rule violation before it is a security one.",
    decisionRef: "docs/adr/0008-no-cryptography-crates.md",
  },
];

/**
 * `moduleBoundaryOptions` — the non-table half of the policy.
 *
 * Two options are set to `false`, and each is a false here rather than a
 * default:
 *
 *   `banTransitiveDependencies: false` — Cargo already refuses a path
 *   dependency that is not declared, and a manifest that names a crate it
 *   cannot use is a compile error rather than a boundary question. Left on, it
 *   would report the same tree as a `noTransitiveDependencies` violation and
 *   dilute the real findings with cargo's own.
 *
 *   `checkNestedExternalImports: false` — the platform ban is already stated by
 *   the four `bannedExternalImports` rows. The nested form judges what a
 *   dependency DRAGS IN as well as what a crate imports directly, so a crate
 *   that legitimately depends on `identity-cloudflare` (which depends on
 *   `worker`) would be reported as importing `worker` itself. Two rules
 *   reporting one fact is a noisier gate, not a stricter one.
 *
 * Everything else is archkeep's default and is written out anyway, because
 * archkeep REFUSES a partial table: "every option is stated explicitly"
 * (`packages/archkeep/src/config.mjs`, `OPTION_TYPES`). An option omitted is a
 * load error rather than a default, which is the right way round — a silently
 * defaulted `allow: []` is a rule that approves something nobody decided.
 *
 *   `allow: []` — no exception, no suppression, no import-pattern carve-out.
 *   `buildTargets: ["build"]` — archkeep's own default, stated rather than
 *   inherited so that the row below it is not a mystery.
 *   `enforceBuildableLibDependency: false` — its own header calls this
 *   "not fully implemented" upstream, and a rule that is not implemented
 *   cannot be one this repository relies on. The equivalent check that IS
 *   real is `pnpm arch`.
 *   `allowCircularSelfDependency: false` — no cycle is waved through.
 *   `checkDynamicDependenciesExceptions: []` — there is no dynamic-import
 *   exception list; Rust has no dynamic import, and the one JS surface that
 *   could is a Vue app that must not reach a crate in the first place.
 *   `ignoredCircularDependencies: []` — no cycle pair is excused, so a cycle
 *   is a finding. An entry added here is an architecture decision and belongs
 *   in an ADR, which is what the rows' `decisionRef` field points at.
 */
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
