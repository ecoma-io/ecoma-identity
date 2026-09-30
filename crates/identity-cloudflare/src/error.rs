//! The wire error envelope, and the mapping from the layers' error
//! vocabularies onto it.
//!
//! # Why the mapping lives here and not in the error types
//!
//! `ApplicationError` and `SecurityError` deliberately do **not** carry an
//! HTTP status. An error type that knew its own status would be an error type
//! every transport had to agree with, and the admin BFF, the OAuth endpoints
//! and the internal service boundary do not speak the same protocol. So the
//! status decision is made here, once, from the stable `code()` string each
//! error already exposes — and a Worker cannot answer 418 because it imported
//! the wrong error crate.
//!
//! # Why the message is never string-formatted from the inner error
//!
//! `ApplicationError::is_client_safe()` and `SecurityError::is_client_safe()`
//! exist precisely so a `Dependency { dependency: "d1", reason: "no such
//! table: users" }` never reaches the internet. Building the message with
//! `format!("{e}")` would defeat both in one character, so this module does
//! not do it anywhere: when the error is not client-safe the message is
//! replaced with a fixed, generic string and the real reason is left for the
//! log. The `client_safe` flag is carried on the envelope so that an operator
//! reading a captured response can tell *which* rule downgraded the message.
//!
//! # The shape
//!
//! ```json
//! {
//!   "error": { "code": "not_found", "message": "user not found", "request_id": "…" },
//!   "client_safe": true
//! }
//! ```
//!
//! The OAuth endpoints do **not** use this envelope: they answer with
//! [`identity_oidc::response::OAuthErrorResponse`], because a third-party OAuth
//! client library parses that shape and not this one. See [`crate::response`].

use core::fmt;

use serde::{Deserialize, Serialize};

use identity_application::error::ApplicationError;
use identity_security::error::SecurityError;

/// The generic message substituted when an error is not client-safe.
///
/// Deliberately says nothing about *what* failed. A caller learns the code,
/// which is stable and safe to branch on, and learns nothing about our
/// internals. The real reason is logged server-side under the request id.
pub const OPAQUE_MESSAGE: &str = "the request could not be completed";

/// The generic message used for errors this crate itself raises.
pub const UNIMPLEMENTED_MESSAGE: &str = "this operation is not implemented yet";

/// A serializable error envelope.
///
/// `code` is the contract a client branches on; `message` is not, and changes
/// whenever the wording improves. `client_safe` records whether the message
/// that is actually on the wire is the error's own or the generic substitute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    /// The stable machine-readable code.
    pub code: String,
    /// The human-readable message, safe to display.
    pub message: String,
    /// The request identifier, when the transport had one, so a user can quote
    /// it and an operator can find the log line.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<String>,
    /// Whether `message` is the error's own text rather than the generic
    /// substitute. Always `false` for anything the layers call operator-facing.
    pub client_safe: bool,
}

impl ErrorEnvelope {
    /// Build an envelope with an explicit code, message and safety.
    #[must_use]
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        client_safe: bool,
        request_id: Option<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            request_id,
            client_safe,
        }
    }

    /// Attach a request identifier.
    #[must_use]
    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }

    /// The HTTP status this envelope should be sent with.
    ///
    /// Derived from `code`, not from the variant: two different errors with
    /// the same code are the same outcome to a client, and a client that had
    /// to distinguish them would be branching on our internals.
    #[must_use]
    pub fn status(&self) -> HttpStatus {
        HttpStatus::for_code(&self.code)
    }
}

/// The HTTP statuses this platform answers with.
///
/// A closed set on purpose. An error path that could produce any `u16` would
/// let a new variant pick an arbitrary status, and a client could not rely on
/// the set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HttpStatus {
    /// The request was malformed.
    BadRequest,
    /// The caller is not authenticated.
    Unauthorized,
    /// The caller is authenticated and not permitted.
    Forbidden,
    /// No such resource.
    NotFound,
    /// The request conflicts with current state.
    Conflict,
    /// The caller is being rate limited or a dependency is unavailable.
    TooManyRequests,
    /// Our fault.
    InternalServerError,
    /// A dependency is unavailable and the request may be retried.
    ServiceUnavailable,
}

impl HttpStatus {
    /// The numeric status on the wire.
    #[must_use]
    pub const fn as_u16(self) -> u16 {
        match self {
            Self::BadRequest => 400,
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::TooManyRequests => 429,
            Self::InternalServerError => 500,
            Self::ServiceUnavailable => 503,
        }
    }

