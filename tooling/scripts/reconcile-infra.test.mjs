/**
 * `reconcile-infra.test.mjs` — the Cloudflare lookups, against a fake that is
 * checked against Cloudflare's published contract.
 *
 * WHY THIS FILE EXISTS. `reconcile-infra.mjs` looks up every D1 database, KV
 * namespace and queue id by exact name over `fetch`. It ran green for a full
 * deploy cycle against a hand-written mock, and then failed against Cloudflare
 * with
 *
 *     HTTP 400 {"code":7400,"message":"Invalid property: name => Required"}
 *
 * The mock had been built from the author's assumption that D1 paginates in a
 * request body, and the mock agreed with the author. `/accounts/{account}/d1/
 * database` serves BOTH `d1-list-databases` (GET) and `d1-create-database`
 * (POST, body required `['name']`), so the POST did not complain about
 * pagination — it complained about a missing name, which is a property this
 * script never asked about.
 *
 * That is the whole lesson, and it is why this fake asserts the METHOD and the
 * response shape against the documented contract rather than against whatever
 * the code happens to send. A mock that agrees with the code cannot catch the
 * code being wrong about the world.
 *
 * THE THREE THINGS THAT WERE WRONG, all of which a lenient fake accepts:
 *
 *   1. the verb on D1 (POST created, GET lists);
 *   2. pagination: `result_info` has `count`/`page`/`per_page`/`total_count` and
 *      NO `has_more`, so `if (!info.has_more) break` stopped after page 1 and
 *      reported page-2 names as nonexistent — a wrong answer shaped like a
 *      right one;
 *   3. the name field: `name` for D1, `title` for a KV namespace, `queue_name`
 *      for a queue. Matching `entry.name` found D1 and nothing else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/** The account id this repository declares in infra-topology/topology.json. */
const ACCOUNT = "406bdb82319b162b09bf5f137a156600";

/**
 * The contract, restated from Cloudflare's published API schema. The fake below
 * is written against THIS, not against the script under test.
 *
 * `createMethod` and `requiredCreateFields` describe the CREATE operation that
 * shares each path with the listing. For D1 that overlap is the trap this file
 * was written for; for KV and queues the create path is separate in Cloudflare's
 * schema but shares the element shape, and recording it here keeps the fake
 * honest about all three rather than special-casing the one that bit.
 *
 * `element.name` and `element.id` are the LISTING element's fields. They are the
 * fields a create response carries too, because a create returns the resource
 * it made in the same shape a listing returns it in.
 */
const CONTRACT = {
  d1: {
    method: "GET",
    path: `/client/v4/accounts/${ACCOUNT}/d1/database`,
    // `d1-create-database` also lives on this path and REQUIRES `name`. A POST
    // here with no name is answered 400 / code 7400, which is the exact
    // failure this file exists to keep from happening again.
    createMethod: "POST",
    requiredCreateFields: ["name"],
    element: { name: "name", id: "uuid" },
  },
  kv: {
    method: "GET",
    path: `/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces`,
    createMethod: "POST",
    requiredCreateFields: ["title"],
    element: { name: "title", id: "id" },
  },
  queue: {
    method: "GET",
    path: `/client/v4/accounts/${ACCOUNT}/queues`,
    createMethod: "POST",
    requiredCreateFields: ["queue_name"],
    element: { name: "queue_name", id: "queue_id" },
  },
};

/**
 * A Cloudflare stand-in that enforces the contract above.
 *
 * `inventory` maps a kind to the full set of resources that exist in the fake
 * account. It is paginated at `per_page` exactly as Cloudflare paginates, and it
 * reports `result_info` with the four fields Cloudflare reports and no others.
 *
 * CREATE IS SUPPORTED, and it mutates the inventory — a POST that passes the
 * required-field check appends to the fake account, exactly as Cloudflare does.
 * That is what lets a test distinguish "found it" from "made it and then found
 * it": the descriptor's id must equal the created element's id either way, but
 * the CALL LOG says which happened. `calls` records everything, and `created`
 * records only what the script made.
 *
 * Returns `{ calls, created, restore }`.
 */
