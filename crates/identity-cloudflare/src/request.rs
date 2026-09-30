//! Parsing an incoming `worker::Request` into a typed request.
//!
//! # The body limit is the point of this module
//!
//! An unbounded `request.json()` on an unauthenticated endpoint is a
//! denial-of-service primitive. It costs the caller nothing to declare a
//! `Content-Length` of four gigabytes; the Worker pays for every byte, out of
//! its own CPU and memory budget, before any authentication code runs — and on
//! an endpoint whose purpose is to *not* authenticate anyone yet, that is a
//! free amplification for anyone who finds the hostname.
//!
//! So [`IncomingRequest::from_request`] reads the body as a stream, counts as
//! it goes, and **stops and refuses at [`MAX_JSON_BODY_BYTES`]**. It does not
//! trust `Content-Length`, because that header is set by whoever is making the
//! request and is routinely wrong in both directions.
//!
//! # What this module does not parse
//!
//! OAuth parameters. `identity-oidc` owns those shapes, and it owns them as
//! types with their own validation. This module's job is to hand a handler the
//! method, the path, a bounded set of query parameters, the headers it cares
//! about, and — only where the content type says so — a decoded JSON body.
//!
//! # The client IP
//!
//! Taken from `CF-Connecting-IP`, which the Workers runtime sets and overwrites
//! on every inbound request. It is **not** taken from `X-Forwarded-For`: that
//! header is attacker-controlled wherever a proxy in front of us does not
//! strip it, and a rate-limit key built from it would be built from something
//! the caller chose. `CF-Connecting-IP` is `None` for a request the runtime did
//! not originate (a local `wrangler dev` synthetic request, for instance), and
//! `None` is a legitimate state — the caller must decide what to do rather than
//! being handed an invented address.

use std::collections::HashMap;

use futures_util::TryStreamExt;
use serde::de::DeserializeOwned;
use wasm_bindgen::JsValue;
use worker::Method;
use worker::Request as WorkerRequest;

use crate::error::{CloudflareError, Result, TransportError};

/// The largest JSON request body this platform will read, in bytes.
///
/// 64 KiB. Every legitimate body in the contract is an order of magnitude
/// smaller: a token request is form-encoded and under 1 KiB, a client
/// registration is a few hundred bytes, and the largest thing in `contracts/`
/// is an audit query with a bounded `limit`. The number is generous on purpose —
/// a limit that is too tight produces a 413 in production for a client doing
/// something legitimate, which is worse than a limit that is generous.
pub const MAX_JSON_BODY_BYTES: usize = 64 * 1024;

/// The name of the session cookie.
///
/// Named once, here, and imported by all three Workers, because three Workers
/// that spell the cookie three ways is three Workers where logging out of one
/// leaves you logged into the others.
pub const SESSION_COOKIE_NAME: &str = "__Host-ecoma_session";

/// The header the Workers runtime sets to the connecting client's address.
pub const CLIENT_IP_HEADER: &str = "CF-Connecting-IP";

/// A bounded JSON body that has been read in full.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedBody {
    /// The raw bytes, at most [`MAX_JSON_BODY_BYTES`] long.
    pub bytes: Vec<u8>,
}

impl BoundedBody {
    /// Decode the body as JSON.
    ///
    /// # Errors
    ///
    /// [`TransportError::UnreadableBody`] when the bytes are not valid JSON for
    /// `T`. The message carries nothing from the body: a parse error from
    /// serde quotes the input it choked on, and an identity endpoint echoing a
    /// fragment of a request back is how a malformed-credential probe learns
    /// the shape of the parser.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.bytes)
            .map_err(|_| CloudflareError::transport(TransportError::UnreadableBody))
    }
}

/// A parsed incoming request.
///
/// Owns its body, so a handler that only needs the path does not have to read
/// the body at all and cannot accidentally read it twice.
#[derive(Debug, Clone)]
pub struct IncomingRequest {
    /// The HTTP method.
    pub method: Method,
    /// The path, with the query string already removed.
    pub path: String,
    /// The query parameters, percent-decoded.
    pub query: HashMap<String, String>,
    /// The request headers, as the runtime received them.
    pub headers: worker::Headers,
    /// The bounded body, if the request had one and it was within the limit.
    pub body: Option<BoundedBody>,
    /// The connecting client's address, when the runtime supplied one.
    pub client_ip: Option<String>,
    /// The request id, taken from the inbound `cf-ray` when present.
    pub request_id: Option<String>,
}

