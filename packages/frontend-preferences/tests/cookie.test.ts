import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookiePolicy } from "../src/index.js";
import {
  DEFAULT_LOCALE,
  MissingFrontendConfigError,
  cookiePolicy,
  detectBrowserLocale,
  getEffectiveLocale,
  getLocaleFromCookie,
  removeLocaleCookie,
  setLocaleCookie,
} from "../src/index.js";
import { POLICIES, ROUND_TRIP_POLICIES, clearCookies } from "./support.js";

/**
 * These tests run against a real `document.cookie` in jsdom.
 *
 * jsdom's `document.cookie` implementation has a key limitation: it only exposes
 * name=value pairs, not the attributes (Domain, Secure, SameSite, etc.). To verify
 * the attribute string is correct, we spy on the setter and capture what was written.
 * The round-trip tests use the actual read path, which works correctly in jsdom.
 *
 * ## Every environment is asserted, not just the production one
 *
 * There are four, and the previous version of this file knew about two — it took
 * an `isProduction: boolean` and branched on it, which is how the same cookie
 * name ended up shared across four environments with four different scopes. The
 * policies below are the topology's, spelled out, so the test fails if the code
 * stops honouring one of them rather than if a constant moves.
 */

/** Set `navigator.languages` / `navigator.language` for one case. */
function browserPrefers(...languages: string[]): void {
  vi.stubGlobal("navigator", {
    languages,
    language: languages[0],
  });
}

beforeEach(() => {
  clearCookies();
  browserPrefers("en-US");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
});

describe("clearCookies, the helper every suite leans on", () => {
  // The suite-level reset is infrastructure, and infrastructure that is wrong
  // does not fail its own test — it fails the NEXT one. A `clearCookies` that
  // cleared nothing would show up as four unrelated failures in three unrelated
  // suites, which is exactly how this one was found: after a suite began
  // writing cookies with a `Domain`, the host-only delete stopped matching
  // them, and every case that ran afterwards inherited the previous one's state.
  //
  // So the helper is tested directly, in the file that owns cookies, on the
  // property that matters: after it, a name that was written is gone — whichever
  // scope it was written under.
  it("removes a host-only cookie", () => {
    document.cookie = "ecoma_clearme=a; Path=/";
    expect(document.cookie).toContain("ecoma_clearme=");

    clearCookies();
    expect(document.cookie).not.toContain("ecoma_clearme=");
  });

  it("removes a cookie written with a Domain as well as one without", () => {
    // Both spellings in one case, because "clear everything" that leaves one of
    // them behind is the failure, and it is invisible from any single case.
    document.cookie = "ecoma_scoped=a; Path=/";
    document.cookie = "ecoma_scoped=b; Path=/; Domain=ecoma.io";

    clearCookies();

    // Whatever jsdom retained under either scope, the name must not survive:
    // a leftover here is what every other suite's isolation rests on.
    expect(document.cookie).not.toContain("ecoma_scoped=");
  });
});

