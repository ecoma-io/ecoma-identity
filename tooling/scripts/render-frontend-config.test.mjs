/**
 * `render-frontend-config.test.mjs` — the browser-safe projection.
 *
 * The projection is the only thing in this repository that a JavaScript bundle
 * is allowed to read about a deployment, and the whole safety argument for it
 * rests on it being built by WHITELIST rather than by subtracting keys from the
 * deployment descriptor. That is the property under test: the descriptor beside
 * it carries an account id and every resource name in the platform, and a
 * frontend that could read it would have a path to all of them.
 *
 * These tests invoke the real loader and the real projection. A test that
 * asserted a hand-written fixture would still pass if `buildFrontendConfig`
 * were deleted.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadFrontendSupport,
  loadTopology,
  TopologyError,
} from "./topology-model.mjs";
import { buildConfig, main } from "./render-wrangler-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

const { topology } = loadTopology(REPO_ROOT);
const { support } = loadFrontendSupport(REPO_ROOT);

function project(environment, pr) {
  return buildConfig({
    topology,
    support,
    environment,
    deployable: "identity",
    pr,
    descriptor: null,
    configDirAbs: path.join(
      REPO_ROOT,
      ".generated",
      "cloudflare",
      environment,
      "identity",
    ),
  }).frontend;
}

/** Every environment, with the PR number preview requires. */
const ENVIRONMENTS = ["production", "staging", "development", "preview"];

describe("the frontend projection", () => {
  it("carries no account id, resource name or email provider for any environment", () => {
    // The negative assertion, and the reason the file exists. Every one of
    // these strings is a real value in the topology; a projection that leaked
    // any of them would hand a browser bundle the platform's infrastructure.
    //
    // `account.zone` is deliberately NOT on this list, and the omission is not
    // an oversight. The apex is a public hostname — it is the address of the
    // website, printed on every page — so the projection is SUPPOSED to contain
    // it as a cookie domain and a base URL. What must not reach a browser
    // bundle is the account that owns the zone, not the zone itself.
    const forbidden = [
      topology.account.id,
      ...Object.values(topology.environments).flatMap((environment) =>
        Object.values(environment.resources ?? {}).flatMap((resource) => [
          resource.worker,
          resource.d1?.name,
          resource.kv?.name,
          resource.queue?.name,
          resource.queue?.dlq,
        ]),
      ),
      ...Object.values(topology.environments).map(
        (environment) => environment.email?.service,
      ),
    ].filter((value) => typeof value === "string" && value.length > 0);

    for (const environment of ENVIRONMENTS) {
      const serialised = JSON.stringify(
        project(environment, environment === "preview" ? 7 : undefined),
      );
      for (const value of forbidden) {
        assert.ok(
          !serialised.includes(value),
          `${environment} projection leaks ${JSON.stringify(value)}`,
        );
      }
    }
  });

  it("names the cookie per environment, and never shares one domain across previews", () => {
    // The property issue #17 is about: production and staging must not read one
    // cookie, and neither must two previews. Distinct names are what makes that
    // true; the domain is the second half, because a preview writing the zone
    // apex would still be readable by every other host under it.
    const names = ENVIRONMENTS.map(
      (environment) =>
        project(environment, environment === "preview" ? 7 : undefined).cookie
          .name,
    );
    assert.equal(new Set(names).size, names.length, `names collide: ${names}`);

    assert.equal(
      project("production").cookie.domain,
      topology.account.zone,
      "production is the only environment that serves the zone apex",
    );
    for (const environment of ["staging", "development", "preview"]) {
      assert.equal(
        project(environment, environment === "preview" ? 7 : undefined).cookie
          .domain,
        null,
        `${environment} must not scope a cookie to the zone apex`,
      );
    }
  });

  it("builds baseUrl from home-web's host, not from whichever deployable is rendering", () => {
    // `buildConfig` receives a deployable and returns a per-deployable `host`,
    // but the emitted file is per-ENVIRONMENT. A `baseUrl` taken from the loop
    // would be the admin host in a file the public site reads to build its
    // canonicals — so this asserts across deployables, not just against a
    // literal.
    for (const deployable of [
      "identity",
      "identity-admin",
      "identity-jobs",
      "home-web",
    ]) {
      const rendered = buildConfig({
        topology,
        support,
        environment: "production",
        deployable,
        descriptor: null,
        configDirAbs: path.join(
          REPO_ROOT,
          ".generated",
          "cloudflare",
          "production",
          deployable,
        ),
      }).frontend;
      assert.equal(
        rendered.baseUrl,
        `https://${topology.environments.production.hosts["home-web"]}`,
        `${deployable} rendered a baseUrl that is not the public site's host`,
      );
    }
  });

  it("never lets a staging or preview build emit the production apex", () => {
    // The duplicate-content bug: a preview indexed under production's canonical
    // is a page that competes with the real site in search results.
    for (const [environment, pr] of [
      ["staging", undefined],
      ["preview", 123],
    ]) {
      const rendered = project(environment, pr);
      assert.notEqual(rendered.baseUrl, `https://${topology.account.zone}`);
      assert.ok(
        rendered.baseUrl.includes(
          topology.environments[environment].hosts["home-web"].replace(
            "{pr}",
            String(pr ?? "{pr}"),
          ),
        ),
        `${environment} baseUrl ${rendered.baseUrl} is not its own host`,
      );
    }
  });

  it("carries the vocabulary rather than inventing one", () => {
    const rendered = project("production");
    assert.deepEqual(rendered.supportedLocales, support.supportedLocales);
    assert.equal(rendered.defaultLocale, support.defaultLocale);
    assert.ok(rendered.supportedLocales.includes(rendered.defaultLocale));
  });

  it("is inert where a deployment has no public host", () => {
    // Development has no host at all. `null` rather than a guess: a base URL
    // that resolved to something plausible would produce canonicals pointing at
    // a host that does not answer.
    assert.equal(project("development").baseUrl, null);
  });
});

