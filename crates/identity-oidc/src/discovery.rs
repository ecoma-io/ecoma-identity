//! The `OpenID` Provider metadata document.
//!
//! Served at `/.well-known/openid-configuration`. It is the one document every
//! OIDC client fetches first, so every field in it is a *promise*. Promising a
//! response type or grant the implementation does not serve is how a
//! conformance suite fails, and how a client picks an endpoint that will
//! 501.

use serde::{Deserialize, Serialize};

/// The provider's metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryDocument {
    /// The issuer identifier. Every token this provider mints carries an
    /// `iss` that must equal this string exactly, including scheme and any
    /// trailing slash. It is not a URL this provider resolves; it is an
    /// opaque identifier that happens to look like one.
    pub issuer: String,

    /// The authorization endpoint.
    pub authorization_endpoint: String,

    /// The token endpoint.
    pub token_endpoint: String,

    /// The userinfo endpoint.
    pub userinfo_endpoint: String,

    /// The JWKS URI. The public keys clients use to verify this provider's
    /// signatures.
    pub jwks_uri: String,

    /// The revocation endpoint, per RFC 7009.
    pub revocation_endpoint: String,

    /// The end-session endpoint.
    pub end_session_endpoint: String,

    /// The scopes this provider supports. The `openid` scope is mandatory for
    /// an OIDC provider and is not optional here.
    pub scopes_supported: Vec<String>,

    /// The response types this provider supports. `code` only: the implicit
    /// and hybrid flows return tokens in a redirect, and a token in a URL is
    /// a token in a browser history, a referrer header and a proxy log.
    pub response_types_supported: Vec<String>,

    /// The grant types this provider supports. `authorization_code` and
    /// `refresh_token`; never `implicit`, never `password`.
    pub grant_types_supported: Vec<String>,

    /// The subject identifier types. `public` only — the same subject for the
    /// same user across every client, which is the privacy-preserving choice
    /// and the one that stops clients correlating users across each other.
    pub subject_types_supported: Vec<String>,

    /// The signing algorithms this provider's ID tokens may be signed with.
    pub id_token_signing_alg_values_supported: Vec<String>,

    /// The signing algorithms this provider's *userinfo* responses may use.
    pub userinfo_signing_alg_values_supported: Vec<String>,

    /// The PKCE code-challenge methods. `S256` only; see
    /// [`crate::SUPPORTED_CODE_CHALLENGE_METHOD`].
    pub code_challenge_methods_supported: Vec<String>,

    /// The token endpoint's authentication methods. `client_secret_basic` and
    /// `client_secret_post` for confidential clients, `none` for public ones.
    pub token_endpoint_auth_methods_supported: Vec<String>,

    /// The claims this provider may put in an ID token.
    pub claims_supported: Vec<String>,

    /// The claims this provider may return from userinfo.
    pub claims_parameter_supported: bool,

    /// Whether this provider will accept a request with no `redirect_uri`.
    /// Always `false`: a redirect URI learned at request time is the open
    /// redirect this design refuses.
    pub request_parameter_supported: bool,

    /// Whether `request` and `request_uri` are supported. Always `false` in
    /// bootstrap: JAR is a large surface and nothing here needs it.
    pub require_request_uri_registration: bool,
}

impl DiscoveryDocument {
    /// The scope every OIDC request must carry.
    pub const REQUIRED_SCOPE: &'static str = "openid";

    /// The `id_token` response type.
    pub const SCOPE_OPENID: &'static str = "openid";

    /// The `profile` scope.
    pub const SCOPE_PROFILE: &'static str = "profile";

    /// The `email` scope.
    pub const SCOPE_EMAIL: &'static str = "email";

