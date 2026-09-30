//! Request shapes: what a client sends to the authorization and token
//! endpoints.

use serde::{Deserialize, Serialize};

use identity_domain::application::ApplicationId;

/// A request to the authorization endpoint.
///
/// The `client_id` is kept as a `String` rather than an [`ApplicationId`]
/// because it is *this* string, not our internal row identifier: the protocol
/// field is a client-chosen handle and resolving it to an application is a
/// repository step this type must not perform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationRequest {
    /// The client identifier, as registered.
    pub client_id: String,
    /// The response type. Only `code` is accepted (see
    /// [`crate::discovery::DiscoveryDocument`]).
    pub response_type: String,
    /// The client identifier as the *user* is redirected back. Echoed in the
    /// response so a client with several in flight can tell them apart. Not a
    /// secret; not a CSRF defence on its own — that is `state`.
    pub redirect_uri: String,
    /// Space-delimited scopes. `openid` is mandatory.
    pub scope: String,
    /// The client's CSRF binding. Required on every request; a request with no
    /// `state` is refused rather than defaulted.
    pub state: String,
    /// The nonce binding the ID token's `nonce` claim to this request.
    pub nonce: Option<String>,
    /// The PKCE code challenge, base64url without padding.
    pub code_challenge: String,
    /// The method the challenge was derived with. `S256` only.
    pub code_challenge_method: String,
    /// What the user is being asked to consent to. Display-only.
    pub prompt: Option<String>,
    /// The identity provider to federate to, when the request selects one.
    pub provider: Option<String>,
    /// The `login_hint` — a pre-filled identifier. Advisory only; a hint is
    /// never an assertion and never bypasses a challenge.
    pub login_hint: Option<String>,
}

impl AuthorizationRequest {
    /// The scopes this request asks for.
    ///
    /// Split on ASCII whitespace, dropping empties. A multi-valued parameter
    /// is not how OAuth conveys scopes, and accepting one as well would leave
    /// two parsers to keep in agreement.
    ///
    /// # Errors
    ///
    /// None.
    pub fn scopes(&self) -> Vec<String> {
        self.scope
            .split_ascii_whitespace()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Whether the request carries the mandatory `openid` scope.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn requests_openid(&self) -> bool {
        self.scopes()
            .iter()
            .any(|s| s == crate::discovery::DiscoveryDocument::REQUIRED_SCOPE)
    }

    /// Whether this request uses the PKCE method this provider advertises.
    ///
    /// # Errors
    ///
    /// None. An unsupported method is a refusal the endpoint performs, not an
    /// error this predicate raises.
    #[must_use]
    pub fn uses_supported_pkce(&self) -> bool {
        self.code_challenge_method == crate::SUPPORTED_CODE_CHALLENGE_METHOD
    }
}

/// A request to the token endpoint.
///
/// `grant_type` is the discriminator the endpoint switches on. It is kept as a
/// field rather than encoded as an enum tag, because the *error* for an
/// unsupported grant type is an OAuth error response, not a deserialization
/// failure — a client sending `grant_type=password` must get `501` and
/// `unsupported_grant_type`, not a 400 from a JSON parser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenRequest {
    /// `authorization_code` or `refresh_token`.
    pub grant_type: String,
    /// The authorization code, for the `authorization_code` grant.
    pub code: Option<String>,
    /// The redirect URI, which must equal the one in the authorization
    /// request. Re-sending it is not redundancy: it is the check that a code
    /// stolen from a log cannot be redeemed by a different client.
    pub redirect_uri: Option<String>,
    /// The client identifier, when the client is not authenticating with HTTP
    /// basic auth.
    pub client_id: Option<String>,
    /// The client secret, when the client is using `client_secret_post`. Not
    /// accepted for public clients.
    pub client_secret: Option<String>,
    /// The refresh token, for the `refresh_token` grant.
    pub refresh_token: Option<String>,
    /// The PKCE verifier, for the `authorization_code` grant.
    pub code_verifier: Option<String>,
    /// Requested scopes on a refresh. A refresh may narrow a grant and never
    /// widen one.
    pub scope: Option<String>,
}

impl TokenRequest {
    /// The grant type, as an enum.
    ///
    /// # Errors
    ///
    /// None. An unrecognised grant is [`GrantType::Unsupported`], and the
    /// endpoint turns that into the OAuth error response.
    #[must_use]
    pub fn grant(&self) -> GrantType {
        match self.grant_type.as_str() {
            "authorization_code" => GrantType::AuthorizationCode,
            "refresh_token" => GrantType::RefreshToken,
            _ => GrantType::Unsupported,
        }
    }

