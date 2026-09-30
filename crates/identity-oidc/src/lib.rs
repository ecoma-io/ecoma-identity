//! `OpenID` Connect and OAuth 2.0 protocol types.
//!
//! This crate knows the **shape** of the messages. It does not verify a
//! signature, mint a token, or touch a session — those are `identity-
//! security`'s, and the boundary between "what does a token look like" and
//! "is this token valid" is the one that matters most in an identity system.
//! Keeping them in separate crates means a protocol change never reaches the
//! verifier and a verifier change never reaches the wire format.
//!
//! Nothing here is implemented against a live provider. Every type is a plain
//! data structure with serde, so a conformance test can assert the shape
//! against the published spec without a network.

#![deny(missing_docs)]

pub mod client;
pub mod discovery;
pub mod jwt;
pub mod request;
pub mod response;
pub mod route;

pub use client::ClientMetadata;
pub use discovery::DiscoveryDocument;
pub use jwt::{IdTokenClaims, JwkSet};
pub use request::{AuthorizationRequest, TokenRequest};
pub use response::{AuthorizationResponse, TokenResponse, UserInfoResponse};

/// The API version this crate implements.
///
/// Versioned, and the version is a constant rather than an inferred type, so
/// a contract fixture can assert "the v1 document has this field" and a future
/// `v2` can differ without pretending to be the same thing
/// (`contracts/oidc/v1/`).
pub const OIDC_VERSION: &str = "1.0";

/// The `at_hash` / `c_hash` / `s_hash` presence rule this crate's discovery
/// document declares.
///
/// `S256` only. Declaring `plain` in an advertisement is a downgrade offer,
/// and advertising both is worse than advertising the weak one.
pub const SUPPORTED_CODE_CHALLENGE_METHOD: &str = "S256";
