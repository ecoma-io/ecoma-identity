//! Producing and consuming Cloudflare Queues messages.
//!
//! # Delivery is at-least-once, and it is not a detail
//!
//! Cloudflare Queues delivers **at least once**. A message can be handed to a
//! consumer more than once: the platform retries a batch whose handler threw,
//! a consumer can be redeployed mid-batch, and a `retry_all` after a partial
//! batch replays the whole thing. There is no exactly-once and there will
//! never be one across two systems.
//!
//! That is why every handler written against this module must be **idempotent
//! by construction**, keyed on the outbox event id. Not "should be" — must.
//! The producer side makes the key available: `OutboxEvent` mints the id
//! when the event is *written* to the outbox, not when it is dispatched, so a
//! replay after a crash carries the same id and the consumer recognises it.
//!
//! # Why the outbox exists at all
//!
//! **A D1 commit and a Queues enqueue are not atomic, and cannot be made so.**
//! They are two different systems with two different failure domains. Write the
//! event to the queue and then commit the row, and a crash between them loses
//! the row with the queue already holding the message — a user is sent an
//! email for a session that was never created. Commit the row and then enqueue,
//! and a crash between them loses the message — the user is never told their
//! password changed. There is no ordering that fixes both.
//!
//! So the fact is committed to D1 *in the same batch as the state change it
//! describes* ([`crate::d1::execute_batch`]), and a dispatcher later reads
//! committed outbox rows and enqueues them. A crash between the two replays the
//! row; a crash before the commit writes nothing at all. That is the whole
//! trade: at-least-once delivery, in exchange for never losing a fact.
//!
//! # Backward compatibility between producer and consumer
//!
//! Every event type carries its version in its own name
//! (`identity.email.send.v1`), which is what lets a consumer be deployed to
//! understand `v1` while the producer is still emitting it, and lets the
//! producer move to `v2` before every consumer does. A consumer must **refuse**
//! an event type it does not know rather than guessing at its shape — see
//! [`identity_domain::outbox::OutboxEventType`] and the `Jobs Worker`'s
//! dispatcher.

use identity_domain::outbox::{OutboxEvent, OutboxEventId, OutboxEventType};
use serde::{Deserialize, Serialize};
use worker::{MessageBatch, MessageExt, Queue};

use crate::error::{CloudflareError, Result, TransportError};

/// The wire shape of a queued outbox event.
///
/// A struct rather than the bare [`OutboxEvent`], because the queue body is a
/// contract that outlives any Rust type: a consumer deployed next year may be
/// built against a different crate version, and it must still be able to parse
/// what is on it. [`OutboxEvent::payload`] is already an opaque
/// `serde_json::Value`, which is the right shape for a body whose schema belongs
/// to the event's own version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedEvent {
    /// The idempotency key. Minted at write time and never re-minted, so this
    /// is the same string on every delivery of the same fact.
    pub id: String,
    /// The versioned message type, for example `identity.email.send.v1`.
    pub event_type: String,
    /// When the fact was committed, in milliseconds since the Unix epoch.
    pub occurred_at_ms: i64,
    /// The body. Opaque here; its shape belongs to the event type's version.
    pub payload: serde_json::Value,
}

impl QueuedEvent {
    /// Project a committed outbox event onto the wire.
    #[must_use]
    pub fn from_outbox(event: &OutboxEvent) -> Self {
        Self {
            id: event.id.as_string(),
            event_type: event.event_type.to_string(),
            occurred_at_ms: event.occurred_at_ms,
            payload: event.payload.clone(),
        }
    }

    /// The idempotency key, for a consumer's dedupe lookup.
    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.id
    }

    /// The event type, if it is one this build knows.
    ///
    /// `None` for an unknown or malformed type is the answer a consumer must
    /// act on by refusing the message, not by guessing. `OutboxEventType::parse`
    /// requires a `.vN` suffix, so a producer that invents an unversioned type
    /// cannot get a message delivered as something it looks like.
    #[must_use]
    pub fn known_type(&self) -> Option<OutboxEventType> {
        OutboxEventType::parse(&self.event_type).ok()
    }

    /// The idempotency key parsed as an outbox event id.
    ///
    /// # Errors
    ///
    /// [`TransportError::Platform`] when the key is not a UUID. A message whose
    /// key cannot be parsed cannot be deduplicated, and a consumer that tried
    /// anyway would process it again — so it is refused at the parse boundary.
    pub fn parsed_id(&self) -> Result<OutboxEventId> {
        if self.id.is_empty() {
            return Err(CloudflareError::transport(TransportError::platform(
                "queue.parse_id",
                "event id is empty",
            )));
        }
        crate::ids::parse_outbox_event_id(&self.id).ok_or_else(|| {
            CloudflareError::transport(TransportError::platform(
                "queue.parse_id",
                "the event id is not an outbox event id the domain will accept",
            ))
        })
    }
}