describe("loadFrontendSupport", () => {
  function writeSupport(contents) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "ecoma-frontend-support-"),
    );
    temporaryRoots.push(root);
    const dir = path.join(root, "infra-topology");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "frontend-support.json"),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
    return root;
  }

  it("refuses a default locale that is not among the supported ones", () => {
    // The combination that ships a locale rendering missing keys: the document
    // claims a default the application holds no catalog for.
    assert.throws(
      () =>
        loadFrontendSupport(
          writeSupport({
            supportedLocales: ["en", "vi"],
            defaultLocale: "zh",
            defaultColorMode: "system",
          }),
        ),
      (error) =>
        error instanceof TopologyError &&
        /not in supportedLocales/.test(error.message),
    );
  });

  it("refuses a duplicate locale, because a list that repeats one is not a vocabulary", () => {
    assert.throws(
      () =>
        loadFrontendSupport(
          writeSupport({
            supportedLocales: ["en", "vi", "en"],
            defaultLocale: "en",
            defaultColorMode: "system",
          }),
        ),
      (error) =>
        error instanceof TopologyError && /duplicates/.test(error.message),
    );
  });

  it("refuses a value that is not a language tag", () => {
    assert.throws(
      () =>
        loadFrontendSupport(
          writeSupport({
            supportedLocales: ["english"],
            defaultLocale: "english",
            defaultColorMode: "system",
          }),
        ),
      (error) => error instanceof TopologyError && /BCP 47/.test(error.message),
    );
  });

  it("refuses a colour mode outside the three the applications can render", () => {
    assert.throws(
      () =>
        loadFrontendSupport(
          writeSupport({
            supportedLocales: ["en"],
            defaultLocale: "en",
            defaultColorMode: "auto",
          }),
        ),
      (error) =>
        error instanceof TopologyError &&
        /defaultColorMode/.test(error.message),
    );
  });

  it("names the file in its own failure, because 'it failed' is not a diagnosis", () => {
    assert.throws(
      () => loadFrontendSupport(writeSupport("{ not json")),
      (error) =>
        error instanceof TopologyError &&
        /frontend-support\.json is not valid JSON/.test(error.message),
    );
  });

  it("reports a missing file by path rather than by stack trace", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "ecoma-frontend-support-"),
    );
    temporaryRoots.push(root);
    assert.throws(
      () => loadFrontendSupport(root),
      (error) =>
        error instanceof TopologyError && /could not read/.test(error.message),
    );
  });
});

describe("writing outside the repository", () => {
  // The one output that is not under `--out-dir`: the vocabulary copy the
  // preference package imports. It has to live in the repository, so the guard
  // is that a run told to write SOMEWHERE ELSE leaves the checkout alone.
  //
  // This is a regression test for a real defect, not a hypothetical: the copy
  // was written from inside the per-deployable body to a REPO_ROOT-derived
  // path, so `--out-dir /tmp/scratch` still rewrote a tracked file. It reached
  // review and merge without a gate noticing, which is why it is asserted here
  // rather than left to the renderer's incidental behaviour.
  it("does not rewrite the tracked vocabulary copy when --out-dir points elsewhere", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ecoma-render-"));
    temporaryRoots.push(scratch);

    const tracked = path.join(
      REPO_ROOT,
      "packages",
      "frontend-preferences",
      "frontend-support.json",
    );
    const before = fs.readFileSync(tracked, "utf8");

    const code = main([
      "--stage",
      "offline",
      "--environment",
      "development",
      "--deployable",
      "home-web",
      "--out-dir",
      scratch,
      "--write",
    ]);

    assert.equal(code, 0, "the render itself should still succeed");
    assert.equal(
      fs.readFileSync(tracked, "utf8"),
      before,
      "a render told to write into a scratch directory must not touch the checkout",
    );
    assert.ok(
      fs.existsSync(path.join(scratch, "cloudflare", "development")),
      "and it must still have written its own tree where it was told to",
    );
  });

  it("does refresh the tracked copy for a default render, so the guard is not a skip", () => {
    const tracked = path.join(
      REPO_ROOT,
      "packages",
      "frontend-preferences",
      "frontend-support.json",
    );
    const before = fs.readFileSync(tracked, "utf8");

    // Corrupt it, then let a default-out-dir render repair it. If the guard
    // were simply "never write this file", the next `pnpm verify` would pass
    // against a stale copy and the package would read a vocabulary no gate
    // agrees with — which is the failure the generated copy exists to prevent.
    fs.writeFileSync(tracked, "{ CORRUPTED", "utf8");
    try {
      const code = main([
        "--stage",
        "offline",
        "--environment",
        "development",
        "--deployable",
        "home-web",
        "--write",
      ]);
      assert.equal(code, 0);
      assert.equal(
        fs.readFileSync(tracked, "utf8"),
        before,
        "a default render must restore the copy byte for byte",
      );
    } finally {
      fs.writeFileSync(tracked, before, "utf8");
    }
  });
});