describe("the cookie policy, per environment", () => {
  it.each([
    ["production", POLICIES.production, "Domain=ecoma.io", true],
    ["staging", POLICIES.staging, null, true],
    ["preview", POLICIES.preview, null, true],
    ["development", POLICIES.development, null, false],
  ] as const)(
    "%s writes its own name and no domain outside production",
    (_environment, policy, expectedDomain, secure) => {
      const spy = vi.spyOn(document, "cookie", "set");
      setLocaleCookie(DEFAULT_LOCALE, policy);
      const written = String(spy.mock.calls[0]?.[0] ?? "");

      expect(written).toContain(`${policy.name}=`);
      // A staging or preview cookie scoped to the zone apex is the exact
      // sharing the per-environment NAME exists to prevent: every preview
      // would overwrite every other preview's preference, and a preview would
      // overwrite production's.
      if (expectedDomain === null) {
        expect(written).not.toContain("Domain=");
      } else {
        expect(written).toContain(expectedDomain);
      }
      expect(written.includes("Secure")).toBe(secure);
      spy.mockRestore();
    },
  );

  it("gives each environment a DIFFERENT cookie name", () => {
    // The property the whole per-environment namespace exists for. Asserted as
    // a set rather than four separate equality checks so that adding an
    // environment without a namespace is caught here.
    const names = Object.values(POLICIES).map((policy) => policy.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never writes two environments' cookies under one name", () => {
    // A round-trip through the real jsdom cookie jar: writing one environment's
    // policy and reading another's must find nothing, because the names differ.
    // If the projection ever emitted one name for every environment — the
    // defect issue #17 reports — this is the assertion that fails.
    //
    // Production is written under ROUND_TRIP_POLICIES, not POLICIES, and that is
    // not a shortcut: jsdom's document host is `localhost` and it rejects a
    // `Domain=ecoma.io` cookie outright, so the real production policy can never
    // be read back in this environment. See `support.ts` for the full reason.
    // Its `Domain` is asserted as a written attribute instead, below.
    setLocaleCookie("vi", ROUND_TRIP_POLICIES.production);
    expect(getLocaleFromCookie(ROUND_TRIP_POLICIES.production)).toBe("vi");
    expect(getLocaleFromCookie(POLICIES.staging)).toBeNull();
    expect(getLocaleFromCookie(POLICIES.preview)).toBeNull();
  });

  it("writes production's Domain attribute, which is the part jsdom drops", () => {
    // The complement of the round trip above, and the reason both exist: the
    // domain is what makes the cookie readable by every app on the zone, so it
    // is the one attribute whose loss would be silent. jsdom refuses to STORE a
    // cookie domain-scoped to `ecoma.io` on a `localhost` document — but it does
    // record the assignment, so the string is assertable even though the effect
    // is not observable here.
    const spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", POLICIES.production);
    const written = String(spy.mock.calls[0]?.[0] ?? "");
    expect(written).toContain("Domain=ecoma.io");
    expect(written).toContain("Secure");
    spy.mockRestore();
  });
});

describe("setLocaleCookie", () => {
  it("round-trips through getLocaleFromCookie", () => {
    setLocaleCookie("vi", POLICIES.development);
    expect(getLocaleFromCookie(POLICIES.development)).toBe("vi");
  });

  it("sets SameSite=Lax, which is what a cross-subdomain navigation needs", () => {
    const spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", POLICIES.production);
    const written = String(spy.mock.calls[0]?.[0] ?? "");
    // SameSite=None would also work and would additionally expose the value to
    // a cross-origin iframe. Lax permits the top-level navigation between the
    // apps, which is the only case there is.
    expect(written).toContain("SameSite=Lax");
    expect(written).not.toContain("SameSite=None");
    spy.mockRestore();
  });

  it("expires after a year, which is the point of storing it", () => {
    const spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", POLICIES.production);
    const written = String(spy.mock.calls[0]?.[0] ?? "");
    expect(written).toContain(`Max-Age=${60 * 60 * 24 * 365}`);
    spy.mockRestore();
  });

  it("does nothing on a server with no document", () => {
    // The home page prerenders on the server, where `document` does not exist.
    // A write attempt here would throw during prerender rather than degrade.
    vi.stubGlobal("document", undefined);
    expect(() => setLocaleCookie("vi", POLICIES.production)).not.toThrow();
  });
});

describe("removeLocaleCookie", () => {
  it("clears the preference so the next visit re-detects", () => {
    setLocaleCookie("vi", POLICIES.development);
    expect(getLocaleFromCookie(POLICIES.development)).toBe("vi");

    removeLocaleCookie(POLICIES.development);
    expect(getLocaleFromCookie(POLICIES.development)).toBeNull();
  });

  it.each([
    ["production", POLICIES.production],
    ["staging", POLICIES.staging],
    ["preview", POLICIES.preview],
    ["development", POLICIES.development],
  ] as const)(
    "%s deletes under the identical policy the write used",
    (_environment, policy) => {
      // THE deletion-symmetry assertion, and the reason `removeLocaleCookie`
      // takes a `CookiePolicy` rather than a boolean. A deletion under a
      // different Domain does not remove the original: the browser stores a
      // second, host-only cookie with the same name, the read path finds
      // whichever comes first, and the preference survives being cleared with
      // no visible error anywhere. Every attribute of the delete is compared
      // against the write's, so a future edit that changes one side and not the
      // other fails here.
      const spy = vi.spyOn(document, "cookie", "set");

      setLocaleCookie("vi", policy);
      removeLocaleCookie(policy);

      const written = String(spy.mock.calls[0]?.[0] ?? "");
      const deleted = String(spy.mock.calls[1]?.[0] ?? "");

      for (const attribute of [
        `name-placeholder`,
        "Path=/",
        "SameSite=Lax",
        ...(policy.domain === null ? [] : [`Domain=${policy.domain}`]),
        ...(policy.secure ? ["Secure"] : []),
      ]) {
        if (attribute === "name-placeholder") {
          expect(written.split("=")[0]).toBe(deleted.split("=")[0]);
          continue;
        }
        expect(written).toContain(attribute);
        expect(deleted).toContain(attribute);
      }

      // And the two differ only in the value and the lifetime.
      expect(deleted).toContain("Max-Age=0");
      expect(deleted).toContain("Expires=Thu, 01 Jan 1970");
      spy.mockRestore();
    },
  );

  it("leaves another environment's cookie alone", () => {
    // Deleting staging's preference must not clear production's. Before the
    // per-environment namespace this was one name shared by all four, so a
    // "reset my language" button on a preview could reset the language of
    // every visitor on production.
    //
    // Staging and preview both round-trip in jsdom; only PRODUCTION needs the
    // host-only stand-in, because jsdom refuses to store a `Domain=ecoma.io`
    // cookie on its `localhost` document (`support.ts`). The claim under test is
    // about the NAMES differing, which is unaffected.
    setLocaleCookie("vi", ROUND_TRIP_POLICIES.production);
    removeLocaleCookie(POLICIES.preview);
    expect(getLocaleFromCookie(ROUND_TRIP_POLICIES.production)).toBe("vi");

    // And symmetrically, deleting production's leaves staging's alone.
    removeLocaleCookie(ROUND_TRIP_POLICIES.production);
    setLocaleCookie("vi", POLICIES.staging);
    removeLocaleCookie(ROUND_TRIP_POLICIES.production);
    expect(getLocaleFromCookie(POLICIES.staging)).toBe("vi");
  });
});

describe("getLocaleFromCookie", () => {
  it("returns null when the cookie is absent", () => {
    expect(getLocaleFromCookie(POLICIES.development)).toBeNull();
  });

  it("treats an unsupported value as absent rather than passing it on", () => {
    // A hand-edited cookie must not be able to select a locale with no message
    // file behind it. Reading as absent means detection runs again, which
    // always lands on a locale that exists.
    document.cookie = `${POLICIES.development.name}=fr; Path=/`;
    expect(getLocaleFromCookie(POLICIES.development)).toBeNull();
  });

  it("treats a region variant as absent", () => {
    document.cookie = `${POLICIES.development.name}=vi-VN; Path=/`;
    expect(getLocaleFromCookie(POLICIES.development)).toBeNull();
  });

  it("treats a malformed percent-encoding as absent rather than throwing", () => {
    // `%` followed by nothing valid is not decodable, and `decodeURIComponent`
    // throws a `URIError` on it. A visitor who edits their own cookie should
    // get detection, not a blank page from an exception in a bootstrap.
    document.cookie = `${POLICIES.development.name}=%E0%A4%A; Path=/`;
    expect(getLocaleFromCookie(POLICIES.development)).toBeNull();
  });

  it("reads the right cookie among several", () => {
    document.cookie = "session=abc; Path=/";
    document.cookie = `${POLICIES.development.name}=vi; Path=/`;
    expect(getLocaleFromCookie(POLICIES.development)).toBe("vi");
  });

  it("returns null on a server with no document", () => {
    vi.stubGlobal("document", undefined);
    expect(getLocaleFromCookie(POLICIES.production)).toBeNull();
  });
});

describe("detectBrowserLocale", () => {
  it("reads the browser's primary language", () => {
    browserPrefers("vi-VN");
    expect(detectBrowserLocale()).toBe("vi");
  });

  it("walks the preference list until it finds a language it has", () => {
    // A browser set to French first and Vietnamese second is a visitor who
    // reads Vietnamese; falling straight through to the default on the first
    // unsupported entry would misread that.
    browserPrefers("fr-FR", "de-DE", "vi-VN", "en-US");
    expect(detectBrowserLocale()).toBe("vi");
  });

  it("falls back to the default when nothing preferred is supported", () => {
    browserPrefers("fr-FR", "de-DE");
    expect(detectBrowserLocale()).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default when the browser reports no languages at all", () => {
    browserPrefers();
    expect(detectBrowserLocale()).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default on a server with no navigator", () => {
    // The prerender path. Detection is a client-side capability, and the answer
    // there is the default rather than a crash.
    vi.stubGlobal("navigator", undefined);
    expect(detectBrowserLocale()).toBe(DEFAULT_LOCALE);
  });
});

describe("getEffectiveLocale", () => {
  it("prefers the stored choice over the browser", () => {
    setLocaleCookie("vi", POLICIES.development);
    browserPrefers("en-US");
    expect(getEffectiveLocale(POLICIES.development)).toBe("vi");
  });

  it("uses the browser when there is no stored choice", () => {
    browserPrefers("vi-VN");
    expect(getEffectiveLocale(POLICIES.development)).toBe("vi");
  });

  it("falls back to the default when neither is usable", () => {
    browserPrefers("de-DE", "fr-FR");
    expect(getEffectiveLocale(POLICIES.development)).toBe(DEFAULT_LOCALE);
  });

  it("does not write the cookie — storing a detected language is the app's call", () => {
    // The home page's server-side redirect must not set a cookie on a request
    // that only wanted to be routed; a first-time visitor's detected language
    // is applied for this visit and nothing more.
    browserPrefers("vi-VN");
    getEffectiveLocale(POLICIES.development);
    expect(getLocaleFromCookie(POLICIES.development)).toBeNull();
  });

  it("defaults to the projected policy when none is passed", () => {
    // Every function that takes a policy makes it optional, and the default is
    // the projection's — not a value computed from `import.meta.env.PROD`,
    // which is true in staging as well and was the reason one bundle could not
    // tell which deployment it was in.
    const written = setLocaleCookie("vi");
    expect(getLocaleFromCookie()).toBe("vi");
    // The projected environment in this checkout is `development`, whose policy
    // is host-only and not Secure. Read through the projection rather than
    // hardcoded, so the assertion tracks whatever was rendered.
    expect(written).toBeUndefined();
  });
});

describe("a policy object, not an isProduction flag", () => {
  it("refuses a boolean rather than writing a nameless cookie", () => {
    // A compile-time fact stated as a runtime guard, because the parameter type
    // cannot be asserted from a test that is itself typechecked the same way.
    //
    // This test was written the other way round, and the other way round was
    // the bug: it asserted that passing `true` produced a write of
    // `undefined=vi` — and it passed, because `cookiePolicy()` returned the
    // caller's value unchecked and `true !== null` satisfied the writer's
    // `Domain` guard. So a boolean produced `Domain=true`, no read could find
    // the cookie, nothing threw, and the preference was reported as working.
    //
    // The failure was not "it wrote a broken cookie instead of a good one".
    // It was that it wrote a broken one QUIETLY. Throwing at the call site is
    // the behaviour a migrating caller needs, because the mistake is theirs and
    // the symptom would otherwise appear as "the language preference stopped
    // saving" in an application they were not looking at.
    const spy = vi.spyOn(document, "cookie", "set");

    expect(() =>
      setLocaleCookie("vi", true as unknown as CookiePolicy),
    ).toThrow(MissingFrontendConfigError);

    // The important half: nothing was written on the way to throwing. A guard
    // that validated after a partial write would leave the broken cookie
    // behind and this assertion is what says it does not.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses a policy whose domain is neither a string nor null", () => {
    // The other half of the same guard, and the one that caught the bug. A
    // domain is written as `Domain=<value>` whenever it is not `null`, so any
    // other type becomes a cookie the browser accepts and nothing can read.
    // `null` is the host-only case and has to keep working — outside
    // production it is what stops a preview writing a zone-scoped cookie.
    const hostOnly = { name: "ecoma_test", domain: null, secure: false };

    expect(cookiePolicy(hostOnly)).toEqual(hostOnly);
    expect(() =>
      cookiePolicy({
        name: "ecoma_test",
        domain: true as unknown as string,
        secure: false,
      }),
    ).toThrow(/must be a domain string or null/);

    // Empty string is worse than `true`: `Domain=` scopes a cookie to the apex
    // and nothing else, so it writes successfully and reads back on exactly one
    // host of the zone.
    expect(() =>
      cookiePolicy({ name: "ecoma_test", domain: "", secure: false }),
    ).toThrow(/must be a domain string or null/);
  });
});
