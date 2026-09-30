//! Sessions: listing and revoking the caller's own sessions.
//!
//! The user-facing surface of session management. Note the naming discipline
//! across the whole layer: `revoke_all_sessions` is the *user* asking to sign
//! out everywhere. The administrator's version of the same action is
//! `crate::administration::RevokeUserSessions`, and the two are separate types
//! on purpose — a confused deputy that let a user pass a `user_id` to the
//! self-service command would be an account-takeover primitive.

use identity_domain::session::SessionId;
use identity_domain::user::UserId;
use serde::{Deserialize, Serialize};

use crate::error::ApplicationResult;

/// A session, as the user sees it in their own list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionView {
    /// The session's identifier.
    pub session_id: SessionId,
    /// When it was created, as milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// When it expires, as milliseconds since the Unix epoch.
    pub expires_at_ms: i64,
    /// The assurance level it was established at.
    pub aal: identity_domain::security::Aal,
    /// A coarse label for where it came from. Never a user-agent string stored
    /// verbatim: it is displayed in a list an account-takeover attacker will
    /// be reading, and an unescaped user-agent is a stored-XSS vector.
    pub label: Option<String>,
    /// Whether this session is the one making the request. The current
    /// session is marked so the UI can offer "this device" separately.
    pub current: bool,
}

/// List the caller's sessions.
pub trait ListSessionsQuery {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Dependency`] if the session
    /// repository is unavailable.
    fn list_sessions(&self) -> ApplicationResult<Vec<SessionView>>;
}

/// Revoke one of the caller's own sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevokeSession {
    /// The session to revoke.
    pub session_id: SessionId,
}

/// Revoke one of the caller's own sessions.
pub trait RevokeSessionCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::NotFound`] when the session is not
    /// the caller's. "Not found" rather than "forbidden": confirming that
    /// someone else's session *exists* is itself a disclosure.
    fn revoke_session(&self, input: RevokeSession) -> ApplicationResult<()>;
}

/// Revoke every session belonging to the caller, including the current one.
///
/// There is no `user_id` field. That absence is the boundary.
///
/// It is a unit struct rather than an empty braced one so that the absence is
/// enforced two ways over. A field cannot be *added* to a unit struct without
/// changing the type, and `RevokeAllSessions {}` — the empty-struct
/// construction syntax — does not compile at all. A braced empty struct would
/// be one careless `pub user_id: UserId,` away from a confused deputy, and it
/// would still look deliberate in review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RevokeAllSessions;

/// Revoke every session belonging to the caller.
pub trait RevokeAllSessionsCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Dependency`] if the session
    /// repository is unavailable. Partial failure must not be reported as
    /// success: a caller who sees success believes they are signed out
    /// everywhere.
    fn revoke_all_sessions(&self, input: RevokeAllSessions) -> ApplicationResult<()>;
}

/// A user's session count and last-activity summary, for the admin surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserSessionSummary {
    /// The user.
    pub user_id: UserId,
    /// How many sessions are currently live.
    pub active_sessions: u32,
    /// When the most recent session was created, as milliseconds since the Unix
    /// epoch. `None` when the user has never signed in.
    pub last_session_at_ms: Option<i64>,
}

/// Read a user's session summary.
///
/// This is a *query*, not a command, and it takes a `user_id` because the
/// administrative surface is a different boundary. It lives here rather than
/// in `crate::administration` because it is a read of session state, and
/// putting session reads in two places is how a `security_version` check gets
/// forgotten on one path.
pub trait GetUserSessionsQuery {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::NotFound`] for an unknown user.
    fn get_user_sessions(&self, user_id: UserId) -> ApplicationResult<UserSessionSummary>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoke_all_sessions_names_no_user() {
        // Two independent structural checks, because they fail differently.
        //
        // The unit struct is the strong one: `RevokeAllSessions { user_id }`
        // does not compile, and `RevokeAllSessions {}` does not either. The
        // serialized shape is the observable one — if this command is ever
        // accepted over HTTP, an empty request body is what must be enough,
        // and a `user_id` in that body is what must become an "unexpected
        // field" rejection rather than a target selection.
        let json = serde_json::to_value(RevokeAllSessions).expect("serializable");
        assert!(
            json.as_object().is_none_or(serde_json::Map::is_empty),
            "RevokeAllSessions must carry no fields, serialized or not, got {json}"
        );

        // And the deserialiser refuses a body that names a user, rather than
        // ignoring the field and revoking the caller's own sessions — which
        // would be a silent, successful, wrong action.
        let refused = serde_json::from_value::<RevokeAllSessions>(
            serde_json::json!({ "user_id": "00000000-0000-4000-8000-000000000000" }),
        );
        assert!(
            refused.is_err(),
            "a body naming a user must be refused, not ignored"
        );
    }

    #[test]
    fn a_session_view_exposes_no_secret_material() {
        let view = SessionView {
            session_id: SessionId::new().expect("uuid"),
            created_at_ms: 1,
            expires_at_ms: 2,
            aal: identity_domain::security::Aal::Aal1,
            label: Some("Chrome on Linux".into()),
            current: true,
        };
        let json = serde_json::to_string(&view).expect("serializable");
        // The id is a handle, not a credential; what must not be here is
        // anything that would let a reader *become* this session.
        for forbidden in ["secret", "token", "hash", "cookie", "security_version"] {
            assert!(!json.contains(forbidden), "{forbidden} leaked: {json}");
        }
    }
}
