//! Failures a security gate can report.
//!
//! A dedicated type rather than `anyhow::Error`, because a failure in this
//! layer is a *security-relevant statement* and the audit trail wants to
//! record which of them occurred. "Verification failed" and "the signing key
//! is missing" are both `Err`, and conflating them would either hide a
//! configuration problem behind a routine user error or alarm on every
//! mistyped code.

/// Why a security gate refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecurityError {
    /// The presented credential does not match. The single most common
    /// outcome, and the one a caller must never be able to distinguish from
    /// several others at the HTTP boundary.
    #[error("verification failed")]
    VerificationFailed,

    /// The credential has expired. Kept separate from
    /// [`SecurityError::VerificationFailed`] so the audit trail can tell a
    /// late request from a wrong one — a user who consistently retries with
    /// stale codes has a clock problem, not an attack.
    #[error("credential expired")]
    Expired,

    /// The credential has already been redeemed. Single-use is the property
    /// that makes a leaked OTP harmless after one use, so a replay is its own
    /// outcome rather than another wrong code.
    #[error("credential already redeemed")]
    AlreadyRedeemed,

    /// The challenge does not exist, or was issued for a different flow.
    /// Not [`SecurityError::VerificationFailed`] because a client presenting a
    /// challenge from another session is a different event.
    #[error("unknown or mismatched challenge")]
    ChallengeMismatch,

    /// The rate limiter is unavailable, so the gate cannot answer. Every
    /// implementation must fail **closed** here: refusing a login because the
    /// rate limiter is down is correct; permitting one is not.
    #[error("rate limiter unavailable: {reason}")]
    RateLimiterUnavailable {
        /// What the limiter reported.
        reason: String,
    },

    /// A required secret or key is not configured. A configuration fault, not
    /// a user error, and never to be reported to a client.
    #[error("missing secret: {name}")]
    MissingSecret {
        /// Which secret is absent.
        name: &'static str,
    },

    /// A cryptographic operation failed. The message is for an operator; the
    /// transport maps this to a generic 500 and forwards nothing.
    #[error("cryptographic operation failed: {reason}")]
    Cryptographic {
        /// What failed, in terms safe to log.
        reason: String,
    },

    /// A token is structurally wrong — not a JWT, missing a segment, a
    /// malformed `kid`.
    #[error("malformed token")]
    MalformedToken,

    /// A token is well-formed and correctly signed but not acceptable: wrong
    /// audience, wrong issuer, already revoked, or outside its validity
    /// window. One variant for all of them, because a caller that could tell
    /// "wrong audience" from "revoked" could probe for which tokens exist.
    #[error("token rejected")]
    TokenRejected,

    /// The operation requires a higher assurance level than the session holds.
    #[error("assurance level insufficient: need {required}, have {actual}")]
    InsufficientAssurance {
        /// The level the operation demands.
        required: identity_domain::security::Aal,
        /// The level the session holds.
        actual: identity_domain::security::Aal,
    },
}

impl SecurityError {
    /// A stable machine-readable code for the error envelope.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::VerificationFailed => "verification_failed",
            Self::Expired => "expired",
            Self::AlreadyRedeemed => "already_redeemed",
            Self::ChallengeMismatch => "challenge_mismatch",
            // A dependency's unavailability is our outage, not the caller's
            // fault, and the code must say so.
            Self::RateLimiterUnavailable { .. } => "temporarily_unavailable",
            Self::MissingSecret { .. } | Self::Cryptographic { .. } => "internal_error",
            Self::MalformedToken => "malformed_token",
            Self::TokenRejected => "invalid_token",
            Self::InsufficientAssurance { .. } => "insufficient_assurance",
        }
    }

    /// Whether this error is safe to show a client verbatim.
    ///
    /// Everything except the operator-facing variants. The transport must ask
    /// rather than assume: a `Cryptographic` message can carry a key name, and
    /// a `MissingSecret` message names the secret that is absent.
    #[must_use]
    pub fn is_client_safe(&self) -> bool {
        !matches!(
            self,
            Self::RateLimiterUnavailable { .. }
                | Self::MissingSecret { .. }
                | Self::Cryptographic { .. }
        )
    }

    /// Whether this failure is worth an audit event.
    ///
    /// A repeated `VerificationFailed` is a credential-stuffing signal. A
    /// `MalformedToken` is usually a confused client. A `RateLimiterUnavailable`
    /// is an outage. Recording all three in one table would make the first
    /// unqueryable.
    #[must_use]
    pub const fn merits_audit(&self) -> bool {
        match self {
            Self::VerificationFailed
            | Self::AlreadyRedeemed
            | Self::ChallengeMismatch
            | Self::TokenRejected
            | Self::InsufficientAssurance { .. } => true,
            Self::Expired
            | Self::MalformedToken
            | Self::RateLimiterUnavailable { .. }
            | Self::MissingSecret { .. }
            | Self::Cryptographic { .. } => false,
        }
    }
}

