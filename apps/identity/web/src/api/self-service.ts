/**
 * The self-service calls the end-user UI will make.
 *
 * Every method here is written against the contract the Worker declares, not
 * against a working endpoint, and every one documents the 501 it will get in
 * the bootstrap phase. They are real, typed call sites with real bodies — not
 * stubs that return a placeholder — because a stub is what produces a screen
 * that looks finished. When the Worker implements `/self-service/sessions`,
 * this method starts working and the deferred state on the sessions screen
 * retires with no change to the screen itself.
 *
 * The alternative considered and rejected: leaving these methods out until the
 * Worker exists. That would mean the day the Worker lands, the screen, the
 * store, the contract types and the call all have to be written at once, under
 * time pressure, against a route whose real shape has meanwhile drifted from
 * the contract in this repository. What is here is the contract, typed
 * strictly enough that a drifted response is a type error at build time rather
 * than `undefined` in a template.
 *
 * **Every call is `credentials: "include"` and none carry a token.** See
 * `http.ts` for why that is not negotiable: the session cookie is `HttpOnly`
 * and unreadable from JavaScript by construction, so the cookie travelling with
 * the request is the whole authentication story from this side.
 */

import type {
  AccountView,
  ConnectedApplication,
  EnrolledAuthenticator,
  SessionView,
} from "./contracts";
import { ROUTES, request } from "./http";

/**
 * Read the caller's own account.
 *
 * Route: `GET /self-service/account`.
 * Bootstrap behaviour: **501**. The route is part of the declared self-service
 * contract, so the Worker answers 501 rather than 404, and this call throws
 * {@link NotImplementedError}. The account screen renders its deferred state
 * from that, naming the phase.
 *
 * A 401 here is the real signed-out state, not an error to suppress: the
 * cookie was absent, expired, or revoked server-side, and all three mean the
 * same thing to this app. The session store treats it as signed out and the
 * user is shown the real sign-in screen — which is itself deferred, and says
 * so.
 */
export async function getAccount(): Promise<AccountView> {
  return request<AccountView>(ROUTES.account, { method: "GET" });
}

/**
 * List the caller's own sessions.
 *
 * Route: `GET /self-service/sessions`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 * The sessions screen must render the deferred state. It must **not** render an
 * empty list: an empty list and an unimplemented query are indistinguishable
 * to a user, and "you have no other sessions" is a security-relevant claim the
 * app is not in a position to make.
 */
export async function listSessions(): Promise<SessionView[]> {
  return request<SessionView[]>(ROUTES.sessions, { method: "GET" });
}

/**
 * Revoke one of the caller's own sessions.
 *
 * Route: `POST /self-service/sessions/{session_id}/revoke`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * A revocation is a `POST` rather than a `DELETE` on purpose: it is a command
 * with an effect the server records in the audit trail, and an audited command
 * that is not idempotently safe to retry is better expressed as a POST the
 * server can refuse a second time than as a DELETE that a browser may replay
 * from a prefetch. CSRF protection for it is the Worker's to enforce — the
 * `SameSite=Lax` cookie is the browser's baseline and the server owns the real
 * check. See `http.ts`; this client does not mint a CSRF token.
 *
 * @param sessionId The session to revoke, as a UUID string.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await request<void>(
    `${ROUTES.sessions}/${encodeURIComponent(sessionId)}/revoke`,
    { method: "POST" },
  );
}

/**
 * Revoke every session belonging to the caller, including this one.
 *
 * Route: `POST /self-service/sessions/revoke-all`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * "Including this one" is the point: this is the sign-out-everywhere path, and
 * a UI that offered it while quietly exempting the current session would leave
 * the user believing they had ended an attacker's access when they had not.
 */
export async function revokeAllSessions(): Promise<void> {
  await request<void>(`${ROUTES.sessions}/revoke-all`, { method: "POST" });
}

/**
 * List the caller's enrolled second factors.
 *
 * Route: `GET /self-service/factors`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 * The second-factor screen renders its deferred state; it does not render an
 * empty list, for the same reason the sessions screen does not.
 */
export async function listAuthenticators(): Promise<EnrolledAuthenticator[]> {
  return request<EnrolledAuthenticator[]>(ROUTES.factors, { method: "GET" });
}

/**
 * Begin enrolling a TOTP second factor.
 *
 * Route: `POST /self-service/factors/totp`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * When it is implemented, the response is the enrolment *secret*, and the
 * provisioning URI. That is a secret and this method's return type says so.
 * The UI's obligation when that day comes is to render the provisioning URI as
 * a QR code the user can scan and to never log it, never put it in a URL, and
 * never put it in `localStorage` — the same "no token in storage" rule as the
 * session cookie, for the same reason.
 */
export async function beginTotpEnrolment(): Promise<{
  /** The Base32 shared secret. A secret: never logged, never stored. */
  readonly secret: string;
  /** The `otpauth://` URI to render as a QR code. */
  readonly provisioning_uri: string;
}> {
  return request(`${ROUTES.factors}/totp`, { method: "POST" });
}

/**
 * Remove an enrolled second factor.
 *
 * Route: `DELETE /self-service/factors/{authenticator_id}`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * Removing a second factor lowers the account's assurance, so this is the one
 * self-service call that will demand a step-up (AAL2) when it exists — the
 * caller's `step_up_required` in {@link AccountView} is the flag that says so.
 * A UI may warn; it may not decide the answer.
 */
export async function removeAuthenticator(
  authenticatorId: string,
): Promise<void> {
  await request<void>(
    `${ROUTES.factors}/${encodeURIComponent(authenticatorId)}`,
    { method: "DELETE" },
  );
}

/**
 * List the applications the caller has granted access to.
 *
 * Route: `GET /self-service/applications`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 * The applications screen renders its deferred state, not an empty list: "you
 * have shared nothing with anyone" is a claim about a real user's security
 * posture, and an unimplemented query must never be allowed to make it.
 */
export async function listConnectedApplications(): Promise<
  ConnectedApplication[]
> {
  return request<ConnectedApplication[]>(ROUTES.applications, {
    method: "GET",
  });
}

/**
 * Withdraw this application's access to the caller's account.
 *
 * Route: `DELETE /self-service/applications/{client_id}/grant`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * Withdrawing a grant is not a revocation of issued tokens — the server decides
 * what becomes of them, and the grant's removal is what this call records. The
 * UI must not claim "its access has stopped working" the moment the call
 * succeeds, because whether existing tokens survive is the server's rule.
 *
 * @param clientId The application's public `client_id`.
 */
export async function withdrawApplicationAccess(
  clientId: string,
): Promise<void> {
  await request<void>(
    `${ROUTES.applications}/${encodeURIComponent(clientId)}/grant`,
    { method: "DELETE" },
  );
}

/**
 * Sign out, ending the session the cookie identifies.
 *
 * Route: `POST /oauth/logout`.
 * Bootstrap behaviour: **501**, so this throws {@link NotImplementedError}.
 *
 * This is the one call whose failure mode a user must never be misled about. A
 * user who clicks "sign out" during an incident is trying to *reduce* their
 * exposure; a UI that reported success because it cleared local state while the
 * server never ended the session would be actively harmful. So the call throws,
 * and the signed-out path is only reported when the Worker confirms it. There
 * is no "sign out anyway" local escape hatch, because there is no local state
 * to clear: the cookie is `HttpOnly` and this app cannot revoke it by itself.
 */
export async function signOut(): Promise<void> {
  await request<void>(ROUTES.logout, { method: "POST" });
}
