#!/usr/bin/env node
/**
 * The contracts gate.
 *
 * Answers exactly one question: **does every file under `contracts/` still say
 * what the code beside it does?** A contract here is a promise about a surface,
 * and the whole point of writing one is that a consumer can rely on it. A
 * contract that has drifted is worse than no contract, because a consumer that
 * trusted it built against the wrong shape and found out in production.
 *
 * WHAT IT CHECKS, and why each is here rather than being "obvious":
 *
 *   1. Every `*.json` parses. Trivial, and the check that catches a truncated
 *      file from a bad merge — which is how one of these got committed once.
 *
 *   2. Every schema declares draft 2020-12. A `definitions` block and a
 *      `components/schemas` block are not the same language, and a consumer
 *      that validates against the declared dialect is the one that breaks.
 *
 *   3. Every schema carries `$id`, `x-rust-type` and `x-serde-status`.
 *      `x-serde-status` is the one this repository is unusual about, and it is
 *      the reason this file exists: a schema that describes a shape with no
 *      statement of whether anything produces it is exactly the overstatement
 *      `AGENTS.md` forbids. The annotation is what makes "this is a promise,
 *      not a claim" machine-checkable instead of a matter of discipline.
 *
 *   4. The OIDC route table in `contracts/oidc/v1/README.md` agrees with
 *      `identity_oidc::route::Route`. That README says "this contract is
 *      checked against it", and until this file existed that sentence was a
 *      claim nobody had implemented. The Rust table is the source of truth —
 *      the Identity Worker dispatches from it — and the README is the human
 *      view of it, so a route added in Rust and not in the README is a route
 *      the next reader will believe does not exist.
 *
 * WHAT IT DOES NOT CHECK, stated plainly so nobody assumes it does:
 *
 *   * That the schemas are CORRECT. This reads structure, not meaning. A schema
 *     can be well-formed, correctly annotated and semantically wrong, and this
 *     gate will pass it. The schemas are derived from the Rust types and the
 *     derivation is reviewed; a mechanical check cannot review meaning.
 *
 *   * That any surface SERVES what its schema describes. At platform bootstrap
 *     no protocol route does: every one answers 501. A contract being checked
 *     here says nothing about a route existing, and this file must never be
 *     cited as evidence that one does.
 *
 * WHY IT IS A SCRIPT AND NOT A MOON TASK: no moon project owns `contracts/` —
 * it is a directory of documents, not a package. The moment one does, this
 * moves under it; `lefthook.yml` says so at the call site.
 *
 * EXIT CODES: 0 = every check ran and passed. 1 = a check failed, with the
 * file, what was expected and what was found. There is no "could not run" exit,
 * because every input this needs is tracked in the repository — if a file is
 * missing, that is a finding, not an excuse.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CONTRACTS_DIR = join(REPO_ROOT, "contracts");
const OIDC_README = join(CONTRACTS_DIR, "oidc", "v1", "README.md");
const OIDC_ROUTE_RS = join(
  REPO_ROOT,
  "crates",
  "identity-oidc",
  "src",
  "route.rs",
);

const EXPECTED_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The annotations every schema must carry, and why each one is required. */
const REQUIRED_ANNOTATIONS = [
  [
    "$id",
    "a schema with no $id has no identity, so a consumer cannot dedupe it",
  ],
  [
    "x-rust-type",
    "the Rust type it is derived from; without it nothing ties the shape to the code",
  ],
  [
    "x-serde-status",
    "whether anything actually produces this shape — the annotation that makes a contract a promise rather than a claim",
  ],
];

/** Every finding, collected before anything is printed so one run reports all of them. */
const findings = [];

/**
 * Record a finding.
 *
 * @param {string} file  Repo-relative path, so the message is clickable.
 * @param {string} found What was actually there.
 * @param {string} broke Which rule it breaks.
 * @param {string} fix   What to do about it.
 */
function finding(file, found, broke, fix) {
  findings.push({ file, found, broke, fix });
}

/**
 * Every `.json` file under `contracts/`, sorted for a stable report.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Repo-relative paths.
 */
function schemaFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...schemaFiles(full));
    } else if (entry.endsWith(".json")) {
      found.push(relative(REPO_ROOT, full));
    }
  }
  return found.sort();
}

