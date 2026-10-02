/**
 * Preference mechanics for every Ecoma frontend.
 *
 * ## The promise this package makes, and the one it refuses to make
 *
 * It makes one promise mechanical: **the three frontends cannot disagree about
 * what language a visitor is reading, what colour mode their page is in, or
 * which cookie namespace the answer travels in.** home-web (Nuxt), the
 * end-user app and the operator console each answered those questions
 * themselves, and the cookie was the only thing tying the answers together — so
 * the questions and the cookie are answered in one place and imported, not
 * reimplemented per app.
 *
 * It refuses a second promise. It does not own **translation catalogs** and it
 * does not own **business or user data**. Messages belong to the application
 * that renders them; accounts, sessions, entitlements and an entity's timezone
 * belong to the system that owns that entity. This package owns the *mechanics*
 * — detection, validation, the cookie policy, the resolution order — and reads
 * the vocabulary from a projection of the platform's topology rather than
 * declaring its own.
 *
 * ## Where the values come from
 *
 * Everything environment-specific arrives through `config.ts`, which reads
 * `.generated/frontend/config.json` — projected by
 * `tooling/scripts/render-wrangler-config.mjs` from
 * `infra-topology/topology.json`. There are no fallback values in this package
 * and there will not be: a missing config throws {@link MissingFrontendConfigError}
 * naming the render command, because a default locale list would be a second
 * owner of a fact the topology already states, and a fallback only ever fires
 * when something is already broken.
 *
 * @example
 * ```ts
 * import { LocalPreferenceStore } from "@ecoma-io/frontend-preferences";
 *
 * const store = new LocalPreferenceStore();
 *
 * // Which language? cookie → browser → the platform default. Reads nothing else.
 * store.read().locale.value;
 *
 * // Apply the stored colour mode before first paint.
 * store.applyColorModeTo();
 *
 * // Remember an explicit choice, so it follows the visitor to the other apps.
 * store.setLocale("vi");
 * ```
 *
 * @packageDocumentation
 */

export type {
  ColorMode,
  CookiePolicy,
  FrontendConfig,
  FrontendEnvironment,
  FrontendSupport,
  SupportedLocale,
} from "./config.js";
export {
  DEFAULT_COLOR_MODE,
  DEFAULT_LOCALE,
  FRONTEND_CONFIG,
  PREFERENCE_COOKIE_MAX_AGE,
  PROJECTED_CONFIG_PATH,
  SUPPORT_COPY_PATH,
  SUPPORTED_LOCALES,
  cookiePolicy,
} from "./config.js";

export { MissingFrontendConfigError } from "./errors.js";

export { isSupportedLocale, normalizeLocale } from "./locale.js";

export {
  detectBrowserLocale,
  getEffectiveLocale,
  getLocaleFromCookie,
  removeLocaleCookie,
  setLocaleCookie,
} from "./cookie.js";

export {
  COLOR_MODE_ATTRIBUTE,
  PREFERS_DARK_QUERY,
  applyColorMode,
  isColorMode,
  prefersDark,
  readColorMode,
  removeColorModeCookie,
  resolveColorMode,
  setColorModeCookie,
} from "./color-mode.js";

export { detectTimeZone, isValidTimeZone } from "./timezone.js";

export type {
  FrontendPreferenceSource,
  FrontendPreferenceStore,
  FrontendPreferences,
  RemotePreferenceAdapter,
  SourcedPreference,
} from "./preferences.js";
export { LocalPreferenceStore } from "./preferences.js";
