/**
 * The data contracts the future identity calls will return.
 *
 * These types are the app's half of `contracts/self-service/v1/`. They mirror
 * the Rust types in `identity-application` field for field — `SessionView`,
 * `AccountView`, `AccountEmail`, `AccountIdentity` — including the snake_case
 * wire names, because a `serde` default serialises them that way and a client
 * that guesses camelCase would silently read `undefined` out of a response
 * that is actually correct.
 *
 * They are **types, not fixtures**. Nothing in this file constructs a value:
 * there is no sample session, no sample account, no `MOCK_*` constant. A type
 * with no value behind it cannot be mistaken for a working screen, and a
 * reviewer looking for the source of any data on screen will find that there
 * isn't one. The moment the Worker implements a route, the types here get their
 * first real value — from the network, never from this file.
 *
 * What is **not** here: anything this app would have to invent. There is no
 * `UserPreferences`, no `FeatureFlag`, no client-side "is signed in" record.
 */

/**
 * The assurance level a session was established at.
 *
 * The order matters and is not alphabetical: `aal1` < `aal2`, and an `aal2`
 * session satisfies an `aal1` operation but not the reverse. That asymmetry is
 * the whole reason a step-up exists, so a UI may show a step-up prompt but may
 * never decide on its own that an `aal1` session is good enough.
 */
export type Aal = "aal1" | "aal2";

/** A user's standing in the platform. Mirrors `PlatformRole`. */
export type PlatformRole = "member" | "support" | "administrator" | "service";

/** Whether an account may authenticate. Mirrors `UserStatus`. */
export type UserStatus =
  "active" | "suspended" | "deactivated" | "pending_verification";

/** Which provider asserted a linked external identity. Mirrors `IdentityProvider`. */
export type IdentityProvider = string;

/**
 * A session, as the user sees it in their own list.
 *
 * Mirrors `identity_application::sessions::SessionView`. Note what is absent:
 * no `user_id`, because this is the caller's own list and the user is known;
 * no `ip_address` or raw user-agent, because a session list is a page an
 * account-takeover attacker reads, and an unescaped user-agent stored verbatim
 * is a stored-XSS vector. The `label` is a coarse, pre-sanitised string for
 * exactly that reason.
 */
export interface SessionView {
  readonly session_id: string;
  /** Milliseconds since the Unix epoch. */
  readonly created_at_ms: number;
  /** Milliseconds since the Unix epoch. */
  readonly expires_at_ms: number;
  readonly aal: Aal;
  /** A coarse "where did this come from" label, or `null` when unknown. */
  readonly label: string | null;
  /** Whether this is the session making the request. */
  readonly current: boolean;
}

/** A verified or unverified address on the caller's account. Mirrors `AccountEmail`. */
export interface AccountEmail {
  readonly address: string;
  readonly verified: boolean;
  /** Exactly one per account; the sign-in address. */
  readonly primary: boolean;
}

/** A linked external identity. Mirrors `AccountIdentity`. */
export interface AccountIdentity {
  readonly provider: IdentityProvider;
  /**
   * The provider's identifier for the user. Present in the caller's own view
   * and absent from every administrative view — the console must never receive
   * it, and the type that carries it lives in the admin app, not here.
   */
  readonly subject: string;
  readonly label: string | null;
}

/** The caller's own account. Mirrors `AccountView`. */
export interface AccountView {
  readonly user_id: string;
  readonly display_name: string;
  readonly role: PlatformRole;
  readonly emails: readonly AccountEmail[];
  readonly identities: readonly AccountIdentity[];
  /** How strongly this session is currently authenticated. */
  readonly aal: Aal;
  /** Whether sensitive operations will demand a step-up first. */
  readonly step_up_required: boolean;
}

/**
 * A connected application, from the caller's own point of view.
 *
 * Mirrors `ApplicationView` in the admin crate, minus everything administrative.
 * The user-facing surface needs the `client_id` and the display name to render
 * "you have granted access to X"; it does not need the redirect URIs, the
 * registered scopes, or when the secret was rotated, and passing them to a
 * browser that does not need them widens the disclosure for no gain.
 */
export interface ConnectedApplication {
  readonly application_id: string;
  readonly client_id: string;
  readonly display_name: string;
  readonly access_mode: "oidc" | "oauth2";
  /** When access was granted, in milliseconds since the Unix epoch. */
  readonly granted_at_ms: number;
  /** The scopes actually granted, which may be fewer than were offered. */
  readonly granted_scopes: readonly string[];
}

/** What a second factor enrolment is. Mirrors `AuthenticatorKind`. */
export type AuthenticatorKind =
  "email_otp" | "totp" | "passkey" | "recovery_code";

/** One enrolled second factor, as the user sees it. */
export interface EnrolledAuthenticator {
  readonly authenticator_id: string;
  readonly kind: AuthenticatorKind;
  readonly label: string;
  /** When it was enrolled, in milliseconds since the Unix epoch. */
  readonly enrolled_at_ms: number;
}
