#!/usr/bin/env node
/**
 * `reconcile-infra.mjs` — ENSURE the Cloudflare resources the topology names,
 * and write the ephemeral descriptor `render-wrangler-config.mjs --stage
 * resolve` consumes.
 *
 * WHY THIS EXISTS. Wrangler needs a D1 `database_id` and a KV namespace `id`,
 * and it will not look either one up: a config must name the ID. Topology names
 * the DATABASE (`ecoma-identity-staging`) and deliberately carries no ID — see
 * its `$comment`: "Cloudflare RESOURCE IDs are absent — and so is any way of
 * naming one." So between a topology that knows the name and a config that
 * needs the ID, something has to ask Cloudflare. This is that something.
 *
 * WHY IT IS NOT A SECOND SOURCE OF TRUTH. The descriptor is written to a path
 * the caller chooses, which is a runner's temp directory, and nothing writes it
 * to the repository. Every ID here was rediscovered from Cloudflare by exact
 * name on this run. The consequence that matters: replacing a D1 database is a
 * no-op for this repository, because the next run asks again and gets the new
 * one. That is the property `docs/security/secrets-management.md` buys with
 * "a second copy is a second thing to be wrong" — and the reason the twelve
 * tracked configs that used to carry literal IDs are gone.
 *
 * ENSURE, NOT DISCOVER. A name topology declares that does not exist in the
 * account is CREATED, here, by this run. This is a reversal of a deliberate
 * earlier decision and ADR-0021 records why. The short form: this repository's
 * account starts empty, and a deploy that refuses to run against an empty
 * account is a deploy that never runs at all — the failure this repository
 * spent a month having, with 20 red staging runs, because the reconciler
 * enforced a purity that had no beneficiary. The cost is real and is stated in
 * the ADR: a typo in a topology name now provisions a resource instead of
 * failing a run. That is a cost paid on a typo, on a name that is read from one
 * tracked file, in a review that reads that file. The alternative is paid on
 * every deploy, forever, by nobody being able to ship.
 *
 * WHAT ENSURING IS NOT. This script never DELETES. A name that resolves to two
 * resources is an error, not a tie to break — two resources answering to one name
 * is evidence the account is not the account this topology believes it is, and
 * picking one is how a deploy writes production traffic into somebody's scratch
 * database. Nothing here repairs, renames, adopts or deletes anything. Create is
 * the whole of the write surface.
 *
 * WHY THE CREATED ID IS NOT TRUSTED. Cloudflare returns the new resource inline
 * on every create, and reading that response would be one call cheaper. It is
 * not read: the create response is what Cloudflare SAYS it made, while a re-list
 * is what the account CONTAINS. Both are then funnelled through the same
 * `exactMatch` duplicate check, so a create that somehow produced a second
 * resource with the same name fails exactly as a pre-existing duplicate does.
 * One rule for "is this name safe to bind", on both paths.
 *
 * No dependencies. Node ≥ 20. Reads the token from the environment
 * (`CLOUDFLARE_API_TOKEN`) and never from an argument, so it never appears in a
 * process listing or a shell history.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENVIRONMENTS,
  EXIT_CANNOT_RUN,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  TopologyError,
  loadTopology,
  reportFailure,
  resolveEnvironment,
  validatePrNumber,
} from "./topology-model.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * What a lookup costs, how to create what is absent, and how to find the value
 * in either response.
 *
 * `path` is the field carrying the resource id inside one result element, and
 * `name` is the field carrying the human name — which is NOT the same field for
 * every kind, and is not `title` for KV. `create.nameField` is the field the
 * CREATE body must set, which is a third naming again: a KV namespace is
 * `title` in a listing and `title` in a create, but a queue is `queue_name` in
 * both and a D1 database is `name` in both. They agree today; the table records
 * them separately so that a day they diverge is a one-line change rather than a
 * deployment that provisions nothing under a name that looks right.
 *
 * EVERY lookup here is a GET with pagination in the QUERY STRING. This is not a
 * style preference. `/accounts/{account}/d1/database` serves two methods on one
 * path, and they are not interchangeable:
 *
 *   GET  → `d1-list-databases`   (this is what this script wants)
 *   POST → `d1-create-database`  (body: required ['name'])
 *
 * So a D1 lookup sent as a POST does not return a validation error about
 * pagination. It returns
 *
 *     HTTP 400 {"code":7400,"message":"Invalid property: name => Required"}
 *
 * because `{"per_page":100,"page":1}` is being read as the body of a request to
 * CREATE a database, and it has no name to create one with. Nothing is created
 * — Cloudflare refuses first — but the message names a property this script
 * never asked about, and the failure looks like a malformed request rather than
 * a wrong verb. If you are changing this table, the verb is load-bearing.
 *
 * The three creates are synchronous: each returns HTTP 200 with the new resource
 * in `result`, carrying the id in the same field a listing element carries it in.
 * There is no 202 and no `status: provisioning` to poll.
 *
 * `per_page` is bounded at 10 000 by Cloudflare; 100 is comfortably legal and
 * keeps the pages small enough that a large account does not arrive all at once.
 */
