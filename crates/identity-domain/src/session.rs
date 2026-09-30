//! Sessions: the fact that some request is being made by a proven user.
//!
//! A session is a server-side record, not a token. The token that references
//! it (a cookie, a bearer credential) is transport; this is the state the
//! transport is checked against. Keeping the two apart is what makes
//! "revoke this session" instant and total rather than eventual.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{DomainError, DomainResult};

/// A session's opaque, stable identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(Uuid);

impl SessionId {
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

    /// Parse an identifier from its canonical text form.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `value` is not a UUID.
    pub fn parse(value: &str) -> DomainResult<Self> {
        Uuid::parse_str(value)
            .map(Self)
            .map_err(|e| DomainError::invalid("session_id", format!("not a uuid: {e}")))
    }

    /// The canonical text form.
    #[must_use]
    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl core::fmt::Display for SessionId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Whether a session is still usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Live and usable.
    Active,
    /// Explicitly ended — signed out, revoked, or superseded. Kept as a
    /// distinct state rather than deleted so that "this credential was
    /// revoked" is answerable, and so replaying it is *refused* rather than
    /// being mistaken for a session that never existed.
    Revoked,
    /// Superseded by a newer session, or expired. The distinction from
    /// `Revoked` is for reporting, not for the access decision — both are
    /// equally unusable.
    Expired,
}

impl SessionStatus {
    /// Whether a session in this state authenticates its bearer.
    ///
    /// # Errors
    ///
    /// None. See [`crate::user::UserStatus::permits_authentication`].
    #[must_use]
    pub const fn permits_authentication(self) -> bool {
        matches!(self, Self::Active)
    }
}

/// An authenticated session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// This session's identifier. Not a credential: knowing it is not enough
    /// to authenticate, because the transport also carries a secret the
    /// server stores hashed.
    pub id: SessionId,
    /// The user this session acts for.
    pub user_id: crate::user::UserId,
    /// Whether the session is still usable.
    pub status: SessionStatus,
    /// The user's `security_version` when this session was issued. A
    /// mismatch against the current value means the account changed
    /// security-relevantly and this session is stale — the mechanism behind
    /// "revoke all sessions" without enumerating them.
    pub security_version: u32,
    /// When the session was created, as milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// When the session expires, as milliseconds since the Unix epoch.
    ///
    /// Absolute, not a duration: a duration stored on the row would make
    /// "when does this expire" depend on when you asked.
    pub expires_at_ms: i64,
    /// The assurance level the session was established at.
    pub aal: crate::security::Aal,
    /// Whether the user proved a second factor during this session. Distinct
    /// from `aal` because a step-up is a property of a *moment*, while the AAL
    /// is a floor for the session's lifetime.
    pub recently_authenticated: bool,
}

impl Session {
    /// Build a session.
    ///
    /// # Errors
    ///
    /// [`DomainError::IllegalTransition`] when `expires_at_ms` is not after
    /// `created_at_ms`. A session that is born expired is a caller bug, not a
    /// runtime condition.
    pub fn new(
        user_id: crate::user::UserId,
        security_version: u32,
        created_at_ms: i64,
        expires_at_ms: i64,
        aal: crate::security::Aal,
    ) -> DomainResult<Self> {
        if expires_at_ms <= created_at_ms {
            return Err(DomainError::illegal(
                "a session must expire after it is created",
            ));
        }
        Ok(Self {
            id: SessionId::new()?,
            user_id,
            status: SessionStatus::Active,
            security_version,
            created_at_ms,
            expires_at_ms,
            aal,
            recently_authenticated: false,
        })
    }

    /// Whether the session is usable at `now_ms`.
    ///
    /// Status and expiry are checked together, and both matter: an `Active`
    /// row past its expiry is expired, and an `Expired` row before its expiry
    /// is still refused. Collapsing them to one flag would lose the ability to
    /// answer "was this revoked or merely stale?" in an incident review.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn is_usable_at(&self, now_ms: i64) -> bool {
        self.status.permits_authentication() && now_ms < self.expires_at_ms
    }

    /// Revoke the session.
    ///
    /// # Errors
    ///
    /// [`DomainError::IllegalTransition`] when the session is not currently
    /// active. Revoking an already-revoked session is not a no-op — it is
    /// evidence that two code paths disagree about the session's state, and
    /// the caller needs to know which.
    pub fn revoke(&mut self) -> DomainResult<()> {
        if !self.status.permits_authentication() {
            return Err(DomainError::illegal("session is not active"));
        }
        self.status = SessionStatus::Revoked;
        Ok(())
    }

    /// Whether this session's assurance level satisfies an operation that
    /// demands `required`.
    ///
    /// # Errors
    ///
    /// None. An AAL comparison is total; the interesting refusal lives in
    /// `identity-security`, which is where "what may I do at AAL1" is decided.
    #[must_use]
    pub const fn satisfies(&self, required: crate::security::Aal) -> bool {
        self.aal.satisfies(required)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::Aal;

    fn session() -> Session {
        Session::new(
            crate::user::UserId::new().expect("uuid"),
            3,
            1_000,
            2_000,
            Aal::Aal1,
        )
        .expect("valid")
    }

    #[test]
    fn a_session_that_is_born_expired_is_refused() {
        let uid = crate::user::UserId::new().expect("uuid");
        assert!(Session::new(uid, 0, 1_000, 1_000, Aal::Aal1).is_err());
        assert!(Session::new(uid, 0, 1_000, 999, Aal::Aal1).is_err());
        assert!(Session::new(uid, 0, 1_000, 1_001, Aal::Aal1).is_ok());
    }

    #[test]
    fn a_new_session_starts_active_and_not_recently_authenticated() {
        // `recently_authenticated` starts false because it is a statement
        // about the last few minutes, and a session that has existed for zero
        // minutes has not proved anything recently.
        let s = session();
        assert_eq!(s.status, SessionStatus::Active);
        assert!(!s.recently_authenticated);
        assert_eq!(s.security_version, 3);
    }

    #[test]
    fn expiry_and_status_are_checked_independently() {
        let mut s = session();
        assert!(s.is_usable_at(1_999));
        assert!(!s.is_usable_at(2_000), "expiry is exclusive at the boundary");

        s.revoke().expect("active");
        assert!(!s.is_usable_at(1), "revoked before expiry is still refused");
    }

    #[test]
    fn revoking_twice_is_an_error_not_a_no_op() {
        let mut s = session();
        s.revoke().expect("first revoke");
        assert!(s.revoke().is_err(), "a second revoke must be visible");
    }

    #[test]
    fn an_aal1_session_does_not_satisfy_an_aal2_operation() {
        let s = session();
        assert!(s.satisfies(Aal::Aal1));
        assert!(!s.satisfies(Aal::Aal2));
    }

    #[test]
    fn session_identifiers_round_trip() {
        let s = session();
        assert_eq!(SessionId::parse(&s.id.as_string()).expect("round trip"), s.id);
        assert!(SessionId::parse("nope").is_err());
    }
}
