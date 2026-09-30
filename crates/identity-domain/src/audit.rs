//! Audit events: the durable record of what happened to an account.
//!
//! An audit event is not a log line. It is a row: written in the same D1
//! transaction as the state change it describes, queryable by an
//! administrator, and never mutated. That is what makes it evidence rather
//! than telemetry.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::DomainResult;

/// An audit event's opaque, stable identifier.
///
/// Also the event's idempotency key at the consumer end: a redelivered
/// `identity.audit.archive.v1` message carrying the same id is the same
/// event, not a second one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AuditEventId(Uuid);

impl AuditEventId {
    /// Create an identifier from a UUID.
    ///
    /// # Errors
    ///
    /// None. See [`crate::user::UserId::from_uuid`].
    #[must_use]
    pub const fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    /// Mint a new random identifier.
    ///
    /// # Errors
    ///
    /// None today; see [`crate::user::UserId::new`].
    pub fn new() -> DomainResult<Self> {
        Ok(Self(Uuid::new_v4()))
    }

    /// The canonical text form.
    #[must_use]
    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl core::fmt::Display for AuditEventId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// What kind of thing happened.
///
/// A closed set is a deliberate choice. An open string here would let a
/// caller invent an event name that no query, no retention policy and no
/// alert knows about — the audit trail's value is that its vocabulary is
/// closed enough to be complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventType {
    /// A user authenticated successfully.
    UserAuthenticated,
    /// An authentication attempt failed.
    AuthenticationFailed,
    /// A session was created.
    SessionCreated,
    /// A session was revoked, by the user or by an administrator.
    SessionRevoked,
    /// Every session belonging to a user was revoked.
    AllSessionsRevoked,
    /// A factor was enrolled.
    AuthenticatorEnrolled,
    /// A factor was removed.
    AuthenticatorRemoved,
    /// An external identity was linked to an account.
    IdentityLinked,
    /// An external identity was unlinked.
    IdentityUnlinked,
    /// An email address was added to an account.
    EmailAdded,
    /// An email address was removed from an account.
    EmailRemoved,
    /// A user's display name changed.
    ProfileUpdated,
    /// A user was suspended by an administrator.
    UserSuspended,
    /// A user was reinstated by an administrator.
    UserUnsuspended,
    /// A user's platform role changed.
    UserRoleChanged,
    /// An OAuth client was registered.
    ApplicationRegistered,
    /// An OAuth client's registration changed.
    ApplicationUpdated,
    /// An OAuth client's secret was rotated.
    ApplicationSecretRotated,
    /// Access was granted to an application on a user's behalf.
    ApplicationAccessGranted,
    /// Access previously granted to an application was withdrawn.
    ApplicationAccessRevoked,
    /// The account's security version was bumped.
    SecurityVersionBumped,
}

impl AuditEventType {
    /// Whether an administrator changing an account caused this event.
    ///
    /// Used by the admin audit query to separate "someone did something to
    /// this user" from "this user did something".
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn is_administrative(self) -> bool {
        matches!(
            self,
            Self::UserSuspended
                | Self::UserUnsuspended
                | Self::UserRoleChanged
                | Self::AllSessionsRevoked
                | Self::ApplicationRegistered
                | Self::ApplicationUpdated
                | Self::ApplicationSecretRotated
        )
    }

    /// Whether this event names a user as its subject, as opposed to naming an
    /// application or a system.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn concerns_a_user(self) -> bool {
        !matches!(
            self,
            Self::ApplicationRegistered | Self::ApplicationUpdated | Self::ApplicationSecretRotated
        )
    }
}

/// A durable record of one security-relevant change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEvent {
    /// This event's identifier, and its idempotency key downstream.
    pub id: AuditEventId,
    /// What happened.
    pub event_type: AuditEventType,
    /// The user the event is about, when it is about one.
    pub user_id: Option<crate::user::UserId>,
    /// The administrator who performed the action, when one did.
    pub actor_id: Option<crate::user::UserId>,
    /// The session the action was performed under, for correlating an
    /// administrator's actions with the session they held.
    pub actor_session_id: Option<crate::session::SessionId>,
    /// When it happened, as milliseconds since the Unix epoch.
    pub occurred_at_ms: i64,
    /// The request that caused it, so an operator can find the Worker log
    /// lines for the same request.
    pub request_id: Option<String>,
    /// Free-form, already-redacted detail. A `BTreeMap`, not a `HashMap`,
    /// because an audit row's JSON must serialise in a stable order to be
    /// diffable in a review.
    pub metadata: std::collections::BTreeMap<String, String>,
}

