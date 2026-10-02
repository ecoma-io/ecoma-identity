#!/usr/bin/env node
/**
 * `resolve-infra-name.mjs` — print ONE already-resolved name, as TSV.
 *
 * WHY THIS FILE EXISTS. A workflow step used to read the D1 binding and the D1
 * database name straight out of `infra-topology/topology.json` with `jq`, and
 * that was wrong twice over, both times only on a preview:
 *
 *   1. It read `environments.preview.resources.identity.d1.name`, which is the
 *      TEMPLATE `ecoma-identity-pr-{pr}`. `wrangler` had just been handed a
 *      config naming `ecoma-identity-pr-33`, so the step would have applied
 *      migrations to a database that does not exist, under a name that has
 *      never existed, in a real account. The migration is remote and
 *      forward-only: getting the database wrong is not a no-op.
 *
 *   2. Its ownership walk (`to_entries[] | select(.value.d1.name == $n)`)
 *      crashed with `Cannot index array with string "d1"`, because
 *      `environments.preview.resources` carries a `$comment` that is an ARRAY,
 *      while the three fixed environments carry no such key. Exit 5. It never
 *      fired on staging or production, so the bug had been sitting in a
 *      required step of every deploy, waiting for the first preview.
 *
 * `jq` cannot fix (1) — substitution is `renderTemplate`'s job and there is
 * exactly one owner of it, which is the point of `topology-model.mjs`. And (2)
 * is not really a `jq` bug: re-deriving the manifest's shape in a shell is how
 * (1) happened at all. So this asks the model that already knows the answer.
 *
 * `{pr}` substitution is NOT optional here. Omitting `--pr` for a preview is a
 * usage error (64) rather than a template printed back, because
 * `ecoma-identity-pr-{pr}` is a real-looking name for a real account and the
 * whole reason this file exists is to stop anyone sending one.
 *
 * Usage:
 *   resolve-infra-name.mjs --environment <env> [--pr <n>] --ask <path> [--field <f>]
 *
 * `--ask` is a dotted path into the RESOLVED environment (what `wrangler` will
 * see), not into the manifest. `--field` picks one leaf out of an object.
 * Prints `value` or, for `--field omitted`, an empty string, so a shell
 * `read -r A B` sees a tab-separated line either way.
 *
 * No dependencies. Node ≥ 20.
 */

import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  loadTopology,
  resolveEnvironment,
  validatePrNumber,
} from "./topology-model.mjs";

const USAGE = `Usage: resolve-infra-name.mjs --environment <env> [--pr <n>] --ask <path> [--field <f>] [--explain]

  --environment <env>   production | staging | development | preview
  --pr <n>              required for preview, refused elsewhere
  --ask <path>          dotted path into the resolved environment, e.g.
                        resources.identity.d1.name
  --field <f>           one leaf of the value at --ask, e.g. name
  --explain             say on stderr why a value is absent; stdout stays the
                        VALUE channel either way, and stays empty on absence
  --help                this text

Prints one already-rendered value as TSV. Never prints a {pr} template.

STDOUT IS THE ONLY VALUE CHANNEL. An absent value prints nothing on stdout
and exits 0 — the explanation is on stderr, and only with --explain. The
caller in deploy-worker.yml captures with 2>&1 so that a resolver FAILURE
arrives as text instead of a bare exit code, which means an unconditional
stderr explanation becomes the captured VALUE. --explain exists so that the
decision is the caller's, not this tool's.`;

