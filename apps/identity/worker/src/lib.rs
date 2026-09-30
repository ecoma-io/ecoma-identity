//! The Identity Worker — the composition root for the `identity` deployable.
//!
//! # What this Worker serves today, exactly
//!
//! Nine declared paths, and nothing else. Seven of them are protocol routes
//! this bootstrap has not built, and each answers **501** with the
//! `not_implemented` envelope. The two probes answer **200**. Any other path
//! answers **404**, because a path this provider never declared is a different
//! fact from a path it declared and has not built.
//!
//! **Authentication is not implemented.** Nothing in this crate verifies a
//! credential, issues a token, creates a session or writes a row. The route
//! table existing is not the flows existing, and the readiness probe says so on
//! the wire in [`ReadinessReport`]. A reader who wants one place that answers
//! "what can this actually do" should read that struct and [`RoutePlan`].
//!
//! # What this crate is, and is not
//!
//! Wiring: the `#[event(fetch)]` shell, the one binding name this Worker holds,
//! and the dispatch between a path and a plan. **Not** policy. The route table
//! is `identity_oidc::route::Route`; the response builder, the error envelope
//! and the code-to-status mapping are `identity_cloudflare`'s. None of those is
//! written here, which is the point: three Workers that each spelled the
//! envelope themselves would drift on the first security fix.
//!
//! # Why the decision is a pure function
//!
//! [`plan`] takes a path and returns a [`RoutePlan`], and [`RoutePlan::body`]
//! turns a plan into a JSON body. Neither takes a `worker::Request`, a
//! `worker::Env` or an async anything. The 501/404/2xx split — the part that is
//! easy to get quietly wrong, and the part every document in this repository
//! makes a claim about — is therefore testable on the host with no Workers
//! runtime, and the tests at the bottom of this file are the reason. The wasm
//! shell around them is four lines of plumbing and is deliberately not the part
//! carrying the proof.

#![deny(missing_docs)]

use identity_application::error::ApplicationError;
use identity_cloudflare::error::{CloudflareError, ErrorEnvelope, TransportError};
use identity_cloudflare::response::ResponseBuilder;
use identity_oidc::route::{self, Route};
use serde::Serialize;

/// The deployable's name, as `wrangler`, the moon alias, the release-please
/// component and the Cloudflare version tag all spell it.
///
/// The composition root is where a deployable's name belongs: it is the one
/// place per Worker that is about the deployment rather than about a request.
pub const SERVICE: &str = "identity";

/// The D1 binding this Worker is the sole holder of.
///
/// `identity` is the only deployable permitted to hold `IDENTITY_DB`
/// (`docs/architecture/worker-architecture.md`, ADR-0003). This crate reads the
/// binding's presence for the readiness probe and nothing else: no route
/// reaches identity state yet, and a `D1Database` nothing uses is dead code
/// wearing the costume of wiring. The handle itself is taken when the first
/// handler that reads identity state lands, through `identity-application`'s
/// ports and never by writing SQL here.
pub const IDENTITY_DB_BINDING: &str = "IDENTITY_DB";

/// The header the platform's request id arrives in.
///
/// The same header `identity_cloudflare::request::IncomingRequest` reads for
/// its `request_id` field, and the same one the three Workers must agree on:
/// three different request-id headers is three log lines an operator cannot
/// join.
const REQUEST_ID_HEADER: &str = "cf-ray";

/// The status the two probe routes answer with.
///
/// 200, and the reason is worth stating because in isolation it reads as a
/// lie. The deploy workflow's smoke step requires a 2xx from `/health` and
/// `/ready` on an uploaded version, and the canary ladder's health gate aborts
/// on a failed probe. So a 200 here means **the Worker is up and answered** —
/// and it means nothing else. "This instance may authenticate someone" is
/// [`ReadinessReport::ready`], which is `false`, and
/// [`ReadinessReport::authentication`] which is `not_implemented`.
pub const PROBE_OK: u16 = 200;

/// The status a declared-but-unimplemented route answers with.
///
/// 501, deliberately outside the closed
/// `identity_cloudflare::error::HttpStatus` set. A client that sees 501 stops
/// trying; a client that sees 500 retries, which for an endpoint that will
/// never exist is a retry storm against a route that cannot be fixed by
/// retrying.
///
/// It is also deliberately **not** `ErrorEnvelope::status()`, which maps the
/// `not_implemented` code to 500. This constant is what reaches the wire; the
/// envelope's own mapping is a different question with a different answer, and
/// the test `the_501_is_not_the_envelopes_own_status` pins the difference so a
/// change to either side is noticed.
pub const NOT_IMPLEMENTED: u16 = 501;

