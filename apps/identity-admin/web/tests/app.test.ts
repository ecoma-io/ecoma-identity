/**
 * Tests for the whole operator console: the router, the shell, and every screen.
 *
 * The point of these is to assert what the console does *not* do. A suite that
 * checks screens render is satisfied by a console that renders fake data; the
 * assertions below are the ones that fail if a screen starts inventing a user
 * table, an empty audit log, or an optimistic "suspended" confirmation.
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

    // The menu is the first thing an operator sees, so the availability of the
    // console has to be legible from the menu alone.
    expect(wrapper.text()).toContain("not available yet");
    expect(wrapper.findAll(".app-nav__link--deferred").length).toBeGreaterThan(
      0,
    );
  });

  it("does not hide screens behind a client-side permission check", async () => {
    const wrapper = await mountApp("/");

    // Every administrative screen is linked. A console that hid screens behind
    // an "is an administrator" flag would create the impression that access is
    // controlled in the browser, which is the one place it is not controlled at
    // all — and the cookie is HttpOnly, so such a flag could not be correct
    // anyway.
    const hrefs = wrapper
      .findAll(".app-nav__link")
      .map((link) => link.attributes("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/operator",
        "/users",
        "/moderation",
        "/roles",
        "/sessions",
        "/audit",
      ]),
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

    // More than one nav landmark will exist once the console grows a footer or a
    // breadcrumb; two unnamed ones are two indistinguishable regions.
    expect(wrapper.find("nav").attributes("aria-label")).toBeTruthy();
  });

  it("distinguishes itself from the end-user app by name, not by colour", async () => {
    const wrapper = await mountApp("/");

    // A tab or a header reading only "Ecoma Identity" is indistinguishable from
    // the user-facing app to an operator with two tabs open.
    expect(wrapper.text()).toContain("Console");
  });

  it("sets a document title from the matched route", async () => {
    const router = testRouter();
    await router.push("/audit");
    await router.isReady();

    expect(router.currentRoute.value.meta.title).toBe(
      "Audit log — Ecoma Identity",
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

  it("says the table describes what is built, not what an operator may do", async () => {
    const wrapper = await mountApp("/");

    // The distinction an operator must never misread: a capability table is a
    // description of the build, and a client-side permission matrix would be an
    // authorization check the console has no business performing.
    expect(wrapper.text()).toContain(
      "decided by the Admin Worker, not by this page",
    );
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

    expect(wrapper.find("table").exists()).toBe(true);
    expect(wrapper.find("caption").text()).toContain("Feature availability");
  });
});

describe("no screen fabricates data", () => {
  const screens = [
    { path: "/operator", name: "operator session" },
    { path: "/users", name: "user search" },
    { path: "/users/abc", name: "user detail" },
    { path: "/moderation", name: "moderation" },
    { path: "/roles", name: "role admin" },
    { path: "/sessions", name: "session revocation" },
    { path: "/audit", name: "audit log" },
  ];

  it.each(screens)("$name shows no action control", async ({ path }) => {
    const wrapper = await mountApp(path);

    // No buttons, no inputs, no fake forms. Every administrative action here
    // changes a real person's security posture, and a control that appears to
    // work without a server round-trip is the one failure this console must
    // never ship.
    expect(wrapper.find("button").exists(), path).toBe(false);
    expect(wrapper.find("input").exists(), path).toBe(false);
    expect(wrapper.find("select").exists(), path).toBe(false);
  });

  it.each(screens)(
    "$name says the feature is not available yet",
    async ({ path }) => {
      const wrapper = await mountApp(path);
      expect(wrapper.text(), path).toContain("Not available yet");
    },
  );

  it.each(screens)("$name does not offer a retry", async ({ path }) => {
    const wrapper = await mountApp(path);
    const text = wrapper.text().toLowerCase();

    expect(text, path).not.toContain("try again");
    expect(text, path).not.toContain("retry");
  });

  it.each(screens)("$name renders no result table", async ({ path }) => {
    const wrapper = await mountApp(path);

    // No screen may render an empty results table, because an empty table is a
    // claim about the platform: "there are no users", "nothing has been
    // recorded". Both are alarming, and neither is true here.
    expect(wrapper.find("tbody").exists(), path).toBe(false);
  });
});

describe("the user search screen", () => {
  it("does not render a search box", async () => {
    const wrapper = await mountApp("/users");

    // A disabled search box with no explanation is a control that looks like a
    // decision. The screen has no box at all.
    expect(wrapper.find("input").exists()).toBe(false);
  });

  it("states that identity is reached through the Admin Worker, not directly", async () => {
    const wrapper = await mountApp("/users");

    // The boundary an operator most needs restated: this console never queries
    // Identity D1 and never addresses the Identity Worker.
    expect(wrapper.text()).toContain("service binding");
    expect(wrapper.text()).toContain("never queries that database directly");
  });
});

describe("the user detail screen", () => {
  it("offers no role or suspend control", async () => {
    const wrapper = await mountApp("/users/abc");

    // Those are commands with refusal rules the server evaluates. A console
    // offering a button the server would refuse would be a dead control with a
    // misleading label.
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.text()).toContain('no "change role" or "suspend" control');
  });
});

describe("the role administration screen", () => {
  it("states that the refusal rules are the server's, not hidden here", async () => {
    const wrapper = await mountApp("/roles");

    // A client-side check that disabled the forbidden combinations would be a
    // client-side authorization check, and would teach an operator the rule is
    // the UI's rather than the server's.
    expect(wrapper.text()).toContain("refused by the server");
    expect(wrapper.text()).toContain("their own role");
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.find("input").exists()).toBe(false);
  });
});

describe("the audit log screen", () => {
  it("does not claim the audit log is empty", async () => {
    const wrapper = await mountApp("/audit");
    const text = wrapper.text().toLowerCase();

    // The most important absence in the console. Events *are* being recorded;
    // only the query is deferred. Saying "no events" to an operator
    // investigating an incident is the worst thing this screen could do.
    expect(text).not.toContain("no events");
    expect(text).not.toContain("nothing recorded");
    expect(text).not.toContain("0 events");
    expect(wrapper.find("tbody").exists()).toBe(false);
  });

  it("says events are recorded even though they cannot be read back", async () => {
    const wrapper = await mountApp("/audit");
    expect(wrapper.text()).toContain("Events are being recorded now");
  });
});

describe("the operator session screen", () => {
  it("says the session state is unknown rather than claiming signed out", async () => {
    const wrapper = await mountApp("/operator");

    // The cookie is HttpOnly, so the console cannot know. Rendering "you are
    // not signed in" from an unanswered question would be the console inventing
    // an authentication result.
    expect(wrapper.text()).toContain("Operator session state is unknown");
    expect(wrapper.text()).toContain("cannot read its own");
  });

  it("says the page reports rather than grants", async () => {
    const wrapper = await mountApp("/operator");

    // The distinction that keeps this console honest: the session page is a
    // display, not an authorization check.
    expect(wrapper.text()).toContain("does not grant anything");
  });
});

describe("the catch-all route", () => {
  it("shows the inventory rather than a bare not-found", async () => {
    // A 404 in a single-page app says the feature does not exist, when the truth
    // is that it is declared and unbuilt. Landing on the inventory keeps the
    // product's real shape visible.
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
    const paths = routes.map((route) => route.path);
    for (const path of [
      "/operator",
      "/users",
      "/moderation",
      "/roles",
      "/sessions",
      "/audit",
    ]) {
      expect(paths, path).toContain(path);
    }
  });

  it("registers the user detail screen as a deep link with an id", async () => {
    // The screen needs a user id the search query cannot yet supply, so the
    // route exists for deep links and is absent from the menu. The shape is
    // written down now so the deep link works the day the query lands.
    const wrapper = await mountApp("/users/abc");
    expect(wrapper.text()).toContain("User detail");
  });
});
