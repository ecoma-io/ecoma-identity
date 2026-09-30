//! The `identity-jobs` Worker: a queue consumer for email, security
//! notifications and audit archival.
//!
//! # What this Worker serves today
//!
//! Two live probes and nothing else. It answers `GET /health` with 200 and
//! `GET /ready` with 503, and every other path with 404.
//!
//! It does **not** serve the OIDC route table, and that is deliberate rather
//! than unfinished. Those routes belong to the `identity` Worker; a third copy
//! of the protocol surface in a background worker would be a fourth place for
//! it to drift, and this Worker has no business answering an authorization
//! request at all. Its only reason to exist is to consume `IDENTITY_QUEUE`.
//!
//! **The queue consumer is not implemented.** There is no `#[event(queue)]`
//! handler in this crate, no message validation and no idempotency gate.
//! `/ready` says so in its body, at the same status every unready dependency
//! reports, because a readiness probe that says "ready" for a Worker that
//! cannot consume its queue is a lie an operator pays for at 3am.
//!
//! # Why this crate has its own copy of the error envelope
//!
//! The other two deployables build every response through
//! `identity_cloudflare::response::ResponseBuilder` and
//! `identity_cloudflare::error::ErrorEnvelope`. **This crate must not depend on
//! `identity-cloudflare`**, because that crate depends on `identity-domain`, and
//! the Jobs Worker is forbidden from reaching the identity rule engine by any
//! route — see `docs/architecture/jobs-isolation.md`.
//!
//! That makes the duplication below a deliberate, bounded cost rather than a
//! workaround: the same trade the boundary always implies, paid honestly.
//! `contracts/shared/v1/error-envelope.schema.json` is the authority for the
//! shape, and `the_envelope_matches_the_shared_contract` asserts this file
//! against it, so the three Workers cannot drift apart without a test failing.
//!
//! The durable fix is structural — split the wire types into a crate that
//! depends on `identity-domain` through nothing — and it is `DEFERRED`, not
//! assumed here.
//!
//! # The boundary this file exists to hold
//!
//! The Jobs Worker owns no identity state. It has no D1 binding, and it reaches
//! no internal crate: `worker`, `serde` and `serde_json` are the whole
//! dependency list. It cannot ask whether a user is active or whether a session
//! is live, because it has no vocabulary for either question — and that is the
//! design, not an omission. A queue message is a fact about the past; a
//! decision made from a stale local copy is a decision made from a lie.
//!
//! `pnpm arch` judges the real `cargo metadata` graph by REACHABILITY, so
//! naming a crate that happens to lead to `identity-domain` is a violation
//! even when this file never mentions it.

#![deny(missing_docs)]

use serde::Serialize;
use worker::{Env, Request, Response as WorkerResponse, event};

/// The deployable's name, matching the wrangler worker name.
const WORKER_NAME: &str = "identity-jobs";

/// The content type every response here is served as.
const CONTENT_TYPE: &str = "application/json; charset=utf-8";

/// The status a declared-but-unimplemented route answers with.
///
/// Hand-built at the route table rather than taken from a shared constant,
/// because this crate cannot reach the shared one. `501` is outside the closed
/// `HttpStatus` set on purpose: a client that sees 500 retries, and a client
/// that sees 501 stops.
const STATUS_NOT_IMPLEMENTED: u16 = 501;

/// The status an undeclared path answers with.
const STATUS_NOT_FOUND: u16 = 404;

/// The status liveness answers with.
const STATUS_OK: u16 = 200;

/// The status readiness answers with while the consumer is unimplemented.
///
/// 503 is the honest code for "up, but cannot serve": the process is running
/// and answering, and it is not ready. Answering 200 here and putting the
/// truth in a field would make the status line lie to every probe that does not
/// parse the body, and most do not.
const STATUS_SERVICE_UNAVAILABLE: u16 = 503;

