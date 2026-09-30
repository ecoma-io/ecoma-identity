/**
 * Tests for the operator console's capability inventory.
 *
 * These assert the *properties* the inventory has to hold, not that it
 * currently contains a particular set of rows. A test that asserted "there are
 * exactly eight features and seven are deferred" would fail the day a feature
 * lands, which is the day the test should stop caring; what must survive that
 * day is that no row is internally contradictory and that a screen asking for a
 * feature gets a real answer.
 */

import { describe, expect, it } from "vitest";

import {
  ADMIN_ROUTES,
  CAPABILITIES,
  PHASES,
  capabilityFor,
  deferredCapabilities,
  deferralSentence,
  implementedCapabilities,
  isImplemented,
  phasePhrase,
  type Capability,
} from "../src/capabilities";

describe("the capability inventory", () => {
  it("is not empty and has no duplicate ids", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);

    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a label, a route and a backend behaviour", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.id.trim(), capability.id).not.toBe("");
      expect(capability.label.trim(), capability.id).not.toBe("");
      // A route has to look like a path. A bare word here would produce an
      // endpoint note that reads as a sentence fragment.
      expect(capability.route.startsWith("/"), capability.id).toBe(true);
      expect(capability.backendBehaviour.trim(), capability.id).not.toBe("");
    }
  });

  it("gives every deferred entry a phase, and no implemented entry one", () => {
    // This is the property the deferral screens depend on: a screen prints the
    // phase, so an entry with no phase would render a sentence naming nothing.
    // Conversely an implemented entry must not carry one, or the capability
    // table would claim a working feature is waiting for a phase.
    for (const capability of CAPABILITIES) {
      if (capability.status === "unimplemented") {
        expect(capability.deferredTo, capability.id).toBeDefined();
        expect((capability.deferredTo ?? "").trim(), capability.id).not.toBe(
          "",
        );
      } else {
        expect(capability.deferredTo, capability.id).toBeUndefined();
      }
    }
  });

  it("names every status in the closed set the type allows", () => {
    for (const capability of CAPABILITIES) {
      expect(["implemented", "unimplemented"]).toContain(capability.status);
    }
  });

  it("only claims the two live probe routes are implemented", () => {
    // The Worker's route table answers for real on `/health` and `/ready` and
    // 501s everything else. If an entry here ever claims more than that, the
    // console is asserting a route works when it does not — the exact dishonesty
    // this whole module exists to prevent.
    for (const capability of implementedCapabilities()) {
      expect(["/health", "/ready"], capability.id).toContain(capability.route);
    }
  });

  it("says 501 in the backend behaviour of every deferred entry", () => {
    // A deferred feature must name what the Worker actually answers. Without the
    // 501 in the text, the screen's endpoint note would be an assertion this
    // console cannot support.
    for (const capability of deferredCapabilities()) {
      expect(capability.backendBehaviour, capability.id).toContain("501");
    }
  });

  it("claims no administrative feature is implemented in the bootstrap phase", () => {
    // The load-bearing property for this console specifically. If an entry were
    // flipped to `implemented` before the Admin Worker answers for it, every
    // screen behind it would render a real-looking table with no data behind it.
    const implemented = implementedCapabilities().map((c) => c.id);
    expect(implemented).toEqual(["health"]);
  });
});

