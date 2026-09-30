//! Audit: writing and reading the record of what happened.
//!
//! The write side is a trait rather than a function because the *transaction*
//! matters more than the call. An audit event must be written in the same D1
//! transaction as the state change it describes; a separate `log_event` call
//! after the fact is a race, and a race here means the trail is incomplete
//! exactly when it is needed.

use identity_domain::audit::AuditEvent;
use identity_domain::user::UserId;
use serde::{Deserialize, Serialize};

use crate::error::ApplicationResult;

/// Write an audit event inside a transaction the caller owns.
///
/// The repository implementation must NOT open or commit its own transaction.
/// It participates in whatever the calling use case is already inside, which
/// is what makes the event and the change it describes atomic. An
/// implementation that commits on its own has silently converted an atomic
/// write into a best-effort one.
pub trait WriteAuditEvent {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Dependency`] if the write fails. The
    /// use case must treat this as fatal to the whole operation: a state
    /// change that succeeded but could not be audited is worse than one that
    /// did not happen, because the system now holds a change nobody can
    /// explain.
    fn write_audit_event(&mut self, event: AuditEvent) -> ApplicationResult<()>;
}

/// Read the audit trail.
pub trait ReadAuditLog {
    /// # Errors
    ///
    /// [`crate::error::ApplicationError::Dependency`] if the read fails.
    fn read_audit_for_user(
        &self,
        user_id: UserId,
        limit: u32,
        offset: u32,
    ) -> ApplicationResult<Vec<AuditEvent>>;
}

/// The outcome of a use case, for the audit record it must write.
///
/// A command that changes something returns this alongside its own result, so
/// the audit write cannot be forgotten: the command has to decide what to
/// return, and returning nothing audit-shaped is then a visible omission
/// rather than an invisible one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Audited<T> {
    /// The command's result.
    pub value: T,
    /// The event to write, in the same transaction as `value`.
    pub event: AuditEvent,
}

impl<T> Audited<T> {
    /// Pair a result with its audit event.
    ///
    /// # Errors
    ///
    /// None. Construction is infallible; the *write* is what can fail, and it
    /// happens in the use case, not here.
    pub fn new(value: T, event: AuditEvent) -> Self {
        Self { value, event }
    }

    /// Discard the result, keeping the event.
    ///
    /// For commands whose result is `()` and which would otherwise be tempted
    /// to drop the event along with it.
    ///
    /// # Errors
    ///
    /// None.
    pub fn into_event(self) -> AuditEvent {
        self.event
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use identity_domain::audit::AuditEventType;

    #[test]
    fn an_audited_result_carries_both_halves() {
        let event = AuditEvent::new(AuditEventType::UserSuspended, 1_000).expect("valid");
        let audited = Audited::new(42_u8, event.clone());
        assert_eq!(audited.value, 42);
        assert_eq!(audited.event, event);
        assert_eq!(audited.into_event(), event);
    }
}
