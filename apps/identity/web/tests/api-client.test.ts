/**
 * Tests for the HTTP client's status handling.
 *
 * The 501 path is the one this bootstrap hinges on: the Worker answers 501 on
 * every declared route except the two probes, and the app's honesty depends on
 * a 501 becoming a typed {@link NotImplementedError} rather than a fabricated
 * success or an opaque failure. These tests replace `globalThis.fetch` and
 * assert what the client does with a real `Response` — including that it sends
 * credentials, because that is the one property that cannot be checked by
 * reading the code later and forgotten.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  API_BASE_URL,
  ApiError,
  NotImplementedError,
  ProblemResponse,
  ROUTES,
  getHealth,
  normaliseHealth,
  request,
} from "../src/api/http";
import {
  getAccount,
  listSessions,
  revokeAllSessions,
  signOut,
  withdrawApplicationAccess,
} from "../src/api/self-service";

/** A `Response` with the headers the client reads, built without a body helper. */
function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Capture the `RequestInit` the client passed to `fetch`. */
function captureFetch(response: Response): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the 501 contract", () => {
  it("turns a 501 into NotImplementedError naming the route", async () => {
    captureFetch(respond(501, { error: "not_implemented" }));

    const error = await request(ROUTES.sessions).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NotImplementedError);
    expect((error as NotImplementedError).route).toBe(ROUTES.sessions);
  });

  it("does not leak the base URL into the message", async () => {
    // The message is rendered on a screen. Printing the deployment's origin
    // would disclose the topology to whoever can see the screen, and the route
    // alone is enough to identify the call.
    captureFetch(respond(501, undefined));

    const error = (await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    )) as NotImplementedError;

    expect(error.message).toContain(ROUTES.account);
    expect(error.message).not.toContain(API_BASE_URL);
  });

  it("throws for every self-service call in the bootstrap phase", async () => {
    // Every one of these routes answers 501 today. Asserted per-method so a
    // method that accidentally swallows the error — or returns a default — is
    // caught here rather than showing up as an empty list on a screen.
    captureFetch(respond(501, undefined));

    const calls: Array<() => Promise<unknown>> = [
      () => getAccount(),
      () => listSessions(),
      () => revokeAllSessions(),
      () => signOut(),
      () => withdrawApplicationAccess("client-123"),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(NotImplementedError);
    }
  });

  it("does not resolve to a value on a 501", async () => {
    // The specific failure this guards: a client that `return`s an empty array
    // on 501, which renders as "you have no sessions".
    captureFetch(respond(501, undefined));
    await expect(listSessions()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe("credentials", () => {
  it("sends cookies on every call", async () => {
    // The whole cookie design depends on this one option. The session cookie is
    // `HttpOnly`, so there is no header this app could attach instead: without
    // `include`, every authenticated call is anonymous.
    const { calls } = captureFetch(respond(200, []));

    await listSessions();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  it("sends credentials on the failure path too", async () => {
    const { calls } = captureFetch(respond(501, undefined));

    await request(ROUTES.sessions).catch(() => undefined);

    expect(calls[0]?.init?.credentials).toBe("include");
  });

  it("never puts a token in a header or the URL", async () => {
    const { calls } = captureFetch(respond(200, []));

    await listSessions();

    const call = calls[0];
    const headers = call?.init?.headers as Record<string, string> | undefined;

    // There is no bearer token, because there is no token. Asserting the
    // absence is the point: a future contributor adding one gets a red test
    // explaining that the cookie is the credential.
    expect(call?.url).not.toMatch(/token=/i);
    expect(call?.url).not.toContain("access_token");
    for (const key of Object.keys(headers ?? {})) {
      expect(key.toLowerCase()).not.toBe("authorization");
    }
  });
});

describe("non-501 failures", () => {
  it("raises ApiError with the status and the request id for a 5xx", async () => {
    captureFetch(respond(503, undefined, { "x-request-id": "req-42" }));

    const error = (await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(503);
    expect(error.requestId).toBe("req-42");
  });

  it("does not surface a non-JSON error body", async () => {
    // A Worker error envelope can quote a reason never meant for a browser.
    // An HTML error page from a proxy in front of the Worker must not become a
    // rendered message.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const error = (await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ProblemResponse);
    expect(error.message).not.toContain("Bad Gateway");
  });

  it("raises ProblemResponse for a documented envelope", async () => {
    captureFetch(
      respond(
        403,
        { error: "forbidden", error_description: "AAL2 required" },
        {
          "x-request-id": "req-7",
        },
      ),
    );

    const error = (await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    )) as ProblemResponse;

    expect(error).toBeInstanceOf(ProblemResponse);
    expect(error.code).toBe("forbidden");
    expect(error.problemMessage).toBe("AAL2 required");
    expect(error.requestId).toBe("req-7");
  });

  it("rejects an envelope with no usable error code as a plain ApiError", async () => {
    // The body is attacker-reachable, so a shape that merely *looks* like an
    // envelope must not be trusted into carrying a code the UI branches on.
    captureFetch(respond(400, { message: "no error field here" }));

    const error = (await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error).not.toBeInstanceOf(ProblemResponse);
    expect(error.status).toBe(400);
  });

  it("rejects an envelope whose code is not a string", async () => {
    captureFetch(respond(400, { error: 42 }));

    const error = await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    );

    expect(error).not.toBeInstanceOf(ProblemResponse);
  });

  it("treats an empty request id header as absent", async () => {
    // So the screen says "no request id" instead of rendering a blank that
    // looks like a value the user copied incompletely.
    captureFetch(respond(500, undefined, { "x-request-id": "   " }));

    const error = (await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error.requestId).toBeUndefined();
  });

  it("propagates a network failure as a TypeError, not as a 501", async () => {
    // A Worker outage and an unimplemented route are different facts. If a
    // network error became "not available yet", a user would be told the
    // feature is coming while the system was having an incident.
    vi.stubGlobal("fetch", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );

    const error = await request(ROUTES.account).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(NotImplementedError);
  });
});

describe("URL construction", () => {
  it("joins the base URL and the route without a double slash", async () => {
    // `//oauth/authorize` reads as a protocol-relative URL to a different
    // host in several clients, which would send the cookie somewhere else.
    const { calls } = captureFetch(respond(200, []));

    await listSessions();

    expect(calls[0]?.url).toBe(`${API_BASE_URL}${ROUTES.sessions}`);
    expect(calls[0]?.url).not.toContain("https://https://");
  });

  it("percent-encodes an identifier taken from a caller", async () => {
    const { calls } = captureFetch(respond(204, undefined));

    await withdrawApplicationAccess("client/../admin");

    expect(calls[0]?.url).toContain("client%2F..%2Fadmin");
  });
});

describe("normaliseHealth", () => {
  it("reads an ok probe", () => {
    expect(normaliseHealth({ ok: true })).toEqual({ ok: true, detail: {} });
  });

  it("keeps the rest of the body as unexamined detail", () => {
    const result = normaliseHealth({
      ok: true,
      version: "0.0.0",
      checks: [1, 2],
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toEqual({ version: "0.0.0", checks: [1, 2] });
    expect(result.detail).not.toHaveProperty("ok");
  });

  it("reports a missing ok as not live", () => {
    // A probe that says nothing about its own liveness has not asserted that it
    // is live. Defaulting to `true` would be a health display that lies in
    // exactly the situation a health display exists for. Synchronous, and
    // deliberately so: `normaliseHealth` is a pure function, and an `async` on
    // a test with no `await` in it is a test that returns a promise nobody
    // needed — which hides a real `await` added later behind one that is not.
    expect(normaliseHealth({ status: "up" }).ok).toBe(false);
    expect(normaliseHealth({}).ok).toBe(false);
    expect(normaliseHealth(null).ok).toBe(false);
    expect(normaliseHealth("ok").ok).toBe(false);
  });

  it("reports a non-true ok as not live", () => {
    // `ok: "true"` from a stringly-typed probe is not an assertion of liveness.
    expect(normaliseHealth({ ok: "true" }).ok).toBe(false);
    expect(normaliseHealth({ ok: 1 }).ok).toBe(false);
  });

  it("handles a 204 from getHealth without throwing on an empty body", async () => {
    captureFetch(respond(204, undefined));
    await expect(getHealth(ROUTES.health)).resolves.toEqual({
      ok: false,
      detail: {},
    });
  });
});