function fakeCloudflare({
  inventory,
  perPage = 100,
  duplicateAfterCreate = null,
}) {
  const calls = [];
  const created = [];
  // Mutated in place so a re-list sees the create, which is the whole point of
  // the fake having a create at all.
  const state = {
    d1: [...(inventory.d1 ?? [])],
    kv: [...(inventory.kv ?? [])],
    queue: [...(inventory.queue ?? [])],
  };
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const kind = Object.keys(CONTRACT).find(
      (k) => parsed.pathname === CONTRACT[k].path,
    );
    if (!kind) {
      return jsonResponse(404, {
        success: false,
        errors: [
          { code: 7003, message: "Could not route to the requested path" },
        ],
      });
    }
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      kind,
      method,
      url: String(url),
      body,
      pathname: parsed.pathname,
    });

    // The trap this fake exists to set: POST on a path that also serves GET is
    // the CREATE operation, and it validates a required field the script never
    // supplies. Reproduce Cloudflare's own error, not a generic one.
    if (method === CONTRACT[kind].createMethod) {
      const missing = CONTRACT[kind].requiredCreateFields.filter(
        (f) => body?.[f] === undefined,
      );
      if (missing.length > 0) {
        return jsonResponse(400, {
          success: false,
          errors: [
            {
              code: 7400,
              message: `Invalid property: ${missing[0]} => Required`,
            },
          ],
        });
      }
      const nameField = CONTRACT[kind].element.name;
      const idField = CONTRACT[kind].element.id;
      const name = body[nameField];
      const element = {
        [idField]: `created-${kind}-${state[kind].length + 1}`,
        [nameField]: name,
      };
      state[kind].push(element);
      created.push({ kind, name, element });
      // A fault the script must survive: a create that somehow leaves TWO
      // resources under one name. Cloudflare has no idempotency key, so the
      // duplicate check is the only thing standing between that and a binding
      // chosen at random.
      if (duplicateAfterCreate && duplicateAfterCreate[kind] === name) {
        state[kind].push({ [idField]: `impostor-${kind}`, [nameField]: name });
      }
      // Synchronous: 200 with the resource inline, no 202, no polling.
      return jsonResponse(200, {
        success: true,
        errors: [],
        messages: [],
        result: element,
        result_info: null,
      });
    }
    if (method !== CONTRACT[kind].method) {
      return jsonResponse(405, {
        success: false,
        errors: [{ code: 7000, message: "Method not allowed" }],
      });
    }

    const all = state[kind];
    const page = Number(parsed.searchParams.get("page") ?? "1");
    const size = Number(parsed.searchParams.get("per_page") ?? String(perPage));
    const slice = all.slice((page - 1) * size, page * size);
    return jsonResponse(200, {
      success: true,
      errors: [],
      messages: [],
      result: slice,
      // Exactly Cloudflare's four fields. Notably NO `has_more`.
      result_info: {
        count: slice.length,
        page,
        per_page: size,
        total_count: all.length,
      },
    });
  };

  return {
    calls,
    created,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/**
 * Load the module fresh with a given `fetch` in place.
 *
 * The token is read from the environment by the script and never passed as an
 * argument. The sentinel is deliberately recognisable so a test can assert it
 * does not turn up in the descriptor — a descriptor carrying the credential
 * that resolved it would be a file worth exfiltrating.
 */
const TOKEN = "cf-token-sentinel-that-must-not-be-written";

async function withReconciler(fake, fn) {
  const module = await import("./reconcile-infra.mjs");
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  try {
    return await fn(module);
  } finally {
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    fake.restore();
  }
}

/**
 * Exactly the resources `infra-topology/topology.json` declares for staging.
 *
 * Read from the manifest rather than written by hand on purpose: a fixture that
 * lists fewer resources than the topology demands fails every test for the
 * uninteresting reason that a namespace is missing, which is a slow way to
 * learn that your fixture is stale.
 */
const INVENTORY = {
  d1: [
    { uuid: "db-uuid-1", name: "ecoma-identity-staging" },
    { uuid: "db-uuid-2", name: "ecoma-identity-development" },
  ],
  kv: [
    { id: "kv-id-1", title: "identity-staging-kv" },
    { id: "kv-id-2", title: "jobs-staging-kv" },
  ],
  queue: [
    { queue_id: "q-1", queue_name: "identity-staging" },
    { queue_id: "q-2", queue_name: "identity-staging-dlq" },
  ],
};

test("every lookup is a GET — a POST on these paths is a CREATE", async () => {
  const fake = fakeCloudflare({ inventory: INVENTORY });
  await withReconciler(fake, async ({ reconcile }) => {
    await reconcile("staging", "/tmp/reconcile-test-1.json");
  });
  assert.ok(fake.calls.length > 0, "the script must have called Cloudflare");
  for (const call of fake.calls) {
    assert.equal(
      call.method,
      "GET",
      `${call.kind} was called with ${call.method}. ${call.pathname} serves ` +
        `GET for listing and POST for CREATING, so a POST here is a create ` +
        `request missing its required "name" field.`,
    );
    assert.equal(
      call.body,
      undefined,
      `${call.kind} must send no request body`,
    );
  }
});

test("pagination uses result_info.total_count and reads every page", async () => {
  // 250 D1 databases with per_page 100 means the staging one can be on any page.
  // Put it LAST so stopping after page 1 — the `has_more` bug — reports it
  // missing. This is the regression that a single-page fake cannot catch.
  const many = Array.from({ length: 249 }, (_, i) => ({
    uuid: `db-${i}`,
    name: `filler-${String(i).padStart(3, "0")}`,
  }));
  const inventory = {
    ...INVENTORY,
    d1: [...many, { uuid: "db-uuid-1", name: "ecoma-identity-staging" }],
  };
  const fake = fakeCloudflare({ inventory, perPage: 100 });
  const descriptor = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-2.json"),
  );

  assert.equal(
    descriptor.descriptor.resources.d1["ecoma-identity-staging"].id,
    "db-uuid-1",
    "a name on page 3 must be FOUND, not reported missing",
  );
  const d1Calls = fake.calls.filter((c) => c.kind === "d1");
  assert.equal(d1Calls.length, 3, "250 results at 100 per page is three GETs");
  assert.deepEqual(
    d1Calls.map((c) => new URL(c.url).searchParams.get("page")),
    ["1", "2", "3"],
  );
});

