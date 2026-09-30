/**
 * `validate-topology.test.mjs` — canary for the topology declaration.
 *
 * This suite invokes the real validator, not a copy of its rules. A malformed
 * manifest must fail before the renderer or a privileged preview workflow can
 * use it; a test that merely asserted a helper's output would still pass if the
 * actual gate were removed.
 *
 * The mutation tests here are the ones that matter most after the indirection
 * was removed: every one of them adds a way of obtaining a Cloudflare resource
 * id BACK to a manifest that is now purely logical, and each must be rejected.
 * A gate that only checks what the manifest happens to contain today proves
 * nothing about what somebody can add to it tomorrow.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTopology } from "./topology-model.mjs";
import { validateTopology } from "./validate-topology.mjs";

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
  // The temp root must reproduce the REAL layout `loadTopology` expects, or the
  // test would exercise a different tree from the one the validator ships
  // against. `infra-topology/` is the manifest's home; `infra/topology/` no
  // longer exists.
  const directory = path.join(root, "infra-topology");
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "infra-topology", "topology.json"),
    path.join(directory, "topology.json"),
  );
  return root;
}

function readCopiedTopology(root) {
  return loadTopology(root).topology;
}

function messages(topology) {
  return validateTopology(topology)
    .map((error) => error.message)
    .join("\n");
}

describe("deployment topology manifest", () => {
  it("accepts the checked-in topology", () => {
    const { topology } = loadTopology(REPO_ROOT);
    assert.deepEqual(validateTopology(topology), []);
  });

  it("declares the canonical staging and preview home hostnames", () => {
    const { topology } = loadTopology(REPO_ROOT);

    // The home page is the zone apex in production and a prefixed subdomain
    // everywhere else. `stg.ecoma.io` and `pr{pr}.ecoma.io` were once written
    // here and both were wrong: staging never served the apex, and a preview
    // host matching the apex form would be one the preview grammar could not
    // tell apart from a shape it does not own.
    assert.equal(
      topology.environments.staging.hosts["home-web"],
      "stg-home.ecoma.io",
    );
    assert.equal(
      topology.environments.preview.hosts["home-web"],
      "pr{pr}-home.ecoma.io",
    );
    assert.equal(
      topology.environments.production.hosts["home-web"],
      "ecoma.io",
    );

    const hostnameGrammar = new RegExp(topology.preview.grammar.hostname);
    for (const hostname of [
      "pr123-home.ecoma.io",
      "pr123-identity.ecoma.io",
      "pr123-admin.ecoma.io",
    ]) {
      assert.equal(hostnameGrammar.test(hostname), true, hostname);
    }
    assert.equal(hostnameGrammar.test("pr123.ecoma.io"), false);
  });

  it("pins the one Cloudflare account and no other identifier", () => {
    const { topology } = loadTopology(REPO_ROOT);

    assert.equal(topology.account.id, "406bdb82319b162b09bf5f137a156600");
    assert.equal(topology.account.zone, "ecoma.io");
    assert.equal("id_env_var" in topology.account, false);
    assert.equal("id_source" in topology.account, false);
    assert.equal("resource_ids" in topology, false);
  });

  it("rejects a resource-id indirection reintroduced anywhere in the tree", () => {
    for (const [pointer, inject] of [
      [
        "account.id_env_var",
        (t) => (t.account.id_env_var = "CLOUDFLARE_ACCOUNT_ID"),
      ],
      ["account.id_source", (t) => (t.account.id_source = "github-variable")],
      [
        "d1.database_id",
        (t) =>
          (t.environments.production.resources.identity.d1.database_id =
            "$D1_PRODUCTION"),
      ],
      [
        "kv.id",
        (t) =>
          (t.environments.staging.resources.identity.kv.id =
            "$KV_IDENTITY_STAGING"),
      ],
      [
        "resource_ids",
        (t) =>
          (t.resource_ids = {
            overlay_file: "topology.local.json",
            sources: {},
          }),
      ],
      [
        "email.env_var",
        (t) =>
          (t.environments.production.email.env_var =
            "PRODUCTION_EMAIL_PROVIDER"),
      ],
      [
        "secret_name",
        (t) =>
          (t.environments.production.email.secret_name = "PRODUCTION_EMAIL"),
      ],
    ]) {
      const root = copyTopology();
      const topology = readCopiedTopology(root);
      inject(topology);
      assert.match(
        messages(topology),
        /resource-id indirection/,
        `${pointer} was accepted; the manifest must not carry a way to resolve an id`,
      );
    }
  });

  it("rejects a $TOKEN placeholder in any environment", () => {
    for (const environment of [
      "production",
      "staging",
      "development",
      "preview",
    ]) {
      const root = copyTopology();
      const topology = readCopiedTopology(root);
      topology.environments[environment].resources.identity.queue.dlq =
        "$DLQ_PLACEHOLDER";

      assert.match(
        messages(topology),
        /is the placeholder "\$DLQ_PLACEHOLDER"/,
        `${environment} accepted a placeholder; nothing can resolve it`,
      );
    }
  });

  it("rejects a committed literal Cloudflare resource id", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.production.resources.identity.kv.name =
      "01234567-89ab-cdef-0123-456789abcdef";

    assert.match(messages(topology), /never commit a literal Cloudflare id/);
  });

  it("rejects a cookie namespace shared across environments", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.cookie_namespaces.staging = topology.cookie_namespaces.production;

    assert.match(
      messages(topology),
      /must not share a cookie name across environments/,
    );
  });

  it("rejects a cookie name that disagrees with its environment's prefix", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.cookie_namespaces.staging = "ecoma_pr_locale";

    assert.match(messages(topology), /cookie_prefix/);
  });

  it("rejects a fixed resource name that also matches the preview grammar", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    // A staging Worker named as a preview would let a cleanup run classify it
    // as disposable on the strength of the grammar alone.
    topology.environments.staging.resources["identity-admin"].worker =
      "identity-admin-pr-999";

    assert.match(messages(topology), /also matches preview\.grammar\.worker/);
  });

  it("rejects a preview that has fewer than three public custom domains", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.limits.custom_domains_per_preview = 2;

    assert.match(messages(topology), /identity, admin and home custom domains/);
  });

  it("rejects a public workers.dev endpoint outside development", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.preview.workers_dev = true;

    assert.match(
      messages(topology),
      /no undeclared workers\.dev public entrypoint/,
    );
  });

  it("rejects a staging issuer that does not match the staging identity hostname", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.staging.issuer_base_url =
      "https://identity-staging.ecoma.io";

    assert.match(messages(topology), /canonical staging identity hostname/);
  });

  it("rejects a rate-limit namespace shared with production", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.environments.staging.ratelimits.identity.namespace_id = "1001";

    assert.match(messages(topology), /must not share a rate-limit namespace/);
  });

  it("rejects a preview cleanup policy that treats unknown PR state as deletable", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.preview.evidence.on_unknown = "delete";

    assert.match(
      messages(topology),
      /must fail closed when GitHub cannot prove a PR is closed/,
    );
  });

  it("rejects a preview grammar that could not recognise its own D1 name", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.preview.grammar.d1 = "^ecoma-identity-production$";

    assert.match(
      messages(topology),
      /must recognise canonical preview resource ecoma-identity-pr-123/,
    );
  });

  it("rejects a hostname grammar that claims the bare apex form", () => {
    const root = copyTopology();
    const topology = readCopiedTopology(root);
    topology.preview.grammar.hostname = "^pr[0-9]+(?:-home)?\\.ecoma\\.io$";

    assert.match(messages(topology), /must not match the bare apex form/);
  });
});
