#!/usr/bin/env node
/**
 * `check-architecture.mjs` — the mechanical form of ecoma-identity's boundary
 * law. This is `pnpm arch`.
 *
 * WHAT IT IS: a dependency-free Node ≥ 20 script that exits non-zero when the
 * repository violates one of the ten constraints enumerated in `CHECKS` below,
 * and that prints a banner naming every check it could not run and why. The
 * prose law is `docs/architecture/`; this file is its executable form, and the
 * two move in one commit or not at all.
 *
 * WHAT IT IS NOT: it is not a linter, a formatter, or a general architect's
 * opinion. It judges ten specific constraints and nothing else. It does not
 * decide whether an architectural decision is a good one — only whether the
 * tree still matches the decisions already recorded.
 *
 * The honesty properties this file is built around, in priority order:
 *
 *   1. A check that could not run says so. A missing `wrangler.jsonc`, a
 *      missing `release-please-config.json` and an empty git index are
 *      reported as `skipped`, never as a pass. The banner at the end of every
 *      run lists them, because a green run that silently covered nothing is
 *      worse than a red one: it is the failure mode that gets a boundary
 *      deleted.
 *   2. Findings are evidence, not verdicts by vibes. Every violation names the
 *      file, the line, what was found, the constraint broken, and the fix.
 *   3. The Rust dependency graph comes from `cargo metadata`, not from a regex
 *      over `Cargo.toml`. A regex cannot see a `workspace = true` indirection,
 *      a rename, or a target/dev-dependency split, and a check that cannot see
 *      them gives a false green that somebody later disables.
 *
 * No dependencies. No YAML parser. `wrangler.jsonc` and the GitHub workflows
 * are read by a purpose-written JSONC stripper whose limits are documented on
 * `stripJsonc` below.
 */

/* ------------------------------------------------------------------ *
 * Exit codes
 * ------------------------------------------------------------------ */

/** Clean run, or a run in which only warnings fired. */
const EXIT_OK = 0;
/** At least one violation of at least one hard constraint. */
const EXIT_VIOLATIONS = 1;
/** The run could not be completed: a tool the checks depend on is missing. */
const EXIT_CANNOT_RUN = 2;
/** The command line itself is wrong. */
const EXIT_USAGE = 64;

/* ------------------------------------------------------------------ *
 * Vocabulary. These names are the law's names, not this file's.
 * ------------------------------------------------------------------ */

/** The three deployables. §7: a fourth requires an ADR and proof. */
const DEPLOYABLES = ["identity", "identity-admin", "identity-jobs"];

/** The `wrangler.jsonc` `name` of the deployable an `apps/<dir>` directory is. */
const WORKER_NAMES = {
  identity: "identity",
  "identity-admin": "identity-admin",
  "identity-jobs": "identity-jobs",
};

/** §2/§3: the D1 binding name. Only the Identity Worker may hold it. */
const IDENTITY_D1_BINDING = "IDENTITY_DB";

/**
 * The §2 table, as data, so the two directions of every crate's law are one
 * object rather than two sets of conditionals. `internal` is the crate's
 * internal dependency set as the brief states it; `forbiddenInternal` is the
 * set that would invert or cross the law. Both are judged on the SAME graph,
 * so a row cannot be right in one direction and wrong in the other.
 */
const CRATE_LAW = {
  "identity-domain": {
    internal: [],
    forbiddenInternal: [],
    forbiddenExternal: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
  },
  "identity-application": {
    internal: ["identity-domain"],
    forbiddenInternal: [],
    forbiddenExternal: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
  },
  "identity-oidc": {
    internal: ["identity-domain"],
    forbiddenInternal: [],
    forbiddenExternal: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
  },
  "identity-security": {
    internal: ["identity-domain"],
    forbiddenInternal: [],
    forbiddenExternal: [
      "worker",
      "worker-sys",
      "worker-macros",
      "wasm-bindgen",
    ],
  },
  "identity-cloudflare": {
    internal: [
      "identity-domain",
      "identity-application",
      "identity-oidc",
      "identity-security",
    ],
    forbiddenInternal: [],
    forbiddenExternal: [],
  },
  "identity-testkit": {
    internal: null, // exempt by construction: §1 table, "any (test-only helper)"
    forbiddenInternal: [],
    forbiddenExternal: [],
  },
};

/**
 * §4: the Jobs Worker must not be able to evaluate identity rules.
 * `internal: null` marks "must be empty", not "unconstrained" — the opposite of
 * archkeep's `onlyDependOnLibsWithTags: []` convention, where an empty list is
 * the strictest setting. Read the two together; they are different tools.
 */
const JOBS_FORBIDDEN_INTERNAL = new Set([
  "identity-domain",
  "identity-application",
  "identity-jobs-worker",
]);

/** Paths exempt from the identity-rule law: test doubles, not product code. */
const TESTKIT_PATH = /(^|\/)crates\/identity-testkit\//;

/** Frontend packages. §2 check 4 and the archkeep `layer-web` rows. */
const FRONTEND_PACKAGES = [
  "vue",
  "vue-router",
  "pinia",
  "@vue/devtools-api",
  "@ecoma-io/loom",
  "vite",
  "@vitejs/plugin-vue",
  "vitest",
  "happy-dom",
  "jsdom",
];

/**
 * §28 and the module map. No other Ecoma repository's source may live here.
 * Matched case-insensitively against every path segment, so a nested copy is
 * caught too — `vendor/loom/` is the same defect as `loom/`.
 */
const ORG_REPOS = [
  "ecoma",
  "ecoma-cloud",
  "runtime-trail",
  "loom",
  "action-agents",
  "archkeep",
  "release-craft",
  "rotation-proxy-gateway",
  "http-relay-gateway",
  "opencode-free-proxy",
  "openai-compatible-injector",
];

/** Tracked extensions that are a secret by construction. §27. */
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/**
 * Tracked filenames that are a secret by construction. §27.
 *
 * A NAME RULE, not a list of two exact filenames. `.dev.vars` alone would miss
 * `.dev.vars.local`, and `.gitignore` ignores the whole `.dev.vars.*` family —
 * so before this was a rule rather than a rule-with-a-family, a committed
 * `.dev.vars.production` passed the check that exists to stop exactly that.
 * The two lists must agree with `.gitignore`; `secretFilenameVerdict` is the
 * one place either is spelled, so a new family is added in one commit.
 *
 * `example`/`template`/`sample` are exempt, mirroring `.gitignore`'s own
 * negations: an example file carries variable names and nothing else, and
 * refusing to track it would mean the repository documents its own variables in
 * prose instead, which is worse.
 */
const SECRET_FILENAMES = [
  {
    re: /^\.dev\.vars$/,
    found: "a tracked .dev.vars holds the local development secrets",
  },
  {
    re: /^\.dev\.vars\..+$/,
    found: (base) =>
      `a tracked ${base} holds per-environment development secrets`,
  },
  {
    re: /^\.env$/,
    found: (base) =>
      `a tracked ${base} is a secret file; the repository ships .env.example instead`,
  },
  {
    re: /^\.env\..+$/,
    found: (base) =>
      `a tracked ${base} is a secret file; the repository ships .env.example instead`,
  },
];

/** §27. The `.example`/`.template`/`.sample` suffix that makes a file safe. */
const SECRET_EXEMPT_SUFFIX = /\.(example|template|sample)$/;

/**
 * Judge a tracked basename against the §27 name rules and the secret
 * extensions. Returns a description of what was found, or `null` for a file
 * that is not a secret by construction.
 *
 * The exemption is applied ONCE, here, before both the name rules and the
 * extension rules — not folded into each rule as a negative lookahead. Spelled
 * in both places it is two sources of truth that must agree, and they
 * disagreed here the moment the rule was written: a lookahead placed straight
 * after the dot tests only whether the remainder BEGINS with `example`, so
 * `.env.example` was reported as a committed secret — the guard failed on three
 * of the repository's own example files and exited 1.
 *
 * `SECRET_EXTENSIONS` is an array, not a set, because a file's extension is an
 * exact suffix and `.key` must not be matched against `.keystore`; membership
 * is `includes`, which is exact either way.
 */
function secretFilenameVerdict(entry) {
  const base = path.posix.basename(entry);
  if (SECRET_EXEMPT_SUFFIX.test(base)) return null;
  for (const rule of SECRET_FILENAMES) {
    if (rule.re.test(base)) {
      return typeof rule.found === "function" ? rule.found(base) : rule.found;
    }
  }
  const ext = path.posix.extname(entry);
  if (SECRET_EXTENSIONS.includes(ext)) {
    return `a tracked ${base} is a ${ext.slice(1).toUpperCase()} key or certificate`;
  }
  return null;
}

/** §26. A dev-mode authentication bypass, in any spelling. */
const AUTH_BYPASS_PATTERNS = [
  "dev_auth_bypass",
  "skip_auth",
  "mock_user",
  "insecure",
  "DISABLE_AUTH",
  "bypass_auth",
  "auth_bypass",
  "no_auth_required",
  "ALLOW_ANONYMOUS",
  "trust_the_client",
];

/**
 * §26 exemptions, and the honest reason each exists. `#[cfg(test)]` is
 * compile-time: the module does not exist in a production build, so a bypass
 * there is a test fixture and not a shipped code path. A `#[cfg(test)]`
 * *attribute on an item* is exempt; a `#[cfg(test)]` *inside a comment* is not,
 * which is why the exemption keys on the attribute spelling rather than on the
 * word appearing anywhere in the file.
 */
const AUTH_BYPASS_EXEMPT_PATTERNS = [
  { re: /(^|\/)tests\//, why: "a test suite" },
  { re: TESTKIT_PATH, why: "the test-only double crate" },
  {
    re: /(^|\/)__fixtures__\//,
    why: "a canary fixture that exists to be rejected",
  },
  { re: /\.test\.(mjs|js|ts)$/, why: "a node:test suite" },
  { re: /(^|\/)docs\//, why: "a document naming the rule" },
  { re: /(^|\/)adr\//, why: "a decision record naming the rule" },
  { re: /README\.md$/, why: "prose" },
  {
    re: /check-architecture(\.test)?\.mjs$/,
    why: "the guard and its own test",
  },
  { re: /(^|\/)EXPLANATION\.md$/, why: "this script's documentation" },
];

/** File extensions each check is willing to read. */
const SOURCE_EXTENSIONS = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".vue",
  ".json",
  ".jsonc",
  ".toml",
  ".yml",
  ".yaml",
  ".sql",
  ".sh",
  ".md",
  ".env",
]);

/** Wrangler config spellings, in preference order. */
const WRANGLER_FILENAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** Environment directories, in the order `docs/operations/deployment-model.md` names. */
const ENVIRONMENTS = ["development", "staging", "production"];

/**
 * Directories never walked, and the reason each one is here.
 *
 * `__fixtures__` is the load-bearing entry. `tooling/scripts/__fixtures__/`
 * holds `violating-tree/`, a deliberately broken repository that every
 * boundary check is supposed to FAIL. The default walk must never enter it, and
 * the reason is not tidiness — it is that a run over the real tree has nothing
 * to say about a fixture, and one that does has stopped certifying the tree it
 * was asked about.
 *
 * The fixture is reached EXPLICITLY, by `--root <dir>` or by setting
 * `ECOMA_IDENTITY_ROOT`, and by nothing else. Two properties follow, and both
 * are why this is a walk exclusion rather than anything else:
 *
 *   - The canary cannot be made to pass by deleting it. Deleting the fixture
 *     removes the canary, not the constraint; the constraints are the ten
 *     check functions and they do not consult the fixture at all.
 *   - The fixture is still judged, every time `check-architecture.test.mjs`
 *     runs, by the same functions against that tree. Excluding it from the
 *     default walk does not exempt it from judgement — it moves WHEN it is
 *     judged from "whenever anyone runs the guard" to "whenever the test suite
 *     runs", which is strictly more often than a manual run.
 *
 * What this is NOT allowed to become: an exemption keyed on the fixture's
 * CONTENT, or an addition to `AUTH_BYPASS_EXEMPT_PATTERNS` alone. Both would
 * leave the other nine checks walking into a tree built to fail them, and a
 * future fixture that a developer adds would be walked and unjudged without
 * anyone noticing.
 */
const WALK_SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  ".git",
  ".moon",
  "__fixtures__",
  ".pnpm-store",
  "build",
  ".next",
  ".turbo",
  ".wrangler",
  "coverage",
]);

/** §2 check 4: the two directories the rule is phrased over. */
const WEB_DIR_RE = /(^|\/)apps\/[^/]+\/web(\/|$)/;

/* ------------------------------------------------------------------ *
 * Small primitives
 * ------------------------------------------------------------------ */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * This file's own path, resolved from `import.meta.url` and therefore
 * unaffected by `ECOMA_IDENTITY_ROOT`. `--root` re-executes THIS file, and a
 * fixture tree has no copy of it — so the re-exec must name this path, not a
 * path derived from the overridden root.
 */
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * The repository this run judges. Defaults to the repository the script lives
 * in, and is overridable through `ECOMA_IDENTITY_ROOT` — which is how
 * `--root` re-executes this same file against the canary fixture tree, so
 * the fixture exercises the real checks and not a parallel implementation of
 * them. Two code paths through a boundary check is one too many: the one that
 * is not the one that runs in CI is the one that rots.
 */
const REPO_ROOT = process.env.ECOMA_IDENTITY_ROOT
  ? path.resolve(process.env.ECOMA_IDENTITY_ROOT)
  : path.resolve(SELF_PATH, "..", "..", "..");
const VIRTUAL_NOW = new Date(0).toISOString();

/**
 * `path.relative` with POSIX separators, for message text and for comparing
 * against forward-slash patterns. Every path this script reports goes through
 * here, so output is identical on every platform.
 *
 * A path OUTSIDE the repository — which `cargo metadata` reports for a
 * registry dependency, and which check 3 legitimately names — comes back
 * `../../..`-prefixed. That is ugly but correct, and it is better than a
 * `path.join` that silently re-roots an absolute path inside the repository and
 * points the reader at a file that does not exist.
 */
function rel(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

/** Forward-slash path of an absolute path inside the repository. */
function toPosix(absolute) {
  return absolute.split(path.sep).join("/");
}

function readTextOrNull(absolute) {
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function readText(absolute) {
  const text = readTextOrNull(absolute);
  if (text === null) {
    throw new Error(`cannot read ${rel(absolute)}`);
  }
  return text;
}

function statOrNull(absolute) {
  try {
    return fs.statSync(absolute);
  } catch {
    return null;
  }
}

function isDirectory(absolute) {
  return statOrNull(absolute)?.isDirectory() ?? false;
}

function exists(absolute) {
  return statOrNull(absolute) !== null;
}

/**
 * Every file under `root`, deterministically ordered, skipping the dependency
 * and build directories. `root` not existing yields an empty list — callers
 * that care about absence ask `exists` first, so a missing directory is
 * reported as a skip rather than as an empty pass.
 */
function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }
  return out.sort();
}

