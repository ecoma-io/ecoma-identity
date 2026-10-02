#!/usr/bin/env node
/**
 * The frontend-coherence gate.
 *
 * THREE APPLICATIONS ANSWER "what does this visitor prefer" and the answer has
 * to be the same in all three, because a language chosen on one is read on the
 * next and a cookie that means different things in two apps is not a shared
 * preference. The values involved — the cookie's name and domain, the locale
 * vocabulary, the default locale, the default colour mode — each have exactly
 * one owner: `infra-topology/topology.json` for the cookie's name, and
 * `infra-topology/frontend-support.json` for the vocabulary. This gate is what
 * keeps them single.
 *
 * IT EXISTS BECAUSE NOTHING ELSE DOES. Issue #17 is the evidence: the cookie
 * name was declared in `packages/shared-i18n/src/types.ts:55` and again in
 * `apps/home-web/nuxt.config.ts:118`, and the only thing relating the two
 * copies was a comment saying they had to stay in step. The same locale list
 * existed in two more files. A comment is not a constraint.
 *
 * WHAT IT CHECKS
 *
 *   1. The support file is well-formed — non-empty locales, no duplicates, a
 *      default that is among them, a colour mode that is one of three.
 *   2. The package's GENERATED copy of the vocabulary matches the source. It is
 *      written by the renderer, so a mismatch means someone edited the copy —
 *      or edited the source without re-rendering — and either way the two would
 *      ship different answers.
 *   3. No frontend source hardcodes any of those values. This is the check
 *      that would have caught #17 on the day it was written.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *
 * It does not check the renderer's output. A rendered config for `production`
 * and one for `preview` are SUPPOSED to differ — that is the whole point of the
 * per-environment namespace, and a gate that required them to match would
 * enforce the bug. What must hold is that each one is a projection of the
 * topology, which is the renderer's job and
 * `render-wrangler-config.test.mjs`'s.
 *
 * The scan is line-based and syntactic rather than semantic, and that is a real
 * limitation: a value assembled from parts (`"ecoma" + "_locale"`) passes it.
 * That is acceptable because the values being guarded are ones nobody would
 * assemble by hand, and because a gate with false negatives is still worth more
 * than a comment — but it is a gate, not a proof, and the message says so.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT_CANNOT_RUN,
  EXIT_INVALID,
  EXIT_OK,
  loadFrontendSupport,
  loadTopology,
} from "./topology-model.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** The generated copy the renderer maintains. Compared, never edited. */
const SUPPORT_COPY = path.join(
  "packages",
  "frontend-preferences",
  "frontend-support.json",
);

/**
 * The directories a hardcoded value would be hiding in, and what each is
 * scanned FOR.
 *
 * `src/` and the Nuxt configuration rather than the whole application: a
 * document may legitimately mention that production runs at `ecoma.io` — that
 * is prose about a deployment, not a value a browser is about to be built
 * with. Everything a BUNDLE reads is in one of these.
 *
 * The two checks differ in what they read, and the difference is deliberate:
 *
 *   - `literals` scans the WHOLE file, comments included. A comment that names
 *     `ecoma_locale` is worth a finding, because issue #17 was kept in step by
 *     exactly such a comment and the comment is the thing that failed.
 *   - `locales` scans CODE ONLY. Prose legitimately discusses a locale by name —
 *     `apps/identity/web/src/plugins/i18n.ts` explains its message cache by
 *     referring to `vi`, and `nuxt.config.ts` explains the prerender trap the
 *     same way. Flagging those would make the gate cry wolf on its first run and
 *     teach everyone to ignore it.
 *
 * `index.html` is `literals`-only for a further reason: its `<html lang="en">`
 * cannot be anything else. It is a static shell that must parse before any
 * module has run, so its language is a pre-hydration placeholder that
 * `initializeI18n` overwrites on `document.documentElement.lang`. Requiring it
 * to be generated would mean a build-time HTML transform to substitute one
 * word, which is not worth the machinery — and the value that matters, the
 * locale a reader actually gets, is set at runtime and is the projection's.
 */