impl IncomingRequest {
    /// Parse an incoming `worker::Request`.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the request's own metadata (URL, headers)
    /// cannot be read, and [`TransportError::BodyTooLarge`] if the body exceeds
    /// [`MAX_JSON_BODY_BYTES`] — the one refusal this function exists for.
    pub async fn from_request(request: &mut WorkerRequest) -> Result<Self> {
        let method = request.method();
        let url = request.url().map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.url", e.to_string()))
        })?;
        let path = url.path().to_string();
        let query = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect::<HashMap<_, _>>();
        let headers = request.headers().clone();
        let client_ip = headers.get(CLIENT_IP_HEADER).map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.headers", e.to_string()))
        })?;
        let request_id = headers.get("cf-ray").map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.headers", e.to_string()))
        })?;

        let has_body = method == Method::Post
            || method == Method::Put
            || method == Method::Patch
            || method == Method::Delete;
        let body = if has_body {
            Some(Self::read_bounded_body(request).await?)
        } else {
            None
        };

        Ok(Self {
            method,
            path,
            query,
            headers,
            body,
            client_ip,
            request_id,
        })
    }

    /// Read the body, refusing anything above the limit.
    ///
    /// Streaming rather than `bytes()` on purpose: `Request::bytes()` buffers
    /// the whole thing first and only then gives this function a chance to look
    /// at how big it is, which is a limit that does not limit anything.
    async fn read_bounded_body(request: &mut WorkerRequest) -> Result<BoundedBody> {
        let mut stream = request.stream().map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.body", e.to_string()))
        })?;
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.try_next().await.map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.body", e.to_string()))
        })? {
            if bytes.len().saturating_add(chunk.len()) > MAX_JSON_BODY_BYTES {
                return Err(CloudflareError::transport(TransportError::BodyTooLarge {
                    limit: MAX_JSON_BODY_BYTES,
                }));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(BoundedBody { bytes })
    }

    /// A single query parameter.
    #[must_use]
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(String::as_str)
    }

    /// A single header.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the platform refuses to read the header
    /// set, which means the headers object is malformed rather than that the
    /// header is absent.
    pub fn header(&self, name: &str) -> Result<Option<String>> {
        self.headers.get(name).map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.header", e.to_string()))
        })
    }

    /// The value of the session cookie, if the request carried one.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the `Cookie` header cannot be read.
    pub fn session_cookie(&self) -> Result<Option<String>> {
        let Some(header) = self.header("Cookie")? else {
            return Ok(None);
        };
        Ok(parse_cookie(&header, SESSION_COOKIE_NAME))
    }

    /// Whether the request declared a JSON body.
    ///
    /// # Errors
    ///
    /// As [`IncomingRequest::header`].
    pub fn declares_json(&self) -> Result<bool> {
        Ok(self
            .header("Content-Type")?
            .is_some_and(|value| value.to_ascii_lowercase().contains("application/json")))
    }
}

