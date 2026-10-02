#!/usr/bin/env node
/**
 * `reconcile-infra.mjs` — discover Cloudflare resource IDs by name, and write
 * the ephemeral descriptor `render-wrangler-config.mjs --stage resolve`
 * consumes.
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
 * EXACT MATCH, OR FAILURE. Every lookup is by exact name. A resource that
 * cannot be found by exactly the name topology declares is an ERROR and this
 * script exits non-zero; it is never filled in with a guess, a prefix match, or
 * "the only one there is". The renderer refuses a descriptor carrying two
 * candidates for one name for the same reason — a duplicate is exactly the
 * condition a resolver must not guess about.
 *
 * CREATE OR FAIL. A missing resource is NOT created here. Provisioning is a
 * separate, deliberate act (`infra:provision`), because a deploy that silently
 * creates the database it is about to write to turns a typo in a name into an
 * empty production database rather than a failed run. This script reports what
 * is missing and stops.
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
  EXIT_CANNOT_RUN,
  EXIT_INVALID,
  EXIT_OK,
  TopologyError,
  loadTopology,
  reportFailure,
  resolveEnvironment,
} from "./topology-model.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * What a lookup costs and how to find the value in the response.
 *
 * `path` is the field to read inside one result element. A kind whose list
 * endpoint needs a POST body (`listD1`) carries `body` instead — D1 is the one
 * kind Cloudflare refuses to paginate with a query string.
 */
const LOOKUPS = {
  d1: {
    list: "/accounts/{account}/d1/database",
    body: { per_page: 100 },
    path: "uuid",
  },
  kv: { list: "/accounts/{account}/storage/kv/namespaces", path: "id" },
  queue: { list: "/accounts/{account}/queues", path: "queue_id" },
};

/**
 * Cloudflare's list endpoints are paginated and the default page size is not
 * every account's resource count. A name on page 2 must be FOUND, not reported
 * missing — a resolver that stops at the first page turns a working deploy into
 * a spurious "no such namespace".
 */