/// The status a path this provider does not declare answers with.
///
/// 404, and unlike [`NOT_IMPLEMENTED`] this one *is*
/// `ErrorEnvelope::status()` for the `not_found` code. The two cases differ
/// because the two facts differ: "you asked for something that does not exist"
/// and "this exists and has not been built" are different answers, and a client
/// that cannot tell them apart cannot decide whether to stop.
pub const NOT_FOUND: u16 = 404;

/// The code `TransportError::Unimplemented` produces, and the string the
/// readiness probe reports authentication as.
///
/// One vocabulary, deliberately: a client that sees `"not_implemented"` in a
/// 501 body and reads `"not_implemented"` in the readiness report is being told
/// the same thing twice by the same system, and it is one string in one
/// constant rather than two spellings in two files. The test
/// `the_readiness_report_and_the_501_envelope_agree_on_the_code` pins it.
pub const AUTHENTICATION_STATUS: &str = "not_implemented";

/// The entity name a 404 envelope reports.
const UNDECLARED_ROUTE: &str = "route";

/// What `/health` says on the wire, spelled out so the sentence a client reads
/// is the sentence this crate means.
const HEALTH_DETAIL: &str =
    "liveness only: the Worker answered this probe. No identity capability is implied.";

/// What `/ready` says on the wire.
const READINESS_DETAIL: &str = "authentication is not implemented; every declared protocol \
                                 route answers 501";

/// The `identity_database` value when the binding resolved.
const IDENTITY_DB_PRESENT: &str = "bound";

/// The `identity_database` value when the binding did not resolve.
const IDENTITY_DB_ABSENT: &str = "absent";

/// How many declared **protocol** routes exist, and how many of them are built.
///
/// Protocol routes only, and the exclusion is the whole point of the type.
/// `Route::ALL` contains `/health` and `/ready` as well, and
/// `Route::is_implemented()` returns `true` for those two — deliberately, and
/// documented as being a statement about the _protocol surface_ rather than
/// about a running binary. Counting every entry of `ALL` here would put
/// `"implemented": 2` on a readiness report for a provider that authenticates
/// nobody, which is exactly the overstatement the status vocabulary exists to
/// prevent. The two probes are reported by the probe that answered and by
/// `ok`, and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProtocolRouteStatus {
    /// The protocol routes in `identity_oidc::route::Route::ALL` — every entry
    /// except the two the table calls probes.
    pub declared: usize,
    /// How many of those `Route::is_implemented()` claims. Zero today, and a
    /// non-zero value here is a claim that a protocol flow works.
    pub implemented: usize,
    /// The path of each unimplemented protocol route, in the route table's own
    /// order.
    pub unimplemented: Vec<&'static str>,
}

/// The body `/health` answers with.
///
/// Liveness, and liveness only. There is no field here that a reader could
/// mistake for "this service authenticates people", which is the only property
/// this type has to have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HealthReport {
    /// That the probe answered. **Not** a claim that any identity capability
    /// works — see [`ReadinessReport::ready`] for that question.
    pub ok: bool,
    /// The deployable that answered.
    pub service: &'static str,
    /// What `ok` means here, in words, on the wire.
    pub detail: &'static str,
}

impl HealthReport {
    /// The report this Worker answers `/health` with. The same body every
    /// time, because liveness is a property of the process and not of the
    /// request that asked.
    #[must_use]
    pub const fn current() -> Self {
        Self {
            ok: true,
            service: SERVICE,
            detail: HEALTH_DETAIL,
        }
    }
}