const LOOKUPS = {
  d1: {
    list: "/accounts/{account}/d1/database",
    path: "uuid",
    name: "name",
    create: { nameField: "name" },
  },
  kv: {
    list: "/accounts/{account}/storage/kv/namespaces",
    path: "id",
    name: "title",
    create: { nameField: "title" },
  },
  queue: {
    list: "/accounts/{account}/queues",
    path: "queue_id",
    name: "queue_name",
    create: { nameField: "queue_name" },
  },
};

const PER_PAGE = 100;

/**
 * Cloudflare's list endpoints are paginated and the default page size is not
 * every account's resource count. A name on page 2 must be FOUND, not reported
 * missing — a resolver that stops at the first page turns a working deploy into
 * a spurious "no such namespace".
 *
 * Every response is `{ success, errors, messages, result, result_info }` and
 * `result` is a FLAT ARRAY for all three kinds — there is no
 * `result.databases` wrapper to unwrap. `result_info.total_count` is what tells
 * the loop there is another page, rather than guessing from a short page (which
 * would silently drop the last page of an account whose count is an exact
 * multiple of `per_page`).
 */
async function fetchAll(token, accountId, kind) {
  const spec = LOOKUPS[kind];
  const url = `${CLOUDFLARE_API}${spec.list.replace("{account}", accountId)}`;
  const results = [];
  let page = 1;
  for (;;) {
    const url_ = `${url}?page=${page}&per_page=${PER_PAGE}`;
    const init = {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    const response = await fetch(url_, init);
    if (!response.ok) {
      const detail = await response.text();
      throw new TopologyError(
        `Cloudflare refused to list ${kind} for this account: HTTP ${response.status} ${response.statusText}. ${detail.slice(0, 400)}`,
      );
    }
    const payload = await response.json();
    if (payload.success !== true) {
      throw new TopologyError(
        `Cloudflare returned success=false while listing ${kind}: ${JSON.stringify(payload.errors ?? [])}`,
      );
    }
    const batch = Array.isArray(payload.result) ? payload.result : [];
    results.push(...batch);
    const info = payload.result_info ?? {};
    // `result_info` is `{ count, page, per_page, total_count }` — it has NO
    // `has_more` field. Reading one that is not there yields `undefined`, which
    // is falsy, which ends the loop on page 1 of an account with more than one
    // page — and the names on page 2 are then reported as "does not exist".
    // That is the worst shape this script has: a wrong answer that reads as a
    // correct one. Compare against the count Cloudflare actually reports.
    const total = Number(info.total_count);
    if (!Number.isFinite(total)) {
      throw new TopologyError(
        `listing ${kind} returned no result_info.total_count, so this script cannot tell whether it has seen every page. Refusing to resolve names from a partial listing.`,
      );
    }
    if (results.length >= total) break;
    if (batch.length === 0) {
      throw new TopologyError(
        `listing ${kind} reported ${total} resources but returned an empty page at page ${page}; the listing is inconsistent and this script will not resolve names from it.`,
      );
    }
    page += 1;
    if (page > 100) {
      throw new TopologyError(
        `paginating ${kind} exceeded 100 pages; refusing to guess which name was missed.`,
      );
    }
  }
  return results;
}

/**
 * Every listing element whose NAME is exactly `name`.
 *
 * Returns the matches rather than an id, and throws nothing. Absence is the
 * normal case before an ensure and the error case after it, and the two need
 * opposite handling — one creates, the other fails — so the decision belongs to
 * the caller rather than being buried here.
 *
 * The NAME lives in a different field per kind — `title` for a KV namespace,
 * `queue_name` for a queue — so matching on `entry.name` silently finds nothing
 * for those two and every ensure would provision a second copy of a namespace
 * that already exists. The fallback exists only so a kind added to LOOKUPS
 * without a `name` yields an empty match list rather than a TypeError.
 */
function findExact(kind, name, results) {
  const spec = LOOKUPS[kind];
  const nameField = spec.name ?? "name";
  return results.filter((entry) => entry?.[nameField] === name);
}

/**
 * The ONE resource with exactly this name, or a failure naming what was found.
 *
 * The duplicate check is the load-bearing part. Two resources answering to one
 * name is not a tie to break — it is evidence that the account does not match
 * the topology this repository believes it is deploying to, and guessing which
 * one is "the" `ecoma-identity-staging` is how a deploy writes production
 * traffic into somebody's scratch database.
 */
function exactMatch(kind, name, results, path_ = null) {
  const spec = LOOKUPS[kind];
  const field = path_ ?? spec.path;
  const matches = findExact(kind, name, results);
  if (matches.length === 0) {
    const nearby = results
      .map((entry) => entry?.[spec.name ?? "name"])
      .filter((n) => typeof n === "string")
      .sort()
      .slice(0, 8);
    throw new TopologyError(
      `no ${kind} named ${JSON.stringify(name)} exists in this account, and this run did not create it either. ${
        nearby.length > 0
          ? `Names present in this account include: ${nearby.join(", ")}.`
          : "The account returned no named resources of this kind at all."
      } A create that reported success and left nothing findable is a Cloudflare-side inconsistency, not something to retry silently: check the Cloudflare dashboard, then correct the name in infra-topology/topology.json if it is wrong.`,
    );
  }
  if (matches.length > 1) {
    throw new TopologyError(
      `${matches.length} ${kind} resources are named ${JSON.stringify(name)}. Refusing to choose between them: a duplicate name means the account does not match the topology, and binding the wrong one sends this deploy's traffic and writes somewhere nobody intended. Resolve the duplicate in the Cloudflare dashboard first.`,
    );
  }
  const id = matches[0][field];
  if (typeof id !== "string" || id.length === 0) {
    throw new TopologyError(
      `the ${kind} named ${JSON.stringify(name)} carries no ${field}; refusing to emit an empty id, which Cloudflare accepts and which points at nothing.`,
    );
  }
  return id;
}

/**
 * Create one resource, and return the listing element Cloudflare now reports for
 * that name — not the id from the create response.
 *
 * The re-list is not redundant with the create. The create response is what
 * Cloudflare says it made; the re-list is what the account contains, and the
 * difference between those two is exactly the difference between a deploy that
 * works and one that binds an id the account never had. It also closes the race
 * this design cannot otherwise avoid: there is no idempotency key on any of
 * these endpoints, so two concurrent runs both creating the same name would each
 * believe they won. Re-listing and refusing a duplicate turns that race into a
 * failed run with a legible message instead of two databases.
 */
async function createResource(token, accountId, kind, name) {
  const spec = LOOKUPS[kind];
  const url = `${CLOUDFLARE_API}${spec.list.replace("{account}", accountId)}`;
  const body = JSON.stringify({ [spec.create.nameField]: name });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new TopologyError(
      `Cloudflare refused to create ${kind} ${JSON.stringify(name)}: HTTP ${response.status} ${response.statusText}. ${detail.slice(0, 400)}`,
    );
  }
  const payload = await response.json();
  if (payload.success !== true) {
    throw new TopologyError(
      `Cloudflare returned success=false while creating ${kind} ${JSON.stringify(name)}: ${JSON.stringify(payload.errors ?? [])}`,
    );
  }
  // Re-list rather than reading `payload.result`. See this function's comment.
  const after = await fetchAll(token, accountId, kind);
  const matches = findExact(kind, name, after);
  if (matches.length === 0) {
    throw new TopologyError(
      `Cloudflare reported creating ${kind} ${JSON.stringify(name)} and a fresh listing does not contain it. The create response carried ${JSON.stringify(payload.result ?? null)}. Refusing to bind an id this run cannot see in the account.`,
    );
  }
  return matches[0];
}

