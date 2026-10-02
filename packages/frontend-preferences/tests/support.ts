import { vi } from "vitest";

/**
 * Test helpers shared by this package's suites.
 *
 * ## Why `matchMedia` is stubbed here rather than in each suite
 *
 * jsdom does not implement `window.matchMedia` at all — it is `undefined`, not
 * a function returning `false`. Every colour-mode test therefore has to provide
 * one, and a stub defined per suite is a stub three suites will define three
 * slightly different ways. The rules for a good stub are stated once, here:
 *
 *   - it names what it is for (`prefers-color-scheme`), because the next reader
 *     needs to know it is not a general media-query emulator;
 *   - it can be told to change its answer, because "the system switched to dark
 *     while the page was open" is a behaviour this package promises and a stub
 *     that cannot move would make it untestable;
 *   - it registers the listener a `change` subscription would use, so a test can
 *     assert that a caller subscribed rather than that it happened to read the
 *     right value once.
 */

/** The listeners a {@link stubMatchMedia} has registered, per media query. */
const matchMediaListeners = new Map<
  string,
  Set<(event: MediaQueryListEvent) => void>
>();

/** The answer the current stub gives for `prefers-color-scheme: dark`. */
let prefersDarkAnswer = false;

/**
 * A minimal `MediaQueryList` — only the surface `color-mode.ts` touches.
 *
 * `addEventListener`/`removeEventListener` are here rather than omitted because
 * their absence would fail loudly in any future caller that subscribes, which
 * is the outcome a stub should produce; a stub that silently accepts a
 * subscription and never fires it would hide exactly the bug a test would be
 * written to find.
 */
function createMediaQueryList(query: string): MediaQueryList {
  const listeners = matchMediaListeners.get(query) ?? new Set();

  return {
    media: query,
    get matches() {
      return query === "(prefers-color-scheme: dark)"
        ? prefersDarkAnswer
        : false;
    },
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      listeners.add(listener);
    },
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

/**
 * Install a `window.matchMedia` that answers `prefers-color-scheme`.
 *
 * @param prefersDark Whether the stub should report a dark preference.
 * @returns A function that changes the stub's answer AND notifies every
 *   registered listener, which is what lets a test assert that a page reacts to
 *   a system theme change rather than only reading the preference once.
 */
export function stubMatchMedia(prefersDark = false): (dark: boolean) => void {
  prefersDarkAnswer = prefersDark;
  matchMediaListeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => {
    const existing = matchMediaListeners.get(query);
    if (existing === undefined) {
      matchMediaListeners.set(query, new Set());
    }
    return createMediaQueryList(query);
  });

  return (dark: boolean) => {
    prefersDarkAnswer = dark;
    const listeners = matchMediaListeners.get("(prefers-color-scheme: dark)");
    if (listeners === undefined) {
      return;
    }
    for (const listener of listeners) {
      listener({ matches: dark } as MediaQueryListEvent);
    }
  };
}

/**
 * A cookie policy for one of the four environments, as the projection states it.
 *
 * Built by hand rather than read from the projection because a test that asserts
 * "production writes the zone apex" must not depend on the same value the code
 * under test reads — otherwise the test would pass by construction whatever the
 * code did. The literals here are the topology's, and
 * `tooling/scripts/check-frontend-config.mjs` is what keeps them so.
 */
export const POLICIES = {
  production: {
    name: "ecoma_prod_locale",
    domain: "ecoma.io",
    secure: true,
  },
  staging: { name: "ecoma_stg_locale", domain: null, secure: true },
  preview: { name: "ecoma_pr42_locale", domain: null, secure: true },
  development: { name: "ecoma_dev_locale", domain: null, secure: false },
} as const;