    /// The scopes this refresh requests.
    ///
    /// # Errors
    ///
    /// None.
    pub fn scopes(&self) -> Vec<String> {
        self.scope
            .as_deref()
            .unwrap_or_default()
            .split_ascii_whitespace()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }
}

/// The grant types this provider recognises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GrantType {
    /// The authorization code grant.
    AuthorizationCode,
    /// The refresh token grant.
    RefreshToken,
    /// Anything else, including the implicit and password grants.
    Unsupported,
}

/// A client identifier resolved to a registered application.
///
/// A distinct type from a bare `ApplicationId` so the resolved form cannot be
/// constructed by accident: a caller that has a `String` from a request must go
/// through the repository, and the type makes that step visible at the type
/// level rather than in a comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedClient {
    /// The application.
    pub application_id: ApplicationId,
    /// Whether the client presented a secret successfully. A public client is
    /// `false` by definition, not by failure.
    pub is_confidential: bool,
}

/// A request to the revocation endpoint (RFC 7009).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevocationRequest {
    /// The token to revoke.
    pub token: String,
    /// A hint about the token's type, since RFC 7009 tokens are opaque to the
    /// client.
    pub token_type_hint: Option<String>,
    /// The client identifier, when not authenticating with basic auth.
    pub client_id: Option<String>,
    /// The client secret, when using `client_secret_post`.
    pub client_secret: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AuthorizationRequest {
        AuthorizationRequest {
            client_id: "ecoma-console".into(),
            response_type: "code".into(),
            redirect_uri: "https://console.ecoma.io/callback".into(),
            scope: "openid profile email".into(),
            state: "st".into(),
            nonce: Some("no".into()),
            code_challenge: "chal".into(),
            code_challenge_method: "S256".into(),
            prompt: None,
            provider: None,
            login_hint: None,
        }
    }

    #[test]
    fn scopes_split_on_whitespace_and_drop_empties() {
        assert_eq!(request().scopes(), vec!["openid", "profile", "email"]);
        let mut r = request();
        r.scope = "  openid   profile  ".into();
        assert_eq!(r.scopes(), vec!["openid", "profile"]);
        r.scope = String::new();
        assert!(r.scopes().is_empty());
        assert!(!r.requests_openid());
    }

    #[test]
    fn a_request_without_the_openid_scope_does_not_ask_for_one() {
        let mut r = request();
        r.scope = "profile email".into();
        assert!(!r.requests_openid());
    }

    #[test]
    fn only_s256_is_accepted() {
        assert!(request().uses_supported_pkce());
        let mut r = request();
        r.code_challenge_method = "plain".into();
        assert!(!r.uses_supported_pkce());
        r.code_challenge_method = String::new();
        assert!(!r.uses_supported_pkce());
    }

    #[test]
    fn an_unsupported_grant_is_a_value_not_a_deserialization_error() {
        // A client sending `grant_type=password` must receive an OAuth error
        // response, not a parse failure — the difference matters to a
        // conformance suite and to any client that can only handle OAuth
        // errors.
        let r = TokenRequest {
            grant_type: "password".into(),
            code: None,
            redirect_uri: None,
            client_id: None,
            client_secret: None,
            refresh_token: None,
            code_verifier: None,
            scope: None,
        };
        assert_eq!(r.grant(), GrantType::Unsupported);
    }

    #[test]
    fn a_refresh_may_narrow_its_scopes() {
        let r = TokenRequest {
            grant_type: "refresh_token".into(),
            code: None,
            redirect_uri: None,
            client_id: None,
            client_secret: None,
            refresh_token: Some("rt".into()),
            code_verifier: None,
            scope: Some("openid email".into()),
        };
        assert_eq!(r.scopes(), vec!["openid", "email"]);
    }

    #[test]
    fn a_request_with_no_scope_parses_to_an_empty_list() {
        let r = TokenRequest {
            grant_type: "refresh_token".into(),
            code: None,
            redirect_uri: None,
            client_id: None,
            client_secret: None,
            refresh_token: Some("rt".into()),
            code_verifier: None,
            scope: None,
        };
        assert!(r.scopes().is_empty());
    }
}
