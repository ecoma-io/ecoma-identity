/**
 * `check-architecture.test.mjs` — the canary.
 *
 * WHAT THIS IS: a `node:test` suite that runs the REAL check functions, from
 * `check-architecture.mjs`, against `__fixtures__/violating-tree/` — a
 * deliberately broken repository that violates the boundary law in the exact
 * ways `docs/architecture/` forbids. It asserts that each check FAILS, with the
 * message a maintainer would act on.
 *
 * WHAT THIS IS NOT: it is not a test of the test helpers, and it does not
 * re-implement any check. Every assertion below runs the same function CI
 * runs. A test that duplicated a check's logic would keep passing after the
 * check was deleted — which is the failure mode this file exists to prevent.
 *
 * WHY IT EXISTS. A guard with no test that it catches the thing it exists to
 * catch is an assumption, not a guard. This suite is what turns
 * `check-architecture.mjs` from plausible prose into evidence, and it is run on
 * every `pnpm arch:canary`.
 *
 * THE FIXTURE IS NOT A GIT REPOSITORY, and deliberately so. Check 8 reads the
 * GIT INDEX (`git ls-files`), so the canary needs an index in which `.env` and
 * `tls.pem` are staged. The test builds one at runtime with `GIT_INDEX_FILE`
 * pointing at a temp file and `git add --intent-to-add` over an explicit
 * allow-list, then runs the check with that same variable set.
 *
 * Why not commit a nested `.git` to the fixture? Because git reads a directory
 * containing `.git` with no commit as an EMBEDDED REPOSITORY, and `git add -A`
 * over the whole tree then fails with `does not have a commit checked out` —
 * the bootstrap commit becomes impossible. A committed nested repository is a
 * thing nobody wants to review and nobody can read a diff of. The runtime
 * index has no such cost and is strictly more honest: it is assembled from the
 * fixture's actual files, so it cannot drift from them.
 *
 * Why not simply commit the fixture's `.env`? Because this repository's
 * `.gitignore` ignores `.env` and `*.pem` — correctly, and globally, which is
 * the right rule for a repository that holds real secrets. An exception for the
 * fixture would weaken a security rule to make a test pass, which is the
 * direction that makes a gate decorative. The runtime index reaches the same
 * state without touching the rule.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { internalReachability, readRustGraph } from "./check-architecture.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SCRIPT = path.join(SCRIPT_DIR, "check-architecture.mjs");
const FIXTURE = path.join(SCRIPT_DIR, "__fixtures__", "violating-tree");

/**
 * The fixture paths the canary stages into its runtime git index.
 *
 * An explicit allow-list, not a glob. The point of the canary is to stage
 * EXACTLY the files that stand for a committed secret, and a glob would stage
 * whatever the fixture happens to contain next year — so a new fixture file
 * would silently join the index without anybody deciding that it should.
 */
const FIXTURE_SECRET_FILES = [".env", "tls.pem"];

let tempDir = null;
let tempIndex = null;
let fixtureRun = null;
let realRun = null;

/**
 * Where a run's JSON report is written.
 *
 * A fresh temp directory per call, never a shared one. Two suites in this file
 * each run the guard in their own `before`, and node:test runs the suites'
 * teardowns in declaration order — so a shared temp directory is guaranteed to
 * be DELETED by the time the second suite runs. The symptom is not an obvious
 * failure: `spawnSync` still succeeds, the child still writes its report, and
 * the test only sees a null where it expected a verdict, which reads as a bug
 * in the guard rather than in the harness. Each run owning its directory is the
 * fix, and the child's exit code is asserted alongside so a lost report can
 * never pass as a quiet run.
 */