test("a KV namespace is found by `title`, not by `name`", async () => {
  // The KV list element carries NO `name` field at all. A matcher reading
  // `entry.name` finds nothing and reports the namespace as missing.
  const inventory = {
    ...INVENTORY,
    kv: [
      { id: "kv-id-1", title: "identity-staging-kv" },
      { id: "kv-id-2", title: "jobs-staging-kv" },
    ],
  };
  const fake = fakeCloudflare({ inventory });
  const descriptor = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-3.json"),
  );
  assert.equal(
    descriptor.descriptor.resources.kv["identity-staging-kv"].id,
    "kv-id-1",
  );
});

test("a queue is found by `queue_name`, not by `name`", async () => {
  const fake = fakeCloudflare({ inventory: INVENTORY });
  const descriptor = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-4.json"),
  );
  assert.equal(
    descriptor.descriptor.resources.queue["identity-staging"].id,
    "q-1",
  );
  assert.equal(
    descriptor.descriptor.resources.queue["identity-staging-dlq"].id,
    "q-2",
  );
});

test("a listing with no total_count is refused rather than silently truncated", async () => {
  // The failure mode this guards is the dangerous one: `result_info.has_more` is
  // not a Cloudflare field, so code reading it gets `undefined`, stops at page 1,
  // and reports the rest of the account as nonexistent — confidently.
  const original = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  globalThis.fetch = async () =>
    jsonResponse(200, {
      success: true,
      errors: [],
      messages: [],
      result: [{ uuid: "db-uuid-1", name: "ecoma-identity-staging" }],
      result_info: { count: 1, page: 1, per_page: 100 },
    });
  const module = await import("./reconcile-infra.mjs");
  try {
    await assert.rejects(
      () => module.reconcile("staging", "/tmp/reconcile-test-5.json"),
      /cannot tell whether it has seen every page|total_count/i,
      "an unpaginatable listing must fail loudly, not resolve from page 1",
    );
  } finally {
    globalThis.fetch = original;
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  }
});

test("the descriptor carries resource ids but never the token that fetched them", async () => {
  const fake = fakeCloudflare({ inventory: INVENTORY });
  const { descriptor } = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-8.json"),
  );
  const written = JSON.stringify(descriptor);
  assert.ok(
    !written.includes(TOKEN),
    `the descriptor must not carry the credential:\n${written}`,
  );
  assert.equal(descriptor.account, "406bdb82319b162b09bf5f137a156600");
  assert.ok(
    descriptor.reconciled_at,
    "an unattributed descriptor is a bag of ids",
  );
});

test("a name that does not exist is CREATED, not reported missing", async () => {
  // This is the reversal ADR-0021 records. The account starts empty; a deploy
  // that refuses to run against an empty account never runs at all.
  const inventory = {
    ...INVENTORY,
    d1: [{ uuid: "db-uuid-2", name: "somebody-elses-db" }],
  };
  const fake = fakeCloudflare({ inventory });
  const { descriptor } = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-6.json"),
  );
  assert.equal(
    descriptor.resources.d1["ecoma-identity-staging"].id,
    "created-d1-2",
    "the staging database must have been made, with the id the account reports",
  );
  assert.equal(
    fake.created.filter((c) => c.kind === "d1").length,
    1,
    "exactly one d1 create — the other named database is not ours to touch",
  );
});

