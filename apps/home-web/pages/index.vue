<!--
  The public landing page.

  Every user-visible string comes from the locale files. Nothing here is
  hardcoded English, because this page is prerendered once per locale and the
  only way a `/vi/` build can contain Vietnamese is if the copy is in `vi.json`.

  The claims this page makes are deliberately the same claims the repository's
  `docs/README.md` makes — the platform is at bootstrap — and they are written in
  the copy rather than asserted by the components, so a translation is a copy
  change and not a code change.
-->
<script setup lang="ts">
const { t } = useI18n();

// Feature and repository entries are content, not chrome: they belong in the
// locale files with the rest of the words. They are declared here as the
// message KEYS so a missing key is visible at a glance in the template, and the
// strings themselves come from the active locale.
const featureKeys = [
  "features.unifiedModel.title",
  "features.unifiedModel.body",
  "features.graphLoop.title",
  "features.graphLoop.body",
  "features.fairCode.title",
  "features.fairCode.body",
] as const;

const repoKeys = [
  "repos.ecoma",
  "repos.runtimeTrail",
  "repos.loom",
  "repos.archkeep",
] as const;
</script>

<template>
  <div class="home">
    <section class="hero">
      <h1 class="title">Ecoma</h1>
      <p class="tagline">{{ t("hero.title") }}</p>
      <p class="description">{{ t("hero.subtitle") }}</p>
      <div class="actions">
        <a href="https://github.com/ecoma-io" class="button primary">
          {{ t("hero.cta.primary") }}
        </a>
      </div>
    </section>

    <section id="features" class="features">
      <h2>{{ t("features.heading") }}</h2>
      <p class="status-note">
        <strong>{{ t("common.statusLabel") }}:</strong>
        {{ t("common.statusBody") }}
      </p>
      <ul class="feature-list">
        <li v-for="key in featureKeys" :key="key">
          <strong>{{ t(`${key}.title`) }}.</strong>
          {{ t(`${key}.body`) }}
        </li>
      </ul>
    </section>

    <section class="links">
      <h2>{{ t("repos.heading") }}</h2>
      <ul class="repo-list">
        <li v-for="key in repoKeys" :key="key">
          <a href="https://github.com/ecoma-io" rel="noopener">
            {{ t(`${key}.name`) }}
          </a>
          — {{ t(`${key}.body`) }}
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem;
}

.hero {
  text-align: center;
  padding: 4rem 0;
  border-bottom: 1px solid #e5e7eb;
}

.title {
  font-size: 3rem;
  font-weight: 800;
  color: #111827;
  margin: 0 0 0.5rem;
}

.tagline {
  font-size: 1.5rem;
  color: #6b7280;
  margin: 0 0 1rem;
}

.description {
  font-size: 1.125rem;
  color: #374151;
  max-width: 32rem;
  margin: 0 auto 2rem;
}

.actions {
  display: flex;
  justify-content: center;
  gap: 1rem;
}

.button {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  border-radius: 0.375rem;
  text-decoration: none;
  font-weight: 500;
}

.button.primary {
  background: #111827;
  color: #fff;
}

.button.primary:hover {
  background: #374151;
}

.features,
.links {
  padding: 3rem 0;
  border-bottom: 1px solid #e5e7eb;
}

.features h2,
.links h2 {
  font-size: 1.5rem;
  color: #111827;
  margin: 0 0 1rem;
}

.status-note {
  padding: 1rem;
  background: #fef3c7;
  border-radius: 0.375rem;
  margin-bottom: 1.5rem;
  color: #92400e;
}

.feature-list,
.repo-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.feature-list li,
.repo-list li {
  color: #374151;
}

.repo-list a {
  color: #2563eb;
  text-decoration: none;
}

.repo-list a:hover {
  text-decoration: underline;
}
</style>
