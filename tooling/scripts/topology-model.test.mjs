/**
 * `topology-model.test.mjs` — the failure reporter's own tests.
 *
 * WHY THIS FILE EXISTS. `reportFailure` exists because a script died with
 *
 *     Cannot read properties of undefined (reading 'id')
 *
 * inside a GitHub Actions step, and that single line said what broke without
 * saying where. The cost was a debugging session spent separating a real
 * signal from the `set -x` echo of every source line around it. The fix was to
 * print the stack; the risk of that fix is printing LESS than before, or
 * printing something that looks like a diagnosis and is not.
 *
 * So this asserts the three properties the reporter promises:
 *
 *   1. it names the tool, so a log line says which script failed when several
 *      run in one step;
 *   2. it carries a stack, because a message alone is what it replaced;
 *   3. it annotates with `::error::`, so GitHub renders a failure rather than
 *      log noise somebody has to go looking for.
 *
 * AND the one property that is a security constraint rather than a
 * convenience: it never prints a secret. The Cloudflare token is read from the
 * environment, and a stack trace must not become the thing that leaks it —
 * these scripts write into logs that get pasted into issues.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEPLOYABLES,
  loadTopology,
  reportFailure,
  resolveEnvironment,
  TopologyError,
} from "./topology-model.mjs";

/** Capture what `reportFailure` writes to stderr, and return it as a string. */
function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("names the tool that failed, so one step running two scripts is readable", () => {
  const out = captureStderr(() =>
    reportFailure("reconcile-infra", new TopologyError("no queue named X")),
  );
  assert.match(out, /::error::reconcile-infra: no queue named X/);
});

test("prints the stack, which is the whole reason the function exists", () => {
  const error = new TypeError(
    "Cannot read properties of undefined (reading 'id')",
  );
  const out = captureStderr(() => reportFailure("reconcile-infra", error));
  // A stack has frames; a message does not. Without this the reporter could
  // satisfy its tests by printing only the line it was written to replace.
  assert.match(out, /at\s/, "expected a stack frame in the output");
  assert.match(out, /topology-model\.test\.mjs|node:internal/);
});

test("annotates with ::error:: so GitHub renders it as a failure", () => {
  const out = captureStderr(() =>
    reportFailure("render-wrangler-config", new Error("bad topology")),
  );
  assert.ok(
    out.includes("::error::render-wrangler-config:"),
    "the annotation is what turns this line into a red entry in the run summary",
  );
});

test("never prints a secret, because run logs get pasted into issues", () => {
  // A token in the environment, standing in for the real case: the scripts read
  // it from `process.env` and it must not reach stderr through any path.
  const secret = "cf-token-value-that-must-not-appear";
  process.env.CLOUDFLARE_API_TOKEN = secret;
  try {
    const out = captureStderr(() =>
      reportFailure("reconcile-infra", new TopologyError("listing failed")),
    );
    assert.ok(!out.includes(secret), `the reporter leaked the token:\n${out}`);
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test("every declared binding slot survives resolution, including one added later", () => {
  // The property `resolveBindings` used to fail. It spelled the slot names out by
  // hand, so it was a SECOND view of `topology.bindings` that a new slot would
  // silently not appear in — and nothing else caught it:
  // `validate-topology.mjs`'s `exactKeys` checks the deployable KEYS, not each
  // deployable's slots, and `render-wrangler-config.mjs` reads the manifest
  // directly, so it saw a new slot this function dropped. The failure is a
  // `resolve-infra-name.mjs --ask bindings.<deployable>.<newslot>` answering "is
  // not declared" and exiting 0 — a false negative from the tool the deploy
  // steps treat as authoritative about this file.
  const { topology } = loadTopology();
  const resolved = resolveEnvironment(topology, "staging");

  for (const deployable of DEPLOYABLES) {
    assert.deepEqual(
      resolved.bindings[deployable],
      topology.bindings[deployable] ?? {},
      `${deployable}: resolution must carry every slot the manifest declares`,
    );
  }
});

test("a binding slot nobody enumerated appears in resolution the same day", () => {
  // The same property driven through an INVENTED slot, because the six names in
  // the old table all happen to be present — so "this assertion passes" and "the
  // code is correct" are different claims. Only the second one protects the next
  // slot added, and it is the second one this test is for.
  const { topology } = loadTopology();
  const withNewSlot = structuredClone(topology);
  withNewSlot.bindings.identity.hyperdrive = "IDENTITY_HYPERDRIVE";

  const resolved = resolveEnvironment(withNewSlot, "staging");
  assert.equal(
    resolved.bindings.identity.hyperdrive,
    "IDENTITY_HYPERDRIVE",
    "a slot no code mentions must still reach the resolved environment",
  );
  assert.deepEqual(
    resolved.bindings.identity,
    withNewSlot.bindings.identity,
    "resolution must be the declared object, not a filtered copy of it",
  );
});

test("survives a thrown non-Error instead of printing 'undefined'", () => {
  // A script that throws a bare string is itself a finding, and the reporter
  // must not turn it into a second, quieter failure.
  const out = captureStderr(() =>
    reportFailure("reconcile-infra", "a bare string"),
  );
  assert.match(out, /::error::reconcile-infra: a bare string/);
  assert.ok(!out.includes("undefined"), "must not print a bare 'undefined'");
});

test("flattens a multi-line message so the annotation stays one line", () => {
  // GitHub treats `::error::` as one workflow command per line; an embedded
  // newline splits it into two commands and the second loses its annotation.
  const out = captureStderr(() =>
    reportFailure(
      "reconcile-infra",
      new Error("line one\nline two\nline three"),
    ),
  );
  const annotated = out
    .split("\n")
    .filter((line) => line.includes("::error::"));
  assert.equal(annotated.length, 1, "exactly one annotation line");
  assert.match(annotated[0], /line one line two line three/);
});
