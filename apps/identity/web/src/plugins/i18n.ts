/**
 * The Vue I18n instance for the end-user identity UI.
 *
 * ## Why this file exists rather than a `@intlify/unplugin` setup
 *
 * The messages are plain JSON imported dynamically, so a second build plugin
 * would add a second source of truth for what `t()` resolves against. The
 * locale files are the schema; {@link DefineLocaleMessage} below is the type
 * that schema is checked against, and a missing key is a type error rather than
 * a runtime "not found" at the moment a user opens the screen that needed it.
 *
 * ## Lazy loading, and what the cache is for
 *
 * Only one locale's messages are in the initial bundle. The other arrives as a
 * separate chunk the first time it is asked for, and {@link messageCache} holds
 * the in-flight promise rather than the resolved value so that two components
 * asking for `vi` during the same tick share one network request instead of
 * racing two. Once resolved the browser's own module cache keeps the chunk, so
 * a later switch back is a map lookup rather than a fetch.
 *
 * ## Where the locale comes from
 *
 * {@link initializeI18n} resolves it in one place, and that place is shared
 * across all three frontends through `@ecoma-io/shared-i18n`: the cross-domain
 * cookie first, then the browser's languages, then English. The cookie is what
 * makes a language chosen in the admin console also be the language the
 * end-user app opens in.
 *
 * ## The 501 contract, restated for translation
 *
 * This app renders a screen for every string in these files whether or not the
 * Worker behind it implements the route. That is not a claim that the feature
 * works — it is the deferred state, which says so in the user's language. A
 * missing key renders the key itself (`nav.missing`) rather than an empty
 * string, because a blank button labelled nothing looks like a broken build and
 * a raw key points at the file that is missing it.
 */
import { createI18n } from "vue-i18n";
import type { DefineLocaleMessage } from "vue-i18n";
import type { SupportedLocale } from "@ecoma-io/shared-i18n";
import {
  DEFAULT_LOCALE,
  getEffectiveLocale,
  setLocaleCookie,
} from "@ecoma-io/shared-i18n";

/**
 * The in-flight or resolved message bundle per locale.
 *
 * The promise is what is cached, not the value. A user who toggles the
 * language switcher twice quickly fires two imports for the same locale
 * otherwise, and on a slow connection that is two requests for a file that did
 * not change between them.
 */
const messageCache = new Map<SupportedLocale, Promise<DefineLocaleMessage>>();

/**
 * Load a locale's messages, at most once.
 *
 * The dynamic `import()` is a build-time-resolved glob, so each locale in
 * `SUPPORTED_LOCALES` becomes its own chunk rather than one chunk containing
 * all of them. A locale that is not in that array has no file to find, and the
 * bundler would fail the build — which is the correct outcome, because a
 * locale listed in the platform and missing from this app is a hole in the app,
 * not something to paper over at runtime.
 */
function loadLocaleMessages(
  locale: SupportedLocale,
): Promise<DefineLocaleMessage> {
  const cached = messageCache.get(locale);
  if (cached !== undefined) {
    return cached;
  }

  const promise = import(`../locales/${locale}.json`).then(
    (module) => module.default as DefineLocaleMessage,
  );
  messageCache.set(locale, promise);
  return promise;
}

/**
 * Whether this is a production build.
 *
 * Used for the cookie's `Secure` attribute and `domain`, and to turn off
 * vue-i18n's missing-key warnings in production where nobody would read them.
 * The detection functions in `shared-i18n` do not take this: reading
 * `document.cookie` needs no domain, and only the write does.
 */
const isProduction = import.meta.env.PROD;

/**
 * The Vue I18n instance.
 *
 * `legacy: false` selects the Composition API, which is the only mode
 * `useI18n()` works in and the only one this app's `<script setup>` components
 * are written against.
 *
 * `messages` starts empty on purpose. The first locale is loaded by
 * {@link initializeI18n} before `app.mount()`, so there is no window in which a
 * component renders against an empty bundle and every key falls through to the
 * key name.
 */
export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {},
  missingWarn: !isProduction,
  fallbackWarn: !isProduction,
});

/**
 * Switch the active locale, loading its messages if this is the first request.
 *
 * The cookie is written on every call, including the one
 * {@link initializeI18n} makes from a detected browser language. That is
 * intentional: the detection result becomes the stored preference, so the
 * second app the user opens sees it without re-running detection, and so the
 * language stops tracking their browser if they later change it there.
 *
 * @param locale The locale to switch to.
 */
export async function setI18nLocale(locale: SupportedLocale): Promise<void> {
  if (!i18n.global.availableLocales.includes(locale)) {
    i18n.global.setLocaleMessage(locale, await loadLocaleMessages(locale));
  }

  i18n.global.locale.value = locale;

  // The document language is what a screen reader announces and what a
  // browser's own translation prompt keys off. Leaving it at the HTML default
  // while the page is in Vietnamese mislabels the page to both.
  document.documentElement.lang = locale;

  setLocaleCookie(locale, isProduction);
}

/**
 * Resolve the starting locale and load its messages.
 *
 * The resolution order lives in `shared-i18n` rather than here, so the three
 * frontends cannot drift into three different answers to "what language is
 * this": cookie, then browser, then English.
 *
 * @returns The locale the app is now in.
 */
export async function initializeI18n(): Promise<SupportedLocale> {
  const locale = getEffectiveLocale();
  await setI18nLocale(locale);
  return locale;
}

// The message schema. Every locale file in this app is checked against this, so
// a key added to `en.json` and forgotten in `vi.json` fails `pnpm typecheck`
// rather than rendering as a raw key in front of a Vietnamese-speaking user.
declare module "vue-i18n" {
  export interface DefineLocaleMessage {
    meta: {
      title: string;
    };
    auth: {
      login: {
        title: string;
        email: string;
        password: string;
        submit: string;
        forgot: string;
        signup: string;
      };
      register: {
        title: string;
        email: string;
        password: string;
        confirmPassword: string;
        submit: string;
        login: string;
      };
      mfa: {
        title: string;
        code: string;
        submit: string;
      };
    };
    profile: {
      title: string;
      email: string;
      name: string;
      sessions: string;
      revokeSession: string;
    };
    common: {
      loading: string;
      error: string;
    };
    locale: {
      select: string;
      en: string;
      vi: string;
    };
  }
}
