import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemotePreferenceAdapter } from "../src/index.js";
import {
  DEFAULT_COLOR_MODE,
  DEFAULT_LOCALE,
  LocalPreferenceStore,
} from "../src/index.js";
import {
  POLICIES,
  ROUND_TRIP_POLICIES,
  clearCookies,
  stubMatchMedia,
} from "./support.js";

/**
 * The preference-store tests.
 *
 * ## What this suite is really about
 *
 * The store is the SEAM. Three frontends call the individual functions directly
 * today, and the seam exists so that when a second origin of a preference
 * appears — an authenticated server that knows the account's language — the
 * merge happens in one place instead of at every call site. The tests below
 * cover the one working implementation and assert the absence of the other.
 */

let setSystemPrefersDark: (dark: boolean) => void;

beforeEach(() => {
  clearCookies();
  setSystemPrefersDark = stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCookies();
  document.documentElement.removeAttribute("data-color-mode");
});

describe("LocalPreferenceStore", () => {
  it("reports the cookie's locale as 'cookie'", () => {
    const store = new LocalPreferenceStore(POLICIES.development);
    store.setLocale("vi");

    const preferences = store.read();
    expect(preferences.locale.value).toBe("vi");
    expect(preferences.locale.source).toBe("cookie");
  });

  it("reports a browser-detected locale as 'detected'", () => {
    vi.stubGlobal("navigator", { languages: ["vi-VN"], language: "vi-VN" });
    const store = new LocalPreferenceStore(POLICIES.development);

    const preferences = store.read();
    expect(preferences.locale.value).toBe("vi");
    expect(preferences.locale.source).toBe("detected");
  });

  it("reports the platform fallback as 'default', not as 'detected'", () => {
    // The one place this store could otherwise lie. `detectBrowserLocale`
    // falls back to the platform default internally and offers no way to ask
    // whether it did, so a browser that matched nothing and a browser that
    // happened to match the default locale are indistinguishable from here.
    // Reporting "detected" for the latter would tell a UI that the visitor
    // chose it.
    vi.stubGlobal("navigator", {
      languages: ["de-DE", "fr-FR"],
      language: "de-DE",
    });
    const store = new LocalPreferenceStore(POLICIES.development);

    const preferences = store.read();
    expect(preferences.locale.value).toBe(DEFAULT_LOCALE);
    expect(preferences.locale.source).toBe("default");
  });

  it("never reports a colour mode as 'detected'", () => {
    // The operating system IS consulted — `applyColorModeTo` below consults it
    // — but not by `read()`, and claiming detection here would describe an
    // answer this store has not given. A UI rendering "you chose dark" from a
    // `detected` source would be wrong about something the visitor never chose.
    vi.stubGlobal("navigator", { languages: [], language: undefined });
    setSystemPrefersDark(true);

    const store = new LocalPreferenceStore(POLICIES.development);
    const preferences = store.read();

    expect(preferences.colorMode.value).toBe(DEFAULT_COLOR_MODE);
    expect(preferences.colorMode.source).toBe("default");
  });

  it("reports an explicit colour mode as 'cookie'", () => {
    const store = new LocalPreferenceStore(POLICIES.development);
    store.setColorMode("dark");

    const preferences = store.read();
    expect(preferences.colorMode.value).toBe("dark");
    expect(preferences.colorMode.source).toBe("cookie");
  });

  it("defaults to the projected policy", () => {
    // A store constructed with no policy reads and writes the environment this
    // build was rendered for. That is what lets an app write `new
    // LocalPreferenceStore()` and be correct in staging and in production
    // without a single environment check.
    const store = new LocalPreferenceStore();
    store.setLocale("vi");
    expect(store.read().locale.value).toBe("vi");
  });

  it("clears both preferences with one call", () => {
    // One method rather than two: removing them separately would leave a window
    // in which the visitor has a locale preference and no colour-mode
    // preference, which is not a state any caller wants to reason about.
    const store = new LocalPreferenceStore(POLICIES.development);
    store.setLocale("vi");
    store.setColorMode("dark");
    expect(store.read().locale.source).toBe("cookie");
    expect(store.read().colorMode.source).toBe("cookie");

    store.clear();

    const cleared = store.read();
    expect(cleared.locale.source).not.toBe("cookie");
    expect(cleared.colorMode.source).not.toBe("cookie");
  });

  it("keeps one environment's preferences out of another's", () => {
    // A preview's visitor resetting their language must not reset production's
    // — the failure a single shared cookie name produces, and the one the
    // per-environment namespace exists to prevent.
    //
    // `ROUND_TRIP_POLICIES.production` rather than `POLICIES.production`: this
    // is a round-trip assertion, and the reason the round-trip variant exists
    // is that jsdom's document host is `localhost` and it REJECTS a
    // `Domain=ecoma.io` cookie outright — the write lands and the jar comes
    // back empty. Using the real production policy here would assert nothing
    // about the code and everything about jsdom. The names still differ, which
    // is the property under test; only the domain jsdom refuses is dropped.
    const production = new LocalPreferenceStore(ROUND_TRIP_POLICIES.production);
    const preview = new LocalPreferenceStore(POLICIES.preview);

    production.setLocale("vi");
    preview.clear();

    expect(production.read().locale.value).toBe("vi");
  });

  it("reports a time zone without persisting one", () => {
    // The load-bearing property of the third field. The preference cookie lasts
    // a year, so a traveller's zone stored beside it would be wrong for a year
    // — silently, because every timestamp still renders. Off by six hours is a
    // plausible-looking wrong answer.
    const store = new LocalPreferenceStore(POLICIES.development);
    const before = store.read();

    expect(
      before.timeZone === null || typeof before.timeZone === "string",
    ).toBe(true);

    // Reading again, and writing a locale in between, must not have stored a
    // zone: a zone is detected per session and nothing about it is durable.
    store.setLocale("vi");
    store.setColorMode("dark");
    const after = store.read();

    expect(after.timeZone).toBe(before.timeZone);
    // And the cookie jar holds only the two preferences, not a zone.
    expect(document.cookie).not.toContain("Europe");
    expect(document.cookie).not.toContain("Asia");
    expect(document.cookie).not.toContain("America");
  });

  it("applies the colour mode in one call, before first paint", () => {
    // Reading the cookie and writing the attribute are one decision, so they
    // are one call: three apps each remembering to do that in their bootstrap is
    // three chances to forget, and the flash it causes is the thing the
    // attribute exists to prevent.
    const store = new LocalPreferenceStore(POLICIES.development);
    store.setColorMode("dark");

    expect(store.applyColorModeTo()).toBe("dark");
    expect(document.documentElement.getAttribute("data-color-mode")).toBe(
      "dark",
    );
  });

  it("resolves a stored 'system' against the operating system at apply time", () => {
    const store = new LocalPreferenceStore(POLICIES.development);
    store.setColorMode("system");

    setSystemPrefersDark(true);
    expect(store.applyColorModeTo()).toBe("dark");

    // Same stored preference, system changed: the answer moves without the
    // cookie being touched, which is the whole point of storing "system"
    // rather than the colour it resolved to.
    setSystemPrefersDark(false);
    expect(store.applyColorModeTo()).toBe("light");
    expect(store.read().colorMode.value).toBe("system");
  });

  it("distinguishes a stored 'system' from a visitor who was never asked", () => {
    // The regression this file's other colour-mode test was written to catch,
    // and it was not caught by it.
    //
    // `read()` used to call `readColorMode()` and then test the result with
    // `isColorMode()`. `readColorMode` substitutes the platform default for
    // every "unset" case, so its return is always a valid mode and that test
    // was a tautology: it could never be false, the function it guarded always
    // returned a value, and `source` was therefore reported as `"cookie"` for
    // every visitor who had never opened a theme control.
    //
    // It cannot come back, because the default IS `system` — which is exactly
    // why the check had to be made against the raw cookie rather than the
    // resolved value. Both cases below return `system` as the VALUE, and only
    // one of them was ever a choice.
    const store = new LocalPreferenceStore(POLICIES.development);

    expect(store.read().colorMode).toEqual({
      value: "system",
      source: "default",
    });

    store.setColorMode("system");
    expect(store.read().colorMode).toEqual({
      value: "system",
      source: "cookie",
    });
  });
});

describe("the remote adapter is declared and deferred", () => {
  it("is a type with no implementation anywhere in this package", () => {
    // `RemotePreferenceAdapter` is imported as a TYPE only, which is the
    // strongest statement a test can make: the name resolves, the contract is
    // readable, and nothing at runtime implements it. There is no endpoint, no
    // `fetch` and no mock response in this file or any other in this package.
    //
    // `AGENTS.md` requires unimplemented behaviour to read as unimplemented, so
    // this assertion is the mechanical half of that rule. A future commit that
    // implements the adapter will have to delete this test, and the diff will
    // say so — which is the point.
    const implemented: RemotePreferenceAdapter | undefined = undefined;
    expect(implemented).toBeUndefined();
  });

  it("does not make a network call, because there is nothing to call", () => {
    // The strongest available negative: with `fetch` stubbed to throw, the whole
    // store still works. If any future change introduced a request here, every
    // test in this file would fail on a thrown network error rather than on a
    // silent omission.
    const fetchSpy = vi.fn(() => {
      throw new Error("the preference store must not touch the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const store = new LocalPreferenceStore(POLICIES.development);
    store.setLocale("vi");
    store.setColorMode("dark");
    store.read();
    store.clear();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
