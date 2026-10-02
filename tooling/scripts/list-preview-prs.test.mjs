/**
 * `list-preview-prs.test.mjs` — the sweep's reading of the account.
 *
 * WHY THE INPUT IS A FIXTURE RATHER THAN AN ACCOUNT. This file's whole job is to
 * answer "which pull requests still have a preview in the account", and the
 * only way to test that honestly is to feed it names — including names that look
 * like previews and are not. That is possible here because `collectNames` reads
 * stdin, so a saved wrangler listing from any version is a complete input.
 *
 * The property that matters is the same one every other file in this path
 * cares about: a name this file PROPOSES must be one the delete path would
 * accept. It is checked by asking `deletionRefusal` rather than by a local
 * copy of the grammar, because a local copy is a second rule to keep correct
 * and the whole point of `topology-model.mjs` is that there is one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEPLOYABLES,
  FIXED_ENVIRONMENTS,
  loadTopology,
  previewResources,
} from "./topology-model.mjs";
import {
  collectNames,
  previewPullRequests,
  prFromName,
} from "./list-preview-prs.mjs";

const { topology } = loadTopology();

test("no fixed environment's resource is ever proposed as a preview", () => {
  // THE FIRST TEST, and the same one the delete path's own tests make. This
  // file proposes names for a janitor to act on, so a production name appearing
  // in its output is a production name one step from being deleted.
  const fixed = [];
  for (const environment of FIXED_ENVIRONMENTS) {
    const resources = topology.environments[environment].resources;
    for (const deployable of DEPLOYABLES) {
      const declared = resources[deployable];
      fixed.push(
        declared.worker,
        declared.d1?.name,
        declared.kv?.name,
        declared.queue?.name,
        declared.queue?.dlq,
      );
    }
    fixed.push(
      ...Object.values(topology.environments[environment].hosts).filter(
        (h) => typeof h === "string",
      ),
    );
    fixed.push(topology.environments[environment].email.service);
  }

  const report = previewPullRequests(topology, fixed.filter(Boolean));
  assert.deepEqual(
    report.pullRequests,
    [],
    "no fixed environment resource may be read as a pull request's preview",
  );
  assert.deepEqual(report.refused, []);
});

test("every preview resource a real PR owns is found", () => {
  // The positive half, and the reason the sweep exists: a preview whose pull
  // request is gone has no event pending, so if the sweep cannot find it by
  // name nothing ever will.
  for (const pr of [1, 42, 333, 999]) {
    const names = previewResources(topology, pr).flatMap((entry) =>
      entry.name === undefined ? entry.names : [entry.name],
    );
    const report = previewPullRequests(topology, names);
    const found = report.pullRequests.find((e) => e.pr === pr);
    assert.ok(
      found,
      `PR ${pr}'s resources were not all attributed to PR ${pr}`,
    );
    assert.equal(
      found.names.length,
      names.length,
      `PR ${pr}: ${found.names.length} of ${names.length} names were attributed`,
    );
  }
});

test("names that resemble a preview but are not are attributed to nobody", () => {
  // Near misses in the grammar's `[0-9]+` and in the name shape. Each of these
  // would be catastrophic if reported as a pull request's own — and PR 0 and
  // PR 1000 do not exist, so a sweep proposing them would either fail forever
  // or, worse, target a real pull request's number.
  const notPreviews = [
    "identity-pr-0",
    "identity-pr-007",
    "identity-pr-1000",
    "ecoma-identity-pr-0",
    "identity-pr-33-backup",
    "identity-pr-33-staging",
    "identity-pr-",
    "identity-ecoma-pr-33",
  ];
  for (const name of notPreviews) {
    assert.equal(
      prFromName(topology, name),
      null,
      `${JSON.stringify(name)} must be attributed to no pull request`,
    );
  }
});

test("a pull request number is taken from the name, and validated by the manifest", () => {
  // The manifest's `preview.pr_number` is `^[1-9][0-9]*$` and `max_pr_number` is
  // 999. The grammar admits `[0-9]+`, which is looser — so a name matching the
  // grammar can still name a pull request that cannot exist, and the number has
  // to be re-validated rather than parsed.
  assert.equal(prFromName(topology, "identity-pr-33"), 33);
  assert.equal(prFromName(topology, "ecoma-identity-pr-999"), 999);
  assert.equal(prFromName(topology, "pr7-identity.ecoma.io"), 7);
  assert.equal(prFromName(topology, "identity-pr-1000"), null, "over the cap");
  assert.equal(
    prFromName(topology, "identity"),
    null,
    "not a preview name at all",
  );
});

test("collectNames reads JSON, a table, and one-name-per-line alike", () => {
  // wrangler's output shape is wrangler's business. The sweep reads whatever it
  // is given and asks only which names match the grammar, so a version that
  // wraps its output differently costs a re-read rather than a broken sweep.
  //
  // `collectNames` takes the PARSED value — `main` is what attempts the parse,
  // so a JSON listing arrives as an object and a table arrives as a string.
  // Passing raw JSON text here would assert that the whole raw line is a name.
  assert.deepEqual(
    collectNames(JSON.parse('["identity-pr-33", {"name": "identity-pr-34"}]')),
    ["identity-pr-33", "identity-pr-34"],
  );
  assert.deepEqual(collectNames("identity-pr-33\nidentity-pr-34\n"), [
    "identity-pr-33",
    "identity-pr-34",
  ]);
  // Nested, because a listing can be `[{deployments: [{name}]}]`.
  assert.ok(
    collectNames([
      { result: [{ deployments: [{ script_name: "identity-pr-42" }] }] },
    ]).includes("identity-pr-42"),
    "a nested script_name must be found",
  );
  // A non-string, non-object value is skipped rather than stringified: `null`
  // becoming the name "null" would be a name the grammar rejects anyway, but
  // `[1, 2, 3]` becoming "1,2,3" would be a name nothing can check.
  assert.deepEqual(collectNames([null, 7, true, "identity-pr-33"]), [
    "identity-pr-33",
  ]);
});

test("two pull requests never merge into one entry", () => {
  // The sweep's output is what a teardown is dispatched on, so two pull
  // requests sharing an entry would have one of them torn down under the
  // other's number.
  const report = previewPullRequests(topology, [
    "identity-pr-33",
    "identity-pr-34",
    "ecoma-identity-pr-34",
  ]);
  assert.deepEqual(
    report.pullRequests.map((e) => e.pr),
    [33, 34],
  );
  assert.deepEqual(report.pullRequests[1].names.sort(), [
    "ecoma-identity-pr-34",
    "identity-pr-34",
  ]);
});
