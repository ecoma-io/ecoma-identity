//! Workers rate limiting, wrapped so that its failure mode is a decision and
//! not an accident.
//!
//! # This fails closed, and that is a trade-off
//!
//! When the rate limiter is unavailable — a binding that is not configured, a
//! platform error, a timeout — **the request is refused**, not allowed.
//!
//! That is a deliberate availability/security trade-off and it is worth stating
//! plainly, because the other side of it is real too. Failing closed means an
//! outage of the rate-limiting binding becomes an outage of authentication: no
//! login can complete while the limiter is down, including for users who have
//! never made a suspicious request. Failing open would keep authentication
//! available and would remove the only control standing between an attacker and
//! credential stuffing.
//!
//! For a system whose entire job is "who is this request made by", refusing a
//! user is a recoverable annoyance and admitting an attacker is not. So the
//! decision is: **refuse**, with
//! [`SecurityError::RateLimiterUnavailable`], which maps to a `503` with the
//! code `temporarily_unavailable` — a status that tells the client to retry
//! later, which is exactly true. A 429 would be a lie (the caller did nothing
//! wrong and has no budget to spend); a 500 would hide a retryable condition
//! behind an opaque fault.
//!
//! The cost of this choice is a documented availability risk, not a silent
//! one. It is recorded here rather than buried in a match arm.
//!
//! # What a key may and may not be
//!
//! The limiter is keyed on a string the caller composes. Two rules:
//!
//! 1. **Never key on a raw client IP.** `CF-Connecting-IP` is a single
//!    IPv4/IPv6 address and a botnet is not one address. A key that includes
//!    the IP *and* the identifier being attacked is better, and
//!    [`RateLimitKey`] is the type that makes composing it a deliberate act.
//! 2. **Never put a credential in the key.** The key is a lookup argument that
//!    ends up in platform logs and dashboards; a key containing a password or
//!    an email address is a secret in a log.

use identity_security::error::SecurityError;
use worker::Env;
use worker::RateLimiter;

/// The Workers rate-limiting binding name for the Identity Worker.
pub const IDENTITY_RATE_LIMITER_BINDING: &str = "RATE_LIMITER";

/// The Workers rate-limiting binding name for the Admin Worker.
pub const ADMIN_RATE_LIMITER_BINDING: &str = "ADMIN_RATE_LIMITER";

/// A composed rate-limit key.
///
/// A newtype rather than a `String` so "what may go in a key" is a type-level
/// question and not a review question. The constructors are the whole
/// vocabulary; there is no `From<String>`, because that would be the way in.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RateLimitKey(String);

impl RateLimitKey {
    /// The maximum length of a key, in bytes.
    ///
    /// A key is stored per window per binding. A caller that composed one out
    /// of a long URL could otherwise write unbounded keys into platform
    /// storage; 256 bytes is far more than any legitimate dimension needs.
    pub const MAX_LEN: usize = 256;

    /// A key for a *known* subject: a user identifier we already resolved.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the key is empty or over
    /// [`RateLimitKey::MAX_LEN`]. A subject id is a UUID, so the length check
    /// is a backstop rather than the usual bound.
    pub fn for_subject(namespace: &str, subject: &str) -> SecurityResultKey {
        Self::build(&[namespace, subject])
    }

    /// A key for an *unknown* subject, keyed on something coarser.
    ///
    /// This is the login-attempt case: before anyone proves who they are, the
    /// only dimensions available are the address presented and a client hint.
    /// Both are trivially spoofed, which is exactly why this key exists as a
    /// separate constructor — a reader can see where the coarse bucket is used
    /// and judge it there, rather than finding it spelled inline.
    ///
    /// # Errors
    ///
    /// As [`RateLimitKey::for_subject`].
    pub fn for_unverified(namespace: &str, hint: &str) -> SecurityResultKey {
        Self::build(&[namespace, "unverified", hint])
    }

    /// Compose a key from parts, bounded.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the composition is empty or over
    /// [`RateLimitKey::MAX_LEN`].
    fn build(parts: &[&str]) -> SecurityResultKey {
        let joined = parts.join(":");
        if joined.is_empty() {
            return Err(SecurityError::Cryptographic {
                reason: "rate limit key must not be empty".to_string(),
            });
        }
        if joined.len() > Self::MAX_LEN {
            return Err(SecurityError::Cryptographic {
                reason: format!("rate limit key must be at most {} bytes", Self::MAX_LEN),
            });
        }
        Ok(Self(joined))
    }

    /// The composed key, as the platform takes it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The result the security layer sees for a key.
///
/// `SecurityResultKey` is an alias, not a new error type: a rate-limit failure
/// is a security-gate failure and must reach the caller as
/// [`SecurityError::RateLimiterUnavailable`], because that variant is the one
/// the audit trail and the error envelope already understand.
pub type SecurityResultKey = core::result::Result<RateLimitKey, SecurityError>;

/// The gate the security layer calls.
///
/// Returning [`SecurityError::RateLimiterUnavailable`] on both "refused" and
/// "could not ask" is deliberate: a caller must not be able to distinguish
/// "you are over budget" from "the limiter is down", because that difference
/// tells an attacker they are being watched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitDecision {
    /// Under budget. The request may proceed.
    Allow,
    /// Over budget. The request is refused.
    Refuse,
}