/** 1-based line number of `needle`'s first occurrence, or `null`. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index === -1 ? null : text.slice(0, index).split("\n").length;
}

/**
 * The 1-based `lineNo`-th line of `text`, or `""`.
 *
 * Paired with `lineOf` wherever a line number is about to be classified, and
 * not folded into it on purpose: `isProseLine` takes the line's TEXT, and the
 * two getting confused produced `lineText.trim is not a function` inside a
 * check — an errored check, which is reported rather than hidden, but a check
 * that cannot run catches nothing.
 */
function lineTextAt(text, lineNo) {
  if (typeof lineNo !== "number" || lineNo < 1) return "";
  return text.split("\n")[lineNo - 1] ?? "";
}

/**
 * Every 1-based line number at which `pattern` matches, one entry per match.
 *
 * `lineOf` would answer "where is the first one" and a file can hold several;
 * this answers "where are all of them", which is what a finding needs. It does
 * so with `matchAll` on a caller-supplied global regex rather than a scanning
 * loop over indices: a scanning loop has to reset `lastIndex` by hand and gets
 * it wrong exactly when the pattern has no `y` flag, which is the common case.
 *
 * The caller must pass a global regex. A non-global one throws here rather
 * than looping forever, which is the better of the two failure modes.
 */
function allLinesOf(text, pattern) {
  if (!pattern.global) {
    throw new Error("allLinesOf requires a global regex");
  }
  pattern.lastIndex = 0;
  const lines = [];
  for (const match of text.matchAll(pattern)) {
    lines.push(text.slice(0, match.index).split("\n").length);
  }
  return lines;
}

/**
 * Every identifier-looking token WITH the 1-based line it sits on, one entry
 * per OCCURRENCE.
 *
 * Deliberately over-collecting. A source-text scan cannot resolve a symbol to
 * its origin crate, so it must catch every spelling a reader would recognise
 * and then judge each one against the law rather than assume a hit is a
 * violation. Under-collecting produces a false green, which is the direction
 * that matters.
 *
 * There is no token-only companion to this, and there was one: a plain
 * `identifiersInFile(text)` that returned `[…tokens]` and let `lineOf` resolve
 * each token to a line afterwards. It was removed rather than kept, because it
 * cannot be used by a check that classifies lines — see below — and keeping it
 * would have meant shipping a second, weaker collector for no caller.
 *
 * The reason a token-only version is wrong here is load-bearing. A file that
 * names `vue` once in a comment and once in code yields the token `vue` twice
 * — and `lineOf` then reports only the FIRST, the comment, which
 * `isProseLine` then correctly suppresses. The result is that the code
 * occurrence is never looked at: check 4 reported a backend that names `vue`
 * in a string literal as clean while its own canary failed. Deduplicating the
 * token list to "fix" that produces the same blindness, because the line is
 * still resolved by first occurrence.
 *
 * So a check that classifies lines must iterate OCCURRENCES, each with its own
 * line, and let `reportOnce` collapse identical findings afterwards.
 */
function identifierOccurrencesInFile(text) {
  const out = [];
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*/g)) {
    out.push({
      token: match[0],
      line: text.slice(0, match.index).split("\n").length,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The JSONC reader
 * ------------------------------------------------------------------ */

/**
 * Strip JSONC comments and trailing commas, preserving every line and
 * character offset.
 *
 * Line preservation is not cosmetic: a finding reports a line number, and
 * blanking a comment in place keeps that number pointing at the same line the
 * author wrote. Replacing comments with spaces rather than deleting them is
 * what makes that true.
 *
 * WHAT THIS STRIPPER DOES NOT HANDLE, and will silently mis-read if a file ever
 * uses it:
 *
 *   - It does not parse YAML. A `wrangler.toml` is read with a small
 *     `key = value` scanner of its own (`readTomlBindings`); that scanner is
 *     crude and this comment is the reason it is acceptable.
 *   - It does not handle JavaScript in a `.jsonc` file: no trailing commas
 *     inside comments (they are removed as comments first, so this is safe),
 *     and no unquoted keys. Wrangler's schema allows neither.
 *   - It is not a general JSONC implementation and is not used as one. The
 *     comment syntax of JSONC is the only thing JSONC adds that this reads,
 *     plus the trailing comma Wrangler's own examples use.
 *   - A `/*` sequence inside a string literal is left alone, correctly, and so
 *     is a `//` inside a string literal, correctly — but only because the
 *     string-literal state is tracked. A file with an unterminated string will
 *     be reported as unparseable rather than guessed at.
 *
 * Returns `{ ok: true, text }` or `{ ok: false, error }`. It never throws, so
 * a caller that forgets to check gets `ok: false` rather than a stack trace.
 */
function stripJsonc(src) {
  const chars = src.split("");
  const blank = (i) => {
    if (i >= 0 && i < chars.length && chars[i] !== "\n" && chars[i] !== "\r") {
      chars[i] = " ";
    }
  };
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        blank(i);
        i += 1;
      }
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }
    i += 1;
  }

  // Trailing commas, removed in place, again preserving offsets: a comma is
  // only dropped when the next non-whitespace character closes an object or an
  // array, and only outside a string.
  const text = chars.join("");
  let out = "";
  let j = 0;
  let str = false;
  let esc = false;
  while (j < text.length) {
    const c = text[j];
    if (str) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') str = false;
      j += 1;
      continue;
    }
    if (c === '"') {
      str = true;
      out += c;
      j += 1;
      continue;
    }
    if (c === ",") {
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (text[k] === "}" || text[k] === "]") {
        j += 1;
        continue;
      }
    }
    out += c;
    j += 1;
  }
  return { ok: true, text: out };
}

/**
 * The 1-based line a `JSON.parse` failure happened on.
 *
 * V8 reports `at position N`, and N is a character offset into the string it
 * was given — the STRIPPED text, because that is what was parsed, so the offset
 * indexes the same text whose lines the caller reports. V8 also appends
 * `(line L column C)` on newer runtimes, but relying on that would make the
 * error message's quality depend on the Node version; the offset is in the
 * message on every version that has it.
 *
 * Returns 1 when the offset is absent or out of range. A wrong line number in
 * an error string is a small lie, so this never throws and never guesses past
 * the end of the text.
 */
function jsonErrorLine(text, error) {
  const position = /at position (\d+)/.exec(String(error?.message ?? ""))?.[1];
  if (position === undefined) return 1;
  const offset = Number(position);
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return 1;
  return text.slice(0, offset).split("\n").length;
}

/**
 * Read a JSON or JSONC configuration file.
 *
 * Returns `{ ok: true, data, text }` where `text` is the stripped text with
 * line numbers intact, or `{ ok: false, error }`. A caller that gets
 * `ok: false` MUST report a skip or a violation — never a pass. This is the
 * single place where "I could not read the file" is turned into an honest
 * outcome, and the whole reason it is a value rather than an exception.
 *
 * The error names the line `JSON.parse` gave up on, so a malformed config
 * points at itself. A parse error that only said "not parseable" would send
 * the next reader to the top of a forty-line file to find the missing comma.
 */
function readJsonc(absolute) {
  const raw = readTextOrNull(absolute);
  if (raw === null) return { ok: false, error: "file could not be read" };
  const stripped = stripJsonc(raw);
  if (!stripped.ok) return { ok: false, error: stripped.error };
  // Tolerate a UTF-8 BOM, which some editors add and `JSON.parse` rejects.
  const text = stripped.text.replace(/^﻿/, "");
  try {
    return { ok: true, data: JSON.parse(text), text };
  } catch (error) {
    const line = jsonErrorLine(text, error);
    return {
      ok: false,
      error: `not parseable as JSON/JSONC at line ${line} (${error.message})`,
    };
  }
}

/**
 * Read a `wrangler.toml`'s binding tables with a purpose-written scanner.
 *
 * HONEST LIMITS. This handles exactly one shape: a top-level `[section]` or
 * `[[section]]` header, `key = "value"` and `key = { ... }` and
 * `key = [ ... ]` assignments, `#` comments, and nothing else. It does not
 * handle multi-line arrays whose elements are on their own lines (it reads the
 * opening line and stops), dotted keys, or inline tables spanning lines — so a
 * binding name declared in one of those spellings is MISSED, and a wrangler
 * check over a `wrangler.toml` is weaker than the same check over a
 * `wrangler.jsonc`. `.jsonc` is what this repository's convention expects;
 * `.toml` support is a courtesy, and `readWranglerConfig` reports which
 * spelling it read so a reader never has to guess which one was judged.
 */
function readTomlBindings(text) {
  const bindings = [];
  let section = "";
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") return;
    const arrayHeader = /^\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]$/.exec(line);
    if (arrayHeader) {
      section = arrayHeader[1];
      return;
    }
    const header = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
    if (header) {
      section = header[1];
      return;
    }
    const bindingKey = /^binding\s*=\s*"([^"]+)"/.exec(line);
    if (bindingKey && section !== "") {
      bindings.push({
        name: bindingKey[1],
        kind: tomlSectionKind(section),
        key: section,
        line: index + 1,
      });
      return;
    }
    const pairKey = /^binding\s*=\s*\{/.exec(line);
    if (pairKey && section !== "") {
      const inline = /binding\s*=\s*\{\s*binding\s*=\s*"([^"]+)"/.exec(line);
      if (inline) {
        bindings.push({
          name: inline[1],
          kind: tomlSectionKind(section),
          key: section,
          line: index + 1,
        });
      }
    }
  });
  return bindings;
}

function tomlSectionKind(section) {
  const head = section.split(".")[0];
  if (/^d1_databases$/.test(head)) return "D1";
  if (/^kv_namespaces$/.test(head)) return "KV";
  if (/^durable_objects$/.test(head)) return "Durable Object";
  if (/^queues/.test(head)) return "Queue";
  if (/^services$/.test(head)) return "service binding";
  if (/^r2_buckets$/.test(head)) return "R2";
  return `unclassified (${section})`;
}

/**
 * Collect every Cloudflare binding a wrangler config declares, with the JSON
 * key it came from and the line that key is on.
 *
 * A top-level key this function does not recognise but whose value looks like
 * a binding table — an array of objects, or an object, under a name that is
 * not `name`/`compatibility_date`/`compatibility_flags`/… — is reported as
 * `unclassified` rather than ignored. That is the schema-drift escape hatch
 * closed: a future wrangler release that adds `stateful_sets` and gets a DO
 * binding for free must fail this check, not slip past it.
 */
const NON_BINDING_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "account_id",
  "route",
  "routes",
  "assets",
  "observability",
  "placement",
  "limits",
  "migrations",
  "minify",
  "keep_vars",
  "upload_source_maps",
  "logpush",
  "tags",
  "env",
  "rules",
]);

const JSON_BINDING_KINDS = {
  d1_databases: "D1",
  kv_namespaces: "KV",
  durable_objects: "Durable Object",
  queues: "Queue",
  r2_buckets: "R2",
  services: "service binding",
  // `ratelimits` is Cloudflare's Workers rate-limiting binding, and it is
  // named `ratelimits` with no underscore. Listed because an UNRECOGNISED
  // binding key is a violation by design, so the classification table is the
  // difference between "this repository declares a rate limiter" and "this
  // script cannot read this repository's wrangler files".
  ratelimits: "Workers rate limiting",
  rate_limits: "Workers rate limiting",
  ai: "Workers AI",
  hyperdrive: "Hyperdrive",
  browser: "Browser rendering",
  analytics_engine_datasets: "Analytics Engine",
  workflows: "Workflow",
  containers: "Container",
  version_metadata: "version metadata",
};

/**
 * Every Cloudflare binding a wrangler config declares, with the JSON key it
 * came from and the line that key is on.
 *
 * Two binding-name spellings exist and BOTH are real in wrangler's schema.
 * The array-of-tables form (`d1_databases: [{ binding: "X" }]`) spells it
 * `binding`; the `durable_objects` object form
 * (`durable_objects: { bindings: [{ name: "X" }] }`) spells it `name`. A
 * reader that knows only the first classifies a Durable Object as an
 * unrecognised entry and reports nothing — which is precisely the binding §24
 * exists to forbid, arriving unnoticed.
 *
 * A top-level key this function does not recognise but whose value looks like
 * a binding table — an array of objects, or an object, under a name that is
 * not `name`/`compatibility_date`/… — is reported as `unclassified` rather
 * than ignored. That is the schema-drift escape hatch closed: a future
 * wrangler release that adds a stateful binding key must FAIL this check, not
 * slip past it.
 */
function collectBindings(data, text) {
  const bindings = [];
  const unclassified = [];
  if (data === null || typeof data !== "object")
    return { bindings, unclassified };

  /** One binding entry, whatever the name spelling, or `null` if it names none. */
  const nameOf = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.binding === "string") return entry.binding;
    if (typeof entry.name === "string") return entry.name;
    return null;
  };

  const take = (entry, kind, key, line) => {
    const name = nameOf(entry);
    if (name === null) {
      unclassified.push({
        key,
        line,
        why: "an entry with no `binding` or `name` string",
      });
      return;
    }
    bindings.push({ name, kind, key, line });
  };

  for (const [key, value] of Object.entries(data)) {
    if (NON_BINDING_KEYS.has(key)) continue;
    const line = lineOf(text, `"${key}"`) ?? 1;
    const kind = JSON_BINDING_KINDS[key] ?? `unclassified (${key})`;

    if (Array.isArray(value)) {
      for (const entry of value) take(entry, kind, key, line);
      continue;
    }
    if (value === null || typeof value !== "object") {
      unclassified.push({
        key,
        line,
        why: "a scalar where a binding table was expected",
      });
      continue;
    }
    if (key === "vars") {
      for (const name of Object.keys(value)) {
        bindings.push({ name, kind: "plain var", key, line });
      }
      continue;
    }
    // `durable_objects: { bindings: [...] }` and `queues: { producers: [...],
    // consumers: [...] }` — descend one level and take each sub-table.
    const nested = Object.entries(value).filter(
      ([, v]) => Array.isArray(v) || (v !== null && typeof v === "object"),
    );
    if (nested.length === 0) {
      unclassified.push({
        key,
        line,
        why: "an object with no binding tables inside it",
      });
      continue;
    }
    for (const [subKey, subValue] of nested) {
      const subKind = subKey === "bindings" ? kind : kind;
      const list = Array.isArray(subValue) ? subValue : [subValue];
      for (const entry of list) take(entry, subKind, `${key}.${subKey}`, line);
    }
  }
  return { bindings, unclassified };
}

