//! The KV wrapper for counters and idempotency guards.
//!
//! # KV here is never authoritative identity state
//!
//! That is constraint §24, and it is enforced at the **type** level rather than
//! in a comment a future reader might skip: [`ScratchKv`] is the only handle
//! this module hands out, and the only things that can be written through it are
//! [`ScratchRecord`] — a counter or an idempotency marker. There is no `get`
//! for "the current `security_version` of this user", no `put` for "this
//! session is valid", and no way to express one, because the type has no such
//! method.
//!
//! Why the constraint exists at all, in one paragraph: KV is eventually
//! consistent across locations and has a read-through cache. A session check
//! that reads a *stale* KV row would authenticate a session that was revoked
//! minutes ago; a rate-limit counter that reads a stale row would let a
//! credential-stuffing run through at the speed of the cache's TTL. Both are
//! correctness failures in the security property, not performance ones. So
//! KV holds only things whose loss or staleness is harmless: how many attempts
//! happened in the last minute, and whether this message id was already
//! handled.
//!
//! # Consistency, stated honestly
//!
//! `KvStore::put` is eventually consistent, and `get` may be served from a
//! cache. Every value this module writes carries an explicit TTL, because an
//! entry that outlives its window is a denial of service in waiting. A cached
//! read of an idempotency guard means a duplicate effect is possible; the
//! guard is therefore **best effort**, and the effect it guards is required to
//! be idempotent by construction. See [`ScratchKv::claim_once`].

use serde::{Deserialize, Serialize};
use worker::KvStore;
use worker::kv::KvError;

use crate::error::{CloudflareError, Result, TransportError};

/// The Identity Worker's KV namespace name.
pub const IDENTITY_KV_BINDING: &str = "IDENTITY_KV";

/// The Jobs Worker's KV namespace name.
pub const JOBS_KV_BINDING: &str = "JOBS_KV";

/// What may be written to scratch KV.
///
/// A closed set of two. Both are reconstructible from D1, both are bounded in
/// time, and both are safe to lose. Anything that would fail an open redirect,
/// allow a revoked session, or let an unbound key be trusted would need a
/// column in D1 instead, and the type will not let you write it here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScratchRecord {
    /// A counter for a rate-limit or abuse window.
    Counter {
        /// The value the counter had when it was last incremented.
        count: u32,
    },
    /// A marker saying "this message id has already been handled".
    ///
    /// Not a lock and not a mutex: see [`ScratchKv::claim_once`] for the
    /// honest description of what it is worth.
    Claimed {
        /// The idempotency key that was claimed.
        key: String,
    },
}

/// A handle to a scratch KV namespace.
///
/// Constructed only from a binding name in [`ScratchKv::from_env`], and the
/// only things it can write are [`ScratchKv::increment_counter`] and
/// [`ScratchKv::claim_once`]. The absence of a general-purpose `put` is the
/// point: the narrow surface is what makes "KV is never authoritative" a
/// property of the API rather than a promise in a doc comment — a caller
/// cannot store identity state here even by accident, because there is no
/// method that would accept it.
#[derive(Debug, Clone)]
pub struct ScratchKv {
    store: KvStore,
    binding: &'static str,
}

impl ScratchKv {
    /// Resolve a KV namespace from the Worker `Env` by binding name.
    ///
    /// # Errors
    ///
    /// [`TransportError::MissingBinding`] when the namespace is absent. A
    /// missing namespace is a configuration fault; it is not defaulted to an
    /// in-memory map, because a test double that silently answers "no claim
    /// recorded" is exactly the "best-effort" behaviour promoted to a promise.
    pub fn from_env(env: &worker::Env, binding: &'static str) -> Result<Self> {
        let store = env.kv(binding).map_err(|_| {
            CloudflareError::transport(TransportError::MissingBinding { name: binding })
        })?;
        Ok(Self { store, binding })
    }

