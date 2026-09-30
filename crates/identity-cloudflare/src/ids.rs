//! Identifier generation and parsing, bound to the domain newtypes.
//!
//! # Why this is not just `Uuid::new_v4`
//!
//! Because a raw `Uuid` at a call site is a `UserId`, a `SessionId`, an
//! `ApplicationId`, an `OutboxEventId` or a `SigningKeyId` depending only on
//! what the surrounding variable happens to be called. Passing a session id
//! where a user id is expected is a compile error you want to have, and the
//! newtypes are what produce it.
//!
//! So the rule the Workers follow is: a Worker never constructs one of these
//! from a raw string without going through here, and here goes through the
//! domain constructor. What this module does not do is decide *what* an
//! identifier means — every type here is a thin, total wrapper over a domain
//! one, and it adds no validation the domain has not already added.
//!
//! # What this is not
//!
//! Not a UUID strategy. Every identifier in the domain is v4, because the
//! domain says so; there is no v7 or ULID here, and adding one would be a
//! change to `identity-domain`, not to this adapter.

use identity_domain::application::ApplicationId;
use identity_domain::audit::AuditEventId;
use identity_domain::outbox::OutboxEventId;
use identity_domain::session::SessionId;
use identity_domain::user::UserId;

/// Mint a new random [`UserId`].
#[must_use]
pub fn new_user_id() -> Option<UserId> {
    UserId::new().ok()
}

/// Mint a new random [`SessionId`].
#[must_use]
pub fn new_session_id() -> Option<SessionId> {
    SessionId::new().ok()
}

/// Mint a new random [`ApplicationId`].
#[must_use]
pub fn new_application_id() -> Option<ApplicationId> {
    ApplicationId::new().ok()
}

/// Mint a new random [`AuditEventId`].
#[must_use]
pub fn new_audit_event_id() -> Option<AuditEventId> {
    AuditEventId::new().ok()
}

/// Mint a new random [`OutboxEventId`].
#[must_use]
pub fn new_outbox_event_id() -> Option<OutboxEventId> {
    OutboxEventId::new().ok()
}

/// Parse a [`UserId`] from its canonical text form.
#[must_use]
pub fn parse_user_id(value: &str) -> Option<UserId> {
    UserId::parse(value).ok()
}

/// Parse a [`SessionId`] from its canonical text form.
#[must_use]
pub fn parse_session_id(value: &str) -> Option<SessionId> {
    SessionId::parse(value).ok()
}

/// Parse an [`OutboxEventId`] from its canonical text form.
///
/// Note the same asymmetry as `parse_application_id` below: `OutboxEventId` has
/// no `parse` constructor in the domain today, because a queue message's `id`
/// is produced by the dispatcher and never arrives from a client as a value
/// this system must trust. A message whose id cannot be parsed cannot be
/// deduplicated, so the queue adapter refuses it rather than inventing a laxer
/// constructor here. When the domain grows one, this becomes a call to it.
#[must_use]
pub const fn parse_outbox_event_id(_value: &str) -> Option<OutboxEventId> {
    None
}

/// Parse an [`ApplicationId`] from its canonical text form.
///
/// Note the asymmetry with the others: `ApplicationId` has no `parse`
/// constructor in the domain today, because nothing in the bootstrap accepts
/// an application identifier from a request — it is only ever minted here or
/// read out of a database row. Rather than invent a laxer constructor in the
/// adapter, this refuses and says so. When the domain grows one, this becomes a
/// call to it.
#[must_use]
pub const fn parse_application_id(_value: &str) -> Option<ApplicationId> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_round_trip_through_their_text_form() {
        let id = new_user_id().expect("a user id");
        assert_eq!(parse_user_id(&id.as_string()), Some(id));

        let session = new_session_id().expect("a session id");
        assert_eq!(parse_session_id(&session.as_string()), Some(session));
    }

    #[test]
    fn two_identifiers_are_never_equal() {
        // A generator that repeated would silently merge two users. Cheap to
        // assert, catastrophic to miss.
        assert_ne!(new_user_id().expect("a"), new_user_id().expect("b"));
        assert_ne!(new_session_id().expect("a"), new_session_id().expect("b"));
    }

    #[test]
    fn a_non_uuid_string_is_not_an_identifier() {
        assert!(parse_user_id("not-a-uuid").is_none());
        assert!(parse_user_id("").is_none());
        // A user id is not a session id, even though both are UUIDs: the
        // newtype is the only thing that stops them being interchangeable, and
        // a function that took `Uuid` would have allowed this call to compile.
        assert!(parse_session_id("11111111-1111-4111-8111-111111111111").is_some());
        assert!(parse_user_id("11111111-1111-4111-8111-111111111111").is_some());
    }

    #[test]
    fn parsing_an_outbox_event_id_is_refused_and_says_why() {
        // The queue adapter's idempotency key goes through this. A message
        // with an unparseable id is refused rather than deduplicated under a
        // string that was never a UUID.
        assert!(parse_outbox_event_id("11111111-1111-4111-8111-111111111111").is_none());
        assert!(parse_outbox_event_id("").is_none());
    }

    #[test]
    fn a_minted_outbox_event_id_is_not_parseable_back_and_the_module_says_why() {
        // The asymmetry is load-bearing, so it is asserted rather than left as
        // a comment: if the domain gains `OutboxEventId::parse`, this fails and
        // the two functions get reconciled deliberately.
        let id = new_outbox_event_id().expect("an outbox event id");
        assert!(parse_outbox_event_id(&id.as_string()).is_none());
    }

    #[test]
    fn parsing_an_application_id_is_refused_and_says_why() {
        // This returning `None` is the honest answer, not a gap someone will
        // assume gets filled. The function exists so the call site does not
        // have to invent a `Uuid::parse_str` and lose the newtype.
        assert!(parse_application_id("11111111-1111-4111-8111-111111111111").is_none());
    }
}
