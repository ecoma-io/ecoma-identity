/**
 * `topology-model.mjs` — the one model of `infra-topology/topology.json`.
 *
 * WHAT THIS IS. The vocabulary and the arithmetic that every other tool needs and
 * none of them should re-implement: the deployables, the environments, how a
 * `{pr}` template becomes a real name, and what counts as a preview name.
 *
 * WHY IT IS SEPARATE. Three tools consume this manifest — the validator, the
 * renderer and the reconciler — and one of them is a *delete* path. The delete
 * path's name check is the most safety-critical expression in this repository:
 * a `startsWith` where an anchored test belongs would eventually match
 * `identity-production`. A rule that four files each spell slightly differently is
 * a rule one of them will spell wrong, so there is exactly one spelling and it is
 * here.
 *
 * WHAT IT IS NOT. Not a validator. `validate-topology.mjs` judges whether a
 * manifest is *legal*; this module assumes one and turns it into values. Not a
 * renderer either — `render-wrangler-config.mjs` decides what a config looks
 * like, and this module only knows what things are called.
 *
 * No dependencies. Node ≥ 20.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const TOPOLOGY_PATH = path.join("infra-topology", "topology.json");

/** The four deployables. ADR-0016 added home-web. */
export const DEPLOYABLES = [
  "identity",
  "identity-admin",
  "identity-jobs",
  "home-web",
];

/** Four environments. `preview` is per-PR and renders from `{pr}`. */
export const ENVIRONMENTS = ["production", "staging", "development", "preview"];

/** Environments whose infrastructure is provisioned and long-lived. */
export const FIXED_ENVIRONMENTS = ["production", "staging", "development"];

/** The resource kinds a preview can own, matching `preview.grammar`' keys. */
export const RESOURCE_KINDS = [
  "worker",
  "d1",
  "kv",
  "queue",
  "dlq",
  "hostname",
  "rate_limit",
  "cookie",
  "email_provider",
];

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_CANNOT_RUN = 2;
export const EXIT_USAGE = 64;

/** A topology read failure. Carries the path, because "it failed" is not a diagnosis. */
export class TopologyError extends Error {}

/**
 * Read and parse the manifest. Throws `TopologyError` rather than letting a
 * JSON parse error escape with no path attached — a caller that catches this
 * prints the message, and a stack trace from `JSON.parse` prints nothing about
 * which file.
 */
export function loadTopology(root = DEFAULT_ROOT) {
  const file = path.join(root, TOPOLOGY_PATH);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TopologyError(`could not read ${file}: ${message}`);
  }
  try {
    return { file, topology: JSON.parse(source) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TopologyError(`${file} is not valid JSON: ${message}`);
  }
}

/** Whether a PR number is well-formed and within the manifest's cap. */
export function validatePrNumber(topology, pr) {
  const raw = typeof pr === "number" ? String(pr) : String(pr ?? "");
  if (!new RegExp(topology.preview.pr_number).test(raw)) {
    throw new TopologyError(
      `PR number ${JSON.stringify(raw)} does not match preview.pr_number (${topology.preview.pr_number}).`,
    );
  }
  const value = Number(raw);
  const max = topology.preview.max_pr_number.value;
  if (!Number.isSafeInteger(value) || value > max) {
    throw new TopologyError(
      `PR number ${value} exceeds preview.max_pr_number (${max}); preview.max_pr_number.on_exceed is "${topology.preview.max_pr_number.on_exceed}".`,
    );
  }
  return value;
}

/**
 * Substitute `{pr}` in a template.
 *
 * Every template in this manifest has exactly one placeholder and it is always
 * `{pr}`. A template with any *other* `{…}` in it is a typo, not something to
 * substitute — silently leaving `{deployable}` in place would produce a real
 * Cloudflare resource literally named `identity-{deployable}`, and the fix is
 * here, not at the point of failure.
 */
export function renderTemplate(template, pr) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (key !== "pr") {
      throw new TopologyError(
        `template ${JSON.stringify(template)} contains the placeholder {${key}}; only {pr} is substitutable.`,
      );
    }
    return String(pr);
  });
}

/**
 * Whether `name` is a preview name of `kind`.
 *
 * Anchored, whole-string, no prefix matching. This is the check the delete path
 * depends on, and it is the one place that check exists.
 */
export function matchesGrammar(topology, kind, name) {
  const source = topology.preview.grammar[kind];
  if (typeof source !== "string") {
    throw new TopologyError(
      `preview.grammar has no entry for kind ${JSON.stringify(kind)}.`,
    );
  }
  return new RegExp(source).test(String(name));
}

/**
 * Whether `name` is a member of `preview.never_delete` for `kind`.
 *
 * The backstop. Tested before every delete IN ADDITION to the grammar, because
 * the grammar is the thing most likely to be wrong in a way that lets something
 * through — and this list does not depend on it being right.
 */