test("every missing kind is created with the verb, path and body field Cloudflare requires", async () => {
  // The per-kind create field is a THIRD naming, distinct from both the listing
  // id field and the common `name`: `title` for KV, `queue_name` for a queue.
  // A create that sends `{name: ...}` to the KV endpoint provisions nothing and
  // Cloudflare answers about a property the script never mentioned.
  const fake = fakeCloudflare({ inventory: { d1: [], kv: [], queue: [] } });
  const { descriptor } = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-9.json"),
  );

  const creates = fake.calls.filter((c) => c.method === "POST");
  assert.deepEqual(
    [...new Set(creates.map((c) => c.kind))].sort(),
    ["d1", "kv", "queue"],
    "all three kinds must be created on an empty account",
  );
  // Indexed by (kind, name), not by kind: two deployables own two KV
  // namespaces, and keying by kind alone silently keeps only the last one.
  const createdBy = new Map(
    creates.map((c) => [
      `${c.kind}/${c.body[CONTRACT[c.kind].element.name]}`,
      c,
    ]),
  );
  assert.equal(createdBy.get("d1/ecoma-identity-staging").method, "POST");
  assert.ok(
    createdBy.has("kv/identity-staging-kv"),
    "the identity KV is created",
  );
  assert.ok(createdBy.has("kv/jobs-staging-kv"), "the jobs KV is created");
  assert.ok(createdBy.has("queue/identity-staging"));
  // The body field per kind, which is what the whole assertion is about.
  assert.equal(
    createdBy.get("kv/identity-staging-kv").body.title,
    "identity-staging-kv",
  );
  assert.equal(
    createdBy.get("kv/identity-staging-kv").body.name,
    undefined,
    "a KV namespace is created by `title`; sending `name` provisions nothing",
  );
  // And the second queue — the DLQ is a separate name and a separate resource.
  assert.equal(
    fake.created.filter((c) => c.name === "identity-staging-dlq").length,
    1,
    "the dead-letter queue is its own resource and must be created too",
  );

  // The descriptor must be complete, not partial.
  assert.equal(Object.keys(descriptor.resources.d1).length, 1);
  assert.equal(
    Object.keys(descriptor.resources.kv).length,
    2,
    "identity + jobs KV",
  );
  assert.equal(
    Object.keys(descriptor.resources.queue).length,
    2,
    "queue + dlq",
  );
});

test("the bound id comes from a re-list, not from the create response", async () => {
  // A create response is what Cloudflare SAYS it made; a re-list is what the
  // account CONTAINS. The reconciler must not bind the former.
  const fake = fakeCloudflare({ inventory: { d1: [], kv: [], queue: [] } });
  const { descriptor } = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-10.json"),
  );
  const createdName = "ecoma-identity-staging";
  const fromCreate = fake.created.find((c) => c.name === createdName).element
    .uuid;
  // Same value here, because the fake is consistent — what is asserted is the
  // CALL that produced the binding, not the coincidence of the id.
  assert.equal(descriptor.resources.d1[createdName].id, fromCreate);

  // The order is the point: a listing strictly AFTER the create. `findIndex` on
  // the POST, then assert at least one GET follows it.
  //
  // The exact URL is what makes this bite. Both listings ask for page 1
  // per_page 100 and carry no distinguishing parameter, so an earlier version of
  // this assertion compared URLs, found the pre-create and the post-create
  // listing byte-identical, and passed a mutation that skipped the re-list
  // entirely. Comparing positions in the call log is what distinguishes them.
  const d1Calls = fake.calls.filter((c) => c.kind === "d1");
  const createAt = d1Calls.findIndex((c) => c.method === "POST");
  assert.ok(createAt >= 0, "the d1 create must have happened");
  const listingsAfterCreate = d1Calls
    .slice(createAt + 1)
    .filter((c) => c.method === "GET");
  assert.equal(
    listingsAfterCreate.length,
    2,
    `expected one listing inside createResource and one before the descriptor is resolved:\n${JSON.stringify(
      d1Calls.map((c) => c.method),
      null,
      2,
    )}`,
  );
});

