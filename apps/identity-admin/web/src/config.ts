/**
 * The projected frontend configuration, as this app reads it.
 *
 * ## This file is a re-export, and it exists for two reasons
 *
 * `@ecoma-io/frontend-preferences` owns the preference MECHANICS and the
 * reader for the projection; nothing else in this app should need to know
 * where `.generated/frontend/config.json` lives. But two things here cannot
 * import the package:
 *
 *   1. `vite.config.ts`, which runs in Node before any bundling and before the
 *      package's `dist/` is guaranteed to exist on a clean checkout. It uses
 *      {@link readFrontendConfig} rather than the package's `FRONTEND_CONFIG`,
 *      because a build that depends on a compiled artefact existing is the
 *      `Rolldown failed to resolve import` failure the `moon.yml` comment
 *      already describes.
 *   2. The tests, which exercise the reader's failure modes — a missing file, a
 *      malformed one, a projection naming a locale with no catalog — and those
 *      cases are not reachable through a module that throws at import time.
 *
 * Everything else imports from `@ecoma-io/frontend-preferences` directly. This
 * file is the seam, and it is deliberately the only one: an app that reached
 * past it would be reading generated state without the validation the package
 * puts around it.
 *
 * ## Why there are no fallback values anywhere below
 *
 * A default would be a second owner. A default locale list here would answer
 * "which languages exist" independently of
 * `infra-topology/frontend-support.json`, and the two would drift silently
 * until an app shipped a locale it has no messages for. So a missing or
 * malformed projection THROWS, by name, with the command that produces one —
 * which is `AGENTS.md`'s rule that something which cannot run says so loudly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FrontendConfig } from "@ecoma-io/frontend-preferences";
import { MissingFrontendConfigError } from "@ecoma-io/frontend-preferences";

/**
 * The path the renderer writes.
 *
 * `.generated/` is gitignored and lives outside every project directory, which
 * is why moon cannot express it as an `inputs:` entry — 2.5.6 rejects `..`
 * traversal outright — and why each consuming task renders it inline instead.
 * See the `build` and `typecheck` tasks in `moon.yml`.
 *
 * The same literal as the package's `PROJECTED_CONFIG_PATH`, which is a
 * repo-relative string for error messages and is not resolvable from a
 * directory four levels down.
 */
const PROJECTED_CONFIG_PATH = fileURLToPath(
  new URL("../../../../.generated/frontend/config.json", import.meta.url),
);

/**
 * Read the projected configuration from disk, for `vite.config.ts`.
 *
 * Validation is this app's own rather than the package's, and the difference is
 * deliberate. `vite.config.ts` runs before the package is compiled, and the
 * build it configures is the thing that has to fail loudly when the projection
 * is wrong — so this cannot be the package's reader.
 *
 * What it does NOT do is supply a value. Every failure below is an error rather
 * than a default, and each names the field at fault: a projection whose
 * `cookie.name` were missing would otherwise produce a build that writes a
 * locale cookie called `undefined`, which is not a crash. It is a preference
 * that silently never follows the visitor to another application, and the
 * per-environment namespace exists precisely to make that impossible.
 *
 * @returns The parsed projection.
 * @throws {MissingFrontendConfigError} When the file is absent, unparseable,
 *   or missing a field. The usual cause of an absent file is `vite` or
 *   `vue-tsc` invoked directly rather than through moon, which skips the
 *   render.
 */
export function readFrontendConfig(): FrontendConfig {
  let raw: string;
  try {
    raw = readFileSync(PROJECTED_CONFIG_PATH, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${PROJECTED_CONFIG_PATH} could not be read (${reason}). ` +
        `It is generated, not committed: run "pnpm exec moon run identity-admin-web:build" or ` +
        `"pnpm infra:render" to produce it. This app carries no built-in defaults, because ` +
        `a default here would be a second owner of a value the topology already declares.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${PROJECTED_CONFIG_PATH} is not valid ` +
        `JSON (${reason}). Re-run "pnpm infra:render"; a truncated write is the usual cause.`,
    );
  }

  return parseFrontendConfig(parsed, PROJECTED_CONFIG_PATH);
}

/**
 * Validate a parsed projection, naming the field that is wrong.
 *
 * Every failure is loud, for the reason given on {@link readFrontendConfig}.
 */
function parseFrontendConfig(value: unknown, path: string): FrontendConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} is not a JSON object.`,
    );
  }

  const record = value as Record<string, unknown>;

  const environment = record["environment"];
  if (typeof environment !== "string" || environment.length === 0) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares no "environment" ` +
        `string; that field names the deployment the rest of the file describes.`,
    );
  }

  const cookie = asRecord(record["cookie"], path, "cookie");
  const name = cookie["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares no "cookie.name"; ` +
        `without it the three frontends cannot share a preference.`,
    );
  }
  const domain = cookie["domain"];
  if (domain !== null && typeof domain !== "string") {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares "cookie.domain" as ` +
        `${JSON.stringify(domain)}; it is a string or null, and null is the correct value ` +
        `outside production — a cookie scoped to the zone apex is readable by staging ` +
        `and by every preview.`,
    );
  }
  const secure = cookie["secure"];
  if (typeof secure !== "boolean") {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares "cookie.secure" as ` +
        `${JSON.stringify(secure)}; it is a boolean.`,
    );
  }

  const supportedLocales = record["supportedLocales"];
  if (
    !Array.isArray(supportedLocales) ||
    supportedLocales.length === 0 ||
    !supportedLocales.every((locale) => typeof locale === "string")
  ) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares "supportedLocales" as ` +
        `${JSON.stringify(supportedLocales)}; it is a non-empty array of locale codes.`,
    );
  }

  const defaultLocale = record["defaultLocale"];
  if (
    typeof defaultLocale !== "string" ||
    !supportedLocales.includes(defaultLocale)
  ) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares defaultLocale ` +
        `${JSON.stringify(defaultLocale)}, which is not among its supportedLocales ` +
        `${JSON.stringify(supportedLocales)}.`,
    );
  }

  const defaultColorMode = record["defaultColorMode"];
  if (typeof defaultColorMode !== "string" || defaultColorMode.length === 0) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares defaultColorMode ` +
        `${JSON.stringify(defaultColorMode)}; it names a colour mode.`,
    );
  }

  const baseUrl = record["baseUrl"];

  return {
    environment: environment as FrontendConfig["environment"],
    baseUrl: typeof baseUrl === "string" ? baseUrl : null,
    cookie: { name, domain, secure },
    supportedLocales,
    defaultLocale,
    defaultColorMode: defaultColorMode as FrontendConfig["defaultColorMode"],
  };
}

/** Narrow an unknown value to a plain record, naming the field on failure. */
function asRecord(
  value: unknown,
  path: string,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MissingFrontendConfigError(
      `the projected frontend configuration at ${path} declares no "${field}" object.`,
    );
  }
  return value as Record<string, unknown>;
}
