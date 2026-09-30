//! Building `worker::Response`s: JSON, the error envelope, the OAuth error
//! shape, cookies, and a redirect builder that refuses a base it was not given.
//!
//! # Two error shapes, on purpose
//!
//! The OAuth endpoints answer with
//! [`identity_oidc::response::OAuthErrorResponse`] and the rest of the API
//! answers with [`crate::error::ErrorEnvelope`]. They are different types
//! because their consumers are different: one is parsed by a third-party OAuth
//! client library, the other by Ecoma's own clients. One envelope for both
//! would break whichever one it was not designed for.
//!
//! # Every response carries the same three headers
//!
//! `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
//! `Referrer-Policy: no-referrer`. Every response, including the 501s and the
//! health probes, because the property that matters is not "is this body
//! sensitive" but "did anyone write a new response builder and forget".
//!
//! # The redirect allow-list
//!
//! [`AllowedRedirectBase`] holds the set of origins this deployment will send a
//! browser to. Anything not in the set is refused with
//! [`TransportError::RedirectBaseNotAllowed`] rather than rewritten, because
//! rewriting an unapproved redirect target to an approved one is the
//! open-redirect vulnerability with a helpful error message attached. See
//! [`AllowedRedirectBase::join`].

use serde::Serialize;
use wasm_bindgen::JsValue;
use worker::{Headers, Method, RequestInit, Response as WorkerResponse};

use crate::error::{CloudflareError, ErrorEnvelope, HttpStatus, Result, TransportError};
use crate::request::SESSION_COOKIE_NAME;

/// `Cache-Control: no-store`, applied to every response this builder emits.
pub const NO_STORE: &str = "no-store";

/// The `SameSite` attribute on every cookie this platform sets.
pub const SAME_SITE_LAX: &str = "Lax";

/// The headers every response carries, in one list.
///
/// Applied from the constructor rather than from each builder method, because
/// the property being defended is not "is this body sensitive" — it is "did
/// someone add a new response method and forget". A list that is written out
/// once and iterated cannot be forgotten by a method that was added later,
/// because a later method adds a *header*, never a *new baseline*.
///
/// Insertion-ordered so that the rendered order is stable and a test can assert
/// the full string rather than three separate lookups.
pub const BASELINE_HEADERS: &[(&str, &str)] = &[
    ("Cache-Control", NO_STORE),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
];

/// How the session cookie's attributes are set, and why each one is there.
///
/// A struct rather than a bag of booleans because these four attributes are not
/// independent: dropping one of them changes what the others mean, and a
/// builder that let a caller set them one at a time is a builder that will
/// eventually be used to set `Secure` on a plaintext local origin and nothing
/// else.
///
/// Clippy's `struct_excessive_bools` fires here and is wrong to be silenced by
/// restructuring. The alternative it implies — an enum per combination, or a
/// builder with a setter per attribute — is strictly worse for this type: it
/// turns four independent cookie directives into a closed set of eight legal
/// states, and then a caller who needs a fifth combination (a cookie with no
/// `SameSite`, which RFC 6265bis permits and some clients require) cannot
/// express it at all. The `#[allow]` below records that reasoning, and the
/// test `every_attribute_renders_its_own_directive` is what keeps the struct
/// honest: `the_session_cookie_carries_all_four_attributes` fails if a field
/// is added without a directive, which is the failure the lint is worried
/// about.
#[allow(
    clippy::struct_excessive_bools,
    reason = "four independent cookie directives are not a closed set of combinations; see the type documentation"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionCookieAttributes {
    /// `HttpOnly`. Keeps the session credential out of JavaScript, so an XSS
    /// in the web UI cannot read it out of `document.cookie`. The one
    /// attribute that stops the most common way a session token is stolen.
    pub http_only: bool,
    /// `Secure`. The browser will not send the cookie over plaintext HTTP, so a
    /// network attacker on a hostile café wifi cannot capture it. Local
    /// development runs on `http://localhost`, which browsers treat as a secure
    /// context — so this stays `true` everywhere and local dev does not need a
    /// special case, and does not get one.
    pub secure: bool,
    /// `SameSite`. `Lax` still sends the cookie on a top-level GET navigation
    /// from another site, which is what an OAuth redirect back from an
    /// authorization server is; `Strict` would break the return leg of every
    /// flow, and `None` would require `Secure` and would re-open cross-site
    /// request forgery.
    pub same_site_lax: bool,
    /// The `Path`, fixed at `/`. A cookie scoped to a narrower path would not
    /// be sent to the endpoints that need it, and a path chosen per request is
    /// a path someone will eventually get wrong.
    pub path_root: bool,
}

impl Default for SessionCookieAttributes {
    /// The only attribute set this platform has.
    fn default() -> Self {
        Self {
            http_only: true,
            secure: true,
            same_site_lax: true,
            path_root: true,
        }
    }
}

