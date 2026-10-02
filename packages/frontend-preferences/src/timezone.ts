/**
 * Time zone detection.
 *
 * ## Why this module exists at all
 *
 * Rendering a timestamp correctly needs a time zone, and the browser knows it
 * without being told. That is the *display* zone, and it is the only thing this
 * module produces.
 *
 * ## Why it is never persisted — the load-bearing decision
 *
 * The cookie that stores a language preference lasts a year, and it is
 * tempting to put a time zone beside it. That would be a bug with a long fuse.
 * A visitor who flies from Ho Chi Minh City to Berlin keeps a machine, a browser
 * profile and possibly the cookie; their zone is now six hours wrong, and it
 * would stay wrong for **a year**, silently, because every timestamp renders
 * and nothing throws. Every hour of every rendered timestamp would be off, and
 * the only symptom is a visitor quietly misreading times that look plausible.
 *
 * The same reasoning applies to a business timezone. An account's reporting
 * timezone is a fact about an entity, owned by that entity, stored server-side
 * next to the data it describes — not a display preference inferred from a
 * browser on the assumption that whoever is reading the screen is wherever the
 * screen is. Backend timestamps stay UTC epoch milliseconds for the same
 * reason: the zone is a rendering decision made by the reader, not a property of
 * the fact.
 *
 * So: detection per session, no cookie, no store, no `FrontendPreferences`
 * field that outlives a page load.
 */

/**
 * Whether a `timeZone` string is one `Intl` can actually format with.
 *
 * ## Why this is a construction and not a lookup
 *
 * The obvious implementation is `Intl.supportedValuesOf("timeZone")`, and it is
 * wrong in a way that harms exactly the users this module exists to serve.
 * `supportedValuesOf` returns the **canonical** zone identifiers, and it omits
 * the legacy aliases that `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * legitimately returns — `US/Pacific`, `Asia/Calcutta`, `Europe/Kiev` and a
 * long tail of others. A browser, a VM image or an ICU build that reports
 * `US/Pacific` would fail a membership test and be silently downgraded to UTC.
 *
 * The symptom of that downgrade is not an error: it is every timestamp on the
 * page rendered seven hours off, for the subset of users whose platform reports
 * an alias. Building the formatter instead *proves* the identifier works in
 * this runtime, aliases included, because that is the only capability actually
 * needed.
 *
 * ## Why not `Intl.supportedValuesOf` even in the type sense
 *
 * This package's `lib` is `["ES2022", "DOM", "DOM.Iterable"]`, and
 * `supportedValuesOf` is a later addition. Declaring the lib to include it
 * would be a dependency on a runtime the package does not otherwise need, for
 * an API that answers the wrong question. If a future runtime lacks
 * `Intl.DateTimeFormat` entirely, that is a different problem with a different
 * answer.
 *
 * @param timeZone The identifier to test.
 * @returns Whether `Intl` can construct a formatter for it.
 */
export function isValidTimeZone(timeZone: string): boolean {
  // `RangeError` is the specified failure for an unknown identifier, but the
  // check is a catch rather than an instanceof test because the point is
  // "did this throw", not "did it throw this particular class" — a runtime that
  // signals the problem differently should still yield `false` rather than
  // propagate an exception out of a validation helper.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The visitor's time zone, as `Intl` reports it.
 *
 * @returns An IANA identifier — canonical or legacy alias, whichever this
 *   runtime uses — or `null` when the runtime cannot report one at all. `null`
 *   rather than `"UTC"` because a caller that cannot detect a zone should say
 *   so and let the formatter omit the zone, and `"UTC"` would be an assertion
 *   that the visitor is at longitude zero.
 *
 * @example
 * ```ts
 * const zone = detectTimeZone();
 * new Intl.DateTimeFormat("en-US", { timeZone: zone ?? undefined }).format(now);
 * ```
 */
export function detectTimeZone(): string | null {
  if (
    typeof Intl === "undefined" ||
    typeof Intl.DateTimeFormat !== "function"
  ) {
    return null;
  }

  let resolved: string | undefined;
  try {
    resolved = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // A runtime whose default formatter cannot even be constructed has no zone
    // to report. That is a null answer, not a crash in a bootstrap.
    return null;
  }

  if (typeof resolved !== "string" || resolved === "") {
    return null;
  }

  // Round-trip before handing the value on. `resolvedOptions()` is specified to
  // return something the runtime accepts, but the *validation* is what this
  // package guarantees to its callers, and a value that fails it here would be
  // passed to a formatter that throws at render time instead — in application
  // code, further from the cause.
  return isValidTimeZone(resolved) ? resolved : null;
}
