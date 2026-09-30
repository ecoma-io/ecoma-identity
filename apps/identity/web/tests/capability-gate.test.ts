/**
 * Tests for the capability gate and the deferred panel it renders.
 *
 * The gate is where a screen decides between real content and an honest
 * deferral, so these assert both halves:
 * - an unimplemented feature renders the deferral and **not the slot**, which
 *   is what stops a screen showing an empty table next to a message saying the
 *   query does not exist;
 * - the deferral text actually names the phase, because a screen that says
 *   only "coming soon" has told the user nothing checkable.
 *
 * The screens themselves are covered by the App-level test, which asserts that
 * every route renders without fabricating data.
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
      props: { featureId: "sessions" },
      slots: { default: "<p>SECRET SLOT CONTENT</p>" },
    });

    expect(wrapper.text()).toContain("Not available yet");
    expect(wrapper.text()).toContain("phase 1");
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
    // strength of a misspelling. It shows a panel that is obviously wrong, which
    // a reviewer or a test can catch.
    const wrapper = mount(CapabilityGate, {
      props: { featureId: "no-such-feature" },
      slots: { default: "<p>SECRET SLOT CONTENT</p>" },
    });

    expect(wrapper.text()).not.toContain("SECRET SLOT CONTENT");
    expect(wrapper.text()).toContain("no inventory entry names this feature");
  });

  it("renders the slot and withholds the deferral for an implemented feature", () => {
    // The mirror of the first case. `health` is the one live route, so a
    // supplied error must not smuggle a deferral onto a working feature — a
    // 503 on `/health` is an outage of a real endpoint, not "coming soon".
    const errorState = toErrorState(
      new ProblemResponse(503, "/health", "req-5", "internal_error", "boom"),
      "phase 2",
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
    // A 5xx while a feature is deferred is a different fact and must not be
    // rendered as a deferral — a user told "coming soon" during an incident is
    // a user who does not report the outage.
    const errorState = toErrorState(
      new ProblemResponse(
        503,
        "/self-service/sessions",
        "req-5",
        "internal_error",
        "boom",
      ),
      "phase 1",
    );

    const wrapper = mount(CapabilityGate, {
      props: { featureId: "sessions", errorState },
      slots: { default: "<p>SECRET SLOT CONTENT</p>" },
    });

    expect(wrapper.text()).toContain("req-5");
    // The title is what identifies the failure as server-side; the detail is
    // the envelope's client-safe message, which is more specific than the
    // generic sentence and is what should be shown.
    expect(wrapper.text()).toContain("could not complete");
    expect(wrapper.text()).toContain("boom");
    expect(wrapper.text()).not.toContain("Not available yet");
    expect(wrapper.text()).not.toContain("SECRET SLOT CONTENT");
  });
});

describe("DeferredFeature", () => {
  it("names the endpoint and what it answers", () => {
    // The endpoint note is what makes the screen verifiable: a reader can curl
    // the route and confirm it really does answer 501. A deferral that only
    // apologises cannot be checked against anything.
    const capability = capabilityFor("sessions");
    const wrapper = mount(DeferredFeature, {
      props: { capability: capability! },
    });

    expect(wrapper.text()).toContain("/self-service/sessions");
    expect(wrapper.text()).toContain("501");
  });

  it("renders no retry control for a deferred feature", () => {
    const capability = capabilityFor("sessions");
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
    const capability = capabilityFor("sessions");
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
      new NotImplementedError("/self-service/sessions"),
      "phase 1",
    );
    const capability = capabilityFor("sessions");

    const wrapper = mount(DeferredFeature, {
      props: { capability: capability!, errorState },
    });

    // The error state *is* a deferral here, so its own detail (which mentions
    // 501) still shows; the separate "Endpoint" line must not, because that
    // line asserts the route's fixed behaviour.
    expect(wrapper.find(".deferred__backend").exists()).toBe(false);
    expect(wrapper.find(".deferred__label").exists()).toBe(false);
  });

  it("surfaces the request id when the Worker sent one", () => {
    // The join key between this screen and the Worker's logs, and the only
    // thing that makes a user's bug report actionable.
    const errorState = toErrorState(
      new ProblemResponse(500, "/x", "req-abc", "internal_error", "boom"),
      "phase 2",
    );
    const capability = capabilityFor("health");

    const wrapper = mount(DeferredFeature, {
      props: { capability: capability!, errorState },
    });

    expect(wrapper.text()).toContain("req-abc");
  });
});

describe("every deferred feature", () => {
  const deferredIds = [
    "sign-in",
    "sign-up",
    "verify-email",
    "second-factor",
    "account",
    "sessions",
    "applications",
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
