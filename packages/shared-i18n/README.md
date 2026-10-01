# @ecoma-io/shared-i18n

Shared i18n utilities for all Ecoma frontend applications.

## Purpose

This package provides:

- **Locale type definitions** — the canonical list of supported languages
- **Browser language detection** — reads `navigator.languages` and normalizes
- **Cross-domain cookie storage** — a single preference shared across all Ecoma
  subdomains (`ecoma.io`, `admin.ecoma.io`, `id.ecoma.io`)

## Supported Locales

| Code | Language   | Default |
| ---- | ---------- | ------- |
| `en` | English    | ✓       |
| `vi` | Tiếng Việt |         |

English is the platform-wide fallback. A visitor whose browser language is not
supported lands in English, and so does a visitor with no cookie and no
recognizable browser language.

## Cookie

| Attribute | Value (production) | Value (development) |
| --------- | ------------------ | ------------------- |
| name      | `ecoma_locale`     | `ecoma_locale`      |
| domain    | `.ecoma.io`        | `localhost`         |
| path      | `/`                | `/`                 |
| sameSite  | `lax`              | `lax`               |
| secure    | `true`             | `false`             |
| maxAge    | 1 year             | 1 year              |

`sameSite: lax` is what allows a cookie written on `ecoma.io` to be read on
`admin.ecoma.io` after a top-level navigation. `strict` would block the read;
`none` would require `secure` and would weaken the CSRF posture for no gain,
since a locale preference is not a credential.

## Usage

```ts
import {
  getEffectiveLocale,
  setLocaleCookie,
  type SupportedLocale,
} from "@ecoma-io/shared-i18n";

// Priority: cookie → browser → default
const locale = getEffectiveLocale();

// Persist an explicit choice
setLocaleCookie("vi", import.meta.env.PROD);
```

`getEffectiveLocale` and `getLocaleFromCookie` take no environment flag:
`document.cookie` reads whatever the current host was sent, so only the write
and the remove need the production domain.

## Architecture

This package is a pure TypeScript library. It depends on nothing internal, no
Rust crate, no Worker binding, and no platform type — it runs identically in the
browser and in a Nitro server context. The boundary row in
`module-boundaries.config.mjs` states that law in archkeep's vocabulary.
