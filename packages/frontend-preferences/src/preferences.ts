import type { ColorMode, CookiePolicy, SupportedLocale } from "./config.js";
import {
  DEFAULT_COLOR_MODE,
  DEFAULT_LOCALE,
  FRONTEND_CONFIG,
} from "./config.js";
import {
  applyColorMode,
  readColorMode,
  setColorModeCookie,
} from "./color-mode.js";
import {
  detectBrowserLocale,
  getLocaleFromCookie,
  setLocaleCookie,
} from "./cookie.js";
import {
  PREFERENCE_STORAGE,
  readStoredColorMode,
  removePreferenceCookie,
  type PreferenceStorage,
} from "./preference-cookie.js";
import { detectTimeZone } from "./timezone.js";

/**
 * A preference that knows where it came from.
 *
 * ## Why the origin travels WITH the value rather than beside it
 *
 * Because "the visitor sees Vietnamese" and "the visitor asked for Vietnamese"
 * are different facts, and a caller that has to reconstruct the second from the
 * first will eventually get it wrong. The merge a future authenticated store
 * needs is "the cookie says `vi`, the session says `en`", and that question is
 * only answerable if both answers still carry their origin when they arrive.
 *
 * Two fields rather than a discriminated union of shapes, because the value is
 * always present: every preference in this package resolves to *something*, and
 * the interesting question is never "is there a value" but "did anyone choose
 * it".
 *
 * @typeParam Value The resolved preference's own type.
 */
export interface SourcedPreference<Value> {
  /** The value to use. */
  readonly value: Value;
  /** How it was obtained. See {@link FrontendPreferenceSource}. */
  readonly source: FrontendPreferenceSource;
}

/**
 * The preference SEAM.
 *
 * ## Why this module is declarations and one implementation
 *
 * Three frontends answer "what does this visitor prefer", and they currently
 * answer it independently, in each case by calling this package's functions
 * directly. That works until the answer has a second origin — an authenticated
 * server that knows the account's language — at which point every call site
 * needs the same four-line merge, gets it slightly differently, and one app ends
 * up preferring the cookie while another prefers the session.
 *
 * So the shape is declared now, while the second origin does not exist. An
 * interface with one implementation is a smaller claim than a framework, and it
 * makes the seam visible: when the backend preference store is built, it
 * implements {@link FrontendPreferenceSource} and nothing else in the frontends
 * changes.
 *
 * ## The status of the remote adapter — DEFERRED, and stated as such
 *
 * {@link RemotePreferenceAdapter} is **NOT IMPLEMENTED**. There is no endpoint,
 * there is no HTTP call, there is no mock response, and no user's preferences
 * are invented anywhere in this package or its tests.
 *
 * It is declared because `AGENTS.md` requires that unimplemented behaviour be
 * *visible as unimplemented* rather than absent — a reader who finds an
 * interface with no implementation learns the work is planned; a reader who
 * finds nothing at all cannot tell the difference between "not thought about"
 * and "deliberately deferred". The type is here; the behaviour is not, and
 * nothing in this repository may claim otherwise.
 *
 * The reason it is deferred is also a boundary, not merely a backlog item: a
 * server-side preference record is identity data, and `AGENTS.md`'s scope
 * statement for this repository is that identity decides *who someone is* while
 * what they may do — and what their account looks like — belongs to the systems
 * that own that data. Adding `UserPreferences` to the Rust domain, a migration,
 * and preference endpoints is backend work with its own ADR, not something a
 * browser-side package should imply by existing.
 */

/**
 * Where a set of preferences came from.
 *
 * The discriminant exists so a caller can *branch* on origin rather than
 * compare values: "the cookie says `vi`, the session says `en`" is a question
 * only a caller with both can answer, and collapsing the two into one field
 * would lose the information needed to resolve it correctly.
 *
 * The order of the union is the resolution order — cookie first, then detection,
 * then the platform default — and it is the same order
 * `getEffectiveLocale` has always used. A source is a *description of how a
 * value was obtained*, not a preference: nothing here ranks one above another,
 * and a caller that wants a different order writes that order itself.
 */
export type FrontendPreferenceSource =
  /** An explicit choice the visitor made and the cookie still holds. */
  | "cookie"
  /** Inferred from the browser: `navigator.languages` or the operating system. */
  | "detected"
  /** The platform's configured fallback, because nothing else applied. */
  | "default";
/**
 * Everything the browser knows about this visit.
 *
 * ## What is NOT a field here
 *
 * No account, no session, no user identifier, and no business or entity data of
 * any kind. Those are the identity plane's and the consuming systems' facts;
 * this package reads the browser's own state and the projected configuration,
 * and that boundary is the reason the type is small. `AGENTS.md` is explicit
 * that a role in this repository is never consulted about a merge, and the same
 * discipline applies here: a preference is not an identity.
 *
 * `timeZone` is `string | null` and is **not persisted** — see
 * `timezone.ts` for why a traveller's zone would otherwise be wrong for a year.
 */
