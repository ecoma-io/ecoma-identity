//! Response shapes: what the token, userinfo and authorization endpoints
//! return.

use serde::{Deserialize, Serialize};

/// A successful authorization response.
///
/// A *successful* response is a redirect, not a body: the endpoint answers
/// with a 302 whose `Location` carries the code. This type exists so the
/// endpoint can build and test that `Location` without doing any HTTP.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationResponse {
    /// The authorization code. Single-use, short-lived, and bound to the
    /// `redirect_uri` and PKCE challenge it was issued against.
    pub code: String,
    /// The state echoed from the request. Present because the client's own
    /// check depends on it.
    pub state: String,
    /// The `iss` parameter (RFC 9207), which mitigates mix-up attacks in a
    /// multi-provider setup. Always this provider's issuer.
    pub issuer: String,
}

impl AuthorizationResponse {
    /// The `Location` header value for this response.
    ///
    /// # Errors
    ///
    /// None. The components are already URL-safe by construction: the code
    /// and state are base64url or UUID-shaped, and the issuer is a configured
    /// absolute URL. A future change that puts user input in any of them
    /// should make this fallible rather than widening an escape.
    #[must_use]
    pub fn location(&self, redirect_uri: &str) -> String {
        let separator = if redirect_uri.contains('?') { '&' } else { '?' };
        format!(
            "{redirect_uri}{separator}code={}&state={}&iss={}",
            urlencoding::encode(&self.code),
            urlencoding::encode(&self.state),
            urlencoding::encode(&self.issuer),
        )
    }
}

/// A successful token response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenResponse {
    /// The access token. Opaque to the client in this design: a JWT would
    /// leak claims to anything that can read it and would be validated by
    /// every client separately. See ADR-0005.
    pub access_token: String,
    /// The token type. Always `Bearer`.
    pub token_type: String,
    /// Lifetime in seconds.
    pub expires_in: u64,
    /// The ID token. Present only for an OIDC request (`openid` scope).
    pub id_token: Option<String>,
    /// The refresh token. Present when the client is registered for one.
    pub refresh_token: Option<String>,
    /// The scopes actually granted, space-delimited per RFC 6749 §5.1. A
    /// client that asked for more than it registered for learns the difference
    /// here, from the server, rather than by discovering it at a protected
    /// resource.
    pub scope: String,
}

impl TokenResponse {
    /// The only token type this provider issues.
    pub const TOKEN_TYPE: &'static str = "Bearer";

    /// A response for an OIDC request.
    ///
    /// # Errors
    ///
    /// None. Construction is infallible; validation belongs to the token
    /// service, which this crate does not contain.
    #[allow(clippy::too_many_arguments)]
    pub fn oidc(
        access_token: impl Into<String>,
        expires_in: u64,
        id_token: impl Into<String>,
        refresh_token: Option<String>,
        scope: impl Into<String>,
    ) -> Self {
        Self {
            access_token: access_token.into(),
            token_type: Self::TOKEN_TYPE.to_string(),
            expires_in,
            id_token: Some(id_token.into()),
            refresh_token,
            scope: scope.into(),
        }
    }

    /// A response for a request that carried no `openid` scope.
    ///
    /// # Errors
    ///
    /// None. See [`TokenResponse::oidc`].
    pub fn oauth2(
        access_token: impl Into<String>,
        expires_in: u64,
        refresh_token: Option<String>,
        scope: impl Into<String>,
    ) -> Self {
        Self {
            access_token: access_token.into(),
            token_type: Self::TOKEN_TYPE.to_string(),
            expires_in,
            id_token: None,
            refresh_token,
            scope: scope.into(),
        }
    }
}

/// A userinfo response.
///
/// An unsigned JSON document, not a JWT. A signed userinfo response is
/// specified and some clients require it, but it is also a second signature
/// path to get wrong; the access token is already the authentication of this
/// call, and the claims here are about the user the token was issued for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInfoResponse {
    /// The subject. Always the same string for the same user, across every
    /// client — see the `public` subject type in the discovery document.
    pub sub: String,
    /// The display name, present when the `profile` scope was granted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The preferred username, present when the `profile` scope was granted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_username: Option<String>,
    /// The email address, present when the `email` scope was granted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Whether the address has been proven. A client that ignores this and
    /// keys on `email` alone has an account-takeover bug, which is why the
    /// field is not optional when `email` is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
}

impl UserInfoResponse {
    /// The subject claim name.
    pub const SUBJECT_CLAIM: &'static str = "sub";

    /// Whether the claims required for an email-scoped response are present.
    ///
    /// `email_verified` is mandatory alongside `email` here even though the
    /// spec marks it optional: a client keying on an unverified address is
    /// the single most common OIDC vulnerability, and refusing to emit the
    /// pair is cheaper than hoping every client checks.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn email_is_safely_usable(&self) -> bool {
        self.email.is_some() && self.email_verified == Some(true)
    }
}