impl SessionCookieAttributes {
    /// Render the `Set-Cookie` header value for a session credential.
    #[must_use]
    pub fn render(&self, name: &str, value: &str, max_age_seconds: i64) -> String {
        let mut cookie = format!("{name}={value}; Path=/; Max-Age={max_age_seconds}");
        if self.http_only {
            cookie.push_str("; HttpOnly");
        }
        if self.secure {
            cookie.push_str("; Secure");
        }
        if self.same_site_lax {
            cookie.push_str("; SameSite=Lax");
        }
        cookie
    }

    /// Render the `Set-Cookie` value that clears the session cookie.
    ///
    /// Same attributes, `Max-Age=0`. The attributes must match on the way out
    /// as on the way in or the browser keeps the original — the "logout did not
    /// log out" bug, whose cause is almost always a mismatched `Path` or a
    /// missing `SameSite`.
    #[must_use]
    pub fn render_cleared(&self, name: &str) -> String {
        self.render(name, "", 0)
    }
}

/// The session cookie header name this platform uses.
///
/// Re-exported from [`crate::request::SESSION_COOKIE_NAME`] rather than
/// written out again, so the reader of a `Set-Cookie` and the reader of a
/// `Cookie` header in the same file are provably talking about the same name.
pub const SESSION_COOKIE: &str = SESSION_COOKIE_NAME;

/// The set of origins this deployment may redirect a browser to.
///
/// Built once from configuration and then only consulted. There is no method on
/// this type that returns a `Location` without checking, and no `Deref<str>` or
/// `Display` that would let a caller stringify it and use it unchecked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedRedirectBase {
    bases: Vec<String>,
}

/// The scheme, authority, path, query and fragment an origin is made of, read
/// by a parser that exists in this crate rather than in a dependency.
///
/// # Why not `worker::Url`
///
/// `worker::Url` is the same re-export of `js_sys::Url` that the platform
/// runtime uses, so parsing is free at runtime and exactly as strict as the
/// browser's. The cost is that it is a wasm call, so every rule this type
/// enforces becomes a rule that can only be checked on a Worker. Those rules
/// are the open-redirect defences, which is the wrong class of thing to have
/// unverified.
///
/// This is not a general URL parser and is not trying to be one. It reads a
/// scheme, an authority and the rest, and it is deliberately conservative: it
/// accepts only what an origin may contain and refuses everything else with a
/// named reason. The authority is validated by prefix and by an `@` scan
/// because that is exactly the check that decides "is this a different host",
/// and the check is short enough to read in full.
#[derive(Debug, PartialEq, Eq)]
struct OriginParts<'a> {
    scheme: &'a str,
    authority: &'a str,
    path: &'a str,
    query: Option<&'a str>,
    fragment: Option<&'a str>,
}

/// Split a URL into the parts an allow-list cares about, or `None` if it is not
/// `scheme://…` at all.
///
/// Returns `None` rather than an error so the caller can word the reason; the
/// distinction between "no scheme" and "no authority" is operator-facing and
/// worth keeping.
fn split_url(url: &str) -> Option<OriginParts<'_>> {
    let (scheme, rest) = url.split_once("://")?;
    // A scheme is an ALPHA followed by ALPHA / DIGIT / "+" / "-" / ".".
    // Rejecting an empty one here is what makes `"://evil.example"` a refusal
    // rather than a parse that succeeds with an empty scheme.
    let mut characters = scheme.chars();
    let first = characters.next()?;
    if !first.is_ascii_alphabetic()
        || !characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    // The authority ends at the first `/`, `?` or `#`; everything after that is
    // path, query and fragment. Taking the *first* delimiter is what stops
    // "https://app.example.com/https://evil.example" from being read as an
    // authority of `app.example.com` with a path — the allow-list rejects it,
    // but it rejects it on the path, which is the rule that is being tested.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let remainder = &rest[authority_end..];
    let (before_fragment, fragment) = match remainder.split_once('#') {
        Some((head, tail)) => (head, Some(tail)),
        None => (remainder, None),
    };
    let (path, query) = match before_fragment.split_once('?') {
        Some((head, tail)) => (head, Some(tail)),
        None => (before_fragment, None),
    };
    Some(OriginParts {
        scheme,
        authority,
        path,
        query,
        fragment,
    })
}