/** Check 1–3: every schema parses, declares the right dialect, and is annotated. */
function checkSchemas() {
  const files = schemaFiles(CONTRACTS_DIR);
  if (files.length === 0) {
    finding(
      relative(REPO_ROOT, CONTRACTS_DIR),
      "no schema files found",
      "the contracts directory is empty",
      "If the contracts are being moved, move them; if this path is wrong, fix the path. An empty contracts/ means the gate is checking nothing and reporting success.",
    );
    return;
  }

  for (const rel of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
    } catch (error) {
      finding(
        rel,
        `does not parse as JSON: ${error.message}`,
        "a schema that is not valid JSON is not a schema",
        "Fix the JSON. This is usually a truncated file from a bad merge; check the diff rather than reformatting.",
      );
      continue;
    }

    if (parsed.$schema !== EXPECTED_DIALECT) {
      finding(
        rel,
        `declares $schema ${JSON.stringify(parsed.$schema ?? null)}`,
        `every schema declares ${EXPECTED_DIALECT}`,
        "A consumer validates against the dialect the file declares. Changing the dialect silently changes what `required` and `type` mean.",
      );
    }

    for (const [key, why] of REQUIRED_ANNOTATIONS) {
      if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
        finding(
          rel,
          `${key} is ${JSON.stringify(parsed[key] ?? null)}`,
          `every schema carries a non-empty ${key} — ${why}`,
          key === "x-serde-status"
            ? 'State what is true: "IMPLEMENTED as a shape" if the type exists, and say EMITTED only if a deployable really sends it.'
            : `Add a ${key}. It is not decoration — the check for the other schemas depends on it being a string.`,
        );
      }
    }
  }

  return files.length;
}

/**
 * The route paths `identity_oidc::route::Route` declares, read from the Rust
 * source rather than hard-coded here.
 *
 * Parsed from `path()`'s match arms because the Rust table is the single list
 * the Identity Worker dispatches from. Re-deriving it in JavaScript would make
 * this file a second source of truth that drifts on the first route added —
 * which is the exact failure this check exists to catch.
 *
 * @returns {Map<string, string>} path -> `Route` variant name.
 */
function rustRouteTable() {
  const source = readFileSync(OIDC_ROUTE_RS, "utf8");
  const arm = /Self::(\w+)\s*=>\s*"([^"]+)"/g;
  const table = new Map();
  for (const match of source.matchAll(arm)) {
    table.set(match[2], match[1]);
  }
  return table;
}

/**
 * The route rows the OIDC README's table declares.
 *
 * @returns {Map<string, {variant: string, status: string}>}
 */
function readmeRouteTable() {
  const readme = readFileSync(OIDC_README, "utf8");
  const row = /^\|\s*`(\/[^`]*)`\s*\|\s*`(\w+)`\s*\|\s*([^|]*?)\s*\|/gm;
  const table = new Map();
  for (const match of readme.matchAll(row)) {
    table.set(match[1], { variant: match[2], status: match[3] });
  }
  return table;
}

/**
 * Check 4: the README's route table and the Rust table agree.
 *
 * Both directions matter, and the second is the one a human writing docs
 * forgets: a route in Rust and missing from the README is a route the next
 * reader believes does not exist, which is the same defect as documenting one
 * that does not.
 */
function checkRouteTable() {
  const rust = rustRouteTable();
  const readme = readmeRouteTable();

  if (rust.size === 0) {
    finding(
      relative(REPO_ROOT, OIDC_ROUTE_RS),
      'no `Self::Variant => "/path"` arms found',
      "the route table is readable from the Rust source",
      "This check parses the match arms of `Route::path()`. If that function's shape changed, update this parser rather than deleting the check.",
    );
    return;
  }

  for (const [path, variant] of rust) {
    const documented = readme.get(path);
    if (!documented) {
      finding(
        relative(REPO_ROOT, OIDC_README),
        `no row for \`${path}\` (${variant})`,
        "every route in `Route` has a row — the Worker dispatches from Rust, the README is the human view of it",
        `Add the row, and state whether the route answers a real body or a 501. A route missing here reads as a route that does not exist.`,
      );
      continue;
    }
    if (documented.variant !== variant) {
      finding(
        relative(REPO_ROOT, OIDC_README),
        `\`${path}\` is documented as \`${documented.variant}\` but is \`${variant}\` in Rust`,
        "the README's variant column matches `Route::path()`",
        "One of the two is stale. The Rust table is the source of truth because the Worker dispatches from it.",
      );
    }
  }

  for (const [path, documented] of readme) {
    if (!rust.has(path)) {
      finding(
        relative(REPO_ROOT, OIDC_README),
        `documents \`${path}\` (\`${documented.variant}\`), which is not in \`Route\``,
        "every documented route exists in the Rust table",
        "Either the route was removed and the row is stale, or it was added in the README and never in the code. The first is a lie in the docs; the second is a promise nothing serves.",
      );
    }
  }
}

/** Run every check and report. */
const schemaCount = checkSchemas();
checkRouteTable();

const header = "ecoma-identity · contracts check";
process.stdout.write(
  `${header}\n${new Date(0).toISOString()} · draft 2020-12 · route table cross-check\n\n`,
);

if (findings.length === 0) {
  process.stdout.write(
    `PASSED  ${schemaCount ?? 0} schemas parse, declare the expected dialect, and are annotated. ` +
      `The OIDC route table agrees with identity_oidc::route::Route.\n`,
  );
  process.exit(0);
}

process.stdout.write(`FAILED  ${findings.length} findings\n\n`);
for (const f of findings) {
  process.stdout.write(`  ${f.file}\n`);
  process.stdout.write(`    found:  ${f.found}\n`);
  process.stdout.write(`    broke:  ${f.broke}\n`);
  process.stdout.write(`    fix:    ${f.fix}\n\n`);
}
process.exit(1);
