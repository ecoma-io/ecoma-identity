import type { ColorMode, CookiePolicy, SupportedLocale } from "./config.js";
import {
  DEFAULT_COLOR_MODE,
  PREFERENCE_COOKIE_MAX_AGE,
  cookiePolicy,
} from "./config.js";
import { isColorMode } from "./color-mode.js";
import { isSupportedLocale } from "./locale.js";

/**
 * The one cookie both browser-side preferences live in.
 *
 * ## Why locale and colour mode share a cookie rather than having one each
 *
 * Because the identity of a cookie is its name, not its path, and its domain.
 * Two cookies therefore differ only by name — and the name comes from the
 * topology's per-environment namespace, of which there is exactly one. A locale
 * cookie and a colour-mode cookie under the same name would have to differ by
 * PATH instead (`/locale`, `/color-mode`), which buys nothing and costs three
 * things:
 *
 *   - `document.cookie` returns every cookie for the path, so each read path
 *     would receive both values and have to know which half was addressed to it;
 *   - a single "reset my preferences" control would need to know the path
 *     convention, and each new preference would be another path nobody remembers;
 *   - the two would still share one max-age, so the appearance of independent
 *     lifetimes would be preserved without the independence.
 *
 * One cookie, one name, one domain, one lifetime, one deletion.
 *
 * ## The encoding is positional, and it is not JSON
 *
 * `locale|colorMode`, read by index.
 *
 * Not JSON: a JSON object needs `:` and `,`, and `document.cookie`'s value
 * grammar forbids `;` and `,` without quoting — a quoting rule whose *optional*
 * part the major implementations, jsdom among them, do not implement. A JSON
 * value would therefore be silently truncated by a browser that took the spec
 * literally, and the failure would be a preference that stops being remembered
 * on one engine and works on another. The characters this encoding does use
 * (`|`, alphanumerics, `-`) are all ones a hand-edited cookie is validated
 * against anyway.
 *
 * ## Why the cookie's NAME is still the locale one
 *
 * It is a language code's cookie and has been since before the name was
 * namespaced per environment. Renaming it would orphan every preference cookie
 * already in a visitor's browser — and with it a working, explicit language
 * choice — for no gain. What the name namespaces is *this deployment*, not
 * *this preference*, and that is already what it does.
 *
 * ## The locale-only cookie is a real case, not a hypothetical
 *
 * Every browser holding a preference from before this change has a cookie with
 * one part and no separator. Reading it as "a locale and no colour mode" is the
 * difference between a visitor keeping the language they chose and silently
 * reverting to the platform default the first time they change their theme.
 */

/** Between the locale and the colour mode. A cookie-safe character. */
const SEPARATOR = "|";

/**
 * Where a preference cookie lives and how long it survives.
 *
 * The projected cookie policy plus a lifetime, so that a caller holding a
 * `CookiePolicy` from its own configuration can pass it and this module adds the
 * one thing the policy does not describe.
 */
export interface PreferenceStorage extends CookiePolicy {
  /** How long the cookie survives, in seconds. */
  readonly maxAge: number;
}

/**
 * The projected storage: this build's cookie policy and the platform's
 * one-year lifetime.
 *
 * Named rather than inlined at each default parameter so that the four cookie
 * functions cannot disagree about what "no policy passed" means — a write that
 * defaulted to one thing and a delete to another is the shadow-cookie bug
 * returning through a different door.
 */
export const PREFERENCE_STORAGE: PreferenceStorage = {
  ...cookiePolicy(),
  maxAge: PREFERENCE_COOKIE_MAX_AGE,
};

/**
 * Resolve a caller-supplied storage against the projected one.
 *
 * A caller that passes a bare `CookiePolicy` is not a mistake worth throwing
 * over — it is a caller that has not heard about `maxAge` yet — so the lifetime
 * is filled in from the platform default rather than left undefined and rendered
 * as `Max-Age=undefined`. Every public entry point therefore accepts
 * `CookiePolicy | PreferenceStorage`, which is what lets an app pass the policy
 * it already holds for its own cookie handling without having to learn this
 * module's vocabulary first.
 */
