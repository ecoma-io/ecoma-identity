// Browser APIs jsdom does not implement that this app's tests touch.
//
// Nothing yet, and the file is empty on purpose rather than absent: it is the
// documented place to add a stub, and the rule is that each entry must name the
// thing that needs it. A general-purpose polyfill bundle would be the wrong
// tool in an operator console — it would add a dependency to make a test
// environment look like a browser, and in this app the browser is where the
// administrative session cookie lives, so the difference between a real browser
// and a stub is exactly where the security-relevant behaviour is.
//
// Nothing here stubs `fetch`. The API tests replace `globalThis.fetch` with
// their own function, because the point of those tests is to assert what this
// app does with a response — including the 501 the Admin Worker returns on every
// administrative route.

export {};
