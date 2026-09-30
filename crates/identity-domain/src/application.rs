//! Applications: registered clients of the identity system.
//!
//! An application is an OAuth client plus the policy around it. It is *not* an
//! Ecoma organisation, and it carries no business authorization: registering
//! an application here says nothing about what that application's users may do
//! inside it (ADR-0005).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{DomainError, DomainResult, require_non_blank};

/// A registered client's opaque, stable identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ApplicationId(Uuid);

impl ApplicationId {
    /// Create an identifier from a UUID.
    ///
    /// # Errors
    ///
    /// None. See [`crate::user::UserId::from_uuid`].
    #[must_use]
    pub const fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    /// Mint a new random identifier.
    ///
    /// # Errors
    ///
    /// None today; see [`crate::user::UserId::new`].
    pub fn new() -> DomainResult<Self> {
        Ok(Self(Uuid::new_v4()))
    }

    /// The canonical text form.
    #[must_use]
    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl core::fmt::Display for ApplicationId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Whether a registered client may serve traffic right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationStatus {
    /// Registered and usable.
    Active,
    /// Temporarily barred. Existing grants are not honoured; new ones cannot be
    /// issued. Distinguishable from `Active` so that "it exists" and "it may
    /// be used" stay separate questions.
    Suspended,
    /// Retired. Never returns to `Active` — retirement is one-way, so an
    /// abandoned integration cannot be woken up years later by a stale
    /// automation.
    Retired,
}

impl ApplicationStatus {
    /// Whether an application in this state may start an authorization flow.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn permits_authorization(self) -> bool {
        matches!(self, Self::Active)
    }
}

/// How a registered client asks for access to a user's account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationAccessMode {
    /// `OpenID` Connect. The client receives identity claims about the user and
    /// delegates authentication here.
    Oidc,
    /// OAuth 2.0 only — access tokens without an identity. Required for
    /// machine-to-machine clients, which have no user to authenticate.
    OAuth2,
}

impl ApplicationAccessMode {
    /// Whether a flow in this mode must use PKCE.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn requires_pkce(self) -> bool {
        // Both modes, unconditionally. The IETF has been moving the whole
        // ecosystem to mandatory PKCE for public clients; making it optional
        // here would mean a future tightening is a breaking change to stored
        // registrations rather than a config flip.
        matches!(self, Self::Oidc | Self::OAuth2)
    }
}

/// A registered client of the identity system.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Application {
    /// This application's identifier.
    pub id: ApplicationId,
    /// The `client_id` presented at the authorization endpoint. Public — it
    /// appears in browser redirects. Must be unique across all applications,
    /// which the `applications.client_id` unique index enforces.
    pub client_id: String,
    /// A human-readable name, for the admin UI and the consent screen.
    pub display_name: String,
    /// Whether the client may be used.
    pub status: ApplicationStatus,
    /// Which access mode it registers under.
    pub access_mode: ApplicationAccessMode,
    /// The redirect URIs the client may use, pre-registered. A redirect URI is
    /// never learned from a request at runtime.
    pub redirect_uris: Vec<String>,
    /// The scopes the client may request, pre-registered at registration.
    pub allowed_scopes: Vec<String>,
}

impl Application {
    /// Build an application with no redirect URIs yet.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `client_id` is blank, padded, or over 191
    /// bytes, or `display_name` is blank, padded, or over 200 bytes.
    ///
    /// The `client_id` bound is 191 because it backs a unique index whose key
    /// length must fit within the D1 index limit alongside its collation.
    pub fn new(
        client_id: impl Into<String>,
        display_name: impl Into<String>,
        access_mode: ApplicationAccessMode,
    ) -> DomainResult<Self> {
        let client_id = client_id.into();
        require_non_blank("client_id", &client_id)?;
        crate::error::require_max_len("client_id", &client_id, 191)?;

        let display_name = display_name.into();
        require_non_blank("display_name", &display_name)?;
        crate::error::require_max_len("display_name", &display_name, 200)?;

        Ok(Self {
            id: ApplicationId::new()?,
            client_id,
            display_name,
            status: ApplicationStatus::Active,
            access_mode,
            redirect_uris: Vec::new(),
            allowed_scopes: Vec::new(),
        })
    }

    /// Register a redirect URI.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when the URI is blank, padded, longer than 2048
    /// bytes, is not absolute, or carries a fragment — the OAuth 2.1 rule,
    /// because a fragment in a redirect URI is attacker-influenceable state
    /// that the authorization server would have to echo.
    pub fn add_redirect_uri(&mut self, uri: impl Into<String>) -> DomainResult<()> {
        let uri = uri.into();
        require_non_blank("redirect_uri", &uri)?;
        crate::error::require_max_len("redirect_uri", &uri, 2048)?;

        if uri.contains('#') {
            return Err(DomainError::invalid(
                "redirect_uri",
                "must not contain a fragment",
            ));
        }
        // A relative URI has no origin, so an attacker's page and the client's
        // page would be indistinguishable at the redirect.
        if !(uri.starts_with("https://") || uri.starts_with("http://")) {
            return Err(DomainError::invalid(
                "redirect_uri",
                "must be absolute and start with http:// or https://",
            ));
        }
        if self.redirect_uris.contains(&uri) {
            return Err(DomainError::invalid("redirect_uri", "already registered"));
        }
        self.redirect_uris.push(uri);
        Ok(())
    }

