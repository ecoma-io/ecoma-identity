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
    // Route rules for hybrid rendering
    routeRules: {
      // Landing page: prerender at build time
      "/": { prerender: true },
      // These rules reserve a portable Nitro SWR/ISR evolution path. No news
      // or blog pages or content engine exist at scaffold time.
      "/news/**": { swr: 3600 },
      "/blog/**": { swr: 3600 },
    },
  },

  // App configuration
  app: {
    head: {
      title: "Ecoma",
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          name: "description",
          content:
            "Ecoma — fair-code labor OS. Humans, AI agents and rules/code as one kind of labor resource.",
        },
      ],
    },
  },

  // Minimal modules — no Tailwind, no UI framework, no analytics at scaffold time
  modules: [],
});
