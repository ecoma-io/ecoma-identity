<!--
  The application shell.

  What it is: the chrome around every screen — the skip link, the navigation, and
  the router outlet.

  What it is not: a place where a global banner claims the product works. The
  navigation marks each screen with its real availability, read from the
  capability inventory, so a user can tell from the menu alone which parts of
  their account exist. That is the same single-source discipline as the screens
  themselves: the menu derives its badges from `capabilities.ts` and holds no
  list of its own.

  Accessibility choices here, rather than left to each screen:
  - A skip link as the first focusable element, so a keyboard user can reach the
    main content without tabbing the whole navigation on every page.
  - `<nav>` with an accessible name, because there is more than one navigation
    landmark once a page grows a breadcrumb or a footer nav.
  - The active link marked with `aria-current="page"` rather than colour alone.
    Colour is not an accessible channel, and a menu that only shows where you
    are by tinting one entry is a menu a screen-reader user cannot navigate.
  - Every nav entry is a real `<a>` rendered by `RouterLink`, so it is
    focusable, middle-clickable, and openable in a new tab. A click handler on a
    `<div>` is none of those.
-->
<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView } from "vue-router";

import {
  CAPABILITIES,
  isImplemented,
  phasePhrase,
  type Capability,
} from "./capabilities";

/**
 * The screens in the menu, derived from the inventory.
 *
 * `menuFeatureIds` names the capability each link is for, rather than hard-coding
 * a label here: the label is user-facing copy that belongs in one place, and
 * having it in two places is how a menu ends up calling the same screen two
 * different things.
 */
const menuFeatureIds: readonly string[] = [
  "sign-in",
  "sign-up",
  "verify-email",
  "second-factor",
  "account",
  "sessions",
  "applications",
];

const menu = computed(() =>
  menuFeatureIds
    .map((id) => CAPABILITIES.find((capability) => capability.id === id))
    .filter((capability): capability is Capability => capability !== undefined),
);

/** The route each menu entry navigates to, keyed by capability id. */
const PATHS: Readonly<Record<string, string>> = {
  "sign-in": "/sign-in",
  "sign-up": "/sign-up",
  "verify-email": "/verify-email",
  "second-factor": "/second-factor",
  account: "/account",
  sessions: "/sessions",
  applications: "/applications",
};

/**
 * A screen's availability badge.
 *
 * `title` carries the reason on hover/focus, so the badge is not just a colour
 * or a word: a sighted user moving a mouse over it and a screen-reader user
 * focusing it get the same explanation.
 */
function availabilityTitle(capability: Capability): string {
  return capability.status === "implemented"
    ? "Available"
    : `Not available yet — deferred to ${phasePhrase(capability.deferredTo)}.`;
}
</script>

<template>
  <a class="skip-link" href="#main">Skip to main content</a>

  <header class="app-header">
    <p class="app-header__brand">
      <RouterLink class="app-header__brand-link" to="/"
        >Ecoma Identity</RouterLink
      >
    </p>

    <nav class="app-nav" aria-label="Account">
      <ul class="app-nav__list">
        <li v-for="entry in menu" :key="entry.id" class="app-nav__item">
          <RouterLink
            class="app-nav__link"
            :class="{ 'app-nav__link--deferred': !isImplemented(entry.id) }"
            :to="PATHS[entry.id] ?? '/'"
          >
            <span class="app-nav__label">{{ entry.label }}</span>
            <span
              v-if="!isImplemented(entry.id)"
              class="app-nav__badge"
              :title="availabilityTitle(entry)"
            >
              <span class="visually-hidden">
                — {{ availabilityTitle(entry) }}</span
              >
              <span aria-hidden="true">not available yet</span>
            </span>
          </RouterLink>
        </li>
      </ul>
    </nav>
  </header>

  <!--
    `tabindex="-1"` on the main landmark so the skip link's target can actually
    receive focus. Without it the link scrolls the page but leaves keyboard
    focus on the skip link, which is the half of the behaviour that makes a skip
    link useless.
  -->
  <main id="main" class="app-main" tabindex="-1">
    <RouterView />
  </main>
</template>
