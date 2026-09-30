//! The administrative route table: the paths the Admin Worker serves.
//!
//! The same shape as `identity_oidc::route`, and the same reason for existing
//! as data rather than as `match` arms inside a handler: a path that exists in
//! the dispatcher and is missing from the client is a bug the client cannot
//! report, because a path the Worker does not serve looks exactly like a path
//! the Worker has never heard of. Declaring the paths here makes
//! [`find_by_path`] one function over one list, and a test asserts the list
//! against the literals the console actually sends.
//!
//! # Why this is not in `identity-oidc`
//!
//! That crate is the OIDC protocol surface, and `identity-application` may not
//! depend on it (`module-boundaries.config.mjs`, the `application` row). An
//! administrative route table is not a protocol artifact: it is a fact about
//! the administrative surface, which is what this crate owns. The OIDC Worker
//! and the Admin Worker are two deployables with two route tables, and merging
//! them would put `/admin/*` inside the crate that publishes a discovery
//! document listing OAuth endpoints.
//!
//! # Where the paths come from
//!
//! From `apps/identity-admin/web/src/api/admin.ts` and
//! `apps/identity-admin/web/src/capabilities.ts`, which is the only place they
//! are written down today. That client is a separate pnpm project the Rust
//! workspace does not build, so the literals are copied into the tests rather
//! than imported: an import that were deleted would silently turn the check
//! into a no-op, and a copied literal fails the moment the client's spelling
//! changes. The client's request path is what the route table must match —
//! its 501 handling keys off the exact string it put in the URL.
//!
//! # What is NOT here
//!
//! No handler, no binding name, no `IDENTITY` service-binding call, and no
//! database. The table is a list of paths and their implementation state. What
//! answers on a path is decided above this crate, in
//! `apps/identity-admin/worker`, which is the only place allowed to name a
//! binding — and which holds no `IDENTITY_DB`. See
//! `docs/architecture/admin-isolation.md`.

use identity_domain::user::UserId;
use serde::{Deserialize, Serialize};

use crate::error::{ApplicationError, ApplicationResult};

/// One route the Admin Worker serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdminRoute {
    /// The operator's own administrative session.
    Session,
    /// The user search.
    Users,
    /// One user's account, by id.
    UserDetail,
    /// Suspend a user.
    UserSuspend,
    /// Reinstate a suspended user.
    UserUnsuspend,
    /// Change a user's platform role.
    UserRole,
    /// Revoke every session belonging to one user.
    UserSessionsRevoke,
    /// The audit query.
    Audit,
    /// List registered OAuth clients.
    Applications,
    /// Rotate a registered client's secret.
    ApplicationRotateSecret,
    /// The liveness probe.
    Health,
    /// The readiness probe.
    Ready,
}

/// A path segment standing for any single segment.
const USER_ID_SEGMENT: &str = "{user_id}";
/// A path segment standing for any single segment.
const APPLICATION_ID_SEGMENT: &str = "{application_id}";

