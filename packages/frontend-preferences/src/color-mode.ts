import type { ColorMode, CookiePolicy } from "./config.js";
import { MissingFrontendConfigError } from "./errors.js";
import {
  readPreferenceColorMode,
  removePreferenceCookie,
  setPreferenceColorMode,
  type PreferenceStorage,
} from "./preference-cookie.js";

/**
 * Colour mode: what a visitor's page looks like, and how they chose it.
 *
 * ## Why the attribute and not a class
 *
 * `data-color-mode` on `<html>`, not a class on `<body>` or a `theme` field in
 * a store. Three reasons, all of them about the first paint:
 *
 *   1. It is settable by a **blocking inline script in `<head>`**, before any
 *      stylesheet has been applied and before the body exists. The alternative
 *      — a class applied by application code — can only happen after the bundle
 *      has parsed and executed, which is several frames after a white
 *      background has already been painted for an anonymous dark-mode visitor.
 *      That flash is the defect this design exists to prevent, and no amount of
 *      correctness elsewhere recovers it.
 *   2. It is a *presentational* fact, so it belongs on the element that owns
 *      presentation. Putting it in a store would mean the store has to be read
 *      before it can exist.
 *   3. One attribute selector per mode means the token sheet has three
 *      selectors, not a `.theme-dark` class on four different components that
 *      each have to remember to apply it.
 *
 * ## Why `system` is a stored value and not merely "no cookie"
 *
 * Because "no cookie" and "`system`" are different intentions. `system` is a
 * choice — *follow my operating system, including when it changes at sunset* —
 * and it is the only choice that can be answered correctly by a later visit
 * without asking the visitor again. Treating it as absence would make the
 * default un-storable and force every app to reimplement the same
 * "was it absent or did they say system" question at the bootstrap.
 */