function parseArgs(argv) {
  const options = {
    environment: null,
    pr: null,
    ask: null,
    field: null,
    explain: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--environment":
        options.environment = argv[++i] ?? null;
        break;
      case "--pr":
        options.pr = argv[++i] ?? null;
        break;
      case "--ask":
        options.ask = argv[++i] ?? null;
        break;
      case "--field":
        options.field = argv[++i] ?? null;
        break;
      case "--explain":
        options.explain = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

/**
 * Walk a dotted path, and only over properties the manifest ITSELF declares.
 *
 * The `hasOwn` check is what keeps `--ask constructor` from answering. A plain
 * `cursor[key]` walks into `Object.prototype`, so `constructor` yielded
 * `Object`, `toString` yielded a function, and `JSON.stringify` of a function is
 * `undefined` — which the next line dereferenced, so the tool died with an
 * uncaught `TypeError`, exit 1, and a stack trace. The caller is a shell step
 * that wants a message and a non-zero exit; a crash is the one outcome it cannot
 * report usefully.
 *
 * An inherited key is not a value the manifest declares, so treating it as
 * absent is not a special case — it is the same answer as any other key the
 * topology does not carry.
 */
function readPath(source, path) {
  let cursor = source;
  for (const key of String(path).split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (!Object.hasOwn(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * The one string form every value is rendered through, at every depth.
 *
 * Exported so it can be tested directly. Every array the manifest declares holds
 * strings, so no lookup through the real topology reaches these functions with an
 * object in hand — the divergence this now prevents (the array branch printing
 * `${entry}` and producing `[object Object]` with exit 0) could only be reproduced
 * through a fixture, and a rule that cannot be exercised is a rule that comes back.
 */
export function renderValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // `JSON.stringify` returns `undefined` — not a string — for a function, for
  // `undefined`, and for a symbol. A caller that then did `text.includes(...)`
  // would die with an uncaught `TypeError`. Every such value is absent from this
  // manifest, and `readPath` no longer lets one reach here, but the two facts are
  // independent and the second is cheap: this function's contract is a string or
  // nothing.
  return typeof text === "string" ? text : null;
}

/**
 * A list, one element per line, every element through `renderValue`.
 *
 * A caller doing `for x in $(...)` needs one per line; a caller reading one name
 * with `$(...)` would otherwise get the whole JSON array, which is the opposite
 * of what it asked for.
 *
 * Returns `null` — not a partial list — if any element has no printable form.
 * See the loop for why.
 *
 * Exported for the same reason as `renderValue` — the array branch calls THIS,
 * so a test of this function is a test of the branch rather than of a helper
 * nothing uses.
 */
export function renderList(value) {
  const lines = [];
  for (const entry of value) {
    const text = renderValue(entry);
    // `null` means the element has no printable form. It is NOT dropped: a list
    // that silently loses an element is a shorter list, and a caller iterating it
    // would deploy against fewer resources than the manifest declares without
    // ever being told. The whole list is refused instead.
    if (text === null) return null;
    lines.push(`${text}\n`);
  }
  return lines.join("");
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (!options.environment) {
    process.stderr.write("--environment is required.\n\n" + USAGE);
    return EXIT_USAGE;
  }
  if (!options.ask) {
    process.stderr.write("--ask is required.\n\n" + USAGE);
    return EXIT_USAGE;
  }

  // Validate the PR number BEFORE resolving anything, so a mistyped one is a
  // usage error with the rule named, not a TopologyError about a missing field.
  if (options.environment === "preview" && options.pr === null) {
    process.stderr.write(
      "--environment preview requires --pr <number>. Every preview resource name is a function of the pull request number; without it the only name available is the template `ecoma-identity-pr-{pr}`, which is exactly what this tool exists not to print.\n",
    );
    return EXIT_USAGE;
  }
  if (options.environment !== "preview" && options.pr !== null) {
    process.stderr.write(
      `--pr is meaningless in environment ${JSON.stringify(options.environment)}: that environment's names are fixed. --pr applies to preview only.\n`,
    );
    return EXIT_USAGE;
  }

  let topology;
  try {
    topology = loadTopology().topology;
    if (options.pr !== null) validatePrNumber(topology, Number(options.pr));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT_USAGE;
  }

  let resolved;
  try {
    resolved = resolveEnvironment(topology, options.environment, {
      pr: options.pr === null ? undefined : Number(options.pr),
    });
  } catch (error) {
    // Everything `resolveEnvironment` rejects here was already checked above
    // (preview needs --pr, --pr is preview-only, the number is in range), so
    // reaching here means the manifest itself is not the shape the model
    // expects. Still a usage error rather than a crash: the caller is a shell
    // step that wants a message and a non-zero exit, not a stack trace.
    process.stderr.write(`${error.message}\n`);
    return EXIT_USAGE;
  }

  const found = readPath(resolved, options.ask);
  const value =
    options.field !== null && found && typeof found === "object"
      ? found[options.field]
      : found;

  if (value === undefined) {
    // Silent by DEFAULT, which is the point of --explain. The documented
    // contract is that an absent path prints an empty string, and a caller
    // that captures `2>&1` — deploy-worker.yml's `infra_name` does, so that a
    // resolver FAILURE arrives as text rather than as a bare exit code — would
    // otherwise capture this prose and use it as `database_name`.
    //
    // Masked today only by luck: `bindings.<deployable>.d1` is `null` rather
    // than undefined for every deployable that binds no database, so the
    // `-z "$D1_BINDING"` guard fires before this value is ever used. A
    // deployable declaring a `d1` slot with no matching resource entry is the
    // case that turns the mask into a real bug, and nothing else in the tree
    // catches it.
    if (options.explain) {
      process.stderr.write(
        `${options.ask}${options.field ? `.${options.field}` : ""} is not declared for ${options.environment}${options.environment === "preview" ? ` (pr ${options.pr})` : ""}. An absent value and an empty one are the same answer here: this deployable declares no such resource in this environment.\n`,
      );
    }
    return EXIT_OK;
  }
  if (value === null) {
    process.stdout.write("\n");
    return EXIT_OK;
  }

  const text = renderValue(value);
  // No printable form, and not absent either — a value the manifest carries that
  // cannot be rendered. A stack trace would be the one outcome a shell step cannot
  // report, so this is a message and a non-zero exit.
  if (text === null) {
    process.stderr.write(
      `${options.ask} names a ${typeof value}, which has no printable form. Refusing to print it rather than guessing at one.\n`,
    );
    return EXIT_INVALID;
  }
  // The one assertion this tool exists to make structural. If a template ever
  // reaches this point, something upstream stopped substituting and a real
  // Cloudflare call would be made against a name that has never existed. Checked
  // on the rendered text, so it also holds for an element inside an array.
  if (text.includes("{pr}")) {
    process.stderr.write(
      `refusing to print ${JSON.stringify(text)}: an unresolved {pr} template reached the end of resolution. This is a bug in the model, not a value to deploy.\n`,
    );
    return EXIT_USAGE;
  }

  // An array prints one element per line. An EMPTY array is an error rather than
  // silence: every path that iterates a list would otherwise do nothing at all
  // and report success.
  //
  // Every element goes through the SAME `renderValue` the scalar branch uses, via
  // `renderList`. `${entry}` on an object prints `[object Object]` and exits 0 — a
  // silent wrong answer, which is the whole failure mode this tool exists to
  // remove. Every array reachable today is a string array, so this is latent; the
  // divergence between the two branches is what makes it worth closing.
  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stderr.write(
        `${options.ask} resolved to an empty list for ${options.environment}. Something that iterates it would silently do nothing, so this is reported rather than printed as nothing.\n`,
      );
      return EXIT_INVALID;
    }
    const list = renderList(value);
    // One element of the list has no printable form. The whole list is refused
    // rather than shortened, because a silently shorter list is a caller
    // deploying against fewer resources than the manifest declares.
    if (list === null) {
      process.stderr.write(
        `${options.ask} resolved to a list for ${options.environment} with at least one element that has no printable form. The whole list is refused rather than shortened, because a shorter list is a caller deploying against fewer resources than this manifest declares.\n`,
      );
      return EXIT_INVALID;
    }
    process.stdout.write(list);
    return EXIT_OK;
  }

  process.stdout.write(`${renderValue(value)}\n`);
  return EXIT_OK;
}

// Entrypoint check, the idiom `validate-topology.mjs` and `reconcile-infra.mjs`
// already use. Without it this file cannot be imported at all: importing it runs
// `main()` against the importing process's argv, so a test file that imported
// `renderValue` set `process.exitCode` to 64 and the whole suite failed at the
// FILE level with every individual test passing — which is a confusing way to
// learn that a module has no entrypoint guard.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