/**
 * Find every wrangler config that declares a deployable, under
 * `infra/cloudflare/<env>/<app>/<file>` and the flat
 * `infra/cloudflare/<env>/<file>` spelling. Returns `{ path, flavour, data,
 * text, bindings, error, all }`, or `{ path: null, error }` when there is none
 * — which every caller reports as a skip.
 *
 * `appName` is the `apps/<app>` directory name, NOT `basename(workerDir)`.
 * Every Worker directory is called `worker`, so the basename is the literal
 * string "worker" for all three deployables and the search finds nothing —
 * which is exactly the bug this parameter's comment exists to prevent. A
 * discovery that silently matched nothing made every binding check report
 * `skipped`, and a run of nothing but skips is a run that proved nothing.
 *
 * A Worker is expected to have one config PER ENVIRONMENT, and each is judged
 * separately. Reading only the first would make a binding added to
 * `production/wrangler.jsonc` — the one that matters most — invisible to a
 * check that had already passed on `development`. So the primary config (the
 * first in `ENVIRONMENTS` order) carries `path`/`data`/`text` for the
 * name-agreement and registration checks, and `all` carries every config found
 * for the binding checks, which are the checks that must not miss one.
 *
 * The discovery order is fixed and the same for every Worker, so which file
 * won is a property of the repository and not of the order checks run in.
 */
function findWranglerConfig(appName, workerDir, root = REPO_ROOT) {
  const infraRoot = path.join(root, "infra", "cloudflare");
  const candidates = [];
  for (const name of WRANGLER_FILENAMES) {
    for (const env of ENVIRONMENTS) {
      candidates.push(path.join(infraRoot, env, appName, name));
      candidates.push(path.join(infraRoot, env, name));
    }
  }
  const all = [];
  for (const candidate of candidates) {
    if (!exists(candidate) || all.some((c) => c.path === candidate)) continue;
    const text = readTextOrNull(candidate);
    if (text === null) {
      all.push({
        path: candidate,
        error: "file could not be read",
        bindings: [],
      });
      continue;
    }
    if (candidate.endsWith(".toml")) {
      all.push({
        path: candidate,
        flavour: "toml",
        data: null,
        text,
        bindings: readTomlBindings(text),
        error: null,
        env: envOf(candidate, root),
      });
      continue;
    }
    const parsed = readJsonc(candidate);
    if (!parsed.ok) {
      all.push({
        path: candidate,
        flavour: "jsonc",
        error: parsed.error,
        text,
        bindings: [],
      });
      continue;
    }
    const collected = collectBindings(parsed.data, parsed.text);
    all.push({
      path: candidate,
      flavour: "jsonc",
      data: parsed.data,
      text: parsed.text,
      bindings: collected.bindings,
      unclassified: collected.unclassified,
      error: null,
      env: envOf(candidate, root),
    });
  }
  if (all.length === 0)
    return { path: null, error: "no wrangler config found" };
  return { ...all[0], all };
}

/** The environment directory a wrangler config sits in, or `(flat)`. */
function envOf(configPath, root) {
  const relPath = path.relative(
    path.join(root, "infra", "cloudflare"),
    configPath,
  );
  return relPath.split(path.sep)[0] ?? "(unknown)";
}

/* ------------------------------------------------------------------ *
 * The Rust dependency graph
 * ------------------------------------------------------------------ */

let cargoMetadataCache = null;

/**
 * The dependency graph, from `cargo metadata --format-version 1 --offline`.
 *
 * `--offline` because CI and a laptop both have the registry cache warm for a
 * committed `Cargo.lock`, and a network call in a gate is a gate that fails for
 * reasons unrelated to the tree. The cost is stated: a manifest that names a
 * dependency absent from the local cache cannot be resolved, and this returns
 * an error rather than a partial graph. The caller turns that error into
 * `could not run`, never into a pass.
 *
 * `--no-deps` is DELIBERATELY NOT USED, and dropping it is a bug this file
 * carries a comment about because it was one. `--no-deps` omits the `resolve`
 * key entirely — not an empty `resolve`, an absent one — so a reader that
 * expects it finds `undefined`, treats "no resolved edges" as "no
 * dependencies", and every cargo-based check in the file passes vacuously
 * against a tree that violates all of them. A silent green is the one outcome
 * this script may never produce. The full resolve costs about 30ms on a nine-
 * crate workspace; that is the right price for the evidence.
 *
 * Cached per process: the two checks that consume it must see one graph.
 */
