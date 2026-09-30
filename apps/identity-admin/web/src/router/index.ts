/**
 * The operator console's router instance.
 *
 * `createWebHistory` rather than hash history: the Admin Worker serves this
 * console's assets and falls back to `index.html` for unmatched paths, so a
 * clean path is what a deployment of this shape supports. A hash URL would put
 * the route in a fragment the server never sees.
 *
 * The route table itself lives in `./routes.ts`, so tests can build a router
 * over the real routes without importing a module that reaches for `document`
 * and `createWebHistory` at import time.
 */

import { createRouter, createWebHistory } from "vue-router";

import { routes } from "./routes";

/** The document title used when a route declares none. */
const DEFAULT_TITLE = "Ecoma Identity — Console";

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Update the document title from the matched route.
//
// `afterEach` is chained rather than passed to `createRouter`, because in
// vue-router 5 it is a guard on the instance and not a constructor option — the
// constructor option form was removed, and a config object that silently carries
// an unknown key looks configured and is not.
router.afterEach((to) => {
  const title = to.meta.title;
  document.title = typeof title === "string" ? title : DEFAULT_TITLE;
});
