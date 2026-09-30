/**
 * The administrative calls the operator console will make.
 *
 * Every method here is written against the contract the Admin Worker declares,
 * not against a working endpoint, and every one documents the 501 it will get in
 * the bootstrap phase. They are real, typed call sites with real bodies — not
 * stubs that return a placeholder — because a stub is what produces a mock user
 * table, which is the single most tempting thing to build in an operator console
 * and the one thing that must not be here. An operator console showing invented
 * users is worse than an empty one: it looks authoritative, and every row in it
 * is a person who does not exist or, worse, a real person with invented standing.
 *
 * When the Admin Worker implements `/admin/users`, {@link searchUsers} starts
 * working and the deferred state on the user-search screen retires with no
 * change to the screen itself.
 *
 * **Every call is `credentials: "include"` and none carry a token.** See
 * `http.ts` for why that is not negotiable: the administrative session cookie is
 * `HttpOnly` and unreadable from JavaScript by construction, so the cookie
 * travelling with the request is the whole authentication story from this side.
 */

import type {
  AdminAuditRow,
  AdminUserRow,
  ApplicationView,
  PlatformRole,
  SearchUsers,
} from "./contracts";
import { ADMIN_ROUTES } from "../capabilities";
import { request } from "./http";

/**
 * Confirm the console's own administrative session.
 *
 * Route: `GET /admin/session`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * This is the query the console needs most and has least: the session cookie is
 * `HttpOnly`, so there is no way for this app to know whether the operator is
 * signed in, let alone what role they hold. Until this route exists, the
 * console renders every administrative screen behind its deferral, which is the
 * correct outcome — an operator console that assumed it was authorised would be
 * assuming the one thing it cannot check.
 */
export async function getAdminSession(): Promise<{
  readonly user_id: string;
  readonly display_name: string;
  readonly role: PlatformRole;
  readonly aal: "aal1" | "aal2";
  /** Whether a step-up is required before the next command will be permitted. */
  readonly step_up_required: boolean;
}> {
  return request(ADMIN_ROUTES.session, { method: "GET" });
}

/**
 * Search users.
 *
 * Route: `GET /admin/users`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}. The
 * user-search screen renders its deferred state; it must **not** render an empty
 * table, because an empty table says "this platform has no users" and a console
 * showing that is a console claiming there is nobody to act on.
 *
 * The filters go in the query string, and `query` is URL-encoded here rather
 * than interpolated raw: it is free text from an operator, it is a query
 * parameter and never a SQL fragment, and a search box that produced a
 * malformed URL would be a search box that silently searches for the wrong
 * thing.
 */
export async function searchUsers(input: SearchUsers): Promise<{
  readonly users: readonly AdminUserRow[];
  readonly has_more: boolean;
}> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit));
  params.set("offset", String(input.offset));
  if (input.query !== undefined) {
    params.set("query", input.query);
  }
  if (input.status !== undefined) {
    params.set("status", input.status);
  }
  if (input.role !== undefined) {
    params.set("role", input.role);
  }

  return request(`${ADMIN_ROUTES.users}?${params.toString()}`, {
    method: "GET",
  });
}

/**
 * Read one user's account.
 *
 * Route: `GET /admin/users/{user_id}`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 */
export async function getUser(userId: string): Promise<AdminUserRow> {
  return request(`${ADMIN_ROUTES.userDetail}/${encodeURIComponent(userId)}`, {
    method: "GET",
  });
}

/**
 * Suspend a user.
 *
 * Route: `POST /admin/users/{user_id}/suspend`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * Suspension is a `POST` and not a `PATCH` of a status field on purpose: it is
 * a command with an effect the server records in the audit trail, and modelling
 * it as a field write would invite a console that offers "edit status" as a
 * generic control. It also revokes the user's sessions server-side, so the
 * effect is not complete when the call returns a user row — which is why this
 * returns `void` and the screen reports what the Worker said, not what it
 * assumed.
 *
 * @param userId The user to suspend.
 * @param reason A client-safe reason, recorded in the audit trail. Optional:
 *   an operator suspending someone mid-incident should not be blocked by a
 *   form, and the audit record's value does not depend on it.
 */
export async function suspendUser(
  userId: string,
  reason?: string,
): Promise<void> {
  await request(`${ADMIN_ROUTES.suspend}/${encodeURIComponent(userId)}`, {
    method: "POST",
    ...(reason === undefined ? {} : { body: JSON.stringify({ reason }) }),
    headers: { "content-type": "application/json" },
  });
}

