/**
 * Tests for the capability gate and the deferred panel it renders.
 *
 * The gate is where a console screen decides between real content and an honest
 * deferral, so these assert both halves:
 * - an unimplemented feature renders the deferral and **not the slot**, which is
 *   what stops a screen showing an empty table next to a message saying the
 *   query does not exist;
 * - the deferral text actually names the phase, because a screen that says only
 *   "coming soon" has told an operator nothing checkable.
 */

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import CapabilityGate from "../src/components/CapabilityGate.vue";
import DeferredFeature from "../src/components/DeferredFeature.vue";
import { capabilityFor, isImplemented } from "../src/capabilities";
import { NotImplementedError, ProblemResponse } from "../src/api/http";
import { toErrorState } from "../src/api/errors";

describe("CapabilityGate", () => {
  it("renders the deferral and withholds the slot for a deferred feature", () => {
    const wrapper = mount(CapabilityGate, {
      props: { featureId: "audit-log" },
      slots: { default: "<p>SECRET SLOT CONTENT</p>" },
    });

    expect(wrapper.text()).toContain("Not available yet");
    expect(wrapper.text()).toContain("phase 6");
    // The load-bearing assertion: the real content must not appear at all.
    expect(wrapper.text()).not.toContain("SECRET SLOT CONTENT");
  });

  it("renders the slot for an implemented feature", () => {
    const wrapper = mount(CapabilityGate, {
      props: { featureId: "health" },
      slots: { default: "<p>REAL CONTENT</p>" },
    });

    expect(wrapper.text()).toContain("REAL CONTENT");
    expect(wrapper.text()).not.toContain("Not available yet");
  });

  it("shows a visible wrong state for an unknown id rather than the slot", () => {
    // A typo in a `feature-id` must not render a screen's real content on the
    // strength of a misspelling.
    const wrapper = mount(CapabilityGate, {
      props: { featureId: "no-such-feature" },
      slots: { default: "<p>SECRET SLOT CONTENT</p>" },
    });

    expect(wrapper.text()).not.toContain("SECRET SLOT CONTENT");
    expect(wrapper.text()).toContain("no inventory entry names this feature");
  });

  it("renders the slot and withholds the deferral for an implemented feature", () => {
    // `health` is the one live route, so a supplied error must not smuggle a
    // deferral onto a working feature.
    const errorState = toErrorState(
      new ProblemResponse(503, "/health", "req-5", "internal_error", "boom"),
      "phase 6",
    );

    const wrapper = mount(CapabilityGate, {
      props: { featureId: "health", errorState },
      slots: { default: "<p>REAL CONTENT</p>" },
    });

    // The slot is the implemented path and owns its own error rendering; the
    // gate's job is only to choose between the two.
    expect(wrapper.text()).toContain("REAL CONTENT");
    expect(wrapper.text()).not.toContain("Not available yet");
  });

  it("shows a real error in place of the deferral for a deferred feature", () => {
    // A 5xx while a feature is deferred is a different fact and must not render
    // as a deferral — an operator told "coming soon" during an incident is an
    // operator who does not report the outage.
    const errorState = toErrorState(
      new ProblemResponse(
        503,
        "/admin/users",
        "req-5",
        "internal_error",
        "boom",
      ),
      "phase 6",
    );

    const wrapper = mount(CapabilityGate, {
      props: { featureId: "user-search", errorState },
      slots: { default: "<p>SECRET SLOT CONTENT</p>" },
    });

    expect(wrapper.text()).toContain("req-5");
    expect(wrapper.text()).toContain("could not complete");
    expect(wrapper.text()).not.toContain("Not available yet");
    expect(wrapper.text()).not.toContain("SECRET SLOT CONTENT");
  });
});

describe("DeferredFeature", () => {
  it("names the endpoint and what it answers", () => {
    // The endpoint note is what makes the screen verifiable: a reader can curl
    // the route and confirm it really does answer 501. A deferral that only
    // apologises cannot be checked against anything.
    const capability = capabilityFor("user-search");
    const wrapper = mount(DeferredFeature, {
      props: { capability: capability! },
    });

    expect(wrapper.text()).toContain("/admin/users");
    expect(wrapper.text()).toContain("501");
  });

  it("renders no retry control for a deferred feature", () => {
    const capability = capabilityFor("user-search");
    const wrapper = mount(DeferredFeature, {
      props: { capability: capability! },
    });

    // A retry button on a 501 route re-issues a request that cannot succeed.
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.text().toLowerCase()).not.toContain("try again");
    expect(wrapper.text().toLowerCase()).not.toContain("retry");
  });

  it("announces its state in a polite live region", () => {
    // `role="status"` rather than `alert`: a deferral is a screen's settled
    // state, not an interruption to be announced assertively on every
    // navigation.
    const capability = capabilityFor("user-search");
    const wrapper = mount(DeferredFeature, {
      props: { capability: capability! },
    });

    const live = wrapper.find('[aria-live="polite"]');
    expect(live.exists()).toBe(true);
    expect(live.attributes("role")).toBe("status");
  });

  it("hides the endpoint note when showing a real error", () => {
    // Printing "answers 501" beside a 500 would be a contradiction.
    const errorState = toErrorState(
      new NotImplementedError("/admin/users"),
      "phase 6",
    );
    const capability = capabilityFor("user-search");

    const wrapper = mount(DeferredFeature, {
      props: { capability: capability!, errorState },
    });

    // The error state *is* a deferral here, so its own detail (which mentions
    // 501) still shows; the separate "Endpoint" line must not, because that line
    // asserts the route's fixed behaviour.
    expect(wrapper.find(".deferred__backend").exists()).toBe(false);
    expect(wrapper.find(".deferred__label").exists()).toBe(false);
  });

  it("surfaces the request id when the Worker sent one", () => {
    // The join key between this console and the Worker's logs, and the only
    // thing that makes an operator's bug report actionable.
    const errorState = toErrorState(
      new ProblemResponse(500, "/x", "req-abc", "internal_error", "boom"),
      "phase 6",
    );
    const capability = capabilityFor("health");

    const wrapper = mount(DeferredFeature, {
      props: { capability: capability!, errorState },
    });

    expect(wrapper.text()).toContain("req-abc");
  });
});

describe("every deferred administrative feature", () => {
  const deferredIds = [
    "operator-session",
    "user-search",
    "user-detail",
    "suspend-user",
    "change-role",
    "revoke-sessions",
    "audit-log",
  ];

  it.each(deferredIds)("%s gates its screen and names a phase", (id) => {
    expect(isImplemented(id)).toBe(false);

    const wrapper = mount(CapabilityGate, {
      props: { featureId: id },
      slots: { default: "<p>SLOT</p>" },
    });

    expect(wrapper.text()).toContain("Not available yet");
    expect(wrapper.text()).toContain("phase");
    expect(wrapper.text()).not.toContain("SLOT");
  });
});
