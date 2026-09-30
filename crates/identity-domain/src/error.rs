//! Domain-level failures.
//!
//! `identity-domain` cannot depend on `identity-application`, so it cannot name
//! the application's error type. It defines its own small vocabulary, and the
//! application layer's richer errors (which carry the *reason* a command
//! failed) wrap these. Keeping the two apart is what lets the domain be reused
//! by the OIDC and security crates without either of them learning about the
//! other's failure modes.

/// Why a domain invariant refused a value.
///
/// This is not an HTTP concern. The Worker layer maps these to transport
/// codes; it does not invent them, and it must not swallow one into a generic
/// 500 — an invalid subject or a malformed e-mail is a client-visible outcome
/// with a stable code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    /// A value was structurally invalid — a malformed e-mail address, an empty
    /// redirect URI, an identifier that is not a UUID.
    #[error("invalid {field}: {reason}")]
    Invalid {
        /// The name of the field that failed validation.
        field: &'static str,
        /// Why it failed, in terms a caller can act on.
        reason: String,
    },

    /// A transition is not legal from the current state. The *shape* is
    /// well-formed; the *move* is not. Distinguishing this from
    /// [`DomainError::Invalid`] matters because it is a 409-class outcome, not
    /// a 400-class one.
    #[error("illegal transition: {reason}")]
    IllegalTransition {
        /// Why the move is refused.
        reason: String,
    },

    /// A referenced entity does not exist.
    #[error("{entity} not found")]
    NotFound {
        /// Which kind of entity was referenced.
        entity: &'static str,
    },
}

impl DomainError {
    /// Build an [`DomainError::Invalid`] for a named field.
    pub fn invalid(field: &'static str, reason: impl Into<String>) -> Self {
        Self::Invalid {
            field,
            reason: reason.into(),
        }
    }

    /// Build a [`DomainError::IllegalTransition`] with a reason.
    pub fn illegal(reason: impl Into<String>) -> Self {
        Self::IllegalTransition {
            reason: reason.into(),
        }
    }

    /// Build a [`DomainError::NotFound`] for an entity kind.
    #[must_use]
    pub fn not_found(entity: &'static str) -> Self {
        Self::NotFound { entity }
    }

    /// A stable machine-readable code, carried into the error envelope
    /// (`docs/architecture/deployment-model.md`, "Error contract").
    ///
    /// The code is part of the public contract: it is what a client branches
    /// on, so it must not change when the human-readable message does.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { .. } => "invalid_request",
            Self::IllegalTransition { .. } => "illegal_transition",
            Self::NotFound { .. } => "not_found",
        }
    }
}

/// Convenience alias for a domain result.
pub type DomainResult<T> = Result<T, DomainError>;

/// A minimal structural check used by the newtypes in this crate.
///
/// It is `pub` rather than crate-private because the same check is needed by
/// the crates that *build* domain values from untrusted input — a client
/// `client_id` in `identity-oidc`, a signing `kid` in `identity-security`. A
/// second, looser copy of this rule in one of those crates would be a second
/// answer to "what makes an identifier well-formed", and the two would drift.
/// The dependency law keeps it safe: only crates that already depend on
/// `identity-domain` can call it, which is the same set of crates that can
/// already construct a `UserId` around any `Uuid` they like.
///
/// # Errors
///
/// Returns [`DomainError::Invalid`] when `value` is empty or has leading or
/// trailing whitespace. This is deliberately the *weakest* useful check: it
/// rejects nothing that is well-formed and catches nothing that is subtle. A
/// stricter rule is the caller's, because "strict enough" is a decision about
/// the field, not about the model as a whole.
pub fn require_non_blank(
    field: &'static str,
    value: &str,
) -> DomainResult<()> {
    if value.trim().is_empty() {
        return Err(DomainError::invalid(field, "must not be blank"));
    }
    if value != value.trim() {
        return Err(DomainError::invalid(
            field,
            "must not have leading or trailing whitespace",
        ));
    }
    Ok(())
}

/// A structural check for an optional, human-chosen identifier (a client
/// `client_id`, a redirect URI path, a display name).
///
/// [`require_non_blank`] is deliberately *not* called here: a display name may
/// legitimately be empty, and a caller that wants both rules writes both.
///
/// # Errors
///
/// Returns [`DomainError::Invalid`] when `value` exceeds `max_len` bytes.
pub fn require_max_len(
    field: &'static str,
    value: &str,
    max_len: usize,
) -> DomainResult<()> {
    if value.len() > max_len {
        return Err(DomainError::invalid(
            field,
            format!("must be at most {max_len} bytes"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_strings() {
        // The envelope's `code` field is a contract, not a Debug print. If any
        // of these change, a client branching on them breaks silently.
        assert_eq!(
            DomainError::invalid("email", "bad").code(),
            "invalid_request"
        );
        assert_eq!(DomainError::illegal("nope").code(), "illegal_transition");
        assert_eq!(DomainError::not_found("user").code(), "not_found");
    }

    #[test]
    fn blank_and_padded_strings_are_both_refused() {
        assert!(require_non_blank("name", "ok").is_ok());
        assert!(require_non_blank("name", "").is_err());
        assert!(require_non_blank("name", "   ").is_err());
        assert!(require_non_blank("name", " ok ").is_err());
    }

    #[test]
    fn max_len_counts_bytes_not_characters() {
        // Bytes, not chars: a storage bound is a byte bound. A 4-byte emoji is
        // four bytes of column, and a limit written in characters would let it
        // through where the column would truncate.
        assert!(require_max_len("name", "ok", 2).is_ok());
        assert!(require_max_len("name", "ok", 1).is_err());
        assert!(require_max_len("name", "🦀", 3).is_err());
    }

    #[test]
    fn errors_display_without_panicking_on_empty_reason() {
        let e = DomainError::invalid("", "");
        // The Display impl is user-visible in logs; it must not assume the
        // field name carries content.
        assert!(!format!("{e}").is_empty());
    }
}
