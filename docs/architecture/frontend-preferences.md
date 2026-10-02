# Frontend preferences

What this document is: the preference model the three frontends share, the
resolution order they follow, and — the part that actually matters — **who owns
each value a preference is made of**.

What this document is **not**: a description of backend persistence. There is
none. Preferences live in a cookie and in `localStorage` in the visitor's own
browser, and that is the whole of what exists today. See
[Status](#status) for the vocabulary.

## The invariant

**A shared frontend package owns preference _mechanics_, not translation
catalogs and not business or user data.**

The package — `packages/frontend-preferences`, published to the workspace as
`@ecoma-io/frontend-preferences` — may own:

- the locale **vocabulary** (which locales exist, which is the default), read
  from the projection described below rather than restated;
- the cookie mechanics (read, write, delete) as a policy, not a hardcoded name;
- colour-mode resolution (a stored choice, or the operating system's);
- display-timezone detection and validation;
- the `RemotePreferenceAdapter` **seam**, which is declared and not implemented.

It may **not** own:

- translation message catalogs — a catalog is an application's content, and two
  applications may legitimately translate the same word differently;
- a session, an account, an application registry, or any business state;
- the business/account/reporting timezone, which is a fact about an organisation
  and not about the device in front of it;
- anything platform-shaped — no `worker` types, no D1, no Cloudflare.

A module that fails the second list is not a preference package any more, and
`module-boundaries.config.mjs` is what says so.

## What a preference is

```ts
interface FrontendPreferences {
  locale: SupportedLocale;
  timeZone: string; // IANA identifier
  colorMode: ColorMode; // "system" | "light" | "dark"
}
```

Three questions, three owners, no overlap.

| Preference       | Owner                                                                           | Persisted?             |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------- |
| Locale           | `infra-topology/frontend-support.json` → projection → package                   | Yes — cookie, one year |
| Colour mode      | `infra-topology/frontend-support.json` (the **default**) → projection → package | Yes — cookie, one year |
| Display timezone | **Detected per session. Never persisted.**                                      | No                     |

### Why the timezone is not persisted

The locale cookie has a one-year max-age. Persisting a timezone next to it would
mean a traveller's zone goes stale for a year, and the symptom — a calendar
rendering in the zone a visitor left three months ago — is indistinguishable
from a bug in the calendar. Display timezone is a **per-request rendering
decision**, re-detected on every load.

### Display timezone is not the business timezone

These are three different facts and conflating them is the most likely way to
build a reporting bug:

- **Display timezone** — the zone a date is rendered in for this visitor, right
  now. Detected in the browser. This document's subject.
- **Account/business timezone** — the zone an organisation's day starts in. A
  fact about an account. Backend state, owned by the account's own service.
- **Reporting timezone** — the zone a period is cut on. An operations decision.

Backend timestamps stay in UTC — epoch milliseconds, per
`database/identity/migrations/0001_schema_migrations.sql`. Nothing in this
document changes that, and nothing in this document is read by the backend.

## The projection, and why the values have one owner each

Three frontends must answer the same questions with the same values. A language
chosen on one is read on the next; a cookie that means different things in two
applications is not a shared preference. So each value has exactly one owner and
no other file is allowed to restate it:

| Value                              | Sole owner                                           | Reaches the browser by                                         |
| ---------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Cookie **name** (per environment)  | `infra-topology/topology.json` → `cookie_namespaces` | projection → `config.cookie.name`                              |
| Cookie **domain** and **`secure`** | `infra-topology/topology.json`                       | projection → `config.cookie`                                   |
| **Locales** and **default locale** | `infra-topology/frontend-support.json`               | projection → `config.supportedLocales`, `config.defaultLocale` |
| **Default colour mode**            | `infra-topology/frontend-support.json`               | projection → `config.defaultColorMode`                         |
| **Site base URL**                  | `infra-topology/topology.json` → the `home-web` host | projection → `config.baseUrl`                                  |
| `FRONTEND_ENVIRONMENT`             | the build                                            | which projection is rendered                                   |

`tooling/scripts/render-wrangler-config.mjs` projects those into
`.generated/frontend/<environment>.json`, writes `.generated/frontend/config.json`
as the copy every application imports, and copies the vocabulary into
`packages/frontend-preferences/frontend-support.json` so a test with no rendered
config present still has one owner to read.

The projection is built **by whitelist**, not by deleting keys from the
deployment descriptor. That distinction is the whole security argument: a field
added to the descriptor later cannot reach a browser bundle by being forgotten
in a deletion list. `render-frontend-config.test.mjs` asserts, for all four
environments, that the emitted JSON carries no account id, no D1/KV/queue name,
no email service name and no worker name.

### The four projections, verbatim

Cookie name and site URL differ per environment. `domain` is `null` outside
production because a preview that wrote the zone cookie would share a cookie
with production — which is exactly the sharing the per-environment name exists
to prevent.

| Environment   | Cookie name           | `cookie.domain` | `cookie.secure` | `baseUrl`                      |
| ------------- | --------------------- | --------------- | --------------- | ------------------------------ |
| `production`  | `ecoma_prod_locale`   | `ecoma.io`      | `true`          | `https://ecoma.io`             |
| `staging`     | `ecoma_stg_locale`    | `null`          | `true`          | `https://stg-home.ecoma.io`    |
| `preview`     | `ecoma_pr{pr}_locale` | `null`          | `true`          | `https://pr{pr}-home.ecoma.io` |
| `development` | `ecoma_dev_locale`    | `null`          | `false`         | `null`                         |

Two things in that table are deliberate and were argued:

- **`domain` is `ecoma.io` without a leading dot.** The source hardcoded
  `".ecoma.io"`. Browsers strip a leading dot, and a domain cookie without one
  still covers subdomains, so **semantics are unchanged** — but it is a real
  diff and it is stated here rather than discovered in review.
- **`baseUrl` is `null` in development** and a preview's `baseUrl` is a real
  per-PR host. A preview that emitted `https://ecoma.io` canonicals would be a
  duplicate-content bug: the preview would be indexed under production's URL.
  Because `baseUrl` is derived from the topology rather than written down, that
  cannot happen for a staging or preview build without the topology changing.

`{pr}` is a template, not a value. The renderer substitutes the PR number when
one is supplied (`--pr 123`) and refuses to render `preview` without one, because
a hostname containing a literal `{pr}` is a real name for a real account.

### What happens when the config is missing

Nothing sensible, and the build says so. `packages/frontend-preferences/src/config.ts`
holds **types and a reader and no fallback values** — a fallback locale list
would be a fourth copy of the vocabulary, and the point of the projection is
that there is one. A build or boot that cannot find the config throws a named
error pointing at `pnpm infra:render` / `moon run home-web:dev`.

This is why each task that reads the config renders it **inline, in the same
task**, immediately before reading it. It deliberately does **not** delete a
previous render first. `set -eu` plus the renderer's non-zero exit on every
failure path means a failed render stops the task before the command that reads
the config is reached, so there is no stale success to prevent — while the file
is shared by four projects, and under `moon ci`, which runs projects
concurrently, one task's `rm` failed an unrelated one with `TS2307`. If you add a
delete here, you have deleted another project's input.

What makes `FRONTEND_ENVIRONMENT` load-bearing instead is that it is exported by
the thing that builds a deployable: `deploy-worker.yml` sets it from
`inputs.environment`. Unset, every deploy built the `development` projection —
measured: cookie `ecoma_dev_locale`, `secure: false`, `baseUrl: null`, which is
a staging deploy publishing no canonical URL at all.

## Resolution order

A preference is resolved in this order, and the order is the reason the same
visitor sees the same language on two different applications:

1. **An authenticated server-side preference.** **DEFERRED.** There is no
   endpoint, and nothing in this document claims otherwise.
2. **The stored cookie.** Written by whichever application the visitor last
   chose on. This is what makes the preference shared rather than per-app.
3. **Browser detection** — `navigator.languages` for locale, `matchMedia` for
   colour mode. Only consulted when there is no cookie.
4. **The platform default**, from the projection.

Anything read from a cookie or from the browser is **untrusted input**. A cookie
value is validated through `isSupportedLocale()` and falls through to the next
step when it is not one of the supported locales; no code path type-casts an
arbitrary string into a preference. `normalizeLocale()` reduces a region-tagged
tag to the base language when that language is supported (`vi-VN` → `vi`,
`en-US` → `en`) and otherwise declines it, so `fr-FR` does not become a locale
whose catalog does not exist — it falls to the default. That is the mechanism by
which a locale with no catalog cannot render missing keys.

## Colour mode

Three states, `system` / `light` / `dark`, resolved in that same order: cookie,
then `prefers-color-scheme` when the choice is `system`, then the projected
default.

**The no-flash mechanism.** An anonymous visitor whose OS is in dark mode must
not see a white page first. `apps/*/web/index.html` carries a **blocking inline
script in `<head>`** that reads the cookie and sets `data-color-mode` on `<html>`
before the first paint. `src/styles/tokens.css` keys its tokens off that
attribute. Without the inline script the attribute is set after the first paint,
which is a flash — the entire problem this mechanism exists to solve.

`home-web` has **no colour mode**. It has no token system at all: every colour
in it is a hardcoded hex in a scoped `<style>`. A toggle there would change
nothing, and a control that changes nothing is a defect rather than a
placeholder. **DEFERRED.**

## Status

Using `docs/README.md`'s vocabulary.

| Thing                                                                   | Status        | Note                                                        |
| ----------------------------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| Locale resolution and the per-environment cookie namespace              | `IMPLEMENTED` | #17                                                         |
| Colour mode on `apps/identity/web` and `apps/identity-admin/web`        | `IMPLEMENTED` | #32                                                         |
| Display timezone detection                                              | `IMPLEMENTED` | Never persisted                                             |
| Topology → frontend projection, and the single-owner gate               | `IMPLEMENTED` | #31, #32                                                    |
| `home-web` reading its locale, cookie and `baseUrl` from the projection | `IMPLEMENTED` |                                                             |
| Authenticated, server-side preference persistence                       | `DEFERRED`    | No endpoint, no schema, no store                            |
| `RemotePreferenceAdapter`                                               | `DEFERRED`    | **Declared, not implemented.** Calls nothing, mocks nothing |
| Colour mode on `home-web`                                               | `DEFERRED`    | No token system to switch                                   |
| A `zh` locale                                                           | Not supported | A cross-repository gap, not a missing catalog — see below   |

`RemotePreferenceAdapter` is the seam a future authenticated store would
implement. It is a type and a comment. **There is no preference endpoint in this
repository**, no table for one, and no Rust type for one; the `UserPreferences`
shape the backend would eventually need is not in `identity-domain`, and adding
it is explicitly out of scope for the frontend work.

### The `zh` gap, recorded rather than closed

`~/ecoma-io/ecoma/languages.config.json` declares a third language that no
catalog in this repository implements. This repository's vocabulary is `en` and
`vi` and adding `zh` here would ship a locale that renders missing keys. The gap
is real and it belongs to the ecoma repository, not here. Adding a locale to
this repository means adding it to `infra-topology/frontend-support.json`
**first**, then a catalog in each application claiming to support it — the
reverse order ships the broken locale.

## Enforcement

- **`tooling/scripts/check-frontend-config.mjs`** — the coherence gate. Fails on
  a frontend source that hardcodes a cookie name, the zone apex, a canonical URL,
  a colour-mode **default** or a locale literal. It also compares the package's
  generated copy of the vocabulary against its source and fails on drift.
  Wired into `ci.yml`'s `checks` job, so it runs on every pull request.
  It deliberately scans **comments** for cookie names and **code only** for
  locales: prose about a locale is legitimate, and a comment that hardcodes a
  cookie name is precisely the defect #17 reports.

  The colour-mode rule is the one that needs its reasoning stated, because the
  obvious version of it is wrong. `"system"` cannot simply be forbidden: it is
  a **member of the `ColorMode` union**, so `if (mode === "system")` and
  `["system", "light", "dark"]` are how that type is written rather than a
  second owner of a fact, and both appear in `useColorMode.ts`. The gate
  therefore draws the line between **consuming** a colour-mode literal and
  **producing** one. A comparison (`===`, `!==`) or a `case` label consumes it,
  because those are the union's discriminants; so does an array member, because
  the three modes are what a visitor may _offer_, which stays three whichever
  way the platform default is set. Every other position — an initialiser, a
  returned value, a class field, an object property, an argument — is an
  application supplying the platform's answer, and that is forbidden. `export
const mode = "system"` fails; `export const mode = cfg.defaultColorMode`
  passes; `mode === "system"` passes.

  Both directions are tested, because a rule narrowed too far fails by _passing_
  rather than by erroring: `check-frontend-config.test.mjs` asserts the gate
  still catches an initialiser, a parameter default, a nested property, a class
  field and a returned value, and separately that it accepts the four shapes in
  the tree today.

- **`module-boundaries.config.mjs`** — a row per frontend application, each
  permitted to depend on `frontend-preferences` and nothing else among the
  frontends. The package may not depend on an application.
- **`tooling/scripts/render-frontend-config.test.mjs`** — asserts the projection
  is secret-free across all four environments, that the four cookie names are
  distinct, that `baseUrl` is always the `home-web` host, and that staging and
  preview never emit the production apex.

## Related

- [ADR-0017 — The topology owns the frontend's cookie namespace, and the
  frontend reads a projection of it](../adr/0017-frontend-preferences-ownership.md)
- [overview.md](overview.md) — the four-deployable topology.
- `infra-topology/topology.json` — `cookie_namespaces`, hosts, `account.zone`.
- `infra-topology/frontend-support.json` — the locale and colour-mode vocabulary.