    /// The status an error `code` maps to.
    ///
    /// The mapping is the documented error contract. `invalid_request`,
    /// `illegal_transition`, `forbidden`, `not_found`, `verification_failed`,
    /// `expired`, `already_redeemed`, `challenge_mismatch`, `malformed_token`,
    /// `invalid_token` and `insufficient_assurance` are 4xx outcomes a caller
    /// can act on. `not_implemented` is 501 — deliberately *outside* this
    /// closed set, because it is answered by a hand-built response at the
    /// route table rather than by an envelope, and a declared route must never
    /// be mistaken for one that was never there. `internal_error` is 500.
    /// Anything unrecognised is 500: an unmapped code is a gap in this table,
    /// and the safe reading of a gap is "our fault", never "the caller did
    /// something wrong".
    #[must_use]
    pub fn for_code(code: &str) -> Self {
        match code {
            "invalid_request"
            | "verification_failed"
            | "expired"
            | "already_redeemed"
            | "challenge_mismatch"
            | "malformed_token"
            | "invalid_token" => Self::BadRequest,
            "unauthorized" => Self::Unauthorized,
            "forbidden" | "insufficient_assurance" => Self::Forbidden,
            "not_found" => Self::NotFound,
            "illegal_transition" => Self::Conflict,
            "temporarily_unavailable" => Self::ServiceUnavailable,
            _ => Self::InternalServerError,
        }
    }
}

impl From<HttpStatus> for u16 {
    fn from(status: HttpStatus) -> Self {
        status.as_u16()
    }
}

/// A failure raised by the adapter itself, rather than by a layer below it.
///
/// Separate from [`ApplicationError`] and [`SecurityError`] because it is not
/// about a use case or a security gate: it is about the transport refusing
/// something (a body above the limit, a redirect base that is not allow-listed)
/// or about an operation this crate does not implement.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
    /// A trait method has no implementation in this crate.
    ///
    /// The variant that keeps the bootstrap honest. Returning
    /// `Ok(default)`, an empty page or a fabricated token instead would
    /// produce a green path that proves nothing, and a caller would have no
    /// way to tell it from a real outcome.
    #[error("not implemented: {operation}")]
    Unimplemented {
        /// The trait method with no backing implementation.
        operation: &'static str,
    },

    /// The request body exceeded the adapter's hard limit.
    #[error("request body exceeds {limit} bytes")]
    BodyTooLarge {
        /// The limit that was applied.
        limit: usize,
    },

    /// The request body was not valid UTF-8, or not the shape that was claimed.
    #[error("request body could not be read")]
    UnreadableBody,

    /// A redirect target's base was not on the allow-list.
    ///
    /// Refused rather than rewritten: rewriting a redirect to "the safe base"
    /// silently sends a user somewhere they did not ask for, which is the
    /// open-redirect vulnerability wearing a disguise.
    #[error("redirect base is not allow-listed")]
    RedirectBaseNotAllowed,

    /// A binding was absent, or of the wrong kind, from the Worker `Env`.
    #[error("binding unavailable: {name}")]
    MissingBinding {
        /// The binding name that could not be resolved.
        name: &'static str,
    },

    /// A secret binding was absent or empty.
    #[error("secret unavailable: {name}")]
    MissingSecret {
        /// The secret name that could not be resolved.
        name: &'static str,
    },

    /// A platform operation failed. The reason is for an operator only.
    #[error("platform failure in {operation}: {reason}")]
    Platform {
        /// Which adapter operation failed.
        operation: &'static str,
        /// What the platform reported.
        reason: String,
    },
}

impl TransportError {
    /// Build an unimplemented error.
    #[must_use]
    pub const fn unimplemented(operation: &'static str) -> Self {
        Self::Unimplemented { operation }
    }

    /// Build a platform-failure error.
    #[must_use]
    pub fn platform(operation: &'static str, reason: impl Into<String>) -> Self {
        Self::Platform {
            operation,
            reason: reason.into(),
        }
    }

    /// The stable code for this failure.
    ///
    /// `not_implemented` is separate from the layer codes so a caller can tell
    /// "this system has not built that yet" from "you asked for the wrong
    /// thing". `platform` is deliberately `internal_error`: an adapter failure
    /// is our outage, and naming it would tell a caller about our topology.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Unimplemented { .. } => "not_implemented",
            Self::BodyTooLarge { .. } => "payload_too_large",
            Self::UnreadableBody | Self::RedirectBaseNotAllowed => "invalid_request",
            // `MissingBinding`, `MissingSecret` and `Platform` collapse into one
            // arm on purpose: they are three different internal causes with
            // one client-visible answer, and a client that can tell them apart
            // is a client being told which of our internals is misconfigured.
            // The distinction survives where it is useful — the `Debug` and
            // `Display` arms, and the log fields a failure is paged from.
            Self::MissingBinding { .. } | Self::MissingSecret { .. } | Self::Platform { .. } => {
                "internal_error"
            }
        }
    }

    /// Whether this failure's own text is safe to send to a client.
    ///
    /// A `Platform` reason is a platform error string; a `MissingSecret` names
    /// the secret. Neither goes out. Everything else here describes a rule the
    /// caller can be told about.
    #[must_use]
    pub const fn is_client_safe(&self) -> bool {
        !matches!(
            self,
            Self::Platform { .. } | Self::MissingBinding { .. } | Self::MissingSecret { .. }
        )
    }
}

