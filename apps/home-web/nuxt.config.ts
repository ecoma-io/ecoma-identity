// Nuxt 4 configuration for home-web.
//
// The public-facing web application of the Ecoma organisation, running on
// Cloudflare Workers + Workers Assets with hybrid rendering: prerender now,
// ISR for news/blog later, SSR only where genuinely needed.
//
// See docs/adr/0016-home-web-fourth-deployable.md for the architecture.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type {
  DetectBrowserLanguageOptions,
  NuxtI18nOptions,
} from "@nuxtjs/i18n";

/**
 * The browser-safe projection of the platform topology.
 *
 * `tooling/scripts/render-wrangler-config.mjs` writes it, by whitelist, to
 * `.generated/frontend/<environment>.json` and copies the environment's file to
 * this one path — so an application never names the environment it is building,
 * only reads what it was given. Its values are owned by `infra-topology`: the
 * cookie namespace by `topology.json`'s `cookie_namespaces`, the locale
 * vocabulary by `frontend-support.json`, the site URL by the resolved
 * `home-web` host.
 *
 * `baseUrl` is a nullable string rather than a required one on purpose. In
 * development the topology resolves no host at all, and `null` is the honest
 * reading of that: there is no canonical URL to emit locally. `strictSeo: false`
 * below is what stops `@nuxtjs/i18n` treating its absence as an error.
 *
 * See docs/architecture/frontend-preferences.md.
 */
interface FrontendConfig {
  readonly environment: string;
  readonly baseUrl: string | null;
  readonly cookie: {
    readonly name: string;
    /** `null` outside production — see the table in that document. */
    readonly domain: string | null;
    readonly secure: boolean;
  };
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: string;
  readonly defaultColorMode: string;
}

/**
 * Read the projection, or fail loudly.
 *
 * There is deliberately NO fallback. A default locale list baked in here would
 * be a fourth copy of a vocabulary `infra-topology/frontend-support.json`
 * already owns, and a default cookie name would be a second copy of the one
 * defect this file exists to remove (#17): a name that exists in no environment
 * and is silently the same name in all four. A missing render must be a failed
 * build, not a plausible-looking site with the wrong cookie — and saying which
 * task produces the file is the difference between a five-second fix and an
 * afternoon.
 *
 * `moon.yml` renders the config inline in every task that reads it, deleting
 * any previous render first, precisely so that this path cannot be reached by
 * accident. It is reachable by exactly one route: running `nuxt` directly.
 */
function readFrontendConfig(): FrontendConfig {
  const configPath = path.resolve(
    __dirname,
    "../../.generated/frontend/config.json",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `home-web: the projected frontend config is missing or unreadable at ` +
        `${configPath} (${cause}).\n` +
        `It is generated, never hand-edited: run \`pnpm exec moon run ` +
        `home-web:dev\` (or any other home-web task, which renders it for ` +
        `you), or \`pnpm infra:render\` to write it by hand. See ` +
        `docs/architecture/frontend-preferences.md.`,
      { cause: error },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `home-web: ${configPath} is not a JSON object. Re-run \`pnpm infra:render\`; ` +
        `the file is written by tooling/scripts/render-wrangler-config.mjs and ` +
        `must not be edited.`,
    );
  }

  const config = parsed as Partial<FrontendConfig>;
  const locales = config.supportedLocales;
  if (
    !Array.isArray(locales) ||
    locales.length === 0 ||
    locales.some((code) => typeof code !== "string" || code.length === 0)
  ) {
    throw new Error(
      `home-web: ${configPath} declares no usable \`supportedLocales\`. Re-run ` +
        `\`pnpm infra:render\`; the vocabulary is owned by ` +
        `infra-topology/frontend-support.json and projected from there.`,
    );
  }
  if (typeof config.cookie?.name !== "string" || config.cookie.name === "") {
    throw new Error(
      `home-web: ${configPath} declares no \`cookie.name\`. Re-run ` +
        `\`pnpm infra:render\`; the cookie namespace is owned by the topology.`,
    );
  }
  if (
    typeof config.defaultLocale !== "string" ||
    !locales.includes(config.defaultLocale)
  ) {
    throw new Error(
      `home-web: ${configPath} declares a \`defaultLocale\` that is not among its ` +
        `\`supportedLocales\`. Re-run \`pnpm infra:render\`; both values come from ` +
        `infra-topology/frontend-support.json.`,
    );
  }

  return config as FrontendConfig;
}

