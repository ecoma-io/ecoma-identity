//! Outbox events: what Identity says happened, on its way to something else.
//!
//! The outbox exists because a D1 transaction and a Queues enqueue are *not*
//! atomic, and pretending otherwise is how you lose an email. The pattern is
//! the standard one, and its cost is stated plainly here: at-least-once
//! delivery, no exactly-once. A dispatcher reads committed outbox rows and
//! enqueues them; a crash between the two replays the row; a crash before the
//! transaction commits writes nothing. Every consumer therefore **must** be
//! idempotent, keyed on [`OutboxEvent::id`].

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{DomainError, DomainResult};

/// An outbox event's opaque, stable identifier.
///
/// This is the idempotency key. It is minted when the event is *written*, not
/// when it is dispatched, so a replay after a crash carries the same id and
/// the consumer can recognise it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OutboxEventId(Uuid);

impl OutboxEventId {
    /// Create an identifier from a UUID.
    ///
    /// # Errors
    ///
    /// None. See [`crate::user::UserId::from_uuid`].
    #[must_use]
    pub const fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    /// Mint a new random identifier.
    ///
    /// # Errors
    ///
    /// None today; see [`crate::user::UserId::new`].
    pub fn new() -> DomainResult<Self> {
        Ok(Self(Uuid::new_v4()))
    }

    /// The canonical text form.
    #[must_use]
    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl core::fmt::Display for OutboxEventId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The queue message type for an outbox event.
///
/// Versioned in the string itself, deliberately. `identity.email.send.v1` and
/// `identity.email.send.v2` are different message types, which is what lets
/// the consumer be deployed to understand both while the producer is still
/// emitting the first (ADR-0014). A consumer that only knows `v1` is never
/// handed a `v2` body.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OutboxEventType(String);

impl OutboxEventType {
    /// The maximum length of a message type, in bytes.
    pub const MAX_LEN: usize = 128;