async function fetchAll(token, accountId, kind) {
  const spec = LOOKUPS[kind];
  const url = `${CLOUDFLARE_API}${spec.list.replace("{account}", accountId)}`;
  const results = [];
  let page = 1;
  for (;;) {
    // A kind whose pagination rides in a request BODY is a POST. Sending that
    // body on the default GET is refused outright —
    //
    //     Request with GET/HEAD method cannot have body.
    //
    // — so the method and the page parameter have to move together with the
    // body, and this loop keeps them in step.
    const usesBody = spec.body !== undefined;
    const url_ = usesBody ? url : `${url}?per_page=100&page=${page}`;
    const init = {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    if (usesBody) {
      init.method = "POST";
      init.body = JSON.stringify({ ...spec.body, page });
    }
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
    const batch = payload.result ?? [];
    results.push(...batch);
    const info = payload.result_info ?? {};
    if (!info.has_more) break;
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
 * The ONE resource with exactly this name, or a failure naming what was found.
 *
 * The duplicate check is the load-bearing part. Two resources answering to one
 * name is not a tie to break — it is evidence that the account does not match
 * the topology this repository believes it is deploying to, and guessing which
 * one is "the" `ecoma-identity-staging` is how a deploy writes production
 * traffic into somebody's scratch database.
 */
function exactMatch(kind, name, results, path_ = null) {
  const field = path_ ?? LOOKUPS[kind].path;
  const matches = results.filter((entry) => entry && entry.name === name);
  if (matches.length === 0) {
    const nearby = results
      .map((entry) => entry && entry.name)
      .filter((n) => typeof n === "string")
      .sort()
      .slice(0, 8);
    throw new TopologyError(
      `no ${kind} named ${JSON.stringify(name)} exists in this account. ${
        nearby.length > 0
          ? `Names present in this account include: ${nearby.join(", ")}.`
          : "The account returned no named resources of this kind at all."
      } Provision it deliberately (infra:provision) or correct the name in infra-topology/topology.json — this script does not guess and does not create.`,
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

function usage() {
  return [
    "Usage:",
    "  node tooling/scripts/reconcile-infra.mjs --environment <env> [--out <file>]",
    "",
    "  --environment <env>   production | staging | development (the environment",
    "                        whose resources this run discovers)",
    "  --out <file>          where to write the descriptor. Defaults to a file in",
    "                        the OS temp directory. NEVER commit it: it carries",
    "                        real Cloudflare resource ids (secrets-management.md).",
    "  --help                this text",
    "",
    "Requires CLOUDFLARE_API_TOKEN in the environment. The account id is read",
    "from infra-topology/topology.json and is not a secret and not a variable.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { environment: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--environment") {
      options.environment = argv[++index] ?? null;
    } else if (arg === "--out") {
      options.out = argv[++index] ?? null;
    } else {
      throw new TopologyError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

async function reconcile(environment, outPath) {
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
  const resolved = resolveEnvironment(topology, environment);

  // One list call per KIND, not per resource: two deployables sharing a queue
  // must not cost two paginated round trips, and one account-wide listing is
  // the only way "the name exists exactly once" is answerable at all.
  const buckets = {};
  for (const kind of ["d1", "kv", "queue"]) {
    buckets[kind] = await fetchAll(token, accountId, kind);
  }

  const resources = { d1: {}, kv: {}, queue: {} };
  const missing = [];

  for (const [deployable, resource] of Object.entries(resolved.resources)) {
    if (resource.d1) {
      const name = resource.d1.name;
      const id = exactMatch("d1", name, buckets.d1);
      resources.d1[name] = { id, deployable };
    }
    if (resource.kv) {
      const name = resource.kv.name;
      resources.kv[name] = {
        id: exactMatch("kv", name, buckets.kv),
        deployable,
      };
    }
    if (resource.queue) {
      for (const [slot, queueName] of [
        ["queue", resource.queue.name],
        ["dlq", resource.queue.dlq],
      ]) {
        if (!queueName) continue;
        const id = exactMatch("queue", queueName, buckets.queue);
        resources.queue[queueName] = { id, deployable, slot };
      }
    }
  }

  if (missing.length > 0) {
    throw new TopologyError(
      `resources named by topology do not exist in this account:\n  - ${missing.join("\n  - ")}`,
    );
  }

  const descriptor = {
    // Which account these ids came from, and when. Without this a descriptor is
    // a bag of ids with no account attached, and a descriptor from one account
    // silently used against another is the exact cross-account mistake the
    // topology's single-account decision exists to prevent.
    account: accountId,
    environment,
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
  if (options.environment === "preview") {
    process.stderr.write(
      "preview is not reconcilable by name: every preview resource is a function of the PR number and is created by the preview provisioner, not discovered from a long-lived account. Reconciling one would look for a name that has never existed.\n",
    );
    return EXIT_INVALID;
  }

  const outPath =
    options.out ??
    path.join(
      os.tmpdir(),
      `ecoma-identity-${options.environment}-descriptor.json`,
    );

  try {
    const { out, descriptor } = await reconcile(options.environment, outPath);
    const counts = Object.entries(descriptor.resources)
      .map(([kind, bucket]) => `${Object.keys(bucket).length} ${kind}`)
      .join(", ");
    process.stdout.write(
      `reconciled ${descriptor.environment} against account ${descriptor.account}: ${counts}\n` +
        `wrote descriptor ${out}\n` +
        `This file carries real Cloudflare resource ids. It belongs in a runner's temp directory, is never committed and is deleted with the job.\n`,
    );
    return EXIT_OK;
  } catch (error) {
    reportFailure("reconcile-infra", error);
    // A missing resource is a STOP, not a crash: the operator's next action is
    // to provision or to correct the name, and the message says which.
    return EXIT_CANNOT_RUN;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
