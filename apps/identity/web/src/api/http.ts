/**
 * The HTTP client for the end-user identity UI.
 *
 * It talks to the **Identity Worker** — the BFF for this app. There is no
 * separate backend service behind it: the Worker serves both these API routes
 * and this app's built `dist/`, and the two ship as one release unit
 * (constraint 8). A `VITE_API_BASE_URL` pointing anywhere else is a
 * misconfiguration this module cannot detect, and the failure it would produce
 * is a 404 that looks like a wrong route rather than a wrong host.
 *
 * ## Why there is no token anywhere in this file
 *
 * The session is a cookie set by the Worker with `HttpOnly`, `Secure` and
 * `SameSite=Lax`. `HttpOnly` means no JavaScript in this app can read it, by
 * construction — including code injected by an XSS bug. There is therefore
 * **no token in `localStorage`, in `sessionStorage`, or in any variable a
 * script can reach**, and this module must never grow one. A stored token is
 * readable by any script on the page and survives until something clears it;
 * a cookie the server sets is not. The cost of that choice is the constraint
 * this whole file is shaped around:
 *
 * - Every authenticated call is `credentials: "include"`, or it is not sent.
 *   There is no header to attach instead, so "did I remember the credentials
 *   flag" is a real question on every call site and the reason the flag is
 *   applied centrally in {@link request} rather than per call.
 * - **CSRF protection is the server's job.** `SameSite=Lax` is the browser's
 *   baseline defence; the Worker owns the real check (double-submit or a
 *   same-origin check on unsafe methods). This client does **not** hand-roll a
 *   CSRF token, and a future contributor should not add one: a token minted and
 *   validated in the client is a token the client can be talked into minting
 *   wrongly, and the fix that matters belongs on the server that can actually
 *   see the Origin header.
 * - Because the cookie is unreadable, this app cannot tell whether it is
 *   signed in by inspection. It must ask the server. There is no cached
 *   "logged in" flag stored anywhere; the only honest client-side state is
 *   "unknown, and the last thing the server said", which is what the session
 *   store holds.
 *
 * ## The 501 contract
 *
 * The Worker answers **501** on every declared route except `/health` and
 * `/ready` — not 404, because the route is part of this provider's contract
 * and a 501 tells a client to stop where a 404 would look like a wrong URL.
 * Every method here documents the route it will call and what happens when
 * that route answers 501, and the answer is always the same: a typed
 * {@link NotImplementedError}, never a fabricated success and never a thrown
 * `TypeError` from reading a body that was never an object.
 *
 * What this module is **not**: it is not a mock layer, it has no fixture mode,
 * and it has no development bypass. There is no code path in this file that
 * returns a value the Worker did not return, because constraint 26 forbids an
 * authentication bypass for development and a fake session is exactly that.
 */

/**
 * The origin of the Identity Worker, from the build-time environment.
 *
 * Defaults to the same origin the app is served from, which is correct in
 * production (the Worker serves this app's assets from its own origin) and
 * wrong for `vite dev` — hence the `.env.example`. An unset variable is
 * therefore not a crash; it is "the Worker is wherever this page came from",
 * which is the true statement about a same-origin deployment.
 */
const DEFAULT_BASE_URL = "http://localhost:8787";

/**
 * The resolved base URL, with any trailing slash removed.
 *
 * Normalising once here means every route is concatenated as
 * `` `${baseUrl}${route}` `` and can never produce `//oauth/authorize`, which
 * some proxies read as a protocol-relative URL to a different host.
 */
export const API_BASE_URL: string = (
  import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL
).replace(/\/+$/, "");

/**
 * The error the API layer raises when the Worker answers 501.
 *
 * A distinct class rather than a status-code field on a generic error,
 * because a screen's correct response to 501 ("this is deferred, here is the
 * phase") is different from its response to a 500 ("something is wrong with
 * the Worker") and from a 403 ("you may not"). Making 501 a type the UI can
 * branch on is what stops a deferred route from being rendered as a generic
 * failure, and it is why this is not a field: a `status` field invites
 * `if (status === 404) ... else genericError()` and 501 falls into the else.
 */
