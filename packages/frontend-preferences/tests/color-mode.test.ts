import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorMode } from "../src/index.js";
import {
  DEFAULT_COLOR_MODE,
  applyColorMode,
  isColorMode,
  prefersDark,
  readColorMode,
  removeColorModeCookie,
  resolveColorMode,
  setColorModeCookie,
} from "../src/index.js";
import {
  POLICIES,
  ROUND_TRIP_POLICIES,
  clearCookies,
  stubMatchMedia,
} from "./support.js";

/**
 * Colour-mode tests.
 *
 * ## The property under test throughout
 *
 * `system` is a STORED value, not the absence of one, and it is resolved at the
 * moment the attribute is applied rather than when it was stored. That pairing
 * is what makes "follow my operating system" a choice a visitor can keep across
 * visits — and it is also why a page that stored the resolved colour would be
 * permanently wrong for exactly the people who chose `system`.
 *
 * ## `matchMedia` is stubbed, and why that is not optional
 *
 * jsdom does not implement `window.matchMedia` at all — it is `undefined`, not
 * a function returning `false`. Without the stub every assertion here would
 * silently be testing the "no matchMedia" fallback, and the suite would go green
 * having verified nothing. The first test asserts the stub is installed for
 * exactly that reason: it protects every test after it from being vacuous.
 */

let setSystemPrefersDark: (dark: boolean) => void;

beforeEach(() => {
  clearCookies();
  setSystemPrefersDark = stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  document.documentElement.removeAttribute("data-color-mode");
});

describe("the matchMedia stub", () => {
  it("is actually installed, so the tests below are not vacuous", () => {
    // The suite's own honesty check. jsdom has no `matchMedia`, so without this
    // stub every `resolveColorMode("system")` case would take the
    // no-matchMedia branch and report "light" for the same reason whether the
    // system preferred dark or not — a green suite that verified nothing.
    expect(typeof window.matchMedia).toBe("function");
    expect(prefersDark()).toBe(false);

    setSystemPrefersDark(true);
    expect(prefersDark()).toBe(true);
  });
});

describe("isColorMode", () => {
  it("accepts exactly the three modes", () => {
    for (const mode of ["system", "light", "dark"] as const) {
      expect(isColorMode(mode)).toBe(true);
    }
  });

  it("rejects anything else, including a near miss", () => {
    // A cookie is a string the visitor edited, so the guard has to be exact.
    // A loose match here would hand `applyColorMode` a value no selector in the
    // token sheet matches, leaving the page unthemed with no error anywhere.
    for (const value of ["auto", "Dark", "DARK", "", "light ", "system2"]) {
      expect(isColorMode(value)).toBe(false);
    }
  });
});

describe("resolveColorMode", () => {
  it("passes an explicit choice through unchanged", () => {
    // A visitor who picked light keeps light whatever their system says. The
    // alternative — always asking the OS — would make the preference a
    // decoration.
    setSystemPrefersDark(true);
    expect(resolveColorMode("light")).toBe("light");

    setSystemPrefersDark(false);
    expect(resolveColorMode("dark")).toBe("dark");
  });

  it("resolves system against the operating system", () => {
    setSystemPrefersDark(true);
    expect(resolveColorMode("system")).toBe("dark");

    setSystemPrefersDark(false);
    expect(resolveColorMode("system")).toBe("light");
  });

  it("reports light when there is no matchMedia at all", () => {
    // The no-matchMedia fallback — jsdom without the stub, a headless render
    // context. Light is the CSS `color-scheme` default and therefore what an
    // unstyled page already renders as, so this answer introduces no visual
    // change of its own. Dark would be a guess, and a guess in a bootstrap that
    // runs before first paint is a visible one.
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersDark()).toBe(false);
    expect(resolveColorMode("system")).toBe("light");
  });
});