function storage(policy?: PreferenceStorage | CookiePolicy): PreferenceStorage {
  return {
    ...cookiePolicy(policy),
    // `'maxAge' in policy` rather than `policy?.maxAge`, because `CookiePolicy`
    // does not declare the field and a property access on a union is an error
    // even when every arm's absence is handled.
    //
    // The `typeof` guard is not decoration: `in` THROWS a `TypeError` on a
    // primitive, so a caller still passing the old boolean where a policy is
    // expected would get a crash whose message names the `in` operator rather
    // than their mistake, thrown out of a bootstrap. Falling through instead
    // produces the nameless cookie — still wrong, still clearly wrong.
    maxAge:
      policy !== undefined && typeof policy === "object" && "maxAge" in policy
        ? policy.maxAge
        : PREFERENCE_COOKIE_MAX_AGE,
  };
}

/**
 * The raw, unvalidated parts of one preference cookie.
 *
 * `undefined` means "this cookie does not carry that part", which is different
 * from "carries something unrecognised" — the first is the legacy cookie, the
 * second is a hand-edited one, and both need to fall back without throwing.
 */
interface PreferenceParts {
  readonly locale: string | undefined;
  readonly colorMode: string | undefined;
  /** Whether a cookie with this policy's name was present at all. */
  readonly present: boolean;
}

/**
 * Find this policy's cookie and split it into its parts.
 *
 * Shared by both readers rather than each parsing its own, because the two
 * formats have to be understood identically: if the locale reader accepted
 * something the colour-mode reader rejected, a visitor's cookie would half-work,
 * which is harder to diagnose than either working or failing.
 */
function readParts(policy: PreferenceStorage): PreferenceParts {
  const absent: PreferenceParts = {
    locale: undefined,
    colorMode: undefined,
    present: false,
  };

  if (typeof document === "undefined") {
    return absent;
  }

  const name = policy.name;

  for (const entry of document.cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }

    if (entry.slice(0, separator).trim() !== name) {
      continue;
    }

    // `decodeURIComponent` THROWS a `URIError` on a truncated escape such as
    // `%E0%A4%A`, and a cookie is the one input on this path a visitor can edit
    // by hand. Left unguarded, a malformed value would throw out of a function
    // documented to fall back — and it would throw from a bootstrap, which is a
    // blank page rather than a fallback.
    let decoded: string;
    try {
      decoded = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      // Present but unusable. Both readers fall back, and `present` stays true
      // so that a WRITE knows not to mistake this for "no cookie" and silently
      // keep the undecodable bytes as the other preference.
      return { locale: undefined, colorMode: undefined, present: true };
    }

    const boundary = decoded.indexOf(SEPARATOR);
    if (boundary === -1) {
      // The cookie this package wrote before colour mode joined it.
      return { locale: decoded, colorMode: undefined, present: true };
    }

    return {
      locale: decoded.slice(0, boundary),
      colorMode: decoded.slice(boundary + 1),
      present: true,
    };
  }

  return absent;
}

/**
 * Build the value for one cookie carrying both preferences.
 *
 * @param locale The locale, or `null` when there is none.
 * @param colorMode The colour mode, or `null` when there is none.
 * @returns The unencoded cookie value.
 */
export function encodePreferences(
  locale: string | null,
  colorMode: string | null,
): string {
  if (locale === null && colorMode === null) {
    return "";
  }
  if (locale === null) {
    return `${SEPARATOR}${colorMode ?? ""}`;
  }
  return colorMode === null ? locale : `${locale}${SEPARATOR}${colorMode}`;
}