test("a create that leaves a duplicate name is refused, not resolved to one of them", async () => {
  // No Cloudflare create has an idempotency key, so a concurrent create can
  // produce two resources under one name. The duplicate check is the only guard.
  const fake = fakeCloudflare({
    inventory: { d1: [], kv: [], queue: [] },
    duplicateAfterCreate: { d1: "ecoma-identity-staging" },
  });
  await withReconciler(fake, async ({ reconcile }) => {
    await assert.rejects(
      () => reconcile("staging", "/tmp/reconcile-test-11.json"),
      /2 d1 resources are named/,
      "binding one of two same-named databases is how a deploy writes into the wrong one",
    );
  });
});

test("--deployable asks for one deployable's resources and no others", async () => {
  // The four staging jobs run in parallel, one per deployable. Each must not be
  // charged a listing of resources it does not bind — and must not create them.
  const fake = fakeCloudflare({ inventory: { d1: [], kv: [], queue: [] } });
  await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-12.json", {
      deployable: "identity-jobs",
    }),
  );
  assert.equal(
    fake.created.filter((c) => c.name === "jobs-staging-kv").length,
    1,
    "the jobs KV must be created",
  );
  assert.equal(
    fake.created.filter((c) => c.name !== "jobs-staging-kv").length,
    0,
    `identity-jobs owns no D1 and no queue; nothing else may be provisioned:\n${JSON.stringify(fake.created)}`,
  );
  assert.equal(
    fake.calls
      .filter((c) => c.method === "GET")
      .map((c) => c.kind)
      .filter((k) => k === "d1").length,
    0,
    "no D1 listing may happen for a deployable that declares no D1",
  );
});

test("a deployable declaring no resources makes no API call at all", async () => {
  // `identity-admin` and `home-web` declare nothing. Three listings to learn
  // that is three round trips per run, four times over, for an answer that is
  // already in topology.json.
  const fake = fakeCloudflare({ inventory: { d1: [], kv: [], queue: [] } });
  const { descriptor } = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-13.json", {
      deployable: "identity-admin",
    }),
  );
  assert.equal(
    fake.calls.length,
    0,
    `nothing should have been called:\n${JSON.stringify(fake.calls, null, 2)}`,
  );
  assert.equal(
    descriptor.resources.d1 && Object.keys(descriptor.resources.d1).length,
    0,
  );
});

test("an account with nothing in it reconciles to a complete descriptor and exits zero", async () => {
  // The first deploy onto a fresh account. It must succeed, not fail.
  const fake = fakeCloudflare({ inventory: { d1: [], kv: [], queue: [] } });
  const { descriptor } = await withReconciler(fake, ({ reconcile }) =>
    reconcile("staging", "/tmp/reconcile-test-14.json"),
  );
  assert.equal(descriptor.account, ACCOUNT);
  assert.equal(descriptor.environment, "staging");
  assert.equal(Object.keys(descriptor.resources.d1).length, 1);
  assert.equal(Object.keys(descriptor.resources.kv).length, 2);
  assert.equal(Object.keys(descriptor.resources.queue).length, 2);
  for (const [kind, bucket] of Object.entries(descriptor.resources)) {
    for (const [name, entry] of Object.entries(bucket)) {
      assert.ok(
        typeof entry.id === "string" && entry.id.length > 0,
        `${kind}/${name} bound an empty id`,
      );
    }
  }
});

test("an unknown --deployable is refused rather than silently reconciling everything", async () => {
  // A typo in the flag would otherwise reconcile the whole environment — and on
  // an empty account, provision all of it.
  const fake = fakeCloudflare({ inventory: { d1: [], kv: [], queue: [] } });
  await withReconciler(fake, async ({ reconcile }) => {
    await assert.rejects(
      () =>
        reconcile("staging", "/tmp/reconcile-test-15.json", {
          deployable: "identit-admin",
        }),
      /no deployable named "identit-admin"/,
      "a misspelled deployable must not fall back to reconciling everything",
    );
  });
  assert.equal(fake.calls.length, 0);
});

test("a duplicate name is refused rather than resolved to one of them", async () => {
  const inventory = {
    ...INVENTORY,
    d1: [
      { uuid: "db-a", name: "ecoma-identity-staging" },
      { uuid: "db-b", name: "ecoma-identity-staging" },
    ],
  };
  const fake = fakeCloudflare({ inventory });
  await withReconciler(fake, async ({ reconcile }) => {
    await assert.rejects(
      () => reconcile("staging", "/tmp/reconcile-test-7.json"),
      /2 d1 resources are named/,
      "picking one of two same-named databases is how a deploy writes into the wrong one",
    );
  });
});