/**
 * The same four environments, with the production `Domain` removed.
 *
 * ## Why this exists, and why asserting with it needs its reason stated
 *
 * **jsdom's document host is `http://localhost:3000/`, and it REJECTS a
 * `Domain=ecoma.io` cookie outright** — the write lands, and the jar comes back
 * empty. Every other host-only policy survives, including the two `Secure`
 * ones: a `Secure` cookie is dropped by a browser on plain HTTP *only for a
 * domain the page is not already on*, so `localhost` is not a special case here
 * and staging/preview round-trip normally.
 *
 * That means a test which writes `POLICIES.production` and reads it back is not
 * testing the package. It is testing whether jsdom accepted a zone-scoped
 * cookie, and it will fail for a reason that has nothing to do with the code
 * under test — which is worse than not testing it, because the obvious fix
 * ("pass the host-only policy") silently stops asserting the production
 * attribute string, the one thing about production that is actually
 * environment-specific.
 *
 * So the two facts are separated deliberately:
 *
 *   - **Round-trip assertions** — does a write read back, does a deletion
 *     delete — use {@link ROUND_TRIP_POLICIES}, whose production entry keeps the
 *     name and the `Secure` flag and drops only the domain jsdom refuses. The
 *     cookie machinery is identical either way; `Domain` is not read back.
 *   - **Attribute-string assertions** — is it written `Domain=ecoma.io` at all,
 *     is it `Secure`, is the name namespaced — use {@link POLICIES} unchanged,
 *     because that string is the whole claim.
 *
 * Nothing in a suite may use `ROUND_TRIP_POLICIES.production` without saying so
 * in a comment that names this reason. A future reader who finds an unexplained
 * production policy in a round-trip test will assume the domain was forgotten.
 */
export const ROUND_TRIP_POLICIES = {
  production: { name: POLICIES.production.name, domain: null, secure: true },
  staging: POLICIES.staging,
  preview: POLICIES.preview,
  development: POLICIES.development,
} as const;

/**
 * Remove every cookie this suite wrote, under both of the scopes one can be
 * written at.
 *
 * ## Why it deletes twice, and why that is not belt-and-braces
 *
 * A cookie's scope is part of its identity, so `ecoma_prod=vi` written with
 * `Domain=ecoma.io` and `ecoma_prod=vi` written without it are TWO cookies, and
 * `Max-Age=0` removes exactly one of them. jsdom implements this faithfully —
 * verified rather than assumed: writing with `Domain=ecoma.io` on a document
 * hosted at `ecoma.io`, then deleting with `Max-Age=0` and no `Domain`, leaves
 * the cookie in place, and only the `Domain`-bearing delete clears it.
 *
 * That is the same shadow-cookie behaviour `preference-cookie.ts` warns about,
 * reproduced faithfully in a test double, which is why the fix here is to
 * delete under every scope a cookie might have been written at rather than to
 * assume the suites below it wrote only host-only ones.
 *
 * An earlier version of this helper omitted `Domain` on the grounds that
 * "`Max-Age=0` alone does not clear a domain-scoped cookie, so delete the
 * host-only ones". Both halves were right and together they deleted neither:
 * the suites write with `POLICIES.production.domain = "ecoma.io"`, the delete
 * targeted a cookie that did not exist, and every suite that ran afterwards
 * inherited the previous test's cookies. Four failures in three unrelated
 * suites were all this one line.
 *
 * Both deletes are unconditional rather than filtered to the policies the
 * suites use, because `document.cookie` exposes only name=value pairs — there
 * is no way to ask a cookie jar what scope a cookie was written at, which is
 * the reason this helper has to guess and is why guessing both ways is correct.
 */
export function clearCookies(): void {
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (name === undefined || name === "") {
      continue;
    }
    document.cookie = `${name}=; Path=/; Max-Age=0`;
    document.cookie = `${name}=; Path=/; Domain=ecoma.io; Max-Age=0`;
  }
}

/**
 * The single attribute string written by the last `document.cookie =` assignment.
 *
 * The `typeof` guard is not decoration. Without it a spy typed loosely enough to
 * accept any argument yields `unknown`, and `String(someObject)` is
 * `"[object Object]"` — so a call that never happened would assert as a cookie
 * string rather than as the empty one it should be, and the failure would read
 * as "the write was malformed" instead of "there was no write".
 */
export function lastCookieWrite(spy: { mock: { calls: unknown[][] } }): string {
  const last = spy.mock.calls.at(-1)?.[0];
  return typeof last === "string" ? last : "";
}