export interface FrontendPreferences {
  readonly locale: SourcedPreference<SupportedLocale>;
  /** The display time zone, detected per session, or `null` when undetectable. */
  readonly timeZone: string | null;
  readonly colorMode: SourcedPreference<ColorMode>;
}

/**
 * A place preferences can be read from and written to.
 *
 * The seam. Two implementations are named by the design: the local cookie store,
 * which exists, and a remote adapter, which is deferred. A third — an
 * authenticated server store — would also satisfy this interface, and nothing
 * here would need to change when it arrives.
 *
 * The methods are synchronous and browser-shaped on purpose. A `Promise` return
 * would force every caller to become async, and a colour-mode bootstrap that
 * must complete before first paint cannot await a network round-trip without
 * reintroducing the flash this package exists to prevent. A remote
 * implementation would therefore need to be a *cache* consulted after a local
 * read, not a replacement for it — which is a design constraint worth stating
 * here, where whoever builds it will read it.
 */
export interface FrontendPreferenceStore {
  /** The preference to use right now, from this store's own source. */
  read(): FrontendPreferences;

  /** Remember an explicit locale choice. */
  setLocale(locale: SupportedLocale): void;

  /** Remember an explicit colour-mode choice. */
  setColorMode(mode: ColorMode): void;

  /**
   * Forget the explicit choices, so detection runs again.
   *
   * One method rather than two: removing them separately would leave a window
   * in which the visitor has a locale preference and no colour-mode preference,
   * which is not a state any caller wants to reason about.
   */
  clear(): void;
}

/**
 * The one working implementation: preferences in this browser's cookies.
 *
 * ## Where each value comes from
 *
 * - **locale** — the cookie, else the browser's languages, else the platform
 *   default. Exactly the order `getEffectiveLocale` has always used, so a
 *   visitor's stored choice keeps winning over a language their browser merely
 *   suggests.
 * - **colorMode** — the cookie, else the platform default. NOT
 *   `prefers-color-scheme`: "system" is a *stored* choice here, and resolving it
 *   to a concrete colour before reporting it would lose the difference between
 *   "follow my OS" and "I picked light", which is the difference between a
 *   visitor whose page follows them to dark at sunset and one whose page does
 *   not.
 * - **timeZone** — detected, never stored. See `timezone.ts`.
 *
 * The `source` discriminants are reported truthfully rather than uniformly. A
 * locale read from a cookie says `cookie`; one the browser implied says
 * `detected`; one that is only the platform fallback says `default`. A colour
 * mode is `cookie` or `default` and never `detected`, because the operating
 * system is consulted later — at the moment the attribute is applied — and
 * claiming detection here would describe an answer this store has not given.
 */
export class LocalPreferenceStore implements FrontendPreferenceStore {
  readonly #policy: CookiePolicy;

  /**
   * The policy plus a lifetime.
   *
   * `#policy` alone is what the readers and writers want; the lifetime is needed
   * only by the deletion path, and resolved here rather than at each call site so
   * that a write and the `clear()` that undoes it cannot disagree about how long
   * the cookie lives — the same reason {@link PREFERENCE_STORAGE} is a constant
   * rather than a default parameter spelled out five times.
   */
  readonly #storage: PreferenceStorage;

  /**
   * @param policy The cookie policy to read and write under. Defaults to the
   *   projected one, and is a constructor argument rather than a module global
   *   so that a caller holding a config for its own cookie handling cannot
   *   accidentally write the preference somewhere else.
   * @param maxAge How long the cookie survives, in seconds. A parameter for the
   *   same reason `cookiePolicy` is a function: a test that wants a short-lived
   *   cookie should be able to say so without reaching into a module global, and
   *   a caller that genuinely wants a different lifetime is stating it rather
   *   than patching one.
   */
  constructor(
    policy: CookiePolicy = FRONTEND_CONFIG.cookie,
    maxAge: number = PREFERENCE_STORAGE.maxAge,
  ) {
    this.#policy = policy;
    this.#storage = { ...policy, maxAge };
  }