/**
 * How a locale names itself, in its own language.
 *
 * `name` is what a language switcher has to render — "English" beside
 * "Tiếng Việt", never "English" twice — and it is the one field that cannot be
 * derived from the language tag alone without asking something. `Intl` already
 * has the answer, in the CLDR data every runtime ships, so this is a lookup
 * rather than a table maintained here. A locale whose tag CLDR does not know
 * returns the tag itself, which is a worse label and never a wrong claim about
 * what the language is called.
 *
 * The alternative — hardcoding the display names beside the locale codes — is
 * exactly the second copy of the vocabulary that
 * `check-frontend-config.mjs` exists to fail on, one level down.
 */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    // A structurally invalid tag makes `Intl.DisplayNames` throw at
    // construction. The tag came from the projection, so this is a topology
    // defect rather than a visitor's input, and the tag is still a truthful
    // (if unpolished) label — which beats failing the build over a label.
    return code;
  }
}

const frontendConfig = readFrontendConfig();

/**
 * The locales this site has catalogs for, in the order the switcher shows them.
 *
 * `file` names the catalog in `i18n/locales/`, and `@nuxtjs/i18n` resolves
 * `langDir` against `restructureDir` (`<rootDir>/i18n`), which is why the path
 * is just the file name here.
 *
 * ## Why the projection is mapped through a loader rather than used directly
 *
 * `@nuxtjs/i18n` types its own configuration as a literal union of the locale
 * codes — `LocaleObject<"en" | "vi">` — and that union is GENERATED, from the
 * catalog files actually present in `i18n/locales/`. Handing it `string` from
 * the projection does not widen the union; it fails to typecheck (TS2322).
 *
 * {@link loadCatalog} exists to keep the check that produces. A dynamic
 * `import()` over a template literal is a type-level glob: TypeScript resolves
 * it against the files on disk, so the union it infers IS the set of locales
 * this application can actually render. No copy of that set is written here —
 * a hand-written map of locale codes to booleans would be a second owner of the
 * vocabulary, which is precisely what `check-frontend-config.mjs` fails on, and
 * a second owner that silently drifts from the first.
 *
 * That is the mechanism behind "a locale added to the topology must have
 * messages". A site configured with a locale it has no catalog for renders
 * missing keys and looks like it works, which is exactly the failure this
 * repository's status vocabulary forbids. {@link checkLocalesHaveCatalogs}
 * rejects it at config-evaluation time, naming the locale, before Nuxt emits a
 * byte. The Vue apps get the same property from the same trick in their own
 * `plugins/i18n.ts`.
 *
 * The consequence worth stating: the two copies must agree.
 * `frontend-support.json` says which locales the platform supports; the catalog
 * files say which this application can render. Neither is derived from the
 * other, and this check is where the disagreement is caught.
 */
function loadCatalog(code: string): Promise<unknown> {
  // Never called — a type-level glob, and the reason the catalog set needs no
  // second owner. `vue-tsc` resolves the template literal against the catalog
  // files present, so the union it infers for {@link CatalogCode} equals the set
  // of locales this app can actually render. Verified, not assumed: widening
  // the parameter to `string` does NOT widen the inferred union, because the
  // type comes from the matched files rather than from the parameter.
  return import(`./i18n/locales/${code}.json`);
}

/**
 * The locale codes this application has a catalog file for.
 *
 * A TYPE-LEVEL FACT — the union of the `i18n/locales/*.json` files, inferred by
 * {@link loadCatalog}. `check-frontend-config.mjs` forbids writing that union
 * down here as a literal list, and correctly: `frontend-support.json` owns the
 * vocabulary, and a second literal list is the defect the gate exists to catch.
 * Deriving it instead of declaring it is what keeps both true at once.
 *
 * `CatalogCode[]` rather than `CatalogCode`, below: TypeScript would otherwise
 * report the literal union as "possibly undefined" at every use, for an array
 * property it can see is assigned.
 */
type CatalogCodeList = Parameters<typeof loadCatalog>[0] | undefined;
type CatalogCode = Exclude<CatalogCodeList, undefined>;

/**
 * Reject any disagreement between the projection and the catalogs, in both
 * directions, naming the locale either way.
 *
 * Direction one — a projected locale with no catalog — would otherwise surface
 * as a `TS2322` naming an index and a union: accurate, and unreadable six weeks
 * later when a locale was added to the topology and not to this app. A site
 * configured that way renders missing keys and looks like it works, which is
 * precisely the failure this repository's status vocabulary forbids.
 *
 * Direction two — a catalog no projected locale asks for — is an unused
 * translation file. It is a different mistake with the same shape: the
 * application carries a locale the platform does not offer. It is checked here
 * for the same reason the first direction is, and reported separately because
 * the fix is different (delete the file, or add the locale to the topology).
 */