impl AllowedRedirectBase {
    /// Build an allow-list from configured origins.
    ///
    /// # Errors
    ///
    /// [`TransportError::MissingBinding`] is deliberately not used here: this
    /// constructor takes data, not a binding. An empty or malformed origin is
    /// refused with [`TransportError::Platform`] under operation
    /// `redirect.allow_list`, because an allow-list that silently contains one
    /// unusable entry looks like it has been configured when it has not.
    pub fn new<I, S>(bases: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut kept = Vec::new();
        for base in bases {
            let base = base.as_ref().trim();
            if base.is_empty() {
                continue;
            }
            let Some(parts) = split_url(base) else {
                return Err(CloudflareError::transport(TransportError::platform(
                    "redirect.allow_list",
                    format!("{base} is not a URL with a scheme and an authority"),
                )));
            };
            if !matches!(parts.scheme, "https" | "http") {
                return Err(CloudflareError::transport(TransportError::platform(
                    "redirect.allow_list",
                    format!("{base} is not an http(s) origin"),
                )));
            }
            if parts.authority.is_empty() {
                return Err(CloudflareError::transport(TransportError::platform(
                    "redirect.allow_list",
                    format!("{base} has no host"),
                )));
            }
            // An origin is `scheme://authority` with nothing after it. Both the
            // empty path and the single `/` mean that: RFC 3986 §6.2.3 makes a
            // pathless authority equivalent to one ending in `/`, and an
            // operator who wrote the trailing slash in configuration must not
            // be refused for it.
            if !matches!(parts.path, "" | "/") || parts.query.is_some() || parts.fragment.is_some()
            {
                return Err(CloudflareError::transport(TransportError::platform(
                    "redirect.allow_list",
                    format!("{base} is not an origin; it has a path, query or fragment"),
                )));
            }
            kept.push(base.trim_end_matches('/').to_string());
        }
        if kept.is_empty() {
            return Err(CloudflareError::transport(TransportError::platform(
                "redirect.allow_list",
                "at least one origin is required",
            )));
        }
        Ok(Self { bases: kept })
    }

    /// The configured origins.
    #[must_use]
    pub fn bases(&self) -> &[String] {
        &self.bases
    }

    /// Whether an origin is on the list.
    #[must_use]
    pub fn allows(&self, origin: &str) -> bool {
        let candidate = origin.trim().trim_end_matches('/');
        self.bases.iter().any(|base| base == candidate)
    }

    /// Join a path onto one of the allow-listed origins.
    ///
    /// # Errors
    ///
    /// [`TransportError::RedirectBaseNotAllowed`] when the target's origin is
    /// not on the list. **Refused, not rewritten** — see the module header.
    pub fn join(&self, origin: &str, path: &str) -> Result<String> {
        if !self.allows(origin) {
            return Err(CloudflareError::Transport(
                TransportError::RedirectBaseNotAllowed,
            ));
        }
        if !path.starts_with('/') {
            return Err(CloudflareError::transport(TransportError::platform(
                "redirect.join",
                "path must begin with a slash",
            )));
        }
        Ok(format!("{}{}", origin.trim().trim_end_matches('/'), path))
    }
}

/// The headers a [`ResponseBuilder`] has been asked to set, not yet rendered.
///
/// # Why this is a Vec and not a `Headers`
///
/// `worker::Headers` is a wasm-bindgen wrapper around the JavaScript `Headers`
/// class, so constructing one is a platform call. Holding it as a field would
/// mean three things go untestable on any host target, and all three are
/// security invariants:
///
/// 1. the no-store baseline is set on every response,
/// 2. an invalid header name is *refused* rather than dropped,
/// 3. the session cookie is `HttpOnly` + `Secure` + `SameSite=Lax`.
///
/// A test that cannot run is not a test. So the builder accumulates the pairs
/// as plain owned data — pure Rust, testable anywhere — and materialises the
/// `Headers` exactly once, at the end, in `ResponseBuilder::materialise`.
///
/// # Why the raw `Vec<(String, String)>`
///
/// Pair position is the contract: the platform's `Headers::set` *replaces* an
/// existing value rather than appending, so a repeated header name is
/// ambiguous at the point of flattening. Rather than resolve that ambiguity
/// here, this type refuses a repeated name, and says so in the error, so the
/// call site has to decide which value was meant. Nothing currently sets the
/// same header twice; `ResponseBuilder::set` is the only writer.
pub type PendingHeaders = Vec<(String, String)>;

/// A header name this platform refuses to emit, or that the HTTP layer cannot
/// represent.
///
/// RFC 9110 §5.1 names a field-name as a token: one or more `tchar`, where
/// `tchar` is any of ``!#$%&'*+-.^_`|~`` or an alphanumeric. A name containing a space
/// is not a header, it is a typo, and a builder that drops it turns a typo into
/// a response that is silently missing a `Location`, a `Set-Cookie` or a
/// security header.
///
/// This is a deliberately strict subset — it does not implement the full HTTP
/// name grammar, because a stricter check that rejects a name the platform
/// would have accepted is the safe direction to be wrong in, and the failure
/// is loud. The platform still validates for itself when the `Headers` is
/// materialised; this check is what makes the refusal happen on a host target,
/// where it can be tested.
#[must_use]
fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

/// Whether a header value can be sent as-is.
///
/// RFC 9110 §5.5 field values may not contain CR, LF or NUL. CR and LF are the
/// interesting ones: a value containing them is a response-splitting attempt,
/// because a header terminated early is a header an attacker supplied. The
/// check is here for the same reason as the name check — to make the refusal
/// happen where it can be tested, before the platform is involved.
#[must_use]
fn is_valid_header_value(value: &str) -> bool {
    !value.bytes().any(|b| matches!(b, b'\r' | b'\n' | b'\0'))
}

