//! JWT and JWK types.
//!
//! **Shape only.** This module can serialise a header and a claim set and
//! parse a JWK set. It cannot sign, verify, or check an expiry — that is
//! `identity-security`'s, and the crate is not allowed to depend on it (see the
//! crate documentation). Every function here that takes a secret or a key is
//! absent by construction; if you find yourself adding one, the boundary has
//! been crossed and it belongs in the security crate.

use serde::{Deserialize, Serialize};

/// A JWT header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JwtHeader {
    /// The signing algorithm. `RS256` only for this provider; see
    /// [`crate::discovery::DiscoveryDocument`].
    pub alg: String,
    /// The token type, when the token is not an ID token.
    #[serde(rename = "typ", skip_serializing_if = "Option::is_none")]
    pub typ: Option<String>,
    /// The key identifier — which key in the JWKS signed this.
    pub kid: String,
}

impl JwtHeader {
    /// The only algorithm this provider signs with.
    pub const ALGORITHM: &'static str = "RS256";

    /// The only algorithm this provider verifies with. Declared as a constant
    /// distinct from [`JwtHeader::ALGORITHM`] on purpose: "the algorithm we
    /// emit" and "the algorithm we accept" are two different decisions, and a
    /// single constant shared between them is how `alg: none` gets accepted.
    pub const ACCEPTED_ALGORITHM: &'static str = "RS256";

    /// The ID token type marker.
    pub const TYPE_ID_TOKEN: &'static str = "JWT";

    /// The access token type marker.
    pub const TYPE_ACCESS_TOKEN: &'static str = "at+jwt";
}

/// The claims an ID token carries.
///
/// Every registered claim is required; the profile and email claims are
/// present only when the corresponding scope was granted, which is what
/// `Option` means here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdTokenClaims {
    /// The issuer. Must equal the discovery document's `issuer` exactly.
    pub iss: String,
    /// The subject — the user.
    pub sub: String,
    /// The audience: the client the token was minted for.
    pub aud: String,
    /// Expiry, as seconds since the Unix epoch.
    pub exp: i64,
    /// Issued-at, as seconds since the Unix epoch.
    pub iat: i64,
    /// When the user actually authenticated, as seconds since the Unix epoch.
    /// Distinct from `iat`: a token minted an hour after authentication has a
    /// much later `iat` than `auth_time`, and that gap is exactly the signal a
    /// client needs to decide whether to ask for a step-up.
    pub auth_time: i64,
    /// The nonce from the authorization request. Required whenever the request
    /// carried one; its absence from a response to a request that had one is a
    /// replay.
    pub nonce: Option<String>,
    /// The authentication context class reference — this provider's `aal`.
    pub acr: String,
    /// The authentication methods used, as an array of strings.
    pub amr: Vec<String>,
    /// The display name, when the `profile` scope was granted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The email address, when the `email` scope was granted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Whether the address was proven. Present whenever `email` is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
}

impl IdTokenClaims {
    /// The `acr` value for an AAL1 authentication.
    pub const ACR_AAL1: &'static str = "urn:ecoma:loa:1";

    /// The `acr` value for an AAL2 authentication.
    pub const ACR_AAL2: &'static str = "urn:ecoma:loa:2";

    /// The AMR value for an emailed one-time code.
    pub const AMR_EMAIL_OTP: &'static str = "otp";

    /// The AMR value for a time-based one-time password.
    pub const AMR_OTP: &'static str = "otp";

    /// The AMR value for a passkey.
    pub const AMR_PASSKEY: &'static str = "user";

    /// The AMR value for a federated provider.
    pub const AMR_FEDERATED: &'static str = "federated";

    /// Whether the token is expired at `now_secs`.
    ///
    /// # Errors
    ///
    /// None. The comparison is total. Note this is *only* the expiry check:
    /// signature, issuer, audience and nonce are the verifier's job, and a
    /// caller that treats a `false` from here as "this token is good" has
    /// skipped four checks.
    #[must_use]
    pub const fn is_expired_at(&self, now_secs: i64) -> bool {
        now_secs >= self.exp
    }
}

/// A JWK set, served at the JWKS URI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JwkSet {
    /// The keys. At least one, always: an empty JWKS is a provider that
    /// cannot verify anything it has ever signed, which during a rotation
    /// window is indistinguishable from a total outage.
    pub keys: Vec<JsonWebKey>,
}