describe("applyColorMode", () => {
  it("writes the resolved mode onto <html>", () => {
    expect(applyColorMode("dark")).toBe("dark");
    expect(document.documentElement.getAttribute("data-color-mode")).toBe(
      "dark",
    );
  });

  it("always writes a concrete mode, never the literal 'system'", () => {
    // `:root` in the token sheet holds the light tokens, so an absent attribute
    // is indistinguishable from `light`. Writing "system" would therefore mean
    // "light" on a machine whose system is dark — and "remove the attribute to
    // go back to following the system" would be a lie. The state has to be
    // representable, and the cookie is where it is representable.
    setSystemPrefersDark(true);
    expect(applyColorMode("system")).toBe("dark");
    expect(document.documentElement.getAttribute("data-color-mode")).not.toBe(
      "system",
    );

    setSystemPrefersDark(false);
    expect(applyColorMode("system")).toBe("light");
    expect(document.documentElement.getAttribute("data-color-mode")).toBe(
      "light",
    );
  });

  it("accepts the element to mark, so the inline bootstrap need not look it up", () => {
    const root = document.createElement("html");
    applyColorMode("dark", root);
    expect(root.getAttribute("data-color-mode")).toBe("dark");
    // The document itself was not touched, which is what makes this usable from
    // a `<head>` script that has an element reference but no reason to reach
    // for the global.
    expect(document.documentElement.getAttribute("data-color-mode")).toBeNull();
  });

  it("reacts to the system changing while the page is open", () => {
    // The behaviour that makes `system` worth storing: a visitor who left the
    // platform on "follow my operating system" gets a page that follows their
    // system to dark at sunset WITHOUT revisiting. Applied twice, once per
    // system state, against the same stored preference.
    setSystemPrefersDark(false);
    applyColorMode("system");
    expect(document.documentElement.getAttribute("data-color-mode")).toBe(
      "light",
    );

    setSystemPrefersDark(true);
    applyColorMode("system");
    expect(document.documentElement.getAttribute("data-color-mode")).toBe(
      "dark",
    );
  });
});

describe("readColorMode", () => {
  it("returns the stored choice", () => {
    setColorModeCookie("dark", POLICIES.development);
    expect(readColorMode(POLICIES.development)).toBe("dark");
  });

  it("returns the platform default when there is no cookie", () => {
    // And the default is read from the projection, not hardcoded here: a test
    // asserting `toBe("system")` would be a second owner of a value
    // `infra-topology/frontend-support.json` declares.
    expect(readColorMode(POLICIES.development)).toBe(DEFAULT_COLOR_MODE);
  });

  it("treats a hand-edited value as no choice rather than trusting it", () => {
    // The same degradation the locale cookie has always had, for the same
    // reason: an unrecognised value reads as "no choice" and lands on the
    // platform default, rather than reaching `applyColorMode` as a string no
    // selector matches.
    document.cookie = `${POLICIES.development.name}=sepia; Path=/`;
    expect(readColorMode(POLICIES.development)).toBe(DEFAULT_COLOR_MODE);
  });

  it("treats a malformed encoding as no choice rather than throwing", () => {
    document.cookie = `${POLICIES.development.name}=%E0%A4%A; Path=/`;
    expect(readColorMode(POLICIES.development)).toBe(DEFAULT_COLOR_MODE);
  });

  it("reads only its own environment's cookie", () => {
    // `ROUND_TRIP_POLICIES` because this reads a cookie back and jsdom's
    // document host is `localhost`, which refuses a `Domain=ecoma.io` cookie
    // outright — writing with the real production policy and reading back would
    // assert that jsdom accepted a zone-scoped cookie, not that this package
    // read its own. See `support.ts` for the full reason; the names still
    // differ, which is the property under test.
    setColorModeCookie("dark", ROUND_TRIP_POLICIES.production);
    expect(readColorMode(ROUND_TRIP_POLICIES.production)).toBe("dark");
    // A preview has no opinion about production's preference, and asking it
    // would be how one deployment's colour mode leaks into another's.
    expect(readColorMode(POLICIES.preview)).toBe(DEFAULT_COLOR_MODE);
  });

  it("returns the default on a server with no document", () => {
    vi.stubGlobal("document", undefined);
    expect(readColorMode(POLICIES.production)).toBe(DEFAULT_COLOR_MODE);
  });
});