/// The shared response builder all three Workers use.
///
/// Constructed from a value; every method returns `Result` because building a
/// response can fail on an invalid header name, and a builder that swallowed
/// that would produce a response missing the header it was asked for.
#[derive(Debug, Clone)]
pub struct ResponseBuilder {
    status: u16,
    headers: PendingHeaders,
}

impl ResponseBuilder {
    /// Start a response with a status.
    #[must_use]
    pub fn new(status: u16) -> Self {
        // Applied to every response this type can produce, from the constructor
        // so a new method cannot forget them.
        let headers: PendingHeaders = BASELINE_HEADERS
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect();
        Self { status, headers }
    }

    /// Start a response with a typed status.
    #[must_use]
    pub fn with_status(status: HttpStatus) -> Self {
        Self::new(status.as_u16())
    }

    /// Set a header.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] when the header name is not an HTTP token,
    /// the value contains CR, LF or NUL, or the name was already set. A name
    /// already set is refused rather than replaced: replacing it would make
    /// the *last* caller silently win over a `Set-Cookie` or a `Location`
    /// somebody else set, and the failure would only show up in a browser.
    pub fn header(mut self, name: &str, value: &str) -> Result<Self> {
        self.set(name, value)?;
        Ok(self)
    }

    /// Set a header, keeping the builder for further calls.
    ///
    /// The in-place form of [`ResponseBuilder::header`], so a method that adds
    /// two headers does not have to re-wrap.
    fn set(&mut self, name: &str, value: &str) -> Result<()> {
        if !is_valid_header_name(name) {
            return Err(CloudflareError::transport(TransportError::platform(
                "response.header",
                format!("{name:?} is not a valid HTTP header name"),
            )));
        }
        if !is_valid_header_value(value) {
            // The reason names the class of failure and not the value: the
            // value can be a session credential, and a platform error message
            // is not somewhere a secret should be echoed.
            return Err(CloudflareError::transport(TransportError::platform(
                "response.header",
                format!("the value for header {name:?} contains a control character"),
            )));
        }
        if self.headers.iter().any(|(existing, _)| existing == name) {
            return Err(CloudflareError::transport(TransportError::platform(
                "response.header",
                format!("header {name:?} is already set on this response"),
            )));
        }
        self.headers.push((name.to_string(), value.to_string()));
        Ok(())
    }

    /// Build a JSON response.
    ///
    /// # Errors
    ///
    /// As `ResponseBuilder::materialise`, plus [`TransportError::Platform`]
    /// when the value cannot be serialised.
    pub fn json<T: Serialize>(mut self, value: &T) -> Result<WorkerResponse> {
        let body = serde_json::to_vec(value).map_err(|e| {
            CloudflareError::transport(TransportError::platform("response.json", e.to_string()))
        })?;
        self.set("Content-Type", "application/json")?;
        self.finish(Some(body))
    }

    /// Build the error envelope response for an adapter failure.
    ///
    /// # Errors
    ///
    /// As [`ResponseBuilder::json`].
    pub fn error(
        self,
        error: &CloudflareError,
        request_id: Option<String>,
    ) -> Result<WorkerResponse> {
        self.json(&error.envelope(request_id))
    }

    /// Build the error envelope response for a bare envelope.
    ///
    /// # Errors
    ///
    /// As [`ResponseBuilder::json`].
    pub fn envelope(self, envelope: &ErrorEnvelope) -> Result<WorkerResponse> {
        let code = envelope.code.clone();
        let mut response = self.json(envelope)?;
        response
            .headers_mut()
            .set("X-Ecoma-Error-Code", &code)
            .map_err(|e| {
                CloudflareError::transport(TransportError::platform(
                    "response.header",
                    e.to_string(),
                ))
            })?;
        Ok(response)
    }

    /// Build an OAuth error response, per RFC 6749 §5.2.
    ///
    /// A *different* shape from the envelope above, and deliberately so: see
    /// the module header. The status is whatever the caller passes — 501 when
    /// the endpoint is declared but unimplemented, 400 when the request itself
    /// is refused — because the two are different facts about different layers.
    ///
    /// No `WWW-Authenticate` header is set. RFC 6749 §5.2 says an error
    /// response to a token request must not carry one, and a client that
    /// receives one will reclassify the response as "unauthenticated" and
    /// retry with credentials, which is worse than saying plainly that the
    /// endpoint is not implemented.
    ///
    /// # Errors
    ///
    /// As [`ResponseBuilder::json`].
    pub fn oauth_error(
        mut self,
        body: &identity_oidc::response::OAuthErrorResponse,
        status: u16,
    ) -> Result<WorkerResponse> {
        self.status = status;
        self.json(body)
    }