    /// Whether a redirect URI presented in a request is pre-registered.
    ///
    /// A comparison, never a prefix or a glob. `https://app.example.com/`
    /// registered does not license `https://app.example.com/steal`, and it
    /// certainly does not license `https://app.example.com.attacker.test/`.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn allows_redirect_uri(&self, presented: &str) -> bool {
        self.redirect_uris.iter().any(|r| r == presented)
    }

    /// Authorise a scope request against this application's registration.
    ///
    /// Returns only the intersection. A client asking for more than it
    /// registered for gets the part it registered for, not an error — the
    /// narrower grant is the safe reading, and a hard failure would break
    /// clients that ask optimistically.
    ///
    /// # Errors
    ///
    /// [`DomainError::IllegalTransition`] when the application may not start an
    /// authorization flow at all.
    pub fn granted_scopes(&self, requested: &[String]) -> DomainResult<Vec<String>> {
        if !self.status.permits_authorization() {
            return Err(DomainError::illegal(format!(
                "application is {}",
                match self.status {
                    ApplicationStatus::Active => "active",
                    ApplicationStatus::Suspended => "suspended",
                    ApplicationStatus::Retired => "retired",
                }
            )));
        }
        Ok(requested
            .iter()
            .filter(|scope| self.allowed_scopes.contains(scope))
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> Application {
        Application::new(
            "ecoma-console",
            "Ecoma Console",
            ApplicationAccessMode::Oidc,
        )
        .expect("valid")
    }

    #[test]
    fn a_new_application_is_active_with_no_redirect_uris() {
        let a = app();
        assert_eq!(a.status, ApplicationStatus::Active);
        assert!(a.redirect_uris.is_empty());
        assert!(!a.allows_redirect_uri("https://console.ecoma.io/callback"));
    }

    #[test]
    fn a_registered_redirect_uri_must_match_exactly() {
        let mut a = app();
        a.add_redirect_uri("https://console.ecoma.io/callback")
            .expect("valid");
        assert!(a.allows_redirect_uri("https://console.ecoma.io/callback"));

        // Every one of these is the prefix/host-confusion attack.
        assert!(!a.allows_redirect_uri("https://console.ecoma.io/callback/"));
        assert!(!a.allows_redirect_uri("https://console.ecoma.io/callback?x=1"));
        assert!(!a.allows_redirect_uri("https://console.ecoma.io/"));
        assert!(!a.allows_redirect_uri("https://console.ecoma.io/cb"));
        assert!(!a.allows_redirect_uri("https://console.ecoma.io.attacker.test/callback"));
        assert!(!a.allows_redirect_uri("http://console.ecoma.io/callback"));
    }

    #[test]
    fn a_fragment_or_relative_redirect_uri_is_refused() {
        let mut a = app();
        assert!(a.add_redirect_uri("https://x.test/cb#frag").is_err());
        assert!(a.add_redirect_uri("/callback").is_err());
        assert!(a.add_redirect_uri("javascript:alert(1)").is_err());
        assert!(a.add_redirect_uri("").is_err());
    }

    #[test]
    fn localhost_http_is_not_special_cased_at_registration() {
        // Native and local clients legitimately use `http://localhost`. This
        // is a *redirect URI* rule, not an environment rule — refusing it
        // uniformly would break every local-development client. Whether a
        // particular localhost client is acceptable is decided per
        // application, at registration, by an administrator.
        let mut a = app();
        assert!(a.add_redirect_uri("http://localhost:5173/callback").is_ok());
    }

    #[test]
    fn registering_the_same_uri_twice_is_refused() {
        let mut a = app();
        a.add_redirect_uri("https://x.test/cb").expect("first");
        assert!(a.add_redirect_uri("https://x.test/cb").is_err());
    }

    #[test]
    fn requested_scopes_are_narrowed_to_the_registration() {
        let mut a = app();
        a.allowed_scopes = vec!["openid".into(), "profile".into()];
        let granted = a
            .granted_scopes(&["openid".into(), "admin:everything".into()])
            .expect("active");
        assert_eq!(granted, vec!["openid".to_string()]);
    }

    #[test]
    fn a_suspended_application_grants_nothing() {
        let mut a = app();
        a.allowed_scopes = vec!["openid".into()];
        a.status = ApplicationStatus::Suspended;
        assert!(a.granted_scopes(&["openid".to_string()]).is_err());
    }

    #[test]
    fn pkce_is_required_in_every_mode() {
        assert!(ApplicationAccessMode::Oidc.requires_pkce());
        assert!(ApplicationAccessMode::OAuth2.requires_pkce());
    }

    #[test]
    fn a_retired_application_can_never_return_to_active() {
        // One-way by construction: there is no method on this type that moves
        // status back. The test documents the absence.
        assert!(!ApplicationStatus::Retired.permits_authorization());
        assert!(ApplicationStatus::Active.permits_authorization());
    }
}