function readRustGraph() {
  if (cargoMetadataCache) return cargoMetadataCache;
  const started = process.hrtime.bigint();
  let raw;
  try {
    raw = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--offline"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const detail =
      typeof error?.stderr === "string" && error.stderr.trim() !== ""
        ? error.stderr.trim().split("\n").slice(0, 4).join("; ")
        : (error?.message ?? "unknown error");
    cargoMetadataCache = {
      ok: false,
      error: `cargo metadata failed: ${detail}`,
      packages: [],
      edges: new Map(),
      members: [],
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
    return cargoMetadataCache;
  }
  const meta = JSON.parse(raw);
  if (meta.resolve === null || meta.resolve === undefined) {
    cargoMetadataCache = {
      ok: false,
      error:
        "cargo metadata returned no `resolve` graph, so no dependency edge could be read. This script judges the dependency law from the graph and NOT from manifest text, so a missing graph is an inability to run, never a clean tree.",
      packages: [],
      edges: new Map(),
      members: [],
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
    return cargoMetadataCache;
  }
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const memberIds = new Set(meta.workspace_members);
  const edges = new Map();
  const members = [];
  for (const id of memberIds) {
    const pkg = byId.get(id);
    if (!pkg) continue;
    const name = pkg.name;
    members.push(name);
    const node = meta.resolve?.nodes?.find((n) => n.id === id);
    const internal = [];
    const external = [];
    for (const dep of node?.deps ?? []) {
      const target = byId.get(dep.pkg);
      if (memberIds.has(dep.pkg)) {
        internal.push(target ? target.name : dep.name);
      } else {
        external.push({
          name: dep.name,
          source: target ? target.source : "unknown",
          path: target?.manifest_path ?? null,
        });
      }
    }
    edges.set(name, {
      internal: [...new Set(internal)].sort(),
      external,
      manifest: toPosix(pkg.manifest_path),
    });
  }
  cargoMetadataCache = {
    ok: true,
    error: null,
    packages: meta.packages,
    edges,
    members: members.sort(),
    workspaceRoot: meta.workspace_root,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
  return cargoMetadataCache;
}

/**
 * Transitive reachability over the INTERNAL graph, with the shortest path to
 * each reachable crate.
 *
 * `edges.get(name).internal` is DIRECT edges only, and reading only that is a
 * false negative waiting to happen. A boundary expressed as "X must not be able
 * to evaluate identity rules" is not a statement about the manifest, it is a
 * statement about what the compiled program contains. `identity-jobs-worker`
 * declaring `identity-security` looks compliant and is not: `identity-security`
 * depends on `identity-domain`, so the jobs Worker reaches the identity rule
 * engine through it. That is exactly the invariant `boundary-2-jobs-isolation`
 * exists to protect, and the direct-only reading reported it as clean.
 *
 * This walks the same graph object the other checks already read — no second
 * `cargo metadata` call and no new evidence to keep in sync. It returns a Map
 * from each reachable internal crate to the shortest path from `name`, because
 * "reachable through identity-security" is a reportable fact and "reachable"
 * alone is not enough for a reader to act on.
 *
 * The testkit exemption is deliberately NOT applied here: that is a judgment
 * about why an edge exists, and it belongs to the check that owns the law, not
 * to the graph reader.
 */
function internalReachability(graph, name) {
  const start = graph.edges.get(name);
  if (!start) return new Map();
  const paths = new Map();
  const queue = [];
  for (const direct of start.internal) {
    if (direct === name || paths.has(direct)) continue;
    paths.set(direct, [direct]);
    queue.push(direct);
  }
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    const edge = graph.edges.get(current);
    if (!edge) continue;
    for (const next of edge.internal) {
      if (next === name || paths.has(next)) continue;
      paths.set(next, [...paths.get(current), next]);
      queue.push(next);
    }
  }
  return paths;
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

/**
 * The severities a finding may carry, and what each one means for the exit
 * code.
 *
 * `violation` fails the run (EXIT_VIOLATIONS). `warning` is reported and
 * printed but exits 0 — it is for a fact a human must look at that is not
 * yet a breach, which is why every warning in this script carries the
 * constraint restated in its own message.
 *
 * This list is ENUMERATED rather than inferred from the `severity === "warning"`
 * test that used to be the whole mechanism, because that test makes every
 * typo a silent downgrade or upgrade:
 *
 * - `severity: "warn"` files as a VIOLATION. A check author who meant a
 *   heads-up fails the build for everyone, with a constraint text that reads
 *   like advice.
 * - `severity: "warning "` (trailing space), or `"Violation"`, does the same.
 * - The dangerous direction is the reverse: a check that INTENDED a hard
 *   violation and misspelled it as a warning-ish word is recorded in
 *   `warnings`, printed in yellow, and exits 0. A guard that fails open is
 *   worse than one that fails loud, and it fails silently.
 *
 * So an unknown severity throws instead of guessing. It is a bug in this
 * script, not in the tree being judged, and it must not be reported as a
 * finding about somebody's code.
 */
const SEVERITIES = ["violation", "warning"];

function formatFinding(finding) {
  const lines = [
    `  ${rel(finding.file)}${finding.line ? `:${finding.line}` : ""}`,
  ];
  lines.push(`      found:    ${finding.found}`);
  lines.push(`      broke:    ${finding.constraint}`);
  lines.push(`      fix:      ${finding.fix}`);
  return lines.join("\n");
}

function formatSkipped(skip) {
  return `  ${skip.check} — ${skip.file ?? "(no single file)"}: skipped — ${skip.reason}`;
}

class Report {
  constructor() {
    /** @type {Array<object>} */
    this.violations = [];
    /** @type {Array<object>} */
    this.warnings = [];
    /** @type {Array<object>} */
    this.skipped = [];
    /** @type {Map<string, object>} */
    this.checks = new Map();
  }

  runCheck(check, ctx) {
    const entry = {
      id: check.id,
      title: check.title,
      status: "pass",
      skipReason: null,
      error: null,
      violationCount: 0,
      warningCount: 0,
      evidence: [],
    };
    this.checks.set(check.id, entry);
    const before = { v: this.violations.length, w: this.warnings.length };
    let outcome;
    try {
      outcome = check.run(ctx);
    } catch (error) {
      entry.status = "error";
      entry.error = error?.message ?? String(error);
      outcome = { skipped: false, evidence: [] };
    }
    if (outcome && outcome.skipped) {
      entry.status = "skipped";
      entry.skipReason = outcome.reason;
      this.skipped.push({
        check: check.id,
        file: outcome.file ?? null,
        reason: outcome.reason,
      });
    }
    for (const item of outcome?.evidence ?? []) entry.evidence.push(item);
    entry.violationCount = this.violations.length - before.v;
    entry.warningCount = this.warnings.length - before.w;
    if (
      entry.status !== "skipped" &&
      entry.status !== "error" &&
      entry.violationCount > 0
    ) {
      entry.status = "violations";
    }
    return entry;
  }

  /**
   * Record a step of a check that did not run. Distinct from the check being
   * skipped: a check that half-ran is NOT a skipped check, and reporting it as
   * one would hide the half that did run. Both land in the coverage banner.
   */
  skip(check, { check: id = check, file = null, reason }) {
    this.skipped.push({ check: id, file, reason });
  }

  violation(check, file, line, found, constraint, fix, severity = "violation") {
    if (!SEVERITIES.includes(severity)) {
      throw new Error(
        `finding for "${check}" in ${rel(file)} has severity "${severity}", which is not one of ${SEVERITIES.join(", ")}`,
      );
    }
    const record = {
      check,
      file,
      line: line ?? null,
      found,
      constraint,
      fix,
      severity,
    };
    if (severity === "warning") this.warnings.push(record);
    else this.violations.push(record);
    return record;
  }

  get failed() {
    return this.violations.length > 0;
  }

  get errored() {
    return [...this.checks.values()].some((c) => c.status === "error");
  }
}

/* ------------------------------------------------------------------ *
 * Checks
 *
 * Each function below enforces exactly one constraint. Its doc comment names
 * the constraint in the brief's own words, because a check whose rule and whose
 * documentation disagree is the first thing to rot.
 * ------------------------------------------------------------------ */

const CHECKS = [
  {
    id: "boundary-1-admin-d1",
    title: "The Admin Worker holds no Identity D1 binding",
    constraint:
      "§3 — the Admin Worker MUST NOT access Identity D1 directly; §2 — Identity D1 is accessed only by the Identity Worker",
    catches:
      "any source file under apps/identity-admin/ naming IDENTITY_DB, and any d1_databases binding in the Admin Worker's wrangler config for any environment",
    doesNotCatch:
      "a D1 handle obtained under a different binding name and pointed at the identity database's id (the wrangler config is still read, and any d1_databases entry fails, but a renamed binding plus a hand-written database_id is only caught by the second half); and a config placed outside infra/cloudflare/**, which this check does not read",
    run: checkBoundary1AdminNoD1,
  },
  {
    id: "boundary-2-jobs-isolation",
    title:
      "The Jobs Worker reaches neither Identity D1 nor the identity rule engine",
    constraint:
      "§3/§5 — the Jobs Worker owns no identity state; §4 — identity-jobs must not depend on identity-domain or identity-application",
    catches:
      "IDENTITY_DB named anywhere under apps/identity-jobs/, any d1_databases binding in its wrangler config, and any cargo-metadata edge from identity-jobs-worker to identity-domain, identity-application or itself",
    doesNotCatch:
      "identity state reached over the IDENTITY service binding, which the brief explicitly permits (§3); and a path dependency that does not resolve, which fails the graph read and is reported as `could not run`, not as a pass",
    run: checkBoundary2JobsIsolation,
  },
  {
    id: "boundary-3-domain-platform",
    title: "The domain and application layers know nothing about Cloudflare",
    constraint:
      "§1 crate table and the brief's check 3 — identity-domain depends on nothing internal; identity-application depends only on identity-domain; neither depends on worker or identity-cloudflare, and no internal edge runs the wrong way",
    catches:
      "any internal dependency of a platform-free crate that is not on its permitted list, and any of the worker/worker-sys/worker-macros/wasm-bindgen crates appearing in a platform-free crate's resolved dependency set",
    doesNotCatch:
      "platform knowledge expressed without the platform crate — a hand-rolled SQL string, a `d1` identifier in a doc comment, or a `cloudflare:` type re-declared by hand. The dependency graph is the only evidence this check reads; a platform concept that never appears in Cargo.toml is invisible to it",
    run: checkBoundary3DomainPlatformFree,
  },
  {
    id: "boundary-4-no-frontend-in-backend",
    title: "Nothing in the backend imports or names a frontend package",
    constraint:
      "§8 and the brief's check 4 — the BFF behind a frontend is one release unit, not a shared library; crates/** and apps/*/worker/** may not import from apps/*/web/** or name a frontend package",
    catches:
      "an import specifier resolving into an apps/*/web/ directory, an import of another app's web by relative path, and the name of a known frontend package in a source file, a manifest or a CSS/link tag",
    doesNotCatch:
      "a frontend package this script has not heard of — the name list is the small, explicit one in FRONTEND_PACKAGES, and an unlisted Vue-ecosystem package is a gap in that list, not a false negative in the mechanism",
    run: checkBoundary4NoFrontend,
  },
  {
    id: "boundary-5-worker-registration",
    title: "Every Worker project is registered in all four places",
    constraint:
      "§7 — exactly three deployables, a fourth requires an ADR and proof; brief check 5 — a new apps/*/worker must appear in .moon/workspace.yml, the root Cargo.toml members, infra/cloudflare/ and release-please-config.json",
    catches:
      "an apps/*/worker/ with a Cargo.toml that any one of those four does not mention; a per-project moon.yml missing, or naming a different Worker than the directory implies; and a wrangler config whose declared name matches no known Worker",
    doesNotCatch:
      "a Worker directory with no Cargo.toml at all — a Worker is defined here as a `worker/Cargo.toml`, and a `worker/` directory holding only a `wrangler.jsonc` is reported as an untracked project by `deploymentable-count` instead",
    run: checkBoundary5WorkerRegistration,
  },
  {
    id: "deploymentable-count",
    title: "Exactly three deployables",
    constraint:
      "§7 — exactly three deployables: identity, identity-admin, identity-jobs",
    catches:
      "a fourth apps/*/worker/ project, a missing one, and a directory under apps/ that is neither a deployable nor a frontend (the operator frontend, `apps/identity-admin/web`, is a known non-deployable; anything else unrecognised fails)",
    doesNotCatch:
      "a second Worker inside a known deployable's directory (an `apps/identity/other-worker/`), which is a path this script does not walk — a `worker/Cargo.toml` is a Worker, and that one has no `worker/` in its path",
    run: checkExactlyThreeDeployables,
  },
  {
    id: "monorepo-self-contained",
    title: "No other Ecoma repository's source lives in this monorepo",
    constraint:
      "§28 — no other Ecoma repository's source lives in this monorepo",
    catches:
      "a file or directory path segment naming another Ecoma repository (ecoma, ecoma-cloud, runtime-trail, loom, action-agents, archkeep, release-craft, the three gateways, the injector), at any depth",
    doesNotCatch:
      "another repository's source vendored under a neutral directory name — `vendor/src/lib.rs` copied out of `loom` is not a path this check can recognise. The CLEAN output lists the walked file count so a reader can see the tree it judged",
    run: checkMonorepoSelfContained,
  },
  {
    id: "no-committed-secrets",
    title: "No production secret is committed",
    constraint:
      "§27 — .dev.vars and .env* are gitignored, and there are .example files instead",
    catches:
      "a tracked `.dev.vars`, a tracked `.env` that is not `.env.example`/`.env.example`/`.env.template`, and any tracked `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks` or `*.keystore` — read from the git INDEX, so a developer's untracked local `.dev.vars` does not fail the build",
    doesNotCatch:
      "a secret committed as an ordinary `.ts` or `.rs` file, a secret in a git history that was rewritten after it landed, or a tracked file named something else that contains one — this check judges filenames and extensions, not contents",
    run: checkNoCommittedSecrets,
  },
  {
    id: "no-auth-bypass",
    title: "No authentication bypass anywhere in the tree",
    constraint:
      "§26 — no authentication bypass for development: not a flag, not an env var, not a test-only role",
    catches:
      "an authentication-bypass token (`dev_auth_bypass`, `skip_auth`, `mock_user`, `insecure`, `DISABLE_AUTH`, …) in any source, manifest or script outside a test, the testkit, a canary fixture or a document",
    doesNotCatch:
      "a bypass spelled with a name not on that list — the list is the brief's, and a new spelling is a list change, not a mechanism change; and a bypass introduced as a Rust `#[cfg(feature)]` whose feature name is not a listed token",
    run: checkNoAuthBypass,
  },
  {
    id: "no-authoritative-kv-or-do",
    title: "No KV and no Durable Objects as authoritative identity state",
    constraint:
      "§24 — no KV and no Durable Objects as authoritative identity state in bootstrap",
    catches:
      "any durable_objects binding in any Worker config, in any environment, at any severity; and any kv_namespaces binding as a warning with the constraint restated",
    doesNotCatch:
      "a DO or KV reached by a binding name this script has not classified — an unrecognised binding table is reported as `unclassified (key)` and fails, so schema drift is caught; but a DO reached through a fetch() to a separately-deployed Worker is not a binding and is not caught",
    run: checkNoAuthoritativeKvOrDo,
  },
];

/**
 * Brief check 1 — Admin → Identity D1. §3.
 *
 * Two independent halves, because either alone is bypassable: source text and
 * the wrangler config. A handler that reads `env.IDENTITY_DB` fails the first;
 * a Worker whose *config* holds the binding fails the second even if no code
 * names it yet — which is the state a boundary is in before someone uses it.
 */
function checkBoundary1AdminNoD1(ctx) {
  const { report } = ctx;
  const evidence = [];
  const appDir = path.join(REPO_ROOT, "apps", "identity-admin");
  if (!isDirectory(appDir)) {
    return {
      skipped: true,
      file: rel(appDir),
      reason: "apps/identity-admin/ does not exist",
    };
  }

  // Half one: source text. Scanned for the whole application directory, not
  // only `worker/`, because the constraint is about the deployable.
  let scanned = 0;
  for (const file of walkFiles(appDir)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
    const text = readTextOrNull(file);
    if (text === null) continue;
    scanned += 1;
    for (const line of allLinesOf(text, /\bIDENTITY_DB\b/g)) {
      const lineText = text.split("\n")[line - 1];
      const prose = isProseLine(file, lineText);
      report.violation(
        "boundary-1-admin-d1",
        file,
        line,
        `IDENTITY_DB in ${rel(file)}: ${lineText.trim().slice(0, 160)}`,
        "§3 — the Admin Worker MUST NOT access Identity D1 directly",
        prose
          ? "This is a comment, so it cannot violate the constraint — but a comment naming a binding is a binding somebody will add. Confirm the sentence describes what the code does; if the code has started to do it, this is a violation and the sentence goes."
          : "The Admin Worker reaches identity through the private `IDENTITY` service binding. Delete the reference; `docs/architecture/admin-isolation.md` owns the reason.",
        prose ? "warning" : "violation",
      );
    }
  }
  evidence.push(`source files scanned under apps/identity-admin/: ${scanned}`);

  // Half two: the wrangler config, for every environment that has one.
  const config = ctx.wranglerFor("identity-admin");
  if (!config || !config.path) {
    // A missing file is a skip, never a pass — but a missing *one* Worker's
    // config in a tree where NO Worker has one is "not written yet", which is a
    // different message from "identity has a config and identity-admin does
    // not". The second is an asymmetry and a real violation.
    const anyConfig = ctx.workers.some(
      (w) => (ctx.wranglerFor(w.name) ?? {}).path,
    );
    if (anyConfig) {
      report.violation(
        "boundary-1-admin-d1",
        path.join(REPO_ROOT, "infra", "cloudflare"),
        null,
        `no wrangler config found for "identity-admin" under infra/cloudflare/, although another Worker has one`,
        "brief check 5 — a Worker project must appear in infra/cloudflare/ as a wrangler config",
        "Add infra/cloudflare/{development,staging,production}/identity-admin/wrangler.jsonc. An Admin Worker with no configuration is one nothing can deploy, and the constraint this check exists for is judged against a configuration that is not there.",
      );
    } else {
      return {
        skipped: true,
        file: path.join(REPO_ROOT, "infra", "cloudflare"),
        reason:
          'no wrangler config found for worker "identity-admin" under infra/cloudflare/ (searched wrangler.jsonc, wrangler.json, wrangler.toml in development/, staging/, production/)',
        evidence,
      };
    }
  } else {
    evidence.push(
      `admin wrangler configs: ${config.all.map((c) => `${rel(c.path)} (${c.flavour})`).join(", ")}`,
    );
    for (const one of config.all) {
      if (one.error) {
        report.skip("boundary-1-admin-d1", {
          check: "boundary-1-admin-d1",
          file: one.path,
          reason: `the admin Worker's wrangler config could not be read: ${one.error}`,
        });
        continue;
      }
      for (const binding of one.bindings) {
        if (binding.kind !== "D1") continue;
        const isIdentityDb = binding.name === IDENTITY_D1_BINDING;
        report.violation(
          "boundary-1-admin-d1",
          one.path,
          binding.line,
          isIdentityDb
            ? `d1_databases binding "${binding.name}" declared for the admin Worker in the ${one.env} environment`
            : `a D1 binding named "${binding.name}" is declared for the admin Worker; §3 forbids the Admin Worker from holding ANY database, not only one called IDENTITY_DB`,
          "§3 — the Admin Worker MUST NOT access Identity D1 directly",
          "Remove the d1_databases entry. The admin Worker has no database: identity through the `IDENTITY` service binding, and its own administrative storage is a separate decision that needs its own ADR (docs/architecture/admin-isolation.md).",
        );
      }
    }
  }
  return { skipped: false, evidence };
}

/**
 * Brief check 2 — Jobs → Identity D1 and Jobs → domain/application. §3, §4, §5.
 *
 * The D1 half is the same two-part check as the admin's. The dependency half
 * is read from the cargo graph, and the exemption path is the testkit: a
 * test-only double crate is not a product dependency, and holding the
 * domain's vocabulary inside it would be a test the production Worker could
 * not use anyway.
 */
function checkBoundary2JobsIsolation(ctx) {
  const { report, graph } = ctx;
  const evidence = [];
  const appDir = path.join(REPO_ROOT, "apps", "identity-jobs");
  if (!isDirectory(appDir)) {
    return {
      skipped: true,
      file: rel(appDir),
      reason: "apps/identity-jobs/ does not exist",
    };
  }

  let scanned = 0;
  for (const file of walkFiles(appDir)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
    const text = readTextOrNull(file);
    if (text === null) continue;
    scanned += 1;
    for (const line of allLinesOf(text, /\bIDENTITY_DB\b/g)) {
      const lineText = text.split("\n")[line - 1];
      const prose = isProseLine(file, lineText);
      report.violation(
        "boundary-2-jobs-isolation",
        file,
        line,
        `IDENTITY_DB in ${rel(file)}: ${lineText.trim().slice(0, 160)}`,
        "§5 — the Jobs Worker owns no identity state and §3 puts Identity D1 behind the Identity Worker",
        prose
          ? "This is a comment, so it cannot violate the constraint — but a comment naming a binding is a binding somebody will add. Confirm the sentence describes what the code does."
          : "A background consumer that can open the database can decide, not just record. Delete the reference; jobs talks to identity over the `IDENTITY` service binding.",
        prose ? "warning" : "violation",
      );
    }
  }
  evidence.push(`source files scanned under apps/identity-jobs/: ${scanned}`);

  const config = ctx.wranglerFor("identity-jobs");
  if (!config || !config.path) {
    const anyConfig = ctx.workers.some(
      (w) => (ctx.wranglerFor(w.name) ?? {}).path,
    );
    if (anyConfig) {
      report.violation(
        "boundary-2-jobs-isolation",
        path.join(REPO_ROOT, "infra", "cloudflare"),
        null,
        `no wrangler config found for "identity-jobs" under infra/cloudflare/, although another Worker has one`,
        "brief check 5 — a Worker project must appear in infra/cloudflare/ as a wrangler config",
        "Add infra/cloudflare/{development,staging,production}/identity-jobs/wrangler.jsonc. The D1 half of this check judges a configuration that does not exist, which is not a pass.",
      );
    } else {
      report.skip("boundary-2-jobs-isolation", {
        check: "boundary-2-jobs-isolation",
        file: path.join(REPO_ROOT, "infra", "cloudflare"),
        reason:
          'no wrangler config found for worker "identity-jobs" under infra/cloudflare/ — the D1 half of this check did not run',
      });
    }
  } else {
    evidence.push(
      `jobs wrangler configs: ${config.all.map((c) => `${rel(c.path)} (${c.flavour})`).join(", ")}`,
    );
    for (const one of config.all) {
      if (one.error) {
        report.skip("boundary-2-jobs-isolation", {
          check: "boundary-2-jobs-isolation",
          file: one.path,
          reason: `the jobs Worker's wrangler config could not be read: ${one.error}`,
        });
        continue;
      }
      for (const binding of one.bindings) {
        if (binding.kind !== "D1") continue;
        report.violation(
          "boundary-2-jobs-isolation",
          one.path,
          binding.line,
          `d1_databases binding "${binding.name}" declared for the jobs Worker in the ${one.env} environment`,
          "§5 — the Jobs Worker owns no identity state; §3 — Identity D1 is accessed only by the Identity Worker",
          "Remove the d1_databases entry. Jobs consumes a queue and calls out; it owns no database in the bootstrap configuration.",
        );
      }
    }
  }

  if (!graph.ok) {
    report.skip("boundary-2-jobs-isolation", {
      check: "boundary-2-jobs-isolation",
      file: "Cargo.toml",
      reason: graph.error,
    });
  } else {
    const edge = graph.edges.get("identity-jobs-worker");
    if (!edge) {
      report.skip("boundary-2-jobs-isolation", {
        check: "boundary-2-jobs-isolation",
        file: "apps/identity-jobs/worker/Cargo.toml",
        reason: "identity-jobs-worker is not a member of the Cargo workspace",
      });
    } else {
      const direct = edge.internal;
      evidence.push(
        `identity-jobs-worker direct internal dependencies: ${direct.join(", ") || "(none)"}`,
      );
      const manifest = path.join(REPO_ROOT, edge.manifest);
      const reachable = internalReachability(graph, "identity-jobs-worker");
      for (const target of JOBS_FORBIDDEN_INTERNAL) {
        if (target === "identity-jobs-worker") continue;
        const pathTo = reachable.get(target);
        if (!pathTo) continue;
        // The testkit is exempt because it is test-only. That exemption holds
        // only while EVERY route to the forbidden crate goes through it, so
        // the question is whether this path's first hop is the testkit — and a
        // direct edge is never exempt whatever else also reaches it.
        const viaTestkit =
          TESTKIT_PATH.test(pathTo[0]) && !direct.includes(target);
        if (viaTestkit) {
          evidence.push(
            `identity-jobs-worker -> ${target} is reached through crates/identity-testkit, which is test-only and exempt`,
          );
          continue;
        }
        const how = direct.includes(target)
          ? "a direct edge in the cargo graph"
          : `transitively, via ${pathTo.slice(0, -1).join(" -> ")}`;
        report.violation(
          "boundary-2-jobs-isolation",
          manifest,
          1,
          `identity-jobs-worker reaches ${target} (${how})`,
          "§4 — apps/identity-jobs/worker must not be able to reach identity-domain or identity-application, directly or through any crate that does",
          "Remove the edge. Jobs receives an event, performs an effect and records it; it does not evaluate identity rules, so it must not be able to. NOTE: no crate in this workspace is currently safe to depend on for this — identity-oidc, identity-security and identity-cloudflare ALL depend on identity-domain, so any of them carries the rule engine in with it. Until one of them is split so its wire types and error vocabulary live in a crate that does not reach identity-domain, the Jobs Worker's route table, its error envelope and its request types must live in the Worker crate itself. That is a real structural cost and it is the honest price of the isolation, not a workaround.",
        );
      }
    }
  }
  return { skipped: false, evidence };
}

/**
 * Brief check 3 — Domain → Cloudflare, plus the whole crate law in both
 * directions.
 *
 * Read from `cargo metadata` for the internal edges, because a `Cargo.toml`
 * regex cannot follow `identity-domain = { workspace = true }` to the crate it
 * names. Read from the *dependency* array for the platform crates, because
 * `--no-deps` does not report transitive resolution and the question "is
 * `worker` a dependency" is exactly the question that needs it.
 */
function checkBoundary3DomainPlatformFree(ctx) {
  const { report, graph } = ctx;
  if (!graph.ok) {
    return { skipped: true, file: "Cargo.toml", reason: graph.error };
  }
  const evidence = [`workspace members: ${graph.members.join(", ")}`];
  for (const name of Object.keys(CRATE_LAW).sort()) {
    const law = CRATE_LAW[name];
    const edge = graph.edges.get(name);
    if (!edge) {
      report.skip("boundary-3-domain-platform", {
        check: "boundary-3-domain-platform",
        file: `crates/${name}`,
        reason: `${name} is not a member of the Cargo workspace, so its internal edges were not judged`,
      });
      continue;
    }
    evidence.push(
      `${name} -> internal: ${edge.internal.join(", ") || "(none)"}`,
    );

    // Direction one: an internal dependency the law does not permit.
    if (law.internal !== null) {
      const permitted = new Set([...law.internal, name]);
      for (const target of edge.internal) {
        if (permitted.has(target)) continue;
        report.violation(
          "boundary-3-domain-platform",
          path.join(REPO_ROOT, edge.manifest),
          1,
          `${name} -> ${target}, which the crate table does not permit`,
          `§1 crate table — ${name} may depend on ${law.internal.length === 0 ? "nothing" : law.internal.join(", ")}`,
          law.internal.length === 0
            ? "This crate is the bottom of the internal graph. Whatever it needs from there belongs in it, or above it."
            : `Move the code that needs ${target} above ${name}, or put the types it shares in identity-domain.`,
        );
      }
    }

    // Direction two: a platform crate anywhere in this crate's resolved
    // dependencies, direct or transitive.
    for (const forbidden of law.forbiddenExternal) {
      for (const dep of edge.external) {
        if (dep.name !== forbidden) continue;
        report.violation(
          "boundary-3-domain-platform",
          // The external crate's OWN manifest, which is the evidence — not the
          // workspace crate's manifest with an external path grafted on. A
          // registry manifest is outside the repository, and a finding that
          // points outside the repository must say so rather than re-root.
          dep.path
            ? path.resolve(dep.path)
            : path.join(REPO_ROOT, edge.manifest),
          1,
          `${name} -> ${dep.name} (${dep.source}), declared in ${dep.path ? rel(dep.path) : "the workspace manifest"}`,
          "§1 and the brief's check 3 — the platform-free crates may not depend on the Cloudflare Workers runtime",
          "The domain rules must be expressible without a platform; a type that only exists because Cloudflare has it cannot be reviewed as a rule. Push the adapter down into identity-cloudflare and pass a plain value up.",
        );
      }
    }
  }
  return { skipped: false, evidence };
}

/**
 * Brief check 4 — Application → Vue, in the strongest form the tree allows.
 *
 * Two independent judgements, because either alone is bypassable. A *resolved
 * path* judgement walks every import specifier and asks which workspace project
 * it lands in — a relative import that climbs out of `crates/` into
 * `apps/identity/web` is caught even though its text never says "web". An
 * unresolved *name* judgement asks whether a known frontend package is named at
 * all. The second cannot be fooled by a spelling, and the first cannot be
 * fooled by a path; each is blind to what the other sees, and that is why
 * both run.
 */
function checkBoundary4NoFrontend(ctx) {
  const { report, webRoots } = ctx;
  const evidence = [];
  if (webRoots.length === 0) {
    return {
      skipped: true,
      file: "apps/*/web",
      reason:
        "no apps/*/web directory exists, so there is no frontend to keep the backend out of",
    };
  }
  evidence.push(`frontend roots: ${webRoots.map(rel).join(", ")}`);

  const roots = [
    { label: "crates/**", dir: path.join(REPO_ROOT, "crates") },
    ...ctx.workers.map((w) => ({
      label: `${rel(w.dir)}/**`,
      dir: w.dir,
      exempt: TESTKIT_PATH,
    })),
  ];
  let importCount = 0;
  const reported = new Set();
  /**
   * The specifiers judgement one has already reported, i.e. the ones that
   * resolved into a frontend directory. Judgement two uses this to avoid
   * reporting the same crossing twice, and ONLY this: the set holds resolved
   * workspace paths, never a bare package name.
   *
   * The narrower form of this rule matters. An earlier version skipped any
   * token that appeared inside any quoted string, which meant a genuine
   * `from "vue"` in a backend file was reported by neither judgement —
   * judgement one does not resolve a bare package name to a path, and
   * judgement two had just been switched off. That is the false green this
   * script exists to prevent, and it looked like a passing check.
   */
  const reportedSpecifiers = new Set();
  const reportOnce = (file, line, found, fix) => {
    // A Vue app naming `vue` in fifty places is one boundary crossing, and
    // fifty identical findings would bury the rest of this run's output.
    const key = `${rel(file)}:${line}:${found}`;
    if (reported.has(key)) return;
    reported.add(key);
    report.violation(
      "boundary-4-no-frontend-in-backend",
      file,
      line,
      found,
      "§8 and the brief's check 4 — a Worker or a crate may not import from apps/*/web/** or name a frontend package",
      fix,
    );
  };
  for (const root of roots) {
    if (!isDirectory(root.dir)) continue;
    for (const file of walkFiles(root.dir)) {
      const ext = path.extname(file);
      const isRust = ext === ".rs";
      const isWeb = new Set([
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".mjs",
        ".cjs",
        ".vue",
      ]).has(ext);
      if (!isRust && !isWeb) continue;
      if (root.exempt && root.exempt.test(rel(file))) continue;
      const text = readTextOrNull(file);
      if (text === null) continue;

      // Judgement one: the specifier as a path, resolved against the file.
      for (const match of importSpecifiers(text)) {
        importCount += 1;
        const target = resolveWorkspacePath(file, match.value);
        if (target && WEB_DIR_RE.test(target)) {
          reportedSpecifiers.add(match.value);
          reportOnce(
            file,
            match.line,
            `import "${match.value}" resolves to ${target}, which is a frontend directory`,
            "The BFF is a boundary, not a shared library. A frontend and the Worker behind it are one release unit, so a backend import of frontend code couples two things that ship together but are edited apart. Call the contract over HTTP instead.",
          );
        }
      }

      // Judgement two: the name of a frontend package, wherever it appears in
      // a file this check reads. A name that judgement one already reported —
      // because the specifier it appeared in resolved into a frontend
      // directory — is not reported again, because that is the same crossing
      // counted twice. Every other spelling, including a bare package name in
      // a quoted string, is a distinct crossing and is reported.
      const identifiers = identifierOccurrencesInFile(text);
      for (const { token, line } of identifiers) {
        const pkg = FRONTEND_PACKAGES.find(
          (name) => token === name || token.startsWith(`${name}/`),
        );
        if (!pkg) continue;
        if (reportedSpecifiers.has(token)) continue;
        if (isProseLine(file, lineTextAt(text, line))) continue;
        reportOnce(
          file,
          line,
          `the frontend package "${pkg}" is named in ${rel(file)}`,
          "Move the import behind HTTP, or move the shared types into `contracts/` as a generated artifact. If the name is in a comment saying the backend must not use it, say the rule without naming the package.",
        );
      }
    }
  }
  evidence.push(`import specifiers resolved: ${importCount}`);
  return { skipped: false, evidence };
}

/**
 * Brief check 5 — an untracked Worker project, and check 6 beside it.
 *
 * A Worker is registered in four places: `.moon/workspace.yml` (as a project
 * rooted at `apps/<name>/worker`), the root `Cargo.toml` members, a wrangler
 * config under `infra/cloudflare/`, and `release-please-config.json`. Four
 * places is not redundancy, it is four different consequences of being a
 * deployable: a task, a build, a target and a version. This check makes
 * adding a fifth place necessary to add a fourth Worker, which is the only
 * point at which a human can be in the loop.
 *
 * Wrangler and release-please are read through the readers above and their
 * absence is a skip, not a pass.
 */
function checkBoundary5WorkerRegistration(ctx) {
  const { report, workers, moonProjects, cargoMembers, releasePlease } = ctx;
  const evidence = [];
  if (workers.length === 0) {
    return {
      skipped: true,
      file: "apps",
      reason:
        "no apps/*/worker/Cargo.toml exists, so no Worker project could be judged",
    };
  }
  evidence.push(`worker projects: ${workers.map((w) => w.name).join(", ")}`);

  // The four registration places, and whether each one is present at all. A
  // place that does not exist is a SKIP; a place that exists and omits a
  // Worker is a VIOLATION. Conflating the two is how a guard becomes
  // decorative in a repository still being written.
  const infraDir = path.join(REPO_ROOT, "infra", "cloudflare");
  const infraPresent = ctx.workers.some((w) => {
    const config = ctx.wranglerFor(w.name);
    return Boolean(config && config.path);
  });
  if (!infraPresent) {
    report.skip("boundary-5-worker-registration", {
      check: "boundary-5-worker-registration",
      file: "infra/cloudflare",
      reason:
        "no wrangler config exists for ANY Worker under infra/cloudflare/, so the infra registration requirement could not be judged for any Worker",
    });
  }

  /**
   * Registration 4 of 4: a release-please component for this deployable.
   *
   * A function rather than a block inside the infra section, because the two
   * requirements are INDEPENDENT and an earlier version nested this one inside
   * the infra branch, where a `continue` taken for a missing wrangler config
   * silently skipped it. A Worker missing two of its four registrations was
   * told about one. A guard that reports what it happened to reach is a guard
   * with holes in it, and the hole was in the direction of reporting LESS.
   */
  const checkReleasePleaseRegistration = (worker) => {
    if (!releasePlease.ok) {
      report.skip("boundary-5-worker-registration", {
        check: "boundary-5-worker-registration",
        file: "release-please-config.json",
        reason: releasePlease.reason,
      });
      return;
    }
    const names = releasePlease.componentNames();
    // `names` is a Set. `.size`, not `.length` — and getting that wrong is the
    // quietest bug this file ever had: `undefined > 0` is false and
    // `undefined === 0` is false, so BOTH guards fell through and every Worker
    // was reported as having a release-please component, on every tree,
    // including one that has none. A missing release-please component is
    // invisible unless `.size` is read. The property is named explicitly on a
    // number so the next reader cannot reintroduce it.
    const componentCount = names.size;
    if (componentCount > 0 && !names.has(worker.name)) {
      report.violation(
        "boundary-5-worker-registration",
        releasePlease.path,
        null,
        `release-please-config.json has no component for "${worker.name}" (components: ${[...names].join(", ") || "none"})`,
        "§10 and brief check 5 — Release Please owns the version, the release PR and the tag of every deployable",
        "Add the component. A deployable with no version chain is deployed by something other than the release process, and §9 says release and deployment are different things.",
      );
    } else if (componentCount === 0) {
      report.skip("boundary-5-worker-registration", {
        check: "boundary-5-worker-registration",
        file: releasePlease.path,
        reason:
          "the file declares no `packages` map, so the component names this check would match on cannot be enumerated",
      });
    } else {
      evidence.push(`${worker.name}: release-please component`);
    }
  };

  for (const worker of workers) {
    // 1. Cargo workspace membership, read from the graph, not the manifest text.
    if (!ctx.graph.ok) {
      report.skip("boundary-5-worker-registration", {
        check: "boundary-5-worker-registration",
        file: "Cargo.toml",
        reason: ctx.graph.error,
      });
    } else if (!ctx.graph.edges.has(worker.crateName)) {
      report.violation(
        "boundary-5-worker-registration",
        path.join(REPO_ROOT, "Cargo.toml"),
        1,
        `${rel(worker.cargoToml)} declares package ${worker.crateName}, which is not a member of the Cargo workspace`,
        "brief check 5 — a Worker project must appear in the root Cargo.toml members",
        "Add the path to `members`. A crate outside the workspace does not build in CI and does not get the workspace lints, so it is a deployable nobody is holding to the law.",
      );
    } else {
      evidence.push(`${worker.crateName}: cargo workspace member`);
    }

    // 2. .moon/workspace.yml — the project map, and the project's own moon.yml.
    if (moonProjects.status !== "ok") {
      report.skip("boundary-5-worker-registration", {
        check: "boundary-5-worker-registration",
        file: ".moon/workspace.yml",
        reason: moonProjects.reason,
      });
    } else if (!moonProjects.projects.has(worker.project)) {
      report.violation(
        "boundary-5-worker-registration",
        path.join(REPO_ROOT, ".moon", "workspace.yml"),
        null,
        `${rel(worker.cargoToml)} is not mapped in .moon/workspace.yml (expected a project "${worker.project}" rooted at ${worker.relDir})`,
        "brief check 5 — a Worker project must appear in .moon/workspace.yml",
        "Add the entry. Without it moon never sees the project, so no task runs against it and `moon ci` reports green over a deployable it does not know exists.",
      );
    } else {
      evidence.push(`${worker.project}: mapped in .moon/workspace.yml`);
    }

    const projectMoon = path.join(worker.dir, "moon.yml");
    if (!exists(projectMoon)) {
      if (!moonProjects.filesFound) {
        // The whole per-project layer is absent. That is a tree still being
        // written, not a Worker that forgot its manifest.
        report.skip("boundary-5-worker-registration", {
          check: "boundary-5-worker-registration",
          file: rel(worker.dir),
          reason:
            "no per-project moon.yml exists anywhere in the tree, so the per-project manifest requirement could not be judged",
        });
      } else {
        report.violation(
          "boundary-5-worker-registration",
          worker.dir,
          null,
          `${rel(worker.dir)} has no moon.yml, so the root task vocabulary in moon.yml applies to a Rust Worker unchanged`,
          "brief check 5 and AGENTS.md — a new module arrives with its own moon.yml (tags included)",
          "Create moon.yml in the Worker directory declaring the Rust tasks (format, lint, typecheck, test, build, dev, package, wrangler-validate) and the tags module-boundaries.config.mjs judges. A `prettier --write` task aimed at a Rust crate is a task that reformats nothing and reports success.",
        );
      }
    } else {
      evidence.push(`${worker.project}: moon.yml present`);
    }

    // 3. infra/cloudflare/ — a wrangler config for this Worker.
    if (infraPresent) {
      const config = ctx.wranglerFor(worker.name);
      if (!config || !config.path) {
        report.violation(
          "boundary-5-worker-registration",
          infraDir,
          null,
          `no wrangler config found for "${worker.name}" under infra/cloudflare/, although another Worker has one`,
          "brief check 5 — a Worker project must appear in infra/cloudflare/ as a wrangler config",
          "Add infra/cloudflare/{development,staging,production}/<worker>/wrangler.jsonc. A Worker with no config is a Worker nothing can deploy, promote or roll back, which is the whole of §12–§14.",
        );
      } else if (config.flavour === "toml") {
        // Honesty: a wrangler.toml is read by a crude scanner. The check ran, but
        // say so rather than letting a green run imply a full parse.
        report.violation(
          "boundary-5-worker-registration",
          config.path,
          1,
          `"${worker.name}" is configured in wrangler.toml, which this repository's convention does not use`,
          "brief check 5 and tooling/scripts/EXPLANATION.md — a wrangler config is read as JSONC",
          "Convert it to wrangler.jsonc. The TOML reader is a scanner, not a parser: a binding declared across multiple lines is invisible to it, and this script says so rather than pretending the file was fully read.",
        );
      } else {
        evidence.push(`${worker.name}: wrangler config ${rel(config.path)}`);
        const declared = config.data?.name;
        if (declared !== worker.name) {
          report.violation(
            "boundary-5-worker-registration",
            config.path,
            config.data?.name === undefined
              ? null
              : lineOf(config.text, '"name"'),
            `wrangler config declares name "${declared}" but the project is "${worker.name}"`,
            "§7 — a deployable is called identity, identity-admin and identity-jobs everywhere that matters: wrangler names, release-please components, git tags",
            "Make the two names the same string. Every promotion, rollback and release references the deployable by its wrangler name, and a mismatch is an incident with a wrong version in it.",
          );
        }
      }
    }

    // 4. release-please-config.json — a version for this deployable. Judged
    // for every Worker, including one that is also missing its wrangler config:
    // four missing registrations are four findings, not one.
    checkReleasePleaseRegistration(worker);
  }

  // A wrangler config naming a Worker nobody declared: a deployable that is
  // registered in exactly one of the four places, which is the worst state.
  for (const orphan of ctx.wranglerOrphans) {
    report.violation(
      "boundary-5-worker-registration",
      orphan.path,
      lineOf(orphan.text, '"name"'),
      `wrangler config declares name "${orphan.declaredName}" but no apps/<name>/worker/Cargo.toml declares that Worker`,
      "brief check 5 — a deployable is registered in all four places or in none",
      "Either delete the config, or create the Worker project and register it. A wrangler config with no project behind it is a fourth deployable that nobody wrote an ADR for (§7).",
    );
  }
  if (cargoMembers.ok) {
    evidence.push(
      `cargo workspace members read: ${cargoMembers.members.length}`,
    );
  } else {
    report.skip("boundary-5-worker-registration", {
      check: "boundary-5-worker-registration",
      file: "Cargo.toml",
      reason: cargoMembers.reason,
    });
  }
  return { skipped: false, evidence };
}

/** Brief check 6 — exactly three deployables, and nothing else under apps/. */
function checkExactlyThreeDeployables(ctx) {
  const { report, workers, appDirs } = ctx;
  if (appDirs.length === 0) {
    return {
      skipped: true,
      file: "apps",
      reason: "no apps/* directory exists",
    };
  }
  const names = workers.map((w) => w.name).sort();
  for (const name of names) {
    if (DEPLOYABLES.includes(name)) continue;
    report.violation(
      "deploymentable-count",
      path.join(REPO_ROOT, "apps", name, "worker", "Cargo.toml"),
      1,
      `a fourth deployable: apps/${name}/worker is a Worker project named "${name}"`,
      "§7 — exactly three deployables: identity, identity-admin, identity-jobs; a fourth requires an ADR and proof it cannot live in one of the three",
      "Write the ADR first, and the proof. Until then, the work belongs in one of the three: a fourth Worker is a fourth set of bindings, a fourth version chain and a fourth thing to promote and roll back.",
    );
  }
  for (const required of DEPLOYABLES) {
    if (names.includes(required)) continue;
    report.violation(
      "deploymentable-count",
      path.join(REPO_ROOT, "apps", required),
      null,
      `deployable "${required}" has no apps/${required}/worker/Cargo.toml`,
      "§7 — exactly three deployables: identity, identity-admin, identity-jobs",
      "The bootstrap declares three. If one is genuinely retired, that is an ADR and a deletion, not a quiet absence.",
    );
  }
  for (const dir of appDirs) {
    if (workers.some((w) => w.name === dir)) continue;
    // An `apps/<name>/` that hosts a `web/` is a frontend, and `identity` and
    // `identity-admin` are exactly that: the pnpm workspace declares both, and
    // a check that flagged them would flag the frontends the brief mandates.
    // Anything else under apps/ is a directory this script cannot classify, and
    // an unclassifiable directory is where a fourth deployable hides.
    if (isDirectory(path.join(REPO_ROOT, "apps", dir, "web"))) continue;
    report.violation(
      "deploymentable-count",
      path.join(REPO_ROOT, "apps", dir),
      null,
      `apps/${dir} is neither one of the three deployables nor a frontend, and it has no worker/Cargo.toml`,
      "§7 and the brief's check 5 — a directory under apps/ is a deployable or a frontend, and this script cannot tell which this one is",
      "If it is a deployable, create apps/<name>/worker/Cargo.toml and register it in all four places. If it is a frontend, it needs a web/ directory this check can recognise. Either way the name goes in this script, in the same commit. Guessing is how a fourth deployable gets shipped.",
    );
  }
  return {
    skipped: false,
    evidence: [`deployables found: ${names.join(", ") || "(none)"}`],
  };
}

/** Brief check 7 — §28, no other Ecoma repository's source in this monorepo. */
function checkMonorepoSelfContained(ctx) {
  const { report } = ctx;
  const files = walkFiles(REPO_ROOT);
  const dirs = ctx.topDirs;
  const evidence = [`files walked: ${files.length}`];
  const repoPattern = new RegExp(`^(${ORG_REPOS.join("|")})$`, "i");
  // One report per offending path, not per offending segment and not per file
  // beneath it: a vendored `loom/` with four files in it is one boundary
  // crossing, and four identical findings would bury the other two thirds of
  // this run's output.
  const reported = new Set();

  const check = (pathParts) => {
    const offending = pathParts.findIndex((segment) =>
      repoPattern.test(segment),
    );
    if (offending === -1) return;
    const to = pathParts.length;
    const offendingPath = pathParts.slice(0, to).join("/");
    if (reported.has(offendingPath)) return;
    reported.add(offendingPath);
    report.violation(
      "monorepo-self-contained",
      path.join(REPO_ROOT, offendingPath),
      null,
      `path names another Ecoma repository: "${pathParts[offending]}" at ${offendingPath}`,
      "§28 — no other Ecoma repository's source lives in this monorepo",
      "Take a dependency (crates.io, the npm registry) or leave the source where it lives. A vendored copy is a fork nobody upgrades, and identity is the component every other Ecoma repository authenticates against — a stale copy of one of them is an outage nobody is paged for.",
    );
  };
  for (const dir of dirs) check(rel(dir).split("/"));
  for (const file of files) check(rel(file).split("/"));
  evidence.push(`top-level directories judged: ${dirs.map(rel).join(", ")}`);
  return { skipped: false, evidence };
}

/** Brief check 8 — §27, no production secret committed. Read from the index. */
function checkNoCommittedSecrets(ctx) {
  const { report } = ctx;
  if (ctx.git.status !== "ok") {
    return {
      skipped: true,
      file: ".git",
      reason: ctx.git.reason,
    };
  }
  if (ctx.git.tracked.length === 0) {
    // Not a pass. An empty index means `git ls-files` saw nothing, and a
    // check that can only ever see nothing must not report that as clean.
    report.violation(
      "no-committed-secrets",
      ".git/index",
      null,
      `the git index is empty (${ctx.git.reason})`,
      "§27 — .dev.vars and .env* are gitignored, and a check that cannot see the index cannot certify it",
      "Commit or stage the tree and re-run. Until the index has entries this check has no evidence and is reported as a violation rather than a pass, because a green run here is exactly the failure mode this script exists to prevent.",
    );
    return {
      skipped: false,
      evidence: ["git index empty — no evidence collected"],
    };
  }

  const evidence = [
    `tracked files read from the git index: ${ctx.git.tracked.length}`,
  ];
  for (const entry of ctx.git.tracked) {
    const found = secretFilenameVerdict(entry);
    if (!found) continue;
    report.violation(
      "no-committed-secrets",
      path.join(REPO_ROOT, entry),
      null,
      found,
      "§27 — no production secrets are committed; .dev.vars and .env* are gitignored and there are .example files instead",
      "Remove it from the index and from history (the key must be rotated either way — it was committed), then add the pattern to .gitignore and commit an .example file carrying the variable names and nothing else.",
    );
  }
  return { skipped: false, evidence };
}

/** Brief check 9 — §26, no authentication bypass anywhere. */
function checkNoAuthBypass(ctx) {
  const { report } = ctx;
  const files = walkFiles(REPO_ROOT);
  if (files.length === 0)
    return { skipped: true, file: ".", reason: "no files found to read" };
  const evidence = [`files scanned: ${files.length}`];
  let scanned = 0;
  let exempted = 0;

  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const text = readTextOrNull(file);
    if (text === null) continue;
    scanned += 1;
    const relative = rel(file);
    const why =
      AUTH_BYPASS_EXEMPT_PATTERNS.find((e) => e.re.test(relative))?.why ?? null;
    const isRust = ext === ".rs";
    for (const pattern of AUTH_BYPASS_PATTERNS) {
      const matcher = new RegExp(pattern, "g");
      for (const match of text.matchAll(matcher)) {
        const line = text.slice(0, match.index).split("\n").length;
        // §26's exemption, as implemented: a Rust `#[cfg(test)]` module does
        // not exist in a production build, so a bypass inside one is a test
        // fixture. Keyed on the attribute spelling, not on the word, so a
        // `// #[cfg(test)]` in a comment is not silently exempted.
        const afterCfg = isRust
          ? isInsideRustTestModule(text, match.index)
          : false;
        const exemption =
          why ?? (afterCfg ? "inside a #[cfg(test)] module" : null);
        if (exemption) {
          exempted += 1;
          continue;
        }
        const lineText = text.split("\n")[line - 1];
        report.violation(
          "no-auth-bypass",
          file,
          line,
          `${pattern} in ${relative}: ${lineText.trim().slice(0, 160)}`,
          "§26 — no authentication bypass for development, not a flag, not an env var, not a test-only role",
          "Delete the bypass. Local development runs the same code path with real secrets from a gitignored `.dev.vars`; that is what makes a dev environment worth trusting. ADR-0009 owns the decision.",
        );
      }
    }
  }
  evidence.push(`source files scanned: ${scanned}`);
  evidence.push(`matches exempt by path or by #[cfg(test)]: ${exempted}`);
  return { skipped: false, evidence };
}

/** Brief check 10 — §24, no KV and no Durable Objects as authoritative state. */
function checkNoAuthoritativeKvOrDo(ctx) {
  const { report, workers } = ctx;
  if (workers.length === 0) {
    return {
      skipped: true,
      file: "apps",
      reason:
        "no apps/*/worker/Cargo.toml exists, so no Worker has bindings to judge",
    };
  }
  const evidence = [];
  let configsRead = 0;
  for (const worker of workers) {
    const config = ctx.wranglerFor(worker.name);
    if (!config || !config.path) {
      report.skip("no-authoritative-kv-or-do", {
        check: "no-authoritative-kv-or-do",
        file: path.join(REPO_ROOT, "infra", "cloudflare"),
        reason: `no wrangler config found for "${worker.name}" under infra/cloudflare/`,
      });
      continue;
    }
    evidence.push(
      `${worker.name}: ${config.all.map((c) => `${rel(c.path)} (${c.flavour})`).join(", ")}`,
    );
    for (const one of config.all) {
      if (one.error) {
        report.skip("no-authoritative-kv-or-do", {
          check: "no-authoritative-kv-or-do",
          file: one.path,
          reason: `this wrangler config could not be read: ${one.error}`,
        });
        continue;
      }
      configsRead += 1;
      for (const binding of one.bindings) {
        if (binding.kind === "Durable Object") {
          report.violation(
            "no-authoritative-kv-or-do",
            one.path,
            binding.line,
            `durable_objects binding "${binding.name}" is declared for "${worker.name}" in the ${one.env} environment`,
            "§24 — no KV and no Durable Objects as authoritative identity state in bootstrap",
            "Remove the binding. A Durable Object holds identity state in a store that is not Identity D1, and the single-source-of-truth constraint (§1) is what every migration, backup and rollback path assumes. Rate limiting belongs on the Workers rate limiter.",
          );
        } else if (binding.kind === "KV") {
          report.violation(
            "no-authoritative-kv-or-do",
            one.path,
            binding.line,
            `kv_namespaces binding "${binding.name}" is declared for "${worker.name}" in the ${one.env} environment`,
            "§24 — no KV as authoritative identity state; KV is for rate limits and counters only",
            "If the namespace carries counters, the name should say so — the name is what a later reader trusts. If it carries identity state, the state belongs in Identity D1, where the migrations and the audit trail are.",
            "warning",
          );
        } else if (binding.kind.startsWith("unclassified")) {
          report.violation(
            "no-authoritative-kv-or-do",
            one.path,
            binding.line,
            `binding "${binding.name}" is declared under ${binding.key}, which this script does not classify`,
            "§24, enforced only if the binding table is understood — an unrecognised table is how a DO binding arrives unnoticed",
            "Add the key to NON_BINDING_KEYS if it is not a binding, or to JSON_BINDING_KINDS with its kind if it is. An unclassified binding is refused rather than ignored on purpose: a new wrangler key that declares state must fail this check, not slip through it.",
          );
        }
      }
    }
  }
  evidence.push(`wrangler configs read: ${configsRead}`);
  return { skipped: false, evidence };
}

/* ------------------------------------------------------------------ *
 * Import specifiers
 * ------------------------------------------------------------------ */

/**
 * Every import-like specifier in a file, with the line it is on.
 *
 * Rust `use` paths and `include_str!`/`include_bytes!` are included because
 * each is a way to reach across a boundary that no manifest records:
 * `include_str!("../../../identity/web/src/main.ts")` compiles a file from
 * another project INTO this crate, so the backend holds frontend source and
 * the Cargo graph is silent about it. A pattern set without it is not a
 * narrower check, it is a check with a hole in the one language where the hole
 * is reachable.
 */
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\buse\s+([A-Za-z0-9_:]+(?:::[A-Za-z0-9_*]+)*)\s*;/g,
  /\b(?:include_str|include_bytes)!\s*\(\s*["']([^"']+)["']\s*\)/g,
];
function importSpecifiers(text) {
  const out = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      out.push({
        value: match[1],
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  return out;
}

/**
 * Resolve an import specifier that names a workspace path to a
 * repository-relative, forward-slash path, or `null` when the specifier is not
 * a workspace path (a bare package name, a Node built-in, a relative path that
 * leaves the repository).
 *
 * Deliberately narrow and documented: it handles `@/`-style aliases as not a
 * workspace path, and it treats a bare `foo/bar` as workspace-relative to the
 * repository root. That is the reading every `apps/<name>/web` import in this
 * tree uses.
 */
function resolveWorkspacePath(fromFile, specifier) {
  const from = path.dirname(fromFile);
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(from, specifier);
    const relative = rel(resolved);
    return relative.startsWith("..") ? null : relative;
  }
  if (specifier.startsWith("/")) return null;
  if (specifier.startsWith("@") || specifier.startsWith("~")) return null;
  if (!specifier.includes("/")) return null;
  if (specifier.startsWith("node:")) return null;
  // A bare multi-segment specifier: a workspace path or a scoped package.
  if (specifier.startsWith("@")) return null;
  const candidate = path.join(REPO_ROOT, specifier);
  if (exists(candidate)) return rel(candidate);
  // `@scope/pkg/sub` is a package subpath, not a workspace path.
  return null;
}

/**
 * True when the token at character offset `matchIndex` sits inside a Rust
 * `#[cfg(test)]` module.
 *
 * The walk is over CHARACTERS, not lines, and it starts at the match rather
 * than at the line it is on. Both details are load-bearing: a match inside a
 * test function is usually on the `fn` line itself, and a line-based walk finds
 * that function's own opening brace and concludes the enclosing block is a
 * function — which exempts nothing and is the single most likely way for this
 * check to become noise.
 */
function isInsideRustTestModule(text, matchIndex) {
  let depth = 0;
  for (let i = matchIndex - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) return isCfgTestBlockHeader(text, i);
      depth -= 1;
    }
  }
  return false;
}