impl AdminRoute {
    /// Every route the bootstrap declares.
    pub const ALL: &'static [AdminRoute] = &[
        AdminRoute::Session,
        AdminRoute::Users,
        AdminRoute::UserDetail,
        AdminRoute::UserSuspend,
        AdminRoute::UserUnsuspend,
        AdminRoute::UserRole,
        AdminRoute::UserSessionsRevoke,
        AdminRoute::Audit,
        AdminRoute::Applications,
        AdminRoute::ApplicationRotateSecret,
        AdminRoute::Health,
        AdminRoute::Ready,
    ];

    /// The path template this route answers on, with `{…}` for a parameter.
    ///
    /// A *template*, not a literal: the parameterized routes are matched
    /// against a concrete path by [`find_by_path`]. The template is the string
    /// a test compares against the console's own literals, which is the
    /// comparison that has to hold.
    #[must_use]
    pub const fn path(self) -> &'static str {
        match self {
            Self::Session => "/admin/session",
            Self::Users => "/admin/users",
            Self::UserDetail => "/admin/users/detail/{user_id}",
            Self::UserSuspend => "/admin/users/suspend/{user_id}",
            Self::UserUnsuspend => "/admin/users/suspend/{user_id}/unsuspend",
            Self::UserRole => "/admin/users/role/{user_id}",
            Self::UserSessionsRevoke => "/admin/sessions/revoke/{user_id}",
            Self::Audit => "/admin/audit",
            Self::Applications => "/admin/applications",
            Self::ApplicationRotateSecret => "/admin/applications/{application_id}/rotate-secret",
            Self::Health => "/health",
            Self::Ready => "/ready",
        }
    }

    /// The path template as its segments, with a `{…}` segment for a parameter.
    ///
    /// The matcher works on segments rather than on the rendered string because
    /// a rendered template cannot be compared for equality. `path` and
    /// `segments` are both `const fn` and both hand-written, so they could
    /// drift; `path_agrees_with_segments` fails if they do.
    #[must_use]
    pub const fn segments(self) -> &'static [&'static str] {
        match self {
            Self::Session => &["admin", "session"],
            Self::Users => &["admin", "users"],
            Self::UserDetail => &["admin", "users", "detail", USER_ID_SEGMENT],
            Self::UserSuspend => &["admin", "users", "suspend", USER_ID_SEGMENT],
            Self::UserUnsuspend => &["admin", "users", "suspend", USER_ID_SEGMENT, "unsuspend"],
            Self::UserRole => &["admin", "users", "role", USER_ID_SEGMENT],
            Self::UserSessionsRevoke => &["admin", "sessions", "revoke", USER_ID_SEGMENT],
            Self::Audit => &["admin", "audit"],
            Self::Applications => &["admin", "applications"],
            Self::ApplicationRotateSecret => &[
                "admin",
                "applications",
                APPLICATION_ID_SEGMENT,
                "rotate-secret",
            ],
            Self::Health => &["health"],
            Self::Ready => &["ready"],
        }
    }

    /// Whether this route is implemented in the bootstrap.
    ///
    /// **False for every administrative route.** The console's ten calls all
    /// answer 501, and the `not_implemented` envelope is all any of them
    /// returns. `Health` and `Ready` answer for real — not because the
    /// administrative surface exists, but because a liveness probe on a system
    /// whose every feature is deferred still has to say *this process is up*,
    /// and `/ready` has to say *and here is exactly what is missing*.
    ///
    /// This is the single honest answer to "is the admin console functional",
    /// and it is what every place that has an opinion reads.
    #[must_use]
    pub const fn is_implemented(self) -> bool {
        matches!(self, Self::Health | Self::Ready)
    }

    /// Whether a request to this route should be answered with the
    /// "scaffolded but not implemented" envelope rather than a 404.
    ///
    /// A 501 is deliberate over a 404, for the reason
    /// `identity_oidc::route::Route::is_declared_but_unimplemented` gives: the
    /// route *is* part of this console's contract, and the Vue client keys its
    /// typed `NotImplementedError` off the 501 status. Answering 404 would make
    /// the client's own deferred-state handling unreachable.
    #[must_use]
    pub const fn is_declared_but_unimplemented(self) -> bool {
        !self.is_implemented()
    }
}

/// A concrete request path that names a declared route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match<'a> {
    /// Which route the path names.
    pub route: AdminRoute,
    /// The raw text of the route's single `{…}` segment, unvalidated.
    ///
    /// Unvalidated on purpose: a path segment that is not a well-formed id is
    /// still a *declared route the caller reached*, and the difference between
    /// "you called a path that does not exist" and "you called a real path with
    /// a bad id" is one the caller can act on. Validating it here would throw
    /// that away and answer both with the same status.
    pub path_parameter: Option<&'a str>,
}

impl Match<'_> {
    /// The user id this path named.
    ///
    /// # Errors
    ///
    /// [`ApplicationError::NotFound`] when the path carried no `{…}` segment, or
    /// carried one that is not a well-formed [`UserId`]. Both are the same fact
    /// to a caller — there is no user by that name — and the transport turns
    /// the code into the wire status. Not a 501: the path named a declared
    /// route, so answering "deferred" would be a lie about a call that will
    /// never be served.
    pub fn user_id(&self) -> ApplicationResult<UserId> {
        let Some(raw) = self.path_parameter else {
            return Err(ApplicationError::NotFound { entity: "user" });
        };
        UserId::parse(raw).map_err(|_| ApplicationError::NotFound { entity: "user" })
    }
}

/// Whether a template segment stands for any segment.
const fn is_parameter(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() > 2 && bytes[0] == b'{' && bytes[bytes.len() - 1] == b'}'
}

/// Split a request path into its segments, or `None` if it is not a path.
///
/// `None` for a path with an empty segment — a trailing slash, a doubled slash
/// — because `/admin/users/` is not `/admin/users` and is not `/admin/users/{…}`.
/// Normalising them would make the Worker answer 501 for a URL the console
/// never sent, which is a claim about a call that did not happen.
fn path_segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix('/')?;
    if rest.is_empty() {
        return Some(Vec::new());
    }
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    Some(segments)
}

