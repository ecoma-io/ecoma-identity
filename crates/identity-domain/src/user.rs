//! User identity: the person, and their standing in the platform.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{require_non_blank, DomainError, DomainResult};

/// A user's opaque, stable identifier.
///
/// Newtype, not a type alias, so a `UserId` cannot be passed where a
/// `SessionId` is expected. The compile error is the enforcement; the database
/// check is the backstop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(Uuid);

impl UserId {
    /// Create an identifier from a UUID.
    ///
    /// # Errors
    ///
    /// None. This constructor is infallible by construction; the fallible
    /// surface is [`UserId::new`], which validates a string first.
    #[must_use]
    pub const fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    /// Mint a new random identifier.
    ///
    /// # Errors
    ///
    /// None today. It returns `DomainResult` rather than a bare `Self` so that
    /// the identifier type's generating function can start failing (a future
    /// `UUIDv7` that needs a clock, say) without a breaking change at every call
    /// site.
    pub fn new() -> DomainResult<Self> {
        Ok(Self(Uuid::new_v4()))
    }

    /// Parse an identifier from its canonical text form.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `value` is not a UUID.
    pub fn parse(value: &str) -> DomainResult<Self> {
        Uuid::parse_str(value)
            .map(Self)
            .map_err(|e| DomainError::invalid("user_id", format!("not a uuid: {e}")))
    }

    /// Borrow the underlying UUID.
    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    /// The canonical text form, as stored and as exposed in contracts.
    #[must_use]
    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl core::fmt::Display for UserId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Whether a user may currently authenticate.
///
/// This is the axis the first domain invariant is written against: an inactive
/// user cannot authenticate. The bootstrap phase defines the states; it does
/// not yet enforce the rule (see [`crate::invariants`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserStatus {
    /// A normal, usable account.
    Active,
    /// Temporarily barred from authenticating. Sessions should be revoked by
    /// the application layer as part of the suspension, but the status is the
    /// authoritative gate: a stale session must still be refused.
    Suspended,
    /// Permanently barred. Distinct from [`UserStatus::Suspended`] because
    /// reactivation is not an allowed transition from it.
    Deactivated,
    /// Created but not yet proven to control a verified address or identity.
    /// A user in this state can complete a challenge but has no session.
    PendingVerification,
}

impl UserStatus {
    /// Whether a user in this state may hold an authenticated session.
    ///
    /// # Errors
    ///
    /// None. This is a query about a single value, not a domain transition,
    /// and inventing a `Result` here would push the "and therefore what?"
    /// burden onto every caller.
    #[must_use]
    pub const fn permits_authentication(self) -> bool {
        matches!(self, Self::Active)
    }

    /// Whether a user in this state can be reactivated.
    ///
    /// # Errors
    ///
    /// None, for the same reason as [`UserStatus::permits_authentication`].
    #[must_use]
    pub const fn permits_reactivation(self) -> bool {
        matches!(self, Self::Suspended | Self::PendingVerification)
    }
}

/// A platform-wide role.
///
/// Deliberately tiny. Ecoma Identity owns *authentication* and the
/// administrative control over accounts; it does not own business
/// authorization. A role here says what an administrator may do to accounts —
/// it is never consulted to decide whether a user may, say, merge a pull
/// request in another Ecoma repository (ADR-0005).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlatformRole {
    /// A user with no administrative standing. The overwhelming majority.
    Member,
    /// May inspect and moderate user accounts, applications and audit.
    Support,
    /// May do everything `Support` may, and change roles. This is the role
    /// "the last admin cannot be removed" is written about.
    Administrator,
    /// The platform's own service identity. Not a human; held by the Jobs
    /// worker when it needs to act on its own behalf.
    Service,
}

impl PlatformRole {
    /// Whether this role confers administrative authority over accounts.
    ///
    /// # Errors
    ///
    /// None. See [`UserStatus::permits_authentication`].
    #[must_use]
    pub const fn is_administrative(self) -> bool {
        matches!(self, Self::Administrator | Self::Support)
    }

    /// Whether this role may change another user's role.
    ///
    /// # Errors
    ///
    /// None. See [`UserStatus::permits_authentication`].
    #[must_use]
    pub const fn may_assign_roles(self) -> bool {
        matches!(self, Self::Administrator)
    }
}

