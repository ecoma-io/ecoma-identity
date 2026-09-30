/**
 * Mapping an administrative API failure onto what the console is allowed to say.
 *
 * Every screen funnels its `catch` through {@link toErrorState}. The mapping is
 * a pure function, deliberately, and it lives apart from every component so that
 * `tests/error-state.test.ts` can assert each branch without mounting anything.
 *
 * Two failures matter more than the rest in an operator console:
 * - A **501** is a *deferral*. Rendering it as a generic failure is how a
 *   bootstrap console starts lying about itself, and rendering it as an empty
 *   result is how it lies about the platform.
 * - A **403** is a *refusal*, and in this console refusals are structured:
 *   "administrative action requires an AAL2 session" and "the last
 *   administrator cannot be demoted" are different facts with different
 *   remedies, and an operator who is told "access denied" for both has been told
 *   nothing they can act on. The `insufficient_assurance` code gets its own
 *   branch for exactly that reason.
 *
 * What this module is **not**: a place to invent a message, and a place to
 * decide whether an operator is permitted to do something. Every branch names
 * what the Worker actually did; authorization is the server's answer, not this
 * app's guess.
 */

import { ApiError, NotImplementedError, ProblemResponse } from "./http";
import { phasePhrase, type DeferredTo } from "../capabilities";

/**
 * The kinds of failure a console screen can be in.
 *
 * - `deferred` — the Admin Worker answered 501. The feature is not built. Name
 *   the phase.
 * - `unreachable` — the request never got an answer. The Worker may be down, or
 *   the base URL may be wrong. Not the same as deferred: telling an operator
 *   "coming soon" because the network is down sends them away from a system
 *   that is having an incident.
 * - `malformed-response` — the Worker answered 2xx with something this client
 *   cannot read. A real fault on one side or the other.
 * - `unauthenticated` — 401. No valid administrative session.
 * - `forbidden` — 403. Signed in, request refused. Includes the AAL2 step-up
 *   case, which carries its own title.
 * - `server` — 5xx. The Worker's fault or a dependency's. Show the request id.
 * - `unexpected` — anything else. The one branch allowed to be vague, because at
 *   this point the app genuinely does not know what happened.
 */
export type ErrorKind =
  | "deferred"
  | "unreachable"
  | "malformed-response"
  | "unauthenticated"
  | "forbidden"
  | "server"
  | "unexpected";

/** A failure, resolved into what a screen may render. */
export interface ErrorState {
  /** Which kind of failure this is. Screens branch on this, not on a status. */
  readonly kind: ErrorKind;
  /**
   * The headline. Must state what happened. For `deferred` it names the phase;
   * for `forbidden` it distinguishes a step-up from a plain refusal.
   */
  readonly title: string;
  /**
   * One or two sentences of detail, safe to show the operator who triggered it.
   * Never a raw response body: see {@link ProblemResponse} for why.
   */
  readonly detail: string;
  /**
   * The request id, when the Worker sent one — the join key between this console
   * and the Worker's logs, and the only thing that makes an operator's bug
   * report actionable. Surfaced rather than logged to a console the operator
   * cannot reach.
   */
  readonly requestId: string | undefined;
  /**
   * The route that failed, or `undefined` when the request never left. A
   * deferred state names it so the operator can see which call is missing.
   */
  readonly route: string | undefined;
  /**
   * Whether a retry could plausibly help. `false` for `deferred` and
   * `forbidden`, because re-issuing a request the server has already refused
   * deterministically teaches an operator to hammer an endpoint. A screen may
   * therefore render no retry button, which is not a dead control — the state
   * says why.
   */
  readonly retryable: boolean;
}

/**
 * Resolve a thrown value into an {@link ErrorState}.
 *
 * Total: it accepts `unknown` and never throws, because it is called from a
 * `catch` where the alternative is a second failure inside the error path. A
 * non-`Error` throw becomes `unexpected` rather than crashing the render.
 *
 * @param error The caught value.
 * @param phase The phase the calling feature is deferred to, for the 501 branch.
 *   A screen knows this from its capability entry; passing it in keeps the phase
 *   out of this layer's own guesses, so the phase printed is the one the
 *   capability table records.
 */