    /// Build the document this crate's `v1` contract declares.
    ///
    /// # Errors
    ///
    /// None today. The return type is `Result` because a future field that
    /// needs validating — a custom `issuer` passed in by configuration, say —
    /// will, and a constructor whose signature changes is a breaking change
    /// at every call site.
    pub fn bootstrap(issuer: impl Into<String>) -> crate::discovery::Result<Self> {
        let issuer = issuer.into();
        Ok(Self {
            authorization_endpoint: format!("{issuer}/oauth/authorize"),
            token_endpoint: format!("{issuer}/oauth/token"),
            userinfo_endpoint: format!("{issuer}/oauth/userinfo"),
            jwks_uri: format!("{issuer}/.well-known/jwks.json"),
            revocation_endpoint: format!("{issuer}/oauth/revoke"),
            end_session_endpoint: format!("{issuer}/oauth/logout"),
            issuer,
            scopes_supported: vec![
                Self::REQUIRED_SCOPE.to_string(),
                Self::SCOPE_PROFILE.to_string(),
                Self::SCOPE_EMAIL.to_string(),
            ],
            response_types_supported: vec!["code".to_string()],
            grant_types_supported: vec![
                "authorization_code".to_string(),
                "refresh_token".to_string(),
            ],
            subject_types_supported: vec!["public".to_string()],
            id_token_signing_alg_values_supported: vec!["RS256".to_string()],
            userinfo_signing_alg_values_supported: vec!["RS256".to_string()],
            code_challenge_methods_supported: vec![
                crate::SUPPORTED_CODE_CHALLENGE_METHOD.to_string(),
            ],
            token_endpoint_auth_methods_supported: vec![
                "client_secret_basic".to_string(),
                "client_secret_post".to_string(),
                "none".to_string(),
            ],
            claims_supported: vec![
                "iss".to_string(),
                "sub".to_string(),
                "aud".to_string(),
                "exp".to_string(),
                "iat".to_string(),
                "auth_time".to_string(),
                "nonce".to_string(),
                "acr".to_string(),
                "amr".to_string(),
                "name".to_string(),
                "email".to_string(),
                "email_verified".to_string(),
            ],
            claims_parameter_supported: false,
            request_parameter_supported: false,
            require_request_uri_registration: false,
        })
    }
}

/// The result type for document construction.
pub type Result<T> = core::result::Result<T, crate::discovery::DiscoveryError>;

/// Why a discovery document could not be built.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DiscoveryError {
    /// The configured issuer is not a usable absolute URL.
    #[error("issuer must be an absolute https URL in production")]
    InvalidIssuer {
        /// What was configured.
        issuer: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_endpoint_is_derived_from_the_issuer() {
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        assert_eq!(doc.issuer, "https://auth.ecoma.io");
        assert_eq!(
            doc.authorization_endpoint,
            "https://auth.ecoma.io/oauth/authorize"
        );
        assert_eq!(doc.token_endpoint, "https://auth.ecoma.io/oauth/token");
        assert_eq!(doc.jwks_uri, "https://auth.ecoma.io/.well-known/jwks.json");
    }

    #[test]
    fn the_implicit_flow_is_not_advertised() {
        // A client that sees `id_token` in response_types_supported will use
        // the implicit flow, which returns a token in a redirect fragment.
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        assert_eq!(doc.response_types_supported, vec!["code"]);
        assert!(!doc.grant_types_supported.iter().any(|g| g == "implicit"));
        assert!(!doc.grant_types_supported.iter().any(|g| g == "password"));
    }

    #[test]
    fn only_s256_pkce_is_advertised() {
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        assert_eq!(doc.code_challenge_methods_supported, vec!["S256"]);
        assert!(
            !doc.code_challenge_methods_supported
                .iter()
                .any(|m| m == "plain")
        );
    }

    #[test]
    fn the_openid_scope_is_present() {
        // An OIDC provider without the `openid` scope is not an OIDC provider.
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        assert!(doc.scopes_supported.iter().any(|s| s == "openid"));
    }

    #[test]
    fn the_subject_type_is_public() {
        // `pairwise` would give each client a different subject for the same
        // user. That is a real privacy property, and it is *not* this
        // provider's: the `identity` model exposes a stable subject, and
        // advertising `pairwise` without implementing it would be a lie
        // clients act on.
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        assert_eq!(doc.subject_types_supported, vec!["public"]);
    }

    #[test]
    fn the_document_serialises_with_the_spec_field_names() {
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        let json = serde_json::to_string(&doc).expect("serializable");
        for field in [
            "issuer",
            "authorization_endpoint",
            "jwks_uri",
            "response_types_supported",
            "code_challenge_methods_supported",
            "subject_types_supported",
        ] {
            assert!(
                json.contains(field),
                "{field} must keep its spec name: {json}"
            );
        }
    }

    #[test]
    fn jar_is_declined_explicitly_rather_than_omitted() {
        // `false` is better than absent: absent means "unspecified", and a
        // client that reads unspecified as "maybe" is the problem JAR creates.
        let doc = DiscoveryDocument::bootstrap("https://auth.ecoma.io").expect("valid");
        assert!(!doc.request_parameter_supported);
        assert!(!doc.require_request_uri_registration);
        assert!(!doc.claims_parameter_supported);
    }
}
