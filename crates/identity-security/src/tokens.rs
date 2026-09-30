//! Token, session, PKCE, nonce, CSRF and secret-cipher gates.
//!
//! Every function here that takes a secret does so through a named, narrow
//! method. The names are not decoration: `expose_for_verification` reads as
//! "this is the only thing that should be calling me" in a way that
//! `as_bytes` does not, and a reviewer scanning for secret handling has
//! something to grep for.

use serde::{Deserialize, Serialize};

use crate::error::{SecurityError, SecurityResult};

/// Which signing key signed a token.
///
/// A newtype over a string, so a key identifier cannot be confused with a
/// token, a session or an audience.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SigningKeyId(String);

impl SigningKeyId {
    /// Adopt a key identifier.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the identifier is blank or longer
    /// than 128 bytes. A `kid` is attacker-influenced input — it comes from a
    /// token's header — so it must be bounded before it reaches a map lookup.
    pub fn new(id: impl Into<String>) -> SecurityResult<Self> {
        let id = id.into();
        identity_domain::error::require_non_blank("kid", &id).map_err(|_| {
            SecurityError::Cryptographic {
                reason: "key identifier must not be blank".to_string(),
            }
        })?;
        identity_domain::error::require_max_len("kid", &id, 128).map_err(|_| {
            SecurityError::Cryptographic {
                reason: "key identifier must be at most 128 bytes".to_string(),
            }
        })?;
        Ok(Self(id))
    }

    /// Borrow the identifier.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A signed token: a JWS in compact serialisation.
///
/// A `Debug` that prints the signature, because a signature is not a secret —
/// it is a verification artefact. The *signed payload* may be, so this type
/// holds the three parts separately and prints them labelled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedToken {
    /// The base64url header.
    pub header: String,
    /// The base64url claims.
    pub payload: String,
    /// The base64url signature.
    pub signature: String,
}

impl SignedToken {
    /// The compact serialisation, the form that goes on the wire.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn to_compact(&self) -> String {
        format!("{}.{}.{}", self.header, self.payload, self.signature)
    }
}

/// Produce signatures over claims.
pub trait TokenSigner {
    /// The key identifier this signer signs with, advertised in the header.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when no signing key is configured.
    /// There is no "development" key: a signer without a key cannot sign, and
    /// a signer with a hard-coded key would be a key in the source tree.
    fn signing_key_id(&self) -> SecurityResult<SigningKeyId>;

    /// Sign a claim set.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when no key is configured, and
    /// [`SecurityError::Cryptographic`] on failure.
    fn sign(&self, claims: &serde_json::Value) -> SecurityResult<SignedToken>;

    /// The public key material to publish in the JWKS.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when no key is configured, and
    /// [`SecurityError::Cryptographic`] when the key cannot be exported. A key
    /// that cannot be published is a key that has to be replaced — a rotation
    /// plan, not a code path to paper over.
    fn public_jwks(&self) -> SecurityResult<serde_json::Value>;
}

/// Validate a token's signature and claims.
pub trait TokenVerifier {
    /// Verify a token and return its claims.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MalformedToken`] when the structure is wrong, and
    /// [`SecurityError::TokenRejected`] for everything else — wrong audience,
    /// wrong issuer, bad signature, unknown `kid`, outside the validity window.
    /// One error for all of them on purpose: a caller that could tell "no such
    /// key" from "bad signature" could enumerate which keys exist.
    fn verify(&self, token: &SignedToken) -> SecurityResult<serde_json::Value>;
}

/// Bind a session to the credentials that presented it.
pub trait SessionService {
    /// Resolve a session credential to its session.
    ///
    /// # Errors
    ///
    /// [`SecurityError::TokenRejected`] when the credential is unknown,
    /// revoked or expired. One error for all three: distinguishing them turns
    /// this into an oracle for testing whether a given session token is still
    /// live.
    fn resolve(&self, credential: &str) -> SecurityResult<identity_domain::session::SessionId>;

    /// Issue a fresh session credential for a session.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if a secure random source is
    /// unavailable. The credential must be at least 256 bits of entropy; a
    /// shorter one is a guessable session.
    fn issue_credential(
        &self,
        session: &identity_domain::session::Session,
    ) -> SecurityResult<String>;
}

/// Verify a PKCE code verifier against a challenge.
pub trait PkceService {
    /// Check a verifier against a challenge, per RFC 7636.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] when they do not match, and
    /// [`SecurityError::ChallengeMismatch`] when either is absent. The
    /// comparison is the `S256` one: `BASE64URL(SHA256(verifier))` against the
    /// challenge, compared in constant time. `plain` is not implemented,
    /// because the discovery document does not advertise it.
    fn verify(&self, challenge: &str, verifier: &str) -> SecurityResult<()>;

    /// Derive the challenge for a verifier, for clients and for tests.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] when the verifier is outside the
    /// RFC 7636 length range of 43–128 characters.
    fn derive_challenge(&self, verifier: &str) -> SecurityResult<String>;
}

/// Bind a request to a browser session.
pub trait NonceService {
    /// Issue a nonce and remember it against a session.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if a secure random source is
    /// unavailable.
    fn issue(&self, session_id: &identity_domain::session::SessionId) -> SecurityResult<String>;

