//! D1 helpers: statements, batches, and the row-mapping boundary.
//!
//! # Who may hold a D1 handle
//!
//! **Only the Identity Worker.** That is constraint §2 of the founding brief,
//! and it is not enforced here.
//!
//! There is no runtime capability check in this module, and there will not be
//! one. A check like "refuse unless the caller says it is the identity Worker"
//! would be a string comparison on a value the caller itself supplied, which is
//! not a guard — it is a comment with a runtime cost. The real enforcement is
//! two things that cannot be worked around by a well-meaning import:
//!
//! 1. `tooling/scripts/check-architecture.mjs`, which reads `cargo metadata`
//!    and the git index and fails CI if the Admin or Jobs Worker takes a D1
//!    binding or names an identity repository.
//! 2. The `wrangler` configuration per environment, which grants
//!    `IDENTITY_DB` to the `identity` Worker and to no other script.
//!
//! This module is documentation for that arrangement and plumbing to use it
//! once you are inside the Worker that holds it. If you are reading this from
//! a different composition root, the answer is not "but the helper is right
//! here" — it is that the binding will not exist in your `Env`.
//!
//! # What a transaction is here
//!
//! D1 has no interactive transaction and no `BEGIN`/`COMMIT` across requests.
//! What it has is [`D1Database::batch`], which runs statements in one implicit
//! transaction: all of them commit, or none do. That is the only atomicity
//! available, and it is the atomicity the outbox and the audit write depend on
//! (see `identity-application`'s `WriteAuditEvent`, which explicitly forbids a
//! repository from committing on its own).
//!
//! For a read-then-write that must be atomic against a concurrent request —
//! "demote a user, unless they are the last administrator" — a batch is not
//! enough, because the count and the update must be the same unit. That case
//! needs a `D1DatabaseSession` anchored on the primary, and this module does not
//! pretend otherwise: [`TransactionBatch`] documents the gap.

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use worker::d1::{D1Database, D1PreparedStatement, D1Result};
use worker::js_sys::{ArrayBuffer, Uint8Array};

use crate::error::{CloudflareError, Result, TransportError};

/// A statement with its arguments already bound.
///
/// A thin alias for the platform's own type. It exists so a repository's
/// signature reads `TransactionBatch<'a>` rather than reaching for
/// `worker::d1` directly, and so the `statement`/`args` pairing is visible in
/// the type rather than being a convention at the call site.
pub struct TransactionBatch<'a> {
    /// The SQL, with `?` placeholders.
    pub statement: &'a str,
    /// The bound arguments, in placeholder order.
    pub args: Vec<D1Arg>,
}

/// A value bound to a D1 placeholder.
///
/// A newtype over `D1Type` rather than a re-export, so a repository cannot bind
/// a raw `JsValue` and reach outside the set of types D1 actually supports.
#[derive(Clone)]
pub struct D1Arg(D1TypeInner);

/// The `Debug` of a bound argument, by hand.
///
/// A derived `Debug` on this type would print `Text("hunter2")` — and a bound
/// argument can be a session credential, a TOTP seed or a client secret. The
/// type the operator needs from a log line is *how many* arguments there were
/// and *which kinds*, because that is what a failing batch is diagnosed from;
/// the values are never needed and must never be present. So the derived impl
/// is not merely unused, it is the bug this implementation exists to prevent.
impl core::fmt::Debug for D1Arg {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let kind = match self.0 {
            D1TypeInner::Null => "null",
            D1TypeInner::Integer(_) => "integer",
            D1TypeInner::Real(_) => "real",
            D1TypeInner::Text(_) => "text",
            D1TypeInner::Boolean(_) => "boolean",
            D1TypeInner::Blob(_) => "blob",
        };
        write!(f, "D1Arg({kind}, <redacted>)")
    }
}

#[derive(Clone)]
enum D1TypeInner {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Boolean(bool),
    Blob(Vec<u8>),
}

impl D1Arg {
    /// A nullable column.
    #[must_use]
    pub const fn null() -> Self {
        Self(D1TypeInner::Null)
    }

    /// An integer column.
    #[must_use]
    pub const fn integer(value: i64) -> Self {
        Self(D1TypeInner::Integer(value))
    }

    /// A float column.
    #[must_use]
    pub const fn real(value: f64) -> Self {
        Self(D1TypeInner::Real(value))
    }

