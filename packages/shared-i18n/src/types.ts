/**
 * The platform's locale vocabulary.
 *
 * Every fact about which languages exist lives here, and the three frontends
 * read it rather than each carrying its own list. A language added to the
 * platform is one line in this file plus a message file per app; an app that
 * hardcodes its own list is an app that silently falls back to English for a
 * language the visitor's own browser asked for.
 *
 * ## The default is a real decision
 *
 * English is the fallback, and it is the fallback for three distinct reasons
 * that happen to agree: it is the platform's working language, it is the
 * language the copy is written in first, and it is the only one every screen
 * has a key for. The last is the one that matters operationally — a locale
 * listed in `SUPPORTED_LOCALES` whose messages are missing from one app is a
 * visitor reading raw message keys, so adding a language here without adding
 * its files everywhere is a visible break.
 */

/**
 * Every locale the platform offers, in preference order.
 *
 * The first entry is {@link DEFAULT_LOCALE}. `as const` is what makes
 * {@link SupportedLocale} a union of two literals rather than `string`, which
 * is what lets the cookie parse reject an unknown value at the type level
 * instead of at runtime.
 */
export const SUPPORTED_LOCALES = ["en", "vi"] as const;

/** A locale the platform has messages for. */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locale used when nothing else applies — no cookie, no recognisable
 * browser language, or a request the server cannot attribute a language to.
 */
export const DEFAULT_LOCALE: SupportedLocale = "en";

/**
 * The cookie the locale preference is stored in.
 *
 * The name is shared by all three frontends, and that shared name *is* the
 * cross-app mechanism: a value written on `ecoma.io` is readable on
 * `admin.ecoma.io` and `id.ecoma.io` because it is the same cookie on a shared
 * parent domain. Renaming it splits the platform's languages into three
 * independent preferences with no visible symptom — each app would keep
 * working perfectly, and a visitor would simply find their language did not
 * follow them.
 *
 * It must stay in step with `cookieKey` in `apps/home-web/nuxt.config.ts`.
 * Nothing enforces that pairing mechanically, which is why the name is
 * specified rather than computed in each app.
 */
export const I18N_COOKIE_NAME = "ecoma_locale";

/**
 * How long the preference survives, in seconds. One year.
 *
 * Long because a language preference is a property of a person, not of a
 * session, and a visitor who is shown English once because their cookie expired
 * has been told the platform does not speak their language.
 */
export const I18N_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The production `Domain` for the locale cookie.
 *
 * The leading dot is deliberate and is what makes the cookie readable from
 * every subdomain; see `cookieDomain` in `cookie.ts` for why it is spelled out
 * rather than left to the browser's inference.
 */
export const I18N_COOKIE_DOMAIN_PRODUCTION = ".ecoma.io";

/**
 * The development `Domain` for the locale cookie.
 *
 * `localhost` and not a subdomain of it: the three apps run on different local
 * ports, and **ports do not partition cookies**. A cookie set by the home page
 * on `localhost:5173` is visible to the admin console on `localhost:8788`,
 * which is what makes the cross-app behaviour verifiable on a laptop at all.
 */
export const I18N_COOKIE_DOMAIN_DEVELOPMENT = "localhost";