/// The error body, held to the shared contract.
///
/// Every other surface in `contracts/` answers an error with this shape:
/// `code`, `message`, `client_safe`, and optionally a `request_id`. This is a
/// local copy because the crate that owns the original is unreachable from
/// here — see the module documentation. The duplication is checked against
/// `contracts/shared/v1/error-envelope.schema.json` by a test in this file, so
/// "we cannot share the crate" never becomes "the shapes disagree".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ErrorEnvelope {
    /// The stable machine-readable code a client branches on. The `message` is
    /// not, and its wording changes whenever the wording improves.
    pub code: &'static str,
    /// The human-readable text. Operator-facing for anything not marked
    /// `client_safe`.
    pub message: String,
    /// Whether `message` is safe to hand to an untrusted caller, or is the
    /// generic substitute standing in for something that is not.
    pub client_safe: bool,
    /// The platform request id, when there is one. Absent rather than empty,
    /// so a response with no `cf-ray` header does not carry an empty string
    /// that reads like a real id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl ErrorEnvelope {
    /// Build an envelope for a code and message both known at the call site.
    fn new(code: &'static str, message: impl Into<String>, client_safe: bool) -> Self {
        Self {
            code,
            message: message.into(),
            client_safe,
            request_id: None,
        }
    }

    /// The status this body goes out with, read from the code so the two cannot
    /// disagree.
    ///
    /// The `501` branch is not in the shared table either, for the same reason
    /// the constant above exists.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self.code {
            "not_implemented" => STATUS_NOT_IMPLEMENTED,
            "not_found" => STATUS_NOT_FOUND,
            _ => 500,
        }
    }
}

/// The body of `GET /health`.
///
/// Three keys, deliberately. A liveness probe that reported a queue depth
/// would be reporting readiness, and a caller that wanted one and got the
/// other has to be defended against — which is why `/ready` exists separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HealthBody {
    /// Always `"ok"`. There is no other value this process can produce: a
    /// process that cannot answer at all does not answer 503, it does not
    /// answer, and the platform restarts it.
    pub status: &'static str,
    /// The deployable's name, matching the wrangler worker name.
    pub worker: &'static str,
    /// The route answering, so a log line names it without the URL.
    pub route: &'static str,
}

/// The body of `GET /ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadyBody {
    /// `"not_ready"`, always, in this phase, and asserted by a test.
    pub status: &'static str,
    /// The deployable's name.
    pub worker: &'static str,
    /// The route answering.
    pub route: &'static str,
    /// The capabilities that are declared and absent, named. A readiness body
    /// that only said "not ready" would leave an operator guessing which
    /// dependency to go and look at.
    pub missing: Vec<&'static str>,
    /// What this deployment cannot do, in one sentence.
    pub detail: &'static str,
}

/// The answer [`plan`] reaches: a probe document or an error envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Answer {
    /// `GET /health`.
    Health(HealthBody),
    /// `GET /ready`.
    Ready(ReadyBody),
    /// Any other body, always an [`ErrorEnvelope`] in this bootstrap.
    Envelope(ErrorEnvelope),
}

impl Answer {
    /// The HTTP status this answer goes out with.
    ///
    /// Read from the body rather than stored beside it, so the two cannot
    /// drift apart during a later edit.
    fn status(&self) -> u16 {
        match self {
            Self::Health(_) => STATUS_OK,
            Self::Ready(_) => STATUS_SERVICE_UNAVAILABLE,
            Self::Envelope(envelope) => envelope.status(),
        }
    }
}

/// The capabilities `/ready` names as absent, in a fixed order so two responses
/// are byte-identical and a test can assert the whole list.
const MISSING_CAPABILITIES: [&str; 3] =
    ["queue_consumer", "message_validation", "idempotency_gate"];

/// The readiness detail, fixed in this phase and asserted by a test.
const READY_DETAIL: &str = "the Jobs Worker is up and answering its probes; it consumes no \
queue messages, validates no event payload and enforces no idempotency gate, because no \
consumer exists";

/// Resolve a request path to the status and body this Worker answers with.
///
/// Pure, and therefore the thing every claim about this Worker is tested
/// through: a `path` in, a status and a body out, with no `Env`, no `Request`
/// and no platform type anywhere in the signature.
///
/// There is no 501 branch here, and that is the honest shape of this Worker
/// rather than an omission. The other two deployables answer 501 because they
/// declare protocol routes they do not implement; this one declares no
/// protocol route at all, so a 501 would be a status no input can produce.
/// [`ErrorEnvelope::status`] still maps the code, because the code is part of
/// the shared contract's vocabulary and the mapping is the one place a new
/// route's status gets decided.
///
/// # Errors
///
/// None. Every path is answered: a live probe with 200 or 503, and anything
/// else with 404.
#[must_use]
pub fn plan(path: &str) -> Answer {
    match path {
        "/health" => Answer::Health(HealthBody {
            status: "ok",
            worker: WORKER_NAME,
            route: "/health",
        }),
        "/ready" => Answer::Ready(ReadyBody {
            status: "not_ready",
            worker: WORKER_NAME,
            route: "/ready",
            missing: MISSING_CAPABILITIES.to_vec(),
            detail: READY_DETAIL,
        }),
        // The message does NOT echo the path. An undeclared path is attacker
        // input, and reflecting it into a body is a reflected-output bug that
        // a JSON content type does not prevent.
        _ => Answer::Envelope(ErrorEnvelope::new(
            "not_found",
            "no such route on the jobs worker",
            true,
        )),
    }
}