/**
 * Write one preference into the cookie, leaving the other as it is.
 *
 * Read-modify-write, and the read matters as much as the write: setting a
 * colour mode must not silently reset a visitor's language, which is what a
 * blind `locale|mode` write would do every time the theme changed.
 *
 * @param preference Which field to write.
 * @param value The value to store.
 * @param policy Where the cookie lives.
 */
function writePreference(
  preference: "locale" | "colorMode",
  value: string,
  policy: PreferenceStorage,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const existing = readParts(policy);

  const locale =
    preference === "locale"
      ? value
      : existing.locale === undefined || !isSupportedLocale(existing.locale)
        ? null
        : existing.locale;

  // Read as the RAW part rather than through `readPreferenceColorMode`, which
  // returns the platform default for "unset" — and collapsing those two would
  // make a visitor who explicitly chose `system` have it overwritten by the
  // default the next time they change their language.
  const colorMode =
    preference === "colorMode"
      ? value
      : existing.colorMode === undefined || !isColorMode(existing.colorMode)
        ? null
        : existing.colorMode;

  writeCookie(policy, encodePreferences(locale, colorMode), policy.maxAge);
}

/**
 * Write a cookie value under a policy. The single place a preference cookie's
 * attributes are assembled.
 *
 * Every attribute that identifies the cookie — name, path, domain, `Secure` —
 * is emitted for a deletion exactly as it is for a write. That is the whole
 * reason deletion is expressed as a write with `maxAge: 0` rather than as its
 * own string: a deletion assembled separately is a deletion that eventually
 * forgets one attribute, and a forgotten `Domain` does not delete the original
 * cookie — it deletes a *different* cookie with the same name, leaving the
 * preference alive with no visible error.
 *
 * @param policy The cookie policy.
 * @param value The unencoded value.
 * @param maxAge Lifetime in seconds; `0` expires the cookie immediately.
 * @param expires A past date to write alongside `Max-Age=0`. Written only for a
 *   deletion, and only because a browser that ignores `Max-Age` honours
 *   `Expires` and this file cannot tell which kind it is running under.
 */
function writeCookie(
  policy: CookiePolicy,
  value: string,
  maxAge: number,
  expires?: Date,
): void {
  const parts = [`${policy.name}=${encodeURIComponent(value)}`, "Path=/"];

  if (policy.domain !== null) {
    // A `domain` of `null` emits no `Domain` attribute, which is what makes the
    // cookie host-only. That is the right value outside production: a preview
    // writing a zone-scoped cookie is the exact sharing the per-environment
    // cookie NAME exists to prevent.
    parts.push(`Domain=${policy.domain}`);
  }

  parts.push("SameSite=Lax", `Max-Age=${maxAge}`);

  if (expires !== undefined) {
    parts.push(`Expires=${expires.toUTCString()}`);
  }

  if (policy.secure) {
    // Only meaningful over HTTPS, and a `Secure` cookie set on plain HTTP is
    // silently dropped by the browser — so this follows the policy rather than
    // being unconditional, or every local run would silently lose the
    // preference.
    parts.push("Secure");
  }

  document.cookie = parts.join("; ");
}

/**
 * Write the locale, preserving any colour mode already stored.
 *
 * @param locale The locale to remember.
 * @param policy Where the cookie lives. Defaults to this build's projection.
 */
export function setPreferenceLocale(
  locale: SupportedLocale,
  policy?: PreferenceStorage | CookiePolicy,
): void {
  writePreference("locale", locale, storage(policy));
}

/**
 * Write the colour mode, preserving any locale already stored.
 *
 * Writing `"system"` is a first-class operation, not a way of clearing the
 * cookie: it is the only way to say "stop overriding my operating system", and
 * expressing it as an empty value would leave a stale `light`/`dark` beside it
 * and make the two indistinguishable.
 *
 * @param mode The mode to store.
 * @param policy Where the cookie lives. Defaults to this build's projection.
 */
export function setPreferenceColorMode(
  mode: ColorMode,
  policy?: PreferenceStorage | CookiePolicy,
): void {
  writePreference("colorMode", mode, storage(policy));
}

