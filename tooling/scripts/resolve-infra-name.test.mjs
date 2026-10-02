/**
 * `resolve-infra-name.test.mjs` — the lookup a deploy step makes for a NAME.
 *
 * WHY THIS FILE EXISTS. The first PR to exercise the preview lane failed in the
 * D1 migration step, and the log named two separate defects that shared one
 * cause:
 *
 *     Applying migrations to the database bound as IDENTITY_DB (remote).
 *       database_name: ecoma-identity-pr-{pr}          <- the TEMPLATE
 *     jq: error (at infra-topology/topology.json:749): Cannot index array with
 *     string "d1"                                       <- exit 5, no migration at all
 *
 * The step read `infra-topology/topology.json` with `jq`, i.e. it asked the raw
 * manifest a question about a RESOLVED name. `topology-model.mjs` exists so that
 * exactly one thing knows how `{pr}` becomes `pr`; a shell that re-derives the
 * manifest's shape is how that rule gets skipped, and the skip is invisible until
 * an environment actually carries a template.
 *
 * The tests below pin the properties a caller depends on, each of which has a
 * failure that would be silent rather than loud:
 *
 *   - a preview lookup renders `{pr}` (the bug);
 *   - a fixed environment is unaffected (the regression that must not happen);
 *   - a lookup with no `--pr` on a preview is an error, NOT the template;
 *   - a deployable that binds no D1 prints nothing and exits 0 (so "no database"
 *     stays distinguishable from "the lookup broke");
 *   - no exit path anywhere prints a `{pr}` template.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RESOLVE = path.join(
  REPO_ROOT,
  "tooling",
  "scripts",
  "resolve-infra-name.mjs",
);
const EXIT_USAGE = 64;

/**
 * Run the tool and report the exit code alongside stdout and stderr.
 *
 * `spawnSync`, not `execFileSync`: the latter only populates `error.stderr` when
 * the child exits non-zero, so every notice this tool writes on a SUCCESS — an
 * absent path, a null slot — would have arrived as an empty string and the tests
 * below would have asserted against noise. Both streams are captured on both
 * outcomes.
 */