    /// The binding this handle was resolved from.
    #[must_use]
    pub const fn binding(&self) -> &'static str {
        self.binding
    }

    /// Read a record.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the platform read fails. Note the
    /// error is *not* downgraded to "absent": an unreachable KV namespace and a
    /// missing key are different facts, and a caller that cannot tell them
    /// apart will eventually treat an outage as "no claim recorded" — which is
    /// the fail-open behaviour this crate refuses elsewhere.
    pub async fn get(&self, key: &str) -> Result<Option<ScratchRecord>> {
        let value = self.store.get(key).text().await.map_err(|e| {
            CloudflareError::transport(TransportError::platform("kv.get", e.to_string()))
        })?;
        value
            .map(|text| {
                serde_json::from_str(&text).map_err(|e| {
                    CloudflareError::transport(TransportError::platform(
                        "kv.decode",
                        format!("scratch record is not decodable: {e}"),
                    ))
                })
            })
            .transpose()
    }

    /// Read and increment a counter, setting its window if absent.
    ///
    /// **Not atomic.** KV offers no read-modify-write primitive, so two
    /// concurrent increments of the same counter can lose one between them. For
    /// a rate-limit counter that means the count can be slightly low, never
    /// slightly high — and the real rate limiting for authenticated endpoints is
    /// the Workers binding in [`crate::rate_limit`], which *is* atomic. This is
    /// a secondary signal, not the control.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the read or the write fails. The counter
    /// is not incremented on a failure, so a caller that fails closed on the
    /// error has not silently lost the attempt.
    pub async fn increment_counter(&self, key: &str, ttl_seconds: u64) -> Result<u32> {
        let next = match self.get(key).await? {
            Some(ScratchRecord::Counter { count }) => count.saturating_add(1),
            _ => 1,
        };
        self.put_record(key, &ScratchRecord::Counter { count: next }, ttl_seconds)
            .await?;
        Ok(next)
    }

    /// Record that an idempotency key has been handled.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the write fails.
    pub async fn claim_once(&self, key: &str, ttl_seconds: u64) -> Result<()> {
        self.put_record(
            key,
            &ScratchRecord::Claimed {
                key: key.to_string(),
            },
            ttl_seconds,
        )
        .await
    }

    /// Whether a key has already been claimed.
    ///
    /// # Errors
    ///
    /// As [`ScratchKv::get`]. An error here must be treated as "unknown", and
    /// the caller's response to unknown must be the idempotent one — see below.
    pub async fn is_claimed(&self, key: &str) -> Result<bool> {
        Ok(matches!(
            self.get(key).await?,
            Some(ScratchRecord::Claimed { .. })
        ))
    }

    /// Delete a key.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] if the platform delete fails. Deletion is
    /// eventually consistent too, so this is not a guarantee that a subsequent
    /// read misses.
    pub async fn forget(&self, key: &str) -> Result<()> {
        self.store.delete(key).await.map_err(|e| {
            CloudflareError::transport(TransportError::platform("kv.delete", e.to_string()))
        })
    }

    /// The exactness of [`ScratchKv::is_claimed`], in one place.
    ///
    /// This function exists to be linked from the code that calls it, and it
    /// says the thing that is easy to get wrong: **exactly-once is not
    /// available.** KV's read may be served from a cache that predates the
    /// write, so two workers processing the same message id concurrently can
    /// both read "not claimed" and both perform the effect. The guard is
    /// best effort and it narrows the window; it does not close it. The effect
    /// therefore has to be idempotent by construction — the guard is there to
    /// avoid doing the work twice in the common case, not to make doing it twice
    /// impossible.
    #[must_use]
    pub const fn exactly_once_is_available() -> bool {
        false
    }

    /// Write a record with an explicit TTL.
    async fn put_record(&self, key: &str, record: &ScratchRecord, ttl_seconds: u64) -> Result<()> {
        let body = serde_json::to_string(record).map_err(|e| {
            CloudflareError::transport(TransportError::platform(
                "kv.encode",
                format!("unserialisable: {e}"),
            ))
        })?;
        let builder = self.store.put(key, body).map_err(|e: KvError| {
            CloudflareError::transport(TransportError::platform("kv.put", e.to_string()))
        })?;
        builder
            .expiration_ttl(ttl_seconds)
            .execute()
            .await
            .map_err(|e| {
                CloudflareError::transport(TransportError::platform("kv.put", e.to_string()))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_once_is_not_available_and_the_module_says_so() {
        // If this ever returns true, the `claim_once` documentation above it
        // is a lie and every consumer's idempotency argument has to be
        // re-examined. That is what makes the assertion worth having.
        assert!(!ScratchKv::exactly_once_is_available());
    }

    #[test]
    fn only_two_record_kinds_exist() {
        // The closed set is the enforcement of "KV is never authoritative".
        // Adding a third kind is a decision that Identity D1 cannot hold the
        // value instead, and this test is where it would be noticed.
        let counter = ScratchRecord::Counter { count: 1 };
        let claimed = ScratchRecord::Claimed { key: "k".into() };
        for record in [counter, claimed] {
            let json = serde_json::to_string(&record).expect("serializable");
            let back: ScratchRecord = serde_json::from_str(&json).expect("deserializable");
            assert_eq!(back, record);
        }
        assert!(serde_json::from_str::<ScratchRecord>(r#"{"kind":"session","count":1}"#).is_err());
    }

    #[test]
    fn a_claim_names_the_key_it_claimed() {
        // So a KV dump is auditable: an operator looking at a namespace can see
        // which idempotency keys are currently claimed without guessing from
        // the key layout.
        let record = ScratchRecord::Claimed {
            key: "outbox:abc".into(),
        };
        let json = serde_json::to_string(&record).expect("serializable");
        assert!(json.contains("outbox:abc"), "{json}");
    }

    #[test]
    fn the_binding_names_are_the_ones_the_wrangler_configs_declare() {
        assert_eq!(IDENTITY_KV_BINDING, "IDENTITY_KV");
        assert_eq!(JOBS_KV_BINDING, "JOBS_KV");
    }
}
