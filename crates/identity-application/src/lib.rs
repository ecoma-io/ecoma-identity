//! Use cases over the identity model.
//!
//! This layer is where the *decisions* live: whether a command is legal, what
//! it changes, and what it must refuse. It sits above
//! [`identity_domain`](../../identity_domain/index.html) and below everything
//! that talks to a platform.
//!
//! # The law this crate exists to keep
//!
//! It depends on `identity-domain` and on **no other internal crate**. Not on
//! `identity-cloudflare` (a use case that reached for D1 would be untestable
//! without a database, and every use case here is tested without one), not on
//! `identity-oidc` (protocol shape is not a use case), and not on
//! `identity-security` (a use case asks *whether* a TOTP may be enabled; it
//! does not verify the code). Those crates plug in beneath the traits declared
//! here.
//!
//! # What is and is not here
//!
//! Every command and query below is a **trait with typed input and output**.
//! None has a body. That is the honest state of a bootstrap: the interfaces
//! are the contract that the implementation, the storage adapters and the
//! Workers will all be written against, and writing them first means the
//! boundaries are reviewable before any of them can be quietly widened. A
//! trait here that returns `Result<_, anyhow::Error>` would be a worse
//! scaffold than none, so the errors are typed too.
//!
//! The one thing that *is* implemented here is [`administration::RoleChange`]
//! and its "last administrator" rule — see that module for why that one
//! exception exists.

#![deny(missing_docs)]

pub mod accounts;
pub mod admin_routes;
pub mod administration;
pub mod applications;
pub mod audit;
pub mod authentication;
pub mod error;
pub mod sessions;

pub use error::{ApplicationError, ApplicationResult};
