<!--
  The translated document head.

  `title` and the description are read from the active locale rather than set in
  `nuxt.config.ts`. That is what makes a prerendered page correct: `useHead` runs
  on the server during prerender, so `/vi/` ships a Vietnamese `<title>` in its
  static HTML. A title set in `app.head` would be a constant in every locale's
  output, and the Vietnamese page would be indexed under an English title.

  `htmlAttrs.lang` is set here too, rather than left to i18n alone, because it is
  the attribute a screen reader announces and a browser's translation prompt keys
  off — and the value has to be right in the static HTML, not only after
  hydration.
-->
<script setup lang="ts">
const { t, locale } = useI18n();

// `locale` is a dependency so the head recomputes when the language changes.
// Without it the title would be computed once at the default locale and a
// client-side switch would leave the tab title in the old language.
useHead({
  title: () => t("meta.title"),
  htmlAttrs: { lang: () => locale.value },
  meta: [{ name: "description", content: () => t("meta.description") }],
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