/**
 * Reinstate a suspended user.
 *
 * Route: `POST /admin/users/{user_id}/unsuspend`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * Only `suspended` can be reinstated. `deactivated` is not a reversible state
 * and the console will not offer this for one — the domain refuses the
 * transition, and a control the server would refuse is a dead control with a
 * misleading label.
 */
export async function unsuspendUser(userId: string): Promise<void> {
  await request(
    `${ADMIN_ROUTES.suspend}/${encodeURIComponent(userId)}/unsuspend`,
    {
      method: "POST",
    },
  );
}

/**
 * Change a user's platform role.
 *
 * Route: `POST /admin/users/{user_id}/role`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * The refusal rules — no self-change, no self-promotion, and the last active
 * administrator cannot be demoted — are decided server-side and evaluated in
 * the same transaction that applies the change. The console does **not**
 * pre-empt them with client-side disabling, and that is a substantive choice:
 * a client-side "you cannot demote the last administrator" check is a check the
 * client can be wrong about, and a disabled control is a control that explains
 * nothing. The console shows the server's refusal when it arrives.
 *
 * @param userId The user whose role changes.
 * @param role The role being assigned.
 */
export async function changeUserRole(
  userId: string,
  role: PlatformRole,
): Promise<void> {
  await request(`${ADMIN_ROUTES.role}/${encodeURIComponent(userId)}`, {
    method: "POST",
    body: JSON.stringify({ role }),
    headers: { "content-type": "application/json" },
  });
}

/**
 * Revoke every session belonging to one user.
 *
 * Route: `POST /admin/users/{user_id}/sessions/revoke`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * Distinct from {@link suspendUser}, and the console keeps them distinct:
 * revoking sessions ends the user's current access without changing their
 * account status, and suspending changes their status and revokes sessions as a
 * consequence. Collapsing them into one "disable the user" button would be
 * imprecise about which thing an operator did, and both are written to the audit
 * trail.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  await request(
    `${ADMIN_ROUTES.revokeSessions}/${encodeURIComponent(userId)}`,
    {
      method: "POST",
    },
  );
}

/**
 * Query the audit log.
 *
 * Route: `GET /admin/audit`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * The audit screen must not render an empty list. An empty audit log is a
 * specific and alarming claim — that nothing has been recorded — and during the
 * bootstrap phase events *are* being recorded server-side; only the query is
 * deferred. Saying "no events" when events exist and cannot be read would be
 * the worst possible thing for an operator investigating an incident to be told.
 */
export async function queryAudit(input: {
  readonly user_id?: string | undefined;
  readonly actor_id?: string | undefined;
  readonly since_ms?: number | undefined;
  readonly administrative_only: boolean;
  readonly limit: number;
  readonly offset: number;
}): Promise<{
  readonly events: readonly AdminAuditRow[];
  readonly has_more: boolean;
}> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit));
  params.set("offset", String(input.offset));
  params.set("administrative_only", String(input.administrative_only));
  if (input.user_id !== undefined) {
    params.set("user_id", input.user_id);
  }
  if (input.actor_id !== undefined) {
    params.set("actor_id", input.actor_id);
  }
  if (input.since_ms !== undefined) {
    params.set("since_ms", String(input.since_ms));
  }

  return request(`${ADMIN_ROUTES.audit}?${params.toString()}`, {
    method: "GET",
  });
}

/**
 * List registered OAuth clients.
 *
 * Route: `GET /admin/applications`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * The console shows registrations but never a client secret. The response type
 * has no field for one, and the rotation command below returns no secret to
 * display — a secret an operator console can read is a secret in a browser, in
 * a screenshot, and in a support ticket.
 */
export async function listApplications(): Promise<{
  readonly applications: readonly ApplicationView[];
  readonly has_more: boolean;
}> {
  return request("/admin/applications", { method: "GET" });
}

/**
 * Rotate a registered client's secret.
 *
 * Route: `POST /admin/applications/{application_id}/rotate-secret`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * The response deliberately carries no secret value. Rotation records *that* it
 * happened — `secret_rotated_at_ms` — and the new secret is delivered to the
 * registrant out of band. A console that displayed the new secret once would be
 * the only place in the system where it is readable, which is the opposite of
 * what a secret is for.
 */
export async function rotateClientSecret(applicationId: string): Promise<{
  readonly application_id: string;
  readonly secret_rotated_at_ms: number;
}> {
  return request(
    `/admin/applications/${encodeURIComponent(applicationId)}/rotate-secret`,
    { method: "POST" },
  );
}
