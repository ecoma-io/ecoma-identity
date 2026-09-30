/**
 * The HTTP client for the operator console.
 *
 * It talks to the **Admin Worker** — the BFF for this console. There is no
 * separate backend service behind it, and there is no second service behind
 * *that*: the Admin Worker reaches identity through a private service binding
 * and holds no `IDENTITY_DB` binding of its own (constraints 3 and 4). So every
 * route in this file is an Admin Worker route, and none of them is an Identity
 * Worker route. The console never addresses identity directly; a console that
 * did would be asserting a topology the deployment does not have, and would sit
 * one `VITE_API_BASE_URL` away from being a way around the administrative
 * boundary.
 *
 * ## Why there is no token anywhere in this file
 *
 * The administrative session is a cookie set by the Admin Worker with
 * `HttpOnly`, `Secure` and `SameSite=Lax`. `HttpOnly` means no JavaScript in
 * this app can read it, by construction — including code injected by an XSS
 * bug. There is therefore **no token in `localStorage`, in `sessionStorage`, or
 * in any variable a script can reach**, and this module must never grow one. The
 * cost of that choice is the constraint this file is shaped around:
 *
 * - Every call is `credentials: "include"`, applied centrally in
 *   {@link request} rather than per call site, because there is no header that
 *   could stand in for it.
 * - **CSRF protection is the server's job.** `SameSite=Lax` is the browser's
 *   baseline; the Admin Worker owns the real check. This client does not
 *   hand-roll a CSRF token, and a future contributor should not add one: a
 *   token minted and validated in the client is one the client can be talked
 *   into minting wrongly, and the check that matters belongs on the server that
 *   can actually see the Origin header.
 * - Because the cookie is unreadable, this console cannot tell whether an
 *   operator is signed in by inspection. It must ask the server, and the only
 *   answer it may hold is "the last thing the server said" — never a cached
 *   "is an administrator" flag, which would be both forgeable and a client-side
 *   authorization check in disguise.
 *
 * The administrative actions here are the ones that change someone's security
 * posture — suspending, demoting, revoking sessions. They are `POST`s, and they
 * are deliberately **not** expressed as client-side affordances the operator can
 * trigger optimistically: an operator who suspends a user during an incident and
 * is then told "done" by a UI that had not reached the server has been told a
 * lie that matters. Every call here throws on failure, and no screen reports
 * success without a server response.
 *
 * ## The 501 contract
 *
 * The Admin Worker answers **501** on every declared administrative route in the
 * bootstrap phase. Each method documents the route it will call and what happens
 * when that route answers 501, and the answer is always the same: a typed
 * {@link NotImplementedError}, never a fabricated result and never a sample
 * user.
 *
 * This module is **not** a mock layer. It has no fixture mode, no dev bypass and
 * no "pretend to be an administrator" path; constraint 26 forbids an
 * authentication bypass for development, and a fake administrative session is
 * exactly that.
 */

/**
 * The origin of the Admin Worker, from the build-time environment.
 *
 * Defaults to the same origin the console is served from, which is correct in
 * production (the Admin Worker serves this console's `dist/` from its own
 * origin) and wrong for `vite dev` — hence the `.env.example`. An unset
 * variable is not a crash; it is "the Worker is wherever this page came from",
 * which is the true statement about a same-origin deployment.
 */
const DEFAULT_BASE_URL = "http://localhost:8788";

/**
 * The resolved base URL, with any trailing slash removed.
 *
 * Normalised once here so every route is concatenated as
 * `` `${baseUrl}${route}` `` and can never produce `//admin/users`, which some
 * proxies read as a protocol-relative URL to a different host — a different host
 * being exactly the boundary this app must not cross.
 */
export const API_BASE_URL: string = (
  import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL
).replace(/\/+$/, "");

/**
 * The error the API layer raises when the Admin Worker answers 501.
 *
 * A distinct class rather than a status field, because a screen's correct
 * response to 501 ("this is deferred, here is the phase") is different from its
 * response to a 500, a 403, or a 401, and a `status` field invites
 * `if (status === 404) ... else genericError()` — into which 501 falls.
 */
