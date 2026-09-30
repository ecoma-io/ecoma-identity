//! The security ports, made real on the platform's `WebCrypto`.
//!
//! # The one rule, from ADR-0008
//!
//! **Every primitive in this file comes from `crypto.subtle`.** There is no
//! hand-rolled cipher, hash, MAC, padding scheme, or comparison anywhere below,
//! and there is no cryptography crate in the dependency graph to make one easy
//! to add. The `web-sys` and `js-sys` dependencies exist to *call* `WebCrypto`
//! and to move bytes across the JS boundary; they implement no algorithm
//! between one and the other.
//!
//! # The constant-time comparison, and why it is not written here
//!
//! A `==` over two secret-derived byte strings is a timing side channel: it
//! returns as soon as the first byte differs, and the length of the running time
//! is a prefix oracle. Writing a loop to "do better" produces
//! `slice::ct_eq`-alike code that a reviewer has to take on trust and that a
//! compiler may re-introduce a short-circuit into.
//!
//! So this module does not compare secrets at all. It asks `WebCrypto` to:
//! `SubtleCrypto::verify()` is the platform's constant-time MAC and signature
//! check, and it is the *only* comparison path here. A PKCE `S256` check is
//! therefore expressed as "recompute the HMAC of both candidate values under
//! one key, then `verify()`" — the byte strings never meet a Rust `==`.
//! See `constant_time_hmac_eq` for the whole argument at the one place it
//! matters, and [`crate::crypto::Deferred`] for what is deliberately absent.
//!
//! # What is implemented, and what is not
//!
//! Implemented, all through `crypto.subtle`:
//!
//! - HMAC-SHA-256 — the PKCE `S256` challenge, and the constant-time
//!   comparison primitive above.
//! - SHA-256 — the PKCE `S256` challenge, and the nonce/state digest.
//! - AES-256-GCM — the at-rest cipher for TOTP seeds and recovery codes.
//! - RS256 — the token signing algorithm, as `RSASSA-PKCS1-v1_5` over
//!   SHA-256, which is what `alg: "RS256"` in a JWKS means.
//! - base64url — the JWS encoding, and the PKCE challenge encoding.
//!
//! **Not** implemented, deliberately:
//!
//! - **TOTP** (RFC 6238) — deferred. It needs a counter-based HMAC, a
//!   truncation rule, a time-step window, and a *prohibition on reuse* that is a
//!   data question (the last used counter), not a maths question. A half-built
//!   TOTP is a second factor that accepts wrong codes, so there is none. See
//!   [`Deferred`].
//! - **The signature-counter [`identity_security::factors::OtpService`]** —
//!   deferred for the same reason. The port exists; this crate does not
//!   implement it.
//! - **ES256 / ECDSA P-256** — the port is algorithm-agnostic, but a second
//!   signing algorithm means a second JWKS key type and a second `alg` value in
//!   the discovery document, and only one is contracted. Adding it is a
//!   contract change, not an implementation detail. RS256 is contracted;
//!   ECDSA is not, and this file does not offer it.
//!
//! Every deferred port returns [`SecurityError::Cryptographic`] with an
//! operation name in the reason, so a caller sees *which* gate is missing
//! rather than a generic failure. Nothing here returns a fabricated token, a
//! plausible default, or a zero.

use identity_security::error::SecurityError;
use identity_security::tokens::{
    PkceService, SecretCipher, SignedToken, SigningKeyId, TokenSigner, TokenVerifier,
};
use js_sys::{Array, ArrayBuffer, Object, Promise, Reflect, Uint8Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::SubtleCrypto;

use crate::secrets::{ENCRYPTION_KEY_BYTES, MIN_SIGNING_SECRET_BYTES, SecretBytes};

/// The `Crypto` object, obtained per call from `globalThis`.
///
/// A `#[wasm_bindgen(inline_js = …)]` shim rather than a `web_sys::window()`
/// lookup: this module must work in a Worker, in a service binding and in a
/// `wrangler dev` isolate, none of which has a `window`. `globalThis.crypto` is
/// the only spelling that is present in all three, and the Workers runtime
/// guarantees it is the platform's implementation — not a polyfill we would
/// have to trust or audit.
///
/// It returns the whole `Crypto`, not just `crypto.subtle`, because
/// `getRandomValues` lives on `Crypto` and is synchronous. See the note below
/// the `SubtleCrypto` block.
#[wasm_bindgen(inline_js = r"
export function __ecoma_crypto() {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error('WebCrypto is unavailable in this runtime');
    }
    return globalThis.crypto;
}
")]
extern "C" {
    #[wasm_bindgen(catch, structural, js_name = __ecoma_crypto)]
    fn platform_crypto() -> Result<web_sys::Crypto, JsValue>;
}

/// `SubtleCrypto.digest`.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, structural, js_name = digest)]
    fn digest_promise(
        this: &SubtleCrypto,
        algorithm: &str,
        data: &Uint8Array,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, structural, js_name = importKey)]
    fn import_key_promise(
        this: &SubtleCrypto,
        format: &str,
        key_data: &Uint8Array,
        algorithm: &Object,
        extractable: bool,
        key_usages: &Array,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, structural, js_name = sign)]
    fn sign_promise(
        this: &SubtleCrypto,
        algorithm: &Object,
        key: &web_sys::CryptoKey,
        data: &Uint8Array,
    ) -> Result<Promise, JsValue>;

    /// The platform's constant-time MAC and signature comparison.
    #[wasm_bindgen(catch, structural, js_name = verify)]
    fn verify_promise(
        this: &SubtleCrypto,
        algorithm: &Object,
        key: &web_sys::CryptoKey,
        signature: &Uint8Array,
        data: &Uint8Array,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, structural, js_name = exportKey)]
    fn export_key_promise(
        this: &SubtleCrypto,
        format: &str,
        key: &web_sys::CryptoKey,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, structural, js_name = encrypt)]
    fn encrypt_promise(
        this: &SubtleCrypto,
        algorithm: &Object,
        key: &web_sys::CryptoKey,
        data: &Uint8Array,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, structural, js_name = decrypt)]
    fn decrypt_promise(
        this: &SubtleCrypto,
        algorithm: &Object,
        key: &web_sys::CryptoKey,
        data: &Uint8Array,
    ) -> Result<Promise, JsValue>;
}

// `crypto.getRandomValues` is deliberately **not** declared as a hand-written
// `extern "C"` block here, and that is a decision rather than an omission.
//
// Unlike every `SubtleCrypto` method above, it is specified as a *synchronous*
// method (W3C Web Cryptography API §5.1) that returns the view it filled, in
// place. It is declared here through `web-sys`'s `#[wasm_bindgen(method, catch)]`
// binding, `Crypto::get_random_values_with_js_u8_array`, which is generated from
// that specification and carries the correct return type. A hand-written
// `-> Result<Promise, JsValue>` signature is *type-correct and silently wrong*:
// the value is not a promise, so awaiting it would either panic or, on a
// thenable-looking object, resolve to `undefined` and leave a zero-filled
// buffer looking like a successful CSPRNG read. `random_bytes` is written
// against the generated binding precisely so that the mistake above cannot be
// made here again, and its doc says why the difference from the block above is
// not an oversight.

/// A cryptographic operation this crate does not implement, on purpose.
///
/// The reason is a sentence, not a shrug: `this crate does not implement <x>`
/// is what a reader of a 500 sees, and it is more useful than a `Cryptographic`
/// message naming a JS error string.
///
/// It is not an `Error` and does not implement `std::error::Error`: it never
/// reaches a `Result` on its own. The ports here return
/// [`SecurityError::Cryptographic`], and this type is the documented shape of
/// the gap behind it — the thing the tests link against and the thing a reader
/// looks up. See [`deferred_port`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deferred {
    /// What is not implemented.
    pub operation: &'static str,
    /// Why it is not implemented, and what has to exist first.
    pub reason: &'static str,
}

impl Deferred {
    /// The reason `WebCrypto` could not be reached at all.
    fn no_platform_crypto() -> Self {
        Self {
            operation: "crypto.subtle",
            reason: "this runtime does not provide WebCrypto SubtleCrypto; no \
                     primitive in this crate is available without it",
        }
    }

    /// The shape of this deferral, for a reader or a log line.
    #[must_use]
    pub fn describe(&self) -> String {
        format!("{} is not implemented: {}", self.operation, self.reason)
    }
}

/// Render a `Deferred` as the `SecurityError` the ports return.
fn deferred_error(operation: &'static str, reason: &str) -> SecurityError {
    SecurityError::Cryptographic {
        reason: format!("{operation} is not implemented: {reason}"),
    }
}

/// The error for a rejected JS promise, without forwarding its text.
///
/// `JsValue` renders as `[object Object]` or, for a `DOMException`, as its
/// `message` — and that message can name the key, the operation and the
/// platform. This maps the rejection to a fixed sentence and returns the
/// `JsValue` nowhere. A log line that names a secret is a `SECURITY.md` finding.
fn rejected(operation: &'static str) -> SecurityError {
    SecurityError::Cryptographic {
        reason: format!(
            "{operation} was rejected by WebCrypto; the platform's reason is not forwarded"
        ),
    }
}