/**
 * Read the stored locale, validated.
 *
 * @param policy The cookie policy to read under.
 * @returns The stored locale, or `null` when there is no cookie, its value
 *   cannot be decoded, or its locale is one this platform has no messages for.
 */
export function readPreferenceLocale(
  policy?: PreferenceStorage | CookiePolicy,
): SupportedLocale | null {
  const { locale } = readParts(storage(policy));

  // Validated, never cast. The cookie is a string the visitor wrote.
  return locale !== undefined && isSupportedLocale(locale) ? locale : null;
}

/**
 * Read the stored colour mode, validated.
 *
 * @param policy The cookie policy to read under.
 * @returns The stored mode, or the platform default when the cookie carries no
 *   mode, cannot be decoded, or holds something unrecognised.
 */
export function readPreferenceColorMode(
  policy?: PreferenceStorage | CookiePolicy,
): ColorMode {
  const { colorMode } = readParts(storage(policy));

  // A hand-edited value reads as "no choice" rather than throwing, which lands
  // on the platform default — the same degradation the locale has always had,
  // and for the same reason.
  return colorMode !== undefined && isColorMode(colorMode)
    ? colorMode
    : DEFAULT_COLOR_MODE;
}

/**
 * Read the stored colour mode, or `null` when the visitor has not chosen one.
 *
 * The nullable twin of {@link readPreferenceColorMode}, and it exists because
 * that function's signature makes it unusable for asking WHERE a value came
 * from. `readPreferenceColorMode` substitutes the platform default for every
 * "unset" case, so its result is a `ColorMode` and is always a valid one —
 * there is no value a caller could reject to learn that the cookie said
 * nothing.
 *
 * That distinction is load-bearing: `system` is both a real stored choice and
 * the platform default, so a reader that folds "unset" into "system" cannot
 * tell a visitor who chose to follow their operating system from one who was
 * never asked.
 *
 * Both readers share one parser on purpose, so a value the locale reader
 * accepted cannot be rejected here — a cookie that half-worked would be harder
 * to diagnose than either working or failing.
 *
 * @param policy The cookie policy to read under.
 * @returns The validated stored mode, or `null` when the cookie carries none,
 *   cannot be decoded, or holds something unrecognised. Validated, never cast.
 */
export function readStoredColorMode(
  policy?: PreferenceStorage | CookiePolicy,
): ColorMode | null {
  const { colorMode } = readParts(storage(policy));

  // A hand-edited value reads as "no choice" rather than throwing, which lands
  // on the platform default — the same degradation the locale has always had,
  // and for the same reason.
  return colorMode !== undefined && isColorMode(colorMode) ? colorMode : null;
}

/**
 * Forget both preferences.
 *
 * Takes the same policy the write took, and that symmetry is the entire reason
 * this function has a parameter at all. A deletion under a different `Domain` or
 * name does not remove the original: the browser stores it as a separate
 * host-only cookie with the same name, the read path finds whichever comes
 * first, and the preference appears to survive being cleared — which is the bug
 * this signature makes unrepresentable.
 *
 * `Max-Age=0` and a past `Expires` are both written, for the same reason: a
 * browser that ignores one still honours the other, and this file has no way to
 * know which is which.
 *
 * @param policy Must be the policy the writes used.
 */
export function removePreferenceCookie(
  policy?: PreferenceStorage | CookiePolicy,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const resolved = storage(policy);

  // ONE assignment, carrying `Max-Age=0` and a past `Expires` together with
  // every identifying attribute the write used. An earlier version of this
  // function issued a second `document.cookie` write for the `Expires` alone —
  // which silently dropped `Domain`, `SameSite` and `Secure`, so the very
  // attribute the deletion exists to get right was the one it left out. Both
  // expiry spellings are still written, because a browser that ignores one
  // honours the other and this file cannot tell which it is running under.
  writeCookie(resolved, "", 0, new Date(0));
}
