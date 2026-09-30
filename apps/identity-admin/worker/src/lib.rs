//! The Admin Worker: the administrative BFF.
//!
//! # What this Worker serves today
//!
//! Two routes answer for real, and nothing else does:
//!
//! - `GET /health` — 200, `{"status":"ok"}`. Liveness. The process is up.
//! - `GET /ready` — 503, and a body that says *which* routes are missing. The
//!   process is running, but every administrative feature is deferred, and a
//!   readiness probe that answered 200 here would be a lie an orchestrator
//!   would act on.
//!
//! Every other declared route answers **501** with the `not_implemented`
//! envelope (`code: "not_implemented"`, `client_safe: true`). Every path that
//! is not in the route table answers **404** with the `not_found` envelope.
//!
//! # What this Worker does NOT do
//!
//! **Authentication is not implemented.** `/admin/session` is declared and
//! answers 501, so there is no operator session, no credential check, and no
//! authorization decision anywhere in this file. There is no bypass either —
//! no flag, no environment variable, no dev role (ADR-0009). A route that
//! answers 501 cannot be reached by getting past authentication, because there
//! is nothing behind it.
//!
//! **It holds no database.** There is no `D1Database` here and no `IDENTITY_DB`
//! binding in
//! `infra/cloudflare/development/identity-admin/wrangler.jsonc`. Identity is
//! reached, when a handler exists, through the private `IDENTITY` service
//! binding and nothing else. `docs/architecture/admin-isolation.md` owns that
//! argument and `tooling/scripts/check-architecture.mjs` enforces it.
//!
//! # The shape of this file
//!
//! [`plan`] is a pure function from a path to a status and a body, so the
//! 501/404/live split is covered by ordinary `cargo test` on the host with no
//! Workers runtime. The `#[event(fetch)]` shell below it does three things —
//! read the path, hand it to `plan`, turn the answer into a `worker::Response`
//! — and holds no policy of its own. Every response is built by
//! `identity_cloudflare`'s `ResponseBuilder`, which is where the three baseline
//! headers are applied; this file constructs no `Response` by hand.
//!
//! # What is deliberately absent
//!
//! A `500`-shaped path, a method check, a CSRF check, a rate-limit call, a
//! service-binding call and the `Env`. Each of those is a decision that needs
//! the real thing behind it, and a stub of any of them here would be a green
//! path that proves nothing — which is the failure mode
//! `docs/architecture/worker-architecture.md` calls worse than a documented
//! hole. The `AdminRoute::is_implemented` table is the honest inventory, and
//! `plan` reads it rather than a second list that could disagree with it.

use identity_application::admin_routes::{self, AdminRoute};
use identity_cloudflare::error::{CloudflareError, ErrorEnvelope, HttpStatus, TransportError};
use identity_cloudflare::response::ResponseBuilder;
use serde::Serialize;
use worker::{Env, Request, Response as WorkerResponse, event};

/// The result this file's helpers return.
///
/// `identity_cloudflare`'s own `Result`, not `worker::Result`: the adapter's
/// `CloudflareError` is the only error type that knows how to become a
/// well-formed envelope, and a `worker::Error` on its way out of this Worker
/// becomes a platform-generated response nobody in this codebase shaped.
type Result<T> = core::result::Result<T, CloudflareError>;

/// Turn a `worker::Error` into the adapter's transport failure.
///
/// A `worker::Error` is a platform string, and `TransportError::Platform` is
/// the variant that is *never* forwarded to a client: the envelope it produces
/// carries `OPAQUE_MESSAGE` and `client_safe: false`. That is the only
/// conversion that keeps a platform error message from reaching a browser.
fn platform_failure(operation: &'static str, error: &worker::Error) -> CloudflareError {
    CloudflareError::transport(TransportError::platform(operation, error.to_string()))
}

/// The HTTP status a declared-but-unimplemented route answers with.
///
/// 501, deliberately outside the closed `HttpStatus` set in
/// `identity_cloudflare`. `ErrorEnvelope::status()` would map the
/// `not_implemented` code to 500, and 500 is the wrong answer twice over: a
/// client that sees it retries a call that will never succeed, and a client
/// that sees 404 records a missing endpoint rather than a deferred one. The
/// Vue console keys its typed `NotImplementedError` off this exact number.
const STATUS_NOT_IMPLEMENTED: u16 = 501;