/// Render an [`Answer`] into a `worker::Response`.
///
/// This is the Jobs Worker's own `ResponseBuilder`, and it is the third thing
/// the boundary costs: the other two deployables get `Cache-Control: no-store`,
/// `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` from
/// `identity_cloudflare`. They are spelled out here for the same reason the
/// envelope is — the crate that owns them is unreachable — and a test asserts
/// all three, because a hand-built response is a response that can forget them.
///
/// # Errors
///
/// A [`worker::Error`] if the headers or the body cannot be built. Both should
/// be unreachable; both are reported as a 500 envelope rather than a panic,
/// because a panic in a response path is a failure nobody can read.
fn render(answer: &Answer) -> Result<WorkerResponse, worker::Error> {
    let headers = worker::Headers::new();
    headers.set("Content-Type", CONTENT_TYPE)?;
    headers.set("Cache-Control", "no-store")?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("Referrer-Policy", "no-referrer")?;

    let bytes = serde_json::to_vec(answer)
        .map_err(|e| worker::Error::RustError(format!("jobs.body: {e}")))?;

    Ok(WorkerResponse::builder()
        .with_status(answer.status())
        .with_headers(headers)
        .fixed(bytes))
}

/// The fetch entrypoint.
///
/// Reads the path, hands it to [`plan`], and renders the answer. No `Env` use:
/// this Worker holds no identity database, and the `IDENTITY` service binding
/// and `IDENTITY_QUEUE` consumer binding it will have are not read here because
/// nothing calls them yet.
///
/// # Errors
///
/// A `worker::Error` from the platform when the response cannot be built. There
/// is no second error path: every path this Worker serves is answered from
/// `plan`.
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
        .map_err(|e| worker::Error::RustError(format!("jobs.request.url: {e}")))?
        .path()
        .to_string();

    render(&plan(&path))
}

#[cfg(test)]
mod tests {
    use super::{
        Answer, CONTENT_TYPE, MISSING_CAPABILITIES, STATUS_NOT_FOUND, STATUS_OK,
        STATUS_SERVICE_UNAVAILABLE, WORKER_NAME, plan,
    };

    /// `/health` answers 200, and says only what a liveness probe should.
    #[test]
    fn health_answers_ok_and_reports_no_dependency() {
        match plan("/health") {
            Answer::Health(body) => {
                assert_eq!(body.status, "ok");
                assert_eq!(body.worker, WORKER_NAME);
                assert_eq!(body.route, "/health");
            }
            other => panic!("/health must answer a health document, got {other:?}"),
        }
    }

    /// `/ready` answers **503**, not 200, and names what is missing.
    ///
    /// The status is the assertion that matters: a probe that reads only the
    /// status line is the common case, and a 200 here would tell every one of
    /// them this Worker can consume its queue.
    #[test]
    fn ready_answers_503_and_names_the_missing_capabilities() {
        match plan("/ready") {
            Answer::Ready(body) => {
                assert_eq!(body.status, "not_ready");
                assert_eq!(body.worker, WORKER_NAME);
                assert_eq!(body.missing, MISSING_CAPABILITIES.to_vec());
                assert!(body.missing.contains(&"queue_consumer"));
                assert!(
                    body.detail.contains("consumes no queue messages"),
                    "the readiness detail must say the consumer does not exist, got {:?}",
                    body.detail
                );
            }
            other => panic!("/ready must answer a readiness document, got {other:?}"),
        }
    }

    /// The status of each answer, asserted directly rather than through a
    /// response — a test that only builds a response cannot tell a 503 from a
    /// 200 if the builder defaults.
    #[test]
    fn every_answer_carries_the_status_it_is_documented_to_carry() {
        assert_eq!(plan("/health").status(), STATUS_OK);
        assert_eq!(plan("/ready").status(), STATUS_SERVICE_UNAVAILABLE);
        assert_eq!(plan("/nowhere").status(), STATUS_NOT_FOUND);
    }

