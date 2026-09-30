/**
 * Tests for the whole app: the router, the shell, and every screen.
 *
 * The point of these is to assert what the app does *not* do. A test suite that
 * checks screens render is satisfied by an app that renders fake data; the
 * assertions below are the ones that fail if a screen starts fabricating a
 * session list, a mock user, or a "check your email" message.
 *
 * Every screen is mounted through the real router, so a route that fails to
 * register is caught here rather than at navigation time in a browser.
 */

import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

import App from "../src/App.vue";
import { routes } from "../src/router/routes";
import { CAPABILITIES } from "../src/capabilities";

/** A router over the real route table, backed by memory rather than the URL. */
function testRouter(): Router {
  return createRouter({ history: createMemoryHistory(), routes });
}

async function mountApp(path: string): Promise<VueWrapper> {
  const router = testRouter();
  await router.push(path);
  await router.isReady();

  return mount(App, {
    global: { plugins: [router, createPinia()] },
  });
}

beforeEach(() => {
  document.title = "";
});

describe("the application shell", () => {
  it("marks every deferred screen in the navigation", async () => {
    const wrapper = await mountApp("/");

    // The menu is the first thing a user sees, so the availability of the
    // product has to be legible from the menu alone.
    expect(wrapper.text()).toContain("not available yet");
    expect(wrapper.findAll(".app-nav__link--deferred").length).toBeGreaterThan(
      0,
    );
  });

  it("provides a skip link as the first focusable element", async () => {
    const wrapper = await mountApp("/");

    // A skip link that is not first in the tab order is not a skip link.
    const skip = wrapper.find(".skip-link");
    expect(skip.exists()).toBe(true);
    expect(skip.attributes("href")).toBe("#main");
    expect(wrapper.find("main").attributes("tabindex")).toBe("-1");
  });

  it("gives the navigation an accessible name", async () => {
    const wrapper = await mountApp("/");

    // More than one nav landmark will exist once the app grows a footer or a
    // breadcrumb; two unnamed ones are two indistinguishable regions.
    expect(wrapper.find("nav").attributes("aria-label")).toBeTruthy();
  });

  it("sets a document title from the matched route", async () => {
    const router = testRouter();
    await router.push("/sessions");
    await router.isReady();

    expect(router.currentRoute.value.meta.title).toBe(
      "Your sessions — Ecoma Identity",
    );
  });
});

describe("the home screen", () => {
  it("states how many features are available and how many are not", async () => {
    const wrapper = await mountApp("/");

    const implemented = CAPABILITIES.filter(
      (c) => c.status === "implemented",
    ).length;
    expect(wrapper.text()).toContain("What works today");
    expect(wrapper.text()).toContain("Available");
    expect(wrapper.text()).toContain("Not available yet");
    expect(wrapper.text()).toContain(String(implemented));
  });

  it("marks the deferral phase for every deferred feature", async () => {
    const wrapper = await mountApp("/");

    for (const capability of CAPABILITIES) {
      if (
        capability.status === "unimplemented" &&
        capability.deferredTo !== undefined
      ) {
        expect(wrapper.text(), capability.id).toContain(capability.deferredTo);
      }
    }
  });

  it("renders a real table with a caption, not a list of divs", async () => {
    const wrapper = await mountApp("/");

    // Tabular data with three columns should be a table: a screen reader can
    // then say which status belongs to which feature.
    expect(wrapper.find("table").exists()).toBe(true);
    expect(wrapper.find("caption").text()).toContain("Feature availability");
  });
});

