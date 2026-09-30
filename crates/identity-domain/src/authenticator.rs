//! Authenticators: the factors a user may present, and which are enrolled.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{require_non_blank, DomainError, DomainResult};

/// What kind of factor an authenticator is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticatorKind {
    /// A one-time code delivered to a verified email address. A first factor:
    /// possession of the address, plus possession of the code.
    EmailOtp,
    /// A time-based one-time password from an authenticator app. A second
    /// factor: something the user holds.
    Totp,
    /// A `WebAuthn` credential. A second factor, and phishing-resistant.
    Passkey,
    /// A single-use secret stored hashed, for account recovery when every
    /// other factor is lost.
    RecoveryCode,
}

impl AuthenticatorKind {
    /// Whether proving this authenticator raises a session to AAL2.
    ///
    /// # Errors
    ///
    /// None. This is a property of the factor's specification — "does holding
    /// this thing satisfy a second-factor requirement" — and it is the reason
    /// `identity-security` never has to special-case an authenticator.
    #[must_use]
    pub const fn is_second_factor(self) -> bool {
        matches!(self, Self::Totp | Self::Passkey)
    }

    /// Whether this factor establishes an identity on its own.
    ///
    /// # Errors
    ///
    /// None. See [`AuthenticatorKind::is_second_factor`].
    #[must_use]
    pub const fn is_primary_factor(self) -> bool {
        matches!(self, Self::EmailOtp)
    }
}

/// A user's opaque, stable identifier for one enrolled factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AuthenticatorId(Uuid);

impl AuthenticatorId {
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

impl core::fmt::Display for AuthenticatorId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// An enrolled factor belonging to one user.
///
/// This is the *record of enrolment*. It holds no secret material: a TOTP
/// row stores the shared seed encrypted by a key the Worker holds, a passkey
/// row stores the credential's public key, and both are the concern of
/// `identity-security`. What lives here is the fact of enrolment — which
/// factor, for whom, since when, and whether it has been used — so the domain
/// can answer "what may this user present?" without touching a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Authenticator {
    /// This enrolment's identifier.
    pub id: AuthenticatorId,
    /// The user who enrolled it.
    pub user_id: crate::user::UserId,
    /// What kind of factor it is.
    pub kind: AuthenticatorKind,
    /// A user-chosen label, so two authenticator apps are distinguishable.
    pub label: Option<String>,
    /// When it was enrolled, as milliseconds since the Unix epoch.
    pub enrolled_at_ms: i64,
    /// When it was last successfully used, as milliseconds since the Unix
    /// epoch. `None` means never. This is the input to the "recent
    /// authentication" window a step-up operation reads.
    pub last_used_at_ms: Option<i64>,
}

impl Authenticator {
    /// Build an enrolment.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `label` is present but blank, padded, or
    /// over 200 bytes. `last_used_at_ms` must not precede `enrolled_at_ms` —
    /// a factor used before it existed is a corrupt row, not a state.
    pub fn new(
        user_id: crate::user::UserId,
        kind: AuthenticatorKind,
        enrolled_at_ms: i64,
    ) -> DomainResult<Self> {
        Ok(Self {
            id: AuthenticatorId::new()?,
            user_id,
            kind,
            label: None,
            enrolled_at_ms,
            last_used_at_ms: None,
        })
    }

    /// Attach a user-chosen label.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `label` is blank, padded, or over 200
    /// bytes.
    pub fn with_label(mut self, label: impl Into<String>) -> DomainResult<Self> {
        let label = label.into();
        require_non_blank("label", &label)?;
        crate::error::require_max_len("label", &label, 200)?;
        self.label = Some(label);
        Ok(self)
    }

    /// Record a successful use at `at_ms`.
    ///
    /// # Errors
    ///
    /// [`DomainError::IllegalTransition`] when `at_ms` precedes the enrolment
    /// time.
    pub fn record_use(&mut self, at_ms: i64) -> DomainResult<()> {
        if at_ms < self.enrolled_at_ms {
            return Err(DomainError::illegal(
                "an authenticator cannot be used before it was enrolled",
            ));
        }
        self.last_used_at_ms = Some(at_ms);
        Ok(())
    }

    /// Whether this factor was used within `window_ms` of `now_ms`.
    ///
    /// The "recently authenticated" predicate, as a fact about *this* factor.
    /// A session's own flag is the aggregate of it across the user's
    /// factors; keeping the per-factor answer here is what lets the security
    /// layer explain *why* a step-up was or was not satisfied.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn was_used_recently(&self, now_ms: i64, window_ms: i64) -> bool {
        self.last_used_at_ms.is_some_and(|used| {
            used <= now_ms && now_ms.saturating_sub(used) < window_ms
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(kind: AuthenticatorKind) -> Authenticator {
        Authenticator::new(
            crate::user::UserId::new().expect("uuid"),
            kind,
            1_000,
        )
        .expect("valid")
    }

    #[test]
    fn totp_and_passkey_are_second_factors_email_otp_is_not() {
        assert!(AuthenticatorKind::Totp.is_second_factor());
        assert!(AuthenticatorKind::Passkey.is_second_factor());
        assert!(!AuthenticatorKind::EmailOtp.is_second_factor());
        assert!(!AuthenticatorKind::RecoveryCode.is_second_factor());
    }

    #[test]
    fn recovery_code_is_neither_primary_nor_second() {
        // A recovery code substitutes for a lost second factor. Calling it a
        // second factor would let a stolen recovery code satisfy AAL2 forever;
        // calling it primary would let it stand in for the account itself.
        assert!(!AuthenticatorKind::RecoveryCode.is_second_factor());
        assert!(!AuthenticatorKind::RecoveryCode.is_primary_factor());
    }

    #[test]
    fn a_never_used_factor_is_not_recently_used() {
        assert!(!auth(AuthenticatorKind::Totp).was_used_recently(1_500, 300));
    }

    #[test]
    fn the_recent_window_is_half_open_and_looks_backwards_only() {
        let mut a = auth(AuthenticatorKind::Passkey);
        a.record_use(1_000).expect("valid");
        assert!(a.was_used_recently(1_299, 300), "inside the window");
        assert!(!a.was_used_recently(1_300, 300), "window is exclusive");
        // A clock reading before the use cannot make it "recent" — that would
        // turn clock skew into an authentication bypass.
        assert!(!a.was_used_recently(500, 300));
    }

    #[test]
    fn use_before_enrolment_is_refused() {
        let mut a = auth(AuthenticatorKind::Totp);
        assert!(a.record_use(999).is_err());
        assert_eq!(a.last_used_at_ms, None, "a refused use must not be recorded");
    }

    #[test]
    fn the_record_of_enrolment_holds_no_secret() {
        // The struct is the enrolment record; secret material is `identity-
        // security`'s business. A compile-time reminder: this type is
        // Serialize, so anything added to it lands in logs and API responses.
        let a = auth(AuthenticatorKind::Totp);
        let json = serde_json::to_string(&a).expect("serializable");
        for forbidden in ["secret", "seed", "private_key", "credential"] {
            assert!(
                !json.contains(forbidden),
                "{forbidden} must not appear in the enrolment record: {json}"
            );
        }
    }
}