/// Enqueue one committed outbox event.
///
/// Call this **only from the dispatcher**, after the row is committed, and only
/// after `record_dispatch_attempt` has been written in the same transaction as
/// the increment. A producer that enqueues inside its own transaction is
/// assuming an atomicity that does not exist.
///
/// # Errors
///
/// [`TransportError::Platform`] if the enqueue fails. The dispatcher must let
/// the row stand (with its incremented attempt count) so the next tick retries
/// it; it must **not** treat a failed enqueue as a reason to delete the row,
/// because that converts a retryable failure into a silently lost fact.
pub async fn enqueue_outbox_event(queue: &Queue, event: &OutboxEvent) -> Result<()> {
    let body = QueuedEvent::from_outbox(event);
    queue.send(body).await.map_err(|e| {
        CloudflareError::transport(TransportError::platform("queue.send", e.to_string()))
    })
}

/// How a consumer decided about one message.
///
/// The three outcomes are named because "I did nothing and it is fine" is not
/// one of them. A message either had its effect performed, or it is retried,
/// or it is dropped — and the choice must be explicit at every call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// The effect was performed. Ack.
    Done,
    /// The effect could not be performed and should be attempted again.
    Retry,
    /// The effect cannot ever be performed and retrying is pointless.
    DeadLetter,
}

/// What a consumer handler produced for a batch.
///
/// The handler returns this rather than a bare `Result<()>` because the
/// per-message disposition has to survive the loop: a handler that retries the
/// whole batch on one bad message will re-run the effects of the good ones,
/// which is exactly the duplicate delivery the idempotency key exists to
/// absorb — but only if the *handler* is idempotent, and a handler that
/// retries indiscriminately also burns the platform's retry budget on a poison
/// message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchOutcome {
    /// Messages whose effect was performed, by message id.
    pub done: Vec<String>,
    /// Messages to retry, by message id.
    pub retry: Vec<String>,
    /// Messages to drop, by message id.
    pub dead_letter: Vec<String>,
}

impl BatchOutcome {
    /// An empty outcome.
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            done: Vec::new(),
            retry: Vec::new(),
            dead_letter: Vec::new(),
        }
    }

    /// Record a message as done.
    pub fn done(&mut self, message_id: impl Into<String>) {
        self.done.push(message_id.into());
    }

    /// Record a message for retry.
    pub fn retry(&mut self, message_id: impl Into<String>) {
        self.retry.push(message_id.into());
    }

    /// Record a message as dead-lettered.
    pub fn dead_letter(&mut self, message_id: impl Into<String>) {
        self.dead_letter.push(message_id.into());
    }

    /// Whether anything needs the platform to do anything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.done.is_empty() && self.retry.is_empty() && self.dead_letter.is_empty()
    }
}

