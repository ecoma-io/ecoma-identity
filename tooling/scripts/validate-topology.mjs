/**
 * `validate-topology.mjs` — prove the deployment model can describe only the
 * topology we are willing to operate.
 *
 * WHAT THIS IS. A dependency-free validator for `infra-topology/topology.json`.
 * JSON Schema documents the public shape in `infra-topology/topology.schema.json`,
 * but Node deliberately does not ship a schema evaluator and adding one would put a
 * production-safety gate behind a new dependency. The assertions below are the
 * executable schema: each one names an invariant a malformed manifest must not be
 * able to weaken.
 *
 * THE INVERTED GATE. This file used to require every `$TOKEN` in the manifest to
 * have an entry in a `resource_ids.sources` map naming a GitHub variable — that
 * is, it enforced the indirection "topology → GitHub → Cloudflare resource id".
 * It now forbids that indirection outright, and in every form. The manifest is
 * LOGICAL: it names resources, and a resource id is rediscovered from Cloudflare
 * by that name. A manifest that carries an id, or any way of obtaining one, is
 * rejected — which means the manifest cannot become a stale copy of an account,
 * and a GitHub variable cannot become a second source of truth for it.
 *
 * WHAT THIS IS NOT. This does not inspect a rendered wrangler configuration or a
 * Cloudflare account. The renderer and the topology checker are later units. This
 * is the first gate: a manifest that cannot state a safe topology is rejected
 * before another tool is allowed to consume it.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEPLOYABLES,
  ENVIRONMENTS,
  FIXED_ENVIRONMENTS,
  RESOURCE_KINDS,
  loadTopology,
  matchesGrammar,
} from "./topology-model.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_CANNOT_RUN = 2;
const EXIT_USAGE = 64;

/**
 * The account this repository deploys to. Account context, not a generated
 * resource id — Cloudflare does not mint it and it does not change. It is
 * pinned here and in `topology.schema.json` so that reading it from GitHub
 * cannot become an alternative.
 */
const CLOUDFLARE_ACCOUNT_ID = "406bdb82319b162b09bf5f137a156600";

/**
 * Keys that would reintroduce the indirection this gate exists to forbid.
 *
 * `id` is in this set and `account.id` is the single exception below. Bare `id`
 * is ambiguous by construction — it means "an identifier for whatever this is" —
 * and the only place in this manifest that answers that question legitimately is
 * the account. A `kv.id` or a `d1.id` is the indirection under another spelling,
 * so the rule is positional rather than a name list that would have to enumerate
 * every spelling somebody might reach for next.
 *
 * `namespace_id` is NOT here, and the omission is deliberate rather than an
 * oversight: a Cloudflare rate-limit namespace is a bare integer the account
 * remembers, created implicitly on first use, with no create, list or delete
 * API. There is nothing to look it up by, so the one honest place for it is the
 * manifest — `preview.not_deletable` says so, and
 * `environments.*.ratelimits.*.namespace_id` is configuration rather than a
 * discovered identifier.
 */
const FORBIDDEN_ID_KEYS = new Set([
  "id",
  "id_env_var",
  "id_source",
  "database_id",
  "namespace_id_source",
  "resource_id",
  "resource_ids",
  "env_var",
  "env_prefix",
  "overlay_file",
  "secret_name",
  "variable_name",
  "account_id_env_var",
]);

/** The one identifier in this manifest, and the one place `id` is allowed. */
const ALLOWED_ID_POINTERS = new Set(["account.id"]);

/** A `$TOKEN` placeholder: the shape the old `resource_ids` indirection used. */
const TOKEN_REFERENCE = /^\$[A-Z0-9_]+$/;

/**
 * Literal Cloudflare identifiers. A D1 `database_id` and a KV namespace `id`
 * are UUIDs; committing one names the resource to aim at during an incident.
 */