function runGuard(root, { env = {}, extraArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ecoma-arch-run-"));
  try {
    const reportPath = path.join(dir, "report.json");
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--json", reportPath, "--no-color", ...extraArgs],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ECOMA_IDENTITY_ROOT: root,
          NO_COLOR: "1",
          ...env,
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    const written = fs.existsSync(reportPath);
    assert.ok(
      written || result.status !== 0,
      `--json ${reportPath} was not written and the run exited ${result.status}.\n` +
        `Every run writes a report; a run that exits ${result.status} without one is a broken\n` +
        `invocation, and reading it as a quiet pass would be exactly the mistake this suite\n` +
        `exists to catch.\nstderr:\n${result.stderr}`,
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      report: written ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Findings for one check id, from a parsed report. */
function findingsFor(report, checkId) {
  const check = report.checks.find((c) => c.id === checkId);
  assert.ok(
    check,
    `the report has no check named "${checkId}" — the check id was renamed or removed`,
  );
  return check;
}

/**
 * A finding object in `check` whose `found` text matches `pattern`, or an
 * assertion failure that prints everything the check DID report.
 *
 * The failure message matters more than usual here. A canary that fails with
 * "no matching finding" and nothing else leaves a maintainer guessing which of
 * nine findings was the wrong one; printing all of them, plus every step that
 * was skipped and why, makes the difference between a two-minute diagnosis and
 * an afternoon.
 */
function findingMatching(check, pattern, message) {
  const hit = check.findings.find((f) => pattern.test(f.found));
  assert.ok(
    hit,
    `${message ?? `expected a finding matching ${pattern}`}.\n` +
      `  the check reported ${check.findings.length} finding(s):\n` +
      check.findings
        .map(
          (f) =>
            `    [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.found}`,
        )
        .join("\n") +
      (check.skipReason
        ? `\n  the check was SKIPPED: ${check.skipReason}`
        : "") +
      `\n  evidence:\n` +
      (check.evidence ?? []).map((e) => `    - ${e}`).join("\n"),
  );
  return hit;
}

describe("the canary fixture: a deliberately violating tree", () => {
  before(() => {
    assert.ok(
      fs.existsSync(FIXTURE),
      `the fixture tree is missing: ${FIXTURE}`,
    );

    // Build the git index the canary needs, at a temp path. `--intent-to-add`
    // stages a path WITHOUT its content, which is exactly what `git ls-files`
    // needs to see it: check 8 asks what is TRACKED, and a tracked-but-unread
    // path is the honest representation of a committed file. It is used
    // rather than a real `git add` because a real add would also respect this
    // repository's `.gitignore`, which correctly ignores `.env` and `*.pem`
    // and must keep doing so.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecoma-arch-canary-"));
    tempIndex = path.join(tempDir, "index");
    for (const file of FIXTURE_SECRET_FILES) {
      const target = path.join(FIXTURE, file);
      assert.ok(
        fs.existsSync(target),
        `the fixture file "${file}" is missing; the §27 canary needs it`,
      );
      // `-f` is REQUIRED and is the whole point of this construction.
      // Without it git refuses the path because this repository's .gitignore
      // correctly ignores `.env` and `*.pem` — and that rule must keep
      // applying to every real file in the repository. `-f` applies to a
      // TEMPORARY INDEX at a temp path that nothing else ever reads, and it
      // stages the fixture's file, never a developer's. The alternative — an
      // `!.env` negation for the fixture in .gitignore — would weaken a
      // security rule so that a test could pass, which is the direction that
      // makes a gate decorative.
      execFileSync("git", ["add", "--intent-to-add", "--force", "--", file], {
        cwd: FIXTURE,
        env: { ...process.env, GIT_INDEX_FILE: tempIndex },
        stdio: "pipe",
      });
    }

    // The canary index proves the staged file is visible to `git ls-files`
    // BEFORE any check runs. If this assertion fails, every §27 assertion
    // below would be passing for the wrong reason, and it is better to fail
    // here where the cause is visible than there where it is not.
    const staged = execFileSync("git", ["ls-files"], {
      cwd: FIXTURE,
      env: { ...process.env, GIT_INDEX_FILE: tempIndex },
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const file of FIXTURE_SECRET_FILES) {
      assert.ok(
        staged.includes(file),
        `the canary index does not contain "${file}"; staged: ${staged.join(", ")}`,
      );
    }

    fixtureRun = runGuard(FIXTURE, { env: { GIT_INDEX_FILE: tempIndex } });
    realRun = runGuard(REPO_ROOT);
  });

  after(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits non-zero, because a tree that violates the law must not pass", () => {
    assert.equal(
      fixtureRun.status,
      1,
      `the canary run should exit 1 (violations found) and exited ${fixtureRun.status}.\n` +
        `A guard that cannot fail is not a guard. If this assertion started failing after a\n` +
        `change to check-architecture.mjs, the change removed a constraint — that is a\n` +
        `regression in the law, not a fix to the test.\n\n${fixtureRun.stdout}`,
    );
  });

  it("reports the fixture's secrets from a git index built at runtime", () => {
    const check = findingsFor(fixtureRun.report, "no-committed-secrets");
    findingMatching(
      check,
      /tracked \.env/,
      "check 8 must catch the fixture's committed .env",
    );
    findingMatching(
      check,
      /tracked tls\.pem/,
      "check 8 must catch the fixture's committed tls.pem",
    );
  });

  it("check 1: the Admin Worker must not reach IDENTITY_DB in code", () => {
    const check = findingsFor(fixtureRun.report, "boundary-1-admin-d1");
    const hit = findingMatching(
      check,
      /IDENTITY_DB in apps\/identity-admin\/worker\/src\/lib\.rs/,
      'check 1 must catch `env.d1("IDENTITY_DB")` in the Admin Worker',
    );
    assert.equal(
      hit.severity,
      "violation",
      "a D1 handle in CODE is a violation, not a warning",
    );
    assert.equal(
      hit.line,
      8,
      "the finding must name the line the handle is on",
    );
  });

  it("check 1: the Admin Worker must not declare a D1 binding in wrangler", () => {
    const check = findingsFor(fixtureRun.report, "boundary-1-admin-d1");
    const hit = findingMatching(
      check,
      /d1_databases binding "IDENTITY_DB" declared for the admin Worker/,
      "check 1 must catch the admin worker's wrangler d1_databases binding",
    );
    assert.match(
      hit.file,
      /infra\/cloudflare\/.*\/identity-admin\/wrangler\.jsonc$/,
    );
    assert.match(hit.found, /development|staging|production/);
  });

  it("check 2: the Jobs Worker must not depend on identity-domain", () => {
    const check = findingsFor(fixtureRun.report, "boundary-2-jobs-isolation");
    // The message is `reaches`, not `->`: the check judges transitive
    // reachability, so a path through an intermediate crate is a violation
    // with the same force as a direct edge. The fixture carries a direct
    // edge, and this asserts the violation is reported either way.
    const hit = findingMatching(
      check,
      /identity-jobs-worker reaches identity-domain/,
      "check 2 must catch the jobs worker's cargo edge to identity-domain",
    );
    assert.match(hit.file, /apps\/identity-jobs\/worker\/Cargo\.toml$/);
    assert.match(hit.constraint, /§4/);
  });

  it("check 2: a TRANSITIVE route to identity-domain is also a violation", () => {
    // The direct-edge assertion above cannot tell a check that reads only
    // direct edges from one that reads reachability, because the fixture's
    // edge is direct. This is the case that was silently passing before: a
    // jobs Worker that depends on a crate which itself depends on
    // identity-domain carries the rule engine in with it, and the manifest
    // looks compliant.
    //
    // Proven on the REAL tree, not the fixture, because the real tree is the
    // case that was missed: identity-jobs-worker declares identity-security
    // and identity-cloudflare, and both reach identity-domain.
    const real = internalReachability(readRustGraph(), "identity-jobs-worker");
    const forbidden = [...real.keys()].filter((name) =>
      /identity-(domain|application)$/.test(name),
    );
    assert.ok(
      forbidden.length > 0,
      "the real jobs Worker must be shown reaching identity-domain or identity-application transitively — if this fails, the Cargo.toml changed and the check needs re-deriving",
    );
    for (const name of forbidden) {
      const p = real.get(name);
      assert.ok(
        p.length >= 2,
        `${name} must be reached through at least one intermediate crate, or this test is no longer covering the transitive case`,
      );
    }
  });

  it("check 3: the domain crate must not depend on the Cloudflare runtime", () => {
    const check = findingsFor(fixtureRun.report, "boundary-3-domain-platform");
    const hit = findingMatching(
      check,
      /identity-domain -> worker/,
      "check 3 must catch identity-domain's dependency on the `worker` crate",
    );
    assert.match(hit.found, /crates\.io/);
  });

  it("check 4: the backend must not import or name a frontend package", () => {
    const check = findingsFor(
      fixtureRun.report,
      "boundary-4-no-frontend-in-backend",
    );
    findingMatching(
      check,
      /resolves to apps\/identity\/web/,
      "check 4 must catch the include_str! that climbs out of the admin worker into a frontend",
    );
    findingMatching(
      check,
      /frontend package "vue" is named/,
      "check 4 must catch the backend naming `vue` with no import to resolve",
    );
    assert.equal(
      check.findings.filter((f) => f.file.includes("/web/")).length,
      0,
      "a frontend naming `vue` is LEGAL. The fixture's own frontends do exactly that, and a\n" +
        "check that reported them would be reporting the frontends the brief mandates.",
    );
  });

  it("check 5: the fourth Worker must be unregistered, in the places it is missing from", () => {
    const check = findingsFor(
      fixtureRun.report,
      "boundary-5-worker-registration",
    );
    findingMatching(
      check,
      /identity-reporting-worker, which is not a member of the Cargo workspace/,
      "check 5 must catch the fourth Worker missing from the Cargo members",
    );
    findingMatching(
      check,
      /apps\/identity-reporting\/worker\/Cargo\.toml is not mapped in \.moon\/workspace\.yml/,
      "check 5 must catch the fourth Worker missing from the moon project map",
    );
    findingMatching(
      check,
      /release-please-config\.json has no component for "identity-reporting"/,
      "check 5 must catch the fourth Worker missing from the release-please components",
    );
  });

  it("check 6: there must be exactly three deployables", () => {
    const check = findingsFor(fixtureRun.report, "deploymentable-count");
    const hit = findingMatching(
      check,
      /a fourth deployable: apps\/identity-reporting\/worker/,
      "check 6 must count the fourth Worker",
    );
    assert.match(hit.constraint, /§7/);
  });

  it("check 7: another Ecoma repository's source must be refused", () => {
    const check = findingsFor(fixtureRun.report, "monorepo-self-contained");
    const hit = findingMatching(
      check,
      /another Ecoma repository: "loom"/,
      "check 7 must catch the vendored loom/ copy",
    );
    assert.match(hit.file, /vendor\/loom/);
  });

  it("check 9: an authentication bypass in production code must be refused", () => {
    const check = findingsFor(fixtureRun.report, "no-auth-bypass");
    const hit = findingMatching(
      check,
      /dev_auth_bypass in apps\/identity\/worker\/src\/dev_auth\.rs/,
      "check 9 must catch the auth bypass in the Identity Worker",
    );
    assert.equal(hit.severity, "violation");
    assert.match(hit.constraint, /§26/);
  });

  it("check 10: a Durable Object binding must be refused", () => {
    const check = findingsFor(fixtureRun.report, "no-authoritative-kv-or-do");
    const hit = findingMatching(
      check,
      /durable_objects binding "SESSION_STORE"/,
      "check 10 must catch the DO binding on the Identity Worker",
    );
    assert.equal(
      hit.severity,
      "violation",
      "a DO is a violation; only KV is a warning",
    );
  });

  it("all ten checks RAN against the fixture, and none of them passed vacuously", () => {
    assert.equal(
      fixtureRun.report.checks.length,
      10,
      "the guard judges exactly ten constraints",
    );
    for (const check of fixtureRun.report.checks) {
      assert.notEqual(
        check.status,
        "error",
        `check "${check.id}" errored: ${check.skipReason ?? "unknown"}`,
      );
    }
    // Every check must either have found something or have a stated reason it
    // could not. A check that reported neither is a check that ran and said
    // nothing, and on a tree built to break it that is indistinguishable from a
    // check that does not work.
    const silent = fixtureRun.report.checks.filter(
      (c) => c.status === "pass" && c.findings.length === 0,
    );
    assert.deepEqual(
      silent.map((c) => c.id),
      [],
      "these checks reported nothing on a tree designed to violate them. Each is either a\n" +
        "check that does not work, or a control case the fixture should no longer hold.",
    );
  });

  it("the canary output names the fixture, so a green real run cannot be the fixture", () => {
    assert.match(
      fixtureRun.stdout,
      /identity-reporting/,
      "the canary run must actually be judging the fixture, not something else",
    );
  });
});

describe("the real tree: what a green run is allowed to claim", () => {
  before(() => {
    // Deliberately NOT shared with the fixture suite. If the canary's setup
    // throws, every assertion in this suite would fail with a confusing
    // "cannot read properties of null" instead of the real cause, and a
    // failing canary would take the real-tree coverage down with it. The two
    // suites answer different questions and neither may hide the other's
    // failure.
    realRun = runGuard(REPO_ROOT);
  });

  it("never walks into the canary fixture", () => {
    assert.equal(
      realRun.stdout.includes("__fixtures__"),
      false,
      "the default run reported a path under tooling/scripts/__fixtures__/.\n" +
        "The fixture is a sub-trell to this guard and the default walk must never enter it:\n" +
        "a run over the real tree has nothing to say about a fixture, and one that does has\n" +
        "stopped certifying the tree it was asked about. The fixture is reached EXPLICITLY,\n" +
        "by --root, and by nothing else — which is also what makes it impossible to make the\n" +
        "canary pass by deleting it.\n\n" +
        realRun.stdout,
    );
  });

  it("does not skip any check because the fixture was skipped", () => {
    // The fixture exclusion must not have become a blanket skip: a run that
    // reported ten skips would be a green run covering nothing, which is the
    // failure this whole script is built to prevent.
    const skipped = realRun.report.skipped.filter((s) =>
      /__fixtures__/.test(s.reason ?? ""),
    );
    assert.deepEqual(skipped, [], "a skip was caused by the fixture exclusion");
  });

  it("prints a coverage banner naming every check that did not run", () => {
    assert.match(
      realRun.stdout,
      /COVERAGE/,
      "every run must end with a coverage banner",
    );
    const banner = realRun.stdout.slice(realRun.stdout.indexOf("COVERAGE"));
    for (const skip of realRun.report.skipped) {
      assert.ok(
        banner.includes(skip.reason.slice(0, 40)),
        `the coverage banner does not mention the skipped step: ${skip.reason}`,
      );
    }
  });

  it("names every finding with a file, a constraint and a fix", () => {
    for (const check of realRun.report.checks) {
      for (const finding of check.findings) {
        assert.ok(finding.file, `a finding in ${check.id} has no file`);
        assert.ok(
          finding.constraint,
          `a finding in ${check.id} has no constraint`,
        );
        assert.ok(finding.fix, `a finding in ${check.id} has no fix`);
      }
    }
  });

  it("declares, for every check, what it does not catch", () => {
    // A check that cannot say what it misses is a check whose boundary is
    // unstated, and an unstated boundary is the one that erodes.
    for (const check of realRun.report.checks) {
      assert.ok(
        check.doesNotCatch && check.doesNotCatch.length > 30,
        `check "${check.id}" does not say what it does not catch`,
      );
      assert.ok(
        check.constraint,
        `check "${check.id}" does not name the constraint it enforces`,
      );
    }
  });
});