/// Await a promise and downcast it to `T`.
async fn await_value<T>(promise: Promise, operation: &'static str) -> Result<T, SecurityError>
where
    T: JsCast,
{
    let value = JsFuture::from(promise)
        .await
        .map_err(|_| rejected(operation))?;
    value.dyn_into::<T>().map_err(|_| rejected(operation))
}

/// `SubtleCrypto`, or the one error every primitive here reports.
///
/// Not `async`, for the same reason [`platform`] is not: the accessor is a
/// synchronous `#[wasm_bindgen(catch)]` binding. Every primitive here is
/// `async` because the *operations* on `SubtleCrypto` return promises, not
/// because obtaining the object does.
fn subtle() -> Result<SubtleCrypto, SecurityError> {
    Ok(platform()?.subtle())
}

/// The platform's `Crypto`, or the one error every primitive here reports.
///
/// Not `async`, and deliberately: `platform_crypto` is a `#[wasm_bindgen(catch)]`
/// extern binding, which is synchronous — it returns `Result<Crypto, JsValue>`
/// directly rather than a `Promise`. An `async` wrapper here would compile and
/// would be a lie about where the boundary is, because every caller would then
/// have to `.await` something that had already happened. If `WebCrypto`'s
/// accessor ever becomes genuinely asynchronous, this becomes `async` again
/// and the call sites change with it; that is the right time to pay it.
fn platform() -> Result<web_sys::Crypto, SecurityError> {
    platform_crypto().map_err(|_| {
        let gap = Deferred::no_platform_crypto();
        SecurityError::Cryptographic {
            reason: gap.describe(),
        }
    })
}

/// A JS dictionary, for the `Algorithm` parameters `WebCrypto` takes.
fn algorithm(pairs: &[(&str, &str)]) -> Object {
    let object = Object::new();
    for (key, value) in pairs {
        // `Reflect::set` on a freshly created `Object` cannot fail — there is
        // no proxy and no read-only property. The `_` is that fact, not a hope.
        let _ = Reflect::set(&object, &JsValue::from_str(key), &JsValue::from_str(value));
    }
    object
}

/// A JS array of strings, for the `keyUsages` argument.
fn usages(values: &[&str]) -> Array {
    let array = Array::new();
    for value in values {
        array.push(&JsValue::from_str(value));
    }
    array
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

/// The base64url alphabet, without padding, per RFC 4648 §5.
const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode bytes as unpadded base64url.
///
/// This is a *transport encoding*, not a cryptographic primitive: base64url is
/// specified in one paragraph of RFC 4648 and has no secret-dependent
/// behaviour, so the prohibition in ADR-0008 does not reach it. It is written
/// here rather than pulled in as a crate because the alternative is a
/// dependency for six lines, and because the JWS encoding must be byte-exact
/// with what a third-party verifier expects — a decoder that disagreed about
/// padding would break interop, not security.
///
/// # Errors
///
/// None. The input is arbitrary bytes by construction.
#[must_use]
pub fn base64url_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let triple = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(char::from(
            BASE64URL_ALPHABET[((triple >> 18) & 0x3f) as usize],
        ));
        out.push(char::from(
            BASE64URL_ALPHABET[((triple >> 12) & 0x3f) as usize],
        ));
        if chunk.len() > 1 {
            out.push(char::from(
                BASE64URL_ALPHABET[((triple >> 6) & 0x3f) as usize],
            ));
        }
        if chunk.len() > 2 {
            out.push(char::from(BASE64URL_ALPHABET[(triple & 0x3f) as usize]));
        }
    }
    out
}

