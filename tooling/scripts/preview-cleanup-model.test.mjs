/**
 * `preview-cleanup-model.test.mjs` — the delete path's arithmetic.
 *
 * WHY THIS FILE EXISTS. `previewResources()` had no test, because nothing
 * called it: the janitor does not exist yet. It was written for the delete path
 * and had never been exercised, which is the worst combination available — a
 * function whose mistakes are unrecoverable and unfalsified.
 *
 * Two were already there.
 *
 * ORDER. The function returned `identity` before `identity-admin`, while
 * `preview.deletion_order.steps` asks for the opposite and says why: "Workers go
 * in reverse dependency order — the consumers before the thing they consume —
 * so no deletion orphans a live service binding." `identity-admin` and
 * `identity-jobs` bind `IDENTITY`, so deleting `identity` first leaves two
 * Workers holding a binding to something that no longer exists.
 *
 * `order`. Every entry carried the WHOLE nine-element `steps` array, so `order`
 * was not a position at all and no caller could index by it. It is now the
 * entry's index, and the list is sorted by the manifest rather than by the order
 * this file happens to be written in.
 *
 * The tests below are ordered by what they would cost if they failed: deleting a
 * production Worker, then deleting out of order, then deleting something that
 * was never a preview's to begin with.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEPLOYABLES,
  FIXED_ENVIRONMENTS,
  RESOURCE_KINDS,
  deletionRefusal,
  isNeverDeleted,
  loadTopology,
  matchesGrammar,
  previewResources,
} from "./topology-model.mjs";

const { topology } = loadTopology();
const PR = 33;

function names(entry) {
  return entry.name === undefined ? entry.names : [entry.name];
}

test("every name previewResources returns is deletable, and deletable for a reason", () => {
  // THE FIRST TEST, AND THE ONE THAT MATTERS MOST. A janitor that deletes
  // `identity-production` is not a bug that gets a fix; it is an incident.
  //
  // The property is `deletionRefusal(...) === null` for every name the function
  // can emit, over several pull requests: no ordering mistake, no missing `{pr}`
  // substitution and no kind mismatch may produce a name the guards stop. The
  // converse is asserted too — that each name IS stopped by the grammar's own
  // rule rather than merely escaping the backstop — so a name cannot pass by
  // being absent from `never_delete` while matching nothing either.
  //
  // Written as a positive assertion on the names, not as "not in
  // never_delete": the original form here asserted `isNeverDeleted` was `true`,
  // which is backwards. A preview's own name is not on the list — that is what
  // makes it deletable — and the test passed for no reason except that the
  // backstop was broken and answered `false` for everything.
  // `999` is the cap `preview.max_pr_number` sets, and the largest value the
  // grammar's `[0-9]+` can be asked to render without truncation. A number above
  // it is refused by `validatePrNumber`, which is the manifest behaving correctly
  // and is covered by its own tests — this file asserts what a preview OWNS, so
  // it stays inside the range a preview can exist in at all.
  for (const pr of [1, 7, 33, 100, 999]) {
    for (const entry of previewResources(topology, pr)) {
      for (const name of names(entry)) {
        assert.equal(
          isNeverDeleted(topology, entry.kind, name),
          false,
          `PR ${pr}: ${entry.step} emits ${JSON.stringify(name)}, which is on ` +
            `preview.never_delete.${entry.kind} and must never be emitted`,
        );
        assert.equal(
          deletionRefusal(topology, entry.kind, name),
          null,
          `PR ${pr}: ${entry.step} emits ${JSON.stringify(name)}, which the ` +
            `guards refuse, so a janitor would skip it and leak the resource`,
        );
        assert.equal(
          matchesGrammar(topology, entry.kind, name),
          true,
          `PR ${pr}: ${entry.step} emits ${JSON.stringify(name)}, which matches ` +
            `no preview.grammar.${entry.kind} and so is not a preview resource`,
        );
      }
    }
  }
});

test("no preview name collides with a name the fixed environments declare", () => {
  // Belt and braces on the same property. `never_delete` is an explicit list, so
  // a name nobody added to it would pass the test above; this derives the fixed
  // names from the manifest instead of trusting the list to be complete.
  const fixed = new Set();
  for (const environment of FIXED_ENVIRONMENTS) {
    const config = topology.environments[environment];
    for (const deployable of DEPLOYABLES) {
      const declared = config.resources[deployable];
      fixed.add(declared.worker);
      for (const part of [
        declared.d1?.name,
        declared.kv?.name,
        declared.queue?.name,
        declared.queue?.dlq,
      ]) {
        if (part) fixed.add(part);
      }
    }
  }

  for (const entry of previewResources(topology, PR)) {
    for (const name of names(entry)) {
      assert.equal(
        fixed.has(name),
        false,
        `previewResources would delete ${JSON.stringify(name)}, which a fixed ` +
          `environment declares`,
      );
    }
  }
});

test("entries come back in exactly the manifest's deletion order", () => {
  // The property itself: the sequence `previewResources` returns IS
  // `preview.deletion_order.steps`, expanded to names. Asserting against the
  // manifest rather than a literal list means a future edit to the manifest
  // cannot leave a stale expectation here — it moves the expectation and the
  // behaviour together, which is the only way a test about ORDER can stay honest.
  const returned = previewResources(topology, PR).map((entry) => entry.step);
  assert.deepEqual(returned, topology.preview.deletion_order.steps);
});

test("a consumer Worker is deleted before the Worker it binds", () => {
  // The reason the order above exists, stated as a check rather than as prose
  // in a comment. `bindings.<deployable>.services` is the manifest's own record
  // of which Worker binds which, so this test reads the dependency graph rather
  // than restating it.
  const steps = previewResources(topology, PR);
  const at = (step) => steps.findIndex((entry) => entry.step === step);

  for (const deployable of DEPLOYABLES) {
    for (const service of topology.bindings[deployable]?.services ?? []) {
      assert.ok(
        at(`worker:${deployable}`) < at(`worker:${service}`),
        `${deployable} binds ${service}, so it must be deleted FIRST; ` +
          `worker:${deployable} is at ${at(`worker:${deployable}`)} and ` +
          `worker:${service} at ${at(`worker:${service}`)}`,
      );
    }
  }
});

test("every entry's order is its own index, not the manifest's array", () => {
  // `order` was the whole `steps` array on every entry, which made it useless
  // for its stated purpose. A caller sorting by it was sorting by nothing.
  previewResources(topology, PR).forEach((entry, index) => {
    assert.equal(
      entry.order,
      index,
      `${entry.step} reports order ${entry.order} at position ${index}`,
    );
  });
});

test("custom domains come first, so nothing answers on a public host mid-delete", () => {
  // The manifest's stated reason: "a Worker that is about to be deleted should
  // stop answering on a public hostname first, so there is no window in which a
  // hostname resolves to a half-deleted Worker."
  const first = previewResources(topology, PR)[0];
  assert.equal(first.step, "custom_domains");
  assert.equal(first.order, 0);
});

test("the D1 database is deleted last, and only ever a preview's own", () => {
  const last = previewResources(topology, PR).at(-1);
  assert.equal(last.step, "d1");
  assert.match(last.name, /-pr-\d+$/);
});

test("every name carries its own PR number, and no two PRs share a name", () => {
  // The property that makes a preview disposable rather than merely temporary:
  // if two pull requests resolved to overlapping names, one teardown would take
  // out the other's live environment.
  //
  // Per PR, names need not be distinct from EACH OTHER. `identity-pr-33` is both
  // the Worker and its queue by design — `preview.grammar.worker` and
  // `preview.grammar.queue` are the same pattern, because Cloudflare scopes a
  // script and a queue name separately and the manifest chose to share the
  // spelling. Asserting one-name-per-PR therefore asserted a falsehood and
  // failed on the manifest's own naming scheme rather than on a defect.
  //
  // What must hold is the cross-PR property: every name belongs to exactly one
  // pull request.
  const byName = new Map();
  for (const pr of [1, 7, 33, 42, 101]) {
    for (const entry of previewResources(topology, pr)) {
      for (const name of names(entry)) {
        assert.match(
          name,
          new RegExp(`(^|[-.])(pr)?${pr}([-.]|$)|pr${pr}`),
          `PR ${pr}: ${JSON.stringify(name)} does not carry its PR number`,
        );
        // Keyed on name → every PR that claims it. Asserting a name belongs to
        // exactly ONE pull request is the cross-PR property; a Map of name → PR
        // asserted it too, and failed on the Worker/Queue pair inside a single
        // PR, which is the collision the manifest intends rather than forbids.
        const owners = byName.get(name) ?? new Set();
        owners.add(pr);
        byName.set(name, owners);
      }
    }
  }

  for (const [name, owners] of byName) {
    assert.equal(
      owners.size,
      1,
      `${JSON.stringify(name)} is claimed by PRs ${[...owners].join(" and ")}; ` +
        `one PR's teardown would delete the other's live resource`,
    );
  }

  // And each PR really does get its own complete set — a PR that resolved to
  // nothing would satisfy the loop above by contributing no names at all.
  for (const pr of [1, 33]) {
    const emitted = previewResources(topology, pr).flatMap((e) => names(e));
    assert.equal(
      emitted.length > 0,
      true,
      `PR ${pr} resolved to no resources at all`,
    );
  }
});

test("deletionRefusal names WHICH guard stopped a name, not merely that one did", () => {
  // Two refusals, two very different findings: "matched no grammar" means the
  // name is not a preview's at all, while "is on the never_delete list" means the
  // grammar let it through and only the backstop caught it. Collapsing them to a
  // boolean loses the second entirely — which is the one that would have deleted
  // production.
  //
  // Production's script name is the BARE deployable name: staging appends
  // `-staging`, development appends `-development`, and production is whatever
  // is left. That is read from the manifest rather than written here, because a
  // hand-typed `identity-production` in this test would be a name that does not
  // exist — and a test asserting a fiction teaches the reader nothing.
  const productionScript =
    topology.environments.production.resources.identity.worker;

  const production = deletionRefusal(topology, "worker", productionScript);
  assert.match(
    production,
    /never_delete/,
    `${productionScript} must be refused by the never_delete list`,
  );

  const nonsense = deletionRefusal(topology, "worker", "not-a-preview");
  assert.match(nonsense, /does not match preview\.grammar\.worker/);

  const preview = deletionRefusal(topology, "worker", `identity-pr-${PR}`);
  assert.equal(preview, null, "a real preview name must not be refused");
});

test("never_delete covers every fixed Worker, and the grammar would not", () => {
  // Two independent guards, asserted as independent. If the grammar alone were
  // relied on, deleting a production Worker would depend on one regex staying
  // correct; `never_delete` is a literal list that does not.
  //
  // The names come from the manifest's own fixed environments, so this test
  // fails if an environment is added without adding its names to the list — which
  // is the actual failure mode, rather than a typo in a literal.
  for (const environment of FIXED_ENVIRONMENTS) {
    for (const deployable of DEPLOYABLES) {
      const name =
        topology.environments[environment].resources[deployable].worker;
      assert.equal(
        isNeverDeleted(topology, "worker", name),
        true,
        `${name} (${environment}) is not on preview.never_delete.workers`,
      );
      assert.equal(
        matchesGrammar(topology, "worker", name),
        false,
        `${name} must not match the preview grammar`,
      );
    }
  }
});

test("an unlisted step would sort last, not first", () => {
  // Defensive, and deliberately unreachable while `validate-topology.mjs` fails
  // on a step it cannot produce. It is here because a delete path should not
  // have an ordering DEFAULT: an unrecognised entry landing at position 0 would
  // be deleted before everything the manifest says comes before it.
  const copied = structuredClone(topology);
  copied.preview.deletion_order.steps =
    copied.preview.deletion_order.steps.filter((step) => step !== "d1");
  const entries = previewResources(copied, PR);
  assert.equal(
    entries.at(-1).step,
    "d1",
    "an entry the manifest does not list must sort last",
  );
});

test("the first step's names pass the guards instead of throwing", () => {
  // `custom_domains` is a deletion STEP; `hostname` is what `preview.grammar`
  // calls the same resource. `previewResources` emitted the step's spelling as
  // its `kind`, and `deletionRefusal` threw `preview.grammar has no entry for
  // kind "custom_domains"` — so the very first delete of every teardown died,
  // on the one step that is always present.
  //
  // Asserted against the guards rather than against the returned `kind`, so
  // this fails whichever spelling the caller happens to use: what matters is
  // that a hostname reaches the `hostname` rules.
  const first = previewResources(topology, PR)[0];
  for (const name of names(first)) {
    assert.equal(
      deletionRefusal(topology, first.kind, name),
      null,
      `${JSON.stringify(name)} must pass the guards as kind ${JSON.stringify(first.kind)}`,
    );
  }
});

test("every fixed environment's hostname, cookie, rate limit and provider is protected", () => {
  // The five kinds that had no `never_delete` list at all. `dlq`, `hostname`,
  // `rate_limit`, `cookie` and `email_provider` were guarded by the grammar
  // alone — which is the guard the manifest says must not be trusted alone, and
  // the only backstop for a Worker was a key spelled `workers` while the code
  // asked for `worker`.
  //
  // Names are read from the manifest rather than written here. A hand-typed
  // `identity.ecoma.io` would drift the moment production's host changed, and a
  // test that asserts a name nobody actually serves teaches its reader nothing.
  for (const environment of FIXED_ENVIRONMENTS) {
    const config = topology.environments[environment];
    const subject = {
      hostname: Object.values(config.hosts).filter(
        (h) => typeof h === "string",
      ),
      cookie: [topology.cookie_namespaces?.[environment]].filter(Boolean),
      rate_limit: Object.entries(config.ratelimits ?? {})
        .filter(
          ([key, value]) =>
            key !== "$comment" && value && typeof value === "object",
        )
        .map(([, value]) => value.namespace_id),
      email_provider: [config.email.service].filter(Boolean),
      dlq: [config.resources.identity?.queue?.dlq].filter(Boolean),
    };

    for (const [kind, list] of Object.entries(subject)) {
      for (const name of list) {
        assert.equal(
          isNeverDeleted(topology, kind, name),
          true,
          `${JSON.stringify(name)} (${environment}, ${kind}) is on no ` +
            `never_delete list; only the grammar guards it`,
        );
      }
    }
  }
});

test("an unknown kind is refused rather than reported as unprotected", () => {
  // The failure mode that made the first bug invisible: `isNeverDeleted` returned
  // `false` — "not on the list" — for a kind it had no list for, which is
  // indistinguishable from a genuine negative. A caller deleting on that basis
  // would get no refusal at all, and nothing would be logged.
  assert.throws(
    () => isNeverDeleted(topology, "analytics", "anything"),
    /unknown resource kind/,
    "an unknown kind must throw, not answer 'nothing is protected here'",
  );
  assert.throws(
    () => deletionRefusal(topology, "workers", "identity"),
    /unknown resource kind/,
    "the old plural spelling must now be an error rather than a silent miss",
  );
});

test("the manifest's never_delete keys are exactly the grammar's kinds", () => {
  // `validate-topology.mjs` enforces this; asserting it here too means the
  // property is stated where the delete path is reasoned about, and that a
  // failing gate has two independent owners rather than one.
  const grammarKinds = Object.keys(topology.preview.grammar).filter(
    (k) => k !== "$comment",
  );
  const neverDeleteKinds = Object.keys(topology.preview.never_delete).filter(
    (k) => k !== "$comment",
  );
  assert.deepEqual(
    [...neverDeleteKinds].sort(),
    [...grammarKinds].sort(),
    "a kind the grammar guards with no never_delete list has a dead backstop",
  );
  for (const kind of RESOURCE_KINDS) {
    assert.equal(
      grammarKinds.includes(kind),
      true,
      `RESOURCE_KINDS names ${kind}, which preview.grammar does not declare`,
    );
  }
});
