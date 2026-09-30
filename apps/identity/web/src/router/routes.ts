/**
 * The end-user identity app's route table.
 *
 * Every screen is reachable in the bootstrap phase, including the ones whose
 * backend does not work. That is the deliberate choice: a route table that
 * refused to register the unimplemented screens would leave a reviewer unable
 * to see the feature inventory, and would make the deferral something a user
 * discovers by hitting a 404 rather than something the app states. A 404 in a
 * single-page app is a lie about the product's shape — it says the feature does
 * not exist, when the truth is that it is declared and unbuilt.
 *
 * The gates live in the screens (`CapabilityGate`), not here, so this stays a
 * route table and nothing else. A guard that redirected every deferred screen
 * to one "coming soon" page would be a second thing to keep in sync with the
 * inventory, and would throw away the per-feature phase each entry records.
 *
 * The table is exported separately from the router instance so tests can build a
 * router over the real routes without importing a module that reaches for
 * `document` and `createWebHistory` at import time.
 */

import type { RouteRecordRaw } from "vue-router";

import AccountView from "../features/account/AccountView.vue";
import ApplicationsView from "../features/applications/ApplicationsView.vue";
import CapabilityTable from "../components/CapabilityTable.vue";
import SecondFactorView from "../features/second-factor/SecondFactorView.vue";
import SessionsView from "../features/sessions/SessionsView.vue";
import SignInView from "../features/sign-in/SignInView.vue";
import SignUpView from "../features/sign-up/SignUpView.vue";
import VerifyEmailView from "../features/verify-email/VerifyEmailView.vue";

/**
 * The route table.
 *
 * Every entry is titled. A tab titled "Ecoma Identity" for all seven screens
 * tells a screen-reader user arriving by link nothing about where they landed,
 * and the title is the cheapest possible fix.
 */
export const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "home",
    component: CapabilityTable,
    meta: { title: "Ecoma Identity" },
  },
  {
    path: "/sign-in",
    name: "sign-in",
    component: SignInView,
    meta: { title: "Sign in — Ecoma Identity" },
  },
  {
    path: "/sign-up",
    name: "sign-up",
    component: SignUpView,
    meta: { title: "Create an account — Ecoma Identity" },
  },
  {
    path: "/verify-email",
    name: "verify-email",
    component: VerifyEmailView,
    meta: { title: "Verify your email — Ecoma Identity" },
  },
  {
    path: "/second-factor",
    name: "second-factor",
    component: SecondFactorView,
    meta: { title: "Second factor — Ecoma Identity" },
  },
  {
    path: "/account",
    name: "account",
    component: AccountView,
    meta: { title: "Your account — Ecoma Identity" },
  },
  {
    path: "/sessions",
    name: "sessions",
    component: SessionsView,
    meta: { title: "Your sessions — Ecoma Identity" },
  },
  {
    path: "/applications",
    name: "applications",
    component: ApplicationsView,
    meta: { title: "Connected applications — Ecoma Identity" },
  },
  /**
   * The catch-all.
   *
   * It renders the inventory rather than a bare "not found", so a mistyped URL
   * lands on the page that explains what exists.
   */
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: CapabilityTable,
    meta: { title: "Not found — Ecoma Identity" },
  },
];
