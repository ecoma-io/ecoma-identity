/**
 * Mapping an API failure onto what a screen is allowed to say.
 *
 * Every screen in this app that awaits a call funnels its `catch` through
 * {@link toErrorState}. The reason is that the app has one failure it must
 * never get wrong: a 501 means **deferred**, and rendering it as a generic
 * failure — or worse, as a spinner that resolves to an empty state — is how a
 * bootstrap UI starts lying about itself.
 *
 * The mapping is a pure function, deliberately, and it lives apart from every
 * component so that `tests/error-state.test.ts` can assert each branch without
 * mounting anything. It is the part of the UI most worth testing and the part
 * most likely to be quietly wrong, because the wrong version still *looks*
 * fine on screen.
 *
 * What this module is **not**: a place to invent a message. Every branch names
 * what the Worker actually did. There is no "something went wrong, please try
 * again" fallback, because a generic error is exactly the sentence that hides
 * the one fact a user needs — that the thing they are looking at does not exist
 * yet.
 */

import { ApiError, NotImplementedError, ProblemResponse } from "./http";
import { phasePhrase, type DeferredTo } from "../capabilities";

/**
 * The kinds of failure a screen can be in.
 *
 * Each variant is a distinct thing the user is entitled to know, and the
 * distinction is the point of the enum:
 * - `deferred` — the Worker answered 501. The feature is not built. Name the
 *   phase.
 * - `unreachable` — the request never got an answer. The Worker may be down,
 *   or the base URL may be wrong. Not the same as deferred, and telling a user
 *   "coming soon" because the network is down sends them away from a system
 *   that is having an incident.
 * - `malformed-response` — the Worker answered 2xx with something this client
 *   cannot read. A real fault on one side or the other; the honest report is
 *   that the two disagree, not a retry suggestion.
 * - `unauthenticated` — 401. The real signed-out state. The user is not signed
 *   in; nothing about the feature being deferred is relevant to them.
 * - `forbidden` — 403. The request was refused, usually an AAL2 step-up being
 *   required. Distinct from 401 because the user *is* signed in.
 * - `server` — 5xx. The Worker's fault or a dependency's. Show the request id
 *   and say it is a server-side problem.
 * - `unexpected` — anything else. The one branch that is allowed to be vague,
 *   because at this point the app genuinely does not know what happened.
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
   * The headline. Must state what happened, not invite optimism. For
   * `deferred` this names the phase; for `server` it says the failure is
   * server-side.
   */
  readonly title: string;
  /**
   * One or two sentences of detail, safe to show to the person who triggered
   * it. Never a raw response body: see {@link ProblemResponse} for why.
   */
  readonly detail: string;
  /**
   * The request id, when the Worker sent one. The join key between this screen
   * and the Worker's logs, and the only thing that makes a user's bug report
   * actionable — so it is surfaced rather than logged to a console the user
   * cannot reach.
   */
  readonly requestId: string | undefined;
  /**
   * The route that failed, or `undefined` when the request never left. A
   * deferred state names it so the user can see which call is missing.
   */
  readonly route: string | undefined;
  /**
   * Whether a retry could plausibly help. `false` for `deferred` and
   * `forbidden`, because retrying an unimplemented route is how a user burns
   * their rate-limit budget discovering a fact this app already knows. A
   * screen may therefore render no retry button, which is not a dead control —
   * the state says why.
   */
  readonly retryable: boolean;
}

/**
 * Resolve a thrown value into an {@link ErrorState}.
 *
 * Total: it accepts `unknown` and never throws, because it is called from a
 * `catch` where the alternative is a second failure inside the error path. A
 * non-`Error` throw (a stray string, `undefined` from a bad `throw`) becomes
 * `unexpected` rather than crashing the render.
 *
 * @param error The caught value.
 * @param phase The phase the calling feature is deferred to, for the 501
 *   branch. A screen knows this from its capability entry; passing it in keeps
 *   the phase out of the error layer's own guesses, so the phase printed on a
 *   deferred screen is the one the capability table records. Typed as
 *   `DeferredTo` so this layer cannot be the source of a phase name the
 *   roadmap does not define.
 */