export function isNeverDeleted(topology, kind, name) {
  const list = topology.preview.never_delete[kind];
  if (!Array.isArray(list)) return false;
  return list.includes(String(name));
}

/**
 * Why a name may not be deleted, or `null` when it may.
 *
 * Returns the reason rather than a boolean so that a caller can report *which*
 * guard stopped it. A cleanup run that says "skipped: matched no grammar" and
 * one that says "skipped: never_delete list" are very different findings, and
 * collapsing them to a boolean loses the second one entirely.
 */
export function deletionRefusal(topology, kind, name) {
  if (isNeverDeleted(topology, kind, name)) {
    return `is a literal member of preview.never_delete.${kind}`;
  }
  if (!matchesGrammar(topology, kind, name)) {
    return `does not match preview.grammar.${kind} (${topology.preview.grammar[kind]})`;
  }
  return null;
}

/**
 * Resolve one environment of the manifest into concrete names.
 *
 * `pr` is required for `preview` and refused elsewhere: rendering a preview
 * template with no PR number would produce `identity-pr-{pr}`, which is a real
 * and completely wrong name for a real account. Passing `pr` for a fixed
 * environment is refused too, because it implies the fixed environment's names
 * depend on a pull request.
 */
export function resolveEnvironment(topology, environment, { pr } = {}) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new TopologyError(
      `unknown environment ${JSON.stringify(environment)}; expected one of ${ENVIRONMENTS.join(", ")}.`,
    );
  }
  const config = topology.environments[environment];
  if (!config)
    throw new TopologyError(`environment ${environment} is not declared.`);

  const number =
    environment === "preview" ? validatePrNumber(topology, pr) : null;
  if (environment !== "preview" && pr !== undefined && pr !== null) {
    throw new TopologyError(
      `environment ${environment} is fixed and must not be rendered for PR ${JSON.stringify(pr)}.`,
    );
  }

  const expand = (value) =>
    typeof value === "string" && value.includes("{pr}")
      ? renderTemplate(value, number)
      : value;

  const resources = {};
  for (const deployable of DEPLOYABLES) {
    const declared = config.resources[deployable];
    const entry = { worker: expand(declared.worker) };
    if (declared.d1) {
      entry.d1 = {
        name: expand(declared.d1.name),
        migrations_table: declared.d1.migrations_table,
      };
    }
    if (declared.kv) entry.kv = { name: expand(declared.kv.name) };
    if (declared.queue) {
      entry.queue = {
        name: expand(declared.queue.name),
        dlq: expand(declared.queue.dlq),
      };
    }
    resources[deployable] = entry;
  }

  const ratelimits = {};
  for (const [role, declared] of Object.entries(config.ratelimits ?? {})) {
    if (typeof declared !== "object" || declared === null) continue;
    ratelimits[role] = {
      namespace_id: expand(
        declared.namespace_id ?? declared.namespace_id_template,
      ),
      simple: declared.simple,
    };
  }

  const hosts = {};
  for (const [deployable, host] of Object.entries(config.hosts)) {
    hosts[deployable] = host === null ? null : expand(host);
  }

  return {
    environment,
    pr: number,
    hosts,
    workers_dev: config.workers_dev,
    issuer_base_url: expand(config.issuer_base_url),
    email: { mode: config.email.mode, service: expand(config.email.service) },
    cookie_name: expand(config.cookie_prefix),
    ratelimits,
    resources,
  };
}

/**
 * Every resource a preview for `pr` owns, keyed by `preview.deletion_order.steps`
 * order.
 *
 * Returned in the manifest's own deletion order, and the reconciler and the
 * cleanup script both walk this list rather than a list of their own — one owner
 * for the order is what stops the PR-close path and the janitor disagreeing
 * about what comes first.
 */
export function previewResources(topology, pr) {
  const resolved = resolveEnvironment(topology, "preview", { pr });
  const hosts = Object.entries(resolved.hosts)
    .filter(([, host]) => typeof host === "string")
    .map(([, host]) => host);

  const workers = DEPLOYABLES.map((deployable) => ({
    kind: "worker",
    deployable,
    name: resolved.resources[deployable].worker,
  }));

  return [
    { kind: "custom_domains", names: hosts },
    ...workers,
    { kind: "dlq", name: resolved.resources.identity.queue.dlq },
    { kind: "queue", name: resolved.resources.identity.queue.name },
    {
      kind: "kv",
      names: [
        resolved.resources.identity.kv.name,
        resolved.resources["identity-jobs"].kv.name,
      ],
    },
    { kind: "d1", name: resolved.resources.identity.d1.name },
  ].map((entry) => ({
    ...entry,
    order: topology.preview.deletion_order.steps,
  }));
}
