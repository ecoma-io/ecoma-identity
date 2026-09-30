//! The identity model.
//!
//! This crate is the bottom of the internal dependency graph. It depends on no
//! other workspace crate, and on nothing from the Cloudflare Workers platform:
//! no D1, no Queues, no HTTP framework, no `worker` crate. That is the whole
//! point of the crate — the rules that decide *what is a valid user, session or
//! application* must be expressible, testable and reviewable without a
//! platform, and must remain true no matter which runtime evaluates them.
//!
//! What is **not** here, deliberately, is behaviour. Every constructor in this
//! crate is a shape: a type with named fields and a newtype for its
//! identifier. The commands that *decide* whether a transition is legal live in
//! `identity-application`; the SQL that persists a shape lives in
//! `identity-cloudflare`. This crate answers "what is a User?", never "may this
//! user log in?".
//!
//! The invariant tests in this module are **skeletons**: they are written, they
//! name the rule, and they are `#[ignore]`d because the rule is not enforced
//! yet. See [`invariants`] for why that is the honest encoding of bootstrap
//! state rather than a stubbed-out passing test.

#![deny(missing_docs)]

pub mod application;
pub mod audit;
pub mod authenticator;
pub mod email;
pub mod error;
pub mod identity;
pub mod invariants;
pub mod outbox;
pub mod security;
pub mod session;
pub mod user;

pub use application::{
    Application, ApplicationAccessMode, ApplicationId, ApplicationStatus,
};
pub use audit::AuditEvent;
pub use authenticator::{Authenticator, AuthenticatorKind};
pub use email::EmailAddress;
pub use error::DomainError;
pub use identity::{Identity, IdentityProvider};
pub use outbox::OutboxEvent;
pub use security::{Aal, SecurityVersion};
pub use session::{Session, SessionId};
pub use user::{PlatformRole, User, UserId, UserStatus};
