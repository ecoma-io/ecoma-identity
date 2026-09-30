import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18N_COOKIE_NAME } from "../src/index.js";
import {
  detectBrowserLocale,
  getEffectiveLocale,
  getLocaleFromCookie,
  removeLocaleCookie,
  setLocaleCookie,
} from "../src/cookie.js";

/**
 * These tests run against a real `document.cookie` in jsdom.
 *
 * jsdom's `document.cookie` implementation has a key limitation: it only exposes
 * name=value pairs, not the attributes (Domain, Secure, SameSite, etc.). To verify
 * the attribute string is correct, we spy on the setter and capture what was written.
 * The round-trip tests use the actual read path, which works correctly in jsdom.
 */

/** Overwrite every cookie this suite set, so cases do not leak into each other. */
function clearCookies(): void {
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (name !== undefined && name !== "") {
      document.cookie = `${name}=; Path=/; Max-Age=0`;
    }
  }
}

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
  clearCookies();
});

describe("the cookie name", () => {
  it("is the one all three frontends share", () => {
    // Named in nuxt.config.ts as `cookieKey`, and in the two Vue apps via this
    // constant. If this string changes, the apps stop sharing a preference and
    // every one of them keeps working perfectly — which is why it is asserted
    // rather than left to a comment.
    expect(I18N_COOKIE_NAME).toBe("ecoma_locale");
  });
});

describe("setLocaleCookie", () => {
  it("round-trips through getLocaleFromCookie", () => {
    setLocaleCookie("vi", false);
    expect(getLocaleFromCookie()).toBe("vi");
  });

  it("writes the parent domain, so the other subdomains can read it", () => {
    const spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", true);
    expect(spy).toHaveBeenCalledTimes(1);
    const written = spy.mock.calls[0]?.[0] ?? "";
    // The Domain attribute is what makes the cookie visible across subdomains.
    // In production it's `.ecoma.io`; in development it's `localhost`.
    expect(written).toContain("Domain=.ecoma.io");
    expect(written).toContain("ecoma_locale=vi");
    spy.mockRestore();
  });

  it("sets SameSite=Lax, which is what a cross-subdomain navigation needs", () => {
    const spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", true);
    const written = spy.mock.calls[0]?.[0] ?? "";
    // SameSite=None would also work and would additionally expose the value to
    // a cross-origin iframe. Lax permits the top-level navigation between
    // ecoma.io and admin.ecoma.io, which is the only case there is.
    expect(written).toContain("SameSite=Lax");
    expect(written).not.toContain("SameSite=None");
    spy.mockRestore();
  });

  it("marks the production cookie Secure and the development one not", () => {
    let spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", true);
    let written = spy.mock.calls[0]?.[0] ?? "";
    expect(written).toContain("Secure");
    spy.mockRestore();

    clearCookies();

    spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", false);
    written = spy.mock.calls[0]?.[0] ?? "";
    // A Secure cookie set over plain HTTP is dropped by the browser, so
    // development has to omit it or the preference would never persist locally
    // and the cross-app behaviour would be untestable on a laptop.
    expect(written).not.toContain("Secure");
    spy.mockRestore();
  });

  it("survives a reload, which is the point of storing it", () => {
    setLocaleCookie("vi", false);
    // Nothing here re-reads a module-level cache, so this is exactly what a
    // fresh page load sees.
    expect(getLocaleFromCookie()).toBe("vi");
  });

  it("does nothing on a server with no document", () => {
    // The home page prerenders on the server, where `document` does not exist.
    // A write attempt here would throw during prerender rather than degrade.
    vi.stubGlobal("document", undefined);
    expect(() => setLocaleCookie("vi", false)).not.toThrow();
  });
});

describe("getLocaleFromCookie", () => {
  it("returns null when the cookie is absent", () => {
    expect(getLocaleFromCookie()).toBeNull();
  });

  it("treats an unsupported value as absent rather than passing it on", () => {
    // A hand-edited cookie must not be able to select a locale with no message
    // file behind it. Reading as absent means detection runs again, which
    // always lands on a locale that exists.
    document.cookie = "ecoma_locale=fr; Path=/";
    expect(getLocaleFromCookie()).toBeNull();
  });

  it("treats a region variant as absent", () => {
    document.cookie = "ecoma_locale=vi-VN; Path=/";
    expect(getLocaleFromCookie()).toBeNull();
  });

  it("reads the right cookie among several", () => {
    document.cookie = "session=abc; Path=/";
    document.cookie = "ecoma_locale=vi; Path=/";
    expect(getLocaleFromCookie()).toBe("vi");
  });

  it("returns null on a server with no document", () => {
    vi.stubGlobal("document", undefined);
    expect(getLocaleFromCookie()).toBeNull();
  });
});

describe("removeLocaleCookie", () => {
  it("clears the preference so the next visit re-detects", () => {
    setLocaleCookie("vi", false);
    expect(getLocaleFromCookie()).toBe("vi");

    removeLocaleCookie(false);
    expect(getLocaleFromCookie()).toBeNull();
  });

  it("is scoped to the same domain the write used", () => {
    // Without the matching Domain, the deletion writes a host-only cookie that
    // shadows the domain-scoped one instead of removing it, and the preference
    // would appear to survive being cleared.
    const spy = vi.spyOn(document, "cookie", "set");
    setLocaleCookie("vi", true);
    removeLocaleCookie(true);
    const written = spy.mock.calls[1]?.[0] ?? "";
    expect(written).toContain("Domain=.ecoma.io");
    expect(written).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    spy.mockRestore();
  });
});

describe("detectBrowserLocale", () => {
  it("reads the browser's primary language", () => {
    browserPrefers("vi-VN");
    expect(detectBrowserLocale()).toBe("vi");
  });

  it("walks the preference list until it finds a language it has", () => {
    // A browser set to French first and Vietnamese second is a visitor who
    // reads Vietnamese; falling straight through to English on the first
    // unsupported entry would misread that.
    browserPrefers("fr-FR", "de-DE", "vi-VN", "en-US");
    expect(detectBrowserLocale()).toBe("vi");
  });

  it("falls back to English when nothing preferred is supported", () => {
    browserPrefers("fr-FR", "de-DE");
    expect(detectBrowserLocale()).toBe("en");
  });

  it("falls back to English when the browser reports no languages at all", () => {
    browserPrefers();
    expect(detectBrowserLocale()).toBe("en");
  });

  it("falls back to English on a server with no navigator", () => {
    // The prerender path. Detection is a client-side capability, and the answer
    // there is the default rather than a crash.
    vi.stubGlobal("navigator", undefined);
    expect(detectBrowserLocale()).toBe("en");
  });
});

describe("getEffectiveLocale", () => {
  it("prefers the stored choice over the browser", () => {
    setLocaleCookie("vi", false);
    browserPrefers("en-US");
    expect(getEffectiveLocale()).toBe("vi");
  });

  it("uses the browser when there is no stored choice", () => {
    browserPrefers("vi-VN");
    expect(getEffectiveLocale()).toBe("vi");
  });

  it("falls back to English when neither is usable", () => {
    browserPrefers("de-DE", "fr-FR");
    expect(getEffectiveLocale()).toBe("en");
  });

  it("does not write the cookie — storing a detected language is the app's call", () => {
    // The home page's server-side redirect must not set a cookie on a request
    // that only wanted to be routed; a first-time visitor's detected language
    // is applied for this visit and nothing more.
    browserPrefers("vi-VN");
    getEffectiveLocale();
    expect(getLocaleFromCookie()).toBeNull();
  });
});