function run(args) {
  const result = spawnSync(process.execPath, [RESOLVE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("a preview lookup renders the PR number, not the template", () => {
  // THE BUG. On the first preview run this step printed
  // `ecoma-identity-pr-{pr}` while wrangler had just uploaded a config naming
  // `ecoma-identity-pr-33`, and the next line of that workflow applies
  // migrations --remote --forward-only to whatever it is given.
  const result = run([
    "--environment",
    "preview",
    "--pr",
    "33",
    "--ask",
    "resources.identity.d1.name",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ecoma-identity-pr-33\n");
  assert.ok(
    !result.stdout.includes("{pr}"),
    "a resolved name must never contain a template placeholder",
  );
});

test("the same PR number renders differently per PR, and neither is the template", () => {
  // If two PRs resolved to one name, one preview's deploy would overwrite the
  // other's — which `reconcile-infra.test.mjs` already asserts on the
  // descriptor. Asserting it here too is cheap and catches the failure at the
  // other end of the same rule.
  const names = [7, 33, 101].map((pr) => {
    const result = run([
      "--environment",
      "preview",
      "--pr",
      String(pr),
      "--ask",
      "resources.identity.d1.name",
    ]);
    assert.equal(result.code, 0);
    return result.stdout.trim();
  });
  assert.equal(new Set(names).size, names.length, `names collided: ${names}`);
});

test("a fixed environment still resolves, and is unaffected by this change", () => {
  for (const environment of ["production", "staging", "development"]) {
    const result = run([
      "--environment",
      environment,
      "--ask",
      "resources.identity.d1.name",
    ]);
    assert.equal(result.code, 0, `${environment} failed to resolve`);
    assert.equal(result.stdout, `ecoma-identity-${environment}\n`);
    assert.ok(!result.stdout.includes("{pr}"));
  }
});

test("a preview lookup without --pr is a usage error, not the template", () => {
  // The one behaviour that must never regress into printing
  // `ecoma-identity-pr-{pr}`: a real-looking name for a real account.
  const result = run([
    "--environment",
    "preview",
    "--ask",
    "resources.identity.d1.name",
  ]);
  assert.equal(result.code, EXIT_USAGE);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--pr <number>/);
});

test("--pr is refused for a fixed environment", () => {
  const result = run([
    "--environment",
    "staging",
    "--pr",
    "33",
    "--ask",
    "resources.identity.d1.name",
  ]);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /fixed/);
});

test("a deployable that binds no D1 answers empty and succeeds", () => {
  // The reason the caller needs `if !` around every lookup: "this deployable has
  // no database" has to be distinguishable from "the lookup failed", because the
  // caller skips migrations on the first and must abort on the second. The empty
  // answer is a NEWLINE, not zero bytes — `$( )` strips it, and a caller that
  // tests `-z` sees the same thing either way, but a caller that counts bytes
  // does not.
  for (const deployable of ["identity-admin", "identity-jobs", "home-web"]) {
    const name = run([
      "--environment",
      "preview",
      "--pr",
      "33",
      "--ask",
      `resources.${deployable}.d1.name`,
    ]);
    assert.equal(name.code, 0, `${deployable}: a name should resolve`);
    assert.equal(name.stdout.trim(), "");
    assert.match(name.stderr, /is not declared/);

    const slot = run([
      "--environment",
      "preview",
      "--pr",
      "33",
      "--ask",
      `bindings.${deployable}.d1`,
    ]);
    assert.equal(slot.code, 0, `${deployable}: a null slot should resolve`);
    assert.equal(slot.stdout.trim(), "");
  }
});

test("a binding slot is the env var name and never carries a template", () => {
  // Binding slots are the strings a Worker reads as `env.IDENTITY_DB`. They live
  // outside `environments.<env>` precisely because a preview reads the SAME slot
  // as production and merely points it at a different database. If a template
  // ever reached a slot name, the config would bind something no Worker declares.
  const result = run([
    "--environment",
    "preview",
    "--pr",
    "33",
    "--ask",
    "bindings.identity.d1",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "IDENTITY_DB\n");
  assert.ok(!result.stdout.includes("{pr}"));
});

test("--ask deployables lists one per line for a caller that iterates it", () => {
  // The migration step walks every deployable to find which one owns a database.
  // An array printed as JSON would make `for x in $(...)` iterate one string; an
  // array printed on one line would make it iterate four.
  const result = run(["--environment", "staging", "--ask", "deployables"]);
  assert.equal(result.code, 0);
  const names = result.stdout.trim().split("\n");
  assert.deepEqual(names, [
    "identity",
    "identity-admin",
    "identity-jobs",
    "home-web",
  ]);
});

test("an unknown path reports itself instead of printing nothing in silence", () => {
  const result = run([
    "--environment",
    "preview",
    "--pr",
    "33",
    "--ask",
    "resources.identity.nope",
  ]);
  assert.equal(result.code, 0, "an absent path is an answer, not a failure");
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /is not declared/);
});

test("an unknown environment and an unknown argument are usage errors", () => {
  assert.equal(
    run(["--environment", "nowhere", "--ask", "deployables"]).code,
    EXIT_USAGE,
  );
  assert.equal(
    run(["--environment", "staging", "--ask", "deployables", "--bogus"]).code,
    EXIT_USAGE,
  );
});

test("no failure path prints a {pr} template to stdout", () => {
  // The blunt version of the property above, applied to every rejection this
  // tool can produce. A caller pipes stdout straight into a Cloudflare command,
  // so stdout must never carry a name that was not fully rendered — including on
  // the paths that exit non-zero.
  const attempts = [
    ["--environment", "preview", "--ask", "resources.identity.d1.name"],
    [
      "--environment",
      "preview",
      "--pr",
      "33",
      "--ask",
      "resources.identity.d1",
    ],
    [
      "--environment",
      "preview",
      "--pr",
      "999999999",
      "--ask",
      "resources.identity.d1.name",
    ],
    [
      "--environment",
      "preview",
      "--pr",
      "notanumber",
      "--ask",
      "resources.identity.d1.name",
    ],
    ["--environment", "nope", "--ask", "deployables"],
    ["--environment", "staging", "--pr", "1", "--ask", "deployables"],
    ["--environment", "staging", "--ask"],
  ];
  for (const args of attempts) {
    const result = run(args);
    assert.ok(
      !result.stdout.includes("{pr}"),
      `${args.join(" ")} printed a template to stdout: ${JSON.stringify(result.stdout)}`,
    );
  }
});
