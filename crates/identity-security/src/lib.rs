//! The security layer's contracts.
//!
//! Every cryptography, secret-handling and factor-verification decision in
//! Ecoma Identity is expressed here as a **trait with a typed interface**.
//! Not one of them has a body, and that is the point of the phase: what is
//! being locked down is the *set of questions* the system must be able to ask,
//! so that the implementations — which will be `WebCrypto`, a maintained TOTP
//! library, a maintained `WebAuthn` verifier — are pluggable and reviewable
//! separately from the decisions that use them.
//!
//! # The law
//!
//! **No cryptography is implemented in this repository.** Not a hash, not a
//! MAC, not a nonce, not a constant-time comparison, not a key derivation, not
//! a TOTP step. Everything below is delegated to a maintained library behind
//! an interface, and the interface is what this crate owns.
//!
//! The reason is not squeamishness. Hand-rolled crypto fails in ways that
//! pass review — a non-constant-time comparison on a session token, a nonce
//! with 16 bits of entropy, a TOTP compared with `==` instead of
//! `subtle::ConstantTimeEq` — and the failure is silent and remote. The only
//! defence that has ever worked is not having the code.
//!
//! # The gates
//!
//! | Trait | Question it answers |
//! |---|---|
//! | [`OtpService`] | Is this code the one we sent to this destination, now? |
//! | [`TotpService`] | Is this code a valid TOTP for this enrolled secret? |
//! | [`PasskeyService`] | Is this a valid `WebAuthn` assertion for this challenge? |
//! | [`SessionService`] | Which session does this credential belong to, and is it live? |
//! | [`TokenSigner`] | Produce a signature over these claims. |
//! | [`TokenVerifier`] | Is this token valid, for this audience, right now? |
//! | [`PkceService`] | Does this verifier match that challenge? |
//! | [`NonceService`] | Was this nonce issued by us, and has it been used? |
//! | [`CsrfService`] | Does this state belong to this browser session? |
//! | [`SecretCipher`] | Encrypt and decrypt this secret at rest. |
//!
//! Every method is fallible and every error is typed. An interface that could
//! only succeed is an interface that has not thought about what happens when
//! the key is wrong.

#![deny(missing_docs)]

pub mod error;
pub mod factors;
pub mod tokens;

pub use error::{SecurityError, SecurityResult};
pub use factors::{OtpService, PasskeyService, RecoveryCodeService, TotpService};
pub use tokens::{
    CsrfService, NonceService, PkceService, SecretCipher, SessionService, SignedToken,
    SigningKeyId, TokenSigner, TokenVerifier,
};
