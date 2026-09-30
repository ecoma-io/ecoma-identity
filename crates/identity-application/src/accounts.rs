//! Accounts: the self-service surface a signed-in user sees.
//!
//! Everything here acts on the caller's own account. Nothing here takes an
//! actor — an operation that changes *someone else's* account is
//! [`crate::administration`], and the absence of an actor field in these
//! types is what makes "self-service" mechanical rather than a convention.

use identity_domain::user::UserId;
use serde::{Deserialize, Serialize};

use crate::error::ApplicationResult;

/// An account, as the user sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    /// The account's identifier.
    pub user_id: UserId,
    /// The display name.
    pub display_name: String,
    /// The platform role. Shown, not editable, here.
    pub role: identity_domain::user::PlatformRole,
    /// The verified addresses on the account.
    pub emails: Vec<AccountEmail>,
    /// The external identities linked to the account.
    pub identities: Vec<AccountIdentity>,
    /// How strongly this session is currently authenticated.
    pub aal: identity_domain::security::Aal,
    /// Whether sensitive operations will demand a step-up first.
    pub step_up_required: bool,
}

/// An email address on an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountEmail {
    /// The address.
    pub address: String,
    /// Whether it has been proven.
    pub verified: bool,
    /// Whether it is the account's sign-in address. Exactly one per account;
    /// enforced by a partial unique index, not by this type.
    pub primary: bool,
}

/// A linked external identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountIdentity {
    /// Which provider asserted it.
    pub provider: identity_domain::identity::IdentityProvider,
    /// The provider's identifier for the user. Present in the user's own view
    /// of their own account, and absent from every administrative view of it.
    pub subject: String,
    /// The user-chosen label.
    pub label: Option<String>,
}

/// Read the caller's account.
pub trait GetAccountQuery {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::NotFound`] when the session's user
    /// does not exist — which means the session outlived its user, and the
    /// correct response is to refuse the request rather than to serve a
    /// half-account.
    fn get_account(&self) -> ApplicationResult<AccountView>;
}

/// Change the caller's display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateProfile {
    /// The new display name. Bounded by `identity-domain`'s `User::new`.
    pub display_name: String,
}

/// Change the caller's display name.
pub trait UpdateProfileCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Domain`] for a blank or oversized
    /// name.
    fn update_profile(&self, input: UpdateProfile) -> ApplicationResult<AccountView>;
}

/// Begin adding an email address to the caller's account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEmail {
    /// The address to add.
    pub email_address: String,
    /// Set the newly verified address as the account's sign-in address.
    pub make_primary: bool,
}

/// The outcome of [`ChangeEmail`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEmailOutcome {
    /// The challenge the verification code was delivered under.
    pub challenge_id: String,
    /// How long to wait before offering a resend.
    pub retry_after_seconds: u32,
}

/// Begin adding an email address.
pub trait ChangeEmailCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Domain`] for a malformed address or
    /// one already on the account.
    fn change_email(&self, input: ChangeEmail) -> ApplicationResult<ChangeEmailOutcome>;
}

/// Link an external identity to the caller's account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkIdentity {
    /// Which provider asserted it.
    pub provider: identity_domain::identity::IdentityProvider,
    /// The provider's identifier for the user.
    pub subject: String,
    /// The one-time state that binds the provider's callback to this session.
    pub state: String,
}

/// Link an external identity.
pub trait LinkIdentityCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Domain`] when `(provider, subject)`
    /// is already linked to **another** account. This is the account-takeover
    /// shape the "user subject cannot be reused" invariant names, and the
    /// refusal must be explicit — silently no-op'ing would leave the user
    /// believing a link exists that does not.
    fn link_identity(&self, input: LinkIdentity) -> ApplicationResult<AccountView>;
}

/// Unlink an external identity from the caller's account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlinkIdentity {
    /// The identity's identifier.
    pub identity_id: String,
}

/// Unlink an external identity.
pub trait UnlinkIdentityCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Domain`] when the account has no
    /// other way to sign in, or when the session is not at AAL2. Unlinking the
    /// last sign-in method of an account is a self-lockout, and the refusal is
    /// the only thing standing between a compromised session and an
    /// unreachable account.
    fn unlink_identity(&self, input: UnlinkIdentity) -> ApplicationResult<AccountView>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_account_command_carries_an_actor() {
        // The type-level expression of "self-service": there is nowhere to put
        // "as whom". If a future field like `actor_id` appears on one of these
        // structs, that command has become an administrative one and belongs
        // in `crate::administration` — a boundary the compiler cannot check,
        // so this test stands in for it.
        let inputs: Vec<serde_json::Value> = vec![
            serde_json::to_value(UpdateProfile {
                display_name: "x".into(),
            })
            .expect("serializable"),
            serde_json::to_value(ChangeEmail {
                email_address: "a@example.com".into(),
                make_primary: true,
            })
            .expect("serializable"),
            serde_json::to_value(LinkIdentity {
                provider: identity_domain::identity::IdentityProvider::OAuth,
                subject: "s".into(),
                state: "st".into(),
            })
            .expect("serializable"),
            serde_json::to_value(UnlinkIdentity {
                identity_id: "i".into(),
            })
            .expect("serializable"),
        ];
        for input in inputs {
            let object = input.as_object().expect("an object");
            for forbidden in ["actor_id", "actor", "as_user", "admin"] {
                assert!(
                    !object.contains_key(forbidden),
                    "{forbidden} has no place in a self-service command"
                );
            }
        }
    }

    #[test]
    fn an_account_view_does_not_carry_another_users_secrets() {
        let view = AccountView {
            user_id: UserId::new().expect("uuid"),
            display_name: "Ada".into(),
            role: identity_domain::user::PlatformRole::Member,
            emails: vec![],
            identities: vec![],
            aal: identity_domain::security::Aal::Aal1,
            step_up_required: false,
        };
        let json = serde_json::to_string(&view).expect("serializable");
        for forbidden in ["password", "secret", "token", "security_version"] {
            assert!(!json.contains(forbidden), "{forbidden} must not be exposed: {json}");
        }
    }
}