function checkLocalesMatchCatalogs(codes: readonly string[]): CatalogCode[] {
  const missing = codes.filter((code) => !hasCatalogFile(code));
  if (missing.length > 0) {
    throw new Error(
      `home-web: the projected config declares locale(s) ${missing.join(", ")} ` +
        `with no catalog in apps/home-web/i18n/locales/. A locale without a ` +
        `catalog renders missing keys, so this site would claim to speak a ` +
        `language it cannot. Either add ${missing.join(", ")}.json to ` +
        `i18n/locales/, or remove ${missing.join(", ")} from ` +
        `\`supportedLocales\` in infra-topology/frontend-support.json — and ` +
        `decide which of the two is true before picking, because the second ` +
        `changes what every other frontend offers.`,
    );
  }

  const unasked = catalogCodesOnDisk().filter((code) => !codes.includes(code));
  if (unasked.length > 0) {
    throw new Error(
      `home-web: i18n/locales/ holds a catalog for ${unasked.join(", ")}, ` +
        `which infra-topology/frontend-support.json does not list in ` +
        `\`supportedLocales\`. A catalog no configured locale can reach is ` +
        `dead weight that reads as support: either add ${unasked.join(", ")} ` +
        `to the topology, or delete the unused file.`,
    );
  }

  return codes as CatalogCode[];
}

/**
 * Whether a locale code has a catalog file, asked of the filesystem.
 *
 * The alternative — a literal map of codes to `true` — was removed because it is
 * a hand-written copy of the vocabulary, which is the exact defect
 * `check-frontend-config.mjs` exists to fail on, and this file is scanned by
 * that gate. So the answer is derived, not declared.
 *
 * There is no read here, only a name test. `nuxt.config.ts` must be evaluable
 * without depending on the catalogs having been parsed, and a directory listing
 * cannot fail for a reason the message above would not already explain.
 */
function hasCatalogFile(code: string): boolean {
  return existsSync(path.resolve(__dirname, "i18n", "locales", `${code}.json`));
}

/**
 * The locale codes this application has a catalog file for, as the filesystem
 * reports them.
 *
 * The runtime counterpart of the {@link CatalogCode} type. Both are derived from
 * the same directory by different mechanisms — a type-level glob and a
 * directory listing — because nothing here can see both at once, and either one
 * alone would be a list that could drift from the other. `checkLocalesMatchCatalogs`
 * is where the two are compared against each other and against the projection.
 */
