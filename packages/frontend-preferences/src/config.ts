/**
 * The projected frontend configuration: its types, and the reader that loads it.
 *
 * ## What this file is for
 *
 * The three frontends each answer "what does this visitor prefer", and the
 * answers have to be the same in all three — a language chosen on the public
 * site is read back on the operator console. Until now the values involved were
 * written by hand in three places, and the only thing keeping them in step was
 * a comment saying they had to be. Issue #17 is that defect: `ecoma_locale` was
 * a bare literal in this package and a second bare literal in
 * `apps/home-web/nuxt.config.ts`, and the platform has four environments whose
 * cookie names differ.
 *
 * `tooling/scripts/render-wrangler-config.mjs` already projects those values
 * into `.generated/frontend/<environment>.json`, and this module is where that
 * file becomes a typed value. It is a WHITELIST projection rather than a pruned
 * descriptor, because the deployment descriptor carries the account id and
 * every resolved resource name — a browser bundle must have no path to any of
 * them.
 *
 * ## Why there are no fallback values here
 *
 * There is not a default locale in this file, and there is not a default cookie
 * name, and there is no `try { … } catch { return SOMETHING }`. That is the
 * point of the module. A fallback list would be a *fourth* copy of the locale
 * vocabulary, and a fourth copy is exactly the failure this work exists to
 * remove: it would be invisible to `tooling/scripts/check-frontend-config.mjs`,
 * which reads the vocabulary from `infra-topology/frontend-support.json` and has
 * no way to see a fallback buried in a TypeScript default. Worse, a fallback
 * only ever fires when something is broken, so it would ship a build whose
 * preferences quietly disagree with the platform's while every green signal said
 * otherwise.
 *
 * So a missing configuration is a **thrown, named error**, not a default. The
 * two places a config legitimately cannot be present are both named in the
 * message:
 *
 *   - A bare `pnpm dev` inside an app, where nothing rendered the config. The
 *     fix is `moon run <project>:dev`, whose script renders inline first.
 *   - A test or a Node tool that never went through a build. The fix is
 *     `pnpm infra:render`, or the package-local copy described below.
 *
 * ## Why the fallback for the VOCABULARY alone is a file, not a constant
 *
 * The vocabulary is the one value that must be readable without a build: a unit
 * test asserts `isSupportedLocale("fr") === false`, and a type-level import has
 * to resolve in `tsc` before any render has run. `frontend-support.json` at the
 * package root is a GENERATED copy of `infra-topology/frontend-support.json` —
 * the renderer writes it and refuses to write when the two disagree, and
 * `check-frontend-config.mjs` fails the build when they have drifted. So the
 * duplication is produced rather than maintained, which is the only kind of
 * duplication that cannot rot.
 *
 * It carries the vocabulary and nothing else. The cookie policy — the part that
 * differs per environment and that this package used to get wrong — is NOT in
 * it and has no fallback: a caller without a projected config has no cookie
 * name, and `cookiePolicy()` says so rather than inventing one.
 */

// `with { type: "json" }` is REQUIRED, not decoration. Node 22+ rejects a
// JSON module import without it, and this module is loaded three ways: by `tsc`
// for the package build, by Vite when an application bundles it, and by Vitest
// directly. Only the last two surface the missing attribute — `tsc` compiles
// the import away — so the build passes and the consuming app's build fails
// with ERR_IMPORT_ATTRIBUTE_MISSING, which names neither this line nor the
// renderer that produces the file.
import generated from "../../../.generated/frontend/config.json" with { type: "json" };
import support from "../frontend-support.json" with { type: "json" };

import { MissingFrontendConfigError } from "./errors.js";

/**
 * A locale the platform has messages for.
 *
 * A *narrowed* string rather than a union of the two literals the vocabulary
 * happens to contain today. That is not a loss of type safety and it is the
 * only spelling that survives the value moving: the list is owned by
 * `infra-topology/frontend-support.json`, so a `typeof SUPPORTED_LOCALES[number]`
 * union would be a type-level second owner that stops compiling the moment a
 * locale is added, and the compile error would point at this file rather than
 * at the place that has to change with it.
 *
 * The narrowing that matters is {@link isSupportedLocale}, a runtime guard. A
 * locale arriving from a cookie or from `navigator.languages` is untrusted
 * whatever the type says, and it is validated through that guard and never
 * through a cast.
 */
export type SupportedLocale = string;

/**
 * The three colour modes the platform offers.
 *
 * A closed union rather than `string`, because unlike the locale list this one
 * *is* fully enumerated by the type: there is no projection that could add a
 * fourth without editing `color-mode.ts`, and a closed union is what lets
 * `resolveColorMode` be exhaustive with no default arm.
 */
