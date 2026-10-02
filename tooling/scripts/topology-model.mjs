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

/**
 * The resource kinds `preview.grammar` declares a rule for, and therefore every
 * kind `preview.never_delete` must carry a list for.
 *
 * This list and the manifest are held in agreement by `validate-topology.mjs`,
 * which fails when a kind has grammar but no `never_delete` entry. That gap is
 * exactly how the Worker backstop sat dead on `main` without anything noticing:
 * the manifest spelled the key `workers`, the caller asked for `worker`, and a
 * missing list read as "nothing is protected" rather than as a fault.
 */
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

/**
 * What a delete step is called in `deletion_order`, and what it is called in the
 * guards. Empty for almost every step.
 *
 * `preview.deletion_order.steps` names its first step `custom_domains` because
 * what it deletes is a Cloudflare Custom Domain attached to a Worker — not a
 * DNS hostname as such. `preview.grammar` and `preview.never_delete` call the
 * same resource `hostname`, because that is the shape a guard is handed: a
 * string like `pr33-home.ecoma.io`.
 *
 * Two spellings for one resource is the condition that produced the first three
 * bugs in this path, so the reconciliation lives in ONE table here instead of
 * being rediscovered — and misspelled — by each caller.
 */
export const KIND_ALIASES = {
  custom_domains: "hostname",
};

/**
 * The `preview.grammar` / `preview.never_delete` key a delete step is tested
 * against, or a thrown `TopologyError` for a kind neither list knows.
 *
 * Throwing rather than passing an unknown kind straight through is deliberate,
 * and it is the second half of the same fix. `matchesGrammar` already threw;
 * `isNeverDeleted` did not — an absent list read as "nothing is protected
 * here", so a caller deleting on that basis would get no refusal at all.
 */
export function guardKind(kind) {
  const alias = KIND_ALIASES[kind];
  if (alias) return alias;
  if (!RESOURCE_KINDS.includes(kind)) {
    throw new TopologyError(
      `unknown resource kind ${JSON.stringify(kind)}; expected one of ` +
        `${RESOURCE_KINDS.join(", ")}, or an alias (${Object.keys(KIND_ALIASES).join(", ")}).`,
    );
  }
  return kind;
}

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_CANNOT_RUN = 2;
export const EXIT_USAGE = 64;

/** A topology read failure. Carries the path, because "it failed" is not a diagnosis. */
export class TopologyError extends Error {}

/**
 * Print a failure so it can be diagnosed from a run log alone.
 *
 * These scripts run inside a GitHub Actions step whose entire output is the
 * only evidence that survives, and a bare
 *
 *     Cannot read properties of undefined (reading 'id')
 *
 * says what broke and nothing about where — which cost a debugging session
 * once already, on a line that had no guard around it. So the stack goes to
 * stderr, plus a `::error::` annotation so GitHub renders this as a failure
 * rather than as log noise somebody has to go looking for.
 *
 * The message appears twice on purpose: once bare, for a human reading
 * consecutive lines, and once inside the annotation, because GitHub collapses
 * and truncates annotation contents in the run summary.
 *
 * Nothing here prints a secret. A stack carries file paths, function names and
 * line numbers; the Cloudflare token is read from the environment and is not
 * part of any value a stack would render. GitHub masks a registered secret with
 * `***` in any case, which is what lets a run log be pasted into an issue
 * without leaking the credential it was debugging.
 *
 * @param {string} tool The script name, so a log line says which tool failed
 *   when several run in one step.
 * @param {unknown} error Anything thrown. A non-Error is reported as such,
 *   because "something threw a string" is itself the finding.
 */
export function reportFailure(tool, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  } else {
    process.stderr.write(`${tool}: thrown value was not an Error.\n`);
  }
  const single = message.replace(/\s+/g, " ").slice(0, 900);
  process.stderr.write(`::error::${tool}: ${single}\n`);
}

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
 *
 * `kind` goes through `guardKind`, so the `custom_domains` step is tested
 * against the `hostname` list rather than against a key that does not exist.
 * A missing key previously returned `false` — "not on the list" — which is the
 * one answer this function must never give by accident, and it was giving it
 * for every Worker in the account.
 */
export function isNeverDeleted(topology, kind, name) {
  const list = topology.preview.never_delete[guardKind(kind)];
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
  const guarded = guardKind(kind);
  if (isNeverDeleted(topology, guarded, name)) {
    return `is a literal member of preview.never_delete.${guarded}`;
  }
  if (!matchesGrammar(topology, guarded, name)) {
    return `does not match preview.grammar.${guarded} (${topology.preview.grammar[guarded]})`;
  }
  return null;
}

