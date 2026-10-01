import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKSPACE_ROOT = path.resolve(APP_ROOT, "..", "..");
const WRANGLER = path.join(WORKSPACE_ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = path.join(
  WORKSPACE_ROOT,
  "infra",
  "cloudflare",
  "development",
  "home-web",
  "wrangler.jsonc",
);
const PORT = 8794;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let worker;
let output = "";

async function waitForWorker() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/`);
      if (response.ok) return;
      lastError = new Error(`GET / returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Wrangler did not start a compatible Worker runtime within 60 seconds: ${lastError?.message ?? "unknown error"}\n${output}`,
  );
}

before(async () => {
  assert.ok(
    fs.existsSync(path.join(APP_ROOT, ".output", "server", "index.mjs")),
    "Nuxt Worker output is missing. Run `moon run home-web:build` before this smoke test.",
  );
  assert.ok(
    fs.existsSync(path.join(APP_ROOT, ".output", "public")),
    "Nuxt Workers Assets output is missing. Run `moon run home-web:build` before this smoke test.",
  );

  worker = spawn(
    WRANGLER,
    ["dev", "--local", "--port", String(PORT), "--config", CONFIG],
    {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout.on("data", (chunk) => {
    output += chunk;
  });
  worker.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await waitForWorker();
});

after(async () => {
  if (!worker || worker.exitCode !== null) return;
  worker.kill("SIGTERM");
  await new Promise((resolve) => worker.once("exit", resolve));
});

test("the Worker serves the public landing page HTML", async () => {
  const response = await fetch(`${ORIGIN}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Ecoma<\/title>/);
  assert.match(html, /Fair-code labor OS/);
});

test("the Worker serves an emitted client asset", async () => {
  const html = await (await fetch(`${ORIGIN}/`)).text();
  const match = /<script[^>]+src="([^"]*\/_nuxt\/[^"]+)"/.exec(html);
  assert.ok(
    match,
    "the landing page did not contain an emitted Nuxt client asset",
  );

  const assetPath = match[1];
  assert.ok(assetPath, "the emitted Nuxt client asset did not have a path");

  const response = await fetch(`${ORIGIN}${assetPath}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.ok(
    (await response.text()).length > 0,
    "the emitted client asset was empty",
  );
});