/// The body `/ready` answers with.
///
/// This is the honesty endpoint, and the whole reason it exists is that a
/// readiness report which says "ready" about a system that cannot authenticate
/// anybody is the failure mode the repository's status vocabulary was written
/// to prevent. So `ready` is `false`, `authentication` is
/// [`AUTHENTICATION_STATUS`], and `protocol_routes.implemented` is `0` — every
/// one of them read from `Route::is_implemented()`, which is the same function
/// the dispatcher, the smoke test and `identity-oidc`'s own tests read. The
/// answer is one function, so it cannot differ between the four.
///
/// The status is still [`PROBE_OK`], because the deploy ladder needs a 200 on
/// `/ready` to promote a version and a 200 here means "the Worker answered",
/// not "this instance can authenticate". That distinction is the reason the
/// body carries `ok` and `ready` as two fields and not one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadinessReport {
    /// That the probe answered. Liveness of the probe, not of the service.
    pub ok: bool,
    /// Whether this instance may receive traffic that authenticates somebody.
    /// **False**, and it stays false until the authentication phases land.
    /// Nothing in this crate can set it true: there is no path from a request
    /// to that field, which is what makes it a claim rather than a setting.
    pub ready: bool,
    /// The deployable that answered.
    pub service: &'static str,
    /// The authentication status, in the error contract's own code vocabulary.
    pub authentication: &'static str,
    /// Whether this Worker resolved its `IDENTITY_DB` binding. A real
    /// readiness fact, and the only binding state this probe reports: the
    /// others are declared in `.generated/cloudflare/` and none of them is read yet.
    pub identity_database: &'static str,
    /// The declared protocol routes and how many are built.
    pub protocol_routes: ProtocolRouteStatus,
    /// The sentence a human reads.
    pub detail: &'static str,
}

impl ReadinessReport {
    /// The report for this Worker, given whether its `IDENTITY_DB` binding
    /// resolved.
    ///
    /// A function of one boolean rather than of the `Env`, so a host test can
    /// assert both branches and the wasm shell stays a lookup.
    #[must_use]
    pub fn current(identity_database_bound: bool) -> Self {
        Self {
            ok: true,
            ready: false,
            service: SERVICE,
            authentication: AUTHENTICATION_STATUS,
            identity_database: if identity_database_bound {
                IDENTITY_DB_PRESENT
            } else {
                IDENTITY_DB_ABSENT
            },
            protocol_routes: protocol_route_status(),
            detail: READINESS_DETAIL,
        }
    }
}

/// The response a request path resolves to.
///
/// The decision, and nothing else: no `worker::Response`, no `Env`, no I/O.
/// Every routing test in this file is a test of this type, which is the whole
/// reason it is a type rather than a `match` inside the handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutePlan {
    /// `/health`. Liveness. Answers [`PROBE_OK`].
    Health,
    /// `/ready`. Readiness, reporting that authentication is not implemented.
    /// Answers [`PROBE_OK`].
    Ready,
    /// A declared route this bootstrap has not built. Answers
    /// [`NOT_IMPLEMENTED`] with a `not_implemented` envelope.
    NotImplemented(Route),
    /// A path this provider does not declare at all. Answers [`NOT_FOUND`]
    /// with a `not_found` envelope.
    NotFound,
}

impl RoutePlan {
    /// The status this plan answers with, on the wire.
    ///
    /// For [`RoutePlan::NotImplemented`] this is [`NOT_IMPLEMENTED`] and not
    /// the envelope's own `status()`. See that constant for why.
    #[must_use]
    pub const fn status(self) -> u16 {
        match self {
            Self::Health | Self::Ready => PROBE_OK,
            Self::NotImplemented(_) => NOT_IMPLEMENTED,
            Self::NotFound => NOT_FOUND,
        }
    }

    /// The route this plan resolved to, or `None` for a path this provider does
    /// not declare.
    #[must_use]
    pub const fn route(self) -> Option<Route> {
        match self {
            Self::Health => Some(Route::Health),
            Self::Ready => Some(Route::Ready),
            Self::NotImplemented(route) => Some(route),
            Self::NotFound => None,
        }
    }

    /// The body this plan answers with.
    ///
    /// Total, not an `Option`: the probes and the errors are the same
    /// question with two answers, and making the caller unwrap which one it got
    /// is a chance to `unwrap()` in a request path.
    #[must_use]
    pub fn body(self, request_id: Option<&str>, identity_database_bound: bool) -> PlanBody {
        match self {
            Self::Health => PlanBody::Health(HealthReport::current()),
            Self::Ready => PlanBody::Ready(ReadinessReport::current(identity_database_bound)),
            Self::NotImplemented(route) => {
                // `TransportError::Unimplemented` rather than
                // `ApplicationError::NotImplemented`: both render the code
                // `not_implemented`, and only this one renders the message the
                // contract fixes —
                // `contracts/shared/v1/not-implemented-envelope.schema.json`
                // spells it as `UNIMPLEMENTED_MESSAGE` plus the parenthesised
                // operation name. The operation named here is the route's own
                // path, so the body tells the client which of its endpoints is
                // the one that does not exist yet.
                PlanBody::Envelope(scaffolded_envelope(
                    &CloudflareError::transport(TransportError::Unimplemented {
                        operation: route.path(),
                    }),
                    request_id,
                ))
            }
            Self::NotFound => PlanBody::Envelope(scaffolded_envelope(
                &CloudflareError::from(ApplicationError::NotFound {
                    entity: UNDECLARED_ROUTE,
                }),
                request_id,
            )),
        }
    }
}

