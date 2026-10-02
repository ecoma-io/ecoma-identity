/**
 * Colour-mode switching for the end-user identity UI.
 *
 * The composable a component uses to read the current theme and offer a choice
 * of others. It is a thin wrapper over `@ecoma-io/frontend-preferences`, the
 * same shape `useLocale()` has over `vue-i18n`: no store of its own, and no
 * reactive copy of a value that already lives on `<html>`, because two sources
 * of truth for "what colour is this page" is a bug waiting for the moment one
 * of them is updated and the other is not.
 *
 * The apparent circularity is deliberate, and it is the reason this reads a
 * function rather than a ref. The attribute IS the state: it is what
 * `src/styles/tokens.css` selects on, and it was already set before this app
 * booted, by the inline script in `index.html`. A ref here would have to be
 * seeded from that attribute, kept in step with it, and would then be a second
 * answer to a question the document has already answered correctly.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * const { currentMode, colorModes, changeMode } = useColorMode();
 * </script>
 *
 * <template>
 *   <label>
 *     {{ t("theme.select") }}
 *     <select
 *       :value="currentMode"
 *       @change="changeMode(($event.target as HTMLSelectElement).value as ColorMode)"
 *     >
 *       <option v-for="m in colorModes" :key="m.code" :value="m.code">
 *         {{ m.name }}
 *       </option>
 *     </select>
 *   </label>
 * </template>
 * ```
 */
import { computed } from "vue";

import {
  COLOR_MODE_ATTRIBUTE,
  PREFERS_DARK_QUERY,
  applyColorMode,
  readColorMode,
  setColorModeCookie,
} from "@ecoma-io/frontend-preferences";
import type { ColorMode } from "@ecoma-io/frontend-preferences";

/**
 * The three modes this app offers.
 *
 * A local `const` rather than an import from the package, and that is a
 * deliberate duplication of three strings. The list here is what a `<select>`
 * iterates, and the package's `ColorMode` is a TYPE — a union cannot be
 * enumerated at runtime without the same three literals appearing somewhere
 * anyway. Listing them in one named constant, next to the composable that
 * renders them, is the smaller duplication: the alternative is a runtime array
 * in the package that exists only to be rendered by two applications, which
 * would make the package own presentation.
 */
const OFFERED_MODES: readonly ColorMode[] = ["system", "light", "dark"];

/**
 * The current theme, and a way to change it.
 *
 * `currentMode` is writable and its setter goes through the same
 * {@link setColorMode} as the explicit method, so `v-model` on a `<select>` and
 * a `changeMode()` call behave identically — including the cookie write that
 * makes the choice survive the next visit, which is the difference between a
 * preference and a setting.
 */
export function useColorMode() {
  /**
   * The mode the visitor has CHOSEN, not the one being painted.
   *
   * Read from the cookie rather than from `<html>` because the attribute holds
   * the resolved mode; see `@ecoma-io/frontend-preferences` for why that
   * difference is the whole reason this control can work.
   */
  const currentMode = computed<ColorMode>({
    get: () => readColorMode(),
    set: (next: ColorMode) => {
      // Synchronous by contract, so `v-model` works. Not fire-and-forget,
      // unlike `useLocale()`'s setter: a locale has to await a message chunk
      // and a theme does not, so a promise here would be a lie about the shape
      // of the operation rather than a compromise.
      changeMode(next);
    },
  });

  /**
   * The mode actually on screen.
   *
   * Not derived from `currentMode` in a computed, because it changes when the
   * OPERATING SYSTEM changes and `currentMode` does not. A computed over the
   * choice would keep reporting the choice and go stale against the page.
   */
  const resolvedMode = computed(() =>
    document.documentElement.getAttribute(COLOR_MODE_ATTRIBUTE),
  );

  /**
   * The themes this app offers, in the order they are offered.
   *
   * "System" first on purpose: it is what most visitors want and what they
   * already have, so making them hunt past two settings to stay where they are
   * is a small act of friction applied to the majority.
   *
   * The labels are the mode names rather than translated strings, and that is a
   * statement rather than a shortcut. `useLocale()` can label each language in
   * its own name because a language has an autonym; a colour scheme does not,
   * and translating "Dark" into 38 languages for a three-option control is
   * surface no one asked for. When the platform has a design system, these
   * become `theme.*` message keys and this array changes shape once.
   */
  const colorModes = computed(() =>
    OFFERED_MODES.map((code) => ({ code, name: code })),
  );

  /**
   * Switch to `next`, persist it, and apply it immediately.
   *
   * Applied immediately rather than on the next paint because the caller has
   * just been told what they want, and a theme that updates a frame later reads
   * as the control having failed.
   *
   * This is also the hook for following the operating system: choosing
   * `system` registers the listener below, and the platform default is applied
   * here rather than at boot because the boot-time application is the inline
   * script's job and doing it twice would be two answers to one question.
   *
   * @param next The mode to switch to.
   */
  function changeMode(next: ColorMode): void {
    setColorModeCookie(next);
    applyColorMode(next);

    if (next === "system") {
      followSystemColorMode();
    }
  }

  return { currentMode, resolvedMode, colorModes, changeMode };
}

/**
 * Repaint when the operating system changes, while the visitor is following it.
 *
 * ## Why this is not registered on mount
 *
 * Registering unconditionally would mean a screen that never renders the theme
 * control still holds a `MediaQueryList` listener, and it would mean an
 * explicit `dark` choice got overwritten the next time the sun set. So the
 * listener is registered when — and only when — the visitor's stored choice is
 * `system`, which is {@link changeMode}'s job and not this composable's.
 *
 * ## Why it is not unregistered
 *
 * `addEventListener` returns nothing, so there is no handle to release, and the
 * closure captures no component state: it reads the cookie and sets an
 * attribute, both of which outlive any component that created it. Registering a
 * second time when the visitor re-picks `system` therefore adds a second
 * listener doing the same idempotent work. That is a real imprecision, called
 * out rather than hidden, because a reviewer should be able to see it — and the
 * alternative, a module-level singleton with its own subscription bookkeeping,
 * is more machinery than a boolean attribute write is worth.
 */
function followSystemColorMode(): void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    // An engine old enough to have no `matchMedia` has no dark mode to follow
    // either, and the bootstrap has already painted the light tokens.
    return;
  }

  window
    .matchMedia(PREFERS_DARK_QUERY)
    .addEventListener("change", (event: MediaQueryListEvent) => {
      // Re-read rather than trusting the caller's intent: the visitor may have
      // chosen an explicit mode after this listener was registered, and their
      // last choice is the one that counts.
      if (readColorMode() !== "system") {
        return;
      }
      applyColorMode(event.matches ? "dark" : "light");
    });
}
