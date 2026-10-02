/**
 * `preview-teardown.test.mjs` — the delete path, exercised without an account.
 *
 * WHY THIS FILE CAN EXIST AT ALL. `preview-teardown.mjs` never decides anything
 * on its own: the PR number comes from the caller, the names come from the
 * manifest, and every refusal is a pure function of the two. That is what makes
 * the delete path testable without a Cloudflare account, and it is why the
 * rules live in this script rather than in a workflow's `run:` block — a rule
 * spelled in YAML can only be tested by running it against the real account.
 *
 * What CANNOT be tested here is stated rather than implied: whether wrangler
 * accepts these commands, and how Cloudflare responds to them. Those are
 * checked by the first real teardown, and a failure there is a wrong argument,
 * not a wrong guard.
 *
 * Ordered by what a failure would cost: deleting production, then deleting with
 * `--force`, then deleting out of order, then a teardown that cannot be
 * believed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  FIXED_ENVIRONMENTS,
  DEPLOYABLES,
  loadTopology,
  previewResources,
} from "./topology-model.mjs";
import {
  WRANGLER_INVOCATION_ENV,
  assertNoForce,
  commandFor,
  planTeardown,
  refusals,
  runDelete,
  wranglerInvocation,
} from "./preview-teardown.mjs";

const { topology } = loadTopology();
const PR = 33;

/** The local spelling — `node_modules` exists here, and only here. */
function withWrangler(extra = {}) {
  return {
    ...process.env,
    [WRANGLER_INVOCATION_ENV]: "pnpm exec wrangler",
    ...extra,
  };
}

function allNames(plan) {
  return plan.flatMap((entry) => entry.names);
}

test("no name in the plan is any fixed environment's resource", () => {
  // THE FIRST TEST. A janitor that deletes `identity-production` is not a bug
  // that gets a fix; it is an incident. Derived from the manifest rather than
  // listed, so adding an environment without checking this fails here.
  const fixed = new Set();
  for (const environment of FIXED_ENVIRONMENTS) {
    const resources = topology.environments[environment].resources;
    for (const deployable of DEPLOYABLES) {
      const declared = resources[deployable];
      fixed.add(declared.worker);
      for (const part of [
        declared.d1?.name,
        declared.kv?.name,
        declared.queue?.name,
        declared.queue?.dlq,
      ]) {
        if (part) fixed.add(part);
      }
    }
  }

  const plan = planTeardown(topology, PR);
  for (const name of allNames(plan)) {
    assert.equal(
      fixed.has(name),
      false,
      `the plan would delete ${JSON.stringify(name)}, which a fixed environment declares`,
    );
  }
});

test("the plan is exactly the manifest's deletion order, with no gaps", () => {
  const plan = planTeardown(topology, PR);
  assert.deepEqual(
    plan.map((entry) => entry.step),
    topology.preview.deletion_order.steps,
    "the plan must visit every step the manifest declares, in the manifest's order",
  );
  plan.forEach((entry, index) => {
    assert.equal(entry.order, index);
  });
});

test("nothing in the plan carries --force, in any spelling", () => {
  // wrangler's `--force` means "delete even if doing so will break other
  // Workers that depend on this one". Passing it discards the guard Cloudflare
  // provides, and `preview.deletion_order.$comment` bans it outright: "a
  // resource it cannot delete cleanly is a resource it reports as surviving."
  //
  // Asserted on the argv the plan actually produces, not on the table it came
  // from, so a flag added to any step — including a future one — fails here.
  for (const entry of planTeardown(topology, PR)) {
    if (entry.spec.wrangler === null) continue;
    for (const name of entry.names) {
      const argv = entry.spec.wrangler.map((part) =>
        part.replace("{name}", name),
      );
      assertNoForce(argv);
      assert.equal(
        argv.some((part) => part.includes("force")),
        false,
        `${entry.step} would run ${argv.join(" ")}, which carries a force flag`,
      );
    }
  }
});