function catalogCodesOnDisk(): string[] {
  const dir = path.resolve(__dirname, "i18n", "locales");
  if (!existsSync(dir)) {
    throw new Error(
      `home-web: ${dir} does not exist. The catalogs are the application's own ` +
        `translation files; a site with no directory has no locale it can render.`,
    );
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"));
}

/**
 * The locale objects, typed as whatever `@nuxtjs/i18n` will accept.
 *
 * `checkLocalesMatchCatalogs()` has already proved every code is one the
 * generated union contains, so the annotation is a claim the compiler stops
 * having to re-derive — not an unchecked assertion. Going through the
 * dependency's own option type rather than naming the union is what keeps the
 * literal out of this file: `check-frontend-config.mjs` forbids a locale literal
 * in any scanned source, and a written-out union would be exactly the second
 * owner it fails on.
 */
const locales = checkLocalesMatchCatalogs(frontendConfig.supportedLocales).map(
  (code) => ({
    code,
    language: code,
    name: languageName(code),
    file: `${code}.json`,
  }),
) as NonNullable<NuxtI18nOptions["locales"]>;

/**
 * The projected default locale, proven to be one this app can render.
 *
 * `frontendConfig.defaultLocale` is a `string` — the projection is parsed JSON
 * and validated at runtime — while `@nuxtjs/i18n` wants a member of the catalog
 * union. `readFrontendConfig()` already rejects a default that is not among the
 * supported locales, so by here it is a `CatalogCode`; the assertion says so
 * rather than re-deriving it.
 */
const defaultLocale = frontendConfig.defaultLocale as CatalogCode;

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
      // response, where there is no page to carry one. It is the projected
      // default locale, so the static shell never has to learn a language tag.
      htmlAttrs: { lang: frontendConfig.defaultLocale },
    },
  },

  // i18n configuration for multi-language support
  modules: ["@nuxtjs/i18n"],

  i18n: {
    // Supported locales, read from the projection rather than written here.
    locales,
    defaultLocale: defaultLocale as Exclude<
      NuxtI18nOptions["defaultLocale"],
      undefined
    >,
    strategy: "prefix", // URL prefix: /en/, /vi/
    langDir: "locales",

    // Browser language detection.
    //
    // The resolution order — cookie, then browser, then the default locale — is
    // @nuxtjs/i18n's own, and it is the same order the other two frontends
    // implement, so all three answer "what language is this" identically.
    detectBrowserLanguage: {
      useCookie: true,
      // The cookie's NAME and DOMAIN are the projection's. They used to be
      // hardcoded here and had to be kept in step with a shared package by a
      // comment saying so, which is how issue #17 happened: the comment was the
      // only thing relating the two copies, and a comment is not a constraint.
      // A language picked on the public site is read by the identity apps and
      // vice versa; which string carries that is now the topology's answer, and
      // it differs per environment so a preview cannot write production's.
      cookieKey: frontendConfig.cookie.name,
      // `null` outside production — the projection says so — and the i18n
      // module treats an absent domain as a host-only cookie, which is exactly
      // what a preview and staging must be. See
      // docs/architecture/frontend-preferences.md for the four rows. The key is
      // spread rather than assigned `undefined` because this file is compiled
      // under `exactOptionalPropertyTypes`, where an explicit `undefined` is not
      // the same as an absent key.
      ...(frontendConfig.cookie.domain
        ? { cookieDomain: frontendConfig.cookie.domain }
        : {}),
      cookieSecure: frontendConfig.cookie.secure,
      // `cookieCrossOrigin` is deliberately NOT set. It is the wrong tool for this
      // job: it flips the cookie to `SameSite=None; Secure`, which is for reading
      // the cookie inside a cross-origin *iframe*. Sharing across subdomains is a
      // top-level navigation, which `SameSite=Lax` already permits — and Lax is
      // what @nuxtjs/i18n writes here, and what the Vue apps write. Setting it
      // here would have made the home page write a `SameSite=None` cookie the
      // other two apps never read, and the language would silently stop crossing
      // apps in the one direction that matters.
      redirectOn: "root", // `/` redirects to the detected locale's prefix
      // Same source as `defaultLocale`: an unrecognised cookie or `Accept-Language`
      // falls back to the platform default rather than to a tag written here.
      fallbackLocale: defaultLocale as Exclude<
        DetectBrowserLanguageOptions["fallbackLocale"],
        undefined
      >,
      // Only redirect a first-time visitor with no cookie. `alwaysRedirect` stays
      // off so a shared `/en/…` link is not bounced to the visitor's own
      // language underneath the person who sent it.
      alwaysRedirect: false,
      // The `satisfies` is load-bearing, and its reason is specific enough to
      // be worth stating.
      //
      // Spreading `cookieDomain` conditionally above makes this object literal's
      // inferred type a WIDENED one: TypeScript gives an object containing a
      // spread a common supertype, so `redirectOn: "root"` widens to `string`
      // and stops matching `RedirectOnOptions`. The error it produces names the
      // whole object and not the property, which is why it reads as a mystery.
      //
      // `satisfies` re-checks this literal against its own option type, so the
      // literal is preserved and the comparison still happens — no cast, and no
      // change to any value at runtime.
    } satisfies DetectBrowserLanguageOptions,

    // SEO configuration. The hreflang alternates and the canonical URL are
    // generated per route from this, which is the point of `strategy: "prefix"`:
    // each language is a real, indexable URL rather than a client-side toggle
    // over one document.
    //
    // The URL is the projected `home-web` host, so a staging build cannot emit
    // production's canonicals — the defect a hardcoded apex guaranteed the
    // moment a second environment existed. This is the whole of the
    // environment-sensitivity of this site's SEO: there is no
    // `import.meta.env.PROD` test anywhere near it, because `PROD` is a build
    // mode rather than an environment and is equally true of the staging
    // artefact.
    //
    // Spread rather than assigned `undefined` for the same
    // `exactOptionalPropertyTypes` reason as `cookieDomain` above: in
    // development the topology resolves no host, so the projection says `null`
    // and the honest thing to hand `@nuxtjs/i18n` is no `baseUrl` key at all.
    // The option is optional in v10 and @nuxtjs/i18n emits no canonical or
    // hreflang at all without one, which is the correct local answer — there is
    // no origin to canonicalise against. (An earlier draft of this comment
    // described a `strictSeo` option that suppresses the resulting warning; no
    // such option exists in v10, and the warning is left to stand rather than
    // silenced by a flag that was never checked.)
    ...(frontendConfig.baseUrl ? { baseUrl: frontendConfig.baseUrl } : {}),
  },
});