/// The name this route is reported under in a 501 body, per route.
///
/// A `const fn`, not a `&'static str` field on the enum, for one reason: the
/// route table lives in `identity-application`, which is a platform-free crate
/// and must not acquire a second copy of the envelope's message contract. This
/// is the adapter's rendering of a fact the table states.
const fn operation_name(route: AdminRoute) -> &'static str {
    match route {
        AdminRoute::Session => "AdminRoute::Session",
        AdminRoute::Users => "AdminRoute::Users",
        AdminRoute::UserDetail => "AdminRoute::UserDetail",
        AdminRoute::UserSuspend => "AdminRoute::UserSuspend",
        AdminRoute::UserUnsuspend => "AdminRoute::UserUnsuspend",
        AdminRoute::UserRole => "AdminRoute::UserRole",
        AdminRoute::UserSessionsRevoke => "AdminRoute::UserSessionsRevoke",
        AdminRoute::Audit => "AdminRoute::Audit",
        AdminRoute::Applications => "AdminRoute::Applications",
        AdminRoute::ApplicationRotateSecret => "AdminRoute::ApplicationRotateSecret",
        AdminRoute::Health => "AdminRoute::Health",
        AdminRoute::Ready => "AdminRoute::Ready",
    }
}

/// The body of `GET /health`.
///
/// Three keys, deliberately. A liveness probe that reported a database
/// connection or a queue depth would be reporting readiness, and a caller that
/// wanted one and got the other has to be defended against — which is why
/// `/ready` exists separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HealthBody {
    /// Always `"ok"`. There is no other value this Worker can produce: a
    /// process that cannot answer at all does not answer 503, it does not
    /// answer, and the platform restarts it.
    status: &'static str,
    /// The deployable's name, matching the wrangler worker name.
    worker: &'static str,
    /// The route answering, so a log line names it without the URL.
    route: &'static str,
}

/// The body of `GET /ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadyBody {
    /// `"not_ready"`. Always, in this phase, and asserted by a test.
    status: &'static str,
    /// The deployable's name.
    worker: &'static str,
    /// The route answering.
    route: &'static str,
    /// The declared routes that answer 501.
    unimplemented: Vec<&'static str>,
    /// What this deployment cannot do, in one sentence.
    detail: &'static str,
}

/// The answer `plan` reaches: a status and a body that is already an envelope
/// or a health document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Answer {
    /// The two live probes.
    Probe(ProbeBody),
    /// Any other body, always an `ErrorEnvelope` in this bootstrap.
    Envelope(ErrorEnvelope),
}

impl Answer {
    /// The HTTP status this answer goes out with.
    ///
    /// Read from the body, not stored beside it, so the two cannot disagree.
    /// `501` is not a member of `HttpStatus`, which is the point: the closed
    /// set is for statuses an *error* maps to, and a declared route's 501 is
    /// decided by the route table.
    fn status(&self) -> u16 {
        match self {
            Self::Probe(ProbeBody::Health(_)) => 200,
            Self::Probe(ProbeBody::Ready(_)) => 503,
            Self::Envelope(envelope) if envelope.code == "not_implemented" => {
                STATUS_NOT_IMPLEMENTED
            }
            Self::Envelope(envelope) => envelope.status().as_u16(),
        }
    }
}

/// One of the two live probe bodies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ProbeBody {
    /// `GET /health`.
    Health(HealthBody),
    /// `GET /ready`.
    Ready(ReadyBody),
}

/// The readiness detail, fixed in this phase and asserted by a test.
const READY_DETAIL: &str = "the Admin Worker is up; authentication, the operator session, \
and every administrative command are declared and unimplemented";

/// The message a 501 carries, matching `UNIMPLEMENTED_MESSAGE` in
/// `identity_cloudflare::error`.
///
/// Spelled out rather than imported because `UNIMPLEMENTED_MESSAGE` is the
/// *transport's* rendering of a `TransportError`, and this Worker reports an
/// `ApplicationError::NotImplemented` from the route table — a different error
/// type that the adapter crate never sees. `the_501_message_matches_the_shared_prefix`
/// fails if the two drift apart, because
/// `contracts/shared/v1/not-implemented-envelope.schema.json` documents this
/// exact text.
fn not_implemented_message(operation: &str) -> String {
    format!("this operation is not implemented yet ({operation})")
}

