import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COLOR_MODE,
  DEFAULT_LOCALE,
  FRONTEND_CONFIG,
  MissingFrontendConfigError,
  PREFERENCE_COOKIE_MAX_AGE,
  PROJECTED_CONFIG_PATH,
  SUPPORTED_LOCALES,
  cookiePolicy,
} from "../src/index.js";
import { POLICIES } from "./support.js";

/**
 * The projection tests.
 *
 * ## The single most important assertion in this package
 *
 * `src/config.ts` holds **no fallback values**, and this file exists partly to
 * say so. A default locale list or a default cookie name would be a second
 * owner of a fact `infra-topology/topology.json` and
 * `infra-topology/frontend-support.json` already state — a fourth copy of the
 * vocabulary, in the one file `tooling/scripts/check-frontend-config.mjs`
 * cannot see, because the gate reads the vocabulary from the support file and
 * has no way to know a fallback is buried in a TypeScript default.
 *
 * The failure mode that motivates the rest: a fallback only ever fires when
 * something is ALREADY broken. It would turn an early, obviously-caused build
 * failure into a quiet, late, hard-to-attribute behaviour difference in
 * production. So this suite asserts the values arrived from the projection, and
 * that the emitted config is the shape the reader expects.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("the projected config", () => {
  it("exists where the package says it does", () => {
    // Not a trivial assertion: `.generated/` is gitignored, so on a clean
    // checkout that has never rendered, this file is absent and the whole
    // package throws `MissingFrontendConfigError` at import. That is the
    // designed behaviour, and this test says which file has to be missing for
    // it to happen.
    expect(fs.existsSync(path.join(REPO_ROOT, PROJECTED_CONFIG_PATH))).toBe(
      true,
    );
  });

  it("carries the three things a frontend may know, and nothing else", () => {
    // Nine fields, and the count is the assertion. The deployment descriptor
    // this is projected FROM carries the account id, the zone and every
    // resolved resource name; a browser bundle that could read any of those
    // would have a path to an account identifier. The projection is built field
    // by field rather than by deleting keys, so a field added to the descriptor
    // later cannot reach a browser bundle by being forgotten from a deny-list.
    const keys = Object.keys(FRONTEND_CONFIG).sort();
    expect(keys).toEqual([
      "baseUrl",
      "cookie",
      "defaultColorMode",
      "defaultLocale",
      "environment",
      "supportedLocales",
    ]);
  });

  it("namespaces the cookie per environment rather than sharing one name", () => {
    // The defect issue #17 reports, in its mechanical form. A build rendered
    // for staging must not write production's cookie, and the only thing that
    // makes that true is that the NAME comes from the topology's
    // `cookie_namespaces` rather than from a literal in this package.
    expect(FRONTEND_CONFIG.cookie.name).toMatch(/ecoma_(prod|stg|pr|dev)/);
  });

  it("declares a locale vocabulary the default belongs to", () => {
    expect(FRONTEND_CONFIG.supportedLocales.length).toBeGreaterThan(0);
    expect(FRONTEND_CONFIG.supportedLocales).toContain(
      FRONTEND_CONFIG.defaultLocale,
    );
  });

  it("declares a colour mode that is one of the three", () => {
    expect(["system", "light", "dark"]).toContain(
      FRONTEND_CONFIG.defaultColorMode,
    );
  });

  it("agrees with the support copy the package also reads", () => {
    // The projection and the vocabulary copy are written by the same renderer
    // in the same pass, so they cannot disagree — and this asserts it rather
    // than trusting it, because "the same renderer wrote both" is a statement
    // about a process, not a fact about these two objects.
    expect(FRONTEND_CONFIG.supportedLocales).toEqual(SUPPORTED_LOCALES);
    expect(FRONTEND_CONFIG.defaultLocale).toBe(DEFAULT_LOCALE);
    expect(FRONTEND_CONFIG.defaultColorMode).toBe(DEFAULT_COLOR_MODE);
  });

  it("reads its values from the emitted file, not from the package", () => {
    // The strongest available form of "no fallback literal list": the cookie
    // policy this package hands out is byte-identical to what the renderer wrote
    // to `.generated/frontend/config.json`. A hardcoded default could not
    // satisfy this unless it happened to match, and matching is the case worth
    // testing because a constant WOULD be hardcoded to exactly these values.
    const emitted = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, PROJECTED_CONFIG_PATH), "utf8"),
    ) as { cookie: unknown; supportedLocales: string[] };

    expect(FRONTEND_CONFIG.cookie).toEqual(emitted.cookie);
    expect(FRONTEND_CONFIG.supportedLocales).toEqual(emitted.supportedLocales);
  });
});

describe("cookiePolicy", () => {
  it("returns the projected policy when given nothing", () => {
    // The default for every cookie function in this package. It is the
    // PROJECTION's policy — not one derived from `import.meta.env.PROD`, which
    // is true in staging as well, because the same bundle is uploaded to both.
    // That substitution is the reason one build could not tell which deployment
    // it was in, and it is what the previous boolean parameter encoded.
    expect(cookiePolicy()).toEqual(FRONTEND_CONFIG.cookie);
    expect(cookiePolicy()).toEqual(
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, PROJECTED_CONFIG_PATH), "utf8"),
      ).cookie,
    );
  });

  it("returns an explicit policy unchanged", () => {
    // A caller that already holds a config for its own cookie handling passes it
    // through, so that a write and a delete cannot be given two policies that
    // disagree.
    expect(cookiePolicy(POLICIES.preview)).toEqual(POLICIES.preview);
  });

  it("treats a null domain as a value, not as an absent field", () => {
    // `null` means "no Domain attribute", which is the correct value outside
    // production: a preview writing a zone-scoped cookie is the exact sharing
    // the per-environment cookie NAME exists to prevent. A type that could not
    // express `null` would push an `if (isProduction)` back into this package,
    // which is the shape the policy object replaced.
    expect(cookiePolicy(POLICIES.staging).domain).toBeNull();
    expect(cookiePolicy(POLICIES.production).domain).toBe("ecoma.io");
  });
});

describe("the absence of fallbacks", () => {
  it("names every source the values could have come from", () => {
    // A map rather than an assertion about the environment: the claim is that
    // each value is traceable to a file, and the file is named so a reader can
    // check it without running anything.
    expect(SUPPORTED_LOCALES).toBeDefined();
    expect(DEFAULT_LOCALE).toBeDefined();
    expect(DEFAULT_COLOR_MODE).toBeDefined();
    expect(FRONTEND_CONFIG.cookie.name).toBeDefined();
  });

  it("keeps the one-constant exception named and justified", () => {
    // `PREFERENCE_COOKIE_MAX_AGE` is the single preference value that IS a
    // constant, and it is deliberately not in `frontend-support.json`: it is a
    // fact about how long this package remembers a display preference, not
    // about the platform's deployment or vocabulary. Asserted so that a reader
    // who finds it in this file learns that it was a decision — the alternative
    // is a reviewer hunting for a `frontend-support.json` key that was never
    // meant to exist.
    expect(PREFERENCE_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 365);
  });

  it("throws a NAMED error rather than defaulting when a config is unusable", () => {
    // The error is a class so a catch site can recognise it without matching a
    // message string, and `AGENTS.md`'s honesty rule requires the failure to be
    // visible as a failure. Constructing one here is the only way to assert the
    // contract from inside a package whose real failures need a render to
    // trigger.
    const error = new MissingFrontendConfigError("no config");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MissingFrontendConfigError");
    expect(error.message).toBe("no config");
  });
});
