/**
 * `validate-topology.mjs` — prove the deployment model can describe only the
 * topology we are willing to operate.
 *
 * WHAT THIS IS. A dependency-free validator for `infra/topology/topology.json`.
 * JSON Schema documents the public shape in `infra/topology/topology.schema.json`,
 * but Node deliberately does not ship a schema evaluator and adding one would put a
 * production-safety gate behind a new dependency. The assertions below are the
 * executable schema: each one names an invariant a malformed manifest must not be
 * able to weaken.
 *
 * WHAT THIS IS NOT. This does not inspect a rendered wrangler configuration or a
 * Cloudflare account. The renderer and the topology checker are later units. This
 * is the first gate: a manifest that cannot state a safe topology is rejected
 * before another tool is allowed to consume it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const TOPOLOGY_PATH = path.join("infra", "topology", "topology.json");
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_CANNOT_RUN = 2;
const EXIT_USAGE = 64;
const DEPLOYABLES = ["identity", "identity-admin", "identity-jobs", "home-web"];
const ENVIRONMENTS = ["production", "staging", "development", "preview"];

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
    valueAt(topology, "account.id_env_var") === "CLOUDFLARE_ACCOUNT_ID",
    "account.id_env_var",
    "must name the one repository Variable, CLOUDFLARE_ACCOUNT_ID",
  );
  expect(
    valueAt(topology, "account.id_source") === "github-variable",
    "account.id_source",
    "must be github-variable; an account id is configuration, not a secret",
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
      "home-web": "stg.ecoma.io",
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
      "home-web": "pr{pr}.ecoma.io",
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

  const tokenReferences = [];
  const literalIdPatterns = [
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
    /^[0-9a-f]{32}$/i,
  ];
  const walk = (value, pointer = "") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}[${index}]`));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key.startsWith("$comment")) continue;
        walk(item, pointer ? `${pointer}.${key}` : key);
      }
    } else if (typeof value === "string") {
      if (/^\$[A-Z0-9_]+$/.test(value))
        tokenReferences.push({ pointer, token: value.slice(1) });
      expect(
        !literalIdPatterns.some((pattern) => pattern.test(value)),
        pointer,
        "must reference a resource id through $TOKEN, never commit a literal Cloudflare id",
      );
    }
  };
  walk(topology);
  for (const { pointer, token } of tokenReferences) {
    expect(
      isRecord(topology.resource_ids?.sources?.[token]),
      pointer,
      `$${token} has no resource_ids.sources entry`,
    );
  }

  const grammar = topology.preview?.grammar;
  const canonicalPreviewNames = {
    worker: "identity-pr-123",
    d1: "ecoma-identity-pr-123",
    kv: "identity-pr-123-kv",
    queue: "identity-pr-123",
    dlq: "identity-pr-123-dlq",
    hostname: "pr123.ecoma.io",
    rate_limit: "identity-pr-123-rate-limit",
    cookie: "ecoma_pr123",
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

  return errors;
}

function readTopology(root) {
  const file = path.join(root, TOPOLOGY_PATH);
  const source = fs.readFileSync(file, "utf8");
  return { file, topology: JSON.parse(source) };
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
    loaded = readTopology(options.root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `could not read ${path.join(options.root, TOPOLOGY_PATH)}: ${message}\n`,
    );
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

export { DEPLOYABLES, ENVIRONMENTS, main, readTopology, validateTopology };
