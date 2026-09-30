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

export {};