export type ColorMode = "system" | "light" | "dark";

/**
 * The four environments the platform deploys to.
 *
 * Declared as a union because `cookie.secure` and `cookie.domain` are the two
 * fields a caller is most likely to branch on by hand, and a branch on a
 * hand-written string is how this package ended up with two environments' worth
 * of cookies. The field is informational: nothing in this package branches on
 * it, because everything environment-specific already arrives in `cookie`.
 */
export type FrontendEnvironment =
  "production" | "staging" | "preview" | "development";

/**
 * How the preference cookie is written in this environment.
 *
 * `domain` is `string | null` and NOT `string`, because `null` is the projection
 * saying "no `Domain` attribute" — which is the correct value everywhere except
 * production, and is exactly what stops a preview from writing a cookie the
 * rest of the zone can read. A type that could not express `null` would push
 * that distinction back into a `if (isProduction)` somewhere, which is the
 * shape this object replaced.
 */
export interface CookiePolicy {
  /** The cookie's name, namespaced per environment by the topology. */
  readonly name: string;
  /** The `Domain` attribute, or `null` for a host-only cookie. */
  readonly domain: string | null;
  /** Whether to add `Secure`. Meaningful only over HTTPS. */
  readonly secure: boolean;
}

/**
 * The whole of what a browser bundle is allowed to know about where it is
 * deployed.
 *
 * Nine fields. `account`, the zone, resource names, binding ids, rate-limit
 * namespaces and the email provider are all absent by construction rather than
 * by omission — the projection is built field by field from the resolved
 * topology, so a value added to the deployment descriptor later has no path here
 * until somebody deliberately adds it.
 */
export interface FrontendConfig {
  readonly environment: FrontendEnvironment;
  /**
   * The site's own base URL, for canonicals and hreflang alternates. `null` in
   * development, where there is no site to be canonical to.
   */
  readonly baseUrl: string | null;
  readonly cookie: CookiePolicy;
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: SupportedLocale;
  readonly defaultColorMode: ColorMode;
}

/** The vocabulary half of the projection, as the generated support file states it. */
export interface FrontendSupport {
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: SupportedLocale;
  readonly defaultColorMode: ColorMode;
}

/**
 * The path an application imports, relative to this package.
 *
 * Named as a constant because the error message quotes it and the three apps
 * all import through it — a path spelled differently in an error than in an
 * import is a path the reader cannot follow.
 */
export const PROJECTED_CONFIG_PATH = ".generated/frontend/config.json";

/** The package-local GENERATED copy of the vocabulary's single owner. */
export const SUPPORT_COPY_PATH =
  "packages/frontend-preferences/frontend-support.json";

/** Whether `value` is one of the three colour modes, as a type guard. */
function isColorMode(value: unknown): value is ColorMode {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Reject a vocabulary that could not produce a working default.
 *
 * The renderer already validates `infra-topology/frontend-support.json` before
 * it writes anything, so reaching this is close to impossible — which is
 * exactly why it is loud. A silently empty vocabulary would make
 * `normalizeLocale` return `undefined` for every tag and every app would render
 * an unresolved message key; a named error at load says which file is wrong.
 */
function assertVocabularyUsable(supported: readonly string[]): void {
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new MissingFrontendConfigError(
      `${SUPPORT_COPY_PATH} declares no locales; a platform with no locales has no default and cannot render a message.`,
    );
  }

  const nonStrings = supported.filter((locale) => typeof locale !== "string");
  if (nonStrings.length > 0) {
    throw new MissingFrontendConfigError(
      `${SUPPORT_COPY_PATH} declares ${JSON.stringify(nonStrings)} as locales; every entry must be a string.`,
    );
  }
}

/**
 * The platform's locale vocabulary, read from the generated support copy.
 *
 * An array of `string`, NOT a literal union. See {@link SupportedLocale} for why
 * the type stays open while the value stays single-owner: the vocabulary moves,
 * and a type derived from the *previous* contents would make every locale added
 * afterwards a compile error in this package instead of in the message catalogs
 * that actually have to learn about it.
 *
 * ## No lazy getter, and why
 *
 * This reads the module once, at import time, rather than behind a getter that
 * re-reads per call. A getter would let the array be swapped in a test, which
 * sounds like flexibility and is actually the absence of a law: `isSupportedLocale`
 * would answer differently depending on when it was asked, and a bug report
 * would be unanswerable without knowing whether the render had happened yet. One
 * read, one array, one answer — and the tests that need a different vocabulary
 * construct a different *config*, not a different global.
 *
 * @throws {MissingFrontendConfigError} If the generated copy is absent or empty,
 *   which means `pnpm infra:render` has not run since the package was created.
 */
