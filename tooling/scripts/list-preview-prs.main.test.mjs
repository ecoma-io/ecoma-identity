/**
 * `list-preview-prs.main.test.mjs` — what a caller can observe.
 *
 * THE SEPARATE FILE IS THE POINT. `scanProblems` is a pure function and its
 * tests are in the sibling file. What was missing is that `main` ACTS on it:
 * mutating the return of `main` to a constant `0` left every test green, so the
 * janitor's `set -e` would have read a failed scan as a successful one and
 * appended `count=0` — the account-is-clean answer, from a run that never looked.
 *
 * These drive `main` end to end, over a real stdin-shaped read, so the exit code
 * under test is the one the workflow actually sees.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { loadTopology } from "./topology-model.mjs";

const { topology } = loadTopology();

/** Collect what `main` wrote and what it returned, over an injected stdin. */
async function runMain(argv, stdin, root) {
  const { main } = await import("./list-preview-prs.mjs");
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = await main(argv, {
      readStdin: () => stdin,
      root,
    });
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("a listing that carried errors exits non-zero, so no count reaches the report", async () => {
  const result = await runMain(
    ["--json"],
    '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
  );
  assert.equal(
    result.code,
    1,
    "a failed scan must fail the step; `count=0` is the account-is-clean answer",
  );
  assert.equal(JSON.parse(result.stdout).complete, false);
  assert.match(result.stderr, /did not succeed/);
});

test("a clean listing exits 0 and says the scan was complete", async () => {
  const result = await runMain(
    ["--json"],
    '{"result":[{"name":"identity-pr-33"}],"success":true,"errors":[]}',
  );
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).complete, true);
});

test("an empty but well-formed account is a complete scan of zero previews", async () => {
  // The case that must NOT fail. `[]` genuinely means no deployments, and a
  // detector loose enough to flag it would make the nightly sweep unrunnable.
  const result = await runMain(
    ["--json"],
    '{"result":[],"success":true,"errors":[],"messages":[]}',
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).pullRequests, []);
  assert.equal(JSON.parse(result.stdout).complete, true);
});

test("--root is matched as a prefix, so the documented spelling works", async () => {
  // `arg === "--root="` matched the bare flag and rejected every real one, so
  // the only spelling the usage text shows was an unknown argument.
  const root = fs.mkdtempSync(path.join(tmpdir(), "list-preview-prs-root-"));
  fs.mkdirSync(path.join(root, "infra-topology"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "infra-topology", "topology.json"),
    JSON.stringify(topology),
  );
  const result = await runMain(
    [`--root=${root}`, "--json"],
    '{"result":[{"name":"identity-pr-33"}],"success":true,"errors":[]}',
    root,
  );
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /unknown argument/);
  assert.equal(JSON.parse(result.stdout).pullRequests[0].pr, 33);
});