describe("the administrative route table", () => {
  it("names only Admin Worker routes", () => {
    // The Admin Worker reaches identity through a private service binding. A
    // console route that pointed at an Identity Worker path or an OAuth path
    // would assert a topology the deployment does not have, and would sit one
    // base URL away from bypassing the administrative boundary.
    for (const path of Object.values(ADMIN_ROUTES)) {
      expect(path, path).not.toMatch(/^\/oauth\//);
      expect(path, path).not.toMatch(/^\/\.well-known\//);
    }
  });

  it("uses the /admin prefix for every administrative route", () => {
    for (const [name, path] of Object.entries(ADMIN_ROUTES)) {
      if (name === "health" || name === "ready") {
        continue;
      }
      expect(path, name).toMatch(/^\/admin\//);
    }
  });

  it("gives every administrative route a path", () => {
    for (const [name, path] of Object.entries(ADMIN_ROUTES)) {
      expect(path.startsWith("/"), name).toBe(true);
    }
  });
});

describe("capabilityFor", () => {
  it("finds an entry by id", () => {
    expect(capabilityFor("audit-log")?.id).toBe("audit-log");
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    // A screen with a typo must render a visible wrong state, not crash the
    // console. `CapabilityGate` turns this into a "no inventory entry names
    // this feature" panel, which is a bug a reviewer can see.
    expect(capabilityFor("no-such-feature")).toBeUndefined();
  });
});

describe("isImplemented", () => {
  it("is true only for implemented entries", () => {
    for (const capability of CAPABILITIES) {
      expect(isImplemented(capability.id)).toBe(
        capability.status === "implemented",
      );
    }
  });

  it("is false for an unknown feature", () => {
    // The load-bearing case: a feature not in the inventory must not get the
    // benefit of the doubt, or a typo would render a screen's real content on
    // the strength of a misspelling.
    expect(isImplemented("no-such-feature")).toBe(false);
  });
});

describe("the derived lists", () => {
  it("partition the inventory with no overlap and nothing missing", () => {
    const implemented = implementedCapabilities().map((c) => c.id);
    const deferred = deferredCapabilities().map((c) => c.id);

    const overlap = implemented.filter((id) => deferred.includes(id));
    expect(overlap).toEqual([]);

    expect(implemented.length + deferred.length).toBe(CAPABILITIES.length);
  });

  it("preserves inventory order", () => {
    // Order is the operator's journey, and a list reordered by a filter would
    // read as a different priority.
    const deferred = deferredCapabilities().map((c) => c.id);
    const inInventoryOrder = CAPABILITIES.filter(
      (c) => c.status === "unimplemented",
    ).map((c) => c.id);
    expect(deferred).toEqual(inInventoryOrder);
  });
});

describe("the canonical phase vocabulary", () => {
  it("uses only phases the roadmap defines, anywhere in the console", () => {
    // The point of the closed union, asserted at runtime so it survives a cast,
    // a hand-built capability, or a value arriving from a test double.
    // `docs/roadmap/phases.md` owns phase names, and a fourth spelling appearing
    // here is the exact defect this change fixes. This is the console's
    // equivalent of what `check-architecture.mjs` does for module boundaries.
    for (const capability of CAPABILITIES) {
      if (capability.status === "unimplemented") {
        expect(
          Object.hasOwn(PHASES, capability.deferredTo),
          `${capability.id} defers to "${capability.deferredTo}", which is not a roadmap phase`,
        ).toBe(true);
      }
    }
  });

  it("defers nothing to phase 0, which is where this repository already is", () => {
    // Phase 0 exists in the union solely for `CapabilityGate`'s unknown-id
    // fallback, where the "deferral" is a bug in the current phase rather than
    // work scheduled for a later one. No administrative feature belongs there.
    const deferredToBootstrap = CAPABILITIES.filter(
      (capability) =>
        capability.status === "unimplemented" &&
        capability.deferredTo === "phase 0",
    );

    expect(deferredToBootstrap.map((capability) => capability.id)).toEqual([]);
  });

  it("gives no unimplemented feature an undefined phase", () => {
    // `docs/README.md` defines `DEFERRED` as "named, with the phase that will
    // build it". A deferral with no phase satisfies half that sentence, and an
    // operator reading a screen would have to be told a phase that does not
    // exist — which is how prose like "the audit query implementation phase"
    // got into this file in the first place.
    for (const capability of CAPABILITIES) {
      if (capability.status === "unimplemented") {
        expect(
          capability.deferredTo,
          `${capability.id} is unimplemented with no phase`,
        ).toBeDefined();
        expect(
          String(capability.deferredTo).trim(),
          `${capability.id} has a blank phase`,
        ).not.toBe("");
      }
    }
  });

  it("names every phase a human could look up, with a label beside the number", () => {
    // A bare number tells an operator nothing about what it means. The label is
    // what the deferred screens print, and it has to be the roadmap's own
    // section heading rather than a paraphrase that can drift.
    for (const [phase, label] of Object.entries(PHASES)) {
      expect(label.trim(), phase).not.toBe("");
    }
  });

  it("renders a phase as a number and a label, and carries no date", () => {
    // `phases.md` is deliberately not a schedule: it has no dates, because this
    // repository is not in a position to make one and a dated plan that slips
    // teaches everybody to ignore the plan. An operator must never read a phase
    // as a delivery commitment, so the phrase is checked for months, quarters
    // and years.
    const phrase = phasePhrase("phase 6");

    expect(phrase).toBe("phase 6 (Administration)");
    for (const month of [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]) {
      expect(phrase, month).not.toContain(month);
    }
    expect(phrase).not.toMatch(/\bQ[1-4]\b/);
    expect(phrase).not.toMatch(/\b20\d{2}\b/);
  });
});

describe("deferralSentence", () => {
  it("names the feature and the phase for a deferred entry", () => {
    const capability = capabilityFor("audit-log");
    expect(capability).toBeDefined();

    const sentence = deferralSentence(capability as Capability);

    // All three parts are load-bearing: the feature so the operator knows what
    // is missing, "not available yet" so they know it is not broken, and the
    // phase so they know it is scheduled rather than abandoned.
    expect(sentence).toContain("Read the audit log");
    expect(sentence).toContain("not available yet");
    // The phase reads as a number and a label: the number is the link into
    // `docs/roadmap/phases.md`, the label is what the operator takes away. A
    // sentence naming a phase the roadmap does not define would be worse than
    // naming none, so the number is what the test pins.
    expect(sentence).toContain("phase 6");
    expect(sentence).toContain("Administration");
  });

  it("returns undefined for an implemented entry", () => {
    // So a template interpolating it renders nothing rather than claiming a
    // working feature is waiting for a phase.
    const health = capabilityFor("health");
    expect(health).toBeDefined();
    expect(deferralSentence(health as Capability)).toBeUndefined();
  });

  it("needs no fallback for a missing phase, because the type forbids one", () => {
    // There used to be a fallback string for a deferred capability with no
    // phase, and it was a second invisible owner of the phase vocabulary: a name
    // invented in this module, for an entry that should never exist. The
    // `Capability` union now requires `deferredTo` whenever the status is
    // `unimplemented`, so the branch is a compile error instead of a sentence.
    //
    // The comment below is the assertion: it must not compile. If a future
    // contributor weakens the union back to an optional phase, `vue-tsc` fails
    // here, and that is the point — the defect this change fixes cannot come
    // back through a string.
    const incomplete = {
      id: "hand-built",
      label: "Something",
      route: "/nope",
      status: "unimplemented",
      backendBehaviour: "501.",
    } as const;
    // @ts-expect-error an unimplemented capability must carry a phase
    const asCapability: Capability = incomplete;
    expect(asCapability.status).toBe("unimplemented");
  });
});