/// The body a [`RoutePlan`] answers with, as one serialisable value.
///
/// Untagged on the wire, so the JSON is the probe body or the error envelope
/// itself rather than a wrapper naming which of the two it is. The variants
/// stay separate in Rust because the two answers are built and sent by
/// different builder calls — `.json` for a probe, `.envelope` for an error, and
/// the second sets `X-Ecoma-Error-Code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PlanBody {
    /// The liveness body.
    Health(HealthReport),
    /// The readiness body.
    Ready(ReadinessReport),
    /// An error envelope: the 501 a declared route answers, or the 404 an
    /// undeclared path answers.
    Envelope(ErrorEnvelope),
}

impl PlanBody {
    /// Whether this body is one of the two probes rather than an error.
    #[must_use]
    pub const fn is_probe(&self) -> bool {
        matches!(self, Self::Health(_) | Self::Ready(_))
    }

    /// The envelope, when this body is one.
    #[must_use]
    pub const fn envelope(&self) -> Option<&ErrorEnvelope> {
        match self {
            Self::Envelope(envelope) => Some(envelope),
            Self::Health(_) | Self::Ready(_) => None,
        }
    }
}

/// Build the wire envelope for a failure, with the request id on it when the
/// platform supplied one.
fn scaffolded_envelope(error: &CloudflareError, request_id: Option<&str>) -> ErrorEnvelope {
    error.envelope(request_id.map(str::to_owned))
}

/// Count the protocol routes in the table, excluding the two probes.
///
/// The exclusion is `is_declared_but_unimplemented()` rather than a hand-written
/// list of `Health | Ready`, and the difference matters: a list of two names
/// would have to be edited when a third probe was added, and a probe silently
/// entering the protocol count is the exact overstatement this report must not
/// make. The predicate is the route table's own statement of what is a
/// declared-but-unimplemented route, so the count follows the table instead of
/// a copy of it.
fn protocol_route_status() -> ProtocolRouteStatus {
    let protocol: Vec<Route> = Route::ALL
        .iter()
        .copied()
        .filter(|r| !matches!(r, Route::Health | Route::Ready))
        .collect();
    ProtocolRouteStatus {
        declared: protocol.len(),
        implemented: protocol.iter().filter(|r| r.is_implemented()).count(),
        unimplemented: protocol
            .iter()
            .filter(|r| r.is_declared_but_unimplemented())
            .map(|r| r.path())
            .collect(),
    }
}

/// Resolve a request path to the response this Worker gives it.
///
/// The routing decision, as one pure function over one string, so the 501 /
/// 404 / 2xx split is testable on the host and cannot drift from the route
/// table: the paths come from `identity_oidc::route::find_by_path`, and
/// nothing here restates one.
///
/// Note what the input is not. There is no method, and that is deliberate: the
/// answer must not depend on whether the caller said `GET` or `POST`, because a
/// route that has no behaviour yet has no behaviour to get wrong per method, and
/// a dispatcher that branched on the method would be a place to add a method
/// rule with no rule behind it. When a protocol route gains a method contract,
/// it gains one here and in the contract at the same time.
///
/// The match is on the route, not on `Route::is_implemented()`. A dispatcher
/// that read that function would answer 501 for a route the table had started
/// claiming was built — a 501 on a route someone believes is implemented is a
/// lie in the direction nobody tests for. Instead the two are held together by
/// a test,
/// `the_dispatcher_and_the_route_table_agree_about_what_is_implemented`,
/// which fails the moment a route is marked implemented without a handler
/// landing here in the same commit.
#[must_use]
pub fn plan(path: &str) -> RoutePlan {
    match route::find_by_path(path) {
        Some(Route::Health) => RoutePlan::Health,
        Some(Route::Ready) => RoutePlan::Ready,
        Some(route) => RoutePlan::NotImplemented(route),
        None => RoutePlan::NotFound,
    }
}

