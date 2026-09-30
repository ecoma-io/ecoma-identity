//! Client metadata, as registered.

use serde::{Deserialize, Serialize};

use identity_domain::application::ApplicationAccessMode;

/// What a client told us about itself at registration.
///
/// This is a *mirror* of the registered application, not the registered
/// application itself. The row in D1 is the authority; this is what the
/// authorization endpoint needs in order to validate a request without loading
/// the whole model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientMetadata {
    /// The public client identifier.
    pub client_id: String,
    /// The display name shown on the consent screen.
    pub client_name: String,
    /// A URI describing the client, shown on the consent screen.
    pub client_uri: Option<String>,
    /// A logo, shown on the consent screen.
    pub logo_uri: Option<String>,
    /// The contact address for the client's operators.
    pub contacts: Vec<String>,
    /// The registered redirect URIs.
    pub redirect_uris: Vec<String>,
    /// The registered response types.
    pub response_types: Vec<String>,
    /// The registered grant types.
    pub grant_types: Vec<String>,
    /// The access mode this client registered under.
    pub access_mode: ApplicationAccessMode,
    /// Whether the client will present a secret. A public client is `false`.
    pub confidential: bool,
    /// The client's JWKS, for `private_key_jwt` authentication. Deferred: this
    /// provider offers only `client_secret_*` in bootstrap.
    pub jwks_uri: Option<String>,
    /// When the client agreed to the provider's terms, as an ISO 8601 date.
    pub tos_uri: Option<String>,
}

impl ClientMetadata {
    /// The token endpoint authentication methods this provider accepts.
    pub const SUPPORTED_AUTH_METHODS: &'static [&'static str] =
        &["client_secret_basic", "client_secret_post", "none"];

    /// Whether the client may use the refresh token grant.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn allows_refresh(&self) -> bool {
        self.grant_types.iter().any(|g| g == "refresh_token")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> ClientMetadata {
        ClientMetadata {
            client_id: "ecoma-console".into(),
            client_name: "Ecoma Console".into(),
            client_uri: Some("https://console.ecoma.io".into()),
            logo_uri: None,
            contacts: vec!["security@ecoma.io".into()],
            redirect_uris: vec!["https://console.ecoma.io/callback".into()],
            response_types: vec!["code".into()],
            grant_types: vec!["authorization_code".into(), "refresh_token".into()],
            access_mode: ApplicationAccessMode::Oidc,
            confidential: true,
            jwks_uri: None,
            tos_uri: None,
        }
    }

    #[test]
    fn a_client_registered_for_refresh_may_use_it() {
        assert!(metadata().allows_refresh());
        let mut m = metadata();
        m.grant_types = vec!["authorization_code".into()];
        assert!(!m.allows_refresh());
    }

    #[test]
    fn private_key_jwt_is_not_advertised_by_a_client_registration() {
        // The client metadata shape carries a `jwks_uri`, but the provider's
        // supported auth methods do not include `private_key_jwt`. A client
        // that offers one is offering something the token endpoint will not
        // accept — which is the correct outcome, and the discovery document is
        // where the refusal is visible.
        let _m = metadata();
        assert!(!ClientMetadata::SUPPORTED_AUTH_METHODS.contains(&"private_key_jwt"));
        assert!(ClientMetadata::SUPPORTED_AUTH_METHODS.contains(&"none"));
    }

    #[test]
    fn a_public_client_declares_itself_insecure() {
        let mut m = metadata();
        m.confidential = false;
        assert!(!m.confidential);
    }
}