export function toErrorState(error: unknown, phase: DeferredTo): ErrorState {
  if (error instanceof NotImplementedError) {
    return {
      kind: "deferred",
      title: "Not available yet",
      detail:
        `This feature is not implemented. ${error.route} answers 501, and ` +
        `the work is deferred to ${phasePhrase(phase)}.`,
      requestId: undefined,
      route: error.route,
      retryable: false,
    };
  }

  if (error instanceof ProblemResponse) {
    return toProblemState(error, phase);
  }

  if (error instanceof ApiError) {
    return toStatusState(error.status, error.route, error.requestId, phase);
  }

  // A rejected `fetch` is a `TypeError` in every browser, and nothing else in
  // this app throws one, so the shape is a reliable enough signal for the
  // network branch. Treating every non-ApiError as unreachable would classify a
  // bug in a screen as an outage, sending an operator to the Worker's logs when
  // the fault is here.
  if (error instanceof TypeError) {
    return {
      kind: "unreachable",
      title: "Could not reach the Admin Worker",
      detail:
        "The request did not complete, so whether this feature works is " +
        "unknown. This is a connectivity or configuration problem, not a " +
        "statement that the feature is unavailable.",
      requestId: undefined,
      route: undefined,
      retryable: true,
    };
  }

  return {
    kind: "unexpected",
    title: "Something went wrong",
    detail:
      "The console hit a failure it does not recognise, and will not guess " +
      "at its cause.",
    requestId: undefined,
    route: undefined,
    retryable: false,
  };
}

/**
 * Map a documented problem envelope.
 *
 * The code is the branch, not the status. A 403 carrying
 * `insufficient_assurance` is a step-up prompt and the same status carrying
 * `forbidden` is a refusal; both are shown with their own message, because an
 * operator told "sign in again with your second factor" and one told "you may
 * not" have different things to do next.
 */
function toProblemState(error: ProblemResponse, phase: DeferredTo): ErrorState {
  const requestId = error.requestId;
  const route = error.route;

  switch (error.code) {
    case "insufficient_assurance":
      return {
        kind: "forbidden",
        title: "Second factor required",
        detail:
          "This administrative action needs a session that has proved a " +
          "second factor. The Admin Worker refused it because this session " +
          "has not, and this console cannot raise a session's assurance.",
        requestId,
        route,
        retryable: false,
      };

    case "forbidden":
      return {
        kind: "forbidden",
        title: "Not permitted",
        detail: error.problemMessage,
        requestId,
        route,
        retryable: false,
      };

    case "not_implemented":
      // A Worker may answer with this code in a body rather than a bare 501. It
      // means the same thing and must render the same way, or the deferral
      // message would depend on which envelope the Worker happened to use.
      return {
        kind: "deferred",
        title: "Not available yet",
        detail:
          `This feature is not implemented and is deferred to ` +
          `${phasePhrase(phase)}.`,
        requestId,
        route,
        retryable: false,
      };

    default:
      return toStatusState(
        error.status,
        route,
        requestId,
        phase,
        // The envelope is documented as client-safe, so its message is
        // strictly more useful than the generic status sentence. A 429 carrying
        // "slow down" should say so, not "answered 429".
        error.problemMessage,
      );
  }
}

/** Map a bare status with no usable envelope. */
function toStatusState(
  status: number,
  route: string,
  requestId: string | undefined,
  // Not used by every branch, but passed rather than dropped so a future
  // status-specific message has the phase to hand and no signature changes.
  phase: DeferredTo,
  clientMessage: string | undefined = undefined,
): ErrorState {
  void phase;

  if (status === 401) {
    return {
      kind: "unauthenticated",
      title: "Not signed in",
      detail:
        "This request carried no valid administrative session, so there is " +
        "nothing to show. Signing in to the console is itself deferred, so " +
        "there is no way to proceed from here yet.",
      requestId,
      route,
      retryable: false,
    };
  }

  if (status === 403) {
    return {
      kind: "forbidden",
      title: "Not permitted",
      detail: clientMessage ?? "The Admin Worker refused this request.",
      requestId,
      route,
      retryable: false,
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      title: "The Admin Worker could not complete this",
      detail:
        clientMessage ??
        "The request reached the Admin Worker and it did not succeed. This " +
          "is a server-side failure.",
      requestId,
      route,
      retryable: true,
    };
  }

  return {
    kind: "unexpected",
    title: "Unexpected response",
    detail:
      clientMessage ?? `The Admin Worker answered ${status} for ${route}.`,
    requestId,
    route,
    retryable: false,
  };
}

/**
 * Whether an {@link ErrorState} means there is no administrative session.
 *
 * A separate predicate rather than a `kind` comparison at each call site,
 * because the question "should this be treated as signed out?" is asked by the
 * router and the session store and both must answer it the same way.
 */
export function isSignedOut(state: ErrorState): boolean {
  return state.kind === "unauthenticated";
}