/// The `fetch` entrypoint Cloudflare's runtime calls.
///
/// Four lines of plumbing around [`plan`]: resolve the path, resolve the one
/// binding the readiness probe reports on, and hand both to the body builder.
/// Every decision worth a test is below it in a function that takes a `&str`.
///
/// Failing to build a response is propagated rather than answered with a
/// fallback envelope, and the reason is not brevity: the only way to build the
/// fallback is the same builder that just failed. The runtime logs the failure
/// and answers 500, which is the right answer for "our fault" and the only one
/// that is true.
///
/// # Errors
///
/// `worker::Error::RustError` when `identity_cloudflare`'s
/// `ResponseBuilder` cannot materialise the response — a header the platform
/// rejects, or a body that will not serialise. Neither is reachable for any
/// path this Worker serves: every header is a literal from
/// `identity_cloudflare`, and every body is one of the three serialisable
/// types in this crate. It is propagated rather than substituted because a
/// substituted answer would have to be built by the same builder that just
/// failed, and a fallback that can fail the same way is not a fallback.
#[worker::event(fetch)]
pub async fn fetch(
    req: worker::Request,
    env: worker::Env,
    _ctx: worker::Context,
) -> worker::Result<worker::Response> {
    let plan = plan(&req.path());
    let request_id = match req.headers().get(REQUEST_ID_HEADER) {
        Ok(request_id) => request_id,
        Err(e) => {
            // Loud rather than silent: a probe that cannot name its request is
            // still a probe, and a header read that failed is worth an
            // operator's attention even though the answer is unaffected.
            worker::console_error!("identity: could not read the {REQUEST_ID_HEADER} header: {e}");
            None
        }
    };
    let identity_database_bound = identity_database_bound(&env);

    match plan.body(request_id.as_deref(), identity_database_bound) {
        PlanBody::Health(report) => ResponseBuilder::new(plan.status()).json(&report),
        PlanBody::Ready(report) => ResponseBuilder::new(plan.status()).json(&report),
        PlanBody::Envelope(envelope) => ResponseBuilder::new(plan.status()).envelope(&envelope),
    }
    .map_err(|error| worker::Error::RustError(error.to_string()))
}

/// Whether this Worker's `IDENTITY_DB` binding resolved.
///
/// Presence, not usability: a D1 handle cannot be validated without issuing a
/// query against it, and a readiness probe that writes to the database to check
/// the database is a probe with a side effect. The binding's absence is the
/// fact worth reporting, and it is the one a misconfigured `wrangler.jsonc`
/// produces.
fn identity_database_bound(env: &worker::Env) -> bool {
    match env.d1(IDENTITY_DB_BINDING) {
        Ok(_) => true,
        Err(e) => {
            worker::console_error!(
                "identity: the {IDENTITY_DB_BINDING} binding did not resolve: {e}"
            );
            false
        }
    }
}