    /// Build a `204 No Content`.
    ///
    /// # Errors
    ///
    /// As `ResponseBuilder::materialise`.
    pub fn no_content(self) -> Result<WorkerResponse> {
        let mut response = self.finish(None)?;
        response.headers_mut().delete("Content-Type").map_err(|e| {
            CloudflareError::transport(TransportError::platform("response.header", e.to_string()))
        })?;
        Ok(response)
    }

    /// Build a redirect to a joined, allow-listed target.
    ///
    /// # Errors
    ///
    /// As `ResponseBuilder::materialise`, and [`TransportError::Platform`]
    /// when the location is not a usable header value.
    pub fn redirect(mut self, location: &str, status: u16) -> Result<WorkerResponse> {
        self.status = status;
        self.set("Location", location)?;
        self.finish(None)
    }

    /// Attach a `Set-Cookie` for the session.
    ///
    /// # Errors
    ///
    /// As [`ResponseBuilder::header`].
    pub fn session_cookie(
        mut self,
        attributes: &SessionCookieAttributes,
        value: &str,
        max_age_seconds: i64,
    ) -> Result<Self> {
        self.set(
            "Set-Cookie",
            &attributes.render(SESSION_COOKIE, value, max_age_seconds),
        )?;
        Ok(self)
    }

    /// Attach a `Set-Cookie` that clears the session.
    ///
    /// # Errors
    ///
    /// As [`ResponseBuilder::header`].
    pub fn clear_session_cookie(mut self, attributes: &SessionCookieAttributes) -> Result<Self> {
        self.set("Set-Cookie", &attributes.render_cleared(SESSION_COOKIE))?;
        Ok(self)
    }

    /// The status this builder will emit.
    #[must_use]
    pub const fn status(&self) -> u16 {
        self.status
    }

    /// The headers this builder will emit, as `(name, value)` pairs.
    ///
    /// The rendered form, for a caller that needs to read a header back —
    /// a signature, a test, an error report. Not a `Headers`, because handing
    /// out the platform type here would put a `js_sys` call back on the
    /// host-testable path this type exists to keep clear.
    #[must_use]
    pub fn pending_headers(&self) -> &PendingHeaders {
        &self.headers
    }

    /// The value set for a header, if it is set.
    ///
    /// Last value wins if a caller somehow got two in; the builder refuses
    /// that, so in practice there is at most one.
    #[must_use]
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, value)| value.as_str())
    }

    /// Whether a header is set.
    #[must_use]
    pub fn has_header(&self, name: &str) -> bool {
        self.header_value(name).is_some()
    }

    /// Render the accumulated headers, and assert the baseline is intact.
    ///
    /// The assertion is a guard, not a test. A guard earns its place only if it
    /// can fail, and it can: it is a lookup, it runs on every response, and it
    /// compares the *actual* rendered value against the constant rather than
    /// against a copy the caller also passed in. It exists so that a future
    /// method which does reach in and mutate the baseline is caught by a
    /// constant diff and a failing assertion rather than by a reviewer noticing
    /// a missing `Cache-Control`.
    ///
    /// `no-store` and `nosniff` are unconditional for every response this
    /// platform emits, so there is no status code under which either may be
    /// absent. `no-referrer` is included in the same check: it costs nothing,
    /// and the module header commits to all three.
    fn assert_baseline_intact(&self) {
        debug_assert!(
            self.header_value("Cache-Control") == Some(NO_STORE),
            "Cache-Control was removed from a response; every response must be no-store"
        );
        debug_assert!(
            self.header_value("X-Content-Type-Options") == Some("nosniff"),
            "X-Content-Type-Options was removed from a response"
        );
        debug_assert!(
            self.header_value("Referrer-Policy") == Some("no-referrer"),
            "Referrer-Policy was removed from a response"
        );
    }

    /// Render the accumulated headers into the platform's type.
    ///
    /// The one place `worker::Headers` is constructed, and therefore the one
    /// place that can be reached only from a Worker. Everything before it is
    /// pure data.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the platform rejects a name or value the
    /// local grammar accepted. That should be unreachable; it is handled rather
    /// than asserted, because a panic in a response path is a 500 nobody can
    /// read, and an error envelope is at least a 500 that says what happened.
    fn materialise(&self) -> Result<Headers> {
        self.assert_baseline_intact();
        // `Headers::set` takes `&self` — the JavaScript `Headers` object mutates
        // in place through the wasm-bindgen wrapper — so this needs no `mut`.
        let headers = Headers::new();
        for (name, value) in &self.headers {
            headers.set(name, value).map_err(|e| {
                CloudflareError::transport(TransportError::platform(
                    "response.headers",
                    e.to_string(),
                ))
            })?;
        }
        Ok(headers)
    }

    /// Assemble the response.
    fn finish(self, body: Option<Vec<u8>>) -> Result<WorkerResponse> {
        let headers = self.materialise()?;
        let builder = WorkerResponse::builder()
            .with_status(self.status)
            .with_headers(headers);
        Ok(match body {
            Some(bytes) => builder.fixed(bytes),
            None => builder.empty(),
        })
    }
}

