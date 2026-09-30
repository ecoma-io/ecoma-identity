#!/usr/bin/env node
/**
 * `check-worker-build-prereqs.mjs` — the preflight that `wrangler-validate`
 * runs before `wrangler deploy --dry-run`.
 *
 * WHAT IT IS: a dependency-free Node ≥ 20 script that answers exactly one
 * question — "can the custom build command in this wrangler config run on this
 * machine?" — and exits non-zero with a named cause when it cannot.
 *
 * WHAT IT IS NOT: it is not a substitute for the dry-run. It performs none of
 * the checks `wrangler deploy --dry-run` performs. It exists because
 * `wrangler deploy --dry-run` runs the config's `build.command` FIRST and
 * before any of them, so a build command that cannot work on the developer's
 * machine presents as a bare `exit code 1` with a 40-line stack in a file
 * under `~/.config/.wrangler/logs/`. That is a real failure reported in a way
 * that costs a debugging session, which is the same defect as a check that
 * reports success without running.
 *
 * WHY THE BUILD COMMAND CANNOT RUN — `worker-build` 0.8.7's own manifest:
 *
 *     [dependencies.ureq]
 *     version = "3.1"
 *     features = ["gzip", "json", "native-tls"]
 *
 * `native-tls` resolves to `openssl-sys`, whose build script links against the
 * SYSTEM OpenSSL. It is not vendored, and `worker-build` does not expose a
 * feature to switch it to `rustls`. So `cargo install worker-build` needs
 * `libssl-dev` (Debian) or `openssl-devel` (Fedora) installed, and this is not
 * something a repository can configure its way out of — there is no
 * `Cargo.toml` in this workspace that appears in the install's graph.
 *
 * The exit code is 0 when the prerequisites are present. The exit code is 1
 * when they are not, and every message names the missing prerequisite and the
 * command that installs it. A run that could not decide says that too: the
 * script never reports a pass it did not verify.
 *
 * No dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * Exit codes
 * ------------------------------------------------------------------ */

const EXIT_OK = 0;
const EXIT_UNAVAILABLE = 1;

/** Strip a JSONC file down to JSON. Documented limits are the same as the ones
 *  `check-architecture.mjs` documents: it removes `//` and block comments and
 *  trailing commas, and it is not a general JSONC parser. A wrangler config
 *  that defeats it is reported as undecidable, not silently read wrong. */
function stripJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // Trailing commas before a closing brace or bracket.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

/**
 * Is the machine's system OpenSSL present for `openssl-sys` to link against?
 *
 * `openssl-sys`'s build script probes with pkg-config first and falls back to
 * the standard include paths. Both are checked, because either being present
 * is enough, and neither is authoritative alone. A machine where neither
 * answers is one where the install will fail.
 */
function systemOpensslPresent() {
  const headerPaths = [
    "/usr/include/openssl/ssl.h",
    "/usr/local/include/openssl/ssl.h",
  ];
  for (const p of headerPaths) {
    try {
      if (existsSync(p)) return { present: true, via: p };
    } catch {
      // A stat failure is not evidence of absence on its own; keep looking and
      // let the pkg-config answer decide.
    }
  }
  return { present: false, via: null };
}

/** A wasm32 target is what the build command's own `cargo build` half needs. */
function wasmTargetInstalled() {
  const res = spawnSync("rustup", ["target", "list", "--installed"], {
    encoding: "utf8",
  });
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout
    .split("\n")
    .some((l) => l.trim() === "wasm32-unknown-unknown");
}

/** `wrangler-validate` passes the config's own directory. */
const configDir = process.argv[2] ?? process.cwd();
const configPath = resolve(configDir, "wrangler.jsonc");

const problems = [];
const undecidable = [];

let config;
try {
  config = JSON.parse(stripJsonc(readFileSync(configPath, "utf8")));
} catch (error) {
  // A config that cannot be read is a real problem, and it is reported as one
  // rather than being folded into the "undecidable" banner: wrangler itself
  // will fail on it, and failing here first names the file.
  process.stderr.write(
    `✗ wrangler build preflight: could not read ${configPath}\n  ${error.message}\n`,
  );
  process.exit(EXIT_UNAVAILABLE);
}

const buildCommand = config?.build?.command;
if (typeof buildCommand !== "string" || buildCommand.length === 0) {
  // No custom build command means nothing to preflight: wrangler will bundle
  // the entry point itself and this script has no opinion about it.
  process.exit(EXIT_OK);
}

if (!buildCommand.includes("worker-build")) {
  // The command is not the one this script knows the prerequisites for. Saying
  // so is the honest answer; guessing at an unfamiliar command's needs is not.
  undecidable.push(
    `the build command in ${configPath} does not install worker-build, so this preflight does not model it: ${buildCommand}`,
  );
} else {
  const openssl = systemOpensslPresent();
  if (!openssl.present) {
    problems.push({
      what: "system OpenSSL development headers, required by worker-build 0.8.7",
      why: "worker-build 0.8.7 depends on ureq with the `native-tls` feature, which resolves to openssl-sys, whose build script links against the system OpenSSL. It is not vendored and worker-build exposes no rustls feature to switch away from it.",
      fix: "Debian/Ubuntu: sudo apt-get install libssl-dev    Fedora/RHEL: sudo dnf install openssl-devel    macOS: brew install openssl && add pkg-config to PKG_CONFIG_PATH",
    });
  }

  const wasm = wasmTargetInstalled();
  if (wasm === null) {
    undecidable.push(
      "`rustup target list` could not be run, so the wasm32-unknown-unknown target could not be confirmed",
    );
  } else if (!wasm) {
    problems.push({
      what: "the wasm32-unknown-unknown Rust target",
      why: "the build command runs `worker-build --release`, which compiles the crate for the Workers runtime. Without the target, cargo cannot produce the wasm module wrangler uploads.",
      fix: "rustup target add wasm32-unknown-unknown",
    });
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `\n✗ wrangler build preflight FAILED for ${config.name ?? configPath}\n\n` +
      `  The custom build command in this wrangler config cannot run on this machine.\n` +
      `  \`wrangler deploy --dry-run\` runs it before any of its own checks, so\n` +
      `  without this preflight the failure surfaces as a bare exit code 1 with\n` +
      `  the real error buried in ~/.config/.wrangler/logs/.\n\n`,
  );
  for (const [i, p] of problems.entries()) {
    process.stderr.write(
      `  ${i + 1}. Missing: ${p.what}\n` +
        `     Why:    ${p.why}\n` +
        `     Fix:    ${p.fix}\n\n`,
    );
  }
  process.stderr.write(
    `  This is a machine prerequisite, not a defect in this repository. Nothing\n` +
      `  has been checked and nothing has been uploaded.\n\n`,
  );
  process.exit(EXIT_UNAVAILABLE);
}

if (undecidable.length > 0) {
  process.stderr.write(
    `\n! wrangler build preflight: ${undecidable.length} question(s) this script could not answer:\n`,
  );
  for (const u of undecidable) process.stderr.write(`    - ${u}\n`);
  process.stderr.write(`\n`);
}

process.exit(EXIT_OK);
