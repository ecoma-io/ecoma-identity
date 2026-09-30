/**
 * The feature inventory for the operator console — the single place that says,
 * per administrative feature, whether it works yet and why.
 *
 * It is the console's answer to "is this implemented?", and it exists so the
 * question has exactly one answer in exactly one file. Every screen reads it
 * through {@link capabilityFor} or {@link isImplemented} rather than holding
 * its own belief, so a screen cannot disagree with this table and a reviewer
 * can see the whole inventory by reading one module.
 *
 * It is **not** a runtime feature flag, a permission system, or a licence to
 * degrade quietly. Nothing turns these on: a feature moves from `unimplemented`
 * to `implemented` only when a commit implements the Admin Worker route behind
 * it *and* flips that one entry. A feature listed as `implemented` here is a
 * claim this repository makes in code.
 *
 * And it is emphatically **not** an authorization mechanism. Every feature in
 * this inventory is `unimplemented` in the bootstrap phase, and when they stop
 * being, the gate that decides who may use them is the Admin Worker's, on the
 * server, checking the operator's session and AAL. A client-side capability
 * table is a description of what exists, not a control over what is permitted:
 * flipping an entry here would not let anyone do anything, and pretending
 * otherwise would be the most dangerous kind of client-side check in an
 * operator console.
 *
 * The status values mean:
 * - `implemented` — the Admin Worker route answers for real and this console
 *   renders its real response.
 * - `unimplemented` — the Admin Worker answers 501. The console shows the
 *   deferred state and the phase it is deferred to, as numbered by
 *   `docs/roadmap/phases.md` — the single owner of phase names. It never shows a
 *   sample user, a sample audit row, a spinner that resolves to placeholders, or
 *   a disabled button with no explanation.
 */

/** Whether a feature is real yet. */
export type CapabilityStatus = "implemented" | "unimplemented";

/**
 * The phases a deferred feature is deferred to, keyed by the roadmap's own
 * phase numbers.
 *
 * `docs/roadmap/phases.md` **owns** this vocabulary. This map is a copy of the
 * roadmap's phase headings and nothing more: a phase name invented in this file
 * would be a second owner for one fact, which is the one thing the repository's
 * authority map forbids. The label beside each number is the roadmap's own
 * section heading, so a reader can diff the two without interpretation.
 *
 * A phase is ordered work with a defined exit condition. It is **not** a date,
 * a quarter, or a commitment to a delivery window, and nothing in this console
 * may render one: the roadmap deliberately carries no dates, and this repository
 * is not in a position to invent one.
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
 * is a compile error here rather than a sentence an operator reads on a screen
 * that names a phase which exists nowhere in the repository.
 */
export type DeferredTo = keyof typeof PHASES;

/**
 * How a phase reads inside a sentence: `phase 6 (Administration)`.
 *
 * The number is the link into `docs/roadmap/phases.md`; the label is what the
 * operator actually takes away. Splitting them here means no screen has to
 * assemble the two by hand and get the punctuation wrong.
 */
export function phasePhrase(phase: DeferredTo): string {
  return `${phase} (${PHASES[phase]})`;
}

/** What every capability records, whether or not it is built. */
interface CapabilityBase {
  /**
   * Stable identifier, used as the record key and by tests. Never reused and
   * never renamed: a rename would silently orphan a screen's lookup and leave
   * it falling through to the "unknown feature" state, which renders as a
   * visibly wrong panel rather than as the honest deferral.
   */
  readonly id: string;
  /** The operator-facing name of the feature, as a screen would title it. */
  readonly label: string;
  /** The Admin Worker route this feature will call, and the only one. */
  readonly route: string;
  /**
   * What the Admin Worker actually answers today on `route`. For an implemented
   * feature this is the success case; for a deferred one it is the 501 envelope.
   * Printed verbatim by the deferred state, because the point of the screen is
   * to be true about the wire.
   */
  readonly backendBehaviour: string;
}