export const SUPPORTED_LOCALES: readonly string[] = ((): readonly string[] => {
  assertVocabularyUsable(support.supportedLocales);
  // A copy, so a caller that mutates the array it is handed cannot reach the
  // one every other module in this package reads.
  return Object.freeze([...support.supportedLocales]);
})();

/**
 * The locale used when nothing else applies.
 *
 * Read from the same owner as {@link SUPPORTED_LOCALES}, and checked against it
 * rather than trusted. The two are separate keys in a JSON file, so "the default
 * is a locale the platform does not have" is expressible on disk — and it would
 * produce a `SupportedLocale` with no message catalog behind it, which renders
 * as raw keys rather than as an error. Cheap to assert, invisible if not.
 *
 * @throws {MissingFrontendConfigError} If the default is not among the locales.
 */
export const DEFAULT_LOCALE: SupportedLocale = ((): SupportedLocale => {
  const declared = support.defaultLocale;
  if (!SUPPORTED_LOCALES.includes(declared)) {
    throw new MissingFrontendConfigError(
      `${SUPPORT_COPY_PATH} declares defaultLocale ${JSON.stringify(declared)}, which is not among its own supportedLocales ${JSON.stringify(SUPPORTED_LOCALES)}.`,
    );
  }
  return declared;
})();

/**
 * The colour mode a visitor gets before they choose one.
 *
 * `system` in practice, and read from the owner rather than defaulted to
 * `system`: if the platform ever decides anonymous visitors should open in
 * `light`, that decision belongs in `frontend-support.json` next to the rest of
 * the vocabulary, where the coherence gate can see it.
 *
 * @throws {MissingFrontendConfigError} If the declared mode is not one of the
 *   three, which would otherwise reach `resolveColorMode` as a `ColorMode` it
 *   cannot match.
 */
export const DEFAULT_COLOR_MODE: ColorMode = ((): ColorMode => {
  const declared: unknown = support.defaultColorMode;
  if (!isColorMode(declared)) {
    throw new MissingFrontendConfigError(
      `${SUPPORT_COPY_PATH} declares defaultColorMode ${JSON.stringify(declared)}; it must be one of "system", "light", "dark".`,
    );
  }
  return declared;
})();

/**
 * How long a preference cookie survives, in seconds. One year.
 *
 * Long because a language or colour-mode preference is a property of a person,
 * not of a session, and a visitor shown English once because their cookie
 * expired has been told the platform does not speak their language.
 *
 * This one IS a constant, and it is the only preference value that is. It is
 * not in `frontend-support.json` because it is not a fact about the platform's
 * deployment or its vocabulary — it is a fact about how long this particular
 * package is willing to remember a display preference, and putting it beside
 * the cookie *namespace* would invite someone to move it when what they meant
 * to change was the namespace.
 */
export const PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The projected configuration, validated.
 *
 * The three checks below are all about the same thing: this module's types
 * describe what the projection SHOULD contain, and a type is not a validator.
 * A JSON file the renderer wrote is trusted here for the same reason a database
 * row is not — it crossed a process boundary that someone could have edited
 * between the two, and the whole point of a projection is that its contents are
 * not all ours to control.
 *
 * The field list is what makes this worth the lines. `cookie.name` is a
 * non-empty string, because `document.cookie = "=vi"` writes a nameless cookie
 * no reader can find — a silent failure with no visible symptom except a
 * preference that never persists. `cookie.domain` is checked to be a string or
 * `null` rather than defaulted, because `domain: null` is a deliberate value
 * carrying a meaning ("host-only, do not share with the zone") and a default
 * would erase the distinction between "not applicable" and "should have been
 * ecoma.io".
 *
 * @throws {MissingFrontendConfigError} If a field is missing or the wrong shape.
 */
