<!--
  The site chrome: header, navigation, locale switcher, footer.

  ## The language links, and why they are real URLs

  Each option is a `SwitchLocalePathLink` to the SAME page in the other
  language, so switching does not navigate the visitor somewhere they did not
  ask to go. It is a link rather than a button that calls `setLocale()` because
  of the cookie: `SwitchLocalePathLink` is what actually writes
  `ecoma_locale`, and `setLocale()` changes the rendered language without
  persisting the choice — which would mean the language resets on the next
  visit and never reaches the other two apps.

  A `<select>` was the other option and was rejected: with real URLs, the
  language is a link a visitor can middle-click, copy, or send to someone else,
  and a `/vi/` page is a page rather than a client-side rendering mode. The
  trade-off is a wider header, which is why the switcher is a compact list
  rather than a styled control.

  ## The label in each language's own name

  "English" and "Tiếng Việt" are written in their own language whatever the
  current one is. A reader who cannot read the page's current language still has
  to be able to find theirs, and a switcher labelled "EN / VI" defeats exactly
  the reader it exists for.
-->
<script setup lang="ts">
const { t, locale, locales } = useI18n();

// The current year, computed once per render rather than baked into the locale
// file, so the copyright line does not need a copy change every January.
const year = new Date().getFullYear();
</script>

<template>
  <div class="layout">
    <header class="header">
      <!--
        The logo links to the locale's own root, not to `/`. Linking to `/`
        would send the visitor through the detection redirect on every click —
        correct, but a visible extra hop on a link that looks like a plain
        homepage link.
      -->
      <NuxtLink :to="`/${locale}`" class="logo">Ecoma</NuxtLink>

      <nav class="nav">
        <a href="#features">{{ t("nav.features") }}</a>
        <a href="https://github.com/ecoma-io" rel="noopener">
          {{ t("nav.github") }}
        </a>

        <span class="locale-switcher">
          <span class="visually-hidden">{{ t("nav.language") }}</span>
          <SwitchLocalePathLink
            v-for="l in locales"
            :key="l.code"
            :locale="l.code"
            class="locale-option"
            :class="{ active: l.code === locale }"
            :aria-current="l.code === locale ? 'true' : undefined"
          >
            <!-- Each language named in itself, never in the current one. -->
            {{ l.code === "vi" ? "Tiếng Việt" : "English" }}
          </SwitchLocalePathLink>
        </span>
      </nav>
    </header>

    <main class="main">
      <slot />
    </main>

    <footer class="footer">
      <p>{{ t("footer.copyright", { year }) }} {{ t("footer.tagline") }}</p>
    </footer>
  </div>
</template>

<style scoped>
.layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  border-bottom: 1px solid #e5e7eb;
}

.logo {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
  text-decoration: none;
}

.nav {
  display: flex;
  gap: 1.5rem;
  align-items: center;
}

.nav a {
  color: #6b7280;
  text-decoration: none;
}

.nav a:hover {
  color: #111827;
}

/*
  The switcher is a list of links, not a control, so it is marked up as one.
  The `active` class is a visual affordance only — `aria-current` is what
  actually tells a screen reader which language the page is in, and a bold
  border alone does not.
*/
.locale-switcher {
  display: flex;
  gap: 0.5rem;
  padding-left: 1.5rem;
  border-left: 1px solid #e5e7eb;
}

.locale-option {
  font-size: 0.875rem;
}

.locale-option.active {
  color: #111827;
  font-weight: 600;
}

/*
  Visually hidden but present for assistive technology. The switcher needs a
  label, and an `aria-label` alone leaves a screen-reader user with two
  unlabelled links whose text differs only in a language they may not read.
*/
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.main {
  flex: 1;
}

.footer {
  padding: 1rem 2rem;
  border-top: 1px solid #e5e7eb;
  text-align: center;
  color: #6b7280;
  font-size: 0.875rem;
}
</style>
