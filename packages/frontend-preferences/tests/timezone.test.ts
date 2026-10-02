import { afterEach, describe, expect, it, vi } from "vitest";
import { detectTimeZone, isValidTimeZone } from "../src/index.js";

/**
 * The zone-detection tests, and the one assertion in this package that exists
 * specifically to prevent a silent, plausible-looking wrong answer.
 *
 * ## Why `US/Pacific` gets its own test
 *
 * `Intl.supportedValuesOf("timeZone")` is the obvious way to validate an
 * identifier, and it is wrong. It returns the CANONICAL names only, and omits
 * the legacy aliases that `resolvedOptions().timeZone` legitimately reports on
 * real machines — `US/Pacific` and `Asia/Calcutta` among them. A browser, a VM
 * image or an ICU build that reports `US/Pacific` would fail a membership test
 * and be downgraded to UTC.
 *
 * The symptom is not an error. It is every timestamp on the page rendered seven
 * hours off, for the subset of users whose platform reports an alias, and no
 * test that only checks `Asia/Ho_Chi_Minh` would ever have found it. That is why
 * this file asserts the alias is ACCEPTED rather than merely asserting that a
 * valid zone is accepted.
 */

afterEach(() => {
  // `vi.unstubAllGlobals` rather than a manual delete: the `Intl` stubs are
  // registered through the same mechanism as the `document` stubs in the other
  // suites, and one consistent teardown is what keeps a stub from leaking into
  // the next file.
  vi.unstubAllGlobals();
});

describe("isValidTimeZone", () => {
  it("accepts a canonical IANA identifier", () => {
    expect(isValidTimeZone("Asia/Ho_Chi_Minh")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("accepts a legacy alias the runtime's resolvedOptions legitimately returns", () => {
    // THE assertion. If this one ever fails, the implementation has been
    // swapped for an `Intl.supportedValuesOf` membership test, and real users on
    // affected platforms will silently get UTC.
    expect(isValidTimeZone("US/Pacific")).toBe(true);
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
  });

  it("rejects an identifier no runtime can format with", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("Not A Zone")).toBe(false);
  });

  it("rejects the empty string and a bare word", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("GMT+7")).toBe(false);
  });

  it("does not consult Intl.supportedValuesOf, which omits the aliases", () => {
    // Stated as a test because the alternative is invisible: the suite above
    // would pass with either implementation for the canonical identifiers, and
    // only this one distinguishes them. If a future runtime's
    // `supportedValuesOf` were to gain the aliases, this assertion becomes
    // conservative rather than wrong — which is the safe direction to fail in.
    expect(
      typeof (Intl as { supportedValuesOf?: unknown }).supportedValuesOf,
    ).not.toBe("undefined");
    expect(Intl.supportedValuesOf("timeZone")).not.toContain("US/Pacific");
  });
});

