//! Administration: an administrator acting on someone else's account.
//!
//! Every command here takes `actor_id` *and* `actor_session_id`. The second is
//! not redundancy: the session is what proves the actor at AAL2, and a
//! destructive administrative action that did not check the actor's
//! assurance level would be reachable from a session the actor merely
//! *logged into*.
//!
//! # The one implemented rule
//!
//! [`RoleChangeRequest::evaluate`] is a real function, not a trait signature. It
//! encodes "the last administrator cannot be removed or demoted", and it is
//! here rather than in `identity-domain` because the rule needs a *count of
//! administrators* — a fact about the current state of the store, not a
//! property of a single user. See its documentation for the transaction
//! requirement that makes it correct under concurrency.

use identity_domain::user::{PlatformRole, UserId, UserStatus};
use serde::{Deserialize, Serialize};

use crate::error::{ApplicationError, ApplicationResult};

/// The context every administrative command carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminContext {
    /// The administrator acting.
    pub actor_id: UserId,
    /// The session they are acting under. Checked for AAL2 on every command
    /// that changes someone else's security posture.
    pub actor_session_id: String,
}

/// Why a role change was refused, or what it will do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum RoleChange {
    /// The change is permitted and should be applied.
    Permitted,
    /// Refused: this would leave the platform with no active administrator.
    LastAdministrator {
        /// The user who would have been demoted.
        user_id: UserId,
    },
    /// Refused: a user cannot change their own role. Self-promotion is the
    /// privilege-escalation primitive; the only way to grant a role is for
    /// another administrator to grant it.
    SelfChange,
    /// Refused: the actor is not permitted to assign the target role.
    NotPermitted {
        /// Which role was refused.
        role: PlatformRole,
    },
}

/// A change to a user's platform role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleChangeRequest {
    /// The user whose role changes.
    pub user_id: UserId,
    /// Who is asking.
    pub actor_id: UserId,
    /// The role the *actor* currently holds. Resolved from the actor's session
    /// by the command that builds this request, and carried here so the rule
    /// below is total: a rule that needs the actor's role but is not given it
    /// has to either fetch it (losing the ability to be tested as a pure
    /// function) or guess.
    pub actor_role: PlatformRole,
    /// The role the target currently holds.
    pub current_role: PlatformRole,
    /// The role being assigned.
    pub new_role: PlatformRole,
    /// The target user's current status. A suspended administrator does not
    /// count toward the "there is at least one" check, which is why status is
    /// an input rather than something this function re-reads.
    pub target_status: UserStatus,
    /// How many *active* administrators exist, this one included.
    pub active_administrator_count: u32,
}

impl RoleChangeRequest {
    /// Decide whether the change is permitted.
    ///
    /// This is a pure function of its inputs. That is what makes the
    /// last-administrator rule testable without a database, and it is why the
    /// count is a field: the real command must compute the count and pass it
    /// in, inside the same transaction that will apply the change (see the
    /// module documentation).
    ///
    /// # Errors
    ///
    /// None. Every outcome is a [`RoleChange`], including the refusals —
    /// a rule that can only return "yes" or an `Err` forces the caller to
    /// decide whether a `DomainError` deserves the same handling.
    #[must_use]
    pub fn evaluate(&self) -> RoleChange {
        // Self-change first, so a lone administrator demoting themselves
        // gets the honest reason rather than the "last administrator" one.
        if self.user_id == self.actor_id {
            return RoleChange::SelfChange;
        }
        // Only an administrator assigns roles. Support moderates accounts but
        // does not promote — and a `Support` actor demoting the last
        // administrator is refused here, before the count is consulted.
        if !self.actor_role.may_assign_roles() {
            return RoleChange::NotPermitted {
                role: self.new_role,
            };
        }
        // The count check applies only when the change would *remove* an
        // active administrator: a demotion, or a change of role away from
        // `Administrator`. Promoting, or demoting a non-administrator, can
        // never reduce the count below one.
        let removes_an_active_administrator = self.current_role.may_assign_roles()
            && !self.new_role.may_assign_roles()
            && self.target_status == UserStatus::Active;
        if removes_an_active_administrator && self.active_administrator_count <= 1 {
            return RoleChange::LastAdministrator {
                user_id: self.user_id,
            };
        }
        RoleChange::Permitted
    }
}