  read(): FrontendPreferences {
    const storedLocale = getLocaleFromCookie(this.#policy);
    const locale: SourcedPreference<SupportedLocale> =
      storedLocale === null
        ? { value: detectBrowserLocale(), source: "detected" }
        : { value: storedLocale, source: "cookie" };

    // `detectBrowserLocale` falls back to the platform default internally, and
    // there is no way to ask it whether it did. Reporting `detected` for a
    // value that came from the default is the one place this store could lie,
    // so it checks the value instead: a browser that matched nothing and a
    // browser that matched the default locale are indistinguishable from here,
    // and both are honestly reported as the default.
    const effectiveLocale = storedLocale ?? locale.value;
    const sourcedLocale: SourcedPreference<SupportedLocale> =
      effectiveLocale === DEFAULT_LOCALE && storedLocale === null
        ? { value: DEFAULT_LOCALE, source: "default" }
        : locale;

    // Read through the NULLABLE reader, not `readColorMode`. That function
    // substitutes the platform default for every "unset" case, so its result is
    // always a valid mode and `isColorMode()` on it can never be false — the
    // check below would be a tautology and every visitor who had never chosen a
    // theme would be reported as having chosen one. `system` is both a real
    // stored choice and the platform default, so only the raw "unset" can tell
    // the two apart.
    const storedMode = readStoredColorMode(this.#policy);
    const colorMode: SourcedPreference<ColorMode> =
      storedMode === null
        ? { value: DEFAULT_COLOR_MODE, source: "default" }
        : { value: storedMode, source: "cookie" };

    return {
      locale: sourcedLocale,
      timeZone: detectTimeZone(),
      colorMode,
    };
  }

  setLocale(locale: SupportedLocale): void {
    // Delegated rather than reimplemented, so the store and the standalone
    // `setLocaleCookie` cannot disagree about how a preference cookie is
    // written. A caller holding only a `FrontendPreferenceStore` should not have
    // to know that both preferences share one cookie, that one write preserves
    // the other, or what the encoded value looks like.
    setLocaleCookie(locale, this.#policy);
  }

  setColorMode(mode: ColorMode): void {
    setColorModeCookie(mode, this.#policy);
  }

  clear(): void {
    // ONE deletion, not two. Both preferences live in the one cookie, so two
    // deletions would issue two identical expiry writes against the same
    // (name, domain, path) identity — the second of which is a no-op that looks
    // like it worked. This is also why the interface has a single `clear()`
    // rather than a `clearLocale`/`clearColorMode` pair: half of a cookie is not a
    // state a browser can express.
    removePreferenceCookie(this.#storage);
  }

  /**
   * Apply the stored colour mode to the document.
   *
   * On the store rather than left to each app, because the ordering is the
   * whole point: the attribute has to be on `<html>` before first paint, and
   * three apps each remembering to do that in their bootstrap is three chances
   * to forget. Reading the cookie and writing the attribute are one decision, so
   * they are one call.
   *
   * @param root The element to mark; defaults to `document.documentElement`.
   * @returns The concrete mode applied, which is `light` or `dark` even when the
   *   stored preference was `system`.
   */
  applyColorModeTo(root?: HTMLElement): "light" | "dark" {
    return applyColorMode(readColorMode(this.#policy), root);
  }
}

/**
 * A preference store backed by an authenticated server — **DEFERRED**.
 *
 * ## Nothing implements this, and nothing in this repository may imply that
 * something does
 *
 * There is no endpoint. There is no `fetch`. There is no mock response in any
 * test in this package. There is no account, session or user-preference row
 * anywhere in `crates/**` or `database/**` as a result of this interface
 * existing, and adding one is out of scope by decision rather than by oversight:
 * this repository's identity plane decides *who someone is*, and a stored
 * "prefers Vietnamese" is data about an account, owned by the system that owns
 * the account.
 *
 * The interface is declared rather than omitted so that the seam is visible to
 * whoever builds it, and so that this package's own documentation can say
 * "DEFERRED" about something concrete. An empty export would be read as an
 * oversight; a declared interface with no implementation is a recorded decision.
 *
 * ## The two constraints whoever implements this inherits
 *
 * 1. **It cannot be the first read.** It implements
 *    {@link FrontendPreferenceStore}, whose `read()` is synchronous — because a
 *    colour-mode bootstrap that awaits a network round-trip before first paint
 *    reinstates the white flash the inline `<head>` script exists to prevent.
 *    A remote implementation is therefore a *cache* layered over the local
 *    store, consulted after a local read and reconciled later, never the only
 *    source.
 * 2. **It crosses a trust boundary the local store does not.** A cookie is
 *    untrusted input the visitor can edit and this package validates it. A
 *    server value would be trusted by definition — which makes the write path
 *    the interesting one, and is a reason this needs an ADR of its own rather
 *    than an implementation.
 */
export interface RemotePreferenceAdapter extends FrontendPreferenceStore {
  /**
   * The endpoint this adapter would read and write.
   *
   * Present only so that whoever implements the interface has to state the URL
   * in the type rather than in a comment, and so that this declaration cannot
   * be quietly satisfied by something that never says where the data comes
   * from. There is no value for it anywhere in this repository.
   */
  readonly endpoint: string;

  /**
   * The account whose preferences this adapter represents.
   *
   * An adapter that cannot say whose preferences it is serving is a shared
   * cache with no key, and the reason a remote store would need one at all.
   * No implementation exists and no identifier is available to pass.
   */
  readonly accountId: string;
}