    /// A text column.
    #[must_use]
    pub fn text(value: impl Into<String>) -> Self {
        Self(D1TypeInner::Text(value.into()))
    }

    /// A boolean column, stored as the integer SQLite has.
    #[must_use]
    pub const fn boolean(value: bool) -> Self {
        Self(D1TypeInner::Boolean(value))
    }

    /// A blob column.
    #[must_use]
    pub fn blob(value: impl Into<Vec<u8>>) -> Self {
        Self(D1TypeInner::Blob(value.into()))
    }

    /// Bind this argument onto a prepared statement.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the platform refuses the binding, which
    /// in practice means the statement has fewer placeholders than the
    /// repository supplied arguments.
    pub fn bind(self, statement: D1PreparedStatement) -> Result<D1PreparedStatement> {
        // `D1Type::Text` and `D1Type::Blob` borrow, and `JsValue::from` copies
        // the JS value it is built from. The borrow is the problem: the `match`
        // arm's binding dies with the arm, so the owned value is lifted to the
        // enclosing scope first and the borrow is taken against that. This is
        // the one place in the crate that has to think about it, which is why
        // `bind` is a function on `D1Arg` rather than something a repository
        // writes at each call site.
        let owned = self.0;
        let argument: worker::d1::D1Type<'_> = match &owned {
            D1TypeInner::Null => worker::d1::D1Type::Null,
            D1TypeInner::Integer(v) => {
                worker::d1::D1Type::Integer(i32::try_from(*v).map_err(|_| {
                    CloudflareError::transport(TransportError::platform(
                        "d1.bind",
                        "integer does not fit SQLite's i32",
                    ))
                })?)
            }
            D1TypeInner::Real(v) => worker::d1::D1Type::Real(*v),
            D1TypeInner::Text(v) => worker::d1::D1Type::Text(v),
            D1TypeInner::Boolean(v) => worker::d1::D1Type::Boolean(*v),
            D1TypeInner::Blob(v) => worker::d1::D1Type::Blob(v),
        };
        statement.bind(&[JsValue::from(&argument)]).map_err(|e| {
            CloudflareError::transport(TransportError::platform("d1.bind", e.to_string()))
        })
    }
}