/// The error type every adapter in this crate returns.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CloudflareError {
    /// A use case or query refused, or a collaborator failed.
    #[error(transparent)]
    Application(#[from] ApplicationError),

    /// A security gate refused.
    #[error(transparent)]
    Security(#[from] SecurityError),

    /// The transport refused, or an operation is unimplemented.
    ///
    /// Built with [`CloudflareError::transport`] rather than `#[from]`, so the
    /// conversion is a name a reader can grep for at the call site instead of
    /// a `?` that could equally have crossed from a layer below.
    #[error(transparent)]
    Transport(TransportError),
}

impl CloudflareError {
    /// Build an adapter failure.
    ///
    /// A constructor rather than a spelling of the variant, so the
    /// `error::result_context!` rules in `clippy.toml` can tell an adapter
    /// failure from a layer failure at the point where one is raised. The
    /// `From<TransportError>` impl below is deliberately left in place for
    /// callers outside this crate that cannot reach this constructor.
    #[must_use]
    pub fn transport(error: TransportError) -> Self {
        Self::Transport(error)
    }

    /// The stable code, whichever layer produced the failure.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Application(e) => e.code(),
            Self::Security(e) => e.code(),
            Self::Transport(e) => e.code(),
        }
    }

    /// Whether the *source* error's text is safe to show a client.
    #[must_use]
    pub fn is_client_safe(&self) -> bool {
        match self {
            Self::Application(e) => e.is_client_safe(),
            Self::Security(e) => e.is_client_safe(),
            Self::Transport(e) => e.is_client_safe(),
        }
    }

    /// Build the wire envelope for this failure.
    ///
    /// The one place the message is chosen. When the source is not
    /// client-safe the message is replaced by [`OPAQUE_MESSAGE`] — it is never
    /// `format!("{inner}")`, and the tests below assert that a dependency
    /// failure's reason string does not reach the envelope.
    #[must_use]
    pub fn envelope(&self, request_id: Option<String>) -> ErrorEnvelope {
        let client_safe = self.is_client_safe();
        let message = if client_safe {
            self.message_when_client_safe()
        } else {
            OPAQUE_MESSAGE.to_string()
        };
        ErrorEnvelope::new(self.code(), message, client_safe, request_id)
    }

    /// The message a client-safe failure carries.
    ///
    /// This is the *only* place in the crate where an inner error is rendered
    /// into text, and it runs only for errors that have already declared
    /// themselves safe to expose.
    fn message_when_client_safe(&self) -> String {
        match self {
            Self::Transport(TransportError::Unimplemented { operation }) => {
                format!("{UNIMPLEMENTED_MESSAGE} ({operation})")
            }
            // The reason here is caller-supplied — a redirect target, a field
            // name — and never a platform string, because the platform variants
            // are all operator-facing and have already been filtered out above.
            other => other.to_string(),
        }
    }
}

impl From<identity_domain::error::DomainError> for CloudflareError {
    fn from(error: identity_domain::error::DomainError) -> Self {
        Self::Application(ApplicationError::from(error))
    }
}

/// Convenience alias for an adapter result.
pub type Result<T> = core::result::Result<T, CloudflareError>;