/**
 * True when the block whose opening brace is at `braceIndex` is a test module:
 * a `mod <name>` whose declaration line, or one of the three non-blank lines
 * above it, is `#[cfg(test)]` or `#[cfg(…test…)]`. A `cfg` that does not
 * mention `test` is not an exemption — that is the whole content of the rule.
 *
 * The upward search SKIPS BLANK LINES rather than taking the byte range
 * between two newlines. A `#[cfg(test)]` is conventionally on the line
 * directly above its `mod`, and taking the range would then include it — but
 * a blank line between the two (a rustfmt-legal, git-hostile arrangement that
 * happens) would yield an empty range and no exemption, which is a failure
 * that looks exactly like a working check.
 */
function isCfgTestBlockHeader(text, braceIndex) {
  const headerStart = text.lastIndexOf("\n", braceIndex) + 1;
  const header = text.slice(headerStart, braceIndex);
  if (!/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+/.test(header)) return false;
  const lines = text.slice(0, headerStart).split("\n");
  let examined = 0;
  for (let i = lines.length - 1; i >= 0 && examined < 3; i -= 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    examined += 1;
    if (/^#\[cfg\((?:[^\]]*\btest\b[^\]]*)\)\]$/.test(line)) return true;
    if (line.startsWith("#[")) return false; // a different attribute governs this block
  }
  return false;
}

/**
 * Classify a line as prose or code, per file extension.
 *
 * WHY THIS EXISTS. A check that fires on the *documentation* of the constraint
 * it enforces is a check that gets switched off: the first time
 * `check-architecture.mjs` reported the sentence "the Admin Worker does NOT
 * take an `IDENTITY_DB` binding" in a manifest comment, the correct response
 * was to fix the check, not the comment — the comment is the constraint, and
 * deleting it to satisfy the tool would make the tree worse.
 *
 * So a mention in a comment is reported as a WARNING — visible, reviewable,
 * never blocking — and a mention in code is a violation. The distinction is
 * not cosmetic: code that names a D1 binding can open it, and a comment
 * cannot. What a comment CAN hide is an intent ("add the admin D1 binding
 * tomorrow"), which is why it is reported at all rather than filtered out.
 */
function isProseLine(file, lineText) {
  const trimmed = lineText.trim();
  const ext = path.extname(file);
  if (ext === ".toml" || ext === ".yml" || ext === ".yaml")
    return trimmed.startsWith("#");
  if (ext === ".rs") return trimmed.startsWith("//");
  if (ext === ".sh") return trimmed.startsWith("#");
  if (ext === ".vue")
    return (
      trimmed.startsWith("//") ||
      trimmed.startsWith("<!--") ||
      trimmed.startsWith("*")
    );
  if (ext === ".sql") return trimmed.startsWith("--");
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("<!--")
  );
}