export const FRONTEND_CONFIG: FrontendConfig = ((): FrontendConfig => {
  const raw = generated as Partial<FrontendConfig>;

  if (typeof raw.cookie?.name !== "string" || raw.cookie.name === "") {
    throw new MissingFrontendConfigError(
      `the projected config at ${PROJECTED_CONFIG_PATH} has no cookie.name; run \`pnpm infra:render\`, and render it in the environment you are building for — the cookie name is namespaced per environment.`,
    );
  }

  const domain = raw.cookie.domain;
  if (domain !== null && typeof domain !== "string") {
    throw new MissingFrontendConfigError(
      `the projected config at ${PROJECTED_CONFIG_PATH} has cookie.domain ${JSON.stringify(domain)}; it must be a string or null, and null means "host-only".`,
    );
  }

  if (typeof raw.cookie.secure !== "boolean") {
    throw new MissingFrontendConfigError(
      `the projected config at ${PROJECTED_CONFIG_PATH} has no boolean cookie.secure; a cookie written without knowing whether to mark it Secure is either silently dropped on HTTPS or needlessly pinned there.`,
    );
  }

  // Narrowed into a local, because `assertVocabularyUsable` returns nothing:
  // it validates and throws, and TypeScript has no way to learn from that that
  // `raw.supportedLocales` is now a non-empty array. Reading it through the
  // local keeps the `?? []` above from having to be repeated three times, which
  // is how a `?? []` turns into a silent default by omission. The `?? []` is
  // what makes the throw below reachable rather than a `TypeError`.
  const supportedLocales: readonly string[] = raw.supportedLocales ?? [];
  assertVocabularyUsable(supportedLocales);

  if (
    typeof raw.defaultLocale !== "string" ||
    !supportedLocales.includes(raw.defaultLocale)
  ) {
    throw new MissingFrontendConfigError(
      `the projected config at ${PROJECTED_CONFIG_PATH} declares defaultLocale ${JSON.stringify(raw.defaultLocale)}, which is not among its own supportedLocales ${JSON.stringify(supportedLocales)}.`,
    );
  }

  if (!isColorMode(raw.defaultColorMode)) {
    throw new MissingFrontendConfigError(
      `the projected config at ${PROJECTED_CONFIG_PATH} declares defaultColorMode ${JSON.stringify(raw.defaultColorMode)}; it must be one of "system", "light", "dark".`,
    );
  }

  return {
    environment: raw.environment as FrontendEnvironment,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : null,
    cookie: {
      name: raw.cookie.name,
      domain,
      secure: raw.cookie.secure,
    },
    supportedLocales: Object.freeze([...supportedLocales]),
    defaultLocale: raw.defaultLocale,
    defaultColorMode: raw.defaultColorMode,
  };
})();

/**
 * The cookie policy for the environment this build is for.
 *
 * A function rather than a constant so a caller can pass an explicit policy
 * where it has one — home-web reads the config inside `nuxt.config.ts` while a
 * Vue app reads it in a plugin, and neither should have to reach into this
 * package's module state to get there.
 *
 * ## Why an explicit policy is validated rather than trusted
 *
 * Every writer in this package does `if (policy.domain !== null) parts.push(
 * "Domain=" + policy.domain)`. That guard assumes `domain` is a string or
 * `null`, and the type says so — but a caller migrating from the old
 * `isProduction: boolean` signature passes `true`, and `true !== null` is true,
 * so the write emits `Domain=true`. No read can find that cookie and nothing
 * throws: the preference is written, lost, and reported as working.
 *
 * So the value is checked here, at the single place a policy is merged. The
 * package's own readers are already defensive about an untrusted cookie; this is
 * the same instinct applied to an untrusted *policy*, and it fails at the point
 * of the mistake rather than three calls later at the point of the symptom.
 *
 * `name` is checked for the same reason and because an empty one would be read
 * back by every page on the host.
 *
 * @param policy An explicit policy, e.g. one the app already loaded for its own
 *   cookie handling.
 * @returns The policy to write with, unchanged when it is well-formed.
 * @throws {MissingFrontendConfigError} If the policy does not describe a cookie
 *   this package could actually write. Failing loudly is the point: the caller
 *   is migrating from a signature that took a boolean, and a silent nameless
 *   cookie is how that migration goes unnoticed.
 */
export function cookiePolicy(policy?: CookiePolicy): CookiePolicy {
  const resolved = policy ?? FRONTEND_CONFIG.cookie;

  if (typeof resolved.name !== "string" || resolved.name.length === 0) {
    throw new MissingFrontendConfigError(
      "a cookie policy was passed with no name; a cookie is identified by its name, so this one could be neither written nor found.",
    );
  }

  // `null` is the host-only case and must survive. A wrong type has to be
  // rejected, and `domain: ""` is the one that looks right: `Domain=` scopes a
  // cookie to the apex and nothing else, so it is written successfully, read
  // back on exactly one host of the zone, and fails only for the visitor who
  // happened to be on another.
  if (
    resolved.domain !== null &&
    (typeof resolved.domain !== "string" || resolved.domain.length === 0)
  ) {
    throw new MissingFrontendConfigError(
      `the cookie policy named ${JSON.stringify(resolved.name)} declares domain ${JSON.stringify(resolved.domain)}; it must be a domain string or null, and null is what makes the cookie host-only.`,
    );
  }

  return resolved;
}
