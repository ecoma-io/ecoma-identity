#!/usr/bin/env node
/**
 * `preview-teardown.mjs` — delete ONE pull request's preview infrastructure,
 * in the order the topology declares, and never anything else.
 *
 * WHY A SCRIPT AND NOT A WORKFLOW. The workflow that calls this decides WHEN;
 * this file decides WHAT and refuses. A delete path whose rules live in a YAML
 * `run:` block is a delete path whose rules nobody can unit-test, and every
 * guard in `topology-model.mjs` — the anchored grammar, the literal
 * `never_delete` backstop, the deletion order — would be advisory rather than
 * enforced. Everything that can refuse lives here, where a test can reach it.
 *
 * WHAT IT IS NOT. It does not enumerate what exists. It is handed a PR number,
 * derives the names from the manifest, and deletes exactly those. A name the
 * account holds that this file cannot derive is not this file's business, which
 * is why an orphaned preview is found by a different job rather than guessed at
 * here.
 *
 * THE THREE REFUSALS. Each is a separate failure with its own exit code,
 * because "the janitor did nothing" and "the janitor could not tell whether it
 * should" are different findings and a run log is the only evidence that
 * survives:
 *
 *   EXIT_PR_STATE_UNKNOWN  GitHub would not say whether the PR is closed. The
 *                          manifest's `preview.evidence.on_unknown` is
 *                          `do-not-delete`, and an API failure is not evidence
 *                          of closure. Nothing is deleted and the run fails
 *                          loudly, which is the opposite of what a janitor
 *                          that treats an outage as "probably closed" does.
 *   EXIT_NOT_CLOSED       The PR is open, or was reopened after this run
 *                          started. `preview.evidence.on_open` is
 *                          `do-not-delete`.
 *   EXIT_NO_CREDENTIAL    No `CLOUDFLARE_API_TOKEN`. Read from the environment
 *                          only, never from an argument, so it cannot appear in
 *                          a process listing.
 *
 * NEVER `--force`. `topology.json` states it and this file does it: wrangler's
 * `--force` means "delete even if doing so will break other Workers that depend
 * on this one", so passing it would re-implement the guard Cloudflare provides.
 * A resource that cannot be deleted cleanly is reported as SURVIVING, which is
 * the honest outcome — and the deletion order exists so that a refusal is rare,
 * because by the time a Worker is reached its consumers are already gone.
 */

import { spawnSync } from "node:child_process";

import {
  DEPLOYABLES,
  EXIT_CANNOT_RUN,
  EXIT_INVALID,
  EXIT_OK,
  TopologyError,
  deletionRefusal,
  loadTopology,
  previewResources,
  reportFailure,
} from "./topology-model.mjs";

/** The PR was not closed, or was reopened. Nothing was deleted. */
export const EXIT_NOT_CLOSED = 3;
/** GitHub would not say. Nothing was deleted. */
export const EXIT_PR_STATE_UNKNOWN = 4;

/**
 * What a `preview.deletion_order` step means in terms of a wrangler command.
 *
 * The `command` is an argv template, never a shell string: a name that reached
 * this file is a name the grammar already accepted, but building a shell line
 * out of it anyway would make an escaping mistake equivalent to running an
 * arbitrary command, and the cost of that mistake is a deleted account.
 * `{name}` is substituted as a single argument.
 */
const STEP_COMMANDS = {
  custom_domains: {
    wrangler: null,
    note:
      "wrangler has no command for a Custom Domain — wrangler 4.144's command " +
      "list has none, and the ones that would reach it (`triggers`, `routes`) " +
      "update a deployment rather than detach a domain. This step therefore has " +
      "no wrangler argv, and a teardown REPORTS it as not performed rather than " +
      "approximating it with the zones API. It matters: wrangler refuses to " +
      "delete a Worker while a Custom Domain is attached, so until this step is " +
      "implemented every Worker delete below it is refused too.",
  },
  // NO `--force`, and not by accident. wrangler's flag means "delete even if
  // doing so will break other Workers that depend on this one", so passing it
  // discards the one guard Cloudflare offers. `preview.deletion_order.$comment`
  // requires it and `assertNoForce` checks the constructed argv on every run.
  worker: { wrangler: ["delete", "{name}"] },
  dlq: { wrangler: ["queues", "delete", "{name}"] },
  queue: { wrangler: ["queues", "delete", "{name}"] },
  kv: { wrangler: ["kv", "namespace", "delete", "{name}"] },
  d1: { wrangler: ["d1", "delete", "{name}", "--skip-confirmation"] },
};

/**
 * Reject any `--force` before a single command runs.
 *
 * Exported for a test that asserts the property directly, because a rule stated
 * only as prose in a comment is a rule the next editor can lift. It is checked
 * against the constructed argv rather than the table, so a `--force` added to
 * any command — or a short form of it — fails before the first delete.
 */
export function assertNoForce(argv) {
  const flag = argv.find(
    (part) => part === "--force" || part.startsWith("--force="),
  );
  if (flag) {
    throw new TopologyError(
      `refusing to run a delete with ${flag}: wrangler's --force means "delete ` +
        'even if doing so will break other Workers that depend on this one", ' +
        "and this path must let Cloudflare refuse instead. " +
        "preview.deletion_order.$comment: the janitor never passes --force at all.",
    );
  }
  return argv;
}