/* ------------------------------------------------------------------ *
 * The workspace readers
 * ------------------------------------------------------------------ */

/**
 * `.moon/workspace.yml` and each project's `moon.yml`.
 *
 * A purpose-written reader, not a YAML parser, and here is exactly what it
 * does and does not do.
 *
 * It reads the `projects:` block of a Moon workspace file: two-space-indented
 * `name: path` pairs under `projects:`, values possibly quoted. It reads each
 * project's `moon.yml` for the same two keys — the project `id` and the
 * `tags:` list of `- value` entries.
 *
 * It DOES NOT handle anchors and aliases (`&x`/`*x`), multi-line scalars, flow
 * mappings (`{ a: b }`), nested structures under a project path, or any YAML
 * this repository's Moon files do not use. If it meets a line it does not
 * recognise inside the block it is reading it records the file as
 * `unparsed` with the line number, and the checks that depend on it report a
 * SKIP with that reason. A reader that guessed would turn a YAML feature into
 * a silent pass, which is the one outcome this file refuses.
 */
function readMoonProjectMap() {
  const file = path.join(REPO_ROOT, ".moon", "workspace.yml");
  if (!exists(file)) {
    return {
      status: "absent",
      reason: ".moon/workspace.yml does not exist",
      projects: new Map(),
      filesFound: 0,
    };
  }
  const parsed = parseMoonProjectBlock(readText(file), file);
  if (parsed.status !== "ok") {
    return { ...parsed, projects: new Map(), filesFound: 0 };
  }
  const projects = new Map();
  let filesFound = 0;
  for (const [id, root] of parsed.entries) {
    const projectFile = path.join(REPO_ROOT, root, "moon.yml");
    let tags = [];
    let tagsStatus = "ok";
    if (!exists(projectFile)) {
      tagsStatus = "absent";
    } else {
      filesFound += 1;
      const projectParsed = parseMoonProjectBlock(
        readText(projectFile),
        projectFile,
      );
      if (projectParsed.status !== "ok") {
        tagsStatus = `unparsed (${projectParsed.reason})`;
      } else {
        tags = projectParsed.tags;
      }
    }
    projects.set(id, { id, root, tags, tagsStatus });
  }
  return { status: "ok", reason: null, projects, file, filesFound };
}