/// Find the route a concrete request path names.
///
/// Matching is per segment, so two routes never collide by depth:
/// `/admin/users/suspend/{id}` and `/admin/users/suspend/{id}/unsuspend` differ
/// in length, and `/admin/users/suspend/{id}/unsuspend/deeper` names nothing at
/// all. A `{…}` segment matches exactly one non-empty segment and is carried
/// out in [`Match::path_parameter`].
///
/// # Errors
///
/// None. An unknown path returns `None`, and the Worker answers 404.
#[must_use]
pub fn find_by_path(path: &str) -> Option<Match<'_>> {
    let segments = path_segments(path)?;
    AdminRoute::ALL.iter().copied().find_map(|route| {
        let template = route.segments();
        if template.len() != segments.len() {
            return None;
        }
        let mut path_parameter = None;
        for (expected, actual) in template.iter().zip(&segments) {
            if is_parameter(expected) {
                path_parameter = Some(*actual);
            } else if *expected != *actual {
                return None;
            }
        }
        Some(Match {
            route,
            path_parameter,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact strings `apps/identity-admin/web/src/capabilities.ts` puts in
    /// `ADMIN_ROUTES`, and the one `api/admin.ts` inlines. These are the URLs
    /// the console builds; the table must answer on them.
    const CLIENT_LITERALS: [(&str, &str); 10] = [
        ("health", "/health"),
        ("ready", "/ready"),
        ("session", "/admin/session"),
        ("users", "/admin/users"),
        ("userDetail", "/admin/users/detail"),
        ("suspend", "/admin/users/suspend"),
        ("role", "/admin/users/role"),
        ("revokeSessions", "/admin/sessions/revoke"),
        ("audit", "/admin/audit"),
        ("applications", "/admin/applications"),
    ];

    /// The full paths `api/admin.ts` builds by appending an id to a literal,
    /// written out here with the id filled in, exactly as the client does.
    const CLIENT_ID_PATHS: [(&str, &str, &str); 5] = [
        (
            "getUser",
            "/admin/users/detail",
            "/admin/users/detail/0195f2c1-0000-7000-8000-000000000001",
        ),
        (
            "suspendUser",
            "/admin/users/suspend",
            "/admin/users/suspend/0195f2c1-0000-7000-8000-000000000001",
        ),
        (
            "unsuspendUser",
            "/admin/users/suspend",
            "/admin/users/suspend/0195f2c1-0000-7000-8000-000000000001/unsuspend",
        ),
        (
            "changeUserRole",
            "/admin/users/role",
            "/admin/users/role/0195f2c1-0000-7000-8000-000000000001",
        ),
        (
            "revokeUserSessions",
            "/admin/sessions/revoke",
            "/admin/sessions/revoke/0195f2c1-0000-7000-8000-000000000001",
        ),
    ];

    const ID: &str = "0195f2c1-0000-7000-8000-000000000001";

    /// The base each of the client's id-bearing calls is built on must be a
    /// prefix of the route that answers it. This is the check that catches the
    /// failure mode that matters: the console builds
    /// `` `${ADMIN_ROUTES.suspend}/${id}` ``, so a table that answered
    /// `/admin/users/{id}/suspend` would look correct next to the client's own
    /// `JSDoc` in `api/admin.ts` and would 404 every real call.
    fn base_of(template: &str) -> &str {
        template.split("/{").next().unwrap_or(template)
    }

    #[test]
    fn path_agrees_with_segments() {
        for route in AdminRoute::ALL {
            let template = route.path();
            let rendered = format!("/{}", route.segments().join("/"));
            assert_eq!(
                template, rendered,
                "{route:?}: path() and segments() disagree; one is hand-written and \
                 a matcher that used the other would answer a path the console \
                 never sends"
            );
        }
    }

    #[test]
    fn every_route_has_a_distinct_path() {
        let mut paths: Vec<&str> = AdminRoute::ALL.iter().map(|r| r.path()).collect();
        let count = paths.len();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), count, "two routes answer on the same path");
    }

    #[test]
    fn every_route_has_a_path_looking_like_a_path() {
        for route in AdminRoute::ALL {
            assert!(
                route.path().starts_with('/') && !route.path().ends_with('/'),
                "{route:?} is not a well-formed path template: {}",
                route.path()
            );
        }
    }

    #[test]
    fn a_fixed_path_resolves_to_its_own_route() {
        for (path, expected) in [
            ("/health", AdminRoute::Health),
            ("/ready", AdminRoute::Ready),
            ("/admin/session", AdminRoute::Session),
            ("/admin/users", AdminRoute::Users),
            ("/admin/audit", AdminRoute::Audit),
            ("/admin/applications", AdminRoute::Applications),
        ] {
            assert_eq!(
                find_by_path(path).map(|m| m.route),
                Some(expected),
                "{path}"
            );
        }
    }

    #[test]
    fn a_parameterized_path_resolves_through_its_id_segment() {
        for (path, expected) in [
            (format!("/admin/users/detail/{ID}"), AdminRoute::UserDetail),
            (
                format!("/admin/users/suspend/{ID}"),
                AdminRoute::UserSuspend,
            ),
            (
                format!("/admin/users/suspend/{ID}/unsuspend"),
                AdminRoute::UserUnsuspend,
            ),
            (format!("/admin/users/role/{ID}"), AdminRoute::UserRole),
            (
                format!("/admin/sessions/revoke/{ID}"),
                AdminRoute::UserSessionsRevoke,
            ),
            (
                format!("/admin/applications/{ID}/rotate-secret"),
                AdminRoute::ApplicationRotateSecret,
            ),
        ] {
            let found = find_by_path(&path).unwrap_or_else(|| panic!("{path} resolved to nothing"));
            assert_eq!(found.route, expected, "{path}");
            assert_eq!(found.path_parameter, Some(ID), "{path}");
        }
    }

    #[test]
    fn a_match_with_no_parameter_carries_none() {
        let found = find_by_path("/admin/audit").expect("/admin/audit is declared");
        assert_eq!(found.route, AdminRoute::Audit);
        assert_eq!(found.path_parameter, None);
    }

    #[test]
    fn routes_differing_only_in_depth_do_not_collide() {
        // `/admin/users/suspend/{id}` and `/admin/users/suspend/{id}/unsuspend`
        // share a three-segment prefix. A prefix-matching table would answer
        // the 501 for `unsuspend` when the console called `suspend`, and the
        // console's deferred-state screen would name the wrong call.
        assert_ne!(
            find_by_path(&format!("/admin/users/suspend/{ID}")).map(|m| m.route),
            find_by_path(&format!("/admin/users/suspend/{ID}/unsuspend")).map(|m| m.route)
        );
    }

    #[test]
    fn a_deeper_path_than_any_route_names_nothing() {
        for path in [
            format!("/admin/users/suspend/{ID}/unsuspend/deeper"),
            format!("/admin/users/detail/{ID}/extra"),
            format!("/admin/applications/{ID}/rotate-secret/extra"),
        ] {
            assert_eq!(find_by_path(&path), None, "{path} should name no route");
        }
    }

    #[test]
    fn an_undeclared_path_is_undeclared() {
        for path in [
            "/",
            "/admin",
            "/admin/",
            "/nope",
            "/admin/nope",
            "/admin/users/detail",
            "/admin/users/suspend",
            "/admin/users/suspend/",
            "/admin/audit/extra",
            // The Identity Worker's OIDC routes. The Admin Worker does not
            // serve them, and answering 501 for them would be a claim about a
            // protocol surface this deployable does not have.
            "/oauth/token",
            "/.well-known/jwks.json",
            // The admin web app's own client-side routes. Those are served by
            // the ASSETS binding, not by this Worker.
            "/users",
            "/audit",
        ] {
            assert_eq!(find_by_path(path), None, "{path} should name no route");
        }
    }

    #[test]
    fn a_doubled_slash_is_not_normalised_into_a_route() {
        assert_eq!(find_by_path("/admin//users"), None);
        assert_eq!(find_by_path(&format!("/admin/users//detail/{ID}")), None);
    }

    #[test]
    fn no_administrative_route_is_implemented_in_bootstrap() {
        // The assertion that makes "no fake admin console is presented as
        // working" mechanical, mirroring
        // `identity_oidc::route::tests::no_protocol_route_is_implemented_in_bootstrap`.
        for route in AdminRoute::ALL {
            if matches!(route, AdminRoute::Health | AdminRoute::Ready) {
                assert!(
                    route.is_implemented(),
                    "{route:?} is live and must say so; a false negative here \
                     would send an operator to a route that answers"
                );
                continue;
            }
            assert!(
                !route.is_implemented(),
                "{route:?} claims to be implemented; update is_implemented, the \
                 console's deferred-state handling and /ready together"
            );
        }
    }

    #[test]
    fn exactly_the_two_health_routes_are_live() {
        let live: Vec<&str> = AdminRoute::ALL
            .iter()
            .filter(|r| r.is_implemented())
            .map(|r| r.path())
            .collect();
        assert_eq!(live, ["/health", "/ready"]);
    }

    #[test]
    fn a_declared_route_is_never_also_undeclared() {
        for route in AdminRoute::ALL {
            assert_ne!(
                route.is_implemented(),
                route.is_declared_but_unimplemented(),
                "{route:?} is in neither state"
            );
        }
    }

    #[test]
    fn every_client_literal_is_a_prefix_of_a_route_the_table_declares() {
        // The half that catches a real outage. The console builds every
        // administrative URL as `` `${ADMIN_ROUTES.<key>}/…` ``, so a table
        // whose path is not built from the same literal would 404 a call the
        // Worker was always supposed to answer — and because every route
        // answers 501, a 404 reads to the operator as "this path does not
        // exist" rather than "this is deferred".
        for (key, literal) in CLIENT_LITERALS {
            let found = AdminRoute::ALL
                .iter()
                .find(|r| r.path() == literal || base_of(r.path()) == literal);
            assert!(
                found.is_some(),
                "the console's ADMIN_ROUTES.{key} is {literal}, and no route in \
                 identity-application is built from it"
            );
        }
    }

    #[test]
    fn every_client_call_resolves_to_a_route() {
        // The other half: take each URL the console actually sends and resolve
        // it. This is the assertion that would have caught a table written from
        // the JSDoc in `api/admin.ts` instead of from its request paths.
        for (fn_name, base, concrete) in CLIENT_ID_PATHS {
            assert!(
                base_of(concrete).starts_with(base),
                "test data for {fn_name} is not built from {base}"
            );
            let found = find_by_path(concrete)
                .unwrap_or_else(|| panic!("{fn_name} sends {concrete}, which no route answers"));
            assert_eq!(
                found.path_parameter,
                Some(ID),
                "{fn_name} sends {concrete}; the id segment was not carried out"
            );
        }
        for (path, expected) in [
            ("/health", AdminRoute::Health),
            ("/ready", AdminRoute::Ready),
            ("/admin/session", AdminRoute::Session),
            ("/admin/users", AdminRoute::Users),
            ("/admin/audit", AdminRoute::Audit),
            ("/admin/applications", AdminRoute::Applications),
        ] {
            assert_eq!(
                find_by_path(path).map(|m| m.route),
                Some(expected),
                "the console sends {path}, which resolves elsewhere"
            );
        }
    }

    #[test]
    fn every_route_is_reachable_from_a_literal_the_console_uses() {
        // No route may exist that the console cannot call. A route the console
        // never sends is a route whose 501 nobody will ever see, and one whose
        // `is_implemented` flip would change nothing observable.
        for route in AdminRoute::ALL {
            let reachable = CLIENT_LITERALS
                .iter()
                .any(|(_, literal)| *literal == route.path() || base_of(route.path()) == *literal);
            assert!(
                reachable,
                "{route:?} ({}) is not reachable from any ADMIN_ROUTES literal; \
                 either it is a phantom route or the console is missing a call",
                route.path()
            );
        }
    }

    #[test]
    fn a_well_formed_id_in_the_path_parses() {
        let path = format!("/admin/users/role/{ID}");
        let found = find_by_path(&path).expect("declared");
        assert_eq!(found.user_id().expect("a valid id parses").to_string(), ID);
    }

    #[test]
    fn a_malformed_id_segment_is_not_found_and_not_deferred() {
        // Not a 501 and not a panic. The path named a declared route and the
        // caller's id was wrong, which is a 404 from the code `not_found`; a
        // 501 here would be the console rendering a call it did make as
        // "deferred", which is the one state an operator cannot act on.
        let found = find_by_path("/admin/users/role/not-a-uuid").expect("the route is declared");
        let err = found.user_id().expect_err("a bad id is refused");
        assert_eq!(err.code(), "not_found");
        assert!(err.is_client_safe(), "NotFound is not a Dependency failure");
    }

    #[test]
    fn a_route_with_no_id_reports_not_found_rather_than_inventing_one() {
        let found = find_by_path("/admin/users").expect("the route is declared");
        assert_eq!(
            found.user_id().expect_err("no id to parse").code(),
            "not_found"
        );
    }
}
