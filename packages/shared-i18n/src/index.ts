/**
 * Shared i18n for every Ecoma frontend.
 *
 * The package exists to make one promise mechanical: **the three frontends
 * cannot disagree about what language a visitor is reading.** home-web (Nuxt),
 * the end-user app and the operator console each decide that question
 * themselves today, and the cookie is the only thing tying the answers
 * together — so the question and the cookie are answered in one place and
 * imported, not reimplemented per app.
 *
 * @example
 * ```ts
 * import { getEffectiveLocale, setLocaleCookie } from "@ecoma-io/shared-i18n";
 *
 * // Which language? cookie → browser → English. Reads nothing else.
 * const locale = getEffectiveLocale();
 *
 * // Remember an explicit choice, so it follows the visitor to the other apps.
 * setLocaleCookie("vi", import.meta.env.PROD);
 * ```
 *
 * @packageDocumentation
 */

export type { SupportedLocale } from "./types.js";
export {
  DEFAULT_LOCALE,
  I18N_COOKIE_DOMAIN_DEVELOPMENT,
  I18N_COOKIE_DOMAIN_PRODUCTION,
  I18N_COOKIE_MAX_AGE,
  I18N_COOKIE_NAME,
  SUPPORTED_LOCALES,
} from "./types.js";

export { isSupportedLocale, normalizeLocale } from "./locale.js";

export {
  detectBrowserLocale,
  getEffectiveLocale,
  getLocaleFromCookie,
  removeLocaleCookie,
  setLocaleCookie,
} from "./cookie.js";
