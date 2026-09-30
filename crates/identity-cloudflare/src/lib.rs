//! The Cloudflare Workers adapters.
//!
//! # The one rule
//!
//! **This crate adapts. It does not decide.**
//!
//! Everything below is a translation between a Cloudflare type and a type the
//! platform-agnostic layers already own. Where a decision is required — what
//! HTTP status an error becomes, how large a body may be, whether a redirect
//! base is allow-listed — the decision is written here as an explicit,
//! documented rule rather than inherited from a framework, and it is the same
//! rule for all three Workers, because all three import it from here.
//!
//! What is **not** here, deliberately: any authentication logic. Nothing in
//! this crate decides whether a credential is valid, whether a session is
//! live, or who a request is made by. Those questions belong to
//! `identity-security` (as traits) and `identity-application` (as decisions).
//! This crate supplies the WebCrypto-backed implementations of the former and
//! the plumbing for the latter, and stops.
//!
//! # Where the boundary is drawn
//!
//! | Module | Adapts | Does not |
//! |---|---|---|
//! | [`error`] | `ApplicationError` / `SecurityError` → a wire envelope | decide which error a command produces |
//! | [`request`] | `worker::Request` → a typed, bounded request | parse OAuth parameters |
//! | [`response`] | domain values → `worker::Response` | choose a redirect target |
//! | [`clock`] | `worker::Date` → the [`clock::Clock`] port | decide what time means |
//! | [`ids`] | UUID text → domain newtypes | mint an identifier out of thin air |
//! | [`d1`] | D1 statements → repository plumbing | be reachable from any Worker but `identity` |
//! | [`queue`] | outbox events → Queues messages | be atomic with a D1 commit |
//! | [`rate_limit`] | Workers rate limiting → the fail-closed gate | be a security control on its own |
//! | [`crypto`] | `WebCrypto` → the `identity-security` gates | implement any primitive |
//! | [`secrets`] | secret bindings → typed handles | default a missing secret |
//! | [`kv`] | KV → scratch counters and idempotency guards | hold authoritative identity state |
//!
//! # What is not implemented
//!
//! The signature-counter (`OtpService`) and TOTP algorithms are **deferred**;
//! see [`crypto`]. Nothing in this crate returns a plausible-looking success in
//! place of an implementation it does not have: every gap is an
//! [`error::TransportError::Unimplemented`] with a named phase, because a
//! green path that proves nothing is worse than a documented hole.

#![deny(missing_docs)]

pub mod clock;
pub mod crypto;
pub mod d1;
pub mod error;
pub mod ids;
pub mod kv;
pub mod queue;
pub mod rate_limit;
pub mod request;
pub mod response;
pub mod secrets;

pub use clock::{Clock, SystemClock};
pub use error::{CloudflareError, ErrorEnvelope, HttpStatus, TransportError};
pub use request::{BoundedBody, IncomingRequest, MAX_JSON_BODY_BYTES, SESSION_COOKIE_NAME};
pub use response::{AllowedRedirectBase, ResponseBuilder as WorkerResponseBuilder};

/// The three deployables this crate serves, by their composition-root crate
/// names.
///
/// Named here so the boundary is legible from the adapter rather than only
/// from the architecture documents: only `identity` — the Identity Worker —
/// may hold a D1 handle at all. See [`d1`] for the full statement and for why
/// there is no runtime check.
pub const DEPLOYABLES: [&str; 3] = ["identity", "identity-admin", "identity-jobs"];

/// The one deployable allowed to hold Identity D1.
pub const IDENTITY_D1_OWNER: &str = "identity";
