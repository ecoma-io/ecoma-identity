//! The OAuth and OIDC route table.
//!
//! One list of the paths this provider serves, shared by the Identity Worker
//! (which dispatches to them) and by the contract fixtures in
//! `contracts/oidc/v1/`. Declaring the routes as data rather than as `match`
//! arms scattered through a handler means a route cannot exist in one place
//! and be missing from the discovery document, and it is what the smoke test
//! checks after a version upload.

use serde::{Deserialize, Serialize};

/// One route this provider serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    /// The provider metadata document.
    Discovery,
    /// The JSON Web Key Set.
    Jwks,
    /// The authorization endpoint.
    Authorize,
    /// The token endpoint.
    Token,
    /// The userinfo endpoint.
    UserInfo,
    /// The revocation endpoint.
    Revoke,
    /// The end-session endpoint.
    Logout,
    /// The liveness probe.
    Health,
    /// The readiness probe.
    Ready,
}

impl Route {
    /// Every route the bootstrap serves.
    pub const ALL: &'static [Route] = &[
        Route::Discovery,
        Route::Jwks,
        Route::Authorize,
        Route::Token,
        Route::UserInfo,
        Route::Revoke,
        Route::Logout,
        Route::Health,
        Route::Ready,
    ];

    /// The path this route answers on.
    #[must_use]
    pub const fn path(self) -> &'static str {
        match self {
            Self::Discovery => "/.well-known/openid-configuration",
            Self::Jwks => "/.well-known/jwks.json",
            Self::Authorize => "/oauth/authorize",
            Self::Token => "/oauth/token",
            Self::UserInfo => "/oauth/userinfo",
            Self::Revoke => "/oauth/revoke",
            Self::Logout => "/oauth/logout",
            Self::Health => "/health",
            Self::Ready => "/ready",
        }
    }

    /// Whether this route is implemented in the bootstrap.
    ///
    /// **False for every protocol route.** Discovery and JWKS have well-defined
    /// bodies this phase does not produce (there is no signing key yet), and
    /// the five OAuth routes are the substance of the authentication
    /// implementation that this phase explicitly defers. The two health routes
    /// are live.
    ///
    /// This is the single honest answer to "is OIDC implemented", and the
    /// smoke test and the `/ready` probe both read it — so the answer is the
    /// same one everywhere, and cannot drift.
    #[must_use]
    pub const fn is_implemented(self) -> bool {
        matches!(self, Self::Health | Self::Ready)
    }

    /// Whether a request to this route should be answered with the
    /// "scaffolded but not implemented" envelope rather than a 404.
    ///
    /// A 501 is deliberate over a 404: the route *is* part of this provider's
    /// contract, and a client that sees 501 knows to stop and a scanner that
    /// sees 404 records a missing endpoint. Silently 404-ing a declared route
    /// would make an incomplete bootstrap indistinguishable from a wrong
    /// discovery document.
    #[must_use]
    pub const fn is_declared_but_unimplemented(self) -> bool {
        !self.is_implemented()
    }
}

/// Find a route by path.
///
/// # Errors
///
/// None. An unknown path returns `None`, and the Worker answers 404.
#[must_use]
pub fn find_by_path(path: &str) -> Option<Route> {
    Route::ALL.iter().copied().find(|r| r.path() == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_has_a_distinct_path() {
        let mut paths: Vec<&str> = Route::ALL.iter().map(|r| r.path()).collect();
        let count = paths.len();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), count, "two routes answer on the same path");
    }

    #[test]
    fn every_route_has_a_path_looking_like_a_path() {
        for route in Route::ALL {
            assert!(
                route.path().starts_with('/'),
                "{route:?} has no leading slash"
            );
        }
    }

    #[test]
    fn a_route_is_found_by_its_path() {
        assert_eq!(find_by_path("/oauth/token"), Some(Route::Token),);
        assert_eq!(find_by_path("/.well-known/jwks.json"), Some(Route::Jwks));
        assert_eq!(find_by_path("/oauth/nope"), None);
        assert_eq!(find_by_path("/"), None);
    }

    #[test]
    fn no_protocol_route_is_implemented_in_bootstrap() {
        // The assertion that makes "no fake OIDC is presented as complete"
        // mechanical. If someone implements `/oauth/token` and forgets this,
        // CI fails and they must update the discovery document, the `/ready`
        // probe and this list together — the three places that claim to know
        // what works.
        //
        // Note what is *not* here: Health and Ready are implemented, and
        // asserting they are not would be asserting a lie. The rule is that
        // no protocol route is implemented, and the two health routes are not
        // protocol routes.
        for route in Route::ALL {
            if matches!(route, Route::Health | Route::Ready) {
                assert!(
                    route.is_implemented(),
                    "{route:?} is live and must say so; a false negative here \
                     would send the smoke test to a route that answers"
                );
                continue;
            }
            assert!(
                !route.is_implemented(),
                "{route:?} claims to be implemented; update is_implemented, the \
                 discovery document and the /ready probe together"
            );
        }
    }

    #[test]
    fn exactly_the_two_health_routes_are_live() {
        let live: Vec<&str> = Route::ALL
            .iter()
            .filter(|r| r.is_implemented())
            .map(|r| r.path())
            .collect();
        assert_eq!(live, ["/health", "/ready"]);
    }

    #[test]
    fn the_health_routes_are_the_only_implemented_ones() {
        let implemented: Vec<&Route> = Route::ALL.iter().filter(|r| r.is_implemented()).collect();
        assert_eq!(implemented.len(), 2, "only /health and /ready are live");
        assert!(Route::Health.is_implemented());
        assert!(Route::Ready.is_implemented());
    }

    #[test]
    fn a_declared_route_is_never_also_undeclared() {
        // The two predicates are complementary by construction. A route must
        // be one or the other, never neither (which would mean the 404 path
        // for something the discovery document promises).
        for route in Route::ALL {
            assert_ne!(
                route.is_implemented(),
                route.is_declared_but_unimplemented(),
                "{route:?} is in neither state"
            );
        }
    }
}