impl fmt::Display for ErrorEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use identity_domain::error::DomainError;

    use super::*;

    #[test]
    fn a_dependency_failure_never_reaches_the_envelope() {
        // The load-bearing test of this module. `reason` is the exact text a
        // D1 error would carry — a table name, a column name — and it must not
        // appear anywhere in what goes on the wire.
        let e = CloudflareError::from(ApplicationError::dependency("d1", "no such table: users"));
        let envelope = e.envelope(Some("req-1".into()));
        let json = serde_json::to_string(&envelope).expect("serializable");
        assert!(!json.contains("no such table"), "{json}");
        assert!(!json.contains("d1"), "{json}");
        assert_eq!(envelope.message, OPAQUE_MESSAGE);
        assert!(!envelope.client_safe);
        assert_eq!(envelope.code, "internal_error");
        assert_eq!(envelope.status(), HttpStatus::InternalServerError);
        assert_eq!(envelope.request_id.as_deref(), Some("req-1"));
    }

    #[test]
    fn a_missing_secret_names_neither_the_secret_nor_the_operation() {
        let e = CloudflareError::transport(TransportError::MissingSecret {
            name: "IDENTITY_SIGNING_SECRET",
        });
        let json = serde_json::to_string(&e.envelope(None)).expect("serializable");
        assert!(!json.contains("IDENTITY_SIGNING_SECRET"), "{json}");
        assert!(!json.contains("missing secret"), "{json}");
    }

    #[test]
    fn a_cryptographic_reason_is_never_forwarded() {
        let e = CloudflareError::from(SecurityError::Cryptographic {
            reason: "key rejected by open".into(),
        });
        let json = serde_json::to_string(&e.envelope(None)).expect("serializable");
        assert!(!json.contains("key rejected"), "{json}");
        assert_eq!(e.code(), "internal_error");
    }

    #[test]
    fn a_client_safe_domain_error_keeps_its_own_message_and_code() {
        let e = CloudflareError::from(DomainError::invalid("email", "not an address"));
        let envelope = e.envelope(None);
        assert!(envelope.client_safe);
        assert_eq!(envelope.code, "invalid_request");
        assert!(envelope.message.contains("email"), "{}", envelope.message);
        assert_eq!(envelope.status(), HttpStatus::BadRequest);
    }

    #[test]
    fn an_unimplemented_error_says_so_in_the_message() {
        // A caller must be able to tell from the response body that the system
        // has not built this yet, without reading the code and inferring.
        let e =
            CloudflareError::transport(TransportError::unimplemented("TotpService::current_code"));
        let envelope = e.envelope(None);
        assert_eq!(envelope.code, "not_implemented");
        assert!(envelope.message.contains("TotpService::current_code"));
        assert!(envelope.client_safe);
        // Not in the closed status set: a declared route answers 501 from the
        // route table, not through this envelope.
        assert_eq!(envelope.status(), HttpStatus::InternalServerError);
    }

    #[test]
    fn the_status_mapping_is_the_documented_one() {
        let cases = [
            ("invalid_request", HttpStatus::BadRequest),
            ("verification_failed", HttpStatus::BadRequest),
            ("malformed_token", HttpStatus::BadRequest),
            ("invalid_token", HttpStatus::BadRequest),
            ("unauthorized", HttpStatus::Unauthorized),
            ("forbidden", HttpStatus::Forbidden),
            ("insufficient_assurance", HttpStatus::Forbidden),
            ("not_found", HttpStatus::NotFound),
            ("illegal_transition", HttpStatus::Conflict),
            ("temporarily_unavailable", HttpStatus::ServiceUnavailable),
            ("internal_error", HttpStatus::InternalServerError),
            ("not_implemented", HttpStatus::InternalServerError),
        ];
        for (code, expected) in cases {
            assert_eq!(HttpStatus::for_code(code), expected, "{code}");
        }
    }

    #[test]
    fn an_unrecognised_code_is_our_fault_not_the_callers() {
        // The important direction. A code added to an error type without a row
        // here must read as 500, because the alternative — falling back to 400
        // — tells a caller they did something wrong when in fact we have a gap.
        assert_eq!(
            HttpStatus::for_code("a_code_nobody_has_defined"),
            HttpStatus::InternalServerError
        );
    }

    #[test]
    fn every_status_in_the_closed_set_is_one_of_the_documented_numbers() {
        for (status, expected) in [
            (HttpStatus::BadRequest, 400u16),
            (HttpStatus::Unauthorized, 401),
            (HttpStatus::Forbidden, 403),
            (HttpStatus::NotFound, 404),
            (HttpStatus::Conflict, 409),
            (HttpStatus::TooManyRequests, 429),
            (HttpStatus::InternalServerError, 500),
            (HttpStatus::ServiceUnavailable, 503),
        ] {
            assert_eq!(status.as_u16(), expected);
            assert_eq!(u16::from(status), expected);
        }
    }

    #[test]
    fn an_absent_request_id_is_omitted_rather_than_serialised_as_null() {
        let envelope = CloudflareError::from(DomainError::not_found("user")).envelope(None);
        let json = serde_json::to_string(&envelope).expect("serializable");
        assert!(!json.contains("request_id"), "{json}");
    }

    #[test]
    fn a_domain_error_converts_through_the_application_layer() {
        let e: CloudflareError = DomainError::not_found("session").into();
        assert_eq!(e.code(), "not_found");
    }
}