/**
 * Which `env` SLOT each deployable reads its resource through.
 *
 * Binding names are slot names — the strings the Worker reads as `env.IDENTITY_DB`
 * — and they never vary by environment: a preview reads the same `IDENTITY_DB`
 * as production, it just points at a different database. That is precisely why
 * they live outside `environments.<env>` in the manifest, and it is why they are
 * not passed through `expand` here. Substituting `{pr}` into a slot name would
 * produce a binding no Worker declares, and the manifest's own validator rejects
 * the idea: "these are binding NAMES … they are not Cloudflare resource ids".
 *
 * A deployable that binds nothing resolves to an empty object rather than being
 * dropped, so a caller asking about a deployable that binds no D1 gets "no"
 * instead of a missing key.
 *
 * Every deployable's slots are COPIED from the manifest rather than enumerated
 * by name. An enumeration is a second view of `topology.bindings` that can
 * drift from it, and it drifted in the direction hardest to notice: a slot
 * added to a deployable would be dropped here, so `resolve-infra-name.mjs
 * --ask bindings.<deployable>.<newslot>` would answer "is not declared" and exit
 * 0 — a false negative from the one tool whose whole purpose is to be
 * authoritative about this file.
 *
 * Nothing else caught it. `validate-topology.mjs`'s `exactKeys` over
 * `topology.bindings` checks the deployable keys, not each deployable's slots,
 * and `render-wrangler-config.mjs` reads `topology.bindings[deployable]`
 * directly — so it saw the new slot while this function did not.
 *
 * Spread, not passed through: `services` is an array and the rest are strings.
 * The shallow copy keeps a caller from mutating the parsed manifest through
 * this object, which is shared by every later resolution in the same process.
 */
function resolveBindings(topology) {
  const slots = {};
  for (const deployable of DEPLOYABLES) {
    slots[deployable] = { ...(topology.bindings[deployable] ?? {}) };
  }
  return slots;
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
    // The deployables this environment declares, in manifest order. A caller
    // that must iterate all of them reads them from here rather than keeping
    // its own list, which is how a fifth deployable would otherwise be deployed
    // and never migrated.
    // Copied, like `services` below: `DEPLOYABLES` is a module-level constant
    // shared with `previewResources` and `validate-topology.mjs`, so handing out
    // the array by reference lets one caller sort or push on it and corrupt the
    // list every later resolution reads. The corruption would be invisible at the
    // call site and would surface somewhere else entirely.
    deployables: [...DEPLOYABLES],
    bindings: resolveBindings(topology),
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
    step: `worker:${deployable}`,
    deployable,
    name: resolved.resources[deployable].worker,
  }));

  // `kind` is the guard's key throughout, never the step's spelling. The one
  // place the two differ is `custom_domains`, whose step says what Cloudflare
  // calls the attachment while its names are hostnames — so a caller passes the
  // name straight to `deletionRefusal` and must not have to know the step's
  // vocabulary differs from the guard's.
  const entries = [
    { kind: "hostname", step: "custom_domains", names: hosts },
    ...workers,
    {
      kind: "dlq",
      step: "dlq",
      name: resolved.resources.identity.queue.dlq,
    },
    {
      kind: "queue",
      step: "queue",
      name: resolved.resources.identity.queue.name,
    },
    {
      kind: "kv",
      step: "kv",
      names: [
        resolved.resources.identity.kv.name,
        resolved.resources["identity-jobs"].kv.name,
      ],
    },
    {
      kind: "d1",
      step: "d1",
      name: resolved.resources.identity.d1.name,
    },
  ];

  // Sorted BY THE MANIFEST, and `order` is each entry's POSITION in
  // `preview.deletion_order.steps` rather than the array itself.
  //
  // Both were wrong. The unsorted list ran `identity` before
  // `identity-admin`, and the manifest asks for the opposite with a stated
  // reason: "Workers go in reverse dependency order — the consumers before the
  // thing they consume — so no deletion orphans a live service binding."
  // `identity-admin` and `identity-jobs` bind `IDENTITY`; deleting `identity`
  // first leaves them holding a binding to a Worker that no longer exists.
  //
  // `order` being the whole nine-element array meant no caller could index by
  // it. Nothing consumed this function before now — it is the janitor's only
  // source of what to delete and in what order — so the mistake would have been
  // invisible right up to the first teardown, where it deletes a Worker with
  // live dependents.
  //
  // The sort is stable and keyed on `step`. A step the manifest lists but this
  // function cannot produce now THROWS, above, rather than being absorbed — and
  // `validate-topology.mjs` independently pins `steps` to the sequence this
  // function produces, so a new step has to be added in both places to be
  // accepted anywhere. The remaining `rank` fallback is defensive only: a delete
  // path that trusts an ordering default is exactly the thing that should not,
  // but with both directions checked by name there is nothing left for it to
  // paper over.
  const steps = topology.preview.deletion_order.steps;

  // A step the manifest lists and this function does not produce is a resource
  // a preview owns that NOTHING will ever delete, and the run that skipped it
  // would report a complete teardown. That is the worse failure, so it throws
  // here — at plan time, before the first delete — rather than sorting quietly
  // to an end and being ignored.
  //
  // The reverse, an entry the manifest does not list, is already fatal in
  // `validate-topology.mjs`, which pins `steps` to the sequence this function
  // produces. Both directions are therefore checked, from opposite ends, by two
  // different tools that have to agree.
  const produced = new Set(entries.map((entry) => entry.step));
  const unproducible = steps.filter((step) => !produced.has(step));
  if (unproducible.length > 0) {
    throw new TopologyError(
      `preview.deletion_order.steps lists ${unproducible.map((s) => JSON.stringify(s)).join(", ")}, ` +
        "which previewResources cannot produce; a step nothing can produce is a " +
        "resource a preview owns that no teardown will ever delete.",
    );
  }

  const rank = (step) => {
    const index = steps.indexOf(step);
    return index === -1 ? steps.length : index;
  };

  return entries
    .map((entry) => ({ ...entry, order: rank(entry.step) }))
    .sort((a, b) => a.order - b.order);
}