/// The status the `not_implemented` code maps to through the envelope's own
/// mapping, and the 500 that the closed `HttpStatus` set sends it to.
///
/// Only the test module reads this. It is a function rather than a constant so
/// the assertion is against what the table *produces* rather than against a
/// second copy of 500 somebody could change without noticing: the divergence
/// between this and [`NOT_IMPLEMENTED`] is a property of
/// `identity_cloudflare`'s mapping, and a test that re-spells it here would
/// pass after that mapping changed.
#[cfg(test)]
const fn not_implemented_envelope_status() -> u16 {
    identity_cloudflare::error::HttpStatus::InternalServerError.as_u16()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seven protocol routes, spelled out rather than derived, so a route
    /// added to the table without a decision here fails a test with a readable
    /// message instead of silently joining whichever arm it happened to fall
    /// into.
    const PROTOCOL_PATHS: [&str; 7] = [
        "/.well-known/openid-configuration",
        "/.well-known/jwks.json",
        "/oauth/authorize",
        "/oauth/token",
        "/oauth/userinfo",
        "/oauth/revoke",
        "/oauth/logout",
    ];

    /// Paths a caller might reasonably send that this provider has never
    /// declared. Each must be a 404, and none of them may be answered as a
    /// 501: answering a path the discovery document never promised as
    /// "declared but not built" would tell a scanner that an endpoint exists
    /// here when it does not.
    const UNDECLARED_PATHS: [&str; 8] = [
        "/",
        "/oauth",
        "/oauth/",
        "/oauth/nope",
        "/health/",
        "/readyx",
        "/HEALTH",
        "/.well-known/",
    ];

    fn envelope_for(path: &str) -> ErrorEnvelope {
        plan(path)
            .body(None, true)
            .envelope()
            .cloned()
            .unwrap_or_else(|| panic!("{path} must be answered with an error envelope"))
    }

    #[test]
    fn every_declared_protocol_route_is_answered_501() {
        for path in PROTOCOL_PATHS {
            let plan = plan(path);
            assert_eq!(plan.status(), NOT_IMPLEMENTED, "{path} must answer 501");
            let envelope = envelope_for(path);
            assert_eq!(envelope.code, "not_implemented", "{path}");
            assert!(envelope.client_safe, "{path}");
        }
    }

    #[test]
    fn the_501_body_is_the_one_the_contract_fixes() {
        // `contracts/shared/v1/not-implemented-envelope.schema.json` pins the
        // rendering: `UNIMPLEMENTED_MESSAGE` plus the parenthesised operation
        // name, and the operation is the route's own path so a client can tell
        // which of its endpoints is the one that does not exist.
        let envelope = envelope_for("/oauth/token");
        assert_eq!(
            envelope.message,
            "this operation is not implemented yet (/oauth/token)"
        );
        assert!(
            envelope.message.contains("/oauth/token"),
            "{}",
            envelope.message
        );

        let body = serde_json::to_value(
            plan("/oauth/token")
                .body(None, true)
                .envelope()
                .expect("501 answers an envelope"),
        )
        .expect("the envelope serialises");
        assert_eq!(body["code"], "not_implemented");
        assert_eq!(body["client_safe"], true);
        assert_eq!(body["message"], envelope.message);
    }

    #[test]
    fn the_two_probes_are_answered_200() {
        assert_eq!(plan("/health"), RoutePlan::Health);
        assert_eq!(plan("/ready"), RoutePlan::Ready);
        assert_eq!(plan("/health").status(), PROBE_OK);
        assert_eq!(plan("/ready").status(), PROBE_OK);
    }

    #[test]
    fn a_probe_answers_its_own_body_and_never_an_error_envelope() {
        let health = plan("/health").body(None, true);
        assert!(health.is_probe());
        assert!(health.envelope().is_none());
        assert_eq!(health, PlanBody::Health(HealthReport::current()));

        let ready = plan("/ready").body(None, true);
        assert!(ready.is_probe());
        assert!(ready.envelope().is_none());
        assert_eq!(ready, PlanBody::Ready(ReadinessReport::current(true)));
    }

    #[test]
    fn a_path_this_provider_does_not_declare_is_answered_404() {
        for path in UNDECLARED_PATHS {
            let plan = plan(path);
            assert_eq!(plan, RoutePlan::NotFound, "{path} is not a declared route");
            assert_eq!(plan.status(), NOT_FOUND, "{path}");
            assert!(plan.route().is_none(), "{path} names no route");
            let envelope = envelope_for(path);
            assert_eq!(envelope.code, "not_found", "{path}");
        }
    }

    #[test]
    fn the_404_envelope_carries_no_trace_of_the_path_that_was_asked_for() {
        // A client supplied the path, so echoing it tells them nothing they did
        // not know, and a body that reflects a probe's input is a body that can
        // be pushed around. The envelope names the entity, not the string.
        let envelope = envelope_for("/oauth/nope");
        assert_eq!(envelope.message, "route not found");
        assert!(
            !envelope.message.contains("/oauth/nope"),
            "{}",
            envelope.message
        );
    }

    #[test]
    fn the_dispatcher_and_the_route_table_agree_about_what_is_implemented() {
        // The one test that holds `plan` to `Route::is_implemented()`.
        //
        // `plan` matches on the route rather than reading `is_implemented()`,
        // because a dispatcher that read it would answer 501 on a route the
        // table had started calling built. This test is the other end of that
        // choice: flip a route to implemented without landing a handler here
        // and this fails, naming the route, in the same commit as the flip.
        for route in Route::ALL.iter().copied() {
            let plan = plan(route.path());
            assert_eq!(
                plan.route(),
                Some(route),
                "{} must resolve to itself",
                route.path()
            );
            if route.is_implemented() {
                assert!(
                    matches!(plan, RoutePlan::Health | RoutePlan::Ready),
                    "{} claims to be implemented, so it must be answered 200, not {}",
                    route.path(),
                    plan.status()
                );
            } else {
                assert_eq!(
                    plan,
                    RoutePlan::NotImplemented(route),
                    "{} is declared but unimplemented, so it must answer 501 — if it \
                     now answers something else, implement it in this crate and update \
                     the discovery document, the /ready probe and docs/README.md in \
                     this same commit",
                    route.path()
                );
            }
        }
    }

    #[test]
    fn the_protocol_path_list_matches_the_route_table() {
        // Keeps `PROTOCOL_PATHS` honest in both directions: a path added to
        // the table without a test entry, and a test entry that names a path
        // the table dropped.
        let declared: Vec<&str> = Route::ALL
            .iter()
            .filter(|r| !r.is_implemented())
            .map(|r| r.path())
            .collect();
        assert_eq!(declared, PROTOCOL_PATHS);
    }

    #[test]
    fn a_200_body_is_never_an_envelope_and_an_error_body_is_never_a_probe() {
        // The invariant the `PlanBody` split rests on, checked over every
        // declared path and a sample of undeclared ones, so that adding a
        // variant later cannot quietly produce a 200 that carries a
        // `not_implemented` body or a 501 that carries a probe's.
        let mut paths: Vec<&str> = Route::ALL.iter().map(|r| r.path()).collect();
        paths.extend(UNDECLARED_PATHS);
        for path in paths {
            let plan = plan(path);
            let body = plan.body(None, true);
            assert_eq!(
                body.is_probe(),
                plan.status() == PROBE_OK,
                "{path}: a {} answer must {}",
                plan.status(),
                if body.is_probe() {
                    "carry a probe"
                } else {
                    "carry an envelope"
                }
            );
        }
    }

    #[test]
    fn the_501_is_not_the_envelopes_own_status() {
        // The divergence the contract fixes, pinned from both sides. 501 is
        // deliberately outside the closed `HttpStatus` set, so
        // `ErrorEnvelope::status()` answers 500 for this code; the status that
        // reaches the wire is [`NOT_IMPLEMENTED`]. If a future change moves
        // `not_implemented` into the closed set, this fails and the decision
        // gets made on purpose rather than by a table edit.
        let envelope = envelope_for("/oauth/authorize");
        assert_eq!(
            envelope.status().as_u16(),
            not_implemented_envelope_status()
        );
        assert_eq!(not_implemented_envelope_status(), 500);
        assert_ne!(envelope.status().as_u16(), NOT_IMPLEMENTED);
        assert_eq!(plan("/oauth/authorize").status(), NOT_IMPLEMENTED);
    }

    #[test]
    fn the_404_is_the_envelopes_own_status() {
        // The contrast that makes the 501 divergence a decision rather than an
        // oversight: `not_found` *is* in the closed set, so the envelope and
        // the wire agree, and the 501 is the one case where they must not.
        let envelope = envelope_for("/nope");
        assert_eq!(envelope.status().as_u16(), NOT_FOUND);
        assert_eq!(plan("/nope").status(), envelope.status().as_u16());
    }

    #[test]
    fn the_request_id_is_carried_into_the_envelope_and_omitted_when_absent() {
        let body = plan("/oauth/token").body(Some("ray-1234"), true);
        assert_eq!(
            body.envelope()
                .expect("501 answers an envelope")
                .request_id
                .as_deref(),
            Some("ray-1234")
        );

        let without = plan("/oauth/token").body(None, true);
        let json = serde_json::to_value(&without).expect("the body serialises");
        assert!(
            !json
                .as_object()
                .expect("an object")
                .contains_key("request_id"),
            "an absent request id is omitted, not null: {json}"
        );
    }

    #[test]
    fn the_readiness_report_does_not_report_readiness() {
        // The single assertion the whole endpoint exists for.
        let report = ReadinessReport::current(true);
        assert!(!report.ready, "/ready must not report a ready service");
        assert!(report.ok, "the probe itself answered");
        assert_eq!(report.authentication, "not_implemented");
    }

    #[test]
    fn the_readiness_report_counts_the_route_table() {
        let report = ReadinessReport::current(true);
        // `Route::ALL` carries the two probes as well, and counting those here
        // would report `"implemented": 2` for a provider that authenticates
        // nobody. The count is over protocol routes only, which is the whole
        // reason `ProtocolRouteStatus` excludes `Health` and `Ready`.
        assert_eq!(report.protocol_routes.declared, PROTOCOL_PATHS.len());
        assert!(
            report.protocol_routes.declared < Route::ALL.len(),
            "the protocol count must exclude the two probes"
        );
        assert_eq!(report.protocol_routes.implemented, 0);
        assert_eq!(report.protocol_routes.unimplemented, PROTOCOL_PATHS);
        assert_eq!(report.service, "identity");
    }

    #[test]
    fn the_two_probes_are_not_counted_as_protocol_routes() {
        // The exclusion stated as an assertion, so the next person to add a
        // route to `Route::ALL` finds out here whether their route is a
        // protocol route or a probe rather than discovering it in a readiness
        // body in production.
        let report = ReadinessReport::current(true);
        for path in &report.protocol_routes.unimplemented {
            assert!(
                !matches!(
                    identity_oidc::route::find_by_path(path),
                    Some(Route::Health | Route::Ready)
                ),
                "{path} is a probe and must not be counted as a protocol route"
            );
        }
        let unimplemented = report
            .protocol_routes
            .unimplemented
            .iter()
            .filter(|p| {
                !Route::ALL
                    .iter()
                    .any(|r| r.is_implemented() && r.path() == **p)
            })
            .count();
        assert_eq!(unimplemented, report.protocol_routes.declared);
    }

    #[test]
    fn every_path_the_readiness_report_lists_unimplemented_is_answered_501() {
        // `/ready` and the dispatcher are two readers of one table; a report
        // naming a route as unimplemented that the dispatcher does not answer
        // 501 is the drift this whole repository's status vocabulary exists to
        // prevent, and it is checked here rather than trusted to review.
        let report = ReadinessReport::current(true);
        for path in &report.protocol_routes.unimplemented {
            assert_eq!(
                plan(path).status(),
                NOT_IMPLEMENTED,
                "{path} is reported unimplemented, so it must be answered 501"
            );
        }
    }

    #[test]
    fn the_readiness_report_and_the_501_envelope_agree_on_the_code() {
        // One vocabulary for one fact. A client that reads
        // `"not_implemented"` in a 501 body and `"not_implemented"` in the
        // readiness report is being told the same thing by the same system, and
        // the two must not become two spellings.
        assert_eq!(
            AUTHENTICATION_STATUS,
            envelope_for("/oauth/authorize").code.as_str()
        );
    }

    #[test]
    fn the_readiness_report_states_the_identity_database_binding_either_way() {
        assert_eq!(ReadinessReport::current(true).identity_database, "bound");
        assert_eq!(
            ReadinessReport::current(false).identity_database,
            "absent",
            "a misconfigured wrangler.jsonc must be visible on the wire, not hidden \
             behind a probe that always says bound"
        );
    }

    #[test]
    fn the_health_report_claims_nothing_beyond_liveness() {
        // A liveness body with a capability field in it is how a probe starts
        // being read as a status page. The key set is asserted rather than
        // merely the values, so adding a field to this struct is a visible
        // decision.
        let body = serde_json::to_value(HealthReport::current()).expect("serialises");
        let keys: Vec<&str> = body
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["detail", "ok", "service"]);
        assert_eq!(body["ok"], true);
        assert_eq!(body["service"], "identity");
    }

    #[test]
    fn the_readiness_body_serialises_the_fields_a_client_branches_on() {
        let body = serde_json::to_value(ReadinessReport::current(true)).expect("serialises");
        assert_eq!(body["ready"], false);
        assert_eq!(body["authentication"], "not_implemented");
        assert_eq!(body["identity_database"], "bound");
        assert_eq!(body["protocol_routes"]["implemented"], 0);
        assert_eq!(
            body["protocol_routes"]["declared"],
            PROTOCOL_PATHS.len(),
            "the report's own count is read off the route table, not hard-coded, and \
             it excludes the two probes the dispatcher answers directly"
        );
        assert_eq!(
            body["protocol_routes"]["unimplemented"],
            serde_json::json!(PROTOCOL_PATHS)
        );
    }

    // -----------------------------------------------------------------------
    // What is NOT tested here, and why.
    //
    // The `#[event(fetch)]` shell: reading a path off a `worker::Request`,
    // looking up a binding on a `worker::Env` and materialising a
    // `worker::Response` all need a Workers runtime. Testing them needs
    // `wasm_bindgen_test`, which is a dev-dependency this crate does not have
    // and is not getting: the alternative would be a test module that does not
    // compile for the host, or one whose assertions cannot run in any pipeline
    // this repository has, and a test nobody runs is a comment wearing a
    // test's clothes.
    //
    // What is tested instead is the part worth proving. The shell is four
    // lines of plumbing between a path and [`RoutePlan::body`], and every
    // decision it could get wrong — which status, which envelope, which body,
    // which route table entry — is a function of a `&str` and a `bool` and is
    // asserted above. The smoke test in `.github/workflows/deploy-worker.yml`
    // exercises the shell itself against an uploaded version, which is the
    // only place it can honestly be exercised.
    // -----------------------------------------------------------------------
}
