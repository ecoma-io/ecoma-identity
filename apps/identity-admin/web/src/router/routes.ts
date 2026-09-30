/**
 * The operator console's route table.
 *
 * Every screen is reachable in the bootstrap phase, including the ones whose
 * backend does not work. That is the deliberate choice: a route table that
 * refused to register the unimplemented screens would leave a reviewer unable
 * to see the feature inventory, and would make the deferral something an
 * operator discovers by hitting a 404 rather than something the console states.
 * A 404 in a single-page app is a lie about the product's shape — it says the
 * feature does not exist, when the truth is that it is declared and unbuilt.
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

import AuditLogView from "../features/audit-log/AuditLogView.vue";
import CapabilityTable from "../components/CapabilityTable.vue";
import ModerationView from "../features/moderation/ModerationView.vue";
import OperatorSessionView from "../features/operator-session/OperatorSessionView.vue";
import RoleAdminView from "../features/role-admin/RoleAdminView.vue";
import SessionRevocationView from "../features/session-revocation/SessionRevocationView.vue";
import UserDetailView from "../features/user-detail/UserDetailView.vue";
import UserSearchView from "../features/user-search/UserSearchView.vue";

/**
 * The route table.
 *
 * Every entry is titled. A tab titled "Console" for all eight screens tells a
 * screen-reader user arriving by link nothing about where they landed, and the
 * title is the cheapest possible fix.
 *
 * The paths carry a user id segment (`/admin/users/:userId`) even though the
 * query that would resolve it does not exist. The shape is written down now so
 * that the day the query lands, the deep link works — and so a route that could
 * only ever be the search page cannot be mistaken for one.
 */
export const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "home",
    component: CapabilityTable,
    meta: { title: "Ecoma Identity — Console" },
  },
  {
    path: "/operator",
    name: "operator-session",
    component: OperatorSessionView,
    meta: { title: "Operator session — Ecoma Identity" },
  },
  {
    path: "/users",
    name: "user-search",
    component: UserSearchView,
    meta: { title: "Search users — Ecoma Identity" },
  },
  {
    path: "/users/:userId",
    name: "user-detail",
    component: UserDetailView,
    meta: { title: "User detail — Ecoma Identity" },
  },
  {
    path: "/moderation",
    name: "moderation",
    component: ModerationView,
    meta: { title: "Suspend and reinstate — Ecoma Identity" },
  },
  {
    path: "/roles",
    name: "role-admin",
    component: RoleAdminView,
    meta: { title: "Platform roles — Ecoma Identity" },
  },
  {
    path: "/sessions",
    name: "session-revocation",
    component: SessionRevocationView,
    meta: { title: "Revoke sessions — Ecoma Identity" },
  },
  {
    path: "/audit",
    name: "audit-log",
    component: AuditLogView,
    meta: { title: "Audit log — Ecoma Identity" },
  },
  /**
   * The catch-all. It renders the inventory rather than a bare "not found", so a
   * mistyped URL lands on the page that explains what exists.
   */
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: CapabilityTable,
    meta: { title: "Not found — Ecoma Identity" },
  },
];