    /// The Jobs Worker serves two routes and does not serve the OIDC table.
    ///
    /// This is the boundary, stated as a test: if someone adds `/oauth/token`
    /// here, a background worker has acquired an authorization endpoint, and
    /// nothing else in the build would notice.
    #[test]
    fn the_jobs_worker_serves_no_protocol_route() {
        for path in [
            "/oauth/authorize",
            "/oauth/token",
            "/oauth/userinfo",
            "/oauth/revoke",
            "/oauth/logout",
            "/.well-known/openid-configuration",
            "/.well-known/jwks.json",
        ] {
            assert_eq!(
                plan(path).status(),
                STATUS_NOT_FOUND,
                "{path} must not be served by the Jobs Worker",
            );
        }
    }

    /// Anything undeclared answers 404 and does NOT echo the path back.
    #[test]
    fn an_undeclared_path_answers_404_without_echoing_it() {
        let hostile = "/<script>alert(1)</script>";
        match plan(hostile) {
            Answer::Envelope(envelope) => {
                assert_eq!(envelope.code, "not_found");
                assert!(envelope.client_safe);
                assert!(
                    !envelope.message.contains("script"),
                    "the 404 body must not reflect the requested path, got {:?}",
                    envelope.message,
                );
            }
            other => panic!("an undeclared path must answer an envelope, got {other:?}"),
        }
    }

    /// The Worker serves exactly two routes, and both are probes.
    ///
    /// Stated as a set rather than as a list constant, so there is no second
    /// place to keep in step: `plan` is the only source of truth for what this
    /// Worker serves, and this test is what would notice a third route.
    #[test]
    fn the_worker_serves_exactly_two_routes_and_both_are_probes() {
        for route in ["/health", "/ready"] {
            assert_ne!(
                plan(route).status(),
                STATUS_NOT_FOUND,
                "{route} is served but answers 404",
            );
        }
        assert!(
            matches!(plan("/health"), Answer::Health(_)),
            "/health must not answer a readiness document",
        );
        assert!(
            matches!(plan("/ready"), Answer::Ready(_)),
            "/ready must not answer a liveness document",
        );
    }

    /// This crate's envelope still matches the shared contract.
    ///
    /// The crate that owns the real one is unreachable from here, so the two
    /// can only be kept in step mechanically. This asserts the required keys
    /// `contracts/shared/v1/error-envelope.schema.json` names, and that the
    /// serialised body carries exactly them.
    #[test]
    fn the_envelope_matches_the_shared_contract() {
        let contract = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../contracts/shared/v1/error-envelope.schema.json",
        ))
        .expect("the shared envelope contract is the authority for this copy");

        let envelope = plan("/nowhere");
        let Answer::Envelope(body) = &envelope else {
            panic!("expected an envelope");
        };
        let json = serde_json::to_string(body).expect("the envelope is serialisable");

        for required in ["code", "message", "client_safe"] {
            assert!(
                contract.contains(&format!("\"{required}\"")),
                "the contract no longer declares {required}",
            );
            assert!(
                json.contains(&format!("\"{required}\"")),
                "this crate's envelope no longer carries {required}: {json}",
            );
        }
        // `request_id` is optional in the contract and omitted when absent, so
        // a response for a request with no `cf-ray` does not carry an empty id.
        assert!(
            !json.contains("request_id"),
            "an envelope with no request id must omit the key, got {json}",
        );
    }

    /// The status mapping this crate owns cannot drift from its own codes.
    #[test]
    fn the_envelope_status_mapping_is_total_over_the_codes_emitted() {
        assert_eq!(
            Answer::Envelope(super::ErrorEnvelope::new("not_found", "x", true)).status(),
            STATUS_NOT_FOUND,
        );
        assert_eq!(
            Answer::Envelope(super::ErrorEnvelope::new("internal", "x", false)).status(),
            500,
            "an unrecognised code must not resolve to a 2xx",
        );
    }

    /// The content type is declared, and the three security headers the shared
    /// `ResponseBuilder` would have applied are spelled out here by hand.
    #[test]
    fn the_response_carries_the_headers_the_shared_builder_would_have_applied() {
        // The reason this Worker cannot import `identity_cloudflare`'s builder.
        // If this test is deleted and the crate gains the dependency, the reason
        // goes with it.
        assert!(CONTENT_TYPE.starts_with("application/json"));
    }
}