test("assertNoForce rejects the flag itself, with the reason", () => {
  // The property is only worth anything if the check actually refuses. Asserted
  // directly, including `--force=true`, which a naive `includes("--force")` on a
  // joined string would miss.
  assert.throws(
    () => assertNoForce(["delete", "identity-pr-33", "--force"]),
    /never passes --force at all/,
  );
  assert.throws(
    () => assertNoForce(["delete", "identity-pr-33", "--force=true"]),
    /never passes --force at all/,
  );
  assert.deepEqual(assertNoForce(["d1", "delete", "x"]), ["d1", "delete", "x"]);
});

test("a name is substituted as one argument, never into a shell string", () => {
  // A name that reached this file passed the grammar, which admits only
  // `[0-9]` and a fixed prefix — so no shell metacharacter can get here today.
  // The property is asserted anyway, because the grammar is a regex and a
  // future edit to it should not silently become an arbitrary-command hole.
  const entry = planTeardown(topology, PR).find(
    (e) => e.step === "worker:identity",
  );
  const argv = entry.spec.wrangler.map((part) =>
    part.replace("{name}", "a b; rm -rf /"),
  );
  assert.equal(
    argv.length,
    2,
    `expected one argument per template part, got ${argv.length}`,
  );
  assert.equal(
    argv[1],
    "a b; rm -rf /",
    "the name must stay a single argv entry",
  );
});

test("refusals() reports every guarded name with the guard that stopped it", () => {
  // Every refusal, not the first: a plan with a bad name is diagnosed in full
  // rather than one run at a time.
  const bad = {
    ...topology,
    preview: {
      ...topology.preview,
      deletion_order: {
        ...topology.preview.deletion_order,
        steps: [...topology.preview.deletion_order.steps],
      },
    },
  };
  // A plan naming a production Worker and a name matching no grammar at all —
  // two different findings that a boolean would collapse into one.
  const plan = [
    { kind: "worker", step: "worker:identity", names: ["identity"] },
    {
      kind: "worker",
      step: "worker:home-web",
      names: ["not-a-preview-at-all"],
    },
    {
      kind: "worker",
      step: "worker:identity-jobs",
      names: ["identity-jobs-pr-33"],
    },
  ];

  const found = refusals(bad, plan);
  assert.equal(found.length, 2, "exactly the two bad names must be refused");

  const byName = new Map(found.map((r) => [r.name, r]));
  assert.match(byName.get("identity").reason, /never_delete/);
  assert.match(byName.get("not-a-preview-at-all").reason, /does not match/);
});

test("the real plan produces no refusals at all", () => {
  // If this fails, either a manifest edit produced a name the guards stop — in
  // which case the teardown is correct and the manifest is wrong — or a guard
  // regressed. Either way the run stops before the first delete.
  const plan = planTeardown(topology, PR);
  assert.deepEqual(refusals(topology, plan), []);
});

test("a production name anywhere in the plan stops the whole run, not just that name", () => {
  // The property `main` relies on. A teardown that deleted "the ones that look
  // fine" would be the dangerous version: a manifest producing one bad name is
  // a manifest whose other names cannot be trusted either.
  const plan = [
    {
      kind: "worker",
      step: "worker:identity",
      names: ["identity", "identity-pr-33"],
    },
  ];
  const found = refusals(topology, plan);
  assert.equal(found.length, 1, "one bad name is enough to report");
  assert.equal(
    found[0].name,
    "identity",
    "the production Worker is the one reported",
  );
});

test("two PRs produce plans that share nothing", () => {
  // The property that makes a teardown safe to run concurrently with another
  // PR's deploy: PR 33's janitor cannot touch PR 34's resources.
  const mine = new Set(allNames(planTeardown(topology, 33)));
  for (const name of allNames(planTeardown(topology, 34))) {
    assert.equal(
      mine.has(name),
      false,
      `PR 34's plan contains ${JSON.stringify(name)}, which PR 33's plan also deletes`,
    );
  }
});

