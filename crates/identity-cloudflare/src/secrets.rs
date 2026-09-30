//! Typed access to the secret bindings.
//!
//! # Refusing rather than defaulting
//!
//! Every accessor here fails when its secret is absent or empty. There is no
//! development default, no placeholder, and no "if it is short, pad it" —
//! because a default signing key is a key that is in this repository, in every
//! clone of it, and in the source of every deployment built from it. ADR-0009
//! is the same rule from the other direction: there is no authentication bypass
//! for development, and a defaulted signing key *is* one.
//!
//! # What is not here
//!
//! Not a secret store, and not a rotation mechanism. A rotation needs more than
//! this crate's cooperation — it needs a versioned key identifier published in
//! the JWKS and a database column recording which key encrypted a row, and
//! neither exists in the bootstrap. What exists here is the narrow thing: a
//! name, a length floor, and a refusal.
//!
//! # Why the lengths are floors and not equalities
//!
//! HMAC-SHA-256 wants at least 32 bytes of key. AES-GCM-256 wants exactly 32.
//! This module enforces the *floor* for both and lets the cipher be the one to
//! object to a wrong length, so a future 64-byte signing secret does not need
//! this file edited.

use worker::Env;

use crate::error::{CloudflareError, Result, TransportError};

/// The minimum length, in bytes, of an HMAC-SHA-256 key.
pub const MIN_SIGNING_SECRET_BYTES: usize = 32;

/// The exact length, in bytes, of an AES-256-GCM key.
pub const ENCRYPTION_KEY_BYTES: usize = 32;

/// A secret that has been read, bounds-checked, and is ready to use.
///
/// The value is behind a method named for its only legitimate caller rather
/// than a public field, so a reviewer grepping for secret handling has
/// something to find, and a `Debug` of a wrapping struct cannot print it.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Adopt a secret's bytes.
    ///
    /// # Errors
    ///
    /// [`TransportError::MissingSecret`] when the value is empty or shorter
    /// than `min_len`. Empty is refused separately from short because an
    /// empty `IDENTITY_SIGNING_SECRET=` in a `.dev.vars` is the single most
    /// likely misconfiguration there is, and it must not read as "configured".
    pub fn new(name: &'static str, value: Vec<u8>, min_len: usize) -> Result<Self> {
        if value.is_empty() {
            return Err(CloudflareError::transport(TransportError::MissingSecret {
                name,
            }));
        }
        if value.len() < min_len {
            return Err(CloudflareError::transport(TransportError::MissingSecret {
                name,
            }));
        }
        Ok(Self(value))
    }

    /// Borrow the bytes, for the one implementation that needs them.
    ///
    /// Named for the narrowest caller in the same way
    /// `identity_security::TotpSecret::expose_for_verification` is: this is
    /// not "the getter", it is "I am the crypto adapter and I am about to hand
    /// this to `WebCrypto`".
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn expose_for_crypto(&self) -> &[u8] {
        &self.0
    }

    /// The length in bytes. Safe to log; the value is not.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the secret is empty. Always false for a secret that exists.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Redacted by hand. See the type documentation.
impl core::fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "SecretBytes({} bytes, <redacted>)", self.0.len())
    }
}

/// Read the HMAC signing secret, refusing a missing or short value.
///
/// # Errors
///
/// [`CloudflareError`] wrapping [`TransportError::MissingSecret`] when the
/// secret is absent from the environment, and a short-secret refusal from
/// [`SecretBytes::new`] when it is present but shorter than
/// [`MIN_SIGNING_SECRET_BYTES`]. There is no default and no fallback: a
/// signing secret this function will invent is a signing secret an attacker can
/// read in the source.
pub fn signing_secret(env: &Env) -> Result<SecretBytes> {
    read_secret(env, "IDENTITY_SIGNING_SECRET", MIN_SIGNING_SECRET_BYTES)
}