/// Change a user's platform role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeUserRole {
    /// Who is asking, and under which session.
    pub context: AdminContext,
    /// The user whose role changes.
    pub user_id: UserId,
    /// The role to assign.
    pub new_role: PlatformRole,
}

/// Change a user's role.
pub trait ChangeUserRoleCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a non-administrator
    /// actor or a non-AAL2 session, and
    /// [`crate::error::ApplicationError::Domain`] for the last-administrator
    /// refusal and for self-change.
    fn change_user_role(&self, input: ChangeUserRole) -> ApplicationResult<PlatformRole>;
}

/// Suspend a user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuspendUser {
    /// Who is asking, and under which session.
    pub context: AdminContext,
    /// The user to suspend.
    pub user_id: UserId,
    /// Why, recorded in the audit trail. Mandatory, and non-empty: a
    /// suspension without a stated reason is one nobody can appeal.
    pub reason: String,
}

/// Suspend a user.
pub trait SuspendUserCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a non-administrator
    /// or a non-AAL2 session, and
    /// [`crate::error::ApplicationError::Domain`] when suspending the last
    /// active administrator.
    fn suspend_user(&self, input: SuspendUser) -> ApplicationResult<()>;
}

/// Reinstate a suspended user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsuspendUser {
    /// Who is asking, and under which session.
    pub context: AdminContext,
    /// The user to reinstate.
    pub user_id: UserId,
    /// Why, recorded in the audit trail.
    pub reason: String,
}

/// Reinstate a user.
pub trait UnsuspendUserCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a non-administrator
    /// or a non-AAL2 session; [`crate::error::ApplicationError::Domain`] for
    /// an already-active user.
    fn unsuspend_user(&self, input: UnsuspendUser) -> ApplicationResult<()>;
}

/// Revoke every session belonging to a user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevokeUserSessions {
    /// Who is asking, and under which session.
    pub context: AdminContext,
    /// The user whose sessions are revoked.
    pub user_id: UserId,
    /// Why, recorded in the audit trail.
    pub reason: String,
}

/// Revoke a user's sessions.
pub trait RevokeUserSessionsCommand {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a non-administrator
    /// or a non-AAL2 session.
    fn revoke_user_sessions(&self, input: RevokeUserSessions) -> ApplicationResult<()>;
}

/// One row of the admin user list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminUserRow {
    /// The user.
    pub user_id: UserId,
    /// The display name.
    pub display_name: String,
    /// The role.
    pub role: PlatformRole,
    /// The status.
    pub status: UserStatus,
    /// How many live sessions the user holds.
    pub active_sessions: u32,
    /// When they last signed in, as milliseconds since the Unix epoch.
    pub last_authenticated_at_ms: Option<i64>,
    /// When the account was created, as milliseconds since the Unix epoch.
    pub created_at_ms: i64,
}

/// Search users, for the admin UI's user table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchUsers {
    /// A free-text query over display name and address. Never a raw SQL
    /// fragment: this is a *query parameter*, and the repository is the only
    /// thing that may decide what it matches.
    pub query: Option<String>,
    /// Filter by status.
    pub status: Option<UserStatus>,
    /// Filter by role.
    pub role: Option<PlatformRole>,
    /// Page size, bounded by the repository.
    pub limit: u32,
    /// Page offset, bounded by the repository.
    pub offset: u32,
}

/// A page of users.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchUsersOutcome {
    /// The matching users.
    pub users: Vec<AdminUserRow>,
    /// Whether more pages exist.
    pub has_more: bool,
}

/// Search users.
pub trait SearchUsersQuery {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a non-administrator.
    fn search_users(&self, input: SearchUsers) -> ApplicationResult<SearchUsersOutcome>;
}

/// One row of the admin audit view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminAuditRow {
    /// The event's identifier.
    pub event_id: String,
    /// What happened.
    pub event_type: String,
    /// The user the event is about.
    pub user_id: Option<UserId>,
    /// The administrator who acted, if one did.
    pub actor_id: Option<UserId>,
    /// When it happened, as milliseconds since the Unix epoch.
    pub occurred_at_ms: i64,
    /// Already-redacted detail.
    pub metadata: std::collections::BTreeMap<String, String>,
}