const SCANNED_ROOTS = [
  {
    path: path.join("apps", "identity", "web", "src"),
    checks: ["literals", "locales"],
  },
  {
    path: path.join("apps", "identity", "web", "index.html"),
    checks: ["literals"],
  },
  {
    path: path.join("apps", "identity-admin", "web", "src"),
    checks: ["literals", "locales"],
  },
  {
    path: path.join("apps", "identity-admin", "web", "index.html"),
    checks: ["literals"],
  },
  {
    path: path.join("apps", "home-web", "nuxt.config.ts"),
    checks: ["literals", "locales"],
  },
  {
    path: path.join("apps", "home-web", "app"),
    checks: ["literals", "locales"],
  },
  {
    path: path.join("apps", "home-web", "pages"),
    checks: ["literals", "locales"],
  },
  {
    path: path.join("apps", "home-web", "layouts"),
    checks: ["literals", "locales"],
  },
  {
    path: path.join("apps", "home-web", "components"),
    checks: ["literals", "locales"],
  },
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".vue",
  ".html",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".output",
  ".nuxt",
  ".wrangler",
]);

/**
 * The literals that would mean a value had been written a second time.
 *
 * `ecoma_locale` is listed rather than only `cookieKey:` because the specific
 * string is what #17 was about: it is a name that exists in no environment and
 * would silently be the same name in all four.
 */
function forbiddenLiterals(topology, support) {
  return [
    { literal: "ecoma_locale", why: "the pre-namespace cookie name from #17" },
    {
      literal: topology.cookie_namespaces.production,
      why: "one environment's cookie name, written as if it were every environment's",
    },
    {
      literal: topology.cookie_namespaces.staging,
      why: "one environment's cookie name, written as if it were every environment's",
    },
    {
      literal: topology.cookie_namespaces.development,
      why: "one environment's cookie name, written as if it were every environment's",
    },
    {
      literal: `".${topology.account.zone}"`,
      why: "the zone apex with a leading dot; the domain comes from the projection",
    },
    {
      literal: `https://${topology.account.zone}`,
      why: "the production apex as a literal; baseUrl comes from the projection",
    },
    {
      literal: `https://stg-${topology.account.zone}`,
      why: "the staging apex as a literal; baseUrl comes from the projection",
    },
    {
      literal: `https://pr{pr}-${topology.account.zone}`,
      why: "a preview host template as a literal",
    },
    {
      literal: `"${support.defaultColorMode}"`,
      why: "a colour-mode literal; the default comes from the projection",
    },
  ];
}

/** Recursively list source files under `absolute`, relative to the repo root. */
function listSources(absolute, out = []) {
  if (!fs.existsSync(absolute)) return out;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (SOURCE_EXTENSIONS.has(path.extname(absolute))) {
      out.push(path.relative(REPO_ROOT, absolute).split(path.sep).join("/"));
    }
    return out;
  }
  for (const entry of fs.readdirSync(absolute)) {
    if (SKIP_DIRS.has(entry)) continue;
    listSources(path.join(absolute, entry), out);
  }
  return out;
}

/**
 * A locale list or a bare locale literal in CODE.
 *
 * Every locale token in the vocabulary is forbidden as a QUOTED STRING, which
 * is why the checker's own vocabulary lives outside the scanned roots — a gate
 * that tripped on the pattern it hunts for would be useless.
 */
function localeOffences(relative, source, support) {
  const offences = [];
  for (const locale of support.supportedLocales) {
    const pattern = new RegExp(`["'\`]${locale}["'\`]`);
    if (pattern.test(stripComments(source))) {
      offences.push({
        file: relative,
        line: firstMatchingLine(source, pattern),
        what: `the locale literal "${locale}"`,
        why: "locales are enumerated by infra-topology/frontend-support.json; an application reads the projection",
      });
    }
  }
  return offences;
}

/**
 * Replace every comment with spaces, preserving newlines and offsets.
 *
 * Block and line comments only. A regex literal's `/` is indistinguishable from
 * a comment's without parsing, so a `/` inside one can swallow text that
 * follows it on the same line; the failure mode is a MISSED finding on a line
 * that already contains a regex, which is the same class of false negative the
 * gate already has and does not make materially worse.
 *
 * Newlines are preserved deliberately — `firstMatchingLine` counts them, and a
 * comment removed rather than blanked would shift every line number the gate
 * reports.
 */
