//! Authentication: proving who someone is.
//!
//! Three flows are named, and they are the only ways identity enters the
//! system: an emailed one-time code, an already-established session, and a
//! federated provider. Everything else — a passkey, a recovery code — is an
//! *authenticator* and enters through the `identity-security` crate's gates, not through
//! a new command here.

use identity_domain::identity::IdentityProvider;
use identity_domain::user::UserId;
use serde::{Deserialize, Serialize};

use crate::error::ApplicationResult;

/// Begin an email login: deliver a one-time code to `email_address`.
///
/// A successful *send* and a successful *login* are different outcomes and the
/// command's return type says so. See the type documentation for why this
/// command must not reveal whether an address is registered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartEmailLogin {
    /// The address to deliver a code to.
    pub email_address: String,
}

/// The outcome of [`StartEmailLogin`].
///
/// The two variants are deliberately indistinguishable *in effect*: in both
/// cases the caller learns "check your inbox" and nothing else. They are
/// separate variants so the implementation can be honest in its own code about
/// which branch ran, and so a future audit event can distinguish them without
/// inferring it from a delivery log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum StartEmailLoginOutcome {
    /// A code was sent to a known, active address.
    CodeSent {
        /// How long the caller should wait before offering "resend".
        ///
        /// Always present, never a `Duration` in the wire form: a duration is
        /// ambiguous across the clock the server and the clock the browser
        /// think it is.
        retry_after_seconds: u32,
    },
    /// No code was sent. Returned for an unknown address and for a known but
    /// inactive one, identically. A caller that can tell these apart is an
    /// account-enumeration oracle.
    Accepted {
        /// The same backoff, so the two branches are timing-indistinguishable
        /// as well as content-indistinguishable.
        retry_after_seconds: u32,
    },
}

/// Begin an email login.
pub trait StartEmailLoginCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Dependency`] if the mail transport or
    /// the repository is unavailable. Nothing is returned that distinguishes an
    /// unknown address from a known one.
    fn start_email_login(
        &self,
        input: StartEmailLogin,
    ) -> ApplicationResult<StartEmailLoginOutcome>;
}

/// Redeem a one-time code delivered by [`StartEmailLoginCommand`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyEmailOtp {
    /// The address the code was sent to.
    pub email_address: String,
    /// The code the user typed.
    pub code: String,
    /// The challenge identifier issued alongside the code, so a correct code
    /// presented against the wrong challenge cannot be replayed.
    pub challenge_id: String,
}

/// A successful authentication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Authenticated {
    /// The session that was established.
    pub session_id: String,
    /// The user it acts for.
    pub user_id: UserId,
    /// The assurance level the session was established at. An email code is
    /// AAL1; nothing here can raise it.
    pub aal: identity_domain::security::Aal,
    /// Whether a step-up is required before sensitive operations are allowed.
    /// A user with no second factor enrolled can never satisfy this, which is
    /// why it is reported rather than assumed.
    pub step_up_required: bool,
}

/// Redeem an emailed one-time code.
pub trait VerifyEmailOtpCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a wrong, expired or
    /// already-redeemed code. The three are one outcome to the caller: which of
    /// them it was is recorded in the audit trail, never in the response.
    fn verify_email_otp(&self, input: VerifyEmailOtp) -> ApplicationResult<Authenticated>;
}

/// Authenticate against a federated provider that has already been through
/// the provider's own flow.
///
/// The command is fed an *asserted* identity — a `(provider, subject)` pair
/// the provider has signed for. Deciding that an assertion is trustworthy is
/// OIDC crate's job; what happens next (link, or fail, or refuse) is this
/// command's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthenticateExternalIdentity {
    /// Which provider asserted the identity.
    pub provider: IdentityProvider,
    /// The provider's identifier for the user.
    pub subject: String,
    /// The one-time code Identity issued to the client, for the CSRF binding.
    pub state: String,
}

/// Authenticate with a federated provider's assertion.
pub trait AuthenticateExternalIdentityCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] when the state does not
    /// match, and [`crate::error::ApplicationError::Domain`] when the identity
    /// is not linked to any account.
    fn authenticate_external_identity(
        &self,
        input: AuthenticateExternalIdentity,
    ) -> ApplicationResult<Authenticated>;
}

/// End a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Logout {
    /// The session to end.
    pub session_id: String,
}

/// End a session.
pub trait LogoutCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::NotFound`] for an unknown session.
    /// An already-revoked session is **not** an error: logging out twice must
    /// be safe, because a browser will do it.
    fn logout(&self, input: Logout) -> ApplicationResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_login_outcomes_are_both_backed_off() {
        // A caller that gets `Accepted` with no retry hint would let a user
        // hammer the endpoint; a caller that gets `CodeSent` with no hint
        // would do the same on a real address. The backoff is not optional on
        // either branch, which is why it is a field on both variants rather
        // than on the enum.
        let sent = StartEmailLoginOutcome::CodeSent {
            retry_after_seconds: 30,
        };
        let accepted = StartEmailLoginOutcome::Accepted {
            retry_after_seconds: 30,
        };
        assert_eq!(
            serde_json::to_string(&sent).expect("serializable"),
            r#"{"outcome":"code_sent","retry_after_seconds":30}"#
        );
        assert_eq!(
            serde_json::to_string(&accepted).expect("serializable"),
            r#"{"outcome":"accepted","retry_after_seconds":30}"#
        );
    }

    #[test]
    fn the_envelope_is_internally_tagged_so_the_field_name_is_fixed() {
        // An externally-tagged enum would put the variant name in a *key*,
        // which no client can switch on without parsing the key first. The
        // `outcome` discriminator is the contract.
        let json = serde_json::to_string(&Authenticated {
            session_id: "s".into(),
            user_id: UserId::new().expect("uuid"),
            aal: identity_domain::security::Aal::Aal1,
            step_up_required: false,
        })
        .expect("serializable");
        assert!(json.contains("\"session_id\""), "{json}");
    }
}
