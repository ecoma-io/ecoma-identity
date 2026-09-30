/**
 * The data contracts the future administrative calls will return.
 *
 * These types are the console's half of `contracts/admin/v1/`. They mirror the
 * Rust types in `identity-application` field for field — `AdminUserRow`,
 * `SearchUsersOutcome`, `AdminAuditRow`, `QueryAuditOutcome`, `RoleChange` —
 * including the snake_case wire names, because a `serde` default serialises
 * them that way and a client that guessed camelCase would silently read
 * `undefined` out of a response that is actually correct.
 *
 * They are **types, not fixtures**. Nothing in this file constructs a value:
 * there is no sample user, no sample audit row, no `MOCK_USER`. A type with no
 * value behind it cannot be mistaken for a working table, and a reviewer looking
 * for the source of any row on screen will find that there isn't one. When the
 * Admin Worker implements `/admin/users`, these types get their first real value
 * — from the network, never from this file.
 *
 * ## What is deliberately absent
 *
 * The console does **not** get the linked `subject` for an external identity.
 * `AccountIdentity` in the user-facing app carries a provider's identifier for
 * the user; the administrative view of an account omits it. The type here has no
 * field for it, so a future change that tries to render one is a compile error
 * rather than a privacy regression discovered in review.
 *
 * There is also no `Password`, no `Secret`, no `ClientSecret` and no
 * `RecoveryCode` type. A console that could read any of those would be a
 * credential-disclosure surface, and not having the type is the cheapest way to
 * say so.
 */

/** A user's standing in the platform. Mirrors `PlatformRole`. */
export type PlatformRole = "member" | "support" | "administrator" | "service";

/** Whether an account may authenticate. Mirrors `UserStatus`. */
export type UserStatus =
  "active" | "suspended" | "deactivated" | "pending_verification";

/** The assurance level a session was established at. Mirrors `Aal`. */
export type Aal = "aal1" | "aal2";

/** Whether a registered client may serve traffic. Mirrors `ApplicationStatus`. */
export type ApplicationStatus = "active" | "suspended" | "retired";

/** How a registered client asks for access. Mirrors `ApplicationAccessMode`. */
export type ApplicationAccessMode = "oidc" | "oauth2";

/**
 * One row of the administrative user list. Mirrors `AdminUserRow`.
 *
 * Every field is read-only from the console's point of view. `role` and
 * `status` are shown; neither is edited by setting a field on a row. They change
 * only through the commands, which have their own refusal rules.
 */
export interface AdminUserRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly role: PlatformRole;
  readonly status: UserStatus;
  /** How many live sessions the user holds. */
  readonly active_sessions: number;
  /** When they last signed in, in milliseconds since the Unix epoch, or `null`. */
  readonly last_authenticated_at_ms: number | null;
  /** When the account was created, in milliseconds since the Unix epoch. */
  readonly created_at_ms: number;
}

/**
 * The filters for a user search. Mirrors `SearchUsers`.
 *
 * `query` is a free-text filter over display name and address. It is a *query
 * parameter*, never a raw SQL fragment: the repository is the only thing that
 * may decide what it matches, and a console that sent one would turn a search
 * box into an injection point the moment someone pasted the wrong thing.
 */
export interface SearchUsers {
  readonly query?: string | undefined;
  readonly status?: UserStatus | undefined;
  readonly role?: PlatformRole | undefined;
  /** Page size, bounded by the repository. */
  readonly limit: number;
  /** Page offset, bounded by the repository. */
  readonly offset: number;
}

/** A page of users. Mirrors `SearchUsersOutcome`. */
export interface SearchUsersOutcome {
  readonly users: readonly AdminUserRow[];
  /** Whether more pages exist. `has_more`, not a count, so the console does not
   *  have to claim a total it was not told. */
  readonly has_more: boolean;
}

/**
 * One row of the administrative audit view. Mirrors `AdminAuditRow`.
 *
 * `metadata` is already redacted server-side. It is a `Record<string, string>`
 * rather than a parsed object because the Worker redacts it into a flat map and
 * a console that re-parsed it would be re-deriving something the server already
 * decided was safe to show.
 */
export interface AdminAuditRow {
  readonly event_id: string;
  /** The event type as a wire string, e.g. `user_suspended`. */
  readonly event_type: string;
  readonly user_id: string | null;
  readonly actor_id: string | null;
  /** When it happened, in milliseconds since the Unix epoch. */
  readonly occurred_at_ms: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The filters for an audit query. Mirrors `QueryAudit`. */
export interface QueryAudit {
  readonly user_id?: string | undefined;
  readonly actor_id?: string | undefined;
  /** Only events at or after this time, in milliseconds since the epoch. */
  readonly since_ms?: number | undefined;
  /** Only administrative events. */
  readonly administrative_only: boolean;
  readonly limit: number;
  readonly offset: number;
}

/** A page of audit events, newest first. Mirrors `QueryAuditOutcome`. */
export interface QueryAuditOutcome {
  readonly events: readonly AdminAuditRow[];
  readonly has_more: boolean;
}

/**
 * What a role change would do, or why it is refused. Mirrors `RoleChange`.
 *
 * The refusals are in the contract because they are the *interesting* part of
 * role administration, and a console that only modelled the success case would
 * have nowhere to show a refusal. It is `tag = "outcome"` on the wire, so the
 * variants are distinguishable in JSON and the discrimination is not guesswork.
 */
export type RoleChange =
  | { readonly outcome: "permitted" }
  | { readonly outcome: "last_administrator"; readonly user_id: string }
  | { readonly outcome: "self_change" }
  | { readonly outcome: "not_permitted"; readonly role: PlatformRole };

/**
 * The context every administrative command carries. Mirrors `AdminContext`.
 *
 * Carried so the audit trail can record which operator acted and under which
 * session. The console does not get to choose these values — they come from the
 * session the Admin Worker resolved, and a client that could set them would be
 * able to forge an audit record.
 */
export interface AdminContext {
  readonly actor_id: string;
  readonly actor_session_id: string;
}

/**
 * One registered OAuth client, as the administrative surface sees it.
 *
 * Mirrors `ApplicationView`. `secret_rotated_at_ms` is `null` meaning "never",
 * which for a confidential client is a finding — the console will show that
 * rather than hiding it. There is no field for the secret itself.
 */
export interface ApplicationView {
  readonly application_id: string;
  readonly client_id: string;
  readonly display_name: string;
  readonly status: ApplicationStatus;
  readonly access_mode: ApplicationAccessMode;
  readonly redirect_uris: readonly string[];
  readonly allowed_scopes: readonly string[];
  readonly secret_rotated_at_ms: number | null;
}