/// Read the AES-GCM encryption key, refusing a missing or short value.
///
/// # Errors
///
/// [`CloudflareError`] wrapping [`TransportError::MissingSecret`] when the
/// key is absent, and a short-key refusal from [`SecretBytes::new`] when it is
/// present but not exactly [`ENCRYPTION_KEY_BYTES`] long. AES-GCM takes a
/// fixed-width key,
/// so a shorter one is not a weaker key — it is not a key at all, and truncating
/// it silently is how an implementation ends up encrypting under a key nobody
/// wrote down.
pub fn encryption_key(env: &Env) -> Result<SecretBytes> {
    read_secret(env, "IDENTITY_ENCRYPTION_KEY", ENCRYPTION_KEY_BYTES)
}

/// Read the issuer this deployment is reached at.
///
/// A var, not a secret: it is public by definition — it appears in the
/// discovery document — so it is held in plain `wrangler` `vars`. What is *not*
/// waived is the refusal: a Worker with no issuer cannot mint an `iss` claim,
/// and a defaulted one would mint tokens that verify against the wrong origin.
///
/// # Errors
///
/// [`CloudflareError`] wrapping [`TransportError::MissingBinding`] when
/// `IDENTITY_ISSUER` is unset. A Worker that cannot say which origin it is
/// cannot issue a token any client will accept, so this refuses rather than
/// guesses.
pub fn issuer(env: &Env) -> Result<String> {
    let value = env
        .var("IDENTITY_ISSUER")
        .map_err(|_| {
            CloudflareError::transport(TransportError::MissingBinding {
                name: "IDENTITY_ISSUER",
            })
        })?
        .to_string();
    if value.trim().is_empty() {
        return Err(CloudflareError::transport(TransportError::MissingBinding {
            name: "IDENTITY_ISSUER",
        }));
    }
    Ok(value)
}

/// Read a named secret and bounds-check it.
fn read_secret(env: &Env, name: &'static str, min_len: usize) -> Result<SecretBytes> {
    let raw = env
        .secret(name)
        .map_err(|_| CloudflareError::transport(TransportError::MissingSecret { name }))?
        .to_string();
    SecretBytes::new(name, raw.into_bytes(), min_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_secret_is_refused_rather_than_accepted() {
        // `.dev.vars` with a blank value is the likely mistake, and the whole
        // point of the refusal is that it is not mistaken for a configuration.
        assert!(SecretBytes::new("K", Vec::new(), 32).is_err());
    }

    #[test]
    fn a_short_secret_is_refused() {
        assert!(SecretBytes::new("K", vec![0; 31], 32).is_err());
        assert!(SecretBytes::new("K", vec![0; 32], 32).is_ok());
    }

    #[test]
    fn a_long_secret_is_accepted_because_the_cipher_decides() {
        // A 64-byte HMAC key is legitimate; refusing it here would mean this
        // file, not WebCrypto, was the authority on key sizes.
        assert!(SecretBytes::new("K", vec![0; 64], 32).is_ok());
    }

    #[test]
    fn a_secret_never_prints_itself() {
        // 32 bytes exactly, so the value is the one a signing secret would be.
        // The literal is recognisable on purpose: the assertion is that this
        // recognisable string does not appear in the `Debug` output.
        let raw = b"hunter2-hunter2-hunter2-12345678";
        assert_eq!(raw.len(), 32);
        let secret = SecretBytes::new("K", raw.to_vec(), 32).expect("32 bytes");
        let debug = format!("{secret:?}");
        assert!(debug.contains("32 bytes"), "{debug}");
        assert!(!debug.contains("hunter2"), "{debug}");
        assert_eq!(secret.len(), 32);
        assert!(!secret.is_empty());
    }

    #[test]
    fn the_redacted_debug_names_only_the_length() {
        // The exact string is asserted, not just the absence of the value, so
        // that a future `Debug` that redacts differently is a visible diff
        // rather than a silent change to a format a log parser may rely on.
        let secret = SecretBytes::new("K", vec![9u8; 48], 32).expect("48 bytes");
        assert_eq!(format!("{secret:?}"), "SecretBytes(48 bytes, <redacted>)");
    }
}