export class NotImplementedError extends Error {
  /**
   * The route that answered 501. The screen reads it to name the endpoint in
   * its deferred state, so the user can see which call is missing.
   */
  readonly route: string;

  /**
   * Build a 501 error.
   *
   * @param route The route that answered 501, not the full URL — the base URL
   *   is deployment configuration, and printing it in an operator-facing screen
   *   would disclose the topology to whoever can see the screen.
   */
  constructor(route: string) {
    super(`The Admin Worker has not implemented ${route} yet (501).`);
    this.name = "NotImplementedError";
    this.route = route;
  }
}

/**
 * The error the API layer raises for a failure that is not 501.
 *
 * Deliberately opaque. It carries the status and the request id — what an
 * operator needs to correlate with the Worker's logs — and the route. It does
 * **not** carry the response body: an error envelope can quote a reason never
 * meant to reach a browser, and in an operator console a leaked internal
 * reason is a disclosure with an audience. {@link ProblemResponse} is the
 * narrow opt-in for the envelope shape the provider documents as client-safe.
 */
export class ApiError extends Error {
  /** The HTTP status the Admin Worker answered. */
  readonly status: number;
  /** The route that failed. */
  readonly route: string;
  /**
   * The `request_id` the Worker stamped on the response, when it sent one — the
   * join key between this console and the Worker's logs, and the single most
   * useful thing to show an operator who is about to file a report. `undefined`
   * rather than empty string when absent, so the screen can say "no request id"
   * instead of rendering a blank.
   */
  readonly requestId: string | undefined;

  constructor(status: number, route: string, requestId: string | undefined) {
    super(`The Admin Worker answered ${status} for ${route}.`);
    this.name = "ApiError";
    this.status = status;
    this.route = route;
    this.requestId = requestId;
  }
}

/**
 * The error envelope the provider documents as safe to show a client.
 *
 * The code is the vocabulary a client branches on (`forbidden`,
 * `insufficient_assurance`, `invalid_request`, …) and the message is written to
 * be read by the person who triggered it. Anything that does not parse as this
 * stays an opaque {@link ApiError}.
 */
export class ProblemResponse extends ApiError {
  /** The provider's error code, e.g. `forbidden`. */
  readonly code: string;
  /** The client-safe message. */
  readonly problemMessage: string;

  constructor(
    status: number,
    route: string,
    requestId: string | undefined,
    code: string,
    problemMessage: string,
  ) {
    super(status, route, requestId);
    this.name = "ProblemResponse";
    this.code = code;
    this.problemMessage = problemMessage;
  }
}

/** The request id header the Worker stamps on every response. */
const REQUEST_ID_HEADER = "x-request-id";

/** Read a response header defensively, as a trimmed string or `undefined`. */
function header(response: Response, name: string): string | undefined {
  const value = response.headers.get(name);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Narrow an unknown JSON value to the documented problem envelope.
 *
 * A type guard rather than a cast, because the body is attacker-reachable
 * input: it is whatever the Admin Worker — or a proxy in front of it, or a
 * misconfigured base URL pointing at something that is not a Worker — put in
 * the response. A cast would make `problemMessage` render whatever the body
 * said, in an operator console.
 */
function isProblemEnvelope(value: unknown): value is {
  error: string;
  error_description?: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "string" || error === "") {
    return false;
  }
  const description = (value as { error_description?: unknown })
    .error_description;
  return description === undefined || typeof description === "string";
}

