/**
 * Tests for the failure mapping every console screen funnels its `catch`
 * through.
 *
 * This is the highest-risk logic in the console, because the wrong version of it
 * still *looks* correct on screen. A 501 rendered as a generic error is a
 * plausible-looking UI that tells an operator the platform is broken when it is
 * merely unbuilt, and a 403 rendered as one flat "access denied" hides the fact
 * that the remedy is a second factor rather than different credentials.
 */

import { describe, expect, it } from "vitest";

import {
  ApiError,
  NotImplementedError,
  ProblemResponse,
} from "../src/api/http";
import { isSignedOut, toErrorState } from "../src/api/errors";

const PHASE = "phase 6";

describe("toErrorState", () => {
  it("maps a 501 to the deferral, naming the route and the phase", () => {
    const state = toErrorState(new NotImplementedError("/admin/audit"), PHASE);

    expect(state.kind).toBe("deferred");
    expect(state.detail).toContain("/admin/audit");
    expect(state.detail).toContain("501");
    expect(state.detail).toContain(PHASE);
  });

  it("does not offer a retry for a deferred feature", () => {
    // The route answers 501 deterministically. A retry button would teach an
    // operator to re-issue a request that cannot succeed, and burn their rate
    // limit discovering a fact this console already knows.
    expect(toErrorState(new NotImplementedError("/x"), PHASE).retryable).toBe(
      false,
    );
  });

  it("maps a 401 to the real signed-out state", () => {
    const state = toErrorState(
      new ApiError(401, "/admin/session", "r1"),
      PHASE,
    );

    expect(state.kind).toBe("unauthenticated");
    expect(isSignedOut(state)).toBe(true);
  });

  it("does not report a 401 as a deferred feature", () => {
    // 401 is about the operator, 501 is about the implementation. `kind` is what
    // a screen branches on; a screen branching on prose would be reading the
    // wrong field.
    const state = toErrorState(new ApiError(401, "/x", undefined), PHASE);
    expect(state.kind).toBe("unauthenticated");
    expect(state.kind).not.toBe("deferred");
  });

  it("maps a 403 to forbidden and not to unauthenticated", () => {
    // The operator *is* signed in; the request was refused. Sending them to a
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
    // Calling it "not available yet" would send an operator away from a system
    // that is having an incident.
    const state = toErrorState(new TypeError("Failed to fetch"), PHASE);

    expect(state.kind).toBe("unreachable");
    expect(state.retryable).toBe(true);
    expect(state.route).toBeUndefined();
  });

  it("does not classify an unknown failure as an outage", () => {
    // A bug in a screen is not a Worker outage. Sending an operator to the
    // Worker's logs when the fault is here is a wasted incident.
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
    // No branch may render an empty panel; a screen showing an error region with
    // no text is a bug a screen-reader user would hit first.
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
    // The single most important branch in an operator console: every command
    // that changes someone's security posture needs an AAL2 session, and an
    // operator told "access denied" has no idea what to do next.
    const problem = new ProblemResponse(
      403,
      "/admin/users/role",
      "r1",
      "insufficient_assurance",
      "administrative action requires an AAL2 session",
    );

    const state = toErrorState(problem, PHASE);

    expect(state.kind).toBe("forbidden");
    expect(state.title).toContain("Second factor");
    expect(state.detail).toContain("second factor");
    expect(state.retryable).toBe(false);
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
    // The Worker may answer with this code in a body rather than a bare 501. If
    // the two rendered differently, the deferral message would depend on which
    // envelope the Worker happened to use.
    const problem = new ProblemResponse(
      501,
      "/admin/audit",
      undefined,
      "not_implemented",
      "no handler",
    );

    const state = toErrorState(problem, PHASE);

    expect(state.kind).toBe("deferred");
    expect(state.detail).toContain(PHASE);
    expect(state.retryable).toBe(false);
  });

  it("keeps the client-safe message for a code it does not branch on", () => {
    // The envelope is documented as safe to show, so its message is strictly
    // better than the generic status sentence.
    const problem = new ProblemResponse(
      400,
      "/x",
      undefined,
      "invalid_request",
      "invalid user_id: not a uuid",
    );

    expect(toErrorState(problem, PHASE).detail).toBe(
      "invalid user_id: not a uuid",
    );
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