const LITERAL_ID_PATTERNS = [
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  /^[0-9a-f]{32}$/i,
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(root, pointer) {
  return pointer.split(".").reduce((value, key) => {
    if (!isRecord(value) && !Array.isArray(value)) return undefined;
    return value[key];
  }, root);
}

function validateTopology(topology) {
  const errors = [];
  const expect = (condition, pointer, message) => {
    if (!condition) errors.push({ pointer, message });
  };
  const exactKeys = (value, keys, pointer) => {
    expect(isRecord(value), pointer, "must be an object");
    if (!isRecord(value)) return;
    const actual = Object.keys(value).filter((key) => !key.startsWith("$"));
    const unexpected = actual.filter((key) => !keys.includes(key));
    const missing = keys.filter((key) => !(key in value));
    expect(
      unexpected.length === 0,
      pointer,
      `has unexpected key(s): ${unexpected.join(", ")}`,
    );
    expect(
      missing.length === 0,
      pointer,
      `is missing key(s): ${missing.join(", ")}`,
    );
  };

  expect(isRecord(topology), "", "must be a JSON object");
  if (!isRecord(topology)) return errors;

  expect(topology.version === 1, "version", "must be the supported version 1");
  expect(
    valueAt(topology, "account.id") === CLOUDFLARE_ACCOUNT_ID,
    "account.id",
    `must be the one Cloudflare account, ${CLOUDFLARE_ACCOUNT_ID}`,
  );
  expect(
    valueAt(topology, "account.zone") === "ecoma.io",
    "account.zone",
    "must be the single ecoma.io zone",
  );

  exactKeys(topology.services, DEPLOYABLES, "services");
  exactKeys(topology.bindings, DEPLOYABLES, "bindings");
  exactKeys(topology.environments, ENVIRONMENTS, "environments");
  exactKeys(topology.cookie_namespaces, ENVIRONMENTS, "cookie_namespaces");

  expect(
    valueAt(topology, "services.identity.public") === true,
    "services.identity.public",
    "identity is a public Worker",
  );
  expect(
    valueAt(topology, "services.identity-admin.public") === true,
    "services.identity-admin.public",
    "identity-admin is a public Worker",
  );
  expect(
    valueAt(topology, "services.home-web.public") === true,
    "services.home-web.public",
    "home-web is a public Worker",
  );
  expect(
    valueAt(topology, "services.identity-jobs.public") === false,
    "services.identity-jobs.public",
    "identity-jobs is private and must never have a hostname",
  );
  expect(
    valueAt(topology, "bindings.identity-admin.d1") === null,
    "bindings.identity-admin.d1",
    "SC-02: identity-admin holds no D1 binding",
  );
  expect(
    valueAt(topology, "bindings.identity-jobs.d1") === null,
    "bindings.identity-jobs.d1",
    "SC-03: identity-jobs owns no identity database",
  );
  expect(
    valueAt(topology, "bindings.identity-jobs.services")?.join(",") ===
      "identity",
    "bindings.identity-jobs.services",
    "identity-jobs may reach only identity through a service binding",
  );

  expect(
    valueAt(topology, "limits.custom_domains_per_zone") === 100,
    "limits.custom_domains_per_zone",
    "must encode Cloudflare's 100 Custom Domains per-zone limit",
  );
  expect(
    valueAt(topology, "limits.workers_per_account") === 500,
    "limits.workers_per_account",
    "must encode the Workers Paid account limit of 500",
  );
  expect(
    valueAt(topology, "limits.custom_domains_reserved_fixed") === 6,
    "limits.custom_domains_reserved_fixed",
    "must reserve the six production and staging domains",
  );
  expect(
    valueAt(topology, "limits.custom_domains_per_preview") === 3,
    "limits.custom_domains_per_preview",
    "must reserve identity, admin and home custom domains for each preview",
  );
  expect(
    valueAt(topology, "limits.workers_per_preview") === 4,
    "limits.workers_per_preview",
    "must reserve all four Workers for each preview",
  );

  const previewCount = valueAt(topology, "limits.max_active_previews");
  expect(
    Number.isInteger(previewCount) && previewCount > 0,
    "limits.max_active_previews",
    "must be a positive integer",
  );
  if (Number.isInteger(previewCount) && previewCount > 0) {
    expect(
      topology.limits.custom_domains_reserved_fixed +
        topology.limits.custom_domains_per_preview * previewCount <=
        topology.limits.custom_domains_per_zone,
      "limits.max_active_previews",
      "exceeds the Custom Domains capacity after fixed domains are reserved",
    );
    expect(
      topology.limits.workers_per_preview * previewCount <=
        topology.limits.workers_per_account,
      "limits.max_active_previews",
      "exceeds the Workers account capacity",
    );
  }

  const expectedHosts = {
    production: {
      identity: "identity.ecoma.io",
      "identity-admin": "admin.ecoma.io",
      "home-web": "ecoma.io",
      "identity-jobs": null,
    },
    staging: {
      identity: "stg-identity.ecoma.io",
      "identity-admin": "stg-admin.ecoma.io",
      "home-web": "stg-home.ecoma.io",
      "identity-jobs": null,
    },
    development: {
      identity: null,
      "identity-admin": null,
      "home-web": null,
      "identity-jobs": null,
    },
    preview: {
      identity: "pr{pr}-identity.ecoma.io",
      "identity-admin": "pr{pr}-admin.ecoma.io",
      "home-web": "pr{pr}-home.ecoma.io",
      "identity-jobs": null,
    },
  };

  const expectedWorkers = {
    production: Object.fromEntries(DEPLOYABLES.map((name) => [name, name])),
    staging: Object.fromEntries(
      DEPLOYABLES.map((name) => [name, `${name}-staging`]),
    ),
    development: Object.fromEntries(
      DEPLOYABLES.map((name) => [name, `${name}-development`]),
    ),
    preview: Object.fromEntries(
      DEPLOYABLES.map((name) => [name, `${name}-pr-{pr}`]),
    ),
  };

  const workerNames = new Map();
  for (const environment of ENVIRONMENTS) {
    const config = topology.environments?.[environment];
    if (!isRecord(config)) continue;
    expect(
      config.workers_dev === (environment === "development"),
      `environments.${environment}.workers_dev`,
      environment === "development"
        ? "must be true for local development"
        : "must be false so no undeclared workers.dev public entrypoint exists",
    );
    expect(
      isRecord(config.hosts),
      `environments.${environment}.hosts`,
      "must declare every deployable's hostname explicitly",
    );
    expect(
      isRecord(config.resources),
      `environments.${environment}.resources`,
      "must declare every deployable's resources explicitly",
    );

    for (const deployable of DEPLOYABLES) {
      const host = config.hosts?.[deployable];
      expect(
        host === expectedHosts[environment][deployable],
        `environments.${environment}.hosts.${deployable}`,
        `must be ${String(expectedHosts[environment][deployable])}`,
      );
      const worker = config.resources?.[deployable]?.worker;
      expect(
        worker === expectedWorkers[environment][deployable],
        `environments.${environment}.resources.${deployable}.worker`,
        `must be ${expectedWorkers[environment][deployable]}`,
      );
      if (typeof worker === "string" && !worker.includes("{pr}")) {
        const prior = workerNames.get(worker);
        expect(
          prior === undefined,
          `environments.${environment}.resources.${deployable}.worker`,
          `duplicates Worker ${worker}, already owned by ${prior}`,
        );
        workerNames.set(worker, `${environment}.${deployable}`);
      }
    }
  }

  expect(
    valueAt(topology, "environments.production.issuer_base_url") ===
      "https://identity.ecoma.io",
    "environments.production.issuer_base_url",
    "must match the production identity hostname",
  );
  expect(
    valueAt(topology, "environments.staging.issuer_base_url") ===
      "https://stg-identity.ecoma.io",
    "environments.staging.issuer_base_url",
    "must match the canonical staging identity hostname",
  );
  expect(
    valueAt(topology, "environments.preview.issuer_base_url") ===
      "https://pr{pr}-identity.ecoma.io",
    "environments.preview.issuer_base_url",
    "must be isolated to the preview identity hostname",
  );
  expect(
    valueAt(topology, "environments.preview.never_binds_production") === true,
    "environments.preview.never_binds_production",
    "must state the preview-to-production binding prohibition",
  );
  expect(
    valueAt(topology, "environments.preview.email.mode") === "stub",
    "environments.preview.email.mode",
    "must be stub; a preview may not send real email",
  );
  expect(
    valueAt(topology, "environments.preview.email.provisioned") === false,
    "environments.preview.email.provisioned",
    "must state honestly that the required preview stub does not exist yet",
  );

  const fixedRateLimitIds = [];
  for (const environment of ["production", "staging", "development"]) {
    for (const deployable of ["identity", "identity-admin"]) {
      const namespaceId = valueAt(
        topology,
        `environments.${environment}.ratelimits.${deployable}.namespace_id`,
      );
      expect(
        typeof namespaceId === "string" && /^\d+$/.test(namespaceId),
        `environments.${environment}.ratelimits.${deployable}.namespace_id`,
        "must be a Cloudflare rate-limit integer namespace id",
      );
      fixedRateLimitIds.push(namespaceId);
    }
  }
  expect(
    new Set(fixedRateLimitIds).size === fixedRateLimitIds.length,
    "environments.*.ratelimits",
    "must not share a rate-limit namespace across environments",
  );
  const maxPr = valueAt(topology, "preview.max_pr_number.value");
  expect(
    Number.isInteger(maxPr) && maxPr > 0 && maxPr <= 999,
    "preview.max_pr_number.value",
    "must be an integer between 1 and 999 so preview rate-limit ids stay disjoint",
  );
  for (const pr of [1, maxPr]) {
    for (const deployable of ["identity", "identity-admin"]) {
      const template = valueAt(
        topology,
        `environments.preview.ratelimits.${deployable}.namespace_id_template`,
      );
      const namespaceId =
        typeof template === "string"
          ? template.replace("{pr}", String(pr))
          : "";
      expect(
        /^\d+$/.test(namespaceId),
        `environments.preview.ratelimits.${deployable}.namespace_id_template`,
        "must render to an integer namespace id",
      );
      expect(
        !fixedRateLimitIds.includes(namespaceId),
        `environments.preview.ratelimits.${deployable}.namespace_id_template`,
        `renders to ${namespaceId}, which collides with a fixed environment`,
      );
    }
  }

  const resources = topology.environments;
  for (const environment of ["production", "staging", "development"]) {
    const identity = resources?.[environment]?.resources?.identity;
    expect(
      isRecord(identity?.d1),
      `environments.${environment}.resources.identity.d1`,
      "identity is the one Worker that owns an identity D1 database",
    );
    expect(
      identity?.d1?.name === `ecoma-identity-${environment}`,
      `environments.${environment}.resources.identity.d1.name`,
      `must be ecoma-identity-${environment}`,
    );
    expect(
      identity?.queue?.name === `identity-${environment}`,
      `environments.${environment}.resources.identity.queue.name`,
      `must be identity-${environment}`,
    );
    expect(
      identity?.queue?.dlq === `identity-${environment}-dlq`,
      `environments.${environment}.resources.identity.queue.dlq`,
      `must be identity-${environment}-dlq`,
    );
  }

  expect(
    valueAt(topology, "environments.preview.resources.identity.d1.name") ===
      "ecoma-identity-pr-{pr}",
    "environments.preview.resources.identity.d1.name",
    "must derive the preview D1 name from the PR number",
  );
  expect(
    valueAt(topology, "environments.preview.resources.identity.queue.name") ===
      "identity-pr-{pr}",
    "environments.preview.resources.identity.queue.name",
    "must derive the preview queue name from the PR number",
  );
  expect(
    valueAt(topology, "environments.preview.resources.identity.queue.dlq") ===
      "identity-pr-{pr}-dlq",
    "environments.preview.resources.identity.queue.dlq",
    "must derive the preview dead-letter queue name from the PR number",
  );

  /* ------------------------------------------------------------------ *
   * The inverted gate: no identifier, and no way of obtaining one.
   *
   * This block replaces the walk that required every `$TOKEN` to resolve
   * through `resource_ids.sources`. The direction of truth is now
   * topology → logical name → Cloudflare lookup, so anything that would
   * resolve an id from configuration is a defect whether it holds an id
   * already or holds a pointer to one.
   * ------------------------------------------------------------------ */
  const walk = (value, pointer = "") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key.startsWith("$comment")) continue;
        const childPointer = pointer ? `${pointer}.${key}` : key;
        if (
          FORBIDDEN_ID_KEYS.has(key) &&
          !ALLOWED_ID_POINTERS.has(childPointer)
        ) {
          errors.push({
            pointer: childPointer,
            message:
              key === "id"
                ? 'is a resource-id indirection. Bare `id` is ambiguous — it means "an identifier for whatever this is" — and this manifest names resources rather than identifying them. The only permitted `id` is `account.id`.'
                : "is a resource-id indirection. This manifest is logical: it names resources, and Cloudflare mints identifiers. A key here reintroduces the topology → GitHub → resource-id chain this gate forbids, whether it holds a value or only a pointer to one.",
          });
        }
        walk(item, childPointer);
      }
      return;
    }
    if (typeof value !== "string") return;
    if (ALLOWED_ID_POINTERS.has(pointer)) return;
    if (TOKEN_REFERENCE.test(value)) {
      errors.push({
        pointer,
        message: `is the placeholder ${JSON.stringify(value)}. A resource identifier is discovered from Cloudflare by logical name, not substituted into the manifest; there is no variable to resolve this against and no default to invent.`,
      });
    }
    expect(
      !LITERAL_ID_PATTERNS.some((pattern) => pattern.test(value)),
      pointer,
      "must reference a resource by logical name, never commit a literal Cloudflare id",
    );
  };
  walk(topology);

  const grammar = topology.preview?.grammar;

  // Every kind the grammar guards must have a `never_delete` list under the
  // SAME key.
  //
  // `isNeverDeleted` answers `false` for a kind it has no list for, which reads
  // as "nothing is protected here" rather than as a fault. That is the one
  // answer a delete path must never give by accident, so the absence of a list
  // has to be impossible to express rather than merely unlikely: it was live on
  // `main` for the key `workers` against a caller asking for `worker`, and
  // every production Worker was unprotected while the validator reported the
  // topology valid.
  for (const kind of RESOURCE_KINDS) {
    const list = topology.preview?.never_delete?.[kind];
    expect(
      Array.isArray(list) && list.length > 0,
      `preview.never_delete.${kind}`,
      "must list at least one name; a kind the grammar guards with no never_delete entry has a backstop that is silently dead",
    );
    if (Array.isArray(list)) {
      for (const name of list) {
        expect(
          typeof name === "string" && name.length > 0,
          `preview.never_delete.${kind}`,
          "must list whole names, not patterns; this list is literal set membership and does not interpret a name",
        );
        expect(
          !matchesGrammar(topology, kind, name),
          `preview.never_delete.${kind}`,
          `lists ${JSON.stringify(name)}, which matches preview.grammar.${kind}; a name the grammar already refuses does not need a backstop entry, and listing it means one of the two rules is wrong`,
        );
      }
    }
  }

  // The reverse direction, because a kind with a list and no grammar is a
  // caller who believes it may delete something nothing can recognise.
  for (const kind of Object.keys(topology.preview?.never_delete ?? {})) {
    if (kind === "$comment") continue;
    expect(
      RESOURCE_KINDS.includes(kind),
      `preview.never_delete.${kind}`,
      "guards a kind `preview.grammar` does not declare; nothing can recognise a name of a kind with no rule",
    );
  }

  const canonicalPreviewNames = {
    worker: "identity-pr-123",
    d1: "ecoma-identity-pr-123",
    kv: "identity-pr-123-kv",
    queue: "identity-pr-123",
    dlq: "identity-pr-123-dlq",
    hostname: "pr123-home.ecoma.io",
    rate_limit: "identity-pr-123-rate-limit",
    cookie: "ecoma_pr123_locale",
    email_provider: "identity-email-provider-pr-123-stub",
  };
  for (const [kind, name] of Object.entries(canonicalPreviewNames)) {
    const source = grammar?.[kind];
    let expression;
    try {
      expression = new RegExp(source);
    } catch {
      expression = null;
    }
    expect(
      expression instanceof RegExp,
      `preview.grammar.${kind}`,
      "must be a valid regular expression",
    );
    if (expression instanceof RegExp) {
      expect(
        expression.test(name),
        `preview.grammar.${kind}`,
        `must recognise canonical preview resource ${name}`,
      );
    }
  }

  const deletionOrder = valueAt(topology, "preview.deletion_order.steps");
  expect(
    Array.isArray(deletionOrder),
    "preview.deletion_order.steps",
    "must be an ordered deletion sequence",
  );
  if (Array.isArray(deletionOrder)) {
    expect(
      deletionOrder.join(",") ===
        "custom_domains,worker:identity-admin,worker:identity-jobs,worker:home-web,worker:identity,dlq,queue,kv,d1",
      "preview.deletion_order.steps",
      "must remove entrypoints, then dependants, then data in reverse topology order",
    );
  }
  expect(
    valueAt(topology, "preview.not_deletable.rate_limit_namespaces") === true,
    "preview.not_deletable.rate_limit_namespaces",
    "must document that Cloudflare rate-limit namespaces cannot be deleted",
  );
  expect(
    valueAt(topology, "preview.evidence.on_unknown") === "do-not-delete",
    "preview.evidence.on_unknown",
    "must fail closed when GitHub cannot prove a PR is closed",
  );
  expect(
    valueAt(topology, "preview.evidence.on_open") === "do-not-delete",
    "preview.evidence.on_open",
    "must not delete a reopened preview",
  );

  /* ------------------------------------------------------------------ *
   * Isolation the delete path depends on, stated as arithmetic.
   * ------------------------------------------------------------------ */

  // The home page is the zone APEX in production and a prefixed subdomain
  // everywhere else. If the preview grammar ever matched the apex form,
  // `pr123.ecoma.io` would classify as a preview host — and a cleanup run
  // would be one refactor away from treating a shape it does not own as
  // disposable.
  expect(
    typeof grammar?.hostname === "string" &&
      !new RegExp(grammar.hostname).test("pr123.ecoma.io"),
    "preview.grammar.hostname",
    "must not match the bare apex form pr123.ecoma.io; a preview serves pr123-home.ecoma.io and production serves the apex",
  );

  // The locale cookie name is what keeps a preview's visitor preference out of
  // the other previews. The grammar and the declared name have to agree, or a
  // cleanup run recognises a cookie namespace that no deployment writes.
  for (const environment of ENVIRONMENTS) {
    const declared = topology.cookie_namespaces?.[environment];
    const prefix = valueAt(
      topology,
      `environments.${environment}.cookie_prefix`,
    );
    expect(
      declared === prefix,
      `cookie_namespaces.${environment}`,
      `must equal environments.${environment}.cookie_prefix (${String(prefix)}); the same cookie name with two owners is a name with two owners`,
    );
    expect(
      typeof declared === "string" && declared.endsWith("_locale"),
      `cookie_namespaces.${environment}`,
      "must be a complete cookie name ending in _locale, not a prefix",
    );
  }
  expect(
    new Set(
      ENVIRONMENTS.map(
        (environment) => topology.cookie_namespaces?.[environment],
      ),
    ).size === ENVIRONMENTS.length,
    "cookie_namespaces",
    "must not share a cookie name across environments",
  );

  // No preview name may collide with a fixed environment's. This is the
  // arithmetic behind `never_binds_production`: two environments reaching the
  // same resource is the bug the whole naming scheme exists to prevent.
  const fixedResourceNames = new Set();
  for (const environment of FIXED_ENVIRONMENTS) {
    const resources = valueAt(
      topology,
      `environments.${environment}.resources`,
    );
    if (!isRecord(resources)) continue;
    for (const [deployable, declared] of Object.entries(resources)) {
      if (!isRecord(declared)) continue;
      for (const name of [
        declared.worker,
        declared.d1?.name,
        declared.kv?.name,
        declared.queue?.name,
        declared.queue?.dlq,
      ]) {
        if (typeof name !== "string" || name.includes("{pr}")) continue;
        fixedResourceNames.add(name);
        for (const kind of ["worker", "d1", "kv", "queue", "dlq"]) {
          if (matchesGrammar(topology, kind, name)) {
            errors.push({
              pointer: `environments.${environment}.resources.${deployable}`,
              message: `${JSON.stringify(name)} is a fixed ${environment} resource name that also matches preview.grammar.${kind}`,
            });
          }
        }
      }
    }
  }
  expect(
    fixedResourceNames.size > 0,
    "environments.*.resources",
    "the fixed environments declare no resource names at all, so the preview/production collision check proved nothing",
  );

  return errors;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("--root="))
      options.root = path.resolve(arg.slice(7));
    else if (arg === "--help") options.help = true;
    else options.error = `unknown argument: ${arg}`;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node tooling/scripts/validate-topology.mjs [--root=<directory>] [--json]\n",
    );
    return EXIT_OK;
  }
  if (options.error) {
    process.stderr.write(`${options.error}\n`);
    return EXIT_USAGE;
  }

  let loaded;
  try {
    loaded = loadTopology(options.root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return EXIT_CANNOT_RUN;
  }

  const errors = validateTopology(loaded.topology);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ file: loaded.file, valid: errors.length === 0, errors }, null, 2)}\n`,
    );
  } else if (errors.length === 0) {
    process.stdout.write(
      `topology valid: ${path.relative(options.root, loaded.file)}\n`,
    );
  } else {
    process.stderr.write(
      `topology invalid: ${path.relative(options.root, loaded.file)}\n`,
    );
    for (const { pointer, message } of errors) {
      process.stderr.write(`  ${pointer || "(root)"}: ${message}\n`);
    }
  }
  return errors.length === 0 ? EXIT_OK : EXIT_INVALID;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}

export { main, validateTopology };
