/**
 * `render-wrangler-config.test.mjs` — every environment a deploy can ask for,
 * rendered and checked for the failure mode JSONC invites.
 *
 * WHY THIS FILE EXISTS. `observability` was resolved with
 *
 *     OBSERVABILITY[shape.observability[environment] ?? "production"]
 *
 * which reads correctly and is wrong: the left side is an ENVIRONMENT and the
 * right is a MODE, and `OBSERVABILITY` is keyed by mode (`full`, `local`,
 * `minimal`). For every fixed environment `shape.observability` happened to
 * carry a key, so the fallback never ran. `preview` had no key, the fallback
 * fired, `"production"` was not a mode, and the renderer wrote the literal text
 *
 *     "observability": undefined,
 *
 * into the config. wrangler rejected it on the first PR to exercise the lane
 * (`InvalidSymbol ... 22:19`), which is the deploy-time check working, but the
 * renderer had produced a file that had never been inspected.
 *
 * `pnpm infra:render` cannot catch it, because preview is deliberately excluded
 * from the offline render set — its names are not knowable without a PR number.
 * So this file renders preview too, and asserts the one property that catches
 * the whole class: NO CONFIG MAY CONTAIN THE WORD `undefined`.
 *
 * That is deliberately blunt. A JSONC config with a literal `undefined` is
 * never valid input to wrangler, whatever produced it, so there is no version
 * of this assertion that should be relaxed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RENDER = path.join(
  REPO_ROOT,
  "tooling",
  "scripts",
  "render-wrangler-config.mjs",
);

/** Every deployable `topology.json` declares, so a new one cannot skip this. */
const DEPLOYABLES = ["identity", "identity-admin", "identity-jobs", "home-web"];

/** Every environment, fixed and ephemeral. */
const ENVIRONMENTS = [
  { environment: "production" },
  { environment: "staging" },
  { environment: "development" },
  { environment: "preview", pr: "33" },
];

function render(outDir, { environment, pr }, deployable) {
  const args = [
    RENDER,
    ...(environment === "preview"
      ? ["--stage", "preview"]
      : ["--stage", "offline"]),
    "--environment",
    environment,
    "--deployable",
    deployable,
    "--out-dir",
    outDir,
    "--write",
  ];
  if (pr) args.push("--pr", pr);
  execFileSync(process.execPath, args, { cwd: REPO_ROOT, stdio: "pipe" });
}

function configPath(outDir, environment, deployable) {
  return path.join(
    outDir,
    "cloudflare",
    environment,
    deployable,
    "wrangler.jsonc",
  );
}

for (const target of ENVIRONMENTS) {
  const label = target.pr
    ? `${target.environment} (pr ${target.pr})`
    : target.environment;

  test(`${label}: every deployable renders a config with no undefined`, () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));
    try {
      for (const deployable of DEPLOYABLES) {
        render(outDir, target, deployable);
        const file = configPath(outDir, target.environment, deployable);
        assert.ok(
          fs.existsSync(file),
          `${deployable}: nothing was rendered at ${file}`,
        );

        const text = fs.readFileSync(file, "utf8");
        assert.ok(
          !text.includes("undefined"),
          `${deployable} in ${label} rendered the literal text "undefined", which ` +
            `wrangler rejects as InvalidSymbol. It usually means a lookup fell ` +
            `through to a fallback key that does not exist in the table it ` +
            `indexes:\n${text}`,
        );
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
}

test("every rendered observability block is an object, not a bare mode name", () => {
  // The specific regression, asserted on its own so a failure names the cause
  // rather than requiring a reader to spot the word `undefined` in a diff.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-obs-"));
  try {
    render(outDir, { environment: "preview", pr: "33" }, "identity");
    const text = fs.readFileSync(
      configPath(outDir, "preview", "identity"),
      "utf8",
    );
    const line = text.split("\n").find((l) => l.includes('"observability"'));
    assert.ok(
      line,
      "the identity preview config has no observability block at all",
    );
    assert.match(
      line,
      /"observability"\s*:\s*\{/,
      `observability must render as an inline object; a bare mode name means the ` +
        `table was indexed by environment and got a mode back. Got: ${line}`,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("a preview's names carry the PR number in every resource it declares", () => {
  // The other half of the preview lane's contract, in the file that emits the
  // names. `reconcile-infra.test.mjs` asserts the same property on the
  // descriptor; this one asserts it on the config that is actually uploaded,
  // because a name can be rendered correctly in one and not the other.
  //
  // Only NAMES that this file is responsible for are asserted. A KV namespace
  // and a rate-limit namespace bind by ID, not by name, and those IDs are
  // resolved during the deploy from a Cloudflare listing — so a preview config
  // carries the placeholder `UNRESOLVED_REQUIRES_CLOUDFLARE_CREDENTIAL` there
  // by design, and `deploy-worker.yml` substitutes it. Asserting a KV NAME
  // here would be asserting a property the renderer does not have.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-names-"));
  try {
    const expectations = {
      // The D1 database binds by name; the queue binds by name; the Worker
      // script name is what the deploy uploads under.
      identity: ["ecoma-identity-pr-33", "identity-pr-33"],
      "identity-jobs": ["identity-pr-33", "identity-pr-33-dlq"],
    };
    for (const [deployable, names] of Object.entries(expectations)) {
      render(outDir, { environment: "preview", pr: "33" }, deployable);
      const text = fs.readFileSync(
        configPath(outDir, "preview", deployable),
        "utf8",
      );
      for (const name of names) {
        assert.ok(
          text.includes(name),
          `${deployable}: expected ${name} in the rendered config`,
        );
      }
      assert.ok(
        !text.includes("{pr}"),
        `${deployable}: the rendered config still carries an unrendered template:\n${text}`,
      );
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
