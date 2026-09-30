/**
 * The feature inventory for the end-user identity UI — the single place that
 * says, per feature, whether it works yet and why.
 *
 * It is the app's answer to "is this implemented?", and it exists so that the
 * question has exactly one answer in exactly one file. Every screen reads it
 * through {@link capabilityFor} or {@link isImplemented} rather than
 * hard-coding its own belief, so a screen cannot disagree with this table and
 * a reviewer can see the whole inventory by reading one module.
 *
 * It is **not** a runtime feature flag, a remote config document, or a licence
 * to degrade quietly. There is no server that turns these on: a feature moves
 * from `unimplemented` to `implemented` only when a commit implements the
 * Worker route behind it *and* flips that one entry. A feature that is listed
 * as `implemented` here is a claim this repository makes in code, and CI
 * cannot verify it — a reviewer can, and `tests/capabilities.test.ts` at least
 * verifies that the table is internally consistent and that no screen has
 * quietly grown a second opinion.
 *
 * The status values mean:
 * - `implemented` — the Worker route answers for real and this UI renders its
 *   real response.
 * - `unimplemented` — the Worker answers 501 (it declares the route, so a
 *   client stops rather than treating it as a missing endpoint). The UI shows
 *   the deferred state and the phase it is deferred to, as numbered by
 *   `docs/roadmap/phases.md` — the single owner of phase names. It never shows
 *   sample data, a spinner that resolves to placeholders, or a disabled control
 *   with no explanation.
 */

/**
 * Whether a feature is real yet.
 *
 * A plain boolean would be enough for the two live routes, and would be the
 * wrong shape for everything else: the reason a feature is absent is the
 * useful part of the answer, and a boolean has nowhere to put it.
 */
export type CapabilityStatus = "implemented" | "unimplemented";

/**
 * The phases a deferred feature is deferred to, keyed by the roadmap's own
 * phase numbers.
 *
 * `docs/roadmap/phases.md` **owns** this vocabulary. This map is a copy of the
 * roadmap's phase headings and nothing more: a phase name invented in this file
 * would be a second owner for one fact, which is the one thing the repository's
 * authority map forbids, and the defect this type was widened to fix. The label
 * beside each number is the roadmap's own section heading, so a reader can diff
 * the two without interpretation.
 *
 * Phase 0 is the phase this repository is already in, and it is here for one
 * reason: a feature id the inventory does not recognise is a defect *in this
 * phase's code*, not planned work, and `CapabilityGate` has to render a
 * capability value for it. No entry in {@link CAPABILITIES} is deferred to
 * phase 0 — nothing is deferred to the phase we are standing in — and
 * `tests/capabilities.test.ts` asserts that.
 *
 * A phase is ordered work with a defined exit condition. It is **not** a date,
 * a quarter, or a commitment to a delivery window, and nothing in this app may
 * render one: the roadmap deliberately carries no dates, and this repository is
 * not in a position to invent one.
 */
export const PHASES = {
  "phase 0": "Platform bootstrap",
  "phase 1": "Sessions and the request context",
  "phase 2": "Email OTP, and the first real authentication",
  "phase 3": "Second factor, and the assurance model",
  "phase 4": "OIDC provider",
  "phase 5": "Applications, grants, and the self-service surface",
  "phase 6": "Administration",
  "phase 7": "Background work",
  "phase 8": "Passkeys",
} as const;

/**
 * The phase a deferred feature is deferred to.
 *
 * A closed union of the roadmap's phases, so a fourth spelling of a phase name
 * is a compile error here rather than a sentence a user reads on a screen that
 * names a phase which exists nowhere in the repository.
 */
export type DeferredTo = keyof typeof PHASES;

/**
 * How a phase reads inside a sentence: `phase 6 (Administration)`.
 *
 * The number is the link into `docs/roadmap/phases.md`; the label is what the
 * person reading the screen actually takes away. Splitting them here means no
 * screen has to assemble the two by hand and get the punctuation wrong.
 */
export function phasePhrase(phase: DeferredTo): string {
  return `${phase} (${PHASES[phase]})`;
}

/** What every capability records, whether or not it is built. */
interface CapabilityBase {
  /**
   * Stable identifier, used as the record key and by tests. Never reused and
   * never renamed: a rename would silently orphan a screen's lookup and leave
   * it falling through to "unknown feature", which renders as an error rather
   * than as the honest deferred state.
   */
  readonly id: string;
  /** The user-facing name of the feature, as a screen would title it. */
  readonly label: string;
  /** The Worker route this feature will call, and the only one. */
  readonly route: string;
  /**
   * What the Worker actually answers today on `route`. For an implemented
   * feature this is the success case; for a deferred one it is the 501
   * envelope. Printed verbatim by the deferred state, because the point of
   * the screen is to be true about the wire.
   */
  readonly backendBehaviour: string;
}

/**
 * A feature whose Worker route answers for real.
 *
 * `deferredTo` is forbidden rather than merely absent, so passing an explicit
 * `undefined` is also a type error under `exactOptionalPropertyTypes`: a
 * working feature carrying a phase is a claim the screen would render.
 */
export interface ImplementedCapability extends CapabilityBase {
  readonly status: "implemented";
  readonly deferredTo?: never;
}