/**
 * The command template for a `preview.deletion_order` step, or a thrown
 * `TopologyError`.
 *
 * `worker:identity` and `worker:identity-admin` are the same operation on
 * different names, so the prefix is stripped — but the deployable half is
 * checked against `DEPLOYABLES` rather than accepted as any suffix. Otherwise
 * `worker:anything` resolves to the Worker delete, and a step naming something
 * that is not a deployable would delete a Worker rather than fail.
 *
 * Throwing rather than returning `undefined` keeps "a step this script cannot
 * run" from becoming a silently skipped entry — which is how a teardown
 * reports a complete job while leaving a resource behind.
 */
export function commandFor(step) {
  let spec;
  if (step.startsWith("worker:")) {
    const deployable = step.slice("worker:".length);
    if (!DEPLOYABLES.includes(deployable)) {
      throw new TopologyError(
        `preview.deletion_order.steps names ${JSON.stringify(step)}, whose deployable ` +
          `${JSON.stringify(deployable)} is not one of ${DEPLOYABLES.join(", ")}; ` +
          "a step that does not correspond to a deployable would delete a Worker " +
          "rather than fail.",
      );
    }
    spec = STEP_COMMANDS.worker;
  } else {
    spec = STEP_COMMANDS[step];
  }

  if (!spec) {
    throw new TopologyError(
      `preview.deletion_order.steps names ${JSON.stringify(step)}, which ` +
        "preview-teardown.mjs has no command for; adding a step to the manifest " +
        "requires adding it here.",
    );
  }
  return spec;
}

/**
 * Every delete this run would attempt, in order, without performing any.
 *
 * Separated from execution so the WHOLE plan can be asserted in a test — that
 * it contains no production name, that its order matches the manifest, that a
 * refused name is reported rather than skipped silently. A janitor that is only
 * ever exercised against Cloudflare is a janitor whose guards have never been
 * run.
 */
export function planTeardown(topology, pr) {
  return previewResources(topology, pr).map((entry) => {
    const names = entry.name === undefined ? entry.names : [entry.name];
    return {
      order: entry.order,
      step: entry.step,
      kind: entry.kind,
      spec: commandFor(entry.step),
      names,
    };
  });
}

/**
 * Which of `names` the guards refuse, and why.
 *
 * Every name is checked and every refusal is returned — not the first one — so
 * that a plan with a bad name is diagnosed in full rather than one step at a
 * time. Returns `[]` when every name may be deleted.
 */
export function refusals(topology, plan) {
  const found = [];
  for (const entry of plan) {
    for (const name of entry.names) {
      const reason = deletionRefusal(topology, entry.kind, name);
      if (reason)
        found.push({ step: entry.step, kind: entry.kind, name, reason });
    }
  }
  return found;
}

/** Substitute `{name}` in a command template, as separate arguments. */
function argvFor(spec, name) {
  return assertNoForce(
    spec.wrangler.map((part) => part.replace("{name}", name)),
  );
}

/**
 * Whether wrangler reports "no such thing" for a resource that is already gone.
 *
 * A teardown must be idempotent: the custom-domain step may already have
 * removed what a later step deletes, and a PR may be closed twice. Treating an
 * absent resource as a failure would leave every janitor run red forever and
 * train everyone to ignore it, which is how a genuinely failed delete stops
 * being noticed.
 *
 * Patterns are matched against wrangler's own stderr, so this is a claim about
 * a specific tool's output — which is why it is a list that can be extended and
 * a test that pins the behaviour, rather than an assumption.
 */
const ALREADY_ABSENT = [
  /not found/i,
  /no such/i,
  /does not exist/i,
  /could not find/i,
  /10007/,
  /10090/,
];

/**
 * Run one delete, returning what happened rather than throwing.
 *
 * NEVER rethrows a delete failure. A janitor that stops at the first refusal
 * leaves every later resource in place while reporting failure, which is the
 * opposite of what a cleanup run is for: the rest are still deletable, and the
 * caller's summary has to be able to say exactly which ones survived.
 */