/**
 * A feature whose Admin Worker route answers for real.
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
 * A feature the Admin Worker answers 501 for.
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
 * Ordered by an operator's actual journey: confirm who is signed in, then find
 * a person, then look at them, then act on them, then read the record of what
 * was done. A reader scanning this list should see the operator's workflow.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "health",
    label: "Admin Worker health",
    route: "/health",
    status: "implemented",
    backendBehaviour: "200 with a liveness body.",
  },
  {
    id: "operator-session",
    label: "Confirm the operator's own session",
    route: "/admin/session",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. The console cannot read its own administrative session cookie, " +
      "so it cannot tell an operator from a signed-out browser by inspection.",
  },
  {
    id: "user-search",
    label: "Search users",
    route: "/admin/users",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. The query, its filters and its pagination are all deferred; the " +
      "route exists in the admin contract and no handler answers it.",
  },
  {
    id: "user-detail",
    label: "View one user's account",
    route: "/admin/users/detail",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. Reading a single account is deferred with the same query layer " +
      "as the search that finds it.",
  },
  {
    id: "suspend-user",
    label: "Suspend and unsuspend a user",
    route: "/admin/users/suspend",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. Both commands are deferred. Suspension is not reversible from a " +
      "deactivated account, so no partial implementation is offered here.",
  },
  {
    id: "change-role",
    label: "Change a user's platform role",
    route: "/admin/users/role",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. The refusal rules — no self-change, no self-promotion, and the " +
      "last active administrator cannot be removed — are decided server-side " +
      "and are not offered as client-side controls here.",
  },
  {
    id: "revoke-sessions",
    label: "Revoke a user's sessions",
    route: "/admin/sessions/revoke",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. Revoking every session of one user is deferred. It is not the " +
      "same as suspending them and does not change their account status.",
  },
  {
    id: "audit-log",
    label: "Read the audit log",
    route: "/admin/audit",
    status: "unimplemented",
    deferredTo: "phase 6",
    backendBehaviour:
      "501. The audit query, its filters and its pagination are deferred. " +
      "Events are recorded server-side regardless of whether they can be read.",
  },
] as const;

/** Every capability id, as a union of literals, for compile-time exhaustiveness. */
export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

/**
 * Look one feature up by id.
 *
 * Returns `undefined` for an unknown id rather than throwing: an unknown id is a
 * programming error in a screen, and a screen that cannot find its feature
 * should render "unknown feature" — a visible, wrong state a test can catch —
 * rather than take down the whole console.
 */
export function capabilityFor(id: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}

/**
 * Whether a feature is real.
 *
 * This is the function screens call to decide what to render. It answers `false`
 * for an unknown id on purpose: a screen asking about a feature that is not in
 * the inventory must not get the benefit of the doubt.
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
 * `docs/roadmap/phases.md`, the label is what the operator takes away. There is
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

/**
 * The routes the Admin Worker serves, as this console names them.
 *
 * The `/admin/*` paths are the console's own BFF routes. They are named here
 * rather than imported from a Rust constant because the Admin Worker's route
 * table does not exist yet: the Worker crates still hold placeholder
 * `lib.rs` files. When the Worker implements them, these strings and the Rust
 * route table must be reconciled in one commit, and the comment is here so that
 * commit finds the note.
 *
 * What is **not** listed: any Identity Worker path. The Admin Worker reaches
 * identity through a private service binding and the console must never address
 * the Identity Worker directly. A console pointed at the Identity Worker's
 * origin would assert a topology the deployment does not have, and would be one
 * `VITE_API_BASE_URL` away from bypassing the administrative boundary.
 */
export const ADMIN_ROUTES = {
  /** Liveness. One of the two routes that answers for real. */
  health: "/health",
  /** Readiness. One of the two routes that answers for real. */
  ready: "/ready",
  /** The operator's own administrative session. Declared; answers 501. */
  session: "/admin/session",
  /** The user search. Declared; answers 501. */
  users: "/admin/users",
  /** One user's account. Declared; answers 501. */
  userDetail: "/admin/users/detail",
  /** Suspend and unsuspend. Declared; answers 501. */
  suspend: "/admin/users/suspend",
  /** Role changes. Declared; answers 501. */
  role: "/admin/users/role",
  /** Session revocation. Declared; answers 501. */
  revokeSessions: "/admin/sessions/revoke",
  /** The audit query. Declared; answers 501. */
  audit: "/admin/audit",
} as const;