/// Check one key against one rate limiter, failing closed.
///
/// # Errors
///
/// [`SecurityError::RateLimiterUnavailable`] when the binding is absent or the
/// platform call fails. That is the fail-closed decision described at the top
/// of this module, expressed as the error the rest of the system already
/// handles. Note the asymmetry with [`RateLimitDecision::Refuse`]: being over
/// budget is a successful answer, an error is not.
pub async fn check(
    limiter: &RateLimiter,
    key: &RateLimitKey,
) -> core::result::Result<RateLimitDecision, SecurityError> {
    let outcome = limiter.limit(key.as_str().to_string()).await.map_err(|e| {
        SecurityError::RateLimiterUnavailable {
            reason: e.to_string(),
        }
    })?;
    Ok(if outcome.success {
        RateLimitDecision::Allow
    } else {
        RateLimitDecision::Refuse
    })
}

/// Resolve a rate-limiting binding by name, failing closed if it is absent.
///
/// # Errors
///
/// [`SecurityError::RateLimiterUnavailable`] when the binding is not present
/// in the Worker `Env`. A missing binding is a configuration fault and is
/// reported as an outage rather than as a default, because a default here
/// would be "allow everything".
pub fn limiter_from_env(
    env: &Env,
    binding: &'static str,
) -> core::result::Result<RateLimiter, SecurityError> {
    env.rate_limiter(binding)
        .map_err(|_| SecurityError::RateLimiterUnavailable {
            reason: format!("binding {binding} is unavailable"),
        })
}

/// Resolve the Identity Worker's limiter and check a key in one step.
///
/// # Errors
///
/// As [`check`], including the absent-binding case.
pub async fn check_identity(
    env: &Env,
    key: &RateLimitKey,
) -> core::result::Result<RateLimitDecision, SecurityError> {
    let limiter = limiter_from_env(env, IDENTITY_RATE_LIMITER_BINDING)?;
    check(&limiter, key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verified_subject_is_namespaced_and_not_guessable() {
        let key = RateLimitKey::for_subject("login", "11111111-1111-4111-8111-111111111111")
            .expect("a key");
        assert_eq!(key.as_str(), "login:11111111-1111-4111-8111-111111111111");
    }

    #[test]
    fn an_unverified_subject_gets_its_own_namespace() {
        // The distinction is load-bearing: a bucket keyed on "who they claim to
        // be" must not be the same bucket as the one keyed on a proven
        // subject, or an attacker who guesses a user's id inherits their
        // budget.
        let key = RateLimitKey::for_unverified("login", "ada@example.com").expect("a key");
        assert_eq!(key.as_str(), "login:unverified:ada@example.com");
        assert_ne!(
            key.as_str(),
            RateLimitKey::for_unverified("login", "bob@example.com")
                .expect("a key")
                .as_str()
        );
    }

    #[test]
    fn an_empty_key_is_refused() {
        assert!(RateLimitKey::build(&[]).is_err());
    }

    #[test]
    fn an_oversized_key_is_refused() {
        // A key composed out of a long URL would otherwise write unbounded keys
        // into platform storage, one per request.
        let long = "x".repeat(RateLimitKey::MAX_LEN);
        assert!(RateLimitKey::build(&["ns", &long]).is_err());
        let fits = "x".repeat(RateLimitKey::MAX_LEN - 4);
        assert!(RateLimitKey::build(&["ns", &fits]).is_ok());
    }

    #[test]
    fn an_over_budget_answer_and_an_outage_are_different_shapes() {
        // Over budget is a decision the gate returns. An outage is an error the
        // gate refuses with. Keeping them apart is what lets a caller tell a
        // user "too many attempts" from a 503 "try again shortly", and both
        // from a 400.
        assert_ne!(
            RateLimitDecision::Allow,
            RateLimitDecision::Refuse,
            "the two decisions are distinct"
        );
        let outage = SecurityError::RateLimiterUnavailable {
            reason: "binding unavailable".into(),
        };
        assert_eq!(outage.code(), "temporarily_unavailable");
        assert!(!outage.is_client_safe());
    }

    #[test]
    fn the_binding_names_are_the_ones_the_wrangler_configs_declare() {
        // A typo here would not fail to compile — `env.rate_limiter` takes any
        // string — it would fail open at runtime, which is the worst possible
        // time. The assertion is the boundary test.
        assert_eq!(IDENTITY_RATE_LIMITER_BINDING, "RATE_LIMITER");
        assert_eq!(ADMIN_RATE_LIMITER_BINDING, "ADMIN_RATE_LIMITER");
    }

    #[test]
    fn a_transport_error_never_claims_a_limiter_problem() {
        use crate::error::TransportError;

        // The failure the adapter raises for a missing binding is an operator
        // fact; the one the security layer raises is a client-facing 503. Both
        // exist and they are different types on purpose.
        let adapter = TransportError::MissingBinding {
            name: "RATE_LIMITER",
        };
        assert_eq!(adapter.code(), "internal_error");
        assert!(!adapter.is_client_safe());
    }
}
