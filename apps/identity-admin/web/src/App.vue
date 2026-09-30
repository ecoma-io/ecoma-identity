<!--
  The operator console's application shell.

  What it is: the chrome around every screen — the skip link, the navigation, and
  the router outlet.

  What it is not: a gate. There is no client-side check anywhere in this shell
  that asks whether the operator is permitted to see the screens in the
  navigation, and there will not be one. The administrative session cookie is
  `HttpOnly`, so this app cannot read it; every command is authorized by the
  Admin Worker on the server, against the session it resolves.

  That is not a missing feature, it is the point. A console that hid screens
  behind a client-side "is an administrator" flag would create the impression
  that access is controlled in the browser, which is the one place it is not
  controlled at all — and an operator would be right to trust the impression. So
  every screen is linked, and every screen's *own* capability gate says whether
  the feature behind it is built.

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
 * a label here: the label is operator-facing copy that belongs in one place, and
 * having it in two places is how a menu ends up calling the same screen two
 * different things.
 *
 * `user-detail` is deliberately absent. It needs a user id that only the search
 * query can supply, and the search query does not exist; a menu link to
 * `/users/:userId` would either 404 into the catch-all or carry a placeholder
 * id that looks like a real one. The route is registered and reachable by deep
 * link, and it becomes a menu entry when there is something to put in it.
 */
const menuFeatureIds: readonly string[] = [
  "operator-session",
  "user-search",
  "suspend-user",
  "change-role",
  "revoke-sessions",
  "audit-log",
];

const menu = computed(() =>
  menuFeatureIds
    .map((id) => CAPABILITIES.find((capability) => capability.id === id))
    .filter((capability): capability is Capability => capability !== undefined),
);

/** The route each menu entry navigates to, keyed by capability id. */
const PATHS: Readonly<Record<string, string>> = {
  "operator-session": "/operator",
  "user-search": "/users",
  "suspend-user": "/moderation",
  "change-role": "/roles",
  "revoke-sessions": "/sessions",
  "audit-log": "/audit",
};

/**
 * A screen's availability badge.
 *
 * `title` carries the reason on hover/focus, so the badge is not just a colour
 * or a word: a sighted operator moving a mouse over it and a screen-reader user
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
      <RouterLink class="app-header__brand-link" to="/">
        Ecoma Identity
      </RouterLink>
      <span class="app-header__brand-suffix">Console</span>
    </p>

    <nav class="app-nav" aria-label="Administration">
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
