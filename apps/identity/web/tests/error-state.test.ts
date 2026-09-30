/**
 * Tests for the failure mapping every screen funnels its `catch` through.
 *
 * This is the highest-risk logic in the app, because the wrong version of it
 * still *looks* correct on screen. A 501 rendered as a generic error is a
 * plausible-looking UI that tells a user the platform is broken when it is
 * merely unbuilt. Each test below pins one branch, including the branches that
 * keep two different failures apart.
 */

import { describe, expect, it } from "vitest";

import {
  ApiError,
  NotImplementedError,
  ProblemResponse,
} from "../src/api/http";
import { isSignedOut, toErrorState } from "../src/api/errors";

const PHASE = "phase 1";

describe("toErrorState", () => {
  it("maps a 501 to the deferral, naming the route and the phase", () => {
    const state = toErrorState(
      new NotImplementedError("/self-service/sessions"),
      PHASE,
    );

    expect(state.kind).toBe("deferred");
    expect(state.detail).toContain("/self-service/sessions");
    expect(state.detail).toContain("501");
    expect(state.detail).toContain(PHASE);
  });

  it("does not offer a retry for a deferred feature", () => {
    // The route answers 501 deterministically. A retry button would teach a
    // user to re-issue a request that cannot succeed, and burn their rate
    // limit discovering a fact this app already knows.
    expect(toErrorState(new NotImplementedError("/x"), PHASE).retryable).toBe(
      false,
    );
  });

  it("maps a 401 to the real signed-out state", () => {
    const state = toErrorState(
      new ApiError(401, "/self-service/account", "r1"),
      PHASE,
    );

    expect(state.kind).toBe("unauthenticated");
    expect(isSignedOut(state)).toBe(true);
  });

  it("does not report a 401 as a deferred feature", () => {
    // The distinction that matters: 401 is about the caller, 501 is about the
    // implementation. `kind` is what a screen branches on, and a screen that
    // branched on the word "deferred" in the prose would be reading the wrong
    // field.
    const state = toErrorState(new ApiError(401, "/x", undefined), PHASE);
    expect(state.kind).toBe("unauthenticated");
    expect(state.kind).not.toBe("deferred");
  });

  it("maps a 403 to forbidden and not to unauthenticated", () => {
    // The user *is* signed in; the request was refused. Sending them to a
    // sign-in screen would be wrong.
    const state = toErrorState(new ApiError(403, "/x", undefined), PHASE);

    expect(state.kind).toBe("forbidden");
    expect(isSignedOut(state)).toBe(false);
  });

  it("maps a 5xx to a server-side failure, keeping the request id", () => {
    const state = toErrorState(new ApiError(503, "/x", "req-99"), PHASE);

    expect(state.kind).toBe("server");
    expect(state.requestId).toBe("req-99");
    expect(state.retryable).toBe(true);
    expect(state.detail).toContain("server-side");
  });

  it("treats every 5xx as server-side", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(
        toErrorState(new ApiError(status, "/x", undefined), PHASE).kind,
      ).toBe("server");
    }
  });

  it("maps a network TypeError to unreachable, not to deferred", () => {
    // A rejected fetch is what an outage or a wrong base URL looks like.
    // Calling it "not available yet" would send a user away from a system that
    // is having an incident.
    const state = toErrorState(new TypeError("Failed to fetch"), PHASE);

    expect(state.kind).toBe("unreachable");
    expect(state.retryable).toBe(true);
    expect(state.route).toBeUndefined();
  });

  it("does not classify an unknown failure as an outage", () => {
    // A bug in a screen is not a Worker outage. Sending an operator to look at
    // the Worker when the fault is in this app is a wasted incident.
    const state = toErrorState(new Error("boom"), PHASE);

    expect(state.kind).toBe("unexpected");
    expect(state.kind).not.toBe("unreachable");
  });

  it("survives a non-Error throw", () => {
    // It is called from a `catch`, where a second failure inside the error path
    // is the worst outcome. `throw undefined` is reachable from a bad library.
    for (const thrown of [
      undefined,
      null,
      "a string",
      42,
      { not: "an error" },
    ]) {
      expect(() => toErrorState(thrown, PHASE)).not.toThrow();
      expect(toErrorState(thrown, PHASE).kind).toBe("unexpected");
    }
  });

  it("always produces a title and a detail", () => {
    // No branch may render an empty panel; a screen showing an error region
    // with no text is a bug a screen-reader user would hit first.
    const cases: unknown[] = [
      new NotImplementedError("/x"),
      new ApiError(401, "/x", undefined),
      new ApiError(403, "/x", undefined),
      new ApiError(500, "/x", undefined),
      new ApiError(418, "/x", undefined),
      new TypeError("Failed to fetch"),
      new Error("boom"),
    ];

    for (const thrown of cases) {
      const state = toErrorState(thrown, PHASE);
      expect(state.title.trim().length).toBeGreaterThan(0);
      expect(state.detail.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("toErrorState with a problem envelope", () => {
  it("maps insufficient_assurance to a step-up prompt", () => {
    const problem = new ProblemResponse(
      403,
      "/self-service/factors",
      "r1",
      "insufficient_assurance",
      "administrative action requires an AAL2 session",
    );

    const state = toErrorState(problem, PHASE);

    expect(state.kind).toBe("forbidden");
    expect(state.title).toContain("Second factor");
    // Not "Access denied": the user has a specific thing to do next, and
    // merging it with a plain refusal loses that.
    expect(state.detail).not.toBe(
      "administrative action requires an AAL2 session",
    );
  });

  it("maps a plain forbidden to the server's own client-safe message", () => {
    const problem = new ProblemResponse(
      403,
      "/x",
      undefined,
      "forbidden",
      "actor is not permitted",
    );

    const state = toErrorState(problem, PHASE);

    expect(state.kind).toBe("forbidden");
    expect(state.detail).toBe("actor is not permitted");
  });

  it("maps a not_implemented code to the same deferral as a 501", () => {
    // The Worker may answer with this code in a body rather than a bare 501.
    // If the two rendered differently, the deferral message would depend on
    // which envelope the Worker happened to use.
    const problem = new ProblemResponse(
      501,
      "/self-service/sessions",
      undefined,
      "not_implemented",
      "no handler",
    );

    const state = toErrorState(problem, PHASE);

    expect(state.kind).toBe("deferred");
    expect(state.detail).toContain(PHASE);
    expect(state.retryable).toBe(false);
  });

  it("falls back to the status mapping for an unrecognised code", () => {
    const problem = new ProblemResponse(
      429,
      "/x",
      undefined,
      "rate_limited",
      "slow down",
    );
    expect(toErrorState(problem, PHASE).kind).toBe("unexpected");
  });

  it("keeps the request id through the envelope branch", () => {
    const problem = new ProblemResponse(
      500,
      "/x",
      "req-1",
      "internal_error",
      "boom",
    );
    expect(toErrorState(problem, PHASE).requestId).toBe("req-1");
  });

  it("keeps the client-safe message for a code it does not branch on", () => {
    // The envelope is documented as safe to show, so its message is strictly
    // better than the generic status sentence — a 400 saying
    // "email_address is malformed" should say that, not "answered 400".
    const problem = new ProblemResponse(
      400,
      "/x",
      undefined,
      "invalid_request",
      "invalid email_address: malformed",
    );

    expect(toErrorState(problem, PHASE).detail).toBe(
      "invalid email_address: malformed",
    );
  });
});

describe("isSignedOut", () => {
  it("is true only for the unauthenticated kind", () => {
    expect(
      isSignedOut(toErrorState(new ApiError(401, "/x", undefined), PHASE)),
    ).toBe(true);

    for (const thrown of [
      new NotImplementedError("/x"),
      new ApiError(403, "/x", undefined),
      new ApiError(500, "/x", undefined),
      new TypeError("Failed to fetch"),
    ]) {
      expect(isSignedOut(toErrorState(thrown, PHASE))).toBe(false);
    }
  });
});
