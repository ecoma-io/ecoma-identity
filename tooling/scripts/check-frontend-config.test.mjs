/**
 * `check-frontend-config.test.mjs` — the coherence gate's own tests.
 *
 * A gate nobody has proved fires is a gate nobody can trust, and this one is
 * load-bearing for a property that is easy to state and easy to lose: three
 * frontends must not each hold a copy of the same constant. So these tests do
 * two things — they assert the gate PASSES on the current tree, which is the
 * state after the migration, and they plant violations in a fixture and assert
 * it FAILS, which is the state it exists to prevent.
 *
 * The mutation tests are the ones that matter. `main()` reads the real
 * repository, so each mutation writes into a temporary tree that reproduces the
 * layout `main()` expects and points it there. A test that only asserted the
 * happy path would still pass if the scan were quietly disabled.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const GATE = path.join(SCRIPT_DIR, "check-frontend-config.mjs");

const temporaryRoots = [];
afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function runGate() {
  try {
    // stdout is kept on SUCCESS, not only on failure: the green-path test
    // asserts what the gate says when it is happy, and a helper that returned
    // "" whenever there was nothing to complain about would make that
    // assertion vacuous.
    const stdout = execFileSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * A tree the gate will run against: the real configuration files, and one
 * frontend source file whose contents the test chooses.
 *
 * `infra-topology/` is copied rather than referenced because the gate resolves
 * the support file relative to its own repository root, and a fixture that
 * pointed at the real one would let a mutation test pass for the wrong reason.
 */
function fixtureWith(file) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecoma-frontend-gate-"));
  temporaryRoots.push(root);

  fs.cpSync(
    path.join(REPO_ROOT, "infra-topology"),
    path.join(root, "infra-topology"),
    {
      recursive: true,
    },
  );
  fs.cpSync(path.join(REPO_ROOT, "tooling"), path.join(root, "tooling"), {
    recursive: true,
    filter: (source) => !source.includes("__fixtures__"),
  });
  fs.mkdirSync(path.join(root, "packages", "frontend-preferences"), {
    recursive: true,
  });
  fs.cpSync(
    path.join(
      REPO_ROOT,
      "packages",
      "frontend-preferences",
      "frontend-support.json",
    ),
    path.join(
      root,
      "packages",
      "frontend-preferences",
      "frontend-support.json",
    ),
  );

  const target = path.join(root, "apps", "identity", "web", "src", "plugin.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file, "utf8");
  return root;
}