export function toErrorState(error: unknown, phase: DeferredTo): ErrorState {
  // 501 first, and structurally: `NotImplementedError` does not extend
  // `ApiError`, so the ordering here is not load-bearing, but keeping the
  // deferral check above the others documents that it is the branch that
  // matters most.
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
  // this app throws a `TypeError`, so the shape is a reliable enough signal
  // for the network branch. The alternative — treating every non-ApiError as
  // unreachable — would classify a bug in a screen as an outage, which is
  // worse: it sends an operator looking at the Worker when the fault is here.
  if (error instanceof TypeError) {
    return {
      kind: "unreachable",
      title: "Could not reach the Identity Worker",
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
      "The application hit a failure it does not recognise, and will not " +
      "guess at its cause.",
    requestId: undefined,
    route: undefined,
    retryable: false,
  };
}

/**
 * Map a documented problem envelope.
 *
 * The code is the branch, not the status: a `403` with
 * `error: "insufficient_assurance"` is a step-up prompt, and the same status
 * with `error: "forbidden"` is a refusal. Both are shown with their own
 * message, because a user who is told "sign in again with your second factor"
 * and a user who is told "you may not do that" have different things to do
 * next, and merging them into "access denied" loses that.
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
          "This action needs a session that has proved a second factor. " +
          "The application has not been able to raise your session's " +
          "assurance, so the request was refused.",
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
      // A Worker may answer with this code in a body rather than a bare 501.
      // It means the same thing and must be rendered the same way, or the
      // deferral message would depend on which envelope the Worker happened to
      // use.
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
        // strictly more useful than the generic status sentence. A 429
        // carrying "slow down" should say so, not "answered 429".
        error.problemMessage,
      );
  }
}

/** Map a bare status with no usable envelope. */
function toStatusState(
  status: number,
  route: string,
  requestId: string | undefined,
  // Not used by every branch, but passed rather than dropped so that a future
  // status-specific message has the phase to hand and no signature has to
  // change. `noUnusedParameters` is satisfied by the `void` below.
  phase: DeferredTo,
  /**
   * A client-safe message from the documented envelope, when one was present.
   * Preferred over the generic sentences below, because it was written to be
   * read by the person who triggered it. `undefined` when the failure carried
   * no envelope, which is the common case during bootstrap.
   */
  clientMessage: string | undefined = undefined,
): ErrorState {
  void phase;

  if (status === 401) {
    return {
      kind: "unauthenticated",
      title: "Not signed in",
      detail:
        "This request carried no valid session, so there is nothing to " +
        "show. Sign-in is itself deferred, so there is no way to proceed " +
        "from here yet.",
      requestId,
      route,
      retryable: false,
    };
  }

  if (status === 403) {
    return {
      kind: "forbidden",
      title: "Not permitted",
      detail: clientMessage ?? "The Identity Worker refused this request.",
      requestId,
      route,
      retryable: false,
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      title: "The Identity Worker could not complete this",
      detail:
        clientMessage ??
        "The request reached the Worker and the Worker did not succeed. " +
          "This is a server-side failure.",
      requestId,
      route,
      retryable: true,
    };
  }

  return {
    kind: "unexpected",
    title: "Unexpected response",
    detail:
      clientMessage ?? `The Identity Worker answered ${status} for ${route}.`,
    requestId,
    route,
    retryable: false,
  };
}

/**
 * Whether an {@link ErrorState} means the user is not signed in.
 *
 * A separate predicate rather than a `kind` comparison at each call site,
 * because the question "should I send them to the sign-in screen?" is asked by
 * the router and the session store and both must answer it the same way.
 */
export function isSignedOut(state: ErrorState): boolean {
  return state.kind === "unauthenticated";
}