/**
 * A feature the Worker answers 501 for.
 *
 * The phase is **required**. That is the whole point of the discriminated
 * union: it is what removes the need for a fallback string in
 * {@link deferralSentence}, and it makes "deferred, with nothing saying what
 * builds it" a compile error instead of a sentence that quietly names a phase
 * nobody can look up.
 */
export interface DeferredCapability extends CapabilityBase {
  readonly status: "unimplemented";
  readonly deferredTo: DeferredTo;
}

/** A single feature's entry. */
export type Capability = ImplementedCapability | DeferredCapability;

/**
 * The whole inventory, as data.
 *
 * Ordered by the journey a user takes, not alphabetically: sign in, sign up,
 * verify, add a factor, then the two management surfaces. A reader scanning
 * this list should see the product's shape.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "health",
    label: "Service health",
    route: "/health",
    status: "implemented",
    backendBehaviour: "200 with a liveness body.",
  },
  {
    id: "sign-in",
    label: "Sign in with an emailed code",
    route: "/oauth/authorize",
    status: "unimplemented",
    deferredTo: "phase 2",
    backendBehaviour:
      "501. The route is declared in the provider's route table, so a client " +
      "stops rather than treating it as a missing endpoint.",
  },
  {
    id: "sign-up",
    label: "Create an account",
    route: "/oauth/authorize",
    status: "unimplemented",
    deferredTo: "phase 2",
    backendBehaviour:
      "501. Account creation and the emailed one-time code share this route; " +
      "neither branch is implemented.",
  },
  {
    id: "verify-email",
    label: "Verify an email address",
    route: "/oauth/authorize",
    status: "unimplemented",
    deferredTo: "phase 2",
    backendBehaviour:
      "501. The challenge is issued by the same route that has to verify it.",
  },
  {
    id: "second-factor",
    label: "Set up a second factor",
    route: "/self-service/factors",
    status: "unimplemented",
    deferredTo: "phase 3",
    backendBehaviour:
      "501. The self-service surface is declared as a contract and served by " +
      "this same Worker, but no handler answers it.",
  },
  {
    id: "account",
    label: "View your own account",
    route: "/self-service/account",
    status: "unimplemented",
    deferredTo: "phase 5",
    backendBehaviour:
      "501. Reading the caller's own account is the query every other " +
      "self-service screen depends on for who the caller is.",
  },
  {
    id: "sessions",
    label: "Manage signed-in sessions",
    route: "/self-service/sessions",
    status: "unimplemented",
    deferredTo: "phase 1",
    backendBehaviour:
      "501. Listing and revoking a caller's own sessions are both deferred.",
  },
  {
    id: "applications",
    label: "Manage connected applications",
    route: "/self-service/applications",
    status: "unimplemented",
    deferredTo: "phase 5",
    backendBehaviour:
      "501. Listing and withdrawing grants are deferred; the OIDC consent " +
      "screen that would create them does not exist either.",
  },
] as const;

/** Every capability id, as a union of literals, for compile-time exhaustiveness. */
export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

/**
 * Look one feature up by id.
 *
 * Returns `undefined` for an unknown id rather than throwing: an unknown id is
 * a programming error in a screen, and a screen that cannot find its feature
 * should render "unknown feature" — a visible, wrong state a test can catch —
 * rather than take down the whole app. `tests/capabilities.test.ts` asserts
 * every screen's id resolves.
 */
export function capabilityFor(id: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}

/**
 * Whether a feature is real.
 *
 * This is the function screens call to decide what to render. It answers
 * `false` for an unknown id on purpose: a screen asking about a feature that
 * is not in the inventory must not get the benefit of the doubt.
 */
export function isImplemented(id: string): boolean {
  return capabilityFor(id)?.status === "implemented";
}

/**
 * The features that are real, in inventory order. Used by the home screen and
 * the capability table to separate "this works" from "this does not", without
 * either list being maintained by hand.
 */
export function implementedCapabilities(): readonly Capability[] {
  return CAPABILITIES.filter(
    (capability) => capability.status === "implemented",
  );
}

/**
 * The features that are deferred, in inventory order. The counter-sibling of
 * {@link implementedCapabilities}; a screen that needs the deferred list must
 * derive it here rather than re-filter, or the two will drift.
 */
export function deferredCapabilities(): readonly Capability[] {
  return CAPABILITIES.filter(
    (capability) => capability.status === "unimplemented",
  );
}

/**
 * The sentence a deferred screen prints.
 *
 * Centralised so that every deferred screen says the same thing in the same
 * shape, and so the "why" is never a sentence invented at the call site —
 * which is how a UI ends up saying "coming soon" on one page and naming a
 * phase on the next.
 *
 * Reads "deferred to phase 6 (Administration)": the number is the link into
 * `docs/roadmap/phases.md`, the label is what the reader takes away. There is
 * no fallback string for a missing phase, because the {@link Capability} union
 * makes a deferred capability's phase a compile-time requirement — a default
 * here would be a phase name invented at runtime by a module that is not its
 * owner.
 *
 * Returns `undefined` for a feature that is implemented, so a template that
 * interpolates it renders nothing rather than claiming a deferral that does not
 * exist. That branch narrows on `status`, which is why the union discriminates.
 */
export function deferralSentence(capability: Capability): string | undefined {
  if (capability.status === "implemented") {
    return undefined;
  }
  return (
    `${capability.label} is not available yet. It is deferred to ` +
    `${phasePhrase(capability.deferredTo)}.`
  );
}