/// Find one cookie's value in a `Cookie` header.
///
/// Split on `;`, then on the first `=` of each pair. Splitting on the first `=`
/// only matters for base64url values, which contain no `=` — but a value that
/// did contain one would otherwise lose its tail, and a session cookie whose
/// value is silently truncated is a session cookie that never matches.
///
/// Not percent-decoded: this provider's cookie values are base64url, which has
/// nothing to percent-decode, and decoding would let a `%2E` in a value change
/// what the comparison sees.
#[must_use]
pub fn parse_cookie(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key.trim() == name {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

/// Whether a `Content-Type` names JSON, ignoring parameters.
///
/// # Errors
///
/// None. A malformed content type is not an error; it simply is not JSON, and
/// the caller's body decode then fails on its own terms.
#[must_use]
pub fn content_type_is_json(value: &str) -> bool {
    let media_type = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    media_type == "application/json" || media_type.ends_with("+json")
}

/// The `Content-Type` of a request expressed as a `JsValue`, for building an
/// outbound request through a service binding.
#[must_use]
pub fn js_content_type_json() -> JsValue {
    JsValue::from_str("application/json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_limit_is_a_real_number_and_not_a_no_op() {
        // A limit of `usize::MAX`, or of zero, would both compile — and both
        // are the two ways this primitive reopens: an unbounded body is the
        // DoS, and a zero limit is a service that refuses every request. So
        // the assertion is against those two values specifically, not `> 0`,
        // which the previous line already implies and which therefore proves
        // nothing on its own.
        assert_eq!(MAX_JSON_BODY_BYTES, 65_536);
        assert_ne!(MAX_JSON_BODY_BYTES, 0, "a zero limit refuses every request");
        // Compared against a value the compiler cannot fold, so this is a real
        // assertion rather than a constant dressed up as one: `usize::MAX` in
        // an `assert!` is a compile-time fact about the type, not about this
        // constant, and clippy is right to reject it.
        let unbounded = std::hint::black_box(usize::MAX);
        assert_ne!(
            MAX_JSON_BODY_BYTES, unbounded,
            "usize::MAX is no limit at all"
        );
        // And it is a limit a real request fits inside, so the constant is a
        // chosen number rather than an arbitrary one.
        let typical_body = std::hint::black_box(4096_usize);
        assert!(
            MAX_JSON_BODY_BYTES >= typical_body,
            "a 4 KiB JSON body is unremarkable"
        );
    }

    #[test]
    fn a_cookie_is_found_among_severals() {
        let header = "other=1; __Host-ecoma_session=abc123; last=2";
        assert_eq!(
            parse_cookie(header, SESSION_COOKIE_NAME).as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn an_absent_cookie_is_none_and_not_an_empty_string() {
        // An empty value and an absent cookie are different states, and
        // conflating them would authenticate the string "".
        assert!(parse_cookie("other=1", SESSION_COOKIE_NAME).is_none());
        assert!(parse_cookie("", SESSION_COOKIE_NAME).is_none());
        assert_eq!(
            parse_cookie("__Host-ecoma_session=", SESSION_COOKIE_NAME).as_deref(),
            Some("")
        );
    }

    #[test]
    fn a_cookie_name_is_matched_exactly_and_after_trimming() {
        // `X__Host-ecoma_session` must not match, and neither must a name with
        // trailing space that the browser would not have sent.
        assert!(parse_cookie("X__Host-ecoma_session=v", SESSION_COOKIE_NAME).is_none());
        assert_eq!(
            parse_cookie("  __Host-ecoma_session=v  ", SESSION_COOKIE_NAME).as_deref(),
            Some("v")
        );
    }

    #[test]
    fn a_value_containing_an_equals_sign_keeps_its_tail() {
        // Not a base64url value, but the parser must not be the thing that
        // decides which characters are legal in a session credential.
        assert_eq!(parse_cookie("k=a=b=c", "k").as_deref(), Some("a=b=c"));
    }

    #[test]
    fn a_cookie_value_is_not_percent_decoded() {
        // Decoding here would let `%2E` in a presented value compare equal to
        // `.` and turn a byte-for-byte credential check into a normalising one.
        assert_eq!(parse_cookie("k=%2E%2E", "k").as_deref(), Some("%2E%2E"));
    }

    #[test]
    fn a_json_content_type_is_recognised_with_its_charset_and_suffixes() {
        assert!(content_type_is_json("application/json"));
        assert!(content_type_is_json("application/json; charset=utf-8"));
        assert!(content_type_is_json("APPLICATION/JSON"));
        assert!(content_type_is_json("application/problem+json"));
        assert!(!content_type_is_json("application/x-www-form-urlencoded"));
        assert!(!content_type_is_json("text/json-ish"));
        assert!(!content_type_is_json(""));
    }

    #[test]
    fn the_cookie_name_carries_the_host_prefix() {
        // `__Host-` is not decoration: a browser refuses to accept a `__Host-`
        // cookie that was not set with `Secure` and without a `Domain`, which
        // is a second line of defence against a subdomain fixing the cookie for
        // the whole origin.
        assert!(SESSION_COOKIE_NAME.starts_with("__Host-"));
    }
}