    /// Build a message type.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when `value` is blank, padded, over
    /// [`OutboxEventType::MAX_LEN`] bytes, or has no `.vN` suffix. Requiring
    /// the version suffix is what makes "this schema evolved" visible in the
    /// type name instead of hidden in a payload field.
    pub fn parse(value: &str) -> DomainResult<Self> {
        crate::error::require_non_blank("event_type", value)?;
        crate::error::require_max_len("event_type", value, Self::MAX_LEN)?;

        let Some((_, version)) = value.rsplit_once(".v") else {
            return Err(DomainError::invalid(
                "event_type",
                "must end with a `.vN` version suffix",
            ));
        };
        if version.is_empty() || !version.bytes().all(|b| b.is_ascii_digit()) {
            return Err(DomainError::invalid(
                "event_type",
                "version suffix must be one or more digits",
            ));
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    /// The email-send event type, version 1.
    ///
    /// # Errors
    ///
    /// None. The literal is known-good; this exists so a consumer's match arm
    /// and the producer's write site cannot drift apart by typo.
    #[must_use]
    pub fn email_send_v1() -> Self {
        Self("identity.email.send.v1".to_string())
    }

    /// The security-notification event type, version 1.
    ///
    /// # Errors
    ///
    /// None. See [`OutboxEventType::email_send_v1`].
    #[must_use]
    pub fn security_notification_v1() -> Self {
        Self("identity.security.notification.v1".to_string())
    }

    /// The audit-archive event type, version 1.
    ///
    /// # Errors
    ///
    /// None. See [`OutboxEventType::email_send_v1`].
    #[must_use]
    pub fn audit_archive_v1() -> Self {
        Self("identity.audit.archive.v1".to_string())
    }

    /// Borrow the type as a string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The version number in the suffix, for a consumer that wants to know
    /// which schema it is reading.
    ///
    /// # Errors
    ///
    /// None. [`OutboxEventType::parse`] proved the suffix is digits.
    ///
    /// # Panics
    ///
    /// Never, for a value that came from [`OutboxEventType::parse`] or from
    /// `Deserialize` — both refuse a type without a `.vN` suffix. `version`
    /// also refuses to invent a number: an unparseable suffix is `0`, not a
    /// guess, so a malformed type surfaces as "version 0", which no consumer
    /// supports, rather than as a plausible version that silently binds to the
    /// wrong schema.
    #[must_use]
    pub fn version(&self) -> u32 {
        let (_, version) = self
            .0
            .rsplit_once(".v")
            .expect("OutboxEventType::parse guarantees a version suffix");
        version.parse().unwrap_or(0)
    }
}

impl core::fmt::Display for OutboxEventType {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A committed fact, waiting to be dispatched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxEvent {
    /// The idempotency key, minted at write time.
    pub id: OutboxEventId,
    /// Which queue message type this becomes.
    pub event_type: OutboxEventType,
    /// The message body. Opaque here: `identity-cloudflare` serialises it, and
    /// the shape belongs to the event's own version, not to this type.
    pub payload: serde_json::Value,
    /// When the fact was committed, as milliseconds since the Unix epoch.
    pub occurred_at_ms: i64,
    /// How many times the dispatcher has tried to enqueue this row. Written by
    /// the dispatcher, never by the producer, and bounded: a row past the
    /// attempt ceiling is dead-lettered rather than retried forever.
    pub dispatch_attempts: u32,
}

impl OutboxEvent {
    /// The attempt ceiling after which a row is dead-lettered.
    ///
    /// Chosen to outlast a weekend of a queue being misconfigured while still
    /// failing in hours rather than days — an email that arrives three days
    /// late is a support incident, and an unbounded retry is worse than a
    /// visible dead letter.
    pub const MAX_DISPATCH_ATTEMPTS: u32 = 25;

    /// Build an outbox event.
    ///
    /// # Errors
    ///
    /// None today. The fallible signature is for symmetry with the other
    /// constructors here, and because a future validated payload shape will
    /// need it.
    pub fn new(
        event_type: OutboxEventType,
        payload: serde_json::Value,
        occurred_at_ms: i64,
    ) -> DomainResult<Self> {
        Ok(Self {
            id: OutboxEventId::new()?,
            event_type,
            payload,
            occurred_at_ms,
            dispatch_attempts: 0,
        })
    }

    /// Whether the dispatcher should attempt another enqueue.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub const fn should_dispatch(&self) -> bool {
        self.dispatch_attempts < Self::MAX_DISPATCH_ATTEMPTS
    }

    /// Record one dispatch attempt.
    ///
    /// # Errors
    ///
    /// [`DomainError::IllegalTransition`] when the row is already at
    /// [`OutboxEvent::MAX_DISPATCH_ATTEMPTS`]. Attempt number N+1 on an
    /// exhausted row is a dispatcher bug, and the counter is how an operator
    /// sees it.
    pub fn record_dispatch_attempt(&mut self) -> DomainResult<()> {
        if !self.should_dispatch() {
            return Err(DomainError::illegal(
                "outbox row has exhausted its dispatch attempts",
            ));
        }
        self.dispatch_attempts += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_type_must_carry_a_version_suffix() {
        assert!(OutboxEventType::parse("identity.email.send.v1").is_ok());
        assert!(OutboxEventType::parse("identity.email.send.v12").is_ok());
        assert!(OutboxEventType::parse("identity.email.send").is_err());
        assert!(OutboxEventType::parse("identity.email.send.v").is_err());
        assert!(OutboxEventType::parse("identity.email.send.vx").is_err());
        assert!(OutboxEventType::parse("").is_err());
    }

    #[test]
    fn the_version_is_readable_without_parsing_the_whole_name() {
        assert_eq!(OutboxEventType::email_send_v1().version(), 1);
        assert_eq!(
            OutboxEventType::parse("identity.email.send.v42")
                .expect("valid")
                .version(),
            42
        );
    }

    #[test]
    fn the_three_bootstrap_event_types_are_distinct() {
        // A consumer's match arm on one of these must not shadow another.
        let all = [
            OutboxEventType::email_send_v1(),
            OutboxEventType::security_notification_v1(),
            OutboxEventType::audit_archive_v1(),
        ];
        let unique: std::collections::BTreeSet<_> = all.iter().collect();
        assert_eq!(unique.len(), 3);
        assert!(all.iter().all(|e| e.version() == 1));
    }

    #[test]
    fn dispatch_stops_at_the_attempt_ceiling() {
        let mut e = OutboxEvent::new(OutboxEventType::email_send_v1(), serde_json::json!({}), 0)
            .expect("valid");
        for _ in 0..OutboxEvent::MAX_DISPATCH_ATTEMPTS {
            assert!(e.should_dispatch());
            e.record_dispatch_attempt().expect("within ceiling");
        }
        assert!(!e.should_dispatch());
        assert!(e.record_dispatch_attempt().is_err());
    }

    #[test]
    fn the_id_is_minted_at_write_time_not_at_dispatch() {
        // Two events built from the same payload and timestamp still have
        // distinct ids. Sharing an id would make the consumer dedupe a real
        // second event away.
        let mk = || {
            OutboxEvent::new(
                OutboxEventType::email_send_v1(),
                serde_json::json!({"to": "a@example.com"}),
                1_000,
            )
            .expect("valid")
        };
        assert_ne!(mk().id, mk().id);
    }
}