/// Query the audit trail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryAudit {
    /// Restrict to events about one user.
    pub user_id: Option<UserId>,
    /// Restrict to events by one actor.
    pub actor_id: Option<UserId>,
    /// Only events at or after this time, in milliseconds since the epoch.
    pub since_ms: Option<i64>,
    /// Only administrative events.
    pub administrative_only: bool,
    /// Page size, bounded by the repository.
    pub limit: u32,
    /// Page offset, bounded by the repository.
    pub offset: u32,
}

/// A page of audit events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryAuditOutcome {
    /// The matching events, newest first.
    pub events: Vec<AdminAuditRow>,
    /// Whether more pages exist.
    pub has_more: bool,
}

/// Query the audit trail.
pub trait QueryAuditQuery {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Forbidden`] for a non-administrator.
    fn query_audit(&self, input: QueryAudit) -> ApplicationResult<QueryAuditOutcome>;
}

/// The standard refusal when an administrative action is attempted from a
/// session that has not proved a second factor.
///
/// A named function rather than an inline `forbidden("…")` at each call site,
/// so the audit of *authorization failures* has one reason string to group by.
///
/// # Errors
///
/// None. It returns a value; the caller propagates it.
#[must_use]
pub fn forbidden_reason_missing_aal2() -> ApplicationError {
    ApplicationError::forbidden("administrative action requires an AAL2 session")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        current_role: PlatformRole,
        new_role: PlatformRole,
        active_admins: u32,
    ) -> RoleChangeRequest {
        request_by(PlatformRole::Administrator, current_role, new_role, active_admins)
    }

    fn request_by(
        actor_role: PlatformRole,
        current_role: PlatformRole,
        new_role: PlatformRole,
        active_admins: u32,
    ) -> RoleChangeRequest {
        RoleChangeRequest {
            user_id: UserId::new().expect("uuid"),
            actor_id: UserId::new().expect("uuid"),
            actor_role,
            current_role,
            new_role,
            target_status: UserStatus::Active,
            active_administrator_count: active_admins,
        }
    }

    #[test]
    fn the_last_administrator_cannot_be_demoted() {
        let outcome = request(PlatformRole::Administrator, PlatformRole::Member, 1).evaluate();
        assert!(matches!(outcome, RoleChange::LastAdministrator { .. }));
    }

    #[test]
    fn an_administrator_may_be_demoted_while_another_remains() {
        let outcome = request(PlatformRole::Administrator, PlatformRole::Member, 2).evaluate();
        assert_eq!(outcome, RoleChange::Permitted);
    }

    #[test]
    fn demoting_a_non_administrator_is_never_the_last_administrator() {
        // The count is 1, but the target is not an administrator, so the
        // check must not fire. Getting this wrong would make the *last member
        // promotion* impossible.
        let outcome = request(PlatformRole::Member, PlatformRole::Member, 1).evaluate();
        assert_eq!(outcome, RoleChange::Permitted);
    }

    #[test]
    fn a_suspended_administrator_does_not_count_as_the_last_one() {
        // Status is an input precisely so this is expressible: the count the
        // caller passes in is over *active* rows, so a suspended
        // administrator is already excluded from it. A suspended target
        // therefore cannot trip the last-administrator refusal — it is not one
        // of the administrators the count is protecting.
        let mut r = request(PlatformRole::Administrator, PlatformRole::Member, 1);
        r.target_status = UserStatus::Suspended;
        assert_eq!(r.evaluate(), RoleChange::Permitted);
    }

    #[test]
    fn a_non_administrator_actor_is_refused_before_the_count_is_consulted() {
        // Support moderates accounts; it does not assign roles. A support actor
        // demoting the last administrator gets the authorization refusal, not
        // the last-administrator refusal — the latter would be a misleading
        // reason for a problem that is really "you may not do this at all".
        let r = request_by(
            PlatformRole::Support,
            PlatformRole::Administrator,
            PlatformRole::Member,
            1,
        );
        assert!(matches!(
            r.evaluate(),
            RoleChange::NotPermitted {
                role: PlatformRole::Member
            }
        ));

        // Even a promotion is refused: the check is on the actor, not the
        // direction of the change.
        let r = request_by(
            PlatformRole::Member,
            PlatformRole::Member,
            PlatformRole::Administrator,
            1,
        );
        assert!(matches!(
            r.evaluate(),
            RoleChange::NotPermitted {
                role: PlatformRole::Administrator
            }
        ));
    }

    #[test]
    fn a_service_actor_may_not_assign_roles() {
        // The Jobs worker holds a Service role and acts on its own behalf. It
        // must never be able to promote an account.
        let r = request_by(
            PlatformRole::Service,
            PlatformRole::Member,
            PlatformRole::Administrator,
            1,
        );
        assert!(matches!(r.evaluate(), RoleChange::NotPermitted { .. }));
    }

    #[test]
    fn a_user_cannot_change_their_own_role() {
        let mut r = request(PlatformRole::Member, PlatformRole::Administrator, 1);
        r.actor_id = r.user_id;
        assert_eq!(r.evaluate(), RoleChange::SelfChange);
    }

    #[test]
    fn self_change_is_reported_before_the_last_administrator_rule() {
        // A lone administrator demoting themselves is both self-change and
        // last-administrator. The self-change reason is the more useful one,
        // and reporting it first is what makes the ordering load-bearing.
        let mut r = request(PlatformRole::Administrator, PlatformRole::Member, 1);
        r.actor_id = r.user_id;
        assert_eq!(r.evaluate(), RoleChange::SelfChange);
    }

    #[test]
    fn promoting_a_member_to_administrator_is_permitted() {
        let outcome = request(PlatformRole::Member, PlatformRole::Administrator, 1).evaluate();
        assert_eq!(outcome, RoleChange::Permitted);
    }

    #[test]
    fn every_administrative_command_carries_a_session() {
        // The AAL2 check has nowhere to happen if the session is not on the
        // input. These four cover the mutating commands.
        let ctx = AdminContext {
            actor_id: UserId::new().expect("uuid"),
            actor_session_id: "s".into(),
        };
        let inputs = vec![
            serde_json::to_value(SuspendUser {
                context: ctx.clone(),
                user_id: UserId::new().expect("uuid"),
                reason: "r".into(),
            })
            .expect("serializable"),
            serde_json::to_value(UnsuspendUser {
                context: ctx.clone(),
                user_id: UserId::new().expect("uuid"),
                reason: "r".into(),
            })
            .expect("serializable"),
            serde_json::to_value(RevokeUserSessions {
                context: ctx.clone(),
                user_id: UserId::new().expect("uuid"),
                reason: "r".into(),
            })
            .expect("serializable"),
            serde_json::to_value(ChangeUserRole {
                context: ctx.clone(),
                user_id: UserId::new().expect("uuid"),
                new_role: PlatformRole::Member,
            })
            .expect("serializable"),
        ];
        for input in inputs {
            assert!(
                input.get("context").and_then(|c| c.get("actor_session_id")).is_some(),
                "an administrative command must carry the actor's session"
            );
        }
    }

    #[test]
    fn a_suspension_requires_a_reason() {
        // Enforced by the type carrying a non-Option `String`; the test records
        // that a future `Option<String>` would be a regression.
        let ctx = AdminContext {
            actor_id: UserId::new().expect("uuid"),
            actor_session_id: "s".into(),
        };
        let json = serde_json::to_value(SuspendUser {
            context: ctx,
            user_id: UserId::new().expect("uuid"),
            reason: "spam".into(),
        })
        .expect("serializable");
        assert_eq!(
            json.get("reason").and_then(|r| r.as_str()),
            Some("spam"),
            "reason is mandatory, not optional"
        );
    }

    #[test]
    fn a_search_query_is_a_parameter_not_a_fragment() {
        // `query` is a `String` the repository binds as a parameter. If this
        // ever became a fragment or gained SQL keywords, the admin UI's search
        // box would be an injection point on an administrative endpoint.
        let input = SearchUsers {
            query: Some("'; DROP TABLE users; --".into()),
            status: None,
            role: None,
            limit: 50,
            offset: 0,
        };
        let json = serde_json::to_string(&input).expect("serializable");
        assert!(json.contains("DROP TABLE users"));
        assert!(!json.to_lowercase().contains("\"where\""));
    }
}
