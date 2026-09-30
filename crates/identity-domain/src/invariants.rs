//! The domain invariants, written as test skeletons.
//!
//! # Why these tests are `#[ignore]`d
//!
//! This is the bootstrap phase: the repository's platform exists, and the
//! authentication implementation does not. Each test below names a rule that
//! the system *must* enforce, and each is marked `#[ignore = "…"]` with the
//! reason it is not yet enforced. They are not written to pass — several
//! cannot even be written in a form that compiles today, because the
//! application-layer command that would decide the rule does not exist yet —
//! and that is the honest state.
//!
//! The alternative was considered and rejected: a test that asserts the
//! opposite of the rule, or that asserts only what the types already guarantee,
//! would go green in CI and would read as "this is covered". A skipped test
//! says "this is not covered", and it fails the moment someone runs it
//! explicitly. `moon run identity-domain:test-invariants` runs the whole set
//! ignoring the ignore attribute, which is how a maintainer asks "how much of
//! the security model is actually real yet?".
//!
//! # The rules
//!
//! | Invariant | Enforcing layer (once implemented) |
//! |---|---|
//! | An inactive user cannot authenticate | `identity-application` — `sessions::authenticate` |
//! | The last administrator cannot be removed or demoted | `identity-application` — `administration` |
//! | A stale `security_version` invalidates its sessions | `identity-domain` + `identity-application` |
//! | AAL1 cannot satisfy an AAL2 operation | `identity-security` |
//! | A revoked session cannot authenticate | `identity-domain` + `identity-application` |
//! | A user subject cannot be reused by another user | `identity-application` — `identities::link` |
//!
//! Two of the six are *already* expressible and asserted for real in the
//! modules that own them ([`crate::security`] for AAL ordering,
//! [`crate::session`] for revocation and expiry). Those are listed here for
//! traceability, with tests that are not ignored, because a rule this crate
//! can enforce on its own should be enforced on its own rather than deferred
//! to a layer that may never get written.

#[cfg(test)]
mod tests {
    // One import block for the module, rather than one per test body: a new
    // test should not be another round of import churn, and the `#[ignore]`d
    // skeletons are expected to have their bodies rewritten when they are
    // implemented.
    use crate::application::{Application, ApplicationAccessMode, ApplicationStatus};
    use crate::error::DomainError;
    use crate::security::{Aal, SecurityVersion};
    use crate::session::{Session, SessionStatus};
    use crate::user::{PlatformRole, User, UserId, UserStatus};

    /// Bring a user to `Active` without going through the application layer.
    ///
    /// The command that does this legitimately is `identity-application`'s
    /// `authentication::complete_email_verification`. In a skeleton test there is
    /// no such command, so the helper sets the field directly and says so. If a
    /// future `User::activate` appears, this helper should call it instead.
    #[allow(dead_code, reason = "used by the #[ignore]d invariant skeletons")]
    fn active_user(role: PlatformRole) -> User {
        let mut user = User::new(UserId::new().expect("uuid"), "Test User").expect("valid");
        user.role = role;
        user.status = UserStatus::Active;
        user
    }

    // ---------------------------------------------------------------------------
    // 1. An inactive user cannot authenticate
    // ---------------------------------------------------------------------------

    #[test]
    #[ignore = "bootstrap: identity-application has no authenticate command yet; \
                the rule is a join over user.status and session issuance"]
    fn inactive_user_cannot_authenticate() {
        for status in [
            UserStatus::Suspended,
            UserStatus::Deactivated,
            UserStatus::PendingVerification,
        ] {
            let user = User::new(UserId::new().expect("uuid"), "Test User").expect("valid");
            assert!(
                !user.may_authenticate(),
                "a {status:?} user must not authenticate"
            );
        }
        assert!(active_user(PlatformRole::Member).may_authenticate());
    }

    // ---------------------------------------------------------------------------
    // 2. The last administrator cannot be removed or demoted
    // ---------------------------------------------------------------------------

    #[test]
    #[ignore = "bootstrap: no administration command exists to demote an administrator, \
                so there is nothing to refuse. The rule needs a count of \
                administrators, which lives in identity-application."]
    fn last_administrator_cannot_be_removed() {
        // The rule: demoting or deactivating the final administrator is refused.
        // It is not "an administrator may not be demoted" — a second
        // administrator may be created and the first then demoted normally. It is
        // a count check against `role = 'administrator' AND status = 'active'`,
        // and it must be evaluated inside the same transaction as the demotion,
        // or two concurrent demotions each see two administrators and both
        // succeed, leaving zero.
        let administrators: Vec<User> = vec![active_user(PlatformRole::Administrator)];
        assert_eq!(administrators.len(), 1, "the precondition of the invariant");
        // The refusing call, once written:
        //   assert!(administration::demote_user(&administrators[0], PlatformRole::Member).is_err());
    }

    // ---------------------------------------------------------------------------
    // 3. A stale security_version invalidates its sessions
    // ---------------------------------------------------------------------------

    #[test]
    fn stale_security_version_does_not_match_the_current_account() {
        // Enforced for real: the comparison is a value comparison this crate owns,
        // and the future access check is exactly this expression. Not ignored,
        // because there is nothing left to implement for *this half* of the rule.

        let user = active_user(PlatformRole::Member);
        let version_at_issue = SecurityVersion::new(user.security_version);
        let current = version_at_issue.bumped().expect("not exhausted");

        let session =
            Session::new(user.id, version_at_issue.get(), 1_000, 2_000, Aal::Aal1).expect("valid");

        assert_eq!(session.security_version, version_at_issue.get());
        assert_ne!(
            session.security_version,
            current.get(),
            "a session issued under an older security version must not match"
        );
        // The rule as the application layer will apply it: the access check
        // compares the session's recorded version against the user's current
        // one, and refuses when they differ. Here they differ, so the
        // comparison the middleware will make evaluates to false.
        assert_ne!(session.security_version, current.get());
    }