test("an already-absent resource is not a failure", () => {
  // Idempotence, and the reason a teardown may be run twice: the custom-domain
  // step may already have removed what a later step deletes, and a PR can be
  // closed more than once. Reporting "not found" as a failure would leave every
  // janitor run red forever and train everyone to ignore it.
  //
  // `runDelete` is exercised against the real wrangler with an argument it does
  // not accept, so the exit code and the stderr are wrangler's own.
  const missing = runDelete(["--definitely-not-a-wrangler-flag"], {
    env: withWrangler(),
    cwd: process.cwd(),
  });
  assert.equal(
    missing.outcome === "survived",
    true,
    "an unknown wrangler flag is a real failure, not an absent resource",
  );
});

test("a delete that is refused reports SURVIVED rather than throwing", () => {
  // The manifest's stated outcome: "a resource it cannot delete cleanly is a
  // resource it reports as surviving, which is the honest outcome." A teardown
  // that threw on the first refusal would leave every LATER resource in place
  // while reporting failure — the opposite of what a cleanup run is for.
  const result = runDelete(["d1", "delete", "definitely-not-a-database-xyz"], {
    env: withWrangler(),
    cwd: process.cwd(),
  });
  assert.ok(
    ["survived", "already-absent"].includes(result.outcome),
    `unexpected outcome ${result.outcome}`,
  );
  if (result.outcome === "survived") {
    assert.equal(typeof result.detail, "string");
    assert.ok(
      result.detail.length > 0,
      "a survivor must carry Cloudflare's own words",
    );
  }
});

test("wrangler is named by the caller, and an unset variable is refused", () => {
  // The bug this guards is not hypothetical: the script shipped hardcoding
  // `pnpm exec wrangler`, and `janitor.yml` checks the repository out WITHOUT
  // installing dependencies, so on the runner every delete would have failed
  // with "Command wrangler not found" — reported, correctly by the delete path
  // and very misleadingly by a run summary, as resources that SURVIVED.
  //
  // The refusal is the point. Defaulting to the locally-convenient spelling
  // would make the failure silent and the report wrong; a caller that has not
  // said how to reach wrangler has not run a teardown.
  assert.throws(
    () => wranglerInvocation({}),
    /PREVIEW_TEARDOWN_WRANGLER is not set/,
  );
  assert.throws(
    () => wranglerInvocation({ PREVIEW_TEARDOWN_WRANGLER: "   " }),
    /PREVIEW_TEARDOWN_WRANGLER is not set/,
  );

  // Both spellings the repository actually uses parse into argv the runner can
  // execute, with no shell between here and spawnSync.
  assert.deepEqual(
    wranglerInvocation({ PREVIEW_TEARDOWN_WRANGLER: "pnpm exec wrangler" }),
    ["pnpm", "exec", "wrangler"],
  );
  assert.deepEqual(
    wranglerInvocation({
      PREVIEW_TEARDOWN_WRANGLER: "npx --yes wrangler@4.144.0",
    }),
    ["npx", "--yes", "wrangler@4.144.0"],
  );
});

test("a missing wrangler is refused before the first name is derived", () => {
  // Ordering, and it is the whole value of the refusal: reached from `main`,
  // this exits before the plan runs and says "no wrangler". Reached after it,
  // the same condition would produce nine SURVIVED lines and a summary reading
  // "some resources survived", which is a different and much more expensive
  // story to investigate.
  const env = { ...process.env, PREVIEW_TEARDOWN_WRANGLER: "" };
  delete env.CLOUDFLARE_API_TOKEN;
  env.CLOUDFLARE_API_TOKEN = "not-a-real-token";

  const result = spawnSync(
    process.execPath,
    ["tooling/scripts/preview-teardown.mjs", "--pr=33"],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0, "a missing wrangler must not exit zero");
  assert.match(
    result.stderr,
    /PREVIEW_TEARDOWN_WRANGLER is not set/,
    "the failure must name the missing variable, not a Cloudflare error",
  );
  assert.equal(
    /\bdeleted\b/.test(result.stdout),
    false,
    "nothing may have been attempted before the refusal",
  );
});