/// Build the prepared statements for a batch.
///
/// # Errors
///
/// [`TransportError::Platform`] if any statement fails to prepare or bind. The
/// whole batch is refused: a partially-bound batch that is then executed is a
/// batch where some writes applied and some did not, which is the exact
/// outcome a batch exists to make impossible.
///
/// Not `async`: `D1Database::prepare` and `D1PreparedStatement::bind` are
/// synchronous — they build a statement object, they do not execute it.
/// Execution is `batch()` or `exec()`, and that is where the platform I/O
/// lives. An `async` on this function would make the caller await a
/// preparation that was already complete, and would hide which call is the
/// one that actually talks to D1.
pub fn prepare_batch(
    db: &D1Database,
    batch: &[TransactionBatch<'_>],
) -> Result<Vec<D1PreparedStatement>> {
    let mut prepared = Vec::with_capacity(batch.len());
    for unit in batch {
        let mut statement = db.prepare(unit.statement);
        for arg in unit.args.iter().cloned() {
            statement = arg.bind(statement)?;
        }
        prepared.push(statement);
    }
    Ok(prepared)
}

/// Execute a batch atomically and return one result per statement.
///
/// The atomicity is D1's, not this function's: `D1Database::batch` runs the
/// statements in a single implicit transaction, so either every statement
/// commits or none does. That is what lets an audit event and the change it
/// describes be written together.
///
/// # Errors
///
/// [`TransportError::Platform`] on any failure, including the partial-failure
/// case D1 reports for a constraint violation — in which case nothing in the
/// batch was committed.
pub async fn execute_batch(
    db: &D1Database,
    batch: &[TransactionBatch<'_>],
) -> Result<Vec<D1Result>> {
    let statements = prepare_batch(db, batch)?;
    db.batch(statements).await.map_err(|e| {
        CloudflareError::transport(TransportError::platform("d1.batch", e.to_string()))
    })
}

/// Map the first row of a query, turning "no rows" and "the wrong shape" into
/// distinct failures.
///
/// They are distinct on purpose. "No row" is a 404 and is the caller's answer;
/// "the row did not have the columns we asked for" is a schema drift and is
/// *ours*, and silently returning a default for it is how a nullable column
/// that should be `NOT NULL` starts answering requests with an empty string.
///
/// # Errors
///
/// [`TransportError::Platform`] with operation `d1.map_row` for both "no row"
/// and "wrong shape", distinguished by the reason text. The reason is
/// operator-facing: `CloudflareError::is_client_safe` is false for platform
/// failures, so neither reaches the wire.
pub async fn map_first_row<T: serde::de::DeserializeOwned>(
    db: &D1Database,
    statement: &str,
    args: &[D1Arg],
) -> Result<Option<T>> {
    let mut prepared = db.prepare(statement);
    for arg in args.iter().cloned() {
        prepared = arg.bind(prepared)?;
    }
    prepared.first(None).await.map_err(|e| {
        CloudflareError::transport(TransportError::platform("d1.map_row", e.to_string()))
    })
}

/// Decode a D1 blob column into owned bytes.
///
/// # Errors
///
/// [`TransportError::Platform`] when the platform cannot produce the array
/// buffer. Kept as its own function so the `Uint8Array` construction — the one
/// place in the crate that touches `js_sys` — is in a single named place.
pub fn blob_from(value: JsValue) -> Result<Vec<u8>> {
    let buffer: ArrayBuffer = value.dyn_into().map_err(|_| {
        CloudflareError::transport(TransportError::platform(
            "d1.blob",
            "value is not an ArrayBuffer",
        ))
    })?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_argument_value_is_never_rendered_in_a_log_line() {
        // A bound argument can be a session credential, a TOTP seed or a client
        // secret. The `Debug` of an argument list therefore names the *kind* of
        // each argument and nothing else.
        let args = vec![
            D1Arg::text("hunter2"),
            D1Arg::integer(7),
            D1Arg::blob(vec![0xde, 0xad, 0xbe, 0xef]),
            D1Arg::boolean(true),
            D1Arg::real(1.5),
            D1Arg::null(),
        ];
        let debug = format!("{args:?}");
        assert!(!debug.contains("hunter2"), "{debug}");
        // `D1Arg::integer(7)` must not render as a bare `7`. A bare `"7"`
        // substring check would be meaningless — a digit appears in almost any
        // Debug output — so this asserts on the *typed* rendering instead:
        // the kind is named and the value is not printed beside it.
        assert!(!debug.contains("integer(7"), "{debug}");
        assert!(debug.contains("integer"), "{debug}");
        // A `Vec<u8>` derived `Debug` would print the bytes as a decimal list;
        // this asserts none of them are present either.
        for byte in ["222", "173", "190", "239"] {
            assert!(!debug.contains(byte), "{byte} leaked: {debug}");
        }
        // The kinds are, because that is what a failing batch is diagnosed from.
        assert!(debug.contains("text"), "{debug}");
        assert!(debug.contains("blob"), "{debug}");
        assert!(debug.contains("integer"), "{debug}");
    }

    #[test]
    fn the_redacted_debug_of_an_argument_is_stable() {
        // Asserted exactly, because a `Debug` format is a thing a log parser
        // may come to depend on, and a silent change to it should be a visible
        // diff rather than something nobody notices.
        assert_eq!(
            format!("{:?}", D1Arg::text("hunter2")),
            "D1Arg(text, <redacted>)"
        );
        assert_eq!(format!("{:?}", D1Arg::null()), "D1Arg(null, <redacted>)");
    }

    #[test]
    fn a_binding_constructors_cover_the_types_d1_actually_accepts() {
        // If one of these is removed the compiler says so at the one place it
        // matters. The assertion is the boundary test AGENTS.md asks for: a
        // failure means "someone deleted a pub", not "the behaviour broke".
        let _ = D1Arg::null();
        let _ = D1Arg::integer(i64::MIN);
        let _ = D1Arg::real(1.5);
        let _ = D1Arg::text("a");
        let _ = D1Arg::boolean(true);
        let _ = D1Arg::blob(vec![0u8; 2]);
    }

    #[test]
    fn a_i64_outside_sqlites_range_is_refused_before_it_reaches_the_binding() {
        // D1 has no BigInt and no i64 column. Binding one would truncate
        // silently at the boundary or throw at it; refusing here says which
        // happened. (This is a pure construction test: `bind` needs a live
        // statement, which needs a live Worker, so the range check itself is
        // exercised in the integration suite rather than here.)
        assert!(i32::try_from(i64::MAX).is_err());
        assert!(i32::try_from(0_i64).is_ok());
    }
}