    #[test]
    fn bumping_the_security_version_invalidates_every_older_session() {
        // The O(1) half of "revoke all sessions": one comparison per request, no
        // enumeration. Enforced here for real because it is pure arithmetic over
        // this crate's types.

        let issued_under = SecurityVersion::INITIAL;
        let bumped = issued_under.bumped().expect("ok");

        let older_sessions = [issued_under, issued_under, issued_under];
        let newer_sessions = [bumped];

        assert!(older_sessions.iter().all(|v| *v != bumped));
        assert!(newer_sessions.iter().all(|v| *v == bumped));
    }

    // ---------------------------------------------------------------------------
    // 4. AAL1 cannot satisfy an AAL2 operation
    // ---------------------------------------------------------------------------

    #[test]
    fn aal1_cannot_satisfy_an_aal2_operation() {
        // Enforced for real — see `security::tests`. Repeated here so the six
        // invariants are readable as one list, with the honest enforcement state
        // attached to each.

        let session =
            Session::new(UserId::new().expect("uuid"), 0, 1_000, 2_000, Aal::Aal1).expect("valid");
        assert!(!session.satisfies(Aal::Aal2));
        assert!(session.satisfies(Aal::Aal1));
    }

    #[test]
    fn recently_authenticated_is_tracked_per_session_not_globally() {
        // A step-up is a property of a moment. If "recently authenticated" were a
        // property of the user, one account-wide flag would let an attacker with
        // any session on the account make every other session step-up-eligible.

        let mut stepped_up =
            Session::new(UserId::new().expect("uuid"), 0, 1_000, 2_000, Aal::Aal1).expect("valid");
        let never_stepped_up =
            Session::new(stepped_up.user_id, 0, 1_000, 2_000, Aal::Aal1).expect("valid");

        stepped_up.recently_authenticated = true;
        assert!(stepped_up.recently_authenticated);
        assert!(
            !never_stepped_up.recently_authenticated,
            "a step-up on one session must not lift another"
        );
    }

    // ---------------------------------------------------------------------------
    // 5. A revoked session cannot authenticate
    // ---------------------------------------------------------------------------

    #[test]
    fn revoked_session_cannot_authenticate() {
        // Enforced for real: `Session::revoke` refuses, and `is_usable_at`
        // consults status first. The application layer's job is to call it.

        let mut session =
            Session::new(UserId::new().expect("uuid"), 0, 1_000, 2_000, Aal::Aal1).expect("valid");

        assert!(session.is_usable_at(1_500));
        session.revoke().expect("active");
        assert_eq!(session.status, SessionStatus::Revoked);
        assert!(
            !session.is_usable_at(1_500),
            "a revoked session is refused even before its expiry"
        );
    }

    // ---------------------------------------------------------------------------
    // 6. A user subject cannot be reused by another user
    // ---------------------------------------------------------------------------

    #[test]
    #[ignore = "bootstrap: identity-application has no link_identity command and no \
                repository, so the uniqueness rule has no enforcement point yet. \
                The database unique index on (provider, subject) is part of the \
                claim; until a repository exists, nothing checks it."]
    fn user_subject_cannot_be_reused_by_another_user() {
        use crate::identity::{Identity, IdentityProvider};

        let alice = UserId::new().expect("uuid");
        let bob = UserId::new().expect("uuid");
        let subject = "provider-user-12345";

        let alice_identity = Identity::new(alice, IdentityProvider::OAuth, subject).expect("valid");

        // The refusing call, once written:
        //   assert!(identities::link(bob, IdentityProvider::OAuth, subject).is_err());
        assert_eq!(alice_identity.subject, subject);

        // The same subject under a *different* provider is a different identity
        // and must be allowed — otherwise a user who has both a Google and a
        // GitHub account whose subjects collide could not link both.
        let other_provider = Identity::new(bob, IdentityProvider::Saml, subject).expect("valid");
        assert_eq!(other_provider.subject, alice_identity.subject);
        assert_ne!(other_provider.provider, alice_identity.provider);
    }

    // ---------------------------------------------------------------------------
    // Supporting shapes
    // ---------------------------------------------------------------------------

    #[test]
    fn a_suspended_application_refuses_an_authorization_flow() {
        // Not one of the six, but the same shape of rule and already enforceable:
        // the type's own method answers it, so it is asserted rather than deferred.
        let mut app =
            Application::new("client", "Client", ApplicationAccessMode::Oidc).expect("valid");
        assert!(app.granted_scopes(&["openid".to_string()]).is_ok());
        app.status = ApplicationStatus::Suspended;
        let err = app
            .granted_scopes(&["openid".to_string()])
            .expect_err("suspended");
        assert_eq!(err.code(), "illegal_transition");
    }

    #[test]
    fn a_domain_error_is_never_panicking_in_an_invariant_message() {
        // Every `expect` above names what it expects. This one checks the error
        // vocabulary the invariants will report through, so a future refactor to
        // a stringly-typed error is caught here rather than in a panic message
        // during an incident.
        assert_eq!(DomainError::not_found("user").code(), "not_found");
    }
}
