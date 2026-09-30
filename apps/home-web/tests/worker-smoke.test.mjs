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
      const response = await fetch(`${ORIGIN}/en`);
      if (response.ok) return;
      lastError = new Error(`GET /en returned HTTP ${response.status}`);
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

  // The build must not have captured `/` as a static file. If it has, the
  // per-request language detection is dead in production: Workers Assets serves
  // that file for every request to `/` and the Worker never gets to read the
  // cookie. This is asserted here rather than left to the config comment,
  // because the failure is invisible until a Vietnamese visitor is silently
  // shown the English page.
  assert.ok(
    !fs.existsSync(path.join(APP_ROOT, ".output", "public", "index.html")),
    "The build prerendered `/`. The language-detection redirect must be answered per request, not frozen at build time. Check `nitro.prerender.ignore` in nuxt.config.ts.",
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

test("the Worker serves the English landing page at its locale prefix", async () => {
  const response = await fetch(`${ORIGIN}/en`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Ecoma — fair-code labor OS<\/title>/);
  assert.match(html, /Fair-code labor OS/);
  assert.match(html, /lang="en"/);
});

test("the Worker serves the Vietnamese landing page at its locale prefix", async () => {
  const response = await fetch(`${ORIGIN}/vi`);
  assert.equal(response.status, 200);
  const html = await response.text();
  // The Vietnamese title proves the translation was resolved server-side and
  // is in the static HTML, rather than the English document plus a client-side
  // swap — which is the whole reason the page is prerendered per locale.
  assert.match(html, /<title>Ecoma — Hệ điều hành lao động fair-code<\/title>/);
  assert.match(html, /lang="vi"/);
});

test("the root redirects to a locale prefix rather than serving a page", async () => {
  const response = await fetch(`${ORIGIN}/`, { redirect: "manual" });
  assert.ok(
    response.status >= 300 && response.status < 400,
    `GET / answered ${response.status}. It must redirect to a locale prefix, because the destination depends on the visitor's cookie.`,
  );
  const location = response.headers.get("location") ?? "";
  assert.match(
    location,
    /^\/(en|vi)(\/|$)/,
    `GET / redirected to ${location}, which is not a locale prefix.`,
  );
});

test("the root redirect honours a stored locale cookie", async () => {
  const response = await fetch(`${ORIGIN}/`, {
    redirect: "manual",
    headers: { cookie: "ecoma_locale=vi" },
  });
  assert.ok(
    response.status >= 300 && response.status < 400,
    `GET / with a vi cookie answered ${response.status}.`,
  );
  assert.match(
    response.headers.get("location") ?? "",
    /^\/vi(\/|$)/,
    "A visitor who stored `vi` was not sent to /vi.",
  );
});

test("the Worker serves an emitted client asset", async () => {
  const html = await (await fetch(`${ORIGIN}/en`)).text();
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