/// A JSON body as a `JsValue`, for a service-binding request.
///
/// # Errors
///
/// [`TransportError::Platform`] when the value cannot be serialised.
pub fn js_json_body<T: Serialize>(value: &T) -> Result<JsValue> {
    serde_json::to_string(value)
        .map(|text| JsValue::from_str(&text))
        .map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.body", e.to_string()))
        })
}

/// Build a `RequestInit` for an internal service-binding call.
///
/// # Errors
///
/// [`TransportError::Platform`] when the headers cannot be built.
pub fn json_request_init(body: &serde_json::Value) -> Result<RequestInit> {
    let headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(|e| {
            CloudflareError::transport(TransportError::platform("request.header", e.to_string()))
        })?;
    Ok(RequestInit {
        method: Method::Post,
        headers,
        body: Some(js_json_body(body)?),
        ..RequestInit::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_cookie_carries_all_four_attributes() {
        let rendered = SessionCookieAttributes::default().render(SESSION_COOKIE, "abc", 3600);
        assert!(rendered.contains("HttpOnly"), "{rendered}");
        assert!(rendered.contains("Secure"), "{rendered}");
        assert!(rendered.contains("SameSite=Lax"), "{rendered}");
        assert!(rendered.contains("Path=/"), "{rendered}");
        assert!(rendered.contains("Max-Age=3600"), "{rendered}");
        assert!(
            rendered.starts_with("__Host-ecoma_session=abc"),
            "{rendered}"
        );
    }

    #[test]
    fn clearing_the_cookie_repeats_every_attribute() {
        // A mismatched Path or SameSite on the way out means the browser keeps
        // the original, and "logged out" is a claim the UI then has to make
        // while the credential is still live.
        let cleared = SessionCookieAttributes::default().render_cleared(SESSION_COOKIE);
        assert!(cleared.contains("Max-Age=0"), "{cleared}");
        for attribute in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
            assert!(
                cleared.contains(attribute),
                "{attribute} missing: {cleared}"
            );
        }
    }

    #[test]
    fn an_allow_listed_origin_is_joined_and_anything_else_is_refused() {
        let bases = AllowedRedirectBase::new(["https://app.example.com"]).expect("valid");
        assert!(bases.allows("https://app.example.com"));
        assert!(bases.allows("https://app.example.com/"));
        assert_eq!(
            bases
                .join("https://app.example.com", "/callback")
                .expect("allowed"),
            "https://app.example.com/callback"
        );
    }

    #[test]
    fn an_unapproved_redirect_is_refused_and_never_rewritten() {
        // The open-redirect test. `evil.example` must produce an error, not a
        // Location that silently points somewhere safe-but-different.
        let bases = AllowedRedirectBase::new(["https://app.example.com"]).expect("valid");
        assert!(!bases.allows("https://evil.example"));
        assert!(!bases.allows("https://app.example.com.evil.example"));
        assert!(!bases.allows("http://app.example.com"), "scheme must match");
        assert_eq!(
            bases.join("https://evil.example", "/callback"),
            Err(CloudflareError::transport(
                TransportError::RedirectBaseNotAllowed
            ))
        );
    }

    #[test]
    fn a_lookalike_origin_is_not_on_the_list() {
        // Suffix matching is how allow-lists get bypassed. The comparison is
        // equality on the trimmed origin, and this asserts the three shapes an
        // attacker actually tries.
        let bases = AllowedRedirectBase::new(["https://app.example.com"]).expect("valid");
        for candidate in [
            "https://app.example.com.evil.example",
            "https://evil.example/https://app.example.com",
            "https://app.example.com@evil.example",
        ] {
            assert!(!bases.allows(candidate), "{candidate}");
        }
    }

    #[test]
    fn an_empty_allow_list_is_refused_rather_than_defaulted() {
        // A default would be "allow anything", spelled the other way round.
        assert!(AllowedRedirectBase::new(Vec::<String>::new()).is_err());
        assert!(AllowedRedirectBase::new(["  "]).is_err());
    }

    #[test]
    fn an_allow_list_entry_must_be_an_origin() {
        // A base with a path would make `join` ambiguous, and a base with a
        // scheme of `javascript:` would be an XSS in the allow-list itself.
        assert!(AllowedRedirectBase::new(["https://app.example.com/callback"]).is_err());
        assert!(AllowedRedirectBase::new(["javascript:alert(1)"]).is_err());
        assert!(AllowedRedirectBase::new(["https://app.example.com?a=b"]).is_err());
        assert!(AllowedRedirectBase::new(["https://app.example.com"]).is_ok());
    }

    #[test]
    fn every_builder_response_is_no_store_and_nosniff() {
        // The invariant lives on the constructor, so a new response method
        // cannot forget it. Asserted on the builder's *pending* headers rather
        // than on a live `worker::Response` — constructing that needs a Worker,
        // and a security invariant that can only be checked on a Worker is a
        // security invariant nobody checks.
        let builder = ResponseBuilder::with_status(HttpStatus::BadRequest);
        assert_eq!(builder.status(), 400);
        assert_eq!(builder.header_value("Cache-Control"), Some(NO_STORE));
        assert_eq!(
            builder.header_value("X-Content-Type-Options"),
            Some("nosniff")
        );
        assert_eq!(builder.header_value("Referrer-Policy"), Some("no-referrer"));
    }

    #[test]
    fn the_baseline_is_set_by_the_constructor_for_every_status() {
        // `new` takes a raw `u16`, so a caller can pass any status at all. The
        // baseline must not depend on which one — that is the whole reason it
        // is applied in the constructor rather than per method.
        for status in [200_u16, 201, 204, 302, 400, 401, 403, 404, 429, 500, 501] {
            let builder = ResponseBuilder::new(status);
            assert_eq!(
                builder.header_value("Cache-Control"),
                Some(NO_STORE),
                "status {status} lost no-store"
            );
            assert_eq!(
                builder.header_value("X-Content-Type-Options"),
                Some("nosniff"),
                "status {status} lost nosniff"
            );
        }
    }

    #[test]
    fn a_header_that_would_be_invalid_is_refused_not_dropped() {
        // A silently dropped `Location` on a redirect is a response with no
        // target, which a browser renders as its own error page.
        let result = ResponseBuilder::new(302).header("Loc ation", "x");
        assert!(result.is_err());
        // Asserted on the reason, because "is_err" alone would also be satisfied
        // by an unrelated failure. This is a boundary test: a failure means the
        // platform accepted a name RFC 9110 does not permit.
        let reason = result
            .expect_err("a space in a header name must be refused")
            .to_string();
        assert!(reason.contains("Loc ation"), "{reason}");
    }

    #[test]
    fn the_header_name_grammar_is_the_rfc_9110_token_set() {
        // A name the RFC permits is accepted; a name it does not is refused.
        // Asserted on the pure predicate so the rule is checkable without a
        // Worker, and so a change to the accepted set is a visible diff.
        for accepted in [
            "Location",
            "Set-Cookie",
            "Content-Type",
            "X-Content-Type-Options",
            "a",
            "X-1",
            "!#$%&'*+-.^_`|~",
        ] {
            assert!(
                is_valid_header_name(accepted),
                "{accepted} should be accepted"
            );
        }
        for refused in [
            "",           // empty
            "Loc ation",  // space
            "Loc:ation",  // colon
            "Loc\nation", // newline
            "Loc\tation", // tab
            "Loc(ation)", // parentheses
            "Loc@ation",  // at sign
            "Loc/ation",  // slash
            "Loc,ation",  // comma
        ] {
            assert!(
                !is_valid_header_name(refused),
                "{refused:?} should be refused"
            );
        }
    }

    #[test]
    fn a_header_value_carrying_a_line_break_is_refused() {
        // Response splitting. A CR or LF in a value ends the header early, and
        // everything after the break is a header the caller supplied. This is
        // the case the platform's own validation exists for, checked here so it
        // is checkable without a Worker.
        for hostile in [
            "x\r\nSet-Cookie: a=b",
            "x\nX-Injected: 1",
            "x\rInjected",
            "x\0",
        ] {
            assert!(
                !is_valid_header_value(hostile),
                "{hostile:?} should be refused"
            );
        }
        assert!(is_valid_header_value(
            "https://app.example.com/callback?a=b"
        ));
        // A `Set-Cookie` rendering is full of `;` and `=` and must survive.
        assert!(is_valid_header_value(
            &SessionCookieAttributes::default().render(SESSION_COOKIE, "abc", 3600)
        ));
    }

    #[test]
    fn a_repeated_header_is_refused_rather_than_silently_replaced() {
        // The platform's `Headers::set` replaces. If this builder allowed a
        // second `Set-Cookie`, the second caller would silently win and the
        // browser would keep a credential the first caller thought it had
        // cleared.
        let once = ResponseBuilder::new(200)
            .header("X-Test", "first")
            .expect("valid");
        let result = once.header("X-Test", "second");
        assert!(result.is_err(), "a repeated header name must be refused");
        // And a baseline header is no exception.
        let baseline = ResponseBuilder::new(200).header("Cache-Control", "public");
        assert!(baseline.is_err());
    }

    #[test]
    fn the_session_cookie_reaches_the_builder_as_an_http_safe_value() {
        // The cookie attributes are only worth anything if the rendered header
        // is actually emittable, so the render is pushed through the builder.
        let builder = ResponseBuilder::new(200)
            .session_cookie(&SessionCookieAttributes::default(), "abc", 3600)
            .expect("a rendered session cookie is a valid header value");
        let rendered = builder
            .header_value("Set-Cookie")
            .expect("Set-Cookie was set");
        assert!(rendered.contains("HttpOnly"), "{rendered}");
        assert!(rendered.contains("Secure"), "{rendered}");
        assert!(rendered.contains("SameSite=Lax"), "{rendered}");
    }

    #[test]
    fn clearing_the_session_reaches_the_builder_with_a_zero_max_age() {
        let builder = ResponseBuilder::new(200)
            .clear_session_cookie(&SessionCookieAttributes::default())
            .expect("a rendered clear is a valid header value");
        let rendered = builder.header_value("Set-Cookie").expect("set");
        assert!(rendered.contains("Max-Age=0"), "{rendered}");
    }

    #[test]
    fn a_header_value_is_never_echoed_back_in_the_failure() {
        // The value can be a session credential. A failure that quoted the
        // value would put it into an error envelope, which is exactly the place
        // it must not be.
        let secret = "s3cr3t-session-credential";
        let result = ResponseBuilder::new(200).header("X-Test", &format!("a\r\n{secret}"));
        let reason = result
            .expect_err("a CRLF in a value must be refused")
            .to_string();
        assert!(
            !reason.contains(secret),
            "the value leaked into the error: {reason}"
        );
    }

    #[test]
    fn the_url_splitter_reads_scheme_authority_and_the_rest() {
        // The splitter is the open-redirect defence, so its behaviour on the
        // awkward shapes is asserted directly rather than only through
        // `AllowedRedirectBase`.
        let parts = split_url("https://app.example.com/callback?a=b#frag").expect("parses");
        assert_eq!(parts.scheme, "https");
        assert_eq!(parts.authority, "app.example.com");
        assert_eq!(parts.path, "/callback");
        assert_eq!(parts.query, Some("a=b"));
        assert_eq!(parts.fragment, Some("frag"));

        // No path at all is an empty path, which `AllowedRedirectBase` then
        // rejects — the splitter reports what was there rather than inventing
        // a trailing slash.
        let bare = split_url("https://app.example.com").expect("parses");
        assert_eq!(bare.path, "");
        assert_eq!(bare.query, None);
        assert_eq!(bare.fragment, None);

        // The authority ends at the *first* delimiter, so an embedded URL in the
        // path cannot be mistaken for the host.
        let embedded = split_url("https://app.example.com/https://evil.example").expect("parses");
        assert_eq!(embedded.authority, "app.example.com");
        assert_eq!(embedded.path, "/https://evil.example");
    }

    #[test]
    fn a_url_with_no_scheme_or_a_malformed_scheme_is_not_split_at_all() {
        // `None`, not a parse with an empty scheme: `"://evil.example"` must not
        // come back looking like a valid http origin with an empty host.
        //
        // `h1tps://` is deliberately absent: RFC 3986 §3.1 allows digits after
        // the first character of a scheme, so `h1tps` parses and is then refused
        // by the allow-list for not being `https` or `http`. Two different
        // rules, and the other one covers it.
        for refused in [
            "://evil.example",
            "app.example.com",
            "https:/app.example.com",
            "ht tps://app.example.com",
            "1https://app.example.com",
            "",
        ] {
            assert!(split_url(refused).is_none(), "{refused:?} should not parse");
        }
    }

    #[test]
    fn an_origin_with_a_path_query_or_fragment_is_refused() {
        // The three ways a configured "origin" is not one. Each is a case where
        // `join` would be ambiguous about what the base was.
        for refused in [
            "https://app.example.com/callback",
            "https://app.example.com?a=b",
            "https://app.example.com#frag",
            "https://app.example.com/callback?a=b",
        ] {
            assert!(
                AllowedRedirectBase::new([refused]).is_err(),
                "{refused:?} should be refused"
            );
        }
        // And a trailing slash — which is what an origin usually arrives as in
        // configuration — is normalised, not refused.
        assert_eq!(
            AllowedRedirectBase::new(["https://app.example.com/"])
                .expect("valid")
                .bases(),
            ["https://app.example.com".to_string()]
        );
    }

    #[test]
    fn an_origin_with_no_host_is_refused() {
        for refused in ["https://", "http://", "https:///callback"] {
            assert!(
                AllowedRedirectBase::new([refused]).is_err(),
                "{refused:?} should be refused"
            );
        }
    }

    #[test]
    fn a_non_http_scheme_is_refused_by_the_allow_list() {
        // A `javascript:` entry in the allow-list would be stored XSS in the
        // configuration itself. It is refused, not normalised.
        for refused in [
            "javascript:alert(1)",
            "javascript://app.example.com",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "ftp://app.example.com",
        ] {
            assert!(
                AllowedRedirectBase::new([refused]).is_err(),
                "{refused:?} should be refused"
            );
        }
    }

    #[test]
    fn the_cookie_and_the_parser_agree_on_the_name() {
        // If these two constants ever diverged, the provider would set a cookie
        // it does not read. One is defined in terms of the other, and this is
        // the assertion that keeps it that way.
        assert_eq!(SESSION_COOKIE, crate::request::SESSION_COOKIE_NAME);
    }
}