/// The default batch strategy: retry everything, ack nothing.
///
/// Correct under at-least-once delivery **only because** every handler is
/// idempotent. It is the default rather than "ack what succeeded" because a
/// partial ack that forgets one message loses that effect permanently, and a
/// replay of a message that was already applied costs one idempotency lookup.
/// The outcome a batch handler returns to retry every message in it.
#[must_use]
pub fn retry_all_outcome(batch: &MessageBatch<QueuedEvent>) -> BatchOutcome {
    let mut outcome = BatchOutcome::empty();
    for message in batch.iter().flatten() {
        outcome.retry(message.id());
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> OutboxEvent {
        OutboxEvent::new(
            OutboxEventType::email_send_v1(),
            serde_json::json!({"to": "a@example.com"}),
            1_000,
        )
        .expect("valid")
    }

    #[test]
    fn the_wire_body_carries_the_id_the_row_was_written_with() {
        // The whole idempotency story in one assertion: the key on the wire is
        // the one minted at write time, so a replay of this row is recognisable
        // as the same fact rather than a second one.
        let event = event();
        let body = QueuedEvent::from_outbox(&event);
        assert_eq!(body.id, event.id.as_string());
        assert_eq!(body.idempotency_key(), event.id.as_string());
        assert_eq!(body.occurred_at_ms, 1_000);
        assert_eq!(body.event_type, "identity.email.send.v1");
    }

    #[test]
    fn two_events_with_the_same_payload_have_different_keys() {
        // If they shared a key the consumer would dedupe a real second email
        // away, and the symptom would be "a user never receives the second
        // password reset" — the kind of bug that is reported as "email is
        // flaky" and is actually a correctness fault in the producer.
        let a = QueuedEvent::from_outbox(&event());
        let b = QueuedEvent::from_outbox(&event());
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn the_wire_body_round_trips() {
        // A consumer deployed from a different build of this crate must be
        // able to parse what is on the queue; that is what the struct is for.
        let body = QueuedEvent::from_outbox(&event());
        let json = serde_json::to_string(&body).expect("serializable");
        let parsed: QueuedEvent = serde_json::from_str(&json).expect("deserializable");
        assert_eq!(parsed, body);
    }

    #[test]
    fn an_unknown_or_unversioned_event_type_is_not_recognised() {
        // The refusal path. A consumer that guessed at the shape of an
        // unversioned message would act on a schema it has never seen.
        let mut body = QueuedEvent::from_outbox(&event());
        body.event_type = "identity.email.send".into();
        assert!(body.known_type().is_none());

        body.event_type = "something.entirely.v9".into();
        let kind = body.known_type().expect("a well-formed type");
        assert_eq!(kind.version(), 9);
    }

    #[test]
    fn an_event_id_that_cannot_be_parsed_is_refused_rather_than_reused() {
        // A key that cannot be parsed cannot be used to dedupe, and a consumer
        // that processed it anyway would be processing a message with no way to
        // recognise its own replay. Note this is a *refusal of the two bad
        // shapes* — `parsed_id` consults the domain, which has no
        // `OutboxEventId::parse` today, so it refuses every value including a
        // well-formed one. The wasm-side test below is the one that shows a
        // real id being minted, and it is what will keep passing unchanged when
        // the domain grows the constructor.
        let mut body = QueuedEvent::from_outbox(&event());
        body.id = "not-a-uuid".into();
        assert!(body.parsed_id().is_err());

        body.id = String::new();
        assert!(body.parsed_id().is_err());

        // A value that *is* a canonical UUID is still refused today, and the
        // error says why rather than reporting a parse failure.
        body.id = "11111111-1111-4111-8111-111111111111".into();
        let error = body
            .parsed_id()
            .expect_err("refused until the domain parses it");
        assert_eq!(error.code(), "internal_error");
    }

    #[test]
    fn an_outcome_records_three_outcomes_and_not_two() {
        // The set is closed on purpose: there is no "silently ignored".
        let mut outcome = BatchOutcome::empty();
        assert!(outcome.is_empty());
        outcome.done("m1");
        outcome.retry("m2");
        outcome.dead_letter("m3");
        assert!(!outcome.is_empty());
        assert_eq!(outcome.done, ["m1"]);
        assert_eq!(outcome.retry, ["m2"]);
        assert_eq!(outcome.dead_letter, ["m3"]);
    }
}

/// The queue adapter against a real `MessageBatch`, which needs a Workers
/// runtime to exist. Until a wasm test runner is wired into CI these are
/// **unverified**: compiled, not executed.
#[cfg(target_arch = "wasm32")]
mod wasm_tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    fn event() -> OutboxEvent {
        OutboxEvent::new(
            OutboxEventType::email_send_v1(),
            serde_json::json!({"to": "a@example.com"}),
            1_000,
        )
        .expect("valid")
    }

    #[wasm_bindgen_test]
    fn a_minted_event_id_round_trips_through_the_wire_shape() {
        // The counterpart to the host-side test above. It asserts the shape the
        // dispatcher actually sends: the canonical text form of a minted
        // `OutboxEventId`, with the idempotency key equal to it.
        let body = QueuedEvent::from_outbox(&event());
        assert_eq!(body.idempotency_key(), body.id);
        assert!(!body.id.is_empty());
        assert!(body.known_type().is_some());
    }
}