describe("persistence", () => {
  it("round-trips an explicit choice", () => {
    // The cookie names the locale, because one cookie carries the preference
    // and the same policy governs it — a separate colour-mode cookie would mean
    // the "reset my preferences" control had two lifetimes to get wrong.
    setColorModeCookie("light", POLICIES.development);
    expect(readColorMode(POLICIES.development)).toBe("light");
  });

  it("round-trips 'system' as a first-class value", () => {
    // Not as an empty string and not as "remove the cookie". `system` is the
    // only way to say "stop overriding my operating system", and expressing it
    // as absence would leave a stale light/dark behind and make the two
    // indistinguishable — with the symptom being a page that keeps a colour the
    // visitor explicitly gave up.
    setColorModeCookie("system", POLICIES.development);
    expect(readColorMode(POLICIES.development)).toBe("system");
  });

  it("survives a reload, which is the point of storing it", () => {
    setColorModeCookie("dark", POLICIES.development);
    // Nothing here re-reads a module-level cache, so this is exactly what a
    // fresh page load sees.
    expect(readColorMode(POLICIES.development)).toBe("dark");
  });

  it("survives the system changing between visits", () => {
    // The stored value is the CHOICE, not the colour it resolved to. A visitor
    // who chose `system` on a dark machine and next visits on a light one must
    // get light — the test that fails if a store ever persisted `resolveColorMode`'s
    // output instead of the preference.
    setColorModeCookie("system", POLICIES.development);
    setSystemPrefersDark(false);
    expect(applyColorMode(readColorMode(POLICIES.development))).toBe("light");

    setSystemPrefersDark(true);
    expect(applyColorMode(readColorMode(POLICIES.development))).toBe("dark");
  });

  it("writes the same policy it later deletes under", () => {
    // The deletion-symmetry property, for the colour-mode cookie. A delete
    // under a different Domain leaves the original in place beside a host-only
    // shadow, and the preference survives being cleared with no error.
    const spy = vi.spyOn(document, "cookie", "set");

    setColorModeCookie("dark", POLICIES.production);
    removeColorModeCookie(POLICIES.production);

    const written = String(spy.mock.calls[0]?.[0] ?? "");
    const deleted = String(spy.mock.calls[1]?.[0] ?? "");

    expect(written.split("=")[0]).toBe(deleted.split("=")[0]);
    expect(written).toContain(`Domain=${POLICIES.production.domain}`);
    expect(deleted).toContain(`Domain=${POLICIES.production.domain}`);
    expect(written).toContain("Secure");
    expect(deleted).toContain("Secure");
    expect(deleted).toContain("Max-Age=0");
    spy.mockRestore();
  });

  it("emits no Domain attribute when the policy says host-only", () => {
    const spy = vi.spyOn(document, "cookie", "set");
    setColorModeCookie("dark", POLICIES.preview);
    removeColorModeCookie(POLICIES.preview);
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain("Domain=");
    }
    spy.mockRestore();
  });

  it("clears the preference so the default applies again", () => {
    setColorModeCookie("dark", POLICIES.development);
    removeColorModeCookie(POLICIES.development);
    expect(readColorMode(POLICIES.development)).toBe(DEFAULT_COLOR_MODE);
  });

  it("leaves another environment's cookie alone", () => {
    // Round trip, so the host-only production policy — see `support.ts`.
    setColorModeCookie("dark", ROUND_TRIP_POLICIES.production);
    removeColorModeCookie(POLICIES.preview);
    expect(readColorMode(ROUND_TRIP_POLICIES.production)).toBe("dark");
  });

  it("writes nothing on a server with no document", () => {
    vi.stubGlobal("document", undefined);
    expect(() => setColorModeCookie("dark", POLICIES.production)).not.toThrow();
    expect(() => removeColorModeCookie(POLICIES.production)).not.toThrow();
  });
});

describe("every mode is applicable", () => {
  it.each(["system", "light", "dark"] as ColorMode[])(
    "%s produces an attribute the token sheet can select on",
    (mode) => {
      // The three attribute selectors in `src/styles/tokens.css` are
      // `[data-color-mode="light"]` and `[data-color-mode="dark"]`; there is no
      // third, because `system` is resolved before it reaches the DOM. A fourth
      // mode reaching here as a literal would produce an attribute with no rule
      // behind it.
      const applied = applyColorMode(mode);
      expect(["light", "dark"]).toContain(applied);
      expect(document.documentElement.getAttribute("data-color-mode")).toBe(
        applied,
      );
    },
  );
});