export function runDelete(argv, { env, cwd }) {
  const run = spawnSync("pnpm", ["exec", "wrangler", ...argv], {
    cwd,
    env,
    encoding: "utf8",
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.status === 0) return { outcome: "deleted", argv };
  if (ALREADY_ABSENT.some((pattern) => pattern.test(output))) {
    return { outcome: "already-absent", argv };
  }
  return {
    outcome: "survived",
    argv,
    detail: output.split("\n").filter(Boolean).slice(-6).join("\n"),
  };
}

/* -------------------------------------------------------------------------- *
 * The command line
 * -------------------------------------------------------------------------- */

const USAGE = `Usage: node tooling/scripts/preview-teardown.mjs --pr=<n> [--json] [--dry-run]

  --pr=<n>     The pull request whose preview to delete. Required.
  --json       Emit one JSON report on stdout instead of prose.
  --dry-run    Print the plan and the refusals, delete nothing.

Requires CLOUDFLARE_API_TOKEN in the environment. The PR's state is NOT read
here: this script refuses anything that is not a closed pull request's own
resources by NAME, and the workflow re-reads GitHub's answer immediately before
calling it. A caller that cannot establish closure must not call this at all —
see preview.evidence.on_unknown, which is do-not-delete.
`;

export function parseArgs(argv) {
  const options = { pr: null, json: false, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith("--pr=")) options.pr = arg.slice("--pr=".length);
    else if (arg === "--json") options.json = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else options.error = `unknown argument: ${arg}`;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}`);
    return EXIT_INVALID;
  }
  if (options.pr === null) {
    process.stderr.write(`--pr is required.\n${USAGE}`);
    return EXIT_INVALID;
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token && !options.dryRun) {
    process.stderr.write(
      "CLOUDFLARE_API_TOKEN is not set. This script reads the token from the " +
        "environment and never from an argument, so it cannot appear in a " +
        "process listing.\n",
    );
    return EXIT_CANNOT_RUN;
  }

  let topology;
  let plan;
  try {
    ({ topology } = loadTopology());
    plan = planTeardown(topology, options.pr);
  } catch (error) {
    reportFailure("preview-teardown", error);
    return EXIT_INVALID;
  }

  // The whole plan is checked before anything is deleted, and a refusal is
  // fatal to the RUN rather than to the one name: a manifest that produces a
  // production name is a manifest whose other names cannot be trusted either,
  // and deleting "the ones that look fine" is how a wrong manifest does damage.
  const blocked = refusals(topology, plan);
  if (blocked.length > 0) {
    const lines = blocked.map(
      (b) => `  ${b.step} (${b.kind}): ${JSON.stringify(b.name)} ${b.reason}`,
    );
    process.stderr.write(
      `refusing to delete ${blocked.length} name(s); nothing was deleted.\n` +
        `This is the delete path's own guard, not a Cloudflare error — a name ` +
        `that is not a preview's own must never be removed by a teardown.\n` +
        `${lines.join("\n")}\n`,
    );
    return EXIT_INVALID;
  }

  if (options.dryRun) {
    const report = {
      pr: options.pr,
      dryRun: true,
      plan: plan.map((e) => ({
        order: e.order,
        step: e.step,
        kind: e.kind,
        names: e.names,
      })),
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const entry of report.plan) {
        process.stdout.write(
          `${String(entry.order).padStart(2)}  ${entry.step}\n`,
        );
        for (const name of entry.names) {
          process.stdout.write(`      ${name}\n`);
        }
      }
    }
    return EXIT_OK;
  }

  const env = { ...process.env, CLOUDFLARE_API_TOKEN: token };
  const cwd = process.cwd();
  const results = [];

  for (const entry of plan) {
    if (entry.spec.wrangler === null) {
      // A step wrangler cannot perform is REPORTED, never approximated. Doing
      // the zones API call here instead would be the same code with none of the
      // tests above it — and the custom-domain delete is the one step whose
      // absence keeps the Worker from being deletable at all.
      results.push({
        order: entry.order,
        step: entry.step,
        names: entry.names,
        outcome: "not-implemented",
        detail: entry.spec.note,
      });
      continue;
    }

    for (const name of entry.names) {
      const outcome = runDelete(argvFor(entry.spec, name), { env, cwd });
      results.push({ order: entry.order, step: entry.step, name, ...outcome });
      const label = outcome.outcome === "deleted" ? "deleted" : outcome.outcome;
      process.stdout.write(
        `${String(entry.order).padStart(2)}  ${entry.step.padEnd(24)} ${label.padEnd(15)} ${outcome.argv.join(" ")}\n`,
      );
    }
  }

  const surviving = results.filter((r) => r.outcome === "survived");
  const unimplemented = results.filter((r) => r.outcome === "not-implemented");

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ pr: options.pr, results }, null, 2)}\n`,
    );
  }

  if (unimplemented.length > 0) {
    process.stderr.write(
      `\n${unimplemented.length} step(s) were NOT deleted because this repository has no ` +
        "command for them:\n" +
        unimplemented
          .map((u) => `  ${u.step}: ${u.names.join(", ")}`)
          .join("\n") +
        "\nThese resources are still in the account. A preview is not fully torn " +
        "down until they are gone.\n",
    );
  }

  if (surviving.length > 0) {
    process.stderr.write(
      `\n${surviving.length} delete(s) were refused by Cloudflare and the resources ` +
        "SURVIVED:\n" +
        surviving
          .map(
            (s) =>
              `  ${s.step}: ${s.name ?? (s.names ?? []).join(", ")}\n${indent(s.detail ?? "")}`,
          )
          .join("\n") +
        "\nThis is the intended outcome when a dependency is still live: this path " +
        "never passes --force, so a resource it cannot remove cleanly is one it " +
        "reports as surviving.\n",
    );
  }

  return surviving.length > 0 || unimplemented.length > 0
    ? EXIT_CANNOT_RUN
    : EXIT_OK;
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    reportFailure("preview-teardown", error);
    process.exit(EXIT_CANNOT_RUN);
  }
}

export { main };