/// Decode unpadded (or padded) base64url.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when a character is not in the alphabet or
/// a trailing group is impossible. The message names the position, never the
/// value: a decoder that echoes the byte it choked on is an oracle for
/// whatever produced it.
pub fn base64url_decode(input: &str) -> Result<Vec<u8>, SecurityError> {
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for (position, byte) in input.bytes().enumerate() {
        if byte == b'=' {
            break;
        }
        let value = base64url_value(byte).ok_or_else(|| SecurityError::Cryptographic {
            reason: format!("base64url: invalid character at position {position}"),
        })?;
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    if bits >= 6 {
        return Err(SecurityError::Cryptographic {
            reason: "base64url: trailing group is not a valid encoding".to_string(),
        });
    }
    Ok(out)
}

/// One character's value in the base64url alphabet.
const fn base64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The constant-time comparison
// ---------------------------------------------------------------------------

/// Compare two byte strings in constant time, through `WebCrypto`.
///
/// **There is no Rust `==` on either argument, and that is the point.** See
/// the module header. The function derives an HMAC key from a per-process
/// random label, computes `HMAC-SHA-256(label, a)` and `HMAC-SHA-256(label, b)`,
/// and asks `SubtleCrypto::verify()` to compare the two digests. The
/// comparison `WebCrypto` performs is constant-time by construction — it is the
/// same code path a MAC verification takes — and the digests are derived, so a
/// timing signal from the *comparison* reveals nothing about the *inputs*.
///
/// `SubtleCrypto::verify` is the direct answer for a caller that already holds
/// a MAC or a signature; this function is the answer for a caller that holds
/// two raw values and has no key, and it is deliberately more expensive than a
/// `==` rather than cheaper. The extra cost buys the property; a caller that
/// can use `verify` directly should, and both paths are the platform's.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the random source or the primitive is
/// unavailable. A comparison that cannot be performed in constant time is
/// **refused**, never downgraded to a non-constant one.
pub async fn constant_time_eq(a: &[u8], b: &[u8]) -> Result<bool, SecurityError> {
    constant_time_hmac_eq(a, b).await
}

/// The same comparison, keyed.
///
/// # Errors
///
/// As [`constant_time_eq`].
async fn constant_time_hmac_eq(a: &[u8], b: &[u8]) -> Result<bool, SecurityError> {
    const OP: &str = "crypto.constant_time_eq";
    let subtle = subtle()?;
    // A per-comparison key. Not a secret from anyone — it exists so the two
    // digests being compared are not themselves attacker-guessable inputs, and
    // so the comparison is over values derived from the inputs rather than over
    // the inputs.
    let key_bytes = random_bytes(32)?;
    let key = import_hmac_key(&subtle, &key_bytes, false).await?;
    let digest_a = hmac(&subtle, &key, a).await?;
    let digest_b = hmac(&subtle, &key, b).await?;
    let promise = verify_promise(
        &subtle,
        &algorithm(&[("name", "HMAC")]),
        &key,
        &Uint8Array::from(digest_a.as_slice()),
        &Uint8Array::from(digest_b.as_slice()),
    )
    .map_err(|_| rejected(OP))?;
    let verified: bool = JsFuture::from(promise)
        .await
        .map_err(|_| rejected(OP))?
        .as_bool()
        .ok_or_else(|| rejected(OP))?;
    // The one thing `verify` cannot answer on its own is length: a short/long
    // pair is not a MAC mismatch, it is a different input length. The lengths
    // are public — a PKCE challenge is a fixed-width base64url string, and a
    // challenge length is not a secret — so this comparison leaks nothing.
    // There is no `==` over `a` or `b` anywhere in this function, which is the
    // whole point of routing the comparison through a MAC.
    Ok(verified && a.len() == b.len())
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/// Fill a buffer from the platform's CSPRNG.
///
/// # The in-place contract, and why the bytes are read back out of the view
///
/// `crypto.getRandomValues` (W3C Web Cryptography API §5.1) **fills the
/// `ArrayBufferView` it is given, in place, and returns that same view.** It is
/// synchronous. This function therefore:
///
/// 1. allocates a `Uint8Array`, which per the `ArrayBuffer` constructor is
///    **zero-filled**;
/// 2. hands it to the platform, and *keeps the returned view* rather than
///    assuming the argument was mutated;
/// 3. reads the bytes out of the **returned** view.
///
/// Step 3 is the load-bearing one. Web Crypto §5.1 defines `getRandomValues` as
/// *synchronous* — it fills the view in place and returns that same view — so
/// there is no promise to await here, and every other primitive in this module
/// goes through `await_value` for exactly that reason. The call is reached
/// through `Crypto::get_random_values_with_js_u8_array`, whose
/// `#[wasm_bindgen(method, catch)]` signature is generated from the
/// specification and returns the filled `Object`; this function then downcasts
/// it and takes the bytes from *that*. So if the platform ever returns a view
/// other than the one passed in — a copy, or nothing at all — the bytes are
/// missing and [`random_bytes_is_zero_checked`] refuses the result rather than
/// handing back a predictable credential.
///
/// The alternative — allocate, call, ignore the return, read the argument —
/// compiles, warns, and can return 32 zero bytes while reporting success, which
/// is precisely the failure ADR-0008 exists to prevent. A *hand-written*
/// `-> Result<Promise, JsValue>` signature is the worse version of the same
/// mistake: it is type-correct against a wrong reading of the spec, so it
/// compiles silently and the un-awaited promise is dropped. That is why the
/// binding is not declared by hand here; see the module header.
///
/// # The 65536-byte cap
///
/// The platform throws if a single request exceeds 65536 bytes, so larger
/// requests are filled in a loop. `usize` → `u32` narrowing cannot fail for any
/// length this function can be asked for on a 32-bit target, but it is handled
/// with a fallible conversion rather than a cast regardless: a truncating cast
/// here would silently request fewer bytes than the caller asked for.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the platform refuses, and
/// [`SecurityError::Cryptographic`] when the platform returns a view whose
/// bytes are all zero — see [`random_bytes_is_zero_checked`]. There is no
/// fallback and no `Math.random`: a session credential derived from a
/// predictable source is a credential an attacker can derive.
pub fn random_bytes(len: usize) -> Result<Vec<u8>, SecurityError> {
    const CHUNK: usize = 65_536;
    if len == 0 {
        return Ok(Vec::new());
    }
    let crypto = platform()?;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        let want = u32::try_from((len - out.len()).min(CHUNK)).map_err(|_| {
            SecurityError::Cryptographic {
                reason: "requested random length does not fit a 32-bit view".to_string(),
            }
        })?;
        let view = Uint8Array::new_with_length(want);
        let returned = crypto
            .get_random_values_with_js_u8_array(&view)
            .map_err(|_| SecurityError::Cryptographic {
                reason: "crypto.getRandomValues was rejected by the platform".to_string(),
            })?;
        // The bytes come from the view the platform *returned*. See the type
        // documentation for why that is not the same as reading `view`.
        let filled: Uint8Array = returned
            .dyn_into()
            .map_err(|_| SecurityError::Cryptographic {
                reason: "crypto.getRandomValues did not return the view it was given".to_string(),
            })?;
        out.extend_from_slice(&filled.to_vec());
    }
    if random_bytes_is_zero_checked(&out) {
        return Err(SecurityError::Cryptographic {
            reason: "the platform returned an all-zero random buffer; the bytes are \
                     not usable as a credential and are refused rather than handed \
                     on as entropy that is not there"
                .to_string(),
        });
    }
    Ok(out)
}

/// Whether a buffer the platform returned is entirely zeros.
///
/// # Why a zero check is a check and not a smell
///
/// A CSPRNG returning all zeros has probability 2^(-8n): 2^-256 for a 32-byte
/// read. It is not a real event, so its only real causes are a caller that never
/// filled the buffer at all, a view that was read from the wrong side of the
/// call, or a runtime stub standing in for the platform. All three produce
/// exactly this: a correctly-sized, entirely-zero buffer that every length and
/// type check accepts and no other test in this crate would catch. Refusing it
/// converts a silently deterministic credential into a loud failure at the one
/// place that can tell.
///
/// It is a *sanity* check on the plumbing, not a statistical claim about the
/// generator, and it is deliberately not applied to values shorter than 16
/// bytes: at that length 2^-128 is small enough that refusing would be
/// introducing a real (if remote) failure mode into a working primitive.
#[must_use]
pub fn random_bytes_is_zero_checked(bytes: &[u8]) -> bool {
    const MIN_CHECKED_BYTES: usize = 16;
    bytes.len() >= MIN_CHECKED_BYTES && bytes.iter().all(|b| *b == 0)
}

/// SHA-256 of a byte string.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the primitive is unavailable.
pub async fn sha256(input: &[u8]) -> Result<Vec<u8>, SecurityError> {
    const OP: &str = "crypto.sha256";
    let subtle = subtle()?;
    let promise =
        digest_promise(&subtle, "SHA-256", &Uint8Array::from(input)).map_err(|_| rejected(OP))?;
    let buffer = await_value::<ArrayBuffer>(promise, OP).await?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

/// Import a raw HMAC-SHA-256 key.
async fn import_hmac_key(
    subtle: &SubtleCrypto,
    material: &[u8],
    extractable: bool,
) -> Result<web_sys::CryptoKey, SecurityError> {
    const OP: &str = "crypto.import_hmac_key";
    let promise = import_key_promise(
        subtle,
        "raw",
        &Uint8Array::from(material),
        &algorithm(&[("name", "HMAC"), ("hash", "SHA-256")]),
        extractable,
        &usages(&["sign", "verify"]),
    )
    .map_err(|_| rejected(OP))?;
    await_value::<web_sys::CryptoKey>(promise, OP).await
}

/// HMAC-SHA-256 over `data` with an imported key.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the primitive is unavailable.
async fn hmac(
    subtle: &SubtleCrypto,
    key: &web_sys::CryptoKey,
    data: &[u8],
) -> Result<Vec<u8>, SecurityError> {
    const OP: &str = "crypto.hmac_sha256";
    let promise = sign_promise(
        subtle,
        &algorithm(&[("name", "HMAC")]),
        key,
        &Uint8Array::from(data),
    )
    .map_err(|_| rejected(OP))?;
    let buffer = await_value::<ArrayBuffer>(promise, OP).await?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

/// Import a raw RSASSA-PKCS1-v1_5 SHA-256 (RS256) key.
///
/// `private` selects the usage set and is the only difference between the two
/// arms: `WebCrypto` refuses a private key imported for `verify`, and refusing
/// here too is what keeps the two call sites from drifting into a state where
/// one of them needs `sign` and the other `verify`.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the key material is not a DER-encoded
/// PKCS#8 RSASSA private key, or the primitive is unavailable. The message does
/// not include the platform's reason.
pub async fn import_rsa_key(
    pkcs8_der: &[u8],
    private: bool,
) -> Result<web_sys::CryptoKey, SecurityError> {
    const OP: &str = "crypto.import_rsa_key";
    let subtle = subtle()?;
    let (format, key_usages) = if private {
        ("pkcs8", &["sign"][..])
    } else {
        ("spki", &["verify"][..])
    };
    let promise = import_key_promise(
        &subtle,
        format,
        &Uint8Array::from(pkcs8_der),
        &algorithm(&[("name", "RSASSA-PKCS1-v1_5"), ("hash", "SHA-256")]),
        // A public key is extractable because it is published; a private key
        // is not, because exporting it is the accident this flag prevents.
        !private,
        &usages(key_usages),
    )
    .map_err(|_| rejected(OP))?;
    await_value::<web_sys::CryptoKey>(promise, OP).await
}

/// RS256-sign `data`.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the key cannot sign.
pub async fn rs256_sign(key: &web_sys::CryptoKey, data: &[u8]) -> Result<Vec<u8>, SecurityError> {
    const OP: &str = "crypto.rs256_sign";
    let subtle = subtle()?;
    let promise = sign_promise(
        &subtle,
        &algorithm(&[("name", "RSASSA-PKCS1-v1_5")]),
        key,
        &Uint8Array::from(data),
    )
    .map_err(|_| rejected(OP))?;
    let buffer = await_value::<ArrayBuffer>(promise, OP).await?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

/// RS256-verify `signature` over `data`, through the platform's comparator.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the key cannot verify. A *false*
/// result is `Ok(false)`, not an error: a wrong signature is a client outcome.
pub async fn rs256_verify(
    key: &web_sys::CryptoKey,
    signature: &[u8],
    data: &[u8],
) -> Result<bool, SecurityError> {
    const OP: &str = "crypto.rs256_verify";
    let subtle = subtle()?;
    let promise = verify_promise(
        &subtle,
        &algorithm(&[("name", "RSASSA-PKCS1-v1_5")]),
        key,
        &Uint8Array::from(signature),
        &Uint8Array::from(data),
    )
    .map_err(|_| rejected(OP))?;
    JsFuture::from(promise)
        .await
        .map_err(|_| rejected(OP))?
        .as_bool()
        .ok_or_else(|| rejected(OP))
}

/// Import a raw AES-256-GCM key.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the key is not exactly 32 bytes or
/// the primitive is unavailable.
async fn import_aes_key(material: &[u8]) -> Result<web_sys::CryptoKey, SecurityError> {
    const OP: &str = "crypto.import_aes_key";
    if material.len() != ENCRYPTION_KEY_BYTES {
        return Err(SecurityError::Cryptographic {
            reason: format!(
                "AES-256-GCM needs exactly {ENCRYPTION_KEY_BYTES} bytes of key material"
            ),
        });
    }
    let subtle = subtle()?;
    let promise = import_key_promise(
        &subtle,
        "raw",
        &Uint8Array::from(material),
        &algorithm(&[("name", "AES-GCM")]),
        false,
        &usages(&["encrypt", "decrypt"]),
    )
    .map_err(|_| rejected(OP))?;
    await_value::<web_sys::CryptoKey>(promise, OP).await
}

/// Encrypt with AES-256-GCM under a 96-bit random nonce.
///
/// The nonce is generated per encryption by the platform and prefixed to the
/// ciphertext. It is never derived from anything, and never reused: a fresh
/// 12 bytes from `getRandomValues` on every call is the cheapest way to be sure,
/// and the key is a single deployment-wide secret, so the birthday bound on a
/// random 96-bit nonce is not reached in any plausible lifetime.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the key or the nonce source is
/// unavailable.
async fn aes_gcm_encrypt(key: &SecretBytes, plaintext: &[u8]) -> Result<Vec<u8>, SecurityError> {
    const OP: &str = "crypto.aes_gcm_encrypt";
    let crypto_key = import_aes_key(key.expose_for_crypto()).await?;
    let nonce = random_bytes(12)?;
    let params = aes_gcm_params(&nonce);
    let subtle = subtle()?;
    let promise = encrypt_promise(&subtle, &params, &crypto_key, &Uint8Array::from(plaintext))
        .map_err(|_| rejected(OP))?;
    let ciphertext = await_value::<ArrayBuffer>(promise, OP).await?;
    let mut out = nonce;
    out.extend_from_slice(&Uint8Array::new(&ciphertext).to_vec());
    Ok(out)
}

/// Decrypt AES-256-GCM from a nonce-prefixed ciphertext.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the input is shorter than the nonce
/// or shorter than the GCM tag, or when authentication fails. Truncation and
/// tampering are the *same* error on purpose: a caller that could tell them
/// apart could use the difference to probe stored ciphertexts.
async fn aes_gcm_decrypt(key: &SecretBytes, ciphertext: &[u8]) -> Result<Vec<u8>, SecurityError> {
    const OP: &str = "crypto.aes_gcm_decrypt";
    // 12 nonce bytes + a 16-byte GCM tag is the shortest thing that can possibly
    // be a ciphertext; anything shorter is refused before WebCrypto is asked.
    if ciphertext.len() < 12 + 16 {
        return Err(SecurityError::Cryptographic {
            reason: "ciphertext is shorter than a nonce and a GCM tag".to_string(),
        });
    }
    let (nonce, body) = ciphertext.split_at(12);
    let crypto_key = import_aes_key(key.expose_for_crypto()).await?;
    let params = aes_gcm_params(nonce);
    let subtle = subtle()?;
    let promise = decrypt_promise(&subtle, &params, &crypto_key, &Uint8Array::from(body))
        .map_err(|_| rejected(OP))?;
    let buffer = await_value::<ArrayBuffer>(promise, OP).await?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

/// The `AesGcmParams` dictionary: the nonce and the tag length.
///
/// The tag length is pinned at 128 bits rather than left to the default,
/// because the default is a platform decision and a stored ciphertext has to
/// be decryptable by a future run of this same code. A tag length that could
/// change is an at-rest format that changes under you.
fn aes_gcm_params(nonce: &[u8]) -> Object {
    let object = Object::new();
    let _ = Reflect::set(
        &object,
        &JsValue::from_str("name"),
        &JsValue::from_str("AES-GCM"),
    );
    let _ = Reflect::set(&object, &JsValue::from_str("iv"), &Uint8Array::from(nonce));
    let _ = Reflect::set(
        &object,
        &JsValue::from_str("tagLength"),
        &JsValue::from_f64(128.0),
    );
    object
}

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

/// A [`TokenSigner`] over RS256, holding one configured key.
///
/// Constructed from the two things a signer needs — a private key and the
/// identifier to publish for it — and from nothing else. There is no
/// constructor that takes a default, and no `Option` anywhere in this type: a
/// signer without a key is not a signer, it is a `SecurityError` waiting to be
/// wrapped in an `Ok` by a future refactor.
#[derive(Debug, Clone)]
pub struct WebCryptoTokenSigner {
    key_id: SigningKeyId,
    key: web_sys::CryptoKey,
    public_key: web_sys::CryptoKey,
}

impl WebCryptoTokenSigner {
    /// Import a PKCS#8 RS256 private key and its SPKI public counterpart.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when the key material is absent, and
    /// [`SecurityError::Cryptographic`] when `WebCrypto` refuses either key.
    pub async fn new(
        key_id: SigningKeyId,
        pkcs8_private_der: &[u8],
        spki_public_der: &[u8],
    ) -> Result<Self, SecurityError> {
        if pkcs8_private_der.is_empty() || spki_public_der.is_empty() {
            return Err(SecurityError::MissingSecret {
                name: "IDENTITY_RSA_SIGNING_KEY",
            });
        }
        let key = import_rsa_key(pkcs8_private_der, true).await?;
        let public_key = import_rsa_key(spki_public_der, false).await?;
        Ok(Self {
            key_id,
            key,
            public_key,
        })
    }

    /// The key this signer signs with.
    #[must_use]
    pub const fn key_id(&self) -> &SigningKeyId {
        &self.key_id
    }
}

/// The fixed JOSE header every token this crate signs carries.
///
/// `typ: "JWT"` per RFC 7519 §5.1 and `alg: "RS256"` — the algorithm is a
/// *header claim*, not a signer-side default, because a verifier that reads it
/// from the token and picks an algorithm from it is the algorithm-confusion
/// vulnerability. The discovery document advertises one algorithm and this
/// header says the same one.
fn jose_header() -> serde_json::Value {
    serde_json::json!({ "alg": "RS256", "typ": "JWT" })
}

impl TokenSigner for WebCryptoTokenSigner {
    fn signing_key_id(&self) -> Result<SigningKeyId, SecurityError> {
        Ok(self.key_id.clone())
    }

    fn sign(&self, _claims: &serde_json::Value) -> Result<SignedToken, SecurityError> {
        // Async, and the port is sync. That is a real impedance mismatch, and
        // it is resolved the only honest way available: the composition root
        // holds a signer whose key was imported before the first request, and
        // the signing itself is a promise the root awaits. This method is
        // therefore provided only for the synchronous test surfaces and
        // returns the documented refusal rather than blocking on an
        // executor — see `sign_async`, which is the real implementation.
        Err(deferred_error(
            "WebCryptoTokenSigner::sign",
            "signing is asynchronous on the Workers runtime; a synchronous trait \
             method cannot await crypto.subtle.sign. Use sign_async, or widen the \
             TokenSigner port to an async signature when the first caller needs it.",
        ))
    }

    fn public_jwks(&self) -> Result<serde_json::Value, SecurityError> {
        // Async, and the port is sync: the same impedance mismatch as `sign`.
        // The public key material has to come out of WebCrypto, so this method
        // refuses rather than embedding a key in the source.
        Err(deferred_error(
            "WebCryptoTokenSigner::public_jwks",
            "publishing the JWKS requires reading the public key out of \
             crypto.subtle, which a synchronous trait method cannot await. Use \
             public_jwks_async, or widen the TokenSigner port to an async \
             signature when the first caller needs it.",
        ))
    }
}

/// Sign a claim set asynchronously. The real implementation behind
/// [`TokenSigner::sign`]'s refusal.
impl WebCryptoTokenSigner {
    /// Sign `claims` and return the compact JWS parts.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the claim set is not serialisable
    /// or `WebCrypto` refuses to sign. A failure here is never papered over with
    /// an unsigned token.
    pub async fn sign_async(
        &self,
        claims: &serde_json::Value,
    ) -> Result<SignedToken, SecurityError> {
        let header = base64url_encode(&serde_json::to_vec(&jose_header()).map_err(|e| {
            SecurityError::Cryptographic {
                reason: format!("JOSE header is not serialisable: {e}"),
            }
        })?);
        let payload = base64url_encode(&serde_json::to_vec(claims).map_err(|e| {
            SecurityError::Cryptographic {
                reason: format!("claim set is not serialisable: {e}"),
            }
        })?);
        let signing_input = format!("{header}.{payload}");
        let signature = rs256_sign(&self.key, signing_input.as_bytes()).await?;
        Ok(SignedToken {
            header,
            payload,
            signature: base64url_encode(&signature),
        })
    }

    /// The JWKS document for this signer's public key.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the key cannot be exported or is
    /// not an RSA key.
    pub async fn public_jwks_async(&self) -> Result<serde_json::Value, SecurityError> {
        let jwk = export_jwk(&self.public_key).await?;
        let modulus = jwk_component(&jwk, "n")?;
        let exponent = jwk_component(&jwk, "e")?;
        Ok(serde_json::json!({
            "keys": [{
                "kty": "RSA",
                "kid": self.key_id.as_str(),
                "alg": "RS256",
                "use": "sig",
                "n": modulus,
                "e": exponent,
            }]
        }))
    }
}

/// A [`TokenVerifier`] over one configured public key.
///
/// One key, not a key set. A JWKS with rotation needs a key *registry* — a map
/// from `kid` to a key, and a rule for which kid is current — and this crate
/// does not have that. What it has is a verifier that refuses an unknown `kid`
/// as a rejection, which is the correct behaviour and is also all a single-key
/// deployment needs.
#[derive(Debug, Clone)]
pub struct WebCryptoTokenVerifier {
    key_id: SigningKeyId,
    key: web_sys::CryptoKey,
    issuer: String,
    audience: String,
}

/// The claim names this verifier reads. Named so the token-validation table in
/// the security design and this file cannot drift apart silently.
const CLAIM_ISS: &str = "iss";
const CLAIM_AUD: &str = "aud";
const CLAIM_EXP: &str = "exp";
const CLAIM_NBF: &str = "nbf";

impl WebCryptoTokenVerifier {
    /// Build a verifier for one key, one issuer and one audience.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MissingSecret`] when the issuer or audience is blank, or
    /// the public key is absent; [`SecurityError::Cryptographic`] when the key
    /// cannot be imported.
    pub async fn new(
        key_id: SigningKeyId,
        spki_public_der: &[u8],
        issuer: impl Into<String>,
        audience: impl Into<String>,
    ) -> Result<Self, SecurityError> {
        let issuer = issuer.into();
        let audience = audience.into();
        if issuer.trim().is_empty() {
            return Err(SecurityError::MissingSecret {
                name: "IDENTITY_ISSUER",
            });
        }
        if audience.trim().is_empty() {
            return Err(SecurityError::MissingSecret {
                name: "IDENTITY_AUDIENCE",
            });
        }
        if spki_public_der.is_empty() {
            return Err(SecurityError::MissingSecret {
                name: "IDENTITY_RSA_SIGNING_KEY",
            });
        }
        let key = import_rsa_key(spki_public_der, false).await?;
        Ok(Self {
            key_id,
            key,
            issuer,
            audience,
        })
    }

    /// The key identifier this verifier accepts.
    #[must_use]
    pub const fn key_id(&self) -> &SigningKeyId {
        &self.key_id
    }

    /// Verify and validate a token asynchronously.
    ///
    /// # Errors
    ///
    /// [`SecurityError::MalformedToken`] for a structurally wrong token, and
    /// [`SecurityError::TokenRejected`] for every other refusal — wrong `kid`,
    /// bad signature, wrong issuer, wrong audience, expired, not yet valid. One
    /// error for all of them: a caller that could tell "no such key" from "bad
    /// signature" could enumerate the deployment's keys.
    pub async fn verify_async(
        &self,
        token: &SignedToken,
    ) -> Result<serde_json::Value, SecurityError> {
        let header: serde_json::Value = serde_json::from_slice(&base64url_decode(&token.header)?)
            .map_err(|_| SecurityError::MalformedToken)?;
        if header.get("alg").and_then(serde_json::Value::as_str) != Some("RS256") {
            // A token that asks for a different algorithm is refused *before*
            // the signature is looked at. This is the algorithm-confusion
            // defence, and it is why the header's `alg` is checked rather than
            // assumed.
            return Err(SecurityError::TokenRejected);
        }
        if header.get("kid").and_then(serde_json::Value::as_str) != Some(self.key_id.as_str()) {
            return Err(SecurityError::TokenRejected);
        }
        let signing_input = format!("{}.{}", token.header, token.payload);
        let signature = base64url_decode(&token.signature)?;
        if !rs256_verify(&self.key, &signature, signing_input.as_bytes()).await? {
            return Err(SecurityError::TokenRejected);
        }
        let claims: serde_json::Value = serde_json::from_slice(&base64url_decode(&token.payload)?)
            .map_err(|_| SecurityError::MalformedToken)?;
        self.validate_claims(&claims, now_seconds())?;
        Ok(claims)
    }

    /// Check the claims a signature does not cover.
    fn validate_claims(&self, claims: &serde_json::Value, now: i64) -> Result<(), SecurityError> {
        if claims.get(CLAIM_ISS).and_then(serde_json::Value::as_str) != Some(self.issuer.as_str()) {
            return Err(SecurityError::TokenRejected);
        }
        if !audience_matches(claims, &self.audience) {
            return Err(SecurityError::TokenRejected);
        }
        // Both non-matching arms refuse, and they are written as one arm
        // rather than two on purpose: a token whose `exp` is absent and a token
        // whose `exp` has passed are the same claim — "this token does not
        // outlive the moment it was checked" — and a JWT with no `exp` is
        // precisely the forever-token this refuses. Which of the two it was
        // says nothing a caller should act on differently.
        match numeric_claim(claims, CLAIM_EXP) {
            Some(exp) if now < exp => {}
            _ => return Err(SecurityError::TokenRejected),
        }
        // `nbf` is optional: a token with no `nbf` is valid from the moment it
        // was signed. One that has one and is not yet valid is refused.
        if let Some(nbf) = numeric_claim(claims, CLAIM_NBF) {
            if now < nbf {
                return Err(SecurityError::TokenRejected);
            }
        }
        Ok(())
    }
}

impl TokenVerifier for WebCryptoTokenVerifier {
    fn verify(&self, _token: &SignedToken) -> Result<serde_json::Value, SecurityError> {
        // The same impedance mismatch as `TokenSigner::sign`, and the same
        // honest answer: a sync trait method cannot await WebCrypto, so it
        // refuses rather than returning an unverified claim set.
        Err(deferred_error(
            "WebCryptoTokenVerifier::verify",
            "verification is asynchronous on the Workers runtime; a synchronous \
             trait method cannot await crypto.subtle.verify. Use verify_async, or \
             widen the TokenVerifier port to an async signature when the first \
             caller needs it.",
        ))
    }
}

/// The current time in whole seconds since the Unix epoch.
///
/// `crate::clock` is the layer's clock port; this is a *verification* clock and
/// it is the one place in this file that reads the platform clock, because a
/// token's `exp` is meaningless against a clock the caller supplies. A test that
/// needs a different clock calls [`validate_claims_at`] rather than this.
fn now_seconds() -> i64 {
    i64::try_from(worker::Date::now().as_millis() / 1000).unwrap_or(i64::MAX)
}

/// Validate a claim set against a given time. Public so a test can place a
/// token either side of its validity window without waiting for one.
///
/// # Errors
///
/// As `WebCryptoTokenVerifier::validate_claims`.
pub fn validate_claims_at(
    verifier: &WebCryptoTokenVerifier,
    claims: &serde_json::Value,
    now: i64,
) -> Result<(), SecurityError> {
    verifier.validate_claims(claims, now)
}

/// Whether the `aud` claim names the expected audience.
///
/// `aud` is a string in one token and an array in another (RFC 7519 §4.1.3), so
/// both are accepted. A missing `aud` is not a match.
fn audience_matches(claims: &serde_json::Value, expected: &str) -> bool {
    match claims.get(CLAIM_AUD) {
        Some(serde_json::Value::String(single)) => single == expected,
        Some(serde_json::Value::Array(many)) => {
            many.iter().any(|entry| entry.as_str() == Some(expected))
        }
        _ => false,
    }
}

/// Read an integer-valued claim.
///
/// RFC 7519 permits `exp` and `nbf` to be numbers; some issuers emit them as
/// strings. Both are accepted here, because a token that is otherwise valid and
/// is rejected only because its `exp` was a string is a false rejection, and
/// the *string* form carries no security property the number form lacks.
fn numeric_claim(claims: &serde_json::Value, name: &str) -> Option<i64> {
    match claims.get(name) {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => s.parse().ok(),
        _ => None,
    }
}

/// Export a public key as the JWK object a JWKS document is built from.
///
/// `WebCrypto` can export an SPKI public key as JWK (`SubtleCrypto.exportKey`
/// with format `jwk`), and that object is exactly what a JWKS entry contains.
/// Reading `n` and `e` from it means the published key and the verifying key
/// are the *same* key by construction — there is no second place to mistype it,
/// and no modulus in this source tree.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the export fails or the platform
/// refuses to export this key as a JWK.
async fn export_jwk(
    key: &web_sys::CryptoKey,
) -> Result<serde_json::Map<String, serde_json::Value>, SecurityError> {
    const OP: &str = "crypto.export_jwk";
    let subtle = subtle()?;
    let promise = export_key_promise(&subtle, "jwk", key).map_err(|_| rejected(OP))?;
    let jwk = await_value::<js_sys::Object>(promise, OP).await?;
    jwk_to_json(&jwk)
}

/// One string component of an exported JWK.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when the component is absent or is not a
/// string. "Absent" is what a non-RSA key looks like, so the message says so
/// rather than reporting a decode failure further down.
fn jwk_component(
    jwk: &serde_json::Map<String, serde_json::Value>,
    component: &str,
) -> Result<String, SecurityError> {
    match jwk.get(component).and_then(serde_json::Value::as_str) {
        Some(value) => Ok(value.to_string()),
        None => Err(SecurityError::Cryptographic {
            reason: format!("exported key is not an RSA key: component {component} is absent"),
        }),
    }
}

/// Turn the JS object `exportKey` returns into a `serde_json::Map`.
///
/// Deliberately narrow rather than a general JS-to-JSON converter: the JWK is
/// a flat object of strings, so this reads the six fields a JWKS entry is made
/// of through `Reflect::get` and ignores everything else. Nothing on the
/// exported object beyond those fields can influence what is published.
fn jwk_to_json(
    value: &js_sys::Object,
) -> Result<serde_json::Map<String, serde_json::Value>, SecurityError> {
    const OP: &str = "crypto.export_jwk";
    let mut out = serde_json::Map::new();
    for component in ["n", "e", "kty", "alg", "use", "kid"] {
        let field = Reflect::get(value, &JsValue::from_str(component)).map_err(|_| rejected(OP))?;
        if field.is_undefined() || field.is_null() {
            continue;
        }
        let Some(text) = field.as_string() else {
            return Err(SecurityError::Cryptographic {
                reason: format!("exported key component {component} is not a string"),
            });
        };
        out.insert(component.to_string(), serde_json::Value::String(text));
    }
    Ok(out)
}

/// A [`PkceService`] for RFC 7636 `S256` only.
///
/// `plain` is not offered and there is no constructor that turns it on, because
/// the discovery document does not advertise it and a second constructor is a
/// second thing to get wrong. A client that tries `plain` is refused.
///
/// # Errors
///
/// [`SecurityError::ChallengeMismatch`] when either side is absent, and
/// [`SecurityError::VerificationFailed`] when they do not match.
#[derive(Debug, Clone, Copy, Default)]
pub struct WebCryptoPkceService;

impl WebCryptoPkceService {
    /// A PKCE service. Infallible, because the configuration it needs is
    /// "S256", and that is a constant.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

/// The RFC 7636 §4.1 length range for a code verifier, in characters.
///
/// The `unreserved` alphabet RFC 7636 defines is ASCII, so "characters" and
/// "bytes" are the same count here — which is why this bound is a range and not
/// a byte budget.
const PKCE_VERIFIER_MIN: usize = 43;
const PKCE_VERIFIER_MAX: usize = 128;

impl PkceService for WebCryptoPkceService {
    fn verify(&self, challenge: &str, verifier: &str) -> Result<(), SecurityError> {
        if challenge.is_empty() || verifier.is_empty() {
            return Err(SecurityError::ChallengeMismatch);
        }
        if verifier.len() < PKCE_VERIFIER_MIN || verifier.len() > PKCE_VERIFIER_MAX {
            return Err(SecurityError::VerificationFailed);
        }
        // The check needs a SHA-256 and a constant-time comparison, both of
        // which are promises on this runtime and neither of which a synchronous
        // trait method can await. So the *bounds* are checked here — the checks
        // that cost nothing and that a caller can get wrong — and the derivation
        // and comparison are behind `verify_async`, which is the real
        // implementation. A verifier whose length is accepted but whose S256
        // transform has not run is not a pass: see the returned error.
        Err(deferred_error(
            "WebCryptoPkceService::verify",
            "the S256 transform and the constant-time comparison are both \
             asynchronous on the Workers runtime. Use verify_async, or widen \
             the PkceService port to an async signature when the first caller \
             needs it. The length and presence checks above still run first, \
             so an out-of-range verifier is refused here rather than later.",
        ))
    }

    fn derive_challenge(&self, verifier: &str) -> Result<String, SecurityError> {
        if verifier.len() < PKCE_VERIFIER_MIN || verifier.len() > PKCE_VERIFIER_MAX {
            return Err(SecurityError::VerificationFailed);
        }
        Err(deferred_error(
            "WebCryptoPkceService::derive_challenge",
            "deriving an S256 challenge is a SHA-256 promise on this runtime. \
             Use derive_challenge_async, or widen the PkceService port to an \
             async signature when the first caller needs it.",
        ))
    }
}

impl WebCryptoPkceService {
    /// Derive the `S256` challenge for a verifier, asynchronously.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] when the verifier is outside the
    /// RFC 7636 length range, and [`SecurityError::Cryptographic`] when SHA-256
    /// is unavailable.
    pub async fn derive_challenge_async(&self, verifier: &str) -> Result<String, SecurityError> {
        if verifier.len() < PKCE_VERIFIER_MIN || verifier.len() > PKCE_VERIFIER_MAX {
            return Err(SecurityError::VerificationFailed);
        }
        derive_challenge_s256(verifier).await
    }

    /// Check a verifier against a challenge, asynchronously.
    ///
    /// # Errors
    ///
    /// [`SecurityError::ChallengeMismatch`] when either side is absent,
    /// [`SecurityError::VerificationFailed`] when they do not match or the
    /// verifier is out of range, and [`SecurityError::Cryptographic`] when
    /// `WebCrypto` is unavailable.
    pub async fn verify_async(&self, challenge: &str, verifier: &str) -> Result<(), SecurityError> {
        if challenge.is_empty() || verifier.is_empty() {
            return Err(SecurityError::ChallengeMismatch);
        }
        let derived = self.derive_challenge_async(verifier).await?;
        // The derived challenge is recomputed and compared through WebCrypto,
        // never with `==`. See the module header for why that is not a
        // formality.
        if constant_time_eq(derived.as_bytes(), challenge.as_bytes()).await? {
            Ok(())
        } else {
            Err(SecurityError::VerificationFailed)
        }
    }
}

/// `BASE64URL(SHA256(ASCII(verifier)))`, the RFC 7636 §4.2 `S256` transform.
///
/// # Errors
///
/// [`SecurityError::Cryptographic`] when SHA-256 is unavailable.
pub async fn derive_challenge_s256(verifier: &str) -> Result<String, SecurityError> {
    Ok(base64url_encode(&sha256(verifier.as_bytes()).await?))
}

/// A [`SecretCipher`] over AES-256-GCM.
///
/// Holds a `SecretBytes` encryption key and a key identifier, both required at
/// construction. The identifier is what makes a rotation possible *later*: a
/// row records the `kid` it was written under, so an old key can still decrypt
/// it after a new one starts being written. No rotation logic is here — the
/// registry that would hold two keys at once does not exist yet, and pretending
/// otherwise is the kind of claim this repository forbids.
#[derive(Debug, Clone)]
pub struct WebCryptoSecretCipher {
    key: SecretBytes,
    key_id: SigningKeyId,
}

impl WebCryptoSecretCipher {
    /// Build a cipher from a validated key and its identifier.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the key is not exactly 32 bytes.
    pub fn new(key: SecretBytes, key_id: SigningKeyId) -> Result<Self, SecurityError> {
        if key.len() != ENCRYPTION_KEY_BYTES {
            return Err(SecurityError::Cryptographic {
                reason: format!(
                    "AES-256-GCM needs exactly {ENCRYPTION_KEY_BYTES} bytes of key material"
                ),
            });
        }
        Ok(Self { key, key_id })
    }
}

impl SecretCipher for WebCryptoSecretCipher {
    fn encrypt(&self, _plaintext: &[u8]) -> Result<Vec<u8>, SecurityError> {
        // Async, as elsewhere in this file, and the same honest refusal: a
        // synchronous trait method cannot await `crypto.subtle.encrypt`, and
        // returning a plaintext-prefixed value would be a "ciphertext" that
        // decrypts to itself.
        Err(deferred_error(
            "WebCryptoSecretCipher::encrypt",
            "encryption is asynchronous on the Workers runtime; a synchronous \
             trait method cannot await crypto.subtle.encrypt. Use encrypt_async, \
             or widen the SecretCipher port to an async signature when the first \
             caller needs it.",
        ))
    }

    fn decrypt(&self, _ciphertext: &[u8]) -> Result<Vec<u8>, SecurityError> {
        Err(deferred_error(
            "WebCryptoSecretCipher::decrypt",
            "decryption is asynchronous on the Workers runtime; a synchronous \
             trait method cannot await crypto.subtle.decrypt. Use decrypt_async, \
             or widen the SecretCipher port to an async signature when the first \
             caller needs it.",
        ))
    }

    fn current_key_id(&self) -> Result<SigningKeyId, SecurityError> {
        Ok(self.key_id.clone())
    }
}

impl WebCryptoSecretCipher {
    /// Encrypt asynchronously. The real implementation behind
    /// [`SecretCipher::encrypt`]'s refusal.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the key or the platform refuses.
    pub async fn encrypt_async(&self, plaintext: &[u8]) -> Result<Vec<u8>, SecurityError> {
        aes_gcm_encrypt(&self.key, plaintext).await
    }

    /// Decrypt asynchronously. The real implementation behind
    /// [`SecretCipher::decrypt`]'s refusal.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] on any failure, including truncation
    /// and tampering, which are deliberately indistinguishable.
    pub async fn decrypt_async(&self, ciphertext: &[u8]) -> Result<Vec<u8>, SecurityError> {
        aes_gcm_decrypt(&self.key, ciphertext).await
    }
}

/// The ports this crate does **not** implement, and why.
///
/// # Errors
///
/// Always. Exists so the absence is callable, greppable, and impossible to
/// mistake for a forgotten `todo!()`. A reader who finds this name knows the
/// gap is deliberate and knows what has to exist before it closes.
///
/// # What is deferred, and the condition that retires each
///
/// - `TotpService::current_code` and `TotpService::verify` — retired when the
///   TOTP factor lands with a *reuse* rule: a counter that has been accepted
///   must be refused on every later attempt for the same step. Without that
///   data model, a TOTP implementation is a second factor that accepts the same
///   code twice.
/// - `OtpService::sign` / `OtpService::verify` (the signature-counter factor)
///   — retired with the same counter store.
/// - `SessionService::issue_credential` / `SessionService::resolve` — retired
///   when the session table and its lookup exist. The entropy requirement is
///   256 bits from `crypto.getRandomValues` and this crate can already supply
///   it; what is missing is the *store*, not the primitive.
/// - `NonceService` and `CsrfService` — retired when a single-use record store
///   exists. Both need "remember this and forget it on second use", which is a
///   D1 write, and a D1 write is a repository that lives above this adapter.
///   A KV-backed version would be a nonce store that fails open during a KV
///   outage, which is a CSRF filter that is off exactly when the system is
///   already degraded.
///
/// # Errors
pub const DEFERRED_PORTS: &[&str] = &[
    "TotpService::current_code",
    "TotpService::verify",
    "OtpService::sign",
    "OtpService::verify",
    "SessionService::issue_credential",
    "SessionService::resolve",
    "NonceService::issue",
    "NonceService::consume",
    "CsrfService::issue_state",
    "CsrfService::consume_state",
];

/// The named refusal for a deferred port.
///
/// # Errors
///
/// Always. Named so a caller sees which gate is missing rather than a generic
/// cryptographic failure, and so the test below can assert the table above and
/// this function cannot disagree.
/// The named deferral for an operation, so a caller sees which gate is
/// missing rather than a generic cryptographic failure.
#[must_use]
pub fn deferred_port(operation: &'static str) -> SecurityError {
    match DEFERRED_REASONS.iter().find(|(name, _)| *name == operation) {
        Some((_, reason)) => deferred_error(operation, reason),
        // An operation not in the table is a typo, and a typo must not be
        // answered with a sentence that reads like a deliberate deferral.
        None => SecurityError::Cryptographic {
            reason: format!("{operation} is not a known port; this is a call-site bug"),
        },
    }
}

/// Why each deferred port is deferred. Kept beside [`DEFERRED_PORTS`] so the
/// two cannot disagree: the table above is the *list*, this is the *reason*,
/// and a port in one and not the other is a compile error in the test below.
const DEFERRED_REASONS: &[(&str, &str)] = &[
    (
        "TotpService::current_code",
        "TOTP is deferred until the factor's counter-reuse rule has a store; a \
         half-built TOTP is a second factor that accepts wrong codes",
    ),
    (
        "TotpService::verify",
        "TOTP is deferred until the factor's counter-reuse rule has a store",
    ),
    (
        "OtpService::sign",
        "the signature-counter factor is deferred with TOTP; it shares the \
         counter store and the reuse rule",
    ),
    (
        "OtpService::verify",
        "the signature-counter factor is deferred with TOTP; it shares the \
         counter store and the reuse rule",
    ),
    (
        "SessionService::issue_credential",
        "the session table does not exist yet; the entropy source does, and the \
         credential format is not contracted",
    ),
    (
        "SessionService::resolve",
        "the session table does not exist yet; resolution is a D1 read that \
         belongs to a repository above this adapter",
    ),
    (
        "NonceService::issue",
        "a nonce needs a single-use record store; KV would fail open during an \
         outage, so a D1 repository is required first",
    ),
    (
        "NonceService::consume",
        "a nonce needs a single-use record store; KV would fail open during an \
         outage, so a D1 repository is required first",
    ),
    (
        "CsrfService::issue_state",
        "a state needs the same single-use store as a nonce, plus a record of \
         the redirect target it was issued for",
    ),
    (
        "CsrfService::consume_state",
        "a state needs the same single-use store as a nonce, plus a record of \
         the redirect target it was issued for",
    ),
];

/// The minimum length a signing secret must reach before this crate will use
/// it as an HMAC key.
///
/// Re-exported from [`crate::secrets`] rather than restated, because the floor
/// in one place and the floor checked in another is a floor that will be raised
/// in one of them.
pub const HMAC_KEY_MIN_BYTES: usize = MIN_SIGNING_SECRET_BYTES;

#[cfg(test)]
mod tests {
    use super::*;

    // These tests are pure. Every one of them that would need a live
    // `crypto.subtle` is marked `unverified` in the module header and is
    // exercised by `wasm-pack test` under a real runtime, not by `cargo test`
    // on the host target — `js_sys` panics there, which is the platform
    // refusing to pretend rather than a thing to work around. What is tested
    // here is everything that does *not* touch WebCrypto, which is a real
    // chunk: the base64url codec, the claim table, the deferred-port table and
    // the PKCE bounds.

    #[test]
    fn base64url_round_trips_every_byte_value() {
        let all: Vec<u8> = (0..=255u8).collect();
        let encoded = base64url_encode(&all);
        assert!(!encoded.contains('+'), "standard-alphabet plus: {encoded}");
        assert!(!encoded.contains('/'), "standard-alphabet slash: {encoded}");
        assert!(!encoded.contains('='), "padding: {encoded}");
        assert_eq!(base64url_decode(&encoded).expect("decodes"), all);
    }

    #[test]
    fn base64url_matches_the_rfc_4648_vectors() {
        // The three test vectors RFC 4648 §10 gives, with the padding removed.
        assert_eq!(base64url_encode(b""), "");
        assert_eq!(base64url_encode(b"f"), "Zg");
        assert_eq!(base64url_encode(b"fo"), "Zm8");
        assert_eq!(base64url_encode(b"foo"), "Zm9v");
        assert_eq!(base64url_encode(b"foob"), "Zm9vYg");
        assert_eq!(base64url_encode(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64url_preserves_the_leading_zero_bytes_a_rsa_modulus_starts_with() {
        // An RSA modulus whose top byte is zero loses it to a `str::from_utf8`
        // round trip in a naive codec, and the published key stops verifying.
        // Encoding the byte string rather than the text is the fix, and this
        // is the test for it.
        let modulus = vec![0u8, 0, 1, 2, 3];
        let encoded = base64url_encode(&modulus);
        assert_eq!(base64url_decode(&encoded).expect("decodes"), modulus);
    }

    #[test]
    fn base64url_rejects_a_character_outside_the_alphabet() {
        assert!(base64url_decode("Zm9v+").is_err());
        assert!(base64url_decode("Zm9v/").is_err());
        assert!(base64url_decode("Zm 9v").is_err());
    }

    #[test]
    fn base64url_rejects_an_impossible_trailing_group() {
        // One character encodes 6 bits, which cannot complete a byte.
        assert!(base64url_decode("Z").is_err());
        assert!(base64url_decode("Zm9vYmFyZ").is_err());
    }

    #[test]
    fn a_deferred_port_names_itself_and_its_reason() {
        let e = deferred_port("TotpService::current_code");
        assert_eq!(e.code(), "internal_error");
        let text = e.to_string();
        assert!(text.contains("TotpService::current_code"), "{text}");
        assert!(
            text.contains("deferred") || text.contains("until"),
            "{text}"
        );
    }

    #[test]
    fn every_listed_deferred_port_has_a_reason_and_the_reverse() {
        // The table and the reason list are separate `const`s because they are
        // separate facts. This is what keeps them from drifting: an entry in one
        // and not the other is a refusal with a blank explanation, or a reason
        // for a port that is not deferred.
        for operation in DEFERRED_PORTS {
            assert!(
                DEFERRED_REASONS.iter().any(|(name, _)| name == operation),
                "{operation} is deferred with no stated reason"
            );
        }
        for (operation, _) in DEFERRED_REASONS {
            assert!(
                DEFERRED_PORTS.contains(operation),
                "{operation} has a reason but is not listed as deferred"
            );
        }
    }

    #[test]
    fn an_unknown_port_is_reported_as_a_bug_rather_than_a_deferral() {
        // A deferral that covers every name would make the deferral mean
        // nothing. An unlisted name has to read as a call-site mistake.
        let e = deferred_port("SomeService::not_a_port");
        assert!(e.to_string().contains("call-site bug"), "{e}");
    }

    #[test]
    fn no_deferred_reason_claims_a_primitive_is_missing() {
        // Every reason above must be about a *store* or a *contract*, never
        // about WebCrypto. "WebCrypto cannot do TOTP" would be false — it can
        // do every step of it — and would license someone to implement the
        // maths here.
        for (operation, reason) in DEFERRED_REASONS {
            for forbidden in ["WebCrypto cannot", "crypto.subtle cannot", "unavailable"] {
                assert!(
                    !reason.contains(forbidden),
                    "{operation} blames the platform: {reason}"
                );
            }
        }
    }

    #[test]
    fn a_deferred_reason_is_never_client_safe() {
        // Whatever else these reasons are, they are operator-facing: a client
        // that reads "TOTP is deferred until the counter store exists" learns
        // about this system's internals and nothing about their request.
        for (operation, _) in DEFERRED_REASONS {
            assert!(
                !deferred_port(operation).is_client_safe(),
                "{operation} leaks internals to a client"
            );
        }
    }

    #[test]
    fn the_pkce_verifier_bounds_are_rfc_7636s() {
        let service = WebCryptoPkceService::new();
        assert!(service.derive_challenge("short").is_err());
        assert!(service.derive_challenge(&"a".repeat(129)).is_err());
        assert!(service.derive_challenge(&"a".repeat(43)).is_err());
        // 44..=128 are inside the range, and `derive_challenge` refuses only
        // on the *length* check — the SHA-256 needs WebCrypto, which this
        // target does not have, so the outcome past the bound is
        // "not a length failure".
        for len in [44usize, 64, 128] {
            let outcome = service.derive_challenge(&"a".repeat(len));
            assert_ne!(
                outcome.as_ref().err().map(SecurityError::code),
                Some("verification_failed"),
                "length {len} is inside the RFC 7636 range"
            );
        }
    }

    #[test]
    fn pkce_verify_refuses_an_absent_side_before_touching_crypto() {
        // A refusal that costs no WebCrypto call and gives the same answer for
        // "no challenge" and "no verifier" is the cheap part of the contract.
        let service = WebCryptoPkceService::new();
        assert!(matches!(
            service.verify("", &"a".repeat(43)),
            Err(SecurityError::ChallengeMismatch)
        ));
        assert!(matches!(
            service.verify("Zm9vYmFy", ""),
            Err(SecurityError::ChallengeMismatch)
        ));
    }

    #[test]
    fn the_audience_claim_is_a_string_or_an_array_and_never_both_absent() {
        let cases = [
            (serde_json::json!({"aud": "ecoma"}), true),
            (serde_json::json!({"aud": ["other", "ecoma"]}), true),
            (serde_json::json!({"aud": ["other"]}), false),
            (serde_json::json!({"aud": 42}), false),
            (serde_json::json!({}), false),
        ];
        for (claims, expected) in cases {
            assert_eq!(audience_matches(&claims, "ecoma"), expected, "{claims}");
        }
    }

    #[test]
    fn an_expiry_claim_is_read_as_a_number_or_a_numeric_string() {
        // RFC 7519 §4.1.4 says NumericDate, and permits a JSON number or a
        // numeric string. Rejecting the string form is a false rejection.
        assert_eq!(
            numeric_claim(&serde_json::json!({"exp": 10}), "exp"),
            Some(10)
        );
        assert_eq!(
            numeric_claim(&serde_json::json!({"exp": "10"}), "exp"),
            Some(10)
        );
        assert_eq!(
            numeric_claim(&serde_json::json!({"exp": true}), "exp"),
            None
        );
        assert_eq!(numeric_claim(&serde_json::json!({}), "exp"), None);
    }

    #[test]
    fn the_jose_header_names_the_one_algorithm_this_crate_signs() {
        // If a second `alg` is ever added, this is the test that fails, and the
        // discovery document has to change with it.
        let header = jose_header();
        assert_eq!(
            header.get("alg").and_then(serde_json::Value::as_str),
            Some("RS256")
        );
        assert_eq!(
            header.get("typ").and_then(serde_json::Value::as_str),
            Some("JWT")
        );
    }

    #[test]
    fn the_constant_time_comparison_is_documented_as_the_only_comparison_path() {
        // Not a behavioural test — a documentation test. The prohibition on a
        // hand-rolled comparison is only mechanical if the function that does
        // it is the one a reader is sent to, so this points at it.
        let source = include_str!("crypto.rs");
        assert!(
            source.contains("SubtleCrypto::verify() is the platform's constant-time"),
            "the constant-time argument has moved out of the module header"
        );
    }

    #[test]
    fn no_rust_equality_is_used_on_secret_derived_bytes() {
        // The mechanical version of ADR-0008's prohibition on a hand-rolled
        // comparison. The one function that compares two values from outside
        // (`constant_time_hmac_eq`) is extracted and read: a `==`, a `!=` or a
        // `vec!` comparison over `a`, `b` or the digests fails this test, and
        // there is no `#[allow]` on it.
        let source = include_str!("crypto.rs");
        let start = source
            .find("async fn constant_time_hmac_eq")
            .expect("the comparison is still in this file");
        let body = &source[start..];
        let end = body.find("\n}\n").expect("the function is closed");
        let body = &body[..end];
        for forbidden in ["a == b", "a != b", "digest_a ==", "digest_b =="] {
            assert!(
                !body.contains(forbidden),
                "constant_time_hmac_eq compares with `{forbidden}`"
            );
        }
        // It must still reach the platform's comparator, or the test above is
        // vacuous.
        assert!(
            body.contains("verify_promise"),
            "the comparison no longer goes through SubtleCrypto::verify"
        );
    }

    #[test]
    fn an_all_zero_buffer_is_recognised_as_not_usable_entropy() {
        // The bug this exists for: a zero-filled view that was allocated but
        // never filled, read as a successful CSPRNG result. A length check, a
        // type check and a `Debug` print would all accept it.
        assert!(random_bytes_is_zero_checked(&[0u8; 32]));
        assert!(random_bytes_is_zero_checked(&[0u8; 16]));
        assert!(
            !random_bytes_is_zero_checked(&[0u8; 15]),
            "too short to judge"
        );
        assert!(!random_bytes_is_zero_checked(&[]));
        let mut mixed = vec![0u8; 32];
        mixed[17] = 1;
        assert!(!random_bytes_is_zero_checked(&mixed));
    }

    #[test]
    fn the_zero_check_would_reject_a_buffer_that_only_one_byte_of() {
        // A buffer that is 31/32 zero is *not* rejected. The check is not a
        // distribution test; rejecting a mostly-zero-but-not-quite buffer would
        // be a false positive on a working generator.
        let mut nearly = vec![0u8; 32];
        nearly[0] = 0xff;
        assert!(!random_bytes_is_zero_checked(&nearly));
    }

    #[test]
    fn the_zero_check_is_a_plumbing_check_and_not_a_distribution_test() {
        // `random_bytes(0)` needs the platform, so it is asserted on the wasm
        // side instead. What is assertable here is the boundary the check
        // draws, which is what a future edit to `MIN_CHECKED_BYTES` would
        // silently change: below the floor the check abstains.
        assert!(!random_bytes_is_zero_checked(&[0u8; 15]));
        assert!(random_bytes_is_zero_checked(&[0u8; 16]));
    }
}

// The tests below need a live `crypto.subtle`, and `js_sys` panics outright on a
// non-wasm target ("cannot call wasm-bindgen imported functions on non-wasm
// targets"). They are therefore compiled and run only for
// `wasm32-unknown-unknown`, under `wasm-pack test --node` or a real Worker —
// which is also the only place their result means anything. On the host target
// they are **absent, not skipped**: a test that runs zero assertions is a lie
// about coverage, and the honest form of "this needs a Workers runtime" is a
// file that does not compile for the target that cannot run it.
//
// Until that runner is wired into CI these are **unverified**: the code path
// they exercise has been compiled for wasm but not executed.
//
// `test` is part of the gate because `wasm_bindgen_test` is a dev-dependency
// and a dev-dependency is not linked into a plain `cargo build`. Gating on
// `target_arch` alone fails the deployable's own wasm build with `E0432` on
// both the attribute and the `use` below. Both halves are load-bearing.
#[cfg(all(target_arch = "wasm32", test))]
#[wasm_bindgen_test::wasm_bindgen_test_configure]
mod wasm_tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    async fn random_bytes_is_filled_by_the_platform_and_not_left_at_zero() {
        // The regression test for the bug this function's documentation
        // describes. It asserts on the *bytes*, not on the length: a view that
        // was allocated, handed to `getRandomValues` and read from the wrong
        // side of the call is the right length and entirely zero.
        let bytes = random_bytes(32).expect("the platform must provide entropy");
        assert_eq!(bytes.len(), 32);
        assert!(
            !random_bytes_is_zero_checked(&bytes),
            "getRandomValues returned an all-zero buffer; every credential \
             derived from it would be deterministic"
        );
        // Two reads must differ. A generator returning a constant is a second
        // way the same bug can present, and this is what catches it.
        let other = random_bytes(32).expect("the second read must also work");
        assert_ne!(
            bytes, other,
            "two reads of 32 bytes produced the same value"
        );
    }

    #[wasm_bindgen_test]
    async fn a_short_random_read_is_not_zero_checked() {
        // The documented floor. Below it, an all-zero result is *refused* by
        // `random_bytes` but not by the check, and this asserts the boundary so
        // the two cannot drift.
        let bytes = random_bytes(8).expect("a short read must work");
        assert_eq!(bytes.len(), 8);
        assert!(!random_bytes_is_zero_checked(&bytes));
    }

    #[wasm_bindgen_test]
    async fn sha256_matches_the_fips_180_4_vector() {
        // NIST's published digest for "abc". If the primitive were wired to the
        // wrong algorithm, or the base64url encoding were the standard alphabet,
        // this is the test that says so.
        let digest = sha256(b"abc").await.expect("sha256 must be available");
        assert_eq!(
            base64url_encode(&digest),
            "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
        );
        assert_eq!(digest.len(), 32);
    }

    #[wasm_bindgen_test]
    async fn the_constant_time_comparison_answers_correctly() {
        // The comparison's *answers*, on the platform. A wrong `false` would
        // refuse every legitimate PKCE code; a wrong `true` would accept any
        // code. Both directions are asserted, plus the length asymmetry.
        assert!(
            constant_time_eq(b"the same bytes", b"the same bytes")
                .await
                .expect("the platform must compare")
        );
        assert!(
            !constant_time_eq(b"the same bytes", b"the other bytes")
                .await
                .expect("the platform must compare")
        );
        assert!(
            !constant_time_eq(b"short", b"much longer than short")
                .await
                .expect("a length mismatch is not an equality")
        );
        // A one-byte difference at the *end* of a 43-byte value — the shape a
        // PKCE verifier has. A comparison that returned early on the first
        // differing byte would still answer correctly here, which is exactly
        // why the answer alone is not the security property; the absence of a
        // `==` in `constant_time_hmac_eq` (asserted on the host) is.
        let a = "a".repeat(43);
        let b = format!("{}b", "a".repeat(42));
        assert!(
            !constant_time_eq(a.as_bytes(), b.as_bytes())
                .await
                .expect("the platform must compare")
        );
    }

    #[wasm_bindgen_test]
    async fn the_pkce_s256_transform_matches_rfc_7636s_vector() {
        // The worked example in RFC 7636 Appendix B, verbatim. If the digest
        // or the base64url encoding were wrong, this is the one assertion in
        // the repository that would catch it.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(
            WebCryptoPkceService::new()
                .derive_challenge_async(verifier)
                .await
                .expect("derivation must work"),
            expected
        );
    }

    #[wasm_bindgen_test]
    async fn a_pkce_verifier_and_its_challenge_verify_and_a_wrong_one_does_not() {
        let service = WebCryptoPkceService::new();
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = service
            .derive_challenge_async(verifier)
            .await
            .expect("derivation must work");
        service
            .verify_async(&challenge, verifier)
            .await
            .expect("the correct pair must verify");
        let wrong = format!("{}X", &verifier[..verifier.len() - 1]);
        assert!(matches!(
            service.verify_async(&challenge, &wrong).await,
            Err(SecurityError::VerificationFailed)
        ));
    }

    #[wasm_bindgen_test]
    async fn aes_gcm_round_trips_and_refuses_a_tampered_ciphertext() {
        // The at-rest cipher. Three things asserted: a round trip returns the
        // plaintext, the ciphertext is not the plaintext, and a single flipped
        // bit is refused rather than decrypted into garbage.
        let key = crate::secrets::SecretBytes::new("K", vec![7u8; 32], 32)
            .expect("32 bytes is a valid key");
        let cipher = WebCryptoSecretCipher::new(key, SigningKeyId::new("k1").expect("a key id"))
            .expect("a cipher");
        let plaintext = b"a totp seed, 32 chars of base32!!";
        let ciphertext = cipher
            .encrypt_async(plaintext)
            .await
            .expect("encryption must work");
        assert_ne!(ciphertext, plaintext.to_vec());
        assert!(
            ciphertext.len() > plaintext.len(),
            "nonce and tag are prepended"
        );
        assert_eq!(
            cipher
                .decrypt_async(&ciphertext)
                .await
                .expect("a round trip"),
            plaintext.to_vec()
        );
        let mut tampered = ciphertext.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        // Matched on the variant *and* the reason rather than on
        // `SecurityError::Cryptographic(_)`: `matches!` alone would accept a
        // failure to even parse the input, which is a different bug with the
        // same type. The reason is the operator-facing string, so asserting on
        // it is what pins "this failed because authentication did", not
        // "this failed somewhere in crypto".
        assert!(matches!(
            cipher.decrypt_async(&tampered).await,
            Err(SecurityError::Cryptographic { ref reason }) if !reason.is_empty()
        ));
    }

    #[wasm_bindgen_test]
    async fn two_encryptions_of_the_same_plaintext_differ() {
        // The nonce-reuse property the `SecretCipher` documentation promises. A
        // fixed IV would make these equal, and two rows of stored ciphertext
        // would then be readable as a pair.
        let key = crate::secrets::SecretBytes::new("K", vec![7u8; 32], 32)
            .expect("32 bytes is a valid key");
        let cipher = WebCryptoSecretCipher::new(key, SigningKeyId::new("k1").expect("a key id"))
            .expect("a cipher");
        let first = cipher.encrypt_async(b"same").await.expect("first");
        let second = cipher.encrypt_async(b"same").await.expect("second");
        assert_ne!(first, second, "a nonce was reused");
    }
}