function stripComments(source) {
  let out = "";
  let index = 0;
  let inBlock = false;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (inBlock) {
      if (two === "*/") {
        out += "  ";
        index += 2;
        inBlock = false;
        continue;
      }
      out += source[index] === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (two === "/*") {
      out += "  ";
      index += 2;
      inBlock = true;
      continue;
    }
    if (two === "//") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

function firstMatchingLine(source, pattern) {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? 0 : index + 1;
}

function scanForLiterals(files, literals) {
  const offences = [];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    for (const { literal, why } of literals) {
      if (!source.includes(literal)) continue;
      offences.push({
        file: relative,
        line: firstMatchingLine(source, new RegExp(escapeRegExp(literal))),
        what: `the literal ${JSON.stringify(literal)}`,
        why,
      });
    }
  }
  return offences;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function report(offences, headline) {
  process.stderr.write(`✗ check-frontend-config: ${headline}\n\n`);
  for (const offence of offences) {
    process.stderr.write(
      `  ${offence.file}:${offence.line} — ${offence.what}\n      ${offence.why}\n`,
    );
  }
  process.stderr.write(
    `\n  Read the value from the projected config at .generated/frontend/config.json,\n`,
  );
  process.stderr.write(
    `  or add the locale to infra-topology/frontend-support.json and re-run\n`,
  );
  process.stderr.write(
    `  \`pnpm infra:render\`. A value with two owners is a value that will\n`,
  );
  process.stderr.write(
    `  disagree with itself. See docs/architecture/frontend-preferences.md.\n\n`,
  );
}

/**
 * Compare the generated copy against its source.
 *
 * Read as a string comparison of the parsed values rather than of the bytes,
 * because the copy is written with two-space indentation by the renderer and a
 * hand-edited file would differ only in formatting while being wrong in
 * substance — or, worse, identical in formatting while being wrong.
 */
function checkSupportCopy(support) {
  const file = path.join(REPO_ROOT, SUPPORT_COPY);
  if (!fs.existsSync(file)) {
    return [
      {
        file: SUPPORT_COPY,
        line: 0,
        what: "the generated vocabulary copy does not exist",
        why: "run `pnpm infra:render`; the renderer writes it from infra-topology/frontend-support.json",
      },
    ];
  }
  let copy;
  try {
    copy = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return [
      {
        file: SUPPORT_COPY,
        line: 0,
        what: "the generated vocabulary copy is not valid JSON",
        why: error.message,
      },
    ];
  }
  const expected = {
    supportedLocales: support.supportedLocales,
    defaultLocale: support.defaultLocale,
    defaultColorMode: support.defaultColorMode,
  };
  if (JSON.stringify(copy) === JSON.stringify(expected)) return [];
  return [
    {
      file: SUPPORT_COPY,
      line: 0,
      what: `the generated copy declares ${JSON.stringify(copy)}, the source declares ${JSON.stringify(expected)}`,
      why: "the copy is written by the renderer; edit infra-topology/frontend-support.json and run `pnpm infra:render`, never this file",
    },
  ];
}

export function main() {
  let topology;
  let support;
  try {
    ({ topology } = loadTopology(REPO_ROOT));
    ({ support } = loadFrontendSupport(REPO_ROOT));
  } catch (error) {
    process.stderr.write(`✗ check-frontend-config: ${error.message}\n`);
    return EXIT_INVALID;
  }

  const groups = SCANNED_ROOTS.map(({ path: relative, checks }) => ({
    checks: new Set(checks),
    files: listSources(path.join(REPO_ROOT, relative)),
  }));
  const totalFiles = groups.reduce((sum, group) => sum + group.files.length, 0);

  const literals = forbiddenLiterals(topology, support);
  const offences = [
    ...checkSupportCopy(support),
    ...groups.flatMap((group) =>
      group.checks.has("literals")
        ? scanForLiterals(group.files, literals)
        : [],
    ),
    ...groups.flatMap((group) =>
      group.checks.has("locales")
        ? group.files.flatMap((relative) =>
            localeOffences(
              relative,
              fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"),
              support,
            ),
          )
        : [],
    ),
  ];

  if (offences.length > 0) {
    report(
      offences,
      `${offences.length} frontend preference value(s) have more than one owner.`,
    );
    return EXIT_CANNOT_RUN;
  }

  process.stdout.write(
    `frontend preferences have one owner each; ${totalFiles} source file(s) scanned across 3 frontends.\n`,
  );
  return EXIT_OK;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`✗ check-frontend-config: ${message}\n`);
    process.exit(EXIT_CANNOT_RUN);
  }
}