/// A person with an account on the platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    /// The user's stable identifier.
    pub id: UserId,
    /// A human-chosen display name. Not a credential and not unique — two
    /// users may share one, and login must never be keyed on it.
    pub display_name: String,
    /// The user's standing in the platform.
    pub role: PlatformRole,
    /// Whether the account may authenticate.
    pub status: UserStatus,
    /// Bumped when something security-relevant about the account changes. Every
    /// session carries the value it was issued under; a mismatch invalidates
    /// it without a per-session scan.
    pub security_version: u32,
}

impl User {
    /// Build a user.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `display_name` is blank or padded with
    /// whitespace, or exceeds 200 bytes. `status` and `role` are enum values
    /// and cannot be out of range; `security_version` is 0 for a fresh account
    /// by definition, since no session can yet carry anything else.
    pub fn new(id: UserId, display_name: impl Into<String>) -> DomainResult<Self> {
        let display_name = display_name.into();
        require_non_blank("display_name", &display_name)?;
        crate::error::require_max_len("display_name", &display_name, 200)?;

        Ok(Self {
            id,
            display_name,
            role: PlatformRole::Member,
            status: UserStatus::PendingVerification,
            security_version: 0,
        })
    }

    /// Whether this user may authenticate right now.
    ///
    /// # Errors
    ///
    /// None. See [`UserStatus::permits_authentication`].
    #[must_use]
    pub const fn may_authenticate(&self) -> bool {
        self.status.permits_authentication()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> User {
        User::new(UserId::new().expect("uuid"), "Ada Lovelace").expect("valid")
    }

    #[test]
    fn a_new_user_is_pending_and_cannot_authenticate() {
        // A fresh account has proven nothing yet. Defaulting to Active here
        // would be the classic "unverified email is a login" bug, written
        // into the type's default state.
        assert_eq!(user().status, UserStatus::PendingVerification);
        assert!(!user().may_authenticate());
        assert_eq!(user().security_version, 0);
    }

    #[test]
    fn only_active_permits_authentication() {
        for status in [
            UserStatus::Active,
            UserStatus::Suspended,
            UserStatus::Deactivated,
            UserStatus::PendingVerification,
        ] {
            assert_eq!(
                status.permits_authentication(),
                status == UserStatus::Active,
                "{status:?} disagrees with itself"
            );
        }
    }

    #[test]
    fn a_deactivated_user_cannot_be_reactivated() {
        // The asymmetry is the point: suspension is reversible, deactivation
        // is not. If `permits_reactivation` ever returns true for
        // Deactivated, the last-admin invariant has a hole in it.
        assert!(!UserStatus::Deactivated.permits_reactivation());
        assert!(UserStatus::Suspended.permits_reactivation());
        assert!(UserStatus::PendingVerification.permits_reactivation());
        assert!(!UserStatus::Active.permits_reactivation());
    }

    #[test]
    fn blank_display_names_are_refused() {
        let id = UserId::new().expect("uuid");
        assert!(User::new(id, "").is_err());
        assert!(User::new(id, "   ").is_err());
        assert!(User::new(id, " Ada").is_err());
    }

    #[test]
    fn identifiers_round_trip_through_text() {
        let id = UserId::new().expect("uuid");
        assert_eq!(UserId::parse(&id.as_string()).expect("round trip"), id);
    }

    #[test]
    fn a_malformed_identifier_is_an_invalid_request_not_a_panic() {
        let err = UserId::parse("not-a-uuid").expect_err("must refuse");
        assert_eq!(err.code(), "invalid_request");
    }

    #[test]
    fn only_an_administrator_may_assign_roles() {
        assert!(PlatformRole::Administrator.may_assign_roles());
        assert!(!PlatformRole::Support.may_assign_roles());
        assert!(!PlatformRole::Member.may_assign_roles());
        assert!(!PlatformRole::Service.may_assign_roles());
    }

    #[test]
    fn support_is_administrative_but_not_role_changing() {
        // Support moderates accounts; it does not promote itself. Keeping the
        // two predicates separate is what makes that distinction expressible.
        assert!(PlatformRole::Support.is_administrative());
        assert!(!PlatformRole::Support.may_assign_roles());
        assert!(!PlatformRole::Member.is_administrative());
    }

    #[test]
    fn a_service_role_is_not_administrative() {
        // Jobs acts on its own behalf; if Service were administrative, a
        // background worker could be mistaken for an administrator at an
        // authorization check.
        assert!(!PlatformRole::Service.is_administrative());
    }
}