/// An OAuth error response, per RFC 6749 §5.2.
///
/// A distinct type from `identity-cloudflare`'s error envelope, and the
/// difference is load-bearing: the OAuth endpoints must answer in the shape a
/// third-party OAuth client library can parse, while the rest of the API
/// answers in the shape Ecoma's own clients can parse. One envelope for both
/// would break one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthErrorResponse {
    /// The machine-readable error code, from the fixed set in §5.2.
    pub error: String,
    /// A human-readable description. Never contains a secret.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error_description: Option<String>,
    /// A URI a client can follow to learn more.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error_uri: Option<String>,
}

impl OAuthErrorResponse {
    /// `invalid_request`.
    pub const INVALID_REQUEST: &'static str = "invalid_request";
    /// `invalid_client`.
    pub const INVALID_CLIENT: &'static str = "invalid_client";
    /// `invalid_grant`.
    pub const INVALID_GRANT: &'static str = "invalid_grant";
    /// `unauthorized_client`.
    pub const UNAUTHORIZED_CLIENT: &'static str = "unauthorized_client";
    /// `unsupported_grant_type`.
    pub const UNSUPPORTED_GRANT_TYPE: &'static str = "unsupported_grant_type";
    /// `invalid_scope`.
    pub const INVALID_SCOPE: &'static str = "invalid_scope";
    /// `access_denied`.
    pub const ACCESS_DENIED: &'static str = "access_denied";
    /// `server_error`.
    pub const SERVER_ERROR: &'static str = "server_error";

    /// Build an error response.
    ///
    /// # Errors
    ///
    /// None.
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            error_description: None,
            error_uri: None,
        }
    }

    /// Attach a human-readable description.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.error_description = Some(description.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unverified_email_is_not_safely_usable() {
        let unverified = UserInfoResponse {
            sub: "s".into(),
            name: None,
            preferred_username: None,
            email: Some("ada@example.com".into()),
            email_verified: Some(false),
        };
        assert!(!unverified.email_is_safely_usable());

        let absent = UserInfoResponse {
            sub: "s".into(),
            name: None,
            preferred_username: None,
            email: Some("ada@example.com".into()),
            email_verified: None,
        };
        assert!(
            !absent.email_is_safely_usable(),
            "an email with no verified flag is not safely usable"
        );

        let verified = UserInfoResponse {
            email_verified: Some(true),
            ..unverified.clone()
        };
        assert!(verified.email_is_safely_usable());
    }

    #[test]
    fn absent_claims_are_omitted_rather_than_serialised_as_null() {
        // A client that sees `"email": null` and does not handle null is
        // entitled to be annoyed; a client that sees the key absent handles it.
        let minimal = UserInfoResponse {
            sub: "s".into(),
            name: None,
            preferred_username: None,
            email: None,
            email_verified: None,
        };
        let json = serde_json::to_string(&minimal).expect("serializable");
        assert_eq!(json, r#"{"sub":"s"}"#);
    }

    #[test]
    fn an_oauth2_response_carries_no_id_token() {
        let r = TokenResponse::oauth2("at", 300, Some("rt".into()), "email");
        assert_eq!(r.id_token, None);
        assert_eq!(r.token_type, "Bearer");
    }

    #[test]
    fn an_oidc_response_always_carries_an_id_token() {
        let r = TokenResponse::oidc("at", 300, "it", Some("rt".into()), "openid email");
        assert_eq!(r.id_token.as_deref(), Some("it"));
    }

    #[test]
    fn a_redirect_with_an_existing_query_gets_an_ampersand() {
        let resp = AuthorizationResponse {
            code: "c".into(),
            state: "s".into(),
            issuer: "https://auth.ecoma.io".into(),
        };
        assert!(
            resp.location("https://app.test/cb")
                .starts_with("https://app.test/cb?code=")
        );
        assert!(resp.location("https://app.test/cb?x=1").contains("&code="));
    }

    #[test]
    fn the_location_encodes_its_components() {
        // The state is client-supplied and comes back through a URL. If it
        // carried a `&` and were not encoded, the client would parse the
        // wrong parameters back.
        let resp = AuthorizationResponse {
            code: "c".into(),
            state: "a&b=c".into(),
            issuer: "https://auth.ecoma.io".into(),
        };
        let location = resp.location("https://app.test/cb");
        assert!(location.contains("state=a%26b%3Dc"), "{location}");
    }

    #[test]
    fn an_oauth_error_omits_absent_optional_fields() {
        let e = OAuthErrorResponse::new(OAuthErrorResponse::INVALID_REQUEST)
            .with_description("code_challenge is required");
        let json = serde_json::to_string(&e).expect("serializable");
        assert!(json.contains(r#""error":"invalid_request""#), "{json}");
        assert!(!json.contains("error_uri"), "{json}");
    }
}
