/**
 * Locale switching for the end-user identity UI.
 *
 * The composable a component uses to read the current language and offer a
 * choice of others. It is a thin wrapper over `vue-i18n`'s own `useI18n()`:
 * the locale ref comes from there, not from a second store, because two
 * sources of truth for "what language is this" is a bug waiting for the moment
 * one of them is updated and the other is not.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * const { currentLocale, supportedLocales, changeLocale } = useLocale();
 * </script>
 *
 * <template>
 *   <label>
 *     {{ t("locale.select") }}
 *     <select
 *       :value="currentLocale"
 *       @change="changeLocale(($event.target as HTMLSelectElement).value as SupportedLocale)"
 *     >
 *       <option
 *         v-for="entry in supportedLocales"
 *         :key="entry.code"
 *         :value="entry.code"
 *       >
 *         {{ entry.name }}
 *       </option>
 *     </select>
 *   </label>
 * </template>
 * ```
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SupportedLocale } from "@ecoma-io/frontend-preferences";
import { SUPPORTED_LOCALES } from "@ecoma-io/frontend-preferences";
import { setI18nLocale } from "../plugins/i18n";

/**
 * The current locale, and a way to change it.
 *
 * `currentLocale` is writable and its setter goes through the same
 * {@link setI18nLocale} as the explicit method, so `v-model` on a locale
 * `<select>` and a `changeLocale()` call behave identically — including the
 * cookie write that makes the choice stick across the other apps.
 */
export function useLocale() {
  const { locale, t } = useI18n();

  const currentLocale = computed<SupportedLocale>({
    get: () => locale.value,
    set: (next: SupportedLocale) => {
      // Fire-and-forget: the assignment is synchronous by contract so a
      // `v-model` works, and the async part is loading a chunk that this app
      // will have loaded before the user can see a difference. Swallowing the
      // rejection here would hide a missing locale file, so it is left to
      // surface as an unhandled rejection in development rather than being
      // turned into a silent no-op.
      void setI18nLocale(next);
    },
  });

  /**
   * The languages this app offers, each labelled in its OWN language.
   *
   * Labelling "English" as "English" and "Tiếng Việt" as "Tiếng Việt" even
   * while the page is in English is the convention users expect from a language
   * switcher: a reader who cannot read the current language still has to be
   * able to find their own. That is why these come from the `locale.*` keys
   * rather than from `SUPPORTED_LOCALES.map(code => code.toUpperCase())`.
   */
  const supportedLocales = computed(() =>
    SUPPORTED_LOCALES.map((code) => ({
      code,
      name: t(`locale.${code}`),
    })),
  );

  /**
   * Switch to `next`, loading its messages on first use.
   *
   * Awaitable so a caller that needs the UI to be in the new language before it
   * does something else — a router navigation, say — can wait for it.
   */
  function changeLocale(next: SupportedLocale): Promise<void> {
    return setI18nLocale(next);
  }

  return { currentLocale, supportedLocales, changeLocale };
}