/** Whether a `window` with a `matchMedia` is available. */
function hasMatchMedia(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

/**
 * The attribute this package writes on `<html>`, and the one
 * `src/styles/tokens.css` selects on.
 *
 * Exported so an application can READ the attribute it is themed by without
 * re-spelling the name. A second spelling in an application is a selector that
 * silently matches nothing, and a page that ignores its own theme control is
 * indistinguishable from a stylesheet bug.
 */
export const COLOR_MODE_ATTRIBUTE = "data-color-mode";

/**
 * The media query that reports the operating system's colour preference.
 *
 * Exported for the same reason: an application that listens for the OS
 * changing has to spell the query exactly as this package does, and two
 * spellings of one query is two answers to "what does the system want".
 */
export const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The attribute written on `<html>`, as a type guard.
 *
 * A guard rather than a cast for the same reason `isSupportedLocale` is one:
 * the value may come out of a cookie a visitor edited, and a cast would hand
 * `applyColorMode` a string no selector matches — leaving the page with no
 * colour-mode attribute at all, which falls through to whatever `:root` says
 * and is indistinguishable from a stylesheet bug.
 *
 * @param mode The string to test.
 * @returns Whether it names a mode this package can apply.
 */
export function isColorMode(mode: string): mode is ColorMode {
  return mode === "system" || mode === "light" || mode === "dark";
}

/**
 * What the operating system is asking for.
 *
 * `matchMedia` is read here rather than trusted to exist: jsdom does not
 * implement it, and a headless rendering context might not either. Absence
 * resolves to `"light"`, which is the CSS `color-scheme` default and therefore
 * what an unstyled page already renders as — the one answer that introduces no
 * visual change of its own. Returning `"dark"` instead would be a guess, and a
 * guess in a bootstrap that runs before first paint is a visible one.
 *
 * @returns `"dark"` when the user agent reports a dark preference, `"light"`
 *   otherwise.
 */
export function prefersDark(): boolean {
  if (!hasMatchMedia()) {
    return false;
  }

  return window.matchMedia(PREFERS_DARK_QUERY).matches;
}

/**
 * Collapse a stored mode into the mode that should be on screen right now.
 *
 * `system` is a pointer to the operating system, not a colour, so it is
 * resolved here — at the moment the attribute is applied — rather than when it
 * was stored. That is what lets a visitor who leaves the platform on "follow my
 * system" get a page that follows their system to dark at sunset without ever
 * revisiting, and it is why an app that stored the *resolved* value instead
 * would be permanently wrong for exactly those users.
 *
 * @param mode The stored mode.
 * @returns The mode to apply: `light` or `dark`.
 */
export function resolveColorMode(
  mode: ColorMode,
): Exclude<ColorMode, "system"> {
  if (mode === "system") {
    return prefersDark() ? "dark" : "light";
  }

  return mode;
}

/**
 * Put a mode on `<html>`.
 *
 * Always writes an attribute, never removes it and never writes `"system"`.
 * Both would be tempting and both are wrong: `:root` in the token sheet holds
 * the light tokens, so an absent attribute is indistinguishable from `light`,
 * which makes "remove the attribute to go back to following the system" a lie
 * on a machine whose system is dark. The state "follow the system" has to be
 * representable, and the only place it can be represented is in the cookie.
 *
 * @param mode The stored mode. `system` is resolved first.
 * @param root The element to mark. Defaults to `document.documentElement`, and is
 *   a parameter so the caller that already holds a reference — the inline
 *   bootstrap, or a test — is not made to look it up again.
 * @returns The mode actually applied, which is `light` or `dark` even when
 *   `system` was asked for.
 * @throws {MissingFrontendConfigError} If `document` is absent and no `root` was
 *   passed. Applying a colour mode needs an element to apply it to, and there is
 *   nothing sensible to do without one — a silent return would leave a caller
 *   believing the page had been themed.
 */
export function applyColorMode(
  mode: ColorMode,
  root?: HTMLElement,
): Exclude<ColorMode, "system"> {
  const element = root ?? document?.documentElement;

  if (element === undefined || element === null) {
    throw new MissingFrontendConfigError(
      "applyColorMode() was called with no document; a colour mode needs an element to be applied to, and there is no server-side equivalent to fall back to.",
    );
  }

  const resolved = resolveColorMode(mode);
  element.setAttribute(COLOR_MODE_ATTRIBUTE, resolved);
  return resolved;
}

/**
 * The colour mode to remember.
 *
 * Reads the shared preference cookie rather than one of its own — see
 * `preference-cookie.ts` for why there is one cookie and not two.
 *
 * @param policy Where the cookie lives. Defaults to this build's projection.
 * @returns The stored mode, or the platform default when the cookie carries no
 *   mode, cannot be decoded, or holds something unrecognised.
 */
export function readColorMode(
  policy?: PreferenceStorage | CookiePolicy,
): ColorMode {
  return readPreferenceColorMode(policy);
}

/**
 * Remember an explicit colour-mode choice.
 *
 * Writing `"system"` is a first-class operation, not a way of clearing the
 * cookie: it is the only way to say "stop overriding my operating system", and
 * expressing it as an empty value would leave a stale `light`/`dark` beside it
 * and make the two indistinguishable. To go back to the platform default
 * entirely, call {@link removeColorModeCookie}.
 *
 * @param mode The mode to store.
 * @param policy Where the cookie lives. Defaults to this build's projection.
 */
export function setColorModeCookie(
  mode: ColorMode,
  policy?: PreferenceStorage | CookiePolicy,
): void {
  setPreferenceColorMode(mode, policy);
}

/**
 * Forget the colour-mode choice.
 *
 * Uses the same policy the write used, for the reason
 * {@link removeLocaleCookie} documents: a deletion under a different `Domain` or
 * name leaves the original cookie in place and adds a shadow beside it.
 *
 * It removes the locale too, because both live in the one cookie and deleting
 * half of a cookie is not an operation a browser offers. See
 * `preference-cookie.ts`.
 *
 * @param policy Must be the policy {@link setColorModeCookie} used.
 */
export function removeColorModeCookie(
  policy?: PreferenceStorage | CookiePolicy,
): void {
  removePreferenceCookie(policy);
}