    /// Consume a nonce, returning whether it was one this service issued to
    /// this session and has not consumed.
    ///
    /// "Returning" rather than erroring, because "was this valid" and "tell me
    /// why not" are different needs and a callback that has already been
    /// invalidated should not care why.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if the nonce store is unavailable. It
    /// must not degrade to "assume valid" — a nonce store outage that permits
    /// nonces is a CSRF filter that is off during every outage.
    fn consume(
        &self,
        session_id: &identity_domain::session::SessionId,
        nonce: &str,
    ) -> SecurityResult<bool>;
}

/// Bind an OAuth request to the browser that made it.
pub trait CsrfService {
    /// Issue a `state` parameter for a browser session and a redirect target.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if a secure random source is
    /// unavailable.
    fn issue_state(
        &self,
        session_id: &identity_domain::session::SessionId,
        return_to: &str,
    ) -> SecurityResult<String>;

    /// Consume a `state`, returning the redirect target it was issued for.
    ///
    /// The returned target is the one **this service** recorded, never one
    /// reconstructed from the request. That is the whole point: a `state` whose
    /// redirect target is read back out of the same query string that carried
    /// it protects nothing.
    ///
    /// # Errors
    ///
    /// [`SecurityError::ChallengeMismatch`] when the state is unknown or
    /// already consumed, and [`SecurityError::Cryptographic`] when the store is
    /// unavailable.
    fn consume_state(
        &self,
        session_id: &identity_domain::session::SessionId,
        state: &str,
    ) -> SecurityResult<String>;
}

/// Encrypt and decrypt secret material at rest.
///
/// # Security
///
/// Implementations must use a maintained AEAD with a nonce derived from a
/// counter or a random value **per encryption**, and must never reuse a nonce
/// with the same key. A TOTP seed stored under a single static IV is readable
/// by anyone who obtains two rows.
pub trait SecretCipher {
    /// Encrypt a secret for storage.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when the encryption key is not
    /// configured, and [`SecurityError::Cryptographic`] on failure.
    fn encrypt(&self, plaintext: &[u8]) -> SecurityResult<Vec<u8>>;

    /// Decrypt a secret from storage.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when the key is not configured, and
    /// [`SecurityError::Cryptographic`] when the ciphertext is truncated,
    /// tampered with, or was written under a previous key. All three are
    /// [`SecurityError::Cryptographic`] rather than distinguishable outcomes
    /// so that a caller cannot use the error to probe stored ciphertexts.
    fn decrypt(&self, ciphertext: &[u8]) -> SecurityResult<Vec<u8>>;

    /// The key identifier under which data is currently encrypted, so a
    /// rotation can decrypt old rows and encrypt new ones.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when no key is configured.
    fn current_key_id(&self) -> SecurityResult<SigningKeyId>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_identifier_is_bounded() {
        // `kid` arrives from a token header, which is attacker-controlled.
        assert!(SigningKeyId::new("k1").is_ok());
        assert!(SigningKeyId::new("").is_err());
        assert!(SigningKeyId::new("  ").is_err());
        assert!(SigningKeyId::new("k".repeat(129)).is_err());
        assert!(SigningKeyId::new("k".repeat(128)).is_ok());
    }

    #[test]
    fn a_signed_token_serialises_to_the_three_dot_compact_form() {
        let t = SignedToken {
            header: "aGVhZGVy".into(),
            payload: "cGF5bG9hZA".into(),
            signature: "c2ln".into(),
        };
        assert_eq!(t.to_compact(), "aGVhZGVy.cGF5bG9hZA.c2ln");
    }

    #[test]
    fn a_signed_token_prints_its_parts_labelled() {
        // The signature is not a secret; the payload might be. Printing the
        // three parts with names is what makes a log line readable without
        // making it dangerous.
        let t = SignedToken {
            header: "H".into(),
            payload: "P".into(),
            signature: "S".into(),
        };
        let debug = format!("{t:?}");
        assert!(debug.contains("header"), "{debug}");
        assert!(debug.contains("signature"), "{debug}");
    }

    #[test]
    fn every_gate_trait_is_object_safe() {
        // The Workers wire these through `Arc<dyn Trait>` and the testkit
        // doubles them behind the same types. A trait that could not be used
        // that way would force generics into the composition roots for no
        // benefit.
        fn object_safe<T: ?Sized>(_: &std::collections::HashMap<String, std::sync::Arc<T>>) {}
        let _ = object_safe::<dyn TokenSigner>;
        let _ = object_safe::<dyn TokenVerifier>;
        let _ = object_safe::<dyn SessionService>;
        let _ = object_safe::<dyn PkceService>;
        let _ = object_safe::<dyn NonceService>;
        let _ = object_safe::<dyn CsrfService>;
        let _ = object_safe::<dyn SecretCipher>;
        let _ = object_safe::<dyn crate::factors::OtpService>;
        let _ = object_safe::<dyn crate::factors::TotpService>;
        let _ = object_safe::<dyn crate::factors::PasskeyService>;
        let _ = object_safe::<dyn crate::factors::RecoveryCodeService>;
    }
}
