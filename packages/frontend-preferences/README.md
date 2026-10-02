# @ecoma-io/frontend-preferences

Preference **mechanics** for every Ecoma frontend application: locale detection
and normalisation, colour mode, display time zone, the cookie policy, and the
order those answers are resolved in.

## The invariant

**A shared frontend package owns preference mechanics, not translation catalogs
and not business or user data.**

Three things follow from it, and each is a boundary someone will eventually
want to cross:

| This package may own                                                 | This package may not own                               |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| The **locale vocabulary** — read from the projection, never restated | Message files, translations, plurals, formatting rules |
| Detection, validation and normalisation of a preference              | Accounts, sessions, entitlements, roles                |
| The **cookie policy** for the environment it is deployed to          | Business, reporting or entity time zones               |
| The resolution order between sources of a preference                 | Marketplace state, cloud resources, any backend fact   |

The right-hand column is not a backlog. A locale in this package is a _code_; the
sentence a reader sees when it is missing belongs to the app that renders it,
which is why adding a language is one edit in
`infra-topology/frontend-support.json` plus a message file in each application
that claims to support it. Adding the language here without the files ships a
visitor raw message keys — the failure a third locale would produce today.

## Where the values come from

None of them are written here.

`tooling/scripts/render-wrangler-config.mjs` projects
`infra-topology/topology.json` and `infra-topology/frontend-support.json` into
`.generated/frontend/<environment>.json`, and this package reads
`.generated/frontend/config.json` — one path, for all three frontends, with no
per-app environment switch.

| Value                               | Owner                                  | Why it is not a constant here                                       |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Cookie name                         | `topology.json` → `cookie_namespaces`  | It differs per environment; a literal in this package was issue #17 |
| Cookie domain, `Secure`             | the topology's account and environment | `null` outside production is a deliberate value, not a default      |
| `supportedLocales`, `defaultLocale` | `frontend-support.json`                | A list here would be a second owner the coherence gate cannot see   |
| `defaultColorMode`                  | `frontend-support.json`                | Same reason                                                         |

`src/config.ts` holds the types and the reader and **no fallback values**. A
missing configuration throws `MissingFrontendConfigError` naming the render
command, because a fallback only ever fires when something is already broken —
which would turn an early, obviously-caused build failure into a quiet
disagreement with the platform at runtime.

The one exception is stated rather than hidden: `frontend-support.json` at this
package's root is a **generated copy** of the vocabulary, so that a unit test and
a type-level import resolve without a build. The renderer writes it and refuses
to write when the two files disagree, and `tooling/scripts/check-frontend-config.mjs`
fails the build when they have drifted — so the duplication is _produced_, never
maintained.

## Supported locales

Read from the projection, not declared. At the time of writing:

| Code | Language   | Default |
| ---- | ---------- | ------- |
| `en` | English    | ✓       |
| `vi` | Tiếng Việt |         |

A visitor whose browser language is not supported lands in the configured
default, and so does a visitor with no cookie and no recognisable browser
language.

## Cookies

One cookie, one policy, projected per environment:

|          | production          | staging            | preview               | development        |
| -------- | ------------------- | ------------------ | --------------------- | ------------------ |
| name     | `ecoma_prod_locale` | `ecoma_stg_locale` | `ecoma_pr{pr}_locale` | `ecoma_dev_locale` |
| domain   | `ecoma.io`          | _host-only_        | _host-only_           | _host-only_        |
| secure   | yes                 | yes                | yes                   | no                 |
| path     | `/`                 | `/`                | `/`                   | `/`                |
| sameSite | `lax`               | `lax`              | `lax`                 | `lax`              |
| maxAge   | 1 year              | 1 year             | 1 year                | 1 year             |

`domain: null` means **no `Domain` attribute**, which is the correct value
everywhere except production: a preview writing a zone-scoped cookie is the exact
sharing the per-environment _name_ exists to prevent.

`SameSite=Lax` is what allows a cookie written on one subdomain to be read on
another after a top-level navigation. `strict` would block the read; `none` would
require `secure` and would weaken the CSRF posture for no gain, since a locale
preference is not a credential.

**Deletion uses the identical policy the creation used.** `removeLocaleCookie`
takes the same `CookiePolicy` object as `setLocaleCookie`, and deriving the
attributes from that one object is the whole reason it is a parameter: a deletion
under a different `Domain` does not remove the original, it writes a host-only
cookie beside it, and the preference appears to survive being cleared.

## Time zone is detected, never stored

`detectTimeZone()` runs per session and nothing persists it. The preference
cookie lasts a year, and a traveller's zone would therefore be wrong for a year
— silently, because every timestamp still renders. Off by six hours is a
plausible-looking wrong answer, which is the worst kind.

This is the _display_ zone. An account's or entity's timezone is a fact about
that entity, owned by the system that stores it, and it is not derivable from the
browser of whoever happens to be reading the screen.

Validation builds an `Intl.DateTimeFormat` in a `try`/`catch`. It does **not**
consult `Intl.supportedValuesOf("timeZone")`, which returns canonical
identifiers only and omits the legacy aliases (`US/Pacific`, `Asia/Calcutta`)
that `resolvedOptions()` legitimately reports — a lookup would silently degrade
exactly those users to UTC.

## Colour mode

`system | light | dark`, stored as a cookie and applied as `data-color-mode` on
`<html>`, because an attribute on the document element is the only thing a
blocking inline script in `<head>` can set before first paint. `system` is a
_stored_ choice, not the absence of one: it is the only value that can be
answered correctly on a later visit without asking the visitor again, and it is
resolved at the moment the attribute is applied so a page follows its reader to
dark at sunset.

## Usage

```ts
import { LocalPreferenceStore } from "@ecoma-io/frontend-preferences";

const store = new LocalPreferenceStore();

// Which language? cookie → browser → the platform default. Reads nothing else.
store.read().locale.value;

// Apply the stored colour mode. Do this before first paint.
store.applyColorModeTo();

// Remember an explicit choice, so it follows the visitor to the other apps.
store.setLocale("vi");
store.setColorMode("dark");
```

Individual pieces are exported too, for an app that has its own bootstrap —
`applyColorMode`, `readColorMode`, `detectTimeZone`, `getEffectiveLocale`,
`isSupportedLocale`, `normalizeLocale`.

## Deferred

Named here because `AGENTS.md` requires unimplemented behaviour to read as
unimplemented rather than as absent:

- **`RemotePreferenceAdapter`** — declared in `src/preferences.ts`, implemented
  by nothing. There is no endpoint, no `fetch`, and no mock response anywhere in
  this package. Server-side preference persistence is backend work with its own
  ADR: a stored preference is data about an account, and this repository's
  identity plane decides _who someone is_, not what their account looks like.
- **Colour mode on home-web** — that application has no token system, so a
  toggle there would change nothing. A control that cannot change anything is a
  defect, not a placeholder.
- **Translation catalogs** — owned by each application, permanently.

## Architecture

This package is a pure TypeScript library. It depends on nothing internal, no
Rust crate, no Worker binding, and no platform type — it runs identically in the
browser and in a Nitro server context, which the home page's prerender needs and
which is why every DOM touch is guarded rather than assumed. The boundary row in
`module-boundaries.config.mjs` states that law in archkeep's vocabulary, and it
is `private: true` and absent from `release.config.json` by design: four
deployables ship, and this is not one of them (ADR-0012, ADR-0015).