export class NotImplementedError extends Error {
  /**
   * The route that answered 501. The screen reads it to name the endpoint in
   * its deferred state, so the user can see which call is missing rather than
   * being told only that something is.
   */
  readonly route: string;

  /**
   * Build a 501 error.
   *
   * @param route The route that answered 501, not the full URL — the base URL
   *   is deployment configuration and printing it in a user-facing message
   *   would leak the topology to whoever reads the screen.
   */
  constructor(route: string) {
    super(`The Identity Worker has not implemented ${route} yet (501).`);
    this.name = "NotImplementedError";
    this.route = route;
  }
}

/**
 * The error the API layer raises when a response is a failure that is not 501.
 *
 * Deliberately opaque. It carries the status and the request id, which is what
 * an operator needs, and the route. It does **not** carry the response body:
 * a Worker error envelope can quote a reason that was never meant to reach a
 * browser, and rendering it verbatim is how an internal detail becomes a
 * disclosure. The one exception is {@link ProblemResponse}, below, which is
 * the envelope shape the provider documents as client-safe.
 */
export class ApiError extends Error {
  /** The HTTP status the Worker answered. */
  readonly status: number;
  /** The route that failed. */
  readonly route: string;
  /**
   * The `request_id` the Worker stamped on the response, when it sent one.
   * This is the join key between a browser error and a Worker log line, and it
   * is the single most useful thing to show a user who is about to file a
   * report. `undefined` rather than empty string when the header is absent, so
   * the UI can say "no request id" instead of rendering a blank.
   */
  readonly requestId: string | undefined;

  constructor(status: number, route: string, requestId: string | undefined) {
    super(`The Identity Worker answered ${status} for ${route}.`);
    this.name = "ApiError";
    this.status = status;
    this.route = route;
    this.requestId = requestId;
  }
}

/**
 * The error envelope the provider documents as safe to show a client.
 *
 * This is the shape `identity-security`'s `is_client_safe` allows out. It is
 * a *narrow* opt-in rather than a general "parse the body" step: the error
 * code is the vocabulary a client branches on (`invalid_request`,
 * `forbidden`, `invalid_token`, …) and the message is written to be read by
 * the person who triggered it. Anything that does not parse as this stays an
 * opaque {@link ApiError}.
 */
