#!/usr/bin/env node
/**
 * `list-preview-prs.mjs` — which pull requests still have a preview in the
 * account?
 *
 * WHY THIS EXISTS. Every other delete trigger in `janitor.yml` is an EVENT, and
 * an event requires something to have happened: a pull request closed, a Deploy
 * Preview run finished. A preview whose pull request was deleted, or one that
 * predates this repository's preview lane, has no event pending and will never
 * be cleaned up by one. Those are the orphans, and they are why the zone's 100
 * custom domains is a real ceiling rather than a theoretical one.
 *
 * WHAT IT DOES NOT DO. It does not delete, and it does not decide. Every name
 * it emits is put through the SAME `preview.grammar` the delete path uses — by
 * calling `deletionRefusal` rather than by re-implementing the match — so a
 * name this file proposes is a name the guards already accept. Deciding that
 * such a preview is safe to remove requires reading the pull request's state
 * from GitHub, and that lookup belongs to exactly one place: the `evidence` job
 * in `janitor.yml`. A second deletion path here would be a second set of rules
 * to keep correct, and the rules are the part that must not be wrong.
 *
 * WHY IT READS STDIN. The account listing comes from `wrangler`, whose output
 * shape is wrangler's business and changes between versions. Reading it here as
 * a stream means this file can be pointed at a saved copy of yesterday's output
 * and will answer the same question, which is what makes it testable at all —
 * there is no Cloudflare account in this repository's test suite.
 */

import fs from "node:fs";

import {
  FIXED_ENVIRONMENTS,
  loadTopology,
  matchesGrammar,
  deletionRefusal,
  validatePrNumber,
} from "./topology-model.mjs";

const USAGE = `Usage: node tooling/scripts/list-preview-prs.mjs [--json] [--root=<dir>]

  --json       Emit JSON instead of one pull request number per line.
  --root=<dir> Repository root; defaults to this script's parent repo.

Reads a wrangler listing on stdin. Emits one entry per distinct pull request
that has at least one resource matching preview.grammar. Deletes nothing and
decides nothing: see the header.
`;

/**
 * Pull the candidate names out of whatever shape wrangler produced.
 *
 * Deliberately forgiving about the envelope and strict about the names. A new
 * wrangler version wrapping its output differently should not break the sweep,
 * but a name that cannot be checked against the grammar must not be reported
 * as a preview — so anything not shaped like a string is skipped rather than
 * guessed at, and the caller sees fewer entries rather than a wrong one.
 */
export function collectNames(input) {
  const names = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      names.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      // Keys wrangler is known to use for a resource's own name. Anything else
      // is a nested structure to walk rather than a name to trust.
      for (const key of [
        "name",
        "script_name",
        "queue_name",
        "namespace",
        "id",
      ]) {
        if (typeof value[key] === "string") names.add(value[key]);
      }
      for (const nested of Object.values(value)) visit(nested);
    }
  };

  if (input !== null && typeof input === "object") {
    visit(input);
  } else {
    for (const line of String(input).split("\n")) {
      const trimmed = line.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names];
}

/**
 * The pull request a preview name belongs to, or `null` when it is not one.
 *
 * Read from the name rather than from a GitHub lookup, because that is the only
 * information available about an ORPHAN — the whole point of this file is the
 * previews whose pull request cannot be read. The patterns are the ones
 * `preview.grammar` already encodes; they are spelled out here only to extract
 * the number, and the name is then handed to `deletionRefusal`, which decides.
 */
export function prFromName(topology, name) {
  for (const kind of [
    "worker",
    "d1",
    "kv",
    "queue",
    "dlq",
    "hostname",
    "email_provider",
  ]) {
    if (!matchesGrammar(topology, kind, name)) continue;

    // Every grammar is anchored and every preview name carries its PR number,
    // so the number is recoverable from the name whatever the shape. `grammar`
    // uses `[0-9]+`, which admits a leading zero — `identity-pr-0` and
    // `identity-pr-007` both match it, and both name a pull request that cannot
    // exist. The number is therefore re-validated here with the manifest's own
    // `validatePrNumber`, which enforces `preview.pr_number` (`^[1-9][0-9]*$`)
    // and the `max_pr_number` cap.
    const digits = name.match(/pr[-_]?(\d+)/i) ?? name.match(/^pr(\d+)[-.]/i);
    if (!digits) return null;
    try {
      return validatePrNumber(topology, digits[1]);
    } catch {
      // A number the manifest refuses is a name no preview was ever built from,
      // so it belongs to nobody. Refused silently rather than reported: this is
      // a name that matched a grammar, not a name a guard stopped.
      return null;
    }
  }
  return null;
}

/**
 * Every pull request with at least one preview resource, with its names.
 *
 * A name that matches a fixed environment's grammar is impossible by
 * construction, but the check is not skipped: `deletionRefusal` is the single
 * spelling of "may this name be deleted", and this file is a delete path's
 * input, so it uses the real one rather than a local copy of the rule.
 */
export function previewPullRequests(topology, names) {
  const byPr = new Map();
  const refused = [];

  for (const name of names) {
    const pr = prFromName(topology, name);
    if (pr === null) continue;

    let kind = null;
    for (const candidate of [
      "worker",
      "d1",
      "kv",
      "queue",
      "dlq",
      "hostname",
      "email_provider",
    ]) {
      if (matchesGrammar(topology, candidate, name)) {
        kind = candidate;
        break;
      }
    }

    const reason = deletionRefusal(topology, kind ?? "worker", name);
    if (reason) {
      refused.push({ name, reason });
      continue;
    }

    const entry = byPr.get(pr) ?? { pr, names: [] };
    entry.names.push(name);
    byPr.set(pr, entry);
  }

  return {
    pullRequests: [...byPr.values()].sort((a, b) => a.pr - b.pr),
    refused,
    fixedEnvironments: FIXED_ENVIRONMENTS,
  };
}

export function parseArgs(argv) {
  const options = { json: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--root=") options.root = arg.slice("--root=".length);
    else if (arg === "--help") options.help = true;
    else options.error = `unknown argument: ${arg}`;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}`);
    return 1;
  }

  const raw = fs.readFileSync(0, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: read it as one name per line. A wrangler version that prints a
    // table is still usable, which is the point of accepting either.
    parsed = raw;
  }

  const { topology } = loadTopology(options.root);
  const names = collectNames(parsed);
  const report = previewPullRequests(topology, names);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          pullRequests: report.pullRequests,
          refused: report.refused,
          scanned: names.length,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const entry of report.pullRequests) {
      process.stdout.write(`${entry.pr}\n`);
    }
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}

export { main };