impl JwkSet {
    /// Find a key by its identifier.
    ///
    /// # Errors
    ///
    /// None. An absent key returns `None`, and it is the *verifier's* job to
    /// treat that as a verification failure rather than to look for another
    /// key: a signature that validates under no advertised key is not valid.
    #[must_use]
    pub fn find(&self, kid: &str) -> Option<&JsonWebKey> {
        self.keys.iter().find(|k| k.kid == kid)
    }
}

/// One JSON Web Key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonWebKey {
    /// The key type. `RSA` only in bootstrap.
    pub kty: String,
    /// The intended use. `sig` — never `enc`. This provider does not encrypt
    /// with its signing keys, and a key advertised for both is a key someone
    /// will eventually use for both.
    #[serde(rename = "use")]
    pub use_: String,
    /// The algorithm. Matches `kty`.
    pub alg: String,
    /// The key identifier, referenced by a JWT header.
    pub kid: String,
    /// The RSA modulus.
    pub n: String,
    /// The RSA public exponent.
    pub e: String,
}

impl JsonWebKey {
    /// The only key type.
    pub const KEY_TYPE: &'static str = "RSA";

    /// The only accepted use.
    pub const USE_SIGNATURE: &'static str = "sig";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_rs256_is_offered_and_only_rs256_is_accepted() {
        // Two constants, not one. If they were the same constant, a future
        // change that added a second algorithm to `ALGORITHM` would silently
        // widen what is accepted.
        assert_eq!(JwtHeader::ALGORITHM, "RS256");
        assert_eq!(JwtHeader::ACCEPTED_ALGORITHM, "RS256");
    }

    #[test]
    fn expiry_is_inclusive_at_the_boundary() {
        // A token whose `exp` is now is expired. Off-by-one here is a token
        // that lives one second longer than advertised, which is the direction
        // that matters.
        let claims = IdTokenClaims {
            iss: "https://auth.ecoma.io".into(),
            sub: "s".into(),
            aud: "c".into(),
            exp: 1_000,
            iat: 900,
            auth_time: 900,
            nonce: None,
            acr: IdTokenClaims::ACR_AAL1.into(),
            amr: vec![IdTokenClaims::AMR_EMAIL_OTP.into()],
            name: None,
            email: None,
            email_verified: None,
        };
        assert!(!claims.is_expired_at(999));
        assert!(claims.is_expired_at(1_000));
        assert!(claims.is_expired_at(1_001));
    }

    #[test]
    fn a_jwk_is_found_by_its_identifier_and_absent_otherwise() {
        let key = JsonWebKey {
            kty: JsonWebKey::KEY_TYPE.into(),
            use_: JsonWebKey::USE_SIGNATURE.into(),
            alg: "RS256".into(),
            kid: "k1".into(),
            n: "AQAB".into(),
            e: "AQAB".into(),
        };
        let set = JwkSet {
            keys: vec![key.clone()],
        };
        assert_eq!(set.find("k1"), Some(&key));
        assert_eq!(set.find("k2"), None);
    }

    #[test]
    fn the_use_field_serialises_as_use() {
        // `use` is a Rust keyword, so the field is `use_` and renamed. A
        // client that receives `"use_": "sig"` will not find the key's usage.
        let key = JsonWebKey {
            kty: "RSA".into(),
            use_: "sig".into(),
            alg: "RS256".into(),
            kid: "k".into(),
            n: "x".into(),
            e: "x".into(),
        };
        let json = serde_json::to_string(&key).expect("serializable");
        assert!(json.contains(r#""use":"sig""#), "{json}");
        assert!(!json.contains("use_"), "{json}");
    }

    #[test]
    fn an_empty_claim_set_still_serialises_the_registered_claims() {
        let claims = IdTokenClaims {
            iss: "i".into(),
            sub: "s".into(),
            aud: "a".into(),
            exp: 1,
            iat: 0,
            auth_time: 0,
            nonce: None,
            acr: "x".into(),
            amr: vec![],
            name: None,
            email: None,
            email_verified: None,
        };
        let json = serde_json::to_string(&claims).expect("serializable");
        for claim in ["iss", "sub", "aud", "exp", "iat", "auth_time", "acr", "amr"] {
            assert!(
                json.contains(&format!("\"{claim}\"")),
                "{claim} missing: {json}"
            );
        }
    }
}