export class ProblemResponse extends ApiError {
  /** The provider's error code, e.g. `invalid_request`. */
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

/**
 * The Worker routes this app calls.
 *
 * The OIDC paths are the ones `identity-oidc`'s route table declares, and
 * they are listed here so a reader can see the target without opening a Rust
 * file. Every one of them except `/health` and `/ready` answers 501 in the
 * bootstrap phase; the methods that call them document that individually.
 *
 * The `/self-service/*` paths are the self-service surface the brief declares
 * and the Worker does not yet serve. They are names this client owns, not
 * paths a Rust constant exports today — when the Worker implements them, these
 * strings and the Rust route table must be reconciled in one commit, and the
 * comment is here so that commit finds the note.
 */
export const ROUTES = {
  /** Liveness. One of the two routes that answers for real. */
  health: "/health",
  /** Readiness. One of the two routes that answers for real. */
  ready: "/ready",
  /** The authorization endpoint. Declared; answers 501. */
  authorize: "/oauth/authorize",
  /** The token endpoint. Declared; answers 501. */
  token: "/oauth/token",
  /** The end-session endpoint. Declared; answers 501. */
  logout: "/oauth/logout",
  /** The caller's own account. Declared for the self-service contract; 501. */
  account: "/self-service/account",
  /** The caller's own second factors. Declared; answers 501. */
  factors: "/self-service/factors",
  /** The caller's own sessions. Declared; answers 501. */
  sessions: "/self-service/sessions",
  /** The caller's own connected applications. Declared; answers 501. */
  applications: "/self-service/applications",
} as const;

/** The request id header the Worker stamps on every response. */
const REQUEST_ID_HEADER = "x-request-id";

/** The header naming the envelope the client wants back. */
const PROBLEM_ACCEPT_HEADER = "application/problem+json";

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
 * Written as a type guard against a hand-rolled validator rather than a cast,
 * because the body is attacker-reachable input: it is whatever the Worker (or
 * a proxy in front of it, or a misconfigured base URL pointing at something
 * that is not a Worker at all) put in the response. A `as ProblemEnvelope`
 * would make `error.message` render whatever the body said.
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
 * @param route The Worker route, without the base URL.
 * @param init Standard `fetch` init, minus the headers this module owns.
 * @throws {NotImplementedError} when the Worker answers 501.
 * @throws {ProblemResponse} when the Worker answers a client-safe problem envelope.
 * @throws {ApiError} for any other non-2xx status.
 * @throws {TypeError} when the network fails — propagated deliberately, because
 *   "the Worker was unreachable" and "the Worker answered 501" are different
 *   facts and a screen must not conflate an outage with a deferral.
 */
export async function request<T>(
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${route}`, {
    ...init,
    // The one line the whole cookie design depends on. `include` is what makes
    // the HttpOnly cookie travel; without it every authenticated call is
    // anonymous and would fail as a 401 that looks like a wrong password.
    credentials: "include",
    headers: {
      Accept: `${PROBLEM_ACCEPT_HEADER}, application/json`,
      ...init.headers,
    },
  });

  if (response.status === 501) {
    // Read before throwing: the 501 body carries the provider's own
    // explanation, but a Worker that answers 501 with an empty body is legal
    // too, so the status alone is the contract and the body is a bonus. Not
    // reading it and returning a fabricated success is what this branch exists
    // to prevent.
    throw new NotImplementedError(route);
  }

  if (!response.ok) {
    throw await toError(response, route);
  }

  // 204 and 205 carry no body by definition; `json()` on them throws, which
  // would turn a successful logout into a UI error.
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * Turn a non-2xx response into the most specific error available.
 *
 * Prefers {@link ProblemResponse} when the body is a documented envelope and
 * falls back to an opaque {@link ApiError} otherwise. The fallback is the
 * common case during bootstrap, and it is the reason the deferred state has a
 * dedicated error class: a 501 never reaches here.
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
   * Every field of the probe body except `ok`, as a stable-keyed map.
   *
   * Open-ended on purpose: the probe's body is the Worker's to define, and
   * this client must not break when it gains a field. It is *not* typed as
   * "a thing we understand" — it is explicitly the remainder, unexamined, and
   * nothing in this app reads it.
   */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Reduce a raw probe body to a {@link HealthStatus}.
 *
 * Split out from {@link getHealth} as a pure function so the awkward part —
 * the probe body's shape is the Worker's to define, and a UI that assumed
 * `ok` was always present would render "not live" for a Worker that simply
 * spells it differently — can be tested without a network.
 *
 * A missing `ok` is reported as `false`, not as `true`. A probe that says
 * nothing about its own liveness has not asserted that it is live, and a
 * health display that defaults to the reassuring answer is a health display
 * that lies in exactly the situation a health display exists for.
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
 * phase. It is what lets the app prove it is reaching a real Worker rather
 * than a static file server, which is the one thing this UI *can* do for real
 * today.
 *
 * @param route `ROUTES.health` or `ROUTES.ready`.
 * @throws {NotImplementedError} if the deployment answers 501 even here — the
 *   capability table says these are live, so that would mean the table and the
 *   deployment disagree, and the error is the honest report of it.
 * @throws {ApiError} for any other non-2xx status.
 */
export async function getHealth(route: string): Promise<HealthStatus> {
  return normaliseHealth(await request<unknown>(route, { method: "GET" }));
}
