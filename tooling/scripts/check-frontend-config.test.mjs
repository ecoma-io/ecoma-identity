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
    execFileSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { code: 0, output: "" };
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
  it("reports only the duplicate owners this branch has not yet migrated", () => {
    // The gate is RED on `main`, by design and by evidence: `nuxt.config.ts`
    // declares the cookie name, the domain and the base URL a second time, and
    // `layouts/default.vue` names a locale in code. That is issue #17, and a
    // gate that went green while those copies existed would not be a gate.
    //
    // So this test asserts the gate FIRES, and — just as importantly — that it
    // names exactly the files the migration is about to rewrite and nothing
    // else. The second half is the part that carries: if a future change added a
    // sixth owner in a new application, this list would have to change, and
    // whoever changed it would be looking at the offending file.
    const { code, output } = runGate();
    assert.notEqual(
      code,
      0,
      "the gate passed a tree that still has duplicate owners",
    );

    // The gate reports one line per OFFENCE, so a file with three hardcoded
    // values appears three times. Deduplicated here, because what this test is
    // about is WHICH FILES carry a duplicate owner.
    const named = [
      ...new Set(
        output
          .split("\n")
          .filter((line) => line.startsWith("  apps/"))
          .map((line) => line.trim().split(" ")[0].split(":")[0]),
      ),
    ].sort();

    assert.deepEqual(named, [
      "apps/home-web/layouts/default.vue",
      "apps/home-web/nuxt.config.ts",
    ]);
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
      what: "a colour-mode literal",
      source: 'export const mode = "system";',
      expect: /colour-mode literal/,
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