function parseMoonProjectBlock(text, file) {
  const projects = new Map();
  const lines = text.split("\n");
  let inProjects = false;
  let projectsIndent = 0;
  const tags = [];
  let inTags = false;
  let tagsIndent = 0;
  const unrecognised = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!inProjects) {
      if (/^projects:\s*(#.*)?$/.test(line)) {
        inProjects = true;
        projectsIndent = indent;
      }
      continue;
    }
    if (indent <= projectsIndent && !/^\s/.test(raw)) {
      // A new top-level key ends the block.
      inProjects = false;
      inTags = false;
      continue;
    }
    if (/^tags:\s*(#.*)?$/.test(line)) {
      inTags = true;
      tagsIndent = indent;
      continue;
    }
    if (inTags) {
      const item = /^-\s+(\S+)\s*(#.*)?$/.exec(line);
      if (item && indent > tagsIndent) {
        tags.push(item[1].replace(/^["']|["']$/g, ""));
        continue;
      }
      inTags = false;
    }
    const pair = /^([A-Za-z0-9_@./-]+):\s*(\S.*?)\s*$/.exec(line);
    if (pair && indent > projectsIndent) {
      const value = pair[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (value.startsWith("[") || value.startsWith("{")) {
        unrecognised.push(`line ${i + 1}: flow-style value for "${pair[1]}"`);
        continue;
      }
      projects.set(pair[1], value);
      continue;
    }
    if (!line.startsWith("#")) unrecognised.push(`line ${i + 1}: ${line}`);
  }
  if (unrecognised.length > 0) {
    return {
      status: "unparsed",
      reason: `${rel(file)} contains ${unrecognised.length} line(s) this reader does not understand (${unrecognised[0]}) — the project map was NOT read, and every check that depends on it was skipped rather than passed`,
      entries: [],
      tags,
    };
  }
  return { status: "ok", reason: null, entries: [...projects.entries()], tags };
}

/**
 * The root `Cargo.toml` members, read with a `key = [ … ]` scanner.
 *
 * The authoritative answer is `cargo metadata`; this exists so the message for
 * "you added a directory but not the member" can name the manifest, and so
 * check 5 can report a missing membership without a second cargo invocation.
 * A members list written in TOML's multi-line form is the only shape it
 * handles, which is the only shape this workspace's `[workspace]` uses.
 */
function readCargoMembers() {
  const file = path.join(REPO_ROOT, "Cargo.toml");
  if (!exists(file)) {
    return {
      ok: false,
      reason: "Cargo.toml does not exist",
      members: [],
      path: file,
    };
  }
  const text = readText(file);
  const start = text.indexOf("members");
  if (start === -1) {
    return {
      ok: false,
      reason: "Cargo.toml has no `members` key",
      members: [],
      path: file,
    };
  }
  const open = text.indexOf("[", start);
  const close = text.indexOf("]", open);
  if (open === -1 || close === -1) {
    return {
      ok: false,
      reason: "Cargo.toml's `members` is not an inline array",
      members: [],
      path: file,
    };
  }
  const members = text
    .slice(open + 1, close)
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "" && !s.startsWith("#"));
  return { ok: true, reason: null, members, path: file };
}

/**
 * `release-please-config.json`'s component names, read as JSON.
 *
 * Release Please's own `packages` map is an object keyed by path, and the
 * component name is whatever the component calls itself. A `node` component
 * declares `package-name`; a Rust deployable conventionally uses the
 * `package-name` field for the same reason, and that is the field matched
 * here. A configuration whose components carry no name at all yields an empty
 * set, and the callers treat an empty set as "cannot enumerate" and skip
 * rather than pass.
 */
function readReleasePlease() {
  const file = path.join(REPO_ROOT, "release-please-config.json");
  if (!exists(file)) {
    return {
      ok: false,
      path: file,
      reason: "release-please-config.json does not exist yet",
      componentNames: () => new Set(),
    };
  }
  const parsed = readJsonc(file);
  if (!parsed.ok) {
    return {
      ok: false,
      path: file,
      reason: `release-please-config.json ${parsed.error}`,
      componentNames: () => new Set(),
    };
  }
  const packages = parsed.data?.packages;
  if (
    packages === null ||
    typeof packages !== "object" ||
    Array.isArray(packages)
  ) {
    return {
      ok: false,
      path: file,
      reason:
        "release-please-config.json declares no `packages` map, so component names cannot be enumerated",
      componentNames: () => new Set(),
    };
  }
  const names = new Set();
  for (const [key, value] of Object.entries(packages)) {
    if (
      value &&
      typeof value === "object" &&
      typeof value["package-name"] === "string"
    ) {
      names.add(value["package-name"]);
    } else {
      names.add(key === "." ? "root" : key);
    }
  }
  return { ok: true, path: file, reason: null, componentNames: () => names };
}

/**
 * The git index, through `git ls-files -z`.
 *
 * The index and not the working tree, deliberately: §27 is about what is
 * committed, and a developer's local, gitignored `.dev.vars` must not fail the
 * build for the wrong reason. A repository with no commits is reported as
 * `empty` rather than as clean.
 */
function readGitIndex() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tracked = out.split("\0").filter((s) => s !== "");
    if (tracked.length === 0) {
      let reason = "git ls-files returned no entries";
      try {
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: REPO_ROOT,
          stdio: "ignore",
        });
        reason =
          "git ls-files returned no entries although HEAD resolves — the index is empty";
      } catch {
        reason =
          "the repository has no commits and the index is empty, so no tracked file could be read";
      }
      return { status: "empty", reason, tracked };
    }
    return { status: "ok", reason: null, tracked };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `git ls-files failed: ${error?.message ?? "unknown error"}`,
      tracked: [],
    };
  }
}

/* ------------------------------------------------------------------ *
 * Context assembly
 * ------------------------------------------------------------------ */