function usage() {
  return [
    "Usage:",
    "  node tooling/scripts/reconcile-infra.mjs --environment <env> [options]",
    "",
    "  --environment <env>   production | staging | development | preview (the",
    "                        environment whose resources this run ensures)",
    "  --pr <number>         REQUIRED for preview, refused elsewhere. Every",
    "                        preview resource name is a function of the pull",
    "                        request number, so reconciling a preview without",
    "                        it would ensure a resource called `identity-pr-{pr}`.",
    "                        Validated against preview.pr_number and capped by",
    "                        preview.max_pr_number.",
    "  --deployable <name>   restrict to one deployable's resources. A deployable",
    "                        that declares none is answered without a single API",
    "                        call. Defaults to every deployable in the environment.",
    "  --out <file>          where to write the descriptor. Defaults to a file in",
    "                        the OS temp directory. NEVER commit it: it carries",
    "                        real Cloudflare resource ids (secrets-management.md).",
    "  --help                this text",
    "",
    "ENSURES what the topology declares: a name this account does not have is",
    "CREATED, then rediscovered by exact name. This script never deletes, never",
    "adopts a duplicate, and never guesses a name.",
    "",
    "Requires CLOUDFLARE_API_TOKEN in the environment. The account id is read",
    "from infra-topology/topology.json and is not a secret and not a variable.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { environment: null, deployable: null, out: null, pr: null };

  /**
   * Read the value that follows a flag, refusing to swallow the next flag.
   *
   * `argv[++index]` alone treats `--pr --out /tmp/x.json` as a PR NUMBER of
   * `--out`, and then reports `/tmp/x.json` as an unknown argument — so the
   * operator is told about the wrong problem, and the real one, a mistyped
   * command line, is the one they have to notice themselves. A trailing `--pr`
   * collapses to `null` and reports "requires --pr", which reads as "you forgot
   * the flag" rather than "you wrote it with nothing after it".
   *
   * `--pr` is where this matters most, because its value is what every preview
   * resource name is derived from — a number that is not a number should be
   * refused here rather than carried one layer deeper. The helper is shared by
   * all four flags because the mistake is the parser's, not `--pr`'s.
   */
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new TopologyError(
        `${flag} requires a value. ${next === undefined ? `It is the last argument on the command line.` : `${JSON.stringify(next)} is the next flag, not a value.`}`,
      );
    }
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--environment") {
      options.environment = value("--environment", index);
      index += 1;
    } else if (arg === "--deployable") {
      options.deployable = value("--deployable", index);
      index += 1;
    } else if (arg === "--out") {
      options.out = value("--out", index);
      index += 1;
    } else if (arg === "--pr") {
      options.pr = value("--pr", index);
      index += 1;
    } else {
      throw new TopologyError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

export async function reconcile(environment, outPath, { deployable, pr } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new TopologyError(
      "CLOUDFLARE_API_TOKEN is not set. This script reads the token from the environment and never from an argument, so it cannot appear in a process listing.",
    );
  }
  const { file: topologyFile, topology } = loadTopology(REPO_ROOT);
  const accountId = topology.account?.id;
  if (typeof accountId !== "string" || accountId === "") {
    throw new TopologyError(
      `${topologyFile} declares no usable account.id. Every wrangler command needs it, and there is nowhere else to read it from.`,
    );
  }
  const resolved = resolveEnvironment(topology, environment, { pr });

  const all = resolved.resources;
  if (deployable !== undefined && deployable !== null) {
    if (!Object.hasOwn(all, deployable)) {
      throw new TopologyError(
        `no deployable named ${JSON.stringify(deployable)} in topology environment ${JSON.stringify(environment)}; expected one of ${Object.keys(all).join(", ")}.`,
      );
    }
  }
  const wanted = Object.entries(all).filter(
    ([name]) =>
      deployable === undefined || deployable === null || name === deployable,
  );

  // ------------------------------------------------------------------------
  // WHAT THIS DEPLOYABLE ASKS FOR, before any network call.
  //
  // `identity-admin` and `home-web` declare no resources at all, and must not be
  // charged three paginated listings to discover that. The four staging jobs
  // run in parallel and each asks for its own deployable, so this filter is the
  // difference between one D1 listing and three.
  // ------------------------------------------------------------------------
  const asked = [];
  for (const [name, resource] of wanted) {
    if (resource.d1)
      asked.push({ kind: "d1", name: resource.d1.name, deployable: name });
    if (resource.kv)
      asked.push({ kind: "kv", name: resource.kv.name, deployable: name });
    if (resource.queue) {
      for (const [slot, queueName] of [
        ["queue", resource.queue.name],
        ["dlq", resource.queue.dlq],
      ]) {
        if (queueName)
          asked.push({
            kind: "queue",
            name: queueName,
            deployable: name,
            slot,
          });
      }
    }
  }

  if (asked.length === 0) {
    process.stdout.write(
      `reconcile ${environment}: ${deployable ?? "every deployable"} declares no D1, KV namespace or queue. Nothing to look up and nothing to create.\n`,
    );
  }

  // One list call per KIND, not per resource: two deployables sharing a queue
  // must not cost two paginated round trips, and one account-wide listing is
  // the only way "the name exists exactly once" is answerable at all.
  const kinds = [...new Set(asked.map((item) => item.kind))];
  const buckets = {};
  for (const kind of kinds) {
    buckets[kind] = await fetchAll(token, accountId, kind);
  }

  // ------------------------------------------------------------------------
  // PHASE 1 — decide the whole write set before writing any of it.
  //
  // Creating inside the resolve loop would leave the account half-provisioned
  // when the fifth create fails: three databases and two queues, none of them
  // referenced by anything, on an account whose next run would find them all.
  // Collecting first means a failure before the first create leaves nothing, and
  // a failure after it leaves a set that is at least complete up to the one that
  // failed — which the next run reconciles without creating anything.
  // ------------------------------------------------------------------------
  const absent = asked.filter(
    (item) => findExact(item.kind, item.name, buckets[item.kind]).length === 0,
  );

  if (absent.length > 0) {
    // A notice, not a warning. This is the designed behaviour of a deploy onto
    // an account that has never been deployed to, and the run summary should say
    // so plainly rather than leaving an operator to wonder what changed.
    process.stdout.write(
      `ensuring ${absent.length} resource(s) that topology declares and this account does not have:\n` +
        absent
          .map(
            (i) =>
              `  - ${i.kind} ${JSON.stringify(i.name)} (for ${i.deployable})`,
          )
          .join("\n") +
        `\n\n`,
    );
  }

  // ------------------------------------------------------------------------
  // PHASE 2 — create, one at a time, each re-listed by `createResource`.
  // ------------------------------------------------------------------------
  for (const item of absent) {
    await createResource(token, accountId, item.kind, item.name);
    // Adopt the freshly listed element so PHASE 3's duplicate check sees the
    // real state of the account rather than the pre-create listing.
    buckets[item.kind] = await fetchAll(token, accountId, item.kind);
  }

  // ------------------------------------------------------------------------
  // PHASE 3 — resolve every name through the one rule, created or not.
  // ------------------------------------------------------------------------
  const resources = { d1: {}, kv: {}, queue: {} };
  for (const item of asked) {
    const id = exactMatch(item.kind, item.name, buckets[item.kind]);
    resources[item.kind][item.name] = {
      id,
      deployable: item.deployable,
      ...(item.slot ? { slot: item.slot } : {}),
    };
  }

  const descriptor = {
    // Which account these ids came from, and when. Without this a descriptor is
    // a bag of ids with no account attached, and a descriptor from one account
    // silently used against another is the exact cross-account mistake the
    // topology's single-account decision exists to prevent.
    account: accountId,
    environment,
    // The pull request these ids belong to, for the same reason and with more
    // force in the preview lane: every name below is a FUNCTION of this number,
    // so a preview descriptor without it is a list of ids that cannot be traced
    // back to the review that asked for them. `null` on every fixed lane,
    // which is what makes `descriptor.pr !== null` an honest test for "is this
    // a preview descriptor" rather than a guess.
    //
    // `resolved.pr`, not the raw `pr` argument. `resolveEnvironment` returns the
    // output of `validatePrNumber` on the preview lane and `null` everywhere
    // else, so this field is a NUMBER for every caller. The raw argument is a
    // string from `main()` and a number from any programmatic caller, which made
    // the descriptor's own type depend on how it was invoked — and let an
    // unvalidated value reach the one field whose entire purpose is to identify
    // the pull request every name above derives from.
    pr: resolved.pr ?? null,
    reconciled_at: new Date().toISOString(),
    resources,
  };

  const resolvedOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { out: resolvedOut, descriptor };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    return EXIT_INVALID;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }
  if (!options.environment) {
    process.stderr.write("--environment is required.\n\n" + usage());
    return EXIT_INVALID;
  }
  // Validated against the model's own list, BEFORE the preview/fixed checks
  // below. Those two tests ask "is this the preview lane?" and "is this a fixed
  // lane?", and an unrecognised environment answers "no" to both — so a typo
  // reached them as an unknown FIXED environment and was reported as
  // "--pr is meaningless in environment \"preveiw\"", advice about a rule that
  // does not apply to the name the operator typed. The misspelling itself went
  // unreported, which is the one thing the operator needed.
  //
  // `resolveEnvironment` would have caught it, two checks and a token read
  // later, as `EXIT_CANNOT_RUN` — a broken configuration reported to an operator
  // as something that could not be done.
  if (!ENVIRONMENTS.includes(options.environment)) {
    process.stderr.write(
      `unknown environment ${JSON.stringify(options.environment)}; expected one of ${ENVIRONMENTS.join(", ")}.\n\n` +
        usage(),
    );
    return EXIT_USAGE;
  }
  if (options.environment === "preview" && options.pr === null) {
    process.stderr.write(
      "--environment preview requires --pr <number>. Every preview resource name is a function of the pull request number, and reconciling one without that number would look for a name that has never existed — `identity-pr-{pr}` is a real-looking name for a real account, which is exactly the wrong thing to send.\n",
    );
    return EXIT_USAGE;
  }
  if (options.environment !== "preview" && options.pr !== null) {
    process.stderr.write(
      `--pr is meaningless in environment ${JSON.stringify(options.environment)}: that environment's resource names are fixed and must not become a function of a pull request. --pr applies to preview only.\n`,
    );
    return EXIT_USAGE;
  }
  // The PR number is validated HERE, before the token is read and before any
  // network call, so a mistyped number is answered as a usage error with a
  // message naming the rule it broke. Deferring it to `resolveEnvironment`
  // would report it through `reportFailure` as EXIT_CANNOT_RUN, which says "I
  // could not run" about something the operator typed.
  //
  // `loadTopology` is deliberately OUTSIDE the try. A missing or malformed
  // `infra-topology/topology.json` is a broken configuration, not an argument
  // mistake, and catching it here reported it as `EXIT_USAGE` — the exit code
  // for "you typed it wrong" — with no `::error::` annotation and no stack. That
  // is the one failure in this file that is not the operator's typing, given the
  // same treatment as the ones that are, and it never reached `reportFailure`.
  //
  // It also duplicated the read `reconcile()` performs moments below, so the two
  // were not a single snapshot of one file.
  const topology = loadTopology(REPO_ROOT).topology;
  if (options.pr !== null) {
    try {
      validatePrNumber(topology, options.pr);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
  }

  const outPath =
    options.out ??
    path.join(
      os.tmpdir(),
      `ecoma-identity-${options.environment}-descriptor.json`,
    );

  try {
    const { out, descriptor } = await reconcile(options.environment, outPath, {
      deployable: options.deployable,
      pr: options.pr,
    });
    const counts = Object.entries(descriptor.resources)
      .filter(([, bucket]) => Object.keys(bucket).length > 0)
      .map(([kind, bucket]) => `${Object.keys(bucket).length} ${kind}`)
      .join(", ");
    process.stdout.write(
      `ensured ${descriptor.environment}` +
        `${options.deployable ? ` for ${options.deployable}` : ""}` +
        ` against account ${descriptor.account}${counts ? `: ${counts}` : " (no resources declared)"}\n` +
        `wrote descriptor ${out}\n` +
        `This file carries real Cloudflare resource ids. It belongs in a runner's temp directory, is never committed and is deleted with the job.\n`,
    );
    return EXIT_OK;
  } catch (error) {
    reportFailure("reconcile-infra", error);
    // A STOP, not a crash: the operator's next action is in the message, which
    // says whether the name is wrong or the account is not the one expected.
    return EXIT_CANNOT_RUN;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
