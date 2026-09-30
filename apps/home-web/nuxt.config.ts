// Nuxt 4 configuration for home-web.
//
// The public-facing web application of the Ecoma organisation, running on
// Cloudflare Workers + Workers Assets with hybrid rendering: prerender now,
// ISR for news/blog later, SSR only where genuinely needed.
//
// See docs/adr/0016-home-web-fourth-deployable.md for the architecture.

export default defineNuxtConfig({
  // Nuxt 4 feature set
  future: {
    compatibilityVersion: 4,
  },

  // TypeScript strict mode — matches the repository's bar
  typescript: {
    strict: true,
    typeCheck: "build",
  },

  // Nitro configuration for Cloudflare Workers
  nitro: {
    preset: "cloudflare-module",
    compatibilityDate: "2024-09-19",
    // Route rules for hybrid rendering.
    //
    // The landing page is prerendered per LOCALE, not at `/`. With
    // `strategy: "prefix"` the routes that exist are `/en/` and `/vi/`; `/` is a
    // redirect decided per request from the cookie and the browser's languages,
    // so prerendering it would freeze one language's answer into a static file
    // for every visitor. Each locale's own page is still fully prerendered —
    // the translation is resolved at build time, which is the point of prerendering.
    routeRules: {
      "/en/**": { prerender: true },
      "/vi/**": { prerender: true },
      // These rules reserve a portable Nitro SWR/ISR evolution path. No news
      // or blog pages or content engine exist at scaffold time, and the locale
      // prefix is part of the path, so the patterns carry it too.
      "/en/news/**": { swr: 3600 },
      "/vi/news/**": { swr: 3600 },
      "/en/blog/**": { swr: 3600 },
      "/vi/blog/**": { swr: 3600 },
    },

    // The routeRules above say "anything under /en/ is prerendered"; they do
    // not walk the route tree to find out what is there, so on their own they
    // emit no files. These are the paths that actually exist, and the crawl
    // starts from them. A new localised page must be added here as well as in
    // `pages/`, or it will be served by the Worker on every request instead of
    // from Workers Assets — correct, but paying full SSR latency for a page
    // whose content never changes.
    prerender: {
      crawlLinks: true,
      routes: ["/en", "/vi"],
      failOnError: true,

      // `/` must NOT be prerendered, and this is not a stylistic preference.
      //
      // The crawler reaches `/` (the locale-less root that the i18n module
      // routes to a redirect), and Nitro happily renders it: with no cookie in a
      // build-time request the detection falls through to the default locale, so
      // the crawler captures `<meta http-equiv="refresh" content="0; url=/en">`
      // and writes it to `.output/public/index.html`.
      //
      // Workers Assets serves that file for every request to `/`, so the
      // per-request detection redirect would never run in production: every
      // visitor, including one whose cookie says `vi` and whose browser says
      // `vi`, would be bounced to `/en` by a file the build decided once. The
      // redirect has to be answered by the Worker that can read the cookie.
      ignore: [/^\/$/],
    },
  },

  // App configuration.
  //
  // The title and description are NOT set here. They are translated, and a
  // hardcoded English string in `app.head` would win over anything i18n sets
  // and put an English `<title>` on the Vietnamese page. `useHead` in
  // `app.vue` reads them from the active locale instead, which is also what
  // makes the title correct in a prerendered page rather than only after
  // hydration.
  app: {
    head: {
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
      ],
      // The <html> element's own language attribute. @nuxtjs/i18n overwrites it
      // per request from the active locale; this is the value for the redirect
      // response, where there is no page to carry one.
      htmlAttrs: { lang: "en" },
    },
  },

  // i18n configuration for multi-language support
  modules: ["@nuxtjs/i18n"],

  i18n: {
    // Supported locales
    locales: [
      { code: "en", language: "en", name: "English", file: "en.json" },
      { code: "vi", language: "vi", name: "Tiếng Việt", file: "vi.json" },
    ],
    defaultLocale: "en",
    strategy: "prefix", // URL prefix: /en/, /vi/
    langDir: "locales",

    // Browser language detection.
    //
    // The resolution order — cookie, then browser, then English — is @nuxtjs/i18n's
    // own, and it is the same order `@ecoma-io/shared-i18n` implements for the two
    // Vue apps, so all three frontends answer "what language is this" identically.
    // `shared-i18n` is what makes the *choice* portable: the cookie is written on
    // `.ecoma.io`, so a language picked here is the language `admin.ecoma.io` and
    // `id.ecoma.io` open in.
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: "ecoma_locale", // the shared name; must match shared-i18n
      cookieDomain: ".ecoma.io",
      cookieSecure: true,
      // `cookieCrossOrigin` is deliberately NOT set. It is the wrong tool for this
      // job: it flips the cookie to `SameSite=None; Secure`, which is for reading
      // the cookie inside a cross-origin *iframe*. Sharing across subdomains is a
      // top-level navigation, which `SameSite=Lax` already permits — and Lax is
      // what `@nuxtjs/i18n` writes here, and what `shared-i18n` writes from the
      // Vue apps. Setting it here would have made the home page write a
      // `SameSite=None` cookie the other two apps never read, and the language
      // would silently stop crossing apps in the one direction that matters.
      redirectOn: "root", // `/` redirects to the detected locale's prefix
      fallbackLocale: "en",
      // Only redirect a first-time visitor with no cookie. `alwaysRedirect` stays
      // off so a shared `/en/…` link is not bounced to the visitor's own
      // language underneath the person who sent it.
      alwaysRedirect: false,
    },

    // SEO configuration. The hreflang alternates and the canonical URL are
    // generated per route from this, which is the point of `strategy: "prefix"`:
    // each language is a real, indexable URL rather than a client-side toggle
    // over one document.
    baseUrl: "https://ecoma.io",
  },
});
