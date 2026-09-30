//! External and platform identities.
//!
//! An *identity* is a fact about a user asserted by something outside Ecoma —
//! an OAuth provider, a passkey authenticator's credential, a future SAML
//! federation. A user may hold several. The user is the account; the identities
//! are the ways of proving it is you.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{require_non_blank, DomainResult};

/// A provider that can assert an identity about a user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityProvider {
    /// A federated OAuth 2.0 / OIDC provider (Google, GitHub, …). The
    /// subject is the provider's own user identifier; it is only stable within
    /// that provider, which is why `Identity` pairs it with the provider.
    OAuth,
    /// A `WebAuthn` passkey. The subject is the credential's user handle.
    Passkey,
    /// An email address used as a direct login factor.
    Email,
    /// A future SAML federation. Reserved, not implemented in bootstrap.
    Saml,
}

impl IdentityProvider {
    /// Whether subjects from this provider are globally unique on their own.
    ///
    /// # Errors
    ///
    /// None. This is a property of the provider's specification, not a runtime
    /// decision.
    #[must_use]
    pub const fn subject_is_globally_unique(self) -> bool {
        match self {
            // A passkey's user handle is minted by us and is unique here.
            Self::Passkey => true,
            // Google's `sub` is stable and unique within Google's tenant;
            // GitHub's numeric id likewise. Both are only meaningful paired
            // with the provider, so "globally unique" is false in the sense
            // that matters: two providers may mint the same string.
            Self::OAuth | Self::Email | Self::Saml => false,
        }
    }
}

/// A user's opaque, stable identifier for one identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IdentityId(Uuid);

impl IdentityId {
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
    /// None today; see [`crate::user::UserId::new`] for why the signature is
    /// fallible anyway.
    pub fn new() -> DomainResult<Self> {
        Ok(Self(Uuid::new_v4()))
    }

    /// The canonical text form.
    #[must_use]
    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl core::fmt::Display for IdentityId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A way a user proves they are a particular user.
///
/// `(provider, subject)` is the natural key and is the subject of the "user
/// subject cannot be reused" invariant: the same pair may attach to one user
/// once, and re-attaching it to a different user is the account-takeover
/// shape this type exists to make hard to write by accident.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    /// This identity's own identifier.
    pub id: IdentityId,
    /// The user this identity authenticates.
    pub user_id: crate::user::UserId,
    /// Which kind of provider asserted it.
    pub provider: IdentityProvider,
    /// The provider's identifier for the user. Not a secret. A user's email
    /// address is often this value, which is why it is not logged.
    pub subject: String,
    /// A label the user chose, for the account's identity list.
    pub label: Option<String>,
}

impl Identity {
    /// Build an identity.
    ///
    /// # Errors
    ///
    /// [`crate::error::DomainError::Invalid`] when `subject` is blank, padded, or longer than
    /// 512 bytes. `label`, when present, is bounded at 200 bytes.
    pub fn new(
        user_id: crate::user::UserId,
        provider: IdentityProvider,
        subject: impl Into<String>,
    ) -> DomainResult<Self> {
        let subject = subject.into();
        require_non_blank("subject", &subject)?;
        // 512 bytes is generous for a provider subject (Google's is 21) and
        // bounded so a hostile provider cannot write an unbounded row.
        crate::error::require_max_len("subject", &subject, 512)?;

        Ok(Self {
            id: IdentityId::new()?,
            user_id,
            provider,
            subject,
            label: None,
        })
    }

    /// Attach a user-chosen label.
    ///
    /// # Errors
    ///
    /// [`crate::error::DomainError::Invalid`] when `label` is blank, padded, or longer than
    /// 200 bytes.
    pub fn with_label(mut self, label: impl Into<String>) -> DomainResult<Self> {
        let label = label.into();
        require_non_blank("label", &label)?;
        crate::error::require_max_len("label", &label, 200)?;
        self.label = Some(label);
        Ok(self)
    }

    /// Whether this identity may be unlinked from its user.
    ///
    /// # Errors
    ///
    /// None. Unlinking is constrained by a count the application layer
    /// maintains, not by a property of the identity itself.
    #[must_use]
    pub const fn is_unlinkable(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user::UserId;

    fn identity(provider: IdentityProvider, subject: &str) -> Identity {
        Identity::new(UserId::new().expect("uuid"), provider, subject).expect("valid")
    }

    #[test]
    fn an_oauth_subject_is_not_treated_as_globally_unique() {
        // Two providers can mint "12345". Only `(provider, subject)` is a key.
        assert!(!IdentityProvider::OAuth.subject_is_globally_unique());
        assert!(IdentityProvider::Passkey.subject_is_globally_unique());
    }

    #[test]
    fn a_blank_subject_is_refused() {
        let uid = UserId::new().expect("uuid");
        assert!(Identity::new(uid, IdentityProvider::OAuth, "  ").is_err());
    }

    #[test]
    fn an_absurdly_long_subject_is_refused() {
        let uid = UserId::new().expect("uuid");
        let long = "s".repeat(513);
        assert!(Identity::new(uid, IdentityProvider::OAuth, &long).is_err());
    }

    #[test]
    fn a_label_is_optional_and_validated_when_present() {
        let id = identity(IdentityProvider::OAuth, "sub-1");
        assert_eq!(id.label, None);
        assert_eq!(
            id.clone()
                .with_label("Work account")
                .expect("valid")
                .label
                .as_deref(),
            Some("Work account")
        );
        assert!(id.with_label("").is_err());
    }

    #[test]
    fn two_providers_may_issue_the_same_subject_string() {
        // Not a collision: the natural key is the pair. Asserting that the
        // *strings* are equal is what makes the pair requirement visible.
        let a = identity(IdentityProvider::OAuth, "12345");
        let b = identity(IdentityProvider::Saml, "12345");
        assert_eq!(a.subject, b.subject);
        assert_ne!(a.provider, b.provider);
    }
}