/**
 * The shared request path: one place that adds credentials, one place that
 * turns a status into a typed error, one place that reads the body.
 *
 * Every call in this app goes through here, which is what makes "every
 * authenticated call is `credentials: include`" a property of the codebase
 * rather than a thing to remember per call site.
 *
 * @param route The Admin Worker route, without the base URL.
 * @param init Standard `fetch` init, minus the headers this module owns.
 * @throws {NotImplementedError} when the Admin Worker answers 501.
 * @throws {ProblemResponse} when it answers a client-safe problem envelope.
 * @throws {ApiError} for any other non-2xx status.
 * @throws {TypeError} when the network fails — propagated deliberately, because
 *   "the Worker was unreachable" and "the Worker answered 501" are different
 *   facts and an operator must not be told an outage is a deferral.
 */
export async function request<T>(
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${route}`, {
    ...init,
    // The one line the cookie design depends on. `include` is what makes the
    // HttpOnly cookie travel; without it every call is anonymous and fails as a
    // 401 that looks like "you are not an administrator".
    credentials: "include",
    headers: {
      Accept: "application/problem+json, application/json",
      ...init.headers,
    },
  });

  if (response.status === 501) {
    // The status alone is the contract. The body may carry the provider's own
    // explanation, but a Worker answering 501 with an empty body is legal too,
    // so reading the body is a bonus and never a requirement. What this branch
    // exists to prevent is returning a fabricated result.
    throw new NotImplementedError(route);
  }

  if (!response.ok) {
    throw await toError(response, route);
  }

  // 204 and 205 carry no body by definition; `json()` on them throws, which
  // would turn a successful revocation into a UI error.
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * Turn a non-2xx response into the most specific error available.
 *
 * Prefers {@link ProblemResponse} when the body is a documented envelope and
 * falls back to an opaque {@link ApiError} otherwise. The fallback is the common
 * case during bootstrap, and it is the reason the deferred state has a dedicated
 * error class: a 501 never reaches here.
 */
async function toError(response: Response, route: string): Promise<Error> {
  const requestId = header(response, REQUEST_ID_HEADER);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A non-JSON error body is not a reason to lose the status and the request
    // id; it only means there is no code to branch on.
    return new ApiError(response.status, route, requestId);
  }

  if (isProblemEnvelope(body)) {
    return new ProblemResponse(
      response.status,
      route,
      requestId,
      body.error,
      body.error_description ?? body.error,
    );
  }

  return new ApiError(response.status, route, requestId);
}

/** The body of a liveness or readiness check. */
export interface HealthStatus {
  /** Whether the Worker reports itself live or ready. */
  readonly ok: boolean;
  /**
   * Every field of the probe body except `ok`.
   *
   * Open-ended on purpose: the probe's body is the Worker's to define and this
   * client must not break when it gains a field. It is explicitly the
   * remainder, unexamined, and nothing in this console reads it.
   */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Reduce a raw probe body to a {@link HealthStatus}.
 *
 * Split out as a pure function so the awkward part is testable without a
 * network. A missing `ok` is reported as `false`, not `true`: a probe that says
 * nothing about its own liveness has not asserted that it is live, and a health
 * display that defaults to the reassuring answer is a health display that lies
 * in exactly the situation a health display exists for.
 */
export function normaliseHealth(body: unknown): HealthStatus {
  if (typeof body !== "object" || body === null) {
    return { ok: false, detail: {} };
  }
  const entries = Object.entries(body as Record<string, unknown>).filter(
    ([key]) => key !== "ok",
  );
  return {
    ok: (body as { ok?: unknown }).ok === true,
    detail: Object.fromEntries(entries),
  };
}

/**
 * GET a health or readiness probe.
 *
 * The only method in this module whose route is implemented in the bootstrap
 * phase. It lets the console prove it is reaching a real Admin Worker rather
 * than a static file server, which is the one thing this UI *can* do for real
 * today.
 *
 * @param route `ADMIN_ROUTES.health` or `ADMIN_ROUTES.ready`.
 * @throws {NotImplementedError} if the deployment answers 501 even here — the
 *   capability table says these are live, so that would mean the table and the
 *   deployment disagree, and the error is the honest report of it.
 */
export async function getHealth(route: string): Promise<HealthStatus> {
  return normaliseHealth(await request<unknown>(route, { method: "GET" }));
}