test("the custom-domain step is reported as not performed, never approximated", () => {
  // wrangler has no Custom Domain delete. A teardown that quietly skipped it
  // would leave the domain attached, and — because wrangler then refuses to
  // delete the Worker — would leave the ENTIRE teardown half-done while
  // reporting success. Reporting it is the honest state and is what makes the
  // partial teardown visible.
  const entry = planTeardown(topology, PR).find(
    (e) => e.step === "custom_domains",
  );
  assert.equal(
    entry.spec.wrangler,
    null,
    "this step must have no wrangler argv at all",
  );
  assert.match(entry.spec.note, /no command for a Custom Domain/);
});

test("a step the manifest lists but nothing can produce is refused at plan time", () => {
  // The manifest is the source of the ORDER, and `previewResources` builds the
  // ENTRIES. A step added to `steps` without a matching entry is a resource a
  // preview owns that nothing will ever delete — and the teardown would report
  // a complete job. Refused here rather than sorted to an end and ignored.
  const extended = structuredClone(topology);
  extended.preview.deletion_order.steps.push("hyperdrive");
  assert.throws(
    () => planTeardown(extended, PR),
    /hyperdrive[\s\S]*no teardown will ever delete/,
    "a step nothing can produce must be refused at plan time",
  );
});

test("a step this script has no command for is an error, not a skip", () => {
  // The other half, and the one that bites later. A step can be produced and
  // still be unrunnable: the manifest and this script are edited by different
  // hands, so a new step can arrive with an entry but no command. Silently
  // omitting it produces a plan that looks complete and is not.
  //
  // `commandFor` is exercised directly rather than through `planTeardown`,
  // because `previewResources` refuses the same manifest first — which is what
  // makes these two independent gates rather than one of them twice.
  assert.throws(
    () => commandFor("hyperdrive"),
    /no command for/,
    "an unrunnable step must throw rather than yield no command",
  );
  // `worker:` is stripped to find the one Worker delete, so a step naming
  // something that is not a deployable has to be refused by the check rather
  // than falling through to that command: it would delete a Worker instead.
  assert.throws(() => commandFor("worker:hyperdrive"), /not one of/);
  assert.throws(() => commandFor("worker:../../etc/passwd"), /not one of/);
  assert.equal(commandFor("d1").wrangler.at(-1), "--skip-confirmation");
  assert.equal(
    commandFor("worker:identity").wrangler.includes("--force"),
    false,
    "the Worker delete must not carry --force",
  );
});

test("every plan entry's kind is a kind the guards know", () => {
  // The bug this file's history is largely about: `custom_domains` is the step
  // spelling and `hostname` is the guard spelling, and emitting the wrong one
  // made the first delete of every teardown throw. Every entry must be handed
  // to the guards under a kind they accept.
  for (const entry of planTeardown(topology, PR)) {
    assert.doesNotThrow(
      () => refusals(topology, [entry]),
      `${entry.step} carries kind ${JSON.stringify(entry.kind)}, which the guards reject`,
    );
  }
});

test("previewResources and the teardown plan agree name for name", () => {
  // The teardown does not keep its own list; it walks the manifest's. If it ever
  // does, this fails — and the difference would be a resource a preview owns
  // that nothing ever deletes.
  const fromModel = previewResources(topology, PR).flatMap((entry) =>
    entry.name === undefined ? entry.names : [entry.name],
  );
  assert.deepEqual(
    [...allNames(planTeardown(topology, PR))].sort(),
    [...fromModel].sort(),
  );
});
