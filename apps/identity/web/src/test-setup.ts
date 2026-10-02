// Browser APIs jsdom does not implement that this app's tests touch.
//
// Each entry names what it is for. A general-purpose polyfill bundle is the
// wrong tool here: it would add a dependency to make a test environment look
// like a browser, and in an identity app the difference between a real browser
// and a stub is exactly where the security-relevant behaviour lives.
//
// Nothing here stubs `fetch`. The API tests replace `globalThis.fetch` directly
// with their own function, because the point of those tests is to assert what
// this app does with a response — including a 501 — and a stubbed fetch would
// be asserting the stub's behaviour instead.

/**
 * `matchMedia`, because the colour-mode preference reads the operating system
 * through it.
 *
 * jsdom implements `window` in enough detail for the DOM and nothing more; it
 * has no `matchMedia` at all, so the property is absent rather than wrong. That
 * absence matters here in a way it would not for most APIs: `useColorMode` and
 * the package behind it both GUARD for it and answer "light" when it is
 * missing, so without this stub every colour-mode test would pass by accident,
 * asserting the fallback path and never the one it was written for.
 *
 * The stub is deliberately not the whole interface. `matches` is computed from
 * a value a test sets, `addEventListener` records its listeners so a test can
 * fire a change, and nothing else is implemented — a test that starts reaching
 * for `addListener` or `removeEventListener` is asking for something jsdom
 * cannot honestly provide, and the failure it gets is more useful than a stub
 * that pretends.
 *
 * `matches` is read at CALL time rather than captured at construction, so a
 * test that changes it before calling `matchMedia` gets the value it set. The
 * alternative — reading it once — is what a real `MediaQueryList` does, and
 * mirroring that would mean every test had to rebuild the stub to change the
 * answer.
 */

/** The media query the stub answers for, and the only one this app asks. */
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Whether the stubbed `matchMedia` currently reports a dark system. */
let prefersDark = false;

/** The listeners registered against the dark query, so tests can fire one. */
const darkQueryListeners = new Set<(event: MediaQueryListEvent) => void>();

/**
 * Set what the next `matchMedia` call reports for `prefers-color-scheme: dark`.
 *
 * Exported for the test that proves the bootstrap and the package agree: it
 * drives the inline script through jsdom with one answer and the package
 * through the stub with the same one.
 *
 * @param value Whether the operating system is in dark mode.
 */
export function setPrefersDark(value: boolean): void {
  prefersDark = value;
}

/**
 * Fire a `change` event at the listeners the stub recorded.
 *
 * @param matches Whether the system has just become dark.
 */
export function emitPrefersDarkChange(matches: boolean): void {
  prefersDark = matches;
  const event = { matches } as MediaQueryListEvent;
  for (const listener of darkQueryListeners) {
    listener(event);
  }
}

/** Forget every listener, so one test's listener cannot fire in the next. */
export function resetMatchMedia(): void {
  prefersDark = false;
  darkQueryListeners.clear();
}

if (typeof window !== "undefined" && window.matchMedia === undefined) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const isDarkQuery = query === DARK_QUERY;
      const list = {
        media: query,
        // Only the dark query answers. Every other query reports no match,
        // which is the same answer jsdom's silence would have produced and a
        // false positive here would be worse than silence.
        get matches(): boolean {
          return isDarkQuery && prefersDark;
        },
        onchange: null,
        addEventListener: (
          type: string,
          listener: (event: MediaQueryListEvent) => void,
        ): void => {
          if (type === "change" && isDarkQuery) {
            darkQueryListeners.add(listener);
          }
        },
        removeEventListener: (
          type: string,
          listener: (event: MediaQueryListEvent) => void,
        ): void => {
          if (type === "change") {
            darkQueryListeners.delete(listener);
          }
        },
        dispatchEvent: (): boolean => true,
        addListener: (): void => {},
        removeListener: (): void => {},
      };

      return list as unknown as MediaQueryList;
    },
  });
}