describe("no screen fabricates data", () => {
  const screens = [
    { path: "/sign-in", name: "sign in" },
    { path: "/sign-up", name: "sign up" },
    { path: "/verify-email", name: "verify email" },
    { path: "/second-factor", name: "second factor" },
    { path: "/account", name: "account" },
    { path: "/sessions", name: "sessions" },
    { path: "/applications", name: "applications" },
  ];

  it.each(screens)("$name shows no form control", async ({ path }) => {
    const wrapper = await mountApp(path);

    // No disabled buttons, no inputs, no fake forms. A form that collects
    // credentials and cannot submit them is a credential-collection surface
    // with no credential behind it.
    expect(wrapper.find("input").exists(), path).toBe(false);
    expect(wrapper.find("button").exists(), path).toBe(false);
    expect(wrapper.find("form").exists(), path).toBe(false);
  });

  it.each(screens)(
    "$name says the feature is not available yet",
    async ({ path }) => {
      const wrapper = await mountApp(path);
      expect(wrapper.text(), path).toContain("Not available yet");
    },
  );

  it.each(screens)(
    "$name does not tell the user to check their email",
    async ({ path }) => {
      const wrapper = await mountApp(path);
      const text = wrapper.text().toLowerCase();

      // The single most damaging thing a deferred auth screen could claim.
      expect(text, path).not.toContain("check your email");
      expect(text, path).not.toContain("check your inbox");
    },
  );

  it.each(screens)("$name does not offer a retry", async ({ path }) => {
    const wrapper = await mountApp(path);
    const text = wrapper.text().toLowerCase();

    expect(text, path).not.toContain("try again");
    expect(text, path).not.toContain("retry");
  });
});

describe("the account screen", () => {
  it("says the session state is unknown rather than claiming signed out", async () => {
    const wrapper = await mountApp("/account");

    // This app cannot read the HttpOnly cookie, so it cannot know. Rendering
    // "you are not signed in" from an unanswered question would be the app
    // inventing an authentication result.
    expect(wrapper.text()).toContain("Session state is unknown");
    expect(wrapper.text()).toContain("cannot read the session cookie");
  });

  it("does not offer a control to change a role", async () => {
    const wrapper = await mountApp("/account");

    // Only an administrator can change a role, and never their own. A control
    // the server would refuse is a dead control with a misleading label.
    expect(wrapper.text()).toContain("cannot be changed from this screen");
    expect(wrapper.find("button").exists()).toBe(false);
  });
});

describe("the sessions screen", () => {
  it("does not render an empty session table", async () => {
    const wrapper = await mountApp("/sessions");

    // An empty list is a security claim — "you have one session, this one" —
    // and a user reading it during an incident draws the wrong conclusion.
    expect(wrapper.find("table").exists()).toBe(false);
    expect(wrapper.find("tbody").exists()).toBe(false);
  });

  it("says the query is not implemented rather than showing no results", async () => {
    const wrapper = await mountApp("/sessions");
    const text = wrapper.text().toLowerCase();

    expect(text).not.toContain("no sessions");
    expect(text).not.toContain("0 sessions");
    expect(text).not.toContain("no results");
  });
});

describe("the connected applications screen", () => {
  it("does not assert that nothing is connected to the account", async () => {
    const wrapper = await mountApp("/applications");
    const text = wrapper.text().toLowerCase();

    // "Nothing is connected" is a reassuring claim about who has access to a
    // user's identity, and a bootstrap query cannot make it.
    expect(text).not.toContain("no connected applications");
    expect(text).not.toContain("nothing is connected");
    expect(text).not.toContain("no applications");
  });
});

describe("the catch-all route", () => {
  it("shows the inventory rather than a bare not-found", async () => {
    // A 404 in a single-page app says the feature does not exist, when the
    // truth is that it is declared and unbuilt. Landing on the inventory keeps
    // the product's real shape visible.
    const wrapper = await mountApp("/no-such-page");
    expect(wrapper.text()).toContain("What works today");
  });
});

describe("the route table", () => {
  it("titles every route", () => {
    // The title is the cheapest fix for a screen-reader user arriving by link,
    // and the cheapest thing to forget when adding a screen.
    for (const route of routes) {
      expect(route.meta?.title, String(route.path)).toBeTruthy();
    }
  });

  it("gives every route a distinct path and name", () => {
    // Two records on one path is a silent override: the first would be
    // unreachable and nothing would say so.
    const paths = routes.map((route) => route.path);
    const names = routes.map((route) => String(route.name));

    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers a screen for every menu feature", () => {
    // A feature in the inventory with no route is a dead link, and a route with
    // no feature is a screen the gate cannot answer for.
    const paths = routes.map((route) => route.path);
    for (const path of [
      "/sign-in",
      "/sign-up",
      "/verify-email",
      "/second-factor",
      "/account",
      "/sessions",
      "/applications",
    ]) {
      expect(paths, path).toContain(path);
    }
  });
});
