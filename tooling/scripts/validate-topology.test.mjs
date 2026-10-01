/**
 * `validate-topology.test.mjs` — canary for the topology declaration.
 *
 * This suite invokes the real validator, not a copy of its rules. A malformed
 * manifest must fail before the renderer or a privileged preview workflow can
 * use it; a test that merely asserted a helper's output would still pass if the
 * actual gate were removed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { readTopology, validateTopology } from "./validate-topology.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function copyTopology() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecoma-topology-"));
  temporaryRoots.push(root);
  const directory = path.join(root, "infra", "topology");
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "infra", "topology", "topology.json"),
    path.join(directory, "topology.json"),
  );
  return root;
}

function readCopiedTopology(root) {
  return readTopology(root).topology;
}

describe("deployment topology manifest", () => {
  it("accepts the checked-in topology", () => {
    const { topology } = readTopology(REPO_ROOT);
    assert.deepEqual(validateTopology(topology), []);
  });

  it("declares the canonical staging and preview home hostnames", () => {
    const { topology } = readTopology(REPO_ROOT);

    assert.equal(
      topology.environments.staging.hosts["home-web"],
      "stg.ecoma.io",
    );
    assert.equal(
      topology.environments.preview.hosts["home-web"],
      "pr{pr}.ecoma.io",
    );

    const hostnameGrammar = new RegExp(topology.preview.grammar.hostname);
    for (const hostname of [
      "pr123.ecoma.io",
      "pr123-identity.ecoma.io",
      "pr123-admin.ecoma.io",
    ]) {
      assert.equal(hostnameGrammar.test(hostname), true);
    }
    assert.equal(hostnameGrammar.test("pr123-home.ecoma.io"), false);
  });

  it("rejects a preview that has fewer than three public custom domains", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.limits.custom_domains_per_preview = 2;

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /identity, admin and home custom domains/,
    );
  });

  it("rejects a public workers.dev endpoint outside development", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.preview.workers_dev = true;

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /no undeclared workers\.dev public entrypoint/,
    );
  });

  it("rejects a staging issuer that does not match the staging identity hostname", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.staging.issuer_base_url =
      "https://identity-staging.ecoma.io";

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /canonical staging identity hostname/,
    );
  });

  it("rejects a rate-limit namespace shared with production", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.staging.ratelimits.identity.namespace_id = "1001";

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /must not share a rate-limit namespace/,
    );
  });

  it("rejects a committed literal Cloudflare resource id", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.production.resources.identity.d1.database_id =
      "01234567-89ab-cdef-0123-456789abcdef";

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /never commit a literal Cloudflare id/,
    );
  });

  it("rejects a preview cleanup policy that treats unknown PR state as deletable", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.preview.evidence.on_unknown = "delete";

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /must fail closed when GitHub cannot prove a PR is closed/,
    );
  });

  it("rejects a preview grammar that could not recognise its own D1 name", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.preview.grammar.d1 = "^ecoma-identity-production$";

    assert.match(
      validateTopology(topology)
        .map((error) => error.message)
        .join("\n"),
      /must recognise canonical preview resource ecoma-identity-pr-123/,
    );
  });
});
