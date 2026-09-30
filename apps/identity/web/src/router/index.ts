/**
 * The end-user identity app's routes.
 *
 * Every screen is reachable in the bootstrap phase, including the ones whose
 * backend does not work. That is the deliberate choice: a route table that
 * refuses to register the unimplemented screens would leave a reviewer unable
 * to see the feature inventory, and would make the deferral something the user
 * discovers by hitting a 404 rather than something the app states. A 404 in a
 * single-page app is a lie about the product's shape — it says the feature does
 * not exist, when the truth is that it is declared and unbuilt.
 *
 * The gates live in the screens (`CapabilityGate`), not here, so that the
 * routing table stays a routing table. A guard that redirected deferred screens
 * to a single "coming soon" page would be a second place to keep in sync with
 * the inventory, and would throw away the per-feature phase.
 *
 * Every route is `meta.title`'d, and the router uses it to set the document
 * title on navigation. A screen-reader user arriving via a link should hear what
 * page they are on, and a tab titled "Ecoma Identity" for every screen does not
 * tell them.
 */

import { createRouter, createWebHistory } from "vue-router";

import { routes } from "./routes";

/** The document title used when a route declares none. */
const DEFAULT_TITLE = "Ecoma Identity";

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Update the document title from the matched route.
//
// `afterEach` is chained rather than passed to `createRouter`, because in
// vue-router 5 it is a guard on the instance and not a constructor option — the
// constructor option form was removed, and a config object that silently
// carries an unknown key is exactly the kind of thing that looks configured and
// is not. A title is a property of the route, so deriving it in one place means
// a new screen gets a correct title by being in the table rather than by
// remembering to set one.
router.afterEach((to) => {
  const title = to.meta.title;
  document.title = typeof title === "string" ? title : DEFAULT_TITLE;
});
