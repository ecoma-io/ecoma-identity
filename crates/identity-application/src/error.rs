//! Application-level failures.
//!
//! A command in this layer can fail for a reason the domain does not name: a
//! required collaborator was absent, a queue was unreachable, a repository
//! rejected the write. [`ApplicationError`] is that vocabulary.
//!
//! It is deliberately *not* an HTTP status type and holds no status code. The
//! transport mapping lives in `identity-cloudflare` (`docs/architecture/
//! deployment-model.md`, "Error contract"), because only that crate knows what
//! the surrounding protocol is. An error type that carried its own status
//! would be an error type that every transport would have to agree with.


use identity_domain::error::DomainError;

/// Why a command or query failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApplicationError {
    /// The domain refused the value or the transition. The `DomainError`'s own
    /// code is preserved verbatim, because it is the one a client branches on.
    #[error("domain: {0}")]
    Domain(#[from] DomainError),

    /// A required collaborator was not wired up. In a scaffold this is a
    /// real, expected failure: a trait with no implementation panics or
    /// returns this, and a caller mistaking it for a real outcome is a bug
    /// worth naming rather than swallowing.
    #[error("not implemented: {operation}")]
    NotImplemented {
        /// The command or query that has no implementation yet.
        operation: &'static str,
    },

    /// The command is not permitted for this actor. Distinct from
    /// `Domain` on purpose: a domain error says the *request* was malformed or
    /// illegal, this says *you* may not ask.
    #[error("forbidden: {reason}")]
    Forbidden {
        /// Why the actor is not permitted.
        reason: String,
    },

    /// A referenced entity does not exist. Kept separate from
    /// `DomainError::NotFound` because this one names a *use-case* entity
    /// (an application, an authorization code) rather than a model one.
    #[error("{entity} not found")]
    NotFound {
        /// Which entity was referenced.
        entity: &'static str,
    },

    /// A collaborator failed. The message is for an operator, never for a
    /// client: the transport maps this to a generic 5xx envelope and does not
    /// forward `reason`.
    #[error("dependency failure in {dependency}: {reason}")]
    Dependency {
        /// Which collaborator failed.
        dependency: &'static str,
        /// What it reported.
        reason: String,
    },
}

impl ApplicationError {
    /// A stable machine-readable code for the error envelope.
    ///
    /// The code is the contract; the message is not. This mapping is the only
    /// place a [`DomainError`] code and an application code meet, so a change
    /// to either is visible here rather than scattered across three Workers.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Domain(d) => d.code(),
            Self::NotImplemented { .. } => "not_implemented",
            Self::Forbidden { .. } => "forbidden",
            Self::NotFound { .. } => "not_found",
            // Deliberately a single code: the reason is operator-facing and
            // must not become a client-visible taxonomy of our internals.
            Self::Dependency { .. } => "internal_error",
        }
    }

    /// Whether this error is safe to show a client verbatim.
    ///
    /// The transport must ask. A `true` here with a `Dependency` variant would
    /// leak a database error string to the internet.
    #[must_use]
    pub fn is_client_safe(&self) -> bool {
        !matches!(self, Self::Dependency { .. })
    }

    /// Build a not-implemented error for a scaffolded operation.
    #[must_use]
    pub fn not_implemented(operation: &'static str) -> Self {
        Self::NotImplemented { operation }
    }

    /// Build a forbidden error.
    pub fn forbidden(reason: impl Into<String>) -> Self {
        Self::Forbidden {
            reason: reason.into(),
        }
    }

    /// Build a dependency-failure error.
    pub fn dependency(dependency: &'static str, reason: impl Into<String>) -> Self {
        Self::Dependency {
            dependency,
            reason: reason.into(),
        }
    }
}

/// Convenience alias for an application result.
pub type ApplicationResult<T> = Result<T, ApplicationError>;

/// A small extension so `?` reads the same in every Worker.
pub trait IntoApplication<T> {
    /// Convert a domain result into an application result.
    ///
    /// # Errors
    ///
    /// Propagates the [`DomainError`] unchanged.
    fn into_application(self) -> ApplicationResult<T>;
}

impl<T> IntoApplication<T> for Result<T, DomainError> {
    fn into_application(self) -> ApplicationResult<T> {
        self.map_err(ApplicationError::from)
    }
}

#[cfg(test)]
mod tests {
    use core::fmt;

    use super::*;

    #[test]
    fn a_domain_code_passes_through_unchanged() {
        // The domain's code is the client-facing contract. Wrapping it in a
        // generic `internal_error` would break every client that branches on it.
        let e = ApplicationError::from(DomainError::invalid("email", "bad"));
        assert_eq!(e.code(), "invalid_request");
    }

    #[test]
    fn a_dependency_failure_is_internal_and_never_client_safe() {
        let e = ApplicationError::dependency("d1", "no such table: users");
        assert_eq!(e.code(), "internal_error");
        assert!(!e.is_client_safe());
        assert!(e.to_string().contains("no such table"));
    }

    #[test]
    fn a_not_implemented_error_says_so_plainly() {
        // The bootstrap's most common error. It must be unambiguous, because
        // "no fake security implementation is presented as complete" is a
        // definition-of-done item.
        let e = ApplicationError::not_implemented("verify_email_otp");
        assert_eq!(e.code(), "not_implemented");
        assert!(e.is_client_safe());
        assert!(e.to_string().contains("verify_email_otp"));
    }

    #[test]
    fn client_safe_errors_are_the_ones_we_chose_to_expose() {
        assert!(ApplicationError::forbidden("nope").is_client_safe());
        assert!(ApplicationError::NotFound { entity: "application" }.is_client_safe());
        assert!(ApplicationError::from(DomainError::not_found("user")).is_client_safe());
    }

    #[test]
    fn the_domain_conversion_is_transparent() {
        let converted: ApplicationResult<u8> = Err(DomainError::not_found("user"))
            .into_application();
        assert_eq!(converted.expect_err("must fail").code(), "not_found");
    }

    #[test]
    fn errors_display_without_panicking_on_empty_strings() {
        let e = ApplicationError::Forbidden { reason: String::new() };
        assert!(!format!("{e}").is_empty());
        let _: &dyn fmt::Display = &e;
    }
}
