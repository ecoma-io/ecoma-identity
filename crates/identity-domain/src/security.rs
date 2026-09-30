//! Assurance levels and the security version.
//!
//! These two values are what make "prove it again before I do that" expressible
//! without re-authenticating from scratch: an AAL says how strongly a session
//! is established, and a security version says whether the account changed
//! since the session was issued.

use serde::{Deserialize, Serialize};

/// Authentication Assurance Level, as defined by `WebAuthn` and adopted by the
/// OAuth/OIDC world.
///
/// `Aal1` means "one factor proved"; `Aal2` means "a second factor proved, or
/// the factor itself is phishing-resistant". Ordinal, and the ordering is
/// load-bearing: [`Aal::satisfies`] is a `>=` comparison, so a session's floor
/// is the one number an authorization check needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Aal {
    /// One factor. A known account plus something it knows.
    Aal1,
    /// Two factors, or one phishing-resistant factor.
    Aal2,
}

impl Aal {
    /// Whether this level meets a requirement.
    ///
    /// The comparison is total and the direction matters: an AAL2 session
    /// satisfies an AAL1 operation (a stronger proof passes a weaker door),
    /// but not the reverse. That asymmetry is the "AAL1 cannot satisfy an AAL2
    /// operation" invariant, and it is why the function takes `self` as the
    /// level held and `required` as the level demanded.
    ///
    /// # Errors
    ///
    /// None. A comparison cannot fail.
    #[must_use]
    pub const fn satisfies(self, required: Self) -> bool {
        (self as u8) >= (required as u8)
    }

    /// The level an operation demands, as a wire value.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Aal1 => "aal1",
            Self::Aal2 => "aal2",
        }
    }
}

impl core::fmt::Display for Aal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_wire())
    }
}

/// The account-wide counter that invalidates stale sessions.
///
/// Stored on the user. Every session records the value in force when it was
/// issued; a request whose session's value is behind the user's is refused
/// without the server enumerating or touching that session at all. Bumping the
/// user's counter is therefore "revoke every session" — O(1) rather than O(n),
/// which matters when the trigger is a suspected compromise.
///
/// It is a plain `u32` wrapped in a newtype, not a timestamp: ordering is all
/// that is needed, and a timestamp would invite someone to compare it to a
/// clock and reason about skew.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct SecurityVersion(u32);

impl SecurityVersion {
    /// The initial value, carried by every freshly created account.
    pub const INITIAL: Self = Self(0);

    /// Build from a raw value read out of storage.
    ///
    /// # Errors
    ///
    /// None. The value came from a `u32` column; the newtype adds no
    /// invariant a corrupt row could violate beyond that.
    #[must_use]
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// The next version, which invalidates every session issued under this one.
    ///
    /// # Errors
    ///
    /// [`crate::error::DomainError::Invalid`] when the counter is already at
    /// `u32::MAX`. Saturating instead would make the bump a silent no-op that
    /// *looks* like it revoked every session and did not — the worst possible
    /// failure for this type.
    pub fn bumped(self) -> crate::error::DomainResult<Self> {
        self.0.checked_add(1).map(Self).ok_or_else(|| {
            crate::error::DomainError::invalid(
                "security_version",
                "counter exhausted; a migration is required",
            )
        })
    }

    /// The raw value.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

impl core::fmt::Display for SecurityVersion {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aal1_cannot_satisfy_an_aal2_operation() {
        assert!(!Aal::Aal1.satisfies(Aal::Aal2));
    }

    #[test]
    fn aal2_satisfies_an_aal1_operation() {
        // The direction of the one-sided rule. Getting this backwards would
        // lock every AAL2 user out of self-service password changes.
        assert!(Aal::Aal2.satisfies(Aal::Aal1));
    }

    #[test]
    fn a_level_satisfies_itself() {
        assert!(Aal::Aal1.satisfies(Aal::Aal1));
        assert!(Aal::Aal2.satisfies(Aal::Aal2));
    }

    #[test]
    fn the_ordinal_ordering_is_what_carries_the_rule() {
        // If someone reorders the variants, `satisfies` silently inverts. This
        // test fails on the reordering, which is the point of asserting the
        // raw ordering rather than only the public behaviour.
        assert!((Aal::Aal1 as u8) < (Aal::Aal2 as u8));
    }

    #[test]
    fn bumping_the_security_version_invalidates_older_sessions() {
        let v1 = SecurityVersion::INITIAL;
        let v2 = v1.bumped().expect("not exhausted");
        assert_ne!(v1, v2);
        assert!(v1 < v2);

        // The actual rule: a session issued under an older version does not
        // match the user's current one.
        let stale_session_version = v1;
        let current_user_version = v2;
        assert_ne!(stale_session_version, current_user_version);
    }

    #[test]
    fn bumping_is_not_idempotent() {
        // A second bump must land on a third value. If `bumped` were
        // "increment or stay", "revoke all sessions" issued twice would leave
        // sessions created between the two calls alive.
        let a = SecurityVersion::INITIAL.bumped().expect("ok");
        let b = a.bumped().expect("ok");
        assert_ne!(a, b);
    }

    #[test]
    fn an_exhausted_counter_refuses_rather_than_wrapping() {
        let max = SecurityVersion::new(u32::MAX);
        let err = max.bumped().expect_err("must not wrap");
        assert_eq!(err.code(), "invalid_request");
    }
}