/// Every declared route that answers 501, in table order.
fn unimplemented_paths() -> Vec<&'static str> {
    AdminRoute::ALL
        .iter()
        .filter(|route| route.is_declared_but_unimplemented())
        .map(|route| route.path())
        .collect()
}

/// Resolve a request path to the status and body this Worker answers with.
///
/// Pure, and therefore the thing every claim about this Worker is tested
/// through: a `path` in, a `status` and a body out, with no `Env`, no
/// `Request` and no platform type anywhere in the signature. A test can assert
/// the whole 501/404/live split on the host.
///
/// # Errors
///
/// None. Every path is answered: a declared one with 200, 501 or 503, and an
/// undeclared one with 404.
#[must_use]
pub fn plan(path: &str) -> Answer {
    let Some(found) = admin_routes::find_by_path(path) else {
        return Answer::Envelope(ErrorEnvelope::new(
            "not_found",
            "no such administrative route",
            true,
            None,
        ));
    };

    match found.route {
        AdminRoute::Health => Answer::Probe(ProbeBody::Health(HealthBody {
            status: "ok",
            worker: "identity-admin",
            route: found.route.path(),
        })),
        AdminRoute::Ready => Answer::Probe(ProbeBody::Ready(ReadyBody {
            status: "not_ready",
            worker: "identity-admin",
            route: found.route.path(),
            unimplemented: unimplemented_paths(),
            detail: READY_DETAIL,
        })),
        route => Answer::Envelope(ErrorEnvelope::new(
            "not_implemented",
            not_implemented_message(operation_name(route)),
            true,
            None,
        )),
    }
}

/// Render an [`Answer`] into a `worker::Response`.
///
/// The one place this Worker turns a body into a response, and it uses
/// `identity_cloudflare`'s `ResponseBuilder` rather than constructing a
/// `Response`: that builder is where `Cache-Control: no-store`,
/// `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are
/// applied, and a hand-built response is a response that can forget them.
///
/// # Errors
///
/// A [`CloudflareError`] from the platform if the headers or the body cannot be
/// built. Both should be unreachable; both are reported as a 500 envelope
/// rather than a panic, because a panic in a response path is a failure nobody
/// can read.
fn render(answer: &Answer) -> Result<WorkerResponse> {
    let status = answer.status();
    ResponseBuilder::new(status).json(answer)
}

