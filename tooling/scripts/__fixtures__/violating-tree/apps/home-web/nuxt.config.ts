// Fixture: home-web nuxt config for canary testing
// This file intentionally violates ADR-0016 for architecture guard testing
export default defineNuxtConfig({
  future: {
    compatibilityVersion: 4,
  },
  nitro: {
    preset: "cloudflare-module",
  },
});