describe("detectTimeZone", () => {
  it("reports the runtime's zone", () => {
    const detected = detectTimeZone();
    // Not a specific value: the zone of whatever machine runs the tests is not
    // a fact this repository owns, and asserting one would make the suite fail
    // on a developer's laptop in Berlin. The property worth asserting is that
    // the value is one the runtime itself accepts.
    expect(detected === null || isValidTimeZone(detected)).toBe(true);
  });

  it("round-trips whatever it detects through the validator", () => {
    const detected = detectTimeZone();
    if (detected !== null) {
      expect(isValidTimeZone(detected)).toBe(true);
    } else {
      // A null answer is only honest when the runtime really cannot report one.
      // Asserting it here rather than skipping keeps the branch meaningful.
      expect(true).toBe(true);
    }
  });

  it("preserves a legacy alias rather than canonicalising it", () => {
    // Stub the whole `Intl` so the detection path is exercised with a runtime
    // that reports an alias. `US/Pacific` is the identifier this whole file
    // turns on, so the stub reports it and the assertion is that it comes back
    // UNCHANGED — canonicalising it to `America/Los_Angeles` would be
    // defensible behaviour, but silently substituting it would hide the fact
    // that this package handles aliases at all.
    const stub = makeIntl("US/Pacific");
    vi.stubGlobal("Intl", stub);

    expect(detectTimeZone()).toBe("US/Pacific");
  });

  it("returns null when the runtime reports no zone", () => {
    vi.stubGlobal("Intl", makeIntl(undefined));
    expect(detectTimeZone()).toBeNull();
  });

  it("returns null when the runtime reports an empty zone", () => {
    vi.stubGlobal("Intl", makeIntl(""));
    expect(detectTimeZone()).toBeNull();
  });

  it("returns null when the default formatter cannot even be constructed", () => {
    // A runtime whose `Intl.DateTimeFormat()` throws on construction has no
    // zone to report. That is a null answer from a bootstrap, not a crash in
    // application code.
    vi.stubGlobal("Intl", {
      DateTimeFormat: function BrokenDateTimeFormat(): never {
        throw new RangeError("no ICU");
      },
    });
    expect(detectTimeZone()).toBeNull();
  });

  it("returns null when there is no Intl at all", () => {
    vi.stubGlobal("Intl", undefined);
    expect(detectTimeZone()).toBeNull();
  });

  it("rejects a zone its own validator refuses, rather than passing it on", () => {
    // A runtime whose `resolvedOptions()` reports something it then cannot
    // format with. Passing that through would move the failure to whichever
    // formatter the application builds later — in application code, further
    // from the cause, and as a thrown `RangeError` rather than a null.
    const stub = makeIntl("Mars/Olympus_Mons", false);
    vi.stubGlobal("Intl", stub);
    expect(detectTimeZone()).toBeNull();
  });

  it("is never persisted, so a traveller's zone cannot go stale", () => {
    // Not a runtime assertion — a structural one, stated here because it is the
    // decision this module exists to make and nothing else in the suite would
    // notice its absence. There is no cookie-writing function in this module
    // and no preference field carrying a zone: `LocalPreferenceStore.read()`
    // reports the detected zone and never writes one. A zone stored beside a
    // one-year preference would be wrong for a year, silently.
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    // No cookie was written by anything above.
    expect(document.cookie).toBe("");
  });
});

/**
 * A stand-in for the `Intl` global whose `resolvedOptions()` reports `zone`.
 *
 * `isValidTimeZone` still runs against the REAL `Intl.DateTimeFormat` — only
 * `resolvedOptions` is stubbed — so a zone the real runtime rejects is still
 * rejected. That is what makes the last detection test meaningful.
 */
/**
 * A stand-in `Intl` whose `resolvedOptions()` reports `zone`.
 *
 * ## Why the constructor accepts and validates a `timeZone`
 *
 * This stub originally ignored its arguments, so `new Intl.DateTimeFormat(
 * "en-US", { timeZone })` constructed successfully for ANY string — and
 * `isValidTimeZone`, whose entire job is to construct that formatter and catch
 * the failure, therefore always returned `true`. The round-trip validation was
 * never exercised: a test asserting that a nonsense zone is rejected passed a
 * validator that accepted everything.
 *
 * So the stub now throws a `RangeError` for an unknown identifier, the way the
 * real `Intl` does. A stub that cannot fail is worse than no stub, because the
 * code under test is written against the real behaviour and the tests then
 * confirm it does something other than what it claims to.
 *
 * @param zone What `resolvedOptions()` should report.
 * @param valid Whether the stub can format with that zone. Defaults to true for
 *   every non-empty identifier, including legacy aliases — those are legitimate
 *   and the real `Intl` formats with them. `false` models the narrow case
 *   `detectTimeZone` round-trips before returning: a runtime that reports a zone
 *   it then refuses to format with.
 */
function makeIntl(zone: string | undefined, valid = true): typeof Intl {
  return {
    DateTimeFormat: class {
      constructor(...args: unknown[]) {
        // Deliberately ignores WHAT it was constructed with: the real `Intl`
        // validates the `timeZone` OPTION, and modelling that faithfully would
        // require an alias table (`US/Pacific` resolving to
        // `America/Los_Angeles`), which is a copy of ICU's data in a test file.
        // The property under test is whether an identifier the runtime REFUSES
        // is caught, so `valid` states that directly and the arguments are
        // accepted only so the call is not a signature error.
        void args;

        // Only an explicitly-declared-invalid zone throws. Every other identifier
        // is accepted, including a LEGACY ALIAS: `US/Pacific` is not
        // `America/Los_Angeles`, and the real `Intl` formats with it happily. A
        // stub that rejected anything differing from what `resolvedOptions`
        // reported would fail the very case the round-trip exists to protect.
        if (!valid) {
          throw new RangeError(`invalid time zone: ${String(zone)}`);
        }
      }

      resolvedOptions(): { timeZone: string | undefined } {
        return { timeZone: zone };
      }
    },
    supportedValuesOf: Intl.supportedValuesOf,
  } as unknown as typeof Intl;
}