impl AuditEvent {
    /// Build an event.
    ///
    /// # Errors
    ///
    /// [`crate::error::DomainError::Invalid`] when `request_id` is present but longer than
    /// 128 bytes, or any `metadata` key or value is blank or over 512 bytes.
    /// Unbounded metadata is how secrets end up in an audit table.
    pub fn new(event_type: AuditEventType, occurred_at_ms: i64) -> DomainResult<Self> {
        Ok(Self {
            id: AuditEventId::new()?,
            event_type,
            user_id: None,
            actor_id: None,
            actor_session_id: None,
            occurred_at_ms,
            request_id: None,
            metadata: std::collections::BTreeMap::new(),
        })
    }

    /// Attach the user this event is about.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn about_user(mut self, user_id: crate::user::UserId) -> Self {
        self.user_id = Some(user_id);
        self
    }

    /// Attach the acting administrator.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn by_actor(mut self, actor_id: crate::user::UserId) -> Self {
        self.actor_id = Some(actor_id);
        self
    }

    /// Attach the request identifier for log correlation.
    ///
    /// # Errors
    ///
    /// [`crate::error::DomainError::Invalid`] when `request_id` is blank or over 128 bytes.
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> DomainResult<Self> {
        let request_id = request_id.into();
        crate::error::require_non_blank("request_id", &request_id)?;
        crate::error::require_max_len("request_id", &request_id, 128)?;
        self.request_id = Some(request_id);
        Ok(self)
    }

    /// Add one metadata entry.
    ///
    /// # Errors
    ///
    /// [`crate::error::DomainError::Invalid`] when the key is blank or over 64 bytes, or the
    /// value is over 512 bytes.
    pub fn with_metadata(
        mut self,
        key: impl Into<String>,
        value: impl Into<String>,
    ) -> DomainResult<Self> {
        let key = key.into();
        let value = value.into();
        crate::error::require_non_blank("metadata_key", &key)?;
        crate::error::require_max_len("metadata_key", &key, 64)?;
        crate::error::require_max_len("metadata_value", &value, 512)?;
        self.metadata.insert(key, value);
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn administrative_events_are_distinguishable_from_self_service_ones() {
        assert!(AuditEventType::UserSuspended.is_administrative());
        assert!(AuditEventType::UserRoleChanged.is_administrative());
        assert!(!AuditEventType::UserAuthenticated.is_administrative());
        assert!(!AuditEventType::SessionRevoked.is_administrative());
    }

    #[test]
    fn application_events_are_not_about_a_user() {
        assert!(!AuditEventType::ApplicationRegistered.concerns_a_user());
        assert!(!AuditEventType::ApplicationSecretRotated.concerns_a_user());
        assert!(AuditEventType::UserAuthenticated.concerns_a_user());
    }

    #[test]
    fn metadata_serialises_in_a_stable_order() {
        // A BTreeMap, so two events with the same metadata diff cleanly in a
        // review. A HashMap would make every re-serialisation a coin flip.
        let e = AuditEvent::new(AuditEventType::ProfileUpdated, 1_000)
            .expect("valid")
            .with_metadata("zebra", "1")
            .expect("valid")
            .with_metadata("alpha", "2")
            .expect("valid");
        let json = serde_json::to_string(&e.metadata).expect("serializable");
        assert!(
            json.find("alpha") < json.find("zebra"),
            "metadata must serialise sorted: {json}"
        );
    }

    #[test]
    fn oversized_metadata_is_refused() {
        let big = "v".repeat(513);
        let e = AuditEvent::new(AuditEventType::ProfileUpdated, 0).expect("valid");
        assert!(e.clone().with_metadata("k", &big).is_err());
    }

    #[test]
    fn an_event_carries_no_actor_until_one_is_attached() {
        // Self-service events have no administrator actor. Defaulting this to
        // "the user" would make an unattributed administrative action
        // indistinguishable from the user acting on themselves.
        let e = AuditEvent::new(AuditEventType::UserAuthenticated, 0).expect("valid");
        assert_eq!(e.actor_id, None);
        assert_eq!(e.user_id, None);
    }
}