function runGateIn(root) {
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "tooling", "scripts", "check-frontend-config.mjs")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    return { code: 0, output: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("check-frontend-config on the current tree", () => {
  // It was RED on `main` until this branch migrated the last of the copies:
  // `nuxt.config.ts` declared the cookie name, the domain and the base URL a
  // second time, and `layouts/default.vue` named a locale in code. That is issue
  // #17, and a gate that had gone green while those copies existed would not have
  // been a gate.
  //
  // So this test asserts the gate is GREEN now — which is a stronger statement
  // than the red one it replaced. That migration is the only thing that made it
  // green, and the mutation tests below are what make the green mean something:
  // a tree with the old copies back in it fails again.
  it("reports that every preference value has one owner", () => {
    const { code, output } = runGate();
    assert.equal(
      code,
      0,
      "the gate found a second owner after the migration:\n" + output,
    );
    assert.match(output, /one owner each/);
  });

  it("would still have been red on main's copies", () => {
    // The regression that gives the test above its meaning. `main`'s
    // `nuxt.config.ts` lines, verbatim, back in a fixture: the gate has to fire
    // on exactly these, or it never did and the green is luck.
    const mainHardcodes = [
      'export const cookieKey = "ecoma_prod_locale";',
      'export const cookieDomain = ".ecoma.io";',
      'export const baseUrl = "https://ecoma.io";',
      'const locale = "vi";',
    ];
    for (const source of mainHardcodes) {
      const { code } = runGateIn(fixtureWith(source));
      assert.notEqual(code, 0, `the gate no longer catches: ${source}`);
    }
  });
});

describe("check-frontend-config rejects a second owner", () => {
  const violations = [
    {
      what: "the pre-namespace cookie name",
      source: 'export const key = "ecoma_locale";',
      expect: /ecoma_locale/,
    },
    {
      what: "one environment's cookie name written as if it were every environment's",
      source: 'export const key = "ecoma_prod_locale";',
      expect: /ecoma_prod_locale/,
    },
    {
      what: "the zone apex as a cookie domain",
      source: 'export const domain = ".ecoma.io";',
      expect: /zone apex/,
    },
    {
      what: "the production apex as a literal base URL",
      source: 'export const baseUrl = "https://ecoma.io";',
      expect: /production apex/,
    },
    {
      what: "a locale literal in code",
      source: 'const locale = "vi";',
      expect: /locale literal/,
    },
    {
      what: "a colour-mode default bound by an initialiser",
      source: 'export const mode = "system";',
      expect: /colour-mode default/,
    },
    {
      what: "a colour-mode default on a property named `default`",
      source: 'const support = { defaultColorMode: "system" };',
      expect: /colour-mode default/,
    },
    {
      what: "a colour-mode default used as a parameter default",
      source: 'function paint(mode = "system") { return mode; }',
      expect: /colour-mode default/,
    },
  ];

  for (const violation of violations) {
    it(`rejects ${violation.what}`, () => {
      const { code, output } = runGateIn(fixtureWith(violation.source));
      assert.notEqual(
        code,
        0,
        "the gate passed a tree it should have rejected",
      );
      assert.match(output, violation.expect);
    });
  }

  it("rejects a support copy that has drifted from its source", () => {
    // The copy is written by the renderer, so drift means somebody edited the
    // generated file — or edited the source without re-rendering. Either way
    // the package and the projection would ship different vocabularies.
    const root = fixtureWith("export const fine = 1;");
    fs.writeFileSync(
      path.join(
        root,
        "packages",
        "frontend-preferences",
        "frontend-support.json",
      ),
      `${JSON.stringify(
        {
          supportedLocales: ["en", "vi", "zh"],
          defaultLocale: "en",
          defaultColorMode: "system",
        },
        null,
        2,
      )}\n`,
    );
    const { code, output } = runGateIn(root);
    assert.notEqual(code, 0);
    assert.match(output, /generated copy declares/);
  });

  // A NARROWED RULE FAILS BY PASSING. Every rejection above proves the gate
  // fires; none of them proves it still fires. `"system"` is a member of the
  // `ColorMode` union, so `mode === "system"` and the offered-modes array are
  // how that type is written, not a fact restated — and an earlier version of
  // this rule rejected both, which was correct for neither. These are the shapes
  // it must catch anyway.
  const stillForbidden = [
    {
      what: "a colour-mode default behind a typed initialiser",
      source:
        'const DEFAULT_MODE: ColorMode = "system";\nexport { DEFAULT_MODE };',
    },
    {
      what: "a colour-mode default in a nested options object",
      source: 'export const theme = { color: { defaultColorMode: "system" } };',
    },
    {
      what: "a colour-mode default on a class field",
      source: 'class Theme {\n  defaultColorMode = "system";\n}',
    },
    {
      what: "a colour-mode default returned from a resolver",
      source:
        'export function defaultMode(): ColorMode {\n  return "system";\n}',
    },
  ];

  for (const shape of stillForbidden) {
    it(`still rejects ${shape.what}`, () => {
      const { code, output } = runGateIn(fixtureWith(shape.source));
      assert.notEqual(
        code,
        0,
        "the narrowed rule stopped catching this, which is what a rule narrowed " +
          "too far looks like",
      );
      assert.match(output, /colour-mode default/);
    });
  }

  // And the shapes that made the rule wrong: each is TypeScript, not a second
  // owner. If any of these fails, the rule has re-narrowed into uselessness.
  const legitimate = [
    {
      what: "comparing a mode against the union's system member",
      source:
        'export function isSystem(mode: ColorMode): boolean {\n  return mode === "system";\n}',
    },
    {
      what: "offering the three modes a visitor may choose",
      source:
        'const OFFERED: readonly ColorMode[] = ["system", "light", "dark"];\nexport { OFFERED };',
    },
    {
      what: "narrowing an unknown value before applying it",
      source:
        'if (readColorMode() !== "system") {\n  return;\n}\napplyColorMode("dark");',
    },
    {
      what: "reading the default from the projection",
      source:
        'import cfg from "@ecoma-io/frontend-preferences";\nexport const mode = cfg.defaultColorMode;',
    },
  ];

  for (const shape of legitimate) {
    it(`accepts ${shape.what}`, () => {
      const { code, output } = runGateIn(fixtureWith(shape.source));
      assert.equal(
        code,
        0,
        "the gate rejected TypeScript rather than a second owner:\n" + output,
      );
    });
  }

  it("reports a missing support copy as something to render, not as silence", () => {
    const root = fixtureWith("export const fine = 1;");
    fs.rmSync(
      path.join(
        root,
        "packages",
        "frontend-preferences",
        "frontend-support.json",
      ),
    );
    const { code, output } = runGateIn(root);
    assert.notEqual(code, 0);
    assert.match(output, /pnpm infra:render/);
  });

  it("does not flag a locale named in a comment", () => {
    // The precision that keeps the gate usable. `plugins/i18n.ts` explains its
    // message cache by referring to `vi` in prose, and `nuxt.config.ts` explains
    // the prerender trap the same way. A gate that cried wolf on the repository
    // it ships in would be disabled within a week.
    const { code, output } = runGateIn(
      fixtureWith(
        "// the cache means two components asking for `vi` share one fetch\nexport const fine = 1;",
      ),
    );
    assert.equal(code, 0, `prose about a locale was flagged:\n${output}`);
  });

  it("still flags a comment naming the un-namespaced cookie", () => {
    // The mirror image, and deliberate: #17 was held together by exactly such a
    // comment, and the comment is what failed. Prose about a LOCALE is fine;
    // prose asserting that a hardcoded name is correct is the failure mode.
    const { code, output } = runGateIn(
      fixtureWith(
        '// must match cookieKey in nuxt.config.ts\nexport const key = "ecoma_locale";',
      ),
    );
    assert.notEqual(code, 0);
    assert.match(output, /ecoma_locale/);
  });

  it("does not flag an HTML shell's pre-hydration lang attribute", () => {
    // `<html lang="en">` cannot be anything else: it must parse before any
    // module has run. `initializeI18n` overwrites `document.documentElement.lang`
    // on the value that actually matters.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecoma-frontend-gate-"));
    temporaryRoots.push(root);
    fs.cpSync(
      path.join(REPO_ROOT, "infra-topology"),
      path.join(root, "infra-topology"),
      {
        recursive: true,
      },
    );
    fs.cpSync(path.join(REPO_ROOT, "tooling"), path.join(root, "tooling"), {
      recursive: true,
      filter: (source) => !source.includes("__fixtures__"),
    });
    fs.mkdirSync(path.join(root, "packages", "frontend-preferences"), {
      recursive: true,
    });
    fs.cpSync(
      path.join(
        REPO_ROOT,
        "packages",
        "frontend-preferences",
        "frontend-support.json",
      ),
      path.join(
        root,
        "packages",
        "frontend-preferences",
        "frontend-support.json",
      ),
    );
    const shell = path.join(root, "apps", "identity", "web", "index.html");
    fs.mkdirSync(path.dirname(shell), { recursive: true });
    fs.writeFileSync(
      shell,
      '<!doctype html>\n<html lang="en">\n<body></body>\n</html>\n',
    );
    const { code, output } = runGateIn(root);
    assert.equal(code, 0, `the static shell's lang was flagged:\n${output}`);
  });
});