function buildContext() {
  const report = new Report();
  const graph = readRustGraph();
  const cargoMembers = readCargoMembers();
  const moonProjects = readMoonProjectMap();
  const releasePlease = readReleasePlease();
  const git = readGitIndex();

  // The apps/ directories, one level down only. A `web` or `worker`
  // subdirectory is not a deployable and is not judged as one.
  const appsRoot = path.join(REPO_ROOT, "apps");
  const appDirs = exists(appsRoot)
    ? fs
        .readdirSync(appsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !WALK_SKIP_DIRS.has(e.name))
        .map((e) => e.name)
        .sort()
    : [];
  const webRoots = appDirs
    .map((name) => path.join(appsRoot, name, "web"))
    .filter((dir) => isDirectory(dir));

  // A Worker project is a directory under apps/ that has worker/Cargo.toml.
  // This is the definition every check below uses, so "a fourth Worker" and
  // "an unregistered Worker" cannot mean different things.
  const workers = [];
  for (const name of appDirs) {
    const cargoToml = path.join(appsRoot, name, "worker", "Cargo.toml");
    if (!exists(cargoToml)) continue;
    const text = readTextOrNull(cargoToml) ?? "";
    const declared = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
    const workerName = WORKER_NAMES[name] ?? name;
    workers.push({
      name: workerName,
      appName: name,
      crateName: declared ? declared[1] : `${name}-worker`,
      dir: path.join(appsRoot, name, "worker"),
      relDir: rel(path.join(appsRoot, name, "worker")),
      cargoToml,
      project: `${workerName}-worker`,
      manifest: text,
    });
  }

  // Wrangler configs, resolved once and shared by every check that needs one.
  const wranglerCache = new Map();
  const wranglerOrphans = [];
  for (const worker of workers) {
    const config = findWranglerConfig(worker.appName, worker.dir);
    wranglerCache.set(worker.name, config);
    if (config.path && config.data && typeof config.data.name === "string") {
      if (!workers.some((w) => w.name === config.data.name)) {
        wranglerOrphans.push({
          path: config.path,
          text: config.text ?? "",
          declaredName: config.data.name,
        });
      }
    }
  }
  // A wrangler config that no worker's own directory owns, and that declares
  // a name no `apps/<name>/worker/Cargo.toml` declares. The `findWranglerConfig`
  // search above would attribute a flat `infra/cloudflare/<env>/wrangler.jsonc`
  // to whichever worker it happened to reach first, so the flat layout is
  // walked separately and its declared name is what decides.
  for (const env of ENVIRONMENTS) {
    for (const name of WRANGLER_FILENAMES) {
      const candidate = path.join(REPO_ROOT, "infra", "cloudflare", env, name);
      if (!exists(candidate)) continue;
      const parsed = readJsonc(candidate);
      if (!parsed.ok) continue;
      const declaredName = parsed.data?.name;
      if (typeof declaredName !== "string") continue;
      if (workers.some((w) => w.name === declaredName)) continue;
      wranglerOrphans.push({
        path: candidate,
        text: parsed.text,
        declaredName,
      });
    }
  }

  const topDirs = fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(REPO_ROOT, e.name));

  const ctx = {
    report,
    graph,
    cargoMembers,
    moonProjects,
    releasePlease,
    git,
    appDirs,
    webRoots,
    workers,
    wranglerCache,
    wranglerOrphans,
    topDirs,
    runOrder: [],
    wranglerFor: (name) => wranglerCache.get(name) ?? null,
  };
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const YELLOW = "[33m";
const CYAN = "[36m";
const RESET = "[0m";

/**
 * Whether a stream may be painted.
 *
 * The `NO_COLOR` convention (no-color.org) is honoured unconditionally, and a
 * stream that is not a terminal gets no escape codes because nobody would see
 * them but every redirect and CI log would carry them. `--no-color` is applied
 * by the caller through `parsed.color`, which is a *request*; this function
 * decides whether the request can be granted.
 *
 * Defined here, once, rather than as an inlined condition at the call site: a
 * second spelling of this rule is a second place to change it.
 */
function useColor(stream) {
  return process.env.NO_COLOR === undefined && Boolean(stream.isTTY);
}

function paint(color, enabled, text) {
  return enabled ? `${color}${text}${RESET}` : text;
}

function printResults(ctx, { color, parsed = {} }) {
  const { report } = ctx;
  const out = process.stdout;

  out.write("\n");
  out.write(`${paint(BOLD, color, "ecoma-identity · architecture check")}\n`);
  out.write(
    `${paint(DIM, color, `${VIRTUAL_NOW} · ten constraints · cargo graph in ${ctx.graph.ok ? `${ctx.graph.elapsedMs.toFixed(0)}ms` : "FAILED"}`)}\n`,
  );

  const byCheck = new Map();
  for (const check of CHECKS) byCheck.set(check.id, []);
  for (const finding of [...report.violations, ...report.warnings]) {
    if (!byCheck.has(finding.check)) byCheck.set(finding.check, []);
    byCheck.get(finding.check).push(finding);
  }

  // The printed list is the RUN list, not the full catalogue: with `--only`,
  // a check that did not run has no entry, and printing the whole catalogue
  // would show ten "ok" lines for a run that judged one.
  for (const check of ctx.runOrder) {
    const entry = report.checks.get(check.id);
    const findings = byCheck.get(check.id) ?? [];
    const violations = findings.filter((f) => f.severity === "violation");
    const warnings = findings.filter((f) => f.severity === "warning");
    let badge;
    if (entry.status === "skipped") {
      badge = paint(YELLOW, color, "SKIPPED");
    } else if (entry.status === "error") {
      badge = paint(RED, color, "ERRORED ");
    } else if (violations.length > 0) {
      badge = paint(RED, color, "FAILED  ");
    } else if (warnings.length > 0) {
      badge = paint(YELLOW, color, "WARNINGS");
    } else {
      badge = paint(CYAN, color, "ok      ");
    }
    out.write(
      `\n  ${badge} ${check.id}  ${paint(DIM, color, `(${violations.length} violation${violations.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"})`)}\n`,
    );
    out.write(`           ${check.title}\n`);
    for (const finding of violations) out.write(`${formatFinding(finding)}\n`);
    for (const finding of warnings) out.write(`${formatFinding(finding)}\n`);
    if (entry.status === "skipped") {
      out.write(`           skipped — ${entry.skipReason}\n`);
    }
    if (entry.status === "error") {
      out.write(`           errored — ${entry.error}\n`);
    }
  }

  // The banner. The most important paragraph this program prints: a green run
  // that silently covered nothing is the failure mode that gets a boundary
  // deleted, so the coverage it did NOT have is stated as loudly as what it
  // did.
  out.write("\n");
  if (parsed.only && parsed.only.size < CHECKS.length) {
    out.write(
      `${paint(YELLOW, color, "COVERAGE")}  partial run: ${parsed.only.size} of ${CHECKS.length} checks were selected with --only. The ${CHECKS.length - parsed.only.size} unselected checks did not run.\n`,
    );
  }
  if (report.skipped.length === 0) {
    out.write(
      `${paint(BOLD, color, "COVERAGE")}  all ${ctx.runOrder.length} checks ran. No file this script reads was missing.\n`,
    );
  } else {
    out.write(
      `${paint(YELLOW, color, "COVERAGE")}  ${report.skipped.length} check step${report.skipped.length === 1 ? "" : "s"} did NOT run. This run is not a full verdict:\n`,
    );
    for (const skip of report.skipped) out.write(`${formatSkipped(skip)}\n`);
  }

  const totalWarnings = report.warnings.length;
  out.write("\n");
  if (report.failed) {
    out.write(
      `${paint(RED, color, `FAILED`)}  ${report.violations.length} violation${report.violations.length === 1 ? "" : "s"} of a hard constraint${totalWarnings > 0 ? `, ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}` : ""}.\n`,
    );
  } else if (totalWarnings > 0) {
    out.write(
      `${paint(YELLOW, color, `PASSED with ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`)}  no hard constraint was violated.\n`,
    );
  } else {
    out.write(
      `${paint(CYAN, color, "PASSED")}  no hard constraint was violated.\n`,
    );
  }
  out.write("\n");
}

function writeJsonReport(ctx, file) {
  const payload = {
    tool: "check-architecture",
    repository: "ecoma-identity",
    constraintsJudged: CHECKS.length,
    generatedFrom: "the repository as found on disk",
    checks: CHECKS.map((check) => {
      const entry = ctx.report.checks.get(check.id);
      const findings = [
        ...ctx.report.violations,
        ...ctx.report.warnings,
      ].filter((f) => f.check === check.id);
      return {
        id: check.id,
        title: check.title,
        constraint: check.constraint,
        catches: check.catches,
        doesNotCatch: check.doesNotCatch,
        status: entry?.status ?? "not-run",
        skipReason: entry?.skipReason ?? null,
        evidence: entry?.evidence ?? [],
        findings: findings.map((f) => ({
          severity: f.severity,
          file: rel(f.file),
          line: f.line,
          found: f.found,
          constraint: f.constraint,
          fix: f.fix,
        })),
      };
    }),
    skipped: ctx.report.skipped,
    violations: ctx.report.violations.length,
    warnings: ctx.report.warnings.length,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const USAGE = `check-architecture — the executable form of ecoma-identity's boundary law

USAGE
  node tooling/scripts/check-architecture.mjs [options]

OPTIONS
  --list-checks        print every check, the constraint it enforces and what
                       it does not catch, then exit 0 without judging anything
  --explain <check>    print one check in full (its id, or its number) and exit
  --only <ids>         comma-separated check ids to run; everything else is
                       reported as not-run
  --json <file>        also write a machine-readable report to <file>
  --root <dir>         judge <dir> instead of the repository this script lives
                       in. Intended for the canary fixture tree; --json is
                       how the test suite reads the result of a fixture run.
                       Implemented by re-executing this same file with
                       ECOMA_IDENTITY_ROOT set, so the fixture runs the real
                       checks and not a second implementation of them.
  --no-color           never colour the output
  -h, --help           this text

EXIT CODES
  0   clean, or warnings only
  1   at least one violation of a hard constraint
  2   the run could not be completed (cargo metadata failed, git unavailable)
  64  the command line was wrong
`;

function parseArgs(argv) {
  const options = {
    listChecks: false,
    explain: null,
    only: null,
    json: null,
    root: null,
    color: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list-checks") options.listChecks = true;
    else if (arg === "--explain") options.explain = argv[++i] ?? null;
    else if (arg === "--only") {
      const value = argv[++i] ?? "";
      options.only = new Set(
        value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === "--json") options.json = argv[++i] ?? null;
    else if (arg === "--root") options.root = argv[++i] ?? null;
    else if (arg === "--no-color") options.color = false;
    else if (arg === "-h" || arg === "--help") return { help: true };
    else return { error: `unrecognised argument: ${arg}` };
  }
  return options;
}

function printListChecks(color) {
  const out = process.stdout;
  out.write("\n");
  out.write(`${paint(BOLD, color, "The ten checks")}\n\n`);
  CHECKS.forEach((check, index) => {
    out.write(
      `  ${paint(BOLD, color, String(index + 1).padStart(2))}. ${paint(CYAN, color, check.id)}\n`,
    );
    out.write(`      ${check.title}\n`);
    out.write(`      enforces: ${check.constraint}\n`);
    out.write(`      catches:  ${check.catches}\n`);
    out.write(`      NOT:      ${check.doesNotCatch}\n\n`);
  });
  out.write(`  \`--explain <id>\` prints one of these in full.\n\n`);
}

function resolveCheckId(token) {
  const lower = token.toLowerCase();
  const byNumber = CHECKS[Number(lower) - 1];
  if (byNumber && /^\d+$/.test(lower)) return byNumber;
  return CHECKS.find((c) => c.id === lower) ?? null;
}

function printExplain(check, color) {
  const out = process.stdout;
  out.write("\n");
  out.write(`${paint(BOLD, color, check.id)}\n\n`);
  out.write(`  title:        ${check.title}\n`);
  out.write(`  enforces:     ${check.constraint}\n`);
  out.write(`  catches:      ${check.catches}\n`);
  out.write(`  does NOT:     ${check.doesNotCatch}\n`);
  out.write(
    `  source:       ${rel(path.join(REPO_ROOT, "tooling", "scripts", "check-architecture.mjs"))} → function ${check.run.name}\n`,
  );
  out.write(
    `  prose law:    docs/architecture/ — a check whose rule and whose document\n`,
  );
  out.write(
    `               disagree is the first thing to rot; change them together.\n\n`,
  );
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const color = parsed.color && useColor(process.stdout);

  if (parsed.listChecks) {
    printListChecks(color);
    return EXIT_OK;
  }
  if (parsed.explain !== null) {
    const check = resolveCheckId(parsed.explain);
    if (!check) {
      process.stderr.write(
        `no check named "${parsed.explain}". Run --list-checks for the ids.\n`,
      );
      return EXIT_USAGE;
    }
    printExplain(check, color);
    return EXIT_OK;
  }

  if (parsed.root) {
    const target = path.resolve(process.cwd(), parsed.root);
    if (!isDirectory(target)) {
      process.stderr.write(`--root ${parsed.root} is not a directory\n`);
      return EXIT_USAGE;
    }
    // Re-exec this same script with the target as the repository root. The
    // alternative — threading a root parameter through every reader — would be
    // a second code path through the checks, and two code paths through a
    // boundary check is one too many: the fixture would exercise the other one.
    //
    // `ECOMA_IDENTITY_ROOT` is the channel, and it is set in the child's
    // environment ONLY. The parent's argv is not rewritten, so `--root` stays
    // in it — which is why the child must also be told not to re-exec again.
    // A second spawn of the same process is the signature of that mistake, and
    // it is a fork bomb rather than a failing test, so the guard is explicit
    // and loud instead of subtle.
    if (process.env.ECOMA_IDENTITY_ROOT) {
      process.stderr.write(
        "--root was passed while ECOMA_IDENTITY_ROOT is already set, which means this\n" +
          "process was spawned by a --root re-exec and must judge the tree directly.\n" +
          "Invoke check-architecture.mjs without --root, or set ECOMA_IDENTITY_ROOT\n" +
          "yourself with the flags for this run.\n",
      );
      return EXIT_USAGE;
    }
    const result = spawnSync(
      process.execPath,
      [
        SELF_PATH,
        ...(parsed.only ? ["--only", [...parsed.only].join(",")] : []),
        ...(parsed.json
          ? ["--json", path.resolve(process.cwd(), parsed.json)]
          : []),
        ...(parsed.color ? [] : ["--no-color"]),
      ],
      {
        stdio: "inherit",
        env: { ...process.env, ECOMA_IDENTITY_ROOT: target },
        cwd: REPO_ROOT,
      },
    );
    return result.status ?? EXIT_CANNOT_RUN;
  }

  const ctx = buildContext();
  const selected = parsed.only
    ? CHECKS.filter((check) => parsed.only.has(check.id))
    : CHECKS;
  if (parsed.only) {
    for (const id of parsed.only) {
      if (selected.some((c) => c.id === id)) continue;
      process.stderr.write(
        `no check named "${id}". Run --list-checks for the ids.\n`,
      );
      return EXIT_USAGE;
    }
  }
  for (const check of selected) {
    ctx.report.runCheck(check, ctx);
    ctx.runOrder.push(check);
  }

  printResults(ctx, { color, parsed });
  if (parsed.json) {
    const written = writeJsonReport(
      ctx,
      path.resolve(process.cwd(), parsed.json),
    );
    if (color) process.stdout.write(`  report written to ${written}\n\n`);
    else process.stdout.write(`  report written to ${written}\n\n`);
  }

  if (ctx.report.errored) return EXIT_CANNOT_RUN;
  if (ctx.report.failed) return EXIT_VIOLATIONS;
  return EXIT_OK;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}

export {
  CHECKS,
  Report,
  buildContext,
  collectBindings,
  findWranglerConfig,
  internalReachability,
  main,
  readGitIndex,
  readJsonc,
  readMoonProjectMap,
  readReleasePlease,
  readRustGraph,
  readTomlBindings,
  resolveWorkspacePath,
  stripJsonc,
};