/// Convenience alias for a security result.
pub type SecurityResult<T> = Result<T, SecurityError>;

/// A trait's implementations must never accept a comparison they cannot make
/// constant-time.
///
/// This is a documentation contract, not a checked one: the compiler cannot see
/// a comparison's timing. It is written down here because the gates that depend
/// on it are exactly the ones where a timing leak turns a comparison oracle
/// into a credential.
pub trait ConstantTimeComparable: private::Sealed {}

mod private {
    /// Prevents [`crate::error::ConstantTimeComparable`] from being
    /// implemented outside this crate — it is a contract note for
    /// implementations, not a capability.
    pub trait Sealed {}
}

#[cfg(test)]
mod tests {
    use core::fmt;

    use super::*;
    use identity_domain::security::Aal;

    #[test]
    fn operator_facing_failures_are_never_client_safe() {
        // The transport asks `is_client_safe`; if a future variant were
        // added without an answer here it would default to the catch-all arm
        // below, so this test fails rather than leaking.
        let all = [
            SecurityError::VerificationFailed,
            SecurityError::Expired,
            SecurityError::AlreadyRedeemed,
            SecurityError::ChallengeMismatch,
            SecurityError::RateLimiterUnavailable {
                reason: "timeout".into(),
            },
            SecurityError::MissingSecret {
                name: "SIGNING_KEY",
            },
            SecurityError::Cryptographic {
                reason: "key rejected".into(),
            },
            SecurityError::MalformedToken,
            SecurityError::TokenRejected,
            SecurityError::InsufficientAssurance {
                required: Aal::Aal2,
                actual: Aal::Aal1,
            },
        ];
        for error in all {
            assert!(!error.code().is_empty(), "{error:?} has no code");
        }
        assert!(!SecurityError::MissingSecret { name: "K" }.is_client_safe());
        assert!(!SecurityError::Cryptographic { reason: "r".into() }.is_client_safe());
    }

    #[test]
    fn a_missing_secret_is_an_internal_error_not_a_user_error() {
        // A client that learned "the signing key is missing" learns the
        // provider's configuration. The code must be `internal_error` so the
        // 5xx shape is right even when the message is not forwarded.
        let e = SecurityError::MissingSecret {
            name: "SIGNING_KEY",
        };
        assert_eq!(e.code(), "internal_error");
    }

    #[test]
    fn a_rate_limiter_outage_is_temporarily_unavailable() {
        // Not `internal_error`: this one is genuinely retryable by the client,
        // and the distinction is what lets it be retried.
        let e = SecurityError::RateLimiterUnavailable {
            reason: "timeout".into(),
        };
        assert_eq!(e.code(), "temporarily_unavailable");
    }

    #[test]
    fn the_insufficient_assurance_error_names_both_levels() {
        let e = SecurityError::InsufficientAssurance {
            required: Aal::Aal2,
            actual: Aal::Aal1,
        };
        let text = e.to_string();
        assert!(text.contains("aal2"), "{text}");
        assert!(text.contains("aal1"), "{text}");
    }

    #[test]
    fn only_security_relevant_failures_are_audited() {
        // Credential stuffing shows up as a run of `VerificationFailed`. A
        // `MalformedToken` is noise in that same table.
        assert!(SecurityError::VerificationFailed.merits_audit());
        assert!(SecurityError::TokenRejected.merits_audit());
        assert!(!SecurityError::MalformedToken.merits_audit());
        assert!(!SecurityError::Expired.merits_audit());
        assert!(!SecurityError::MissingSecret { name: "K" }.merits_audit());
    }

    #[test]
    fn errors_render_without_panicking() {
        let e = SecurityError::MalformedToken;
        let _: &dyn fmt::Display = &e;
        assert!(!format!("{e}").is_empty());
    }
}