/// The fetch entrypoint.
///
/// Reads the path, hands it to [`plan`], and renders the answer. No policy of
/// its own, and no `Env` use: this Worker has no binding to read yet, and the
/// `IDENTITY` service binding it will have is not named here because nothing
/// calls it.
///
/// # Errors
///
/// A `worker::Error` from the platform when the response cannot be built. There
/// is no second error path: every route this Worker declares is answered from
/// `plan`, and a `plan` failure is reported as a 500 envelope carrying the
/// adapter's own opaque message.
///
/// The `ctx` third argument is the platform's and is unused. Named `_ctx`
/// rather than dropped, because a `fetch` handler's arity is fixed by
/// `#[event]` and a two-argument one is a compile error, not a warning.
#[event(fetch)]
pub async fn fetch(
    req: Request,
    _env: Env,
    _ctx: worker::Context,
) -> worker::Result<WorkerResponse> {
    // Not `mut`: `Request::url` takes `&self` in worker-rs 0.8. The `mut` would
    // be needed the moment this Worker starts reading a body, and adding it
    // then is a one-character diff — while a spurious `mut` today is a warning
    // CI fails on.
    let path = req
        .url()
        .map_err(|e| platform_failure("admin.request.url", &e).to_string())?
        .path()
        .to_string();

    match render(&plan(&path)) {
        Ok(response) => Ok(response),
        Err(failure) => {
            // The only place this Worker can fail to answer, and it answers
            // anyway. `OPAQUE_MESSAGE` reaches the caller and the reason stays
            // in the log, because `TransportError::Platform` is operator-facing
            // by construction — which is why the `Display` text of the
            // failure, not its `code`, is what would have leaked.
            let envelope = failure.envelope(None);
            ResponseBuilder::new(HttpStatus::InternalServerError.as_u16())
                .json(&envelope)
                .map_err(|e| worker::Error::RustError(format!("admin 500 unbuildable: {e}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path with no template, so a test can name a route without a body
    /// that would change whenever the message contract does.
    const fn concrete(route: AdminRoute) -> &'static str {
        match route {
            AdminRoute::UserDetail
            | AdminRoute::UserSuspend
            | AdminRoute::UserRole
            | AdminRoute::UserSessionsRevoke => {
                "/admin/users/detail/0195f2c1-0000-7000-8000-000000000001"
            }
            AdminRoute::UserUnsuspend => {
                "/admin/users/suspend/0195f2c1-0000-7000-8000-000000000001/unsuspend"
            }
            AdminRoute::ApplicationRotateSecret => {
                "/admin/applications/0195f2c1-0000-7000-8000-000000000001/rotate-secret"
            }
            AdminRoute::Health => "/health",
            AdminRoute::Ready => "/ready",
            AdminRoute::Session => "/admin/session",
            AdminRoute::Users => "/admin/users",
            AdminRoute::Audit => "/admin/audit",
            AdminRoute::Applications => "/admin/applications",
        }
    }

    /// Serialise an answer, or fail the test loudly. A test that asserted on a
    /// `Debug` string instead would pass on a body that could not be sent.
    fn body_of(answer: &Answer) -> serde_json::Value {
        serde_json::to_value(answer).expect("every answer is serialisable")
    }

    fn envelope_of(answer: &Answer) -> &ErrorEnvelope {
        match answer {
            Answer::Envelope(envelope) => envelope,
            Answer::Probe(_) => panic!("expected an envelope, got a probe body"),
        }
    }

    #[test]
    fn the_liveness_probe_answers_200() {
        let answer = plan("/health");
        assert_eq!(answer.status(), 200);
        let body = body_of(&answer);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["worker"], "identity-admin");
        assert_eq!(body["route"], "/health");
    }

    #[test]
    fn the_readiness_probe_answers_503_and_says_what_is_missing() {
        // 503, not 200. Every administrative route answers 501, so a 200 here
        // would be telling an orchestrator to send traffic to a deployable
        // that cannot do the thing the traffic is for. The test asserts the
        // body as well, because "503" alone is a status an operator has to go
        // and look up.
        let answer = plan("/ready");
        assert_eq!(answer.status(), 503);
        let body = body_of(&answer);
        assert_eq!(body["status"], "not_ready");
        assert_eq!(body["worker"], "identity-admin");
        assert_eq!(body["route"], "/ready");
        assert!(
            body["detail"]
                .as_str()
                .is_some_and(|d| d.contains("unimplemented")),
            "/ready must say what is missing: {body}"
        );
    }

    #[test]
    fn the_readiness_probe_lists_every_unimplemented_route() {
        let body = body_of(&plan("/ready"));
        let listed: Vec<&str> = body["unimplemented"]
            .as_array()
            .expect("unimplemented is an array")
            .iter()
            .map(|v| v.as_str().expect("each entry is a string"))
            .collect();
        let expected: Vec<&str> = unimplemented_paths();
        assert_eq!(listed, expected);
        // The count is the point: a list that silently lost a route would still
        // be a list. Ten administrative routes, none of them live.
        assert_eq!(listed.len(), 10, "{listed:?}");
        assert!(!listed.contains(&"/health"), "{listed:?}");
        assert!(!listed.contains(&"/ready"), "{listed:?}");
    }

    #[test]
    fn the_readiness_detail_names_the_missing_capability() {
        let body = body_of(&plan("/ready"));
        let detail = body["detail"].as_str().expect("detail is a string");
        // `docs/README.md` and `worker-architecture.md` both say the same
        // thing; the probe is the version an operator reads at 3am, so it
        // must not be vaguer than the document it comes from.
        assert!(detail.contains("authentication"), "{detail}");
        assert!(detail.contains("unimplemented"), "{detail}");
    }

    #[test]
    fn every_declared_administrative_route_answers_501() {
        for route in AdminRoute::ALL {
            if route.is_implemented() {
                continue;
            }
            let answer = plan(concrete(*route));
            assert_eq!(
                answer.status(),
                STATUS_NOT_IMPLEMENTED,
                "{} answered {} instead of 501",
                route.path(),
                answer.status()
            );
            let envelope = envelope_of(&answer);
            assert_eq!(envelope.code, "not_implemented", "{}", route.path());
            assert!(
                envelope.client_safe,
                "{}: the 501 is client-safe; an operator must be able to read the \
                 body and know the feature is deferred",
                route.path()
            );
            assert!(
                envelope.request_id.is_none(),
                "{}: this Worker sends no request id yet, and must omit the field \
                 rather than serialise null",
                route.path()
            );
        }
    }

    #[test]
    fn the_501_message_matches_the_shared_prefix() {
        // `contracts/shared/v1/not-implemented-envelope.schema.json` documents
        // this exact text and names
        // `identity_cloudflare::error::UNIMPLEMENTED_MESSAGE` as its source.
        // This Worker renders it itself, so a change to the constant in the
        // adapter would silently make the two disagree — and the schema is a
        // contract, not a description.
        for route in AdminRoute::ALL {
            if route.is_implemented() {
                continue;
            }
            let message = not_implemented_message(operation_name(*route));
            assert!(
                message.starts_with("this operation is not implemented yet ("),
                "{route:?}: {message}"
            );
            assert!(message.ends_with(')'), "{route:?}: {message}");
            assert!(
                message.contains(&format!("{route:?}")),
                "{route:?}: the message must name the route so an operator can \
                 look it up; got {message}"
            );
        }
    }

    #[test]
    fn the_501_message_is_not_empty_and_leaks_nothing() {
        let answer = plan("/admin/session");
        let envelope = envelope_of(&answer);
        assert!(!envelope.message.is_empty());
        // The message names the route and nothing else: no binding, no
        // topology, no repository. The Admin Worker's isolation is the thing
        // most worth not disclosing, and it is exactly what an error string
        // tends to leak.
        for forbidden in ["IDENTITY", "D1", "binding", "wrangler", "database"] {
            assert!(
                !envelope.message.contains(forbidden),
                "the 501 message discloses {forbidden}: {}",
                envelope.message
            );
        }
    }

    #[test]
    fn an_undeclared_path_answers_404() {
        for path in [
            "/",
            "/admin",
            "/admin/",
            "/nope",
            "/admin/nope",
            "/oauth/token",
        ] {
            let answer = plan(path);
            assert_eq!(answer.status(), 404, "{path}");
            let envelope = envelope_of(&answer);
            assert_eq!(envelope.code, "not_found", "{path}");
            assert!(envelope.client_safe, "{path}");
        }
    }

    #[test]
    fn a_404_is_not_a_501_and_a_501_is_not_a_404() {
        // The distinction is the whole contract. A 501 tells the console to
        // render a deferred state; a 404 tells it the path does not exist.
        // Collapsing them either loses the deferred screen or tells an
        // operator a feature is missing when it is only unwritten.
        assert_eq!(plan("/admin/session").status(), STATUS_NOT_IMPLEMENTED);
        assert_eq!(plan("/admin/nope").status(), 404);
        assert_ne!(
            plan("/admin/session").status(),
            plan("/admin/nope").status()
        );
    }

    #[test]
    fn the_identity_workers_oauth_routes_are_not_admin_routes() {
        // The Admin Worker is a separate deployable with a separate route
        // table. Answering 501 for `/oauth/token` here would claim a protocol
        // surface this Worker does not have, and would be the 501 a scanner
        // records for a token endpoint on the wrong host.
        assert_eq!(plan("/oauth/token").status(), 404);
        assert_eq!(plan("/.well-known/openid-configuration").status(), 404);
        assert_eq!(plan("/.well-known/jwks.json").status(), 404);
    }

    #[test]
    fn the_console_web_apps_routes_are_not_served_by_the_bff() {
        // `/users` and `/audit` are client-side routes in the console, served
        // by the ASSETS binding. If the BFF answered them it would shadow the
        // SPA, and an operator would get a 501 envelope where they expect the
        // app.
        assert_eq!(plan("/users").status(), 404);
        assert_eq!(plan("/audit").status(), 404);
        assert_eq!(plan("/session").status(), 404);
    }

    #[test]
    fn every_route_the_table_declares_is_answered_with_a_known_status() {
        // No route may fall through to a status nobody has reasoned about. The
        // set is closed here on purpose, mirroring `HttpStatus` being closed
        // for the codes it maps.
        let known = [200, 404, STATUS_NOT_IMPLEMENTED, 503];
        for route in AdminRoute::ALL {
            let status = plan(concrete(*route)).status();
            assert!(
                known.contains(&status),
                "{} answered {status}, which is not one of {known:?}",
                route.path()
            );
        }
    }

    #[test]
    fn a_deferred_route_never_claims_to_be_implemented() {
        // The rendered body and the table must agree. If `is_implemented()`
        // were ever flipped for an administrative route without the handler
        // landing, this fails rather than the console rendering an empty user
        // list as "no users".
        for route in AdminRoute::ALL {
            let answer = plan(concrete(*route));
            match answer {
                Answer::Envelope(envelope) => {
                    assert_eq!(
                        envelope.code == "not_implemented",
                        route.is_declared_but_unimplemented(),
                        "{route:?}: the body and is_implemented() disagree"
                    );
                }
                Answer::Probe(_) => assert!(
                    route.is_implemented(),
                    "{route:?}: answered a probe body but is not implemented"
                ),
            }
        }
    }

    /// The top-level keys of an answer's body, sorted, owned so a temporary
    /// body may be dropped before the assertion reads them.
    fn keys_of(answer: &Answer) -> std::collections::BTreeSet<String> {
        body_of(answer)
            .as_object()
            .expect("every answer body is a JSON object")
            .keys()
            .cloned()
            .collect()
    }

    fn keys_of_str(keys: &[&str]) -> std::collections::BTreeSet<String> {
        keys.iter().map(|k| (*k).to_string()).collect()
    }

    #[test]
    fn an_error_body_carries_only_the_four_envelope_fields_and_nothing_else() {
        // Exact key-set equality rather than a scan for forbidden words.
        //
        // A substring scan had to name the bindings it was looking for, and
        // naming one in this file is itself what `boundary-1-admin-d1` fails
        // on — the guard is right to, and a test that needs a suppression to
        // exist is a test asking for a hole. Key equality needs no such list:
        // any field that is not one of the four in
        // `contracts/shared/v1/error-envelope.schema.json` fails the test,
        // including a binding name added to the body six months from now.
        let expected = keys_of_str(&["code", "message", "client_safe"]);
        for path in ["/admin/session", "/admin/nope"] {
            let answer = plan(path);
            assert_eq!(
                keys_of(&answer),
                expected,
                "{path}: the envelope gained a field"
            );
            // The one field whose *value* could still disclose: the message. It
            // is client-safe text naming the route, and it carries no request
            // id because this Worker does not mint one yet.
            let envelope = envelope_of(&answer);
            assert!(!envelope.message.is_empty(), "{path}");
        }
    }

    #[test]
    fn a_probe_body_carries_only_the_fields_the_probe_documents() {
        // The same argument, applied to the two live bodies. `/ready` is the
        // one that has to earn its verbosity: it lists ten route templates, and
        // a field added to it later would be a field an operator reads and
        // believes.
        assert_eq!(
            keys_of(&plan("/health")),
            keys_of_str(&["route", "status", "worker"]),
            "the /health body gained a field"
        );
        assert_eq!(
            keys_of(&plan("/ready")),
            keys_of_str(&["detail", "route", "status", "unimplemented", "worker"]),
            "the /ready body gained a field"
        );
    }

    #[test]
    fn an_answer_carries_no_request_id_and_omits_the_field() {
        // `#[serde(skip_serializing_if = "Option::is_none")]` means an absent
        // request id is *absent*, not `null`; `contracts/shared/v1/` says so.
        let body = body_of(&plan("/admin/session"));
        assert!(
            body.get("request_id").is_none(),
            "an absent request id must be omitted, not null: {body}"
        );
    }
}
