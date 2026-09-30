//! Email addresses.
//!
//! An address is modelled, not merely stored, because "is this a deliverable
//! address" is a decision with security consequences — and because the
//! validation here is *structural only*. Deliverability is a question for the
//! email provider (deferred in bootstrap), and syntax validity is not proof
//! that a mailbox exists. The type says exactly as much as it knows.

use serde::{Deserialize, Serialize};

use crate::error::{DomainError, DomainResult};

/// A syntactically valid email address.
///
/// The validation is deliberately conservative and deliberately incomplete:
/// it rejects the shapes that cannot be an address, and accepts anything that
/// could be. It is not RFC 5322 and does not pretend to be. What it refuses is
/// worth refusing — a control character, a missing or repeated `@`, a domain
/// with no dot, an address over 320 bytes — because those are all things a
/// caller gets wrong in ways that matter.
///
/// A `Verified` flag does not live here. Verification is a fact about *when*
/// a proof was presented, and it belongs to the row that stores the address,
/// not to the address itself.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct EmailAddress(String);

impl EmailAddress {
    /// The maximum length of a full address, in bytes.
    ///
    /// 320 is the RFC 5321 path limit. It is a hard ceiling because a column
    /// that can hold it must also hold it.
    pub const MAX_LEN: usize = 320;

    /// The maximum length of the local part, in bytes (RFC 5321).
    pub const MAX_LOCAL_LEN: usize = 64;

    /// The maximum length of the domain, in bytes (RFC 5321).
    pub const MAX_DOMAIN_LEN: usize = 255;

    /// Validate an address.
    ///
    /// # Errors
    ///
    /// [`DomainError::Invalid`] when the address is not structurally an email
    /// address: see the type documentation for the exact list.
    pub fn parse(value: &str) -> DomainResult<Self> {
        if value.is_empty() {
            return Err(DomainError::invalid("email", "must not be empty"));
        }
        if value.len() > Self::MAX_LEN {
            return Err(DomainError::invalid(
                "email",
                format!("must be at most {} bytes", Self::MAX_LEN),
            ));
        }
        if value.trim() != value {
            return Err(DomainError::invalid(
                "email",
                "must not have leading or trailing whitespace",
            ));
        }
        if value.chars().any(char::is_control) {
            return Err(DomainError::invalid(
                "email",
                "must not contain control characters",
            ));
        }

        let mut parts = value.split('@');
        let local = parts.next().unwrap_or_default();
        let domain = parts.next().ok_or_else(|| {
            DomainError::invalid("email", "must contain exactly one `@`")
        })?;
        if parts.next().is_some() {
            return Err(DomainError::invalid(
                "email",
                "must contain exactly one `@`",
            ));
        }

        if local.is_empty() {
            return Err(DomainError::invalid("email", "local part is empty"));
        }
        // Whitespace anywhere in the address, not just at the edges. A local
        // part containing a space is a mistyped address that some providers
        // accept and others silently truncate — the disagreement is exactly
        // the account-takeover shape (`victim@example.com` and
        // `victim @example.com` becoming the same account at one provider and
        // different accounts at another).
        if local.chars().any(char::is_whitespace) {
            return Err(DomainError::invalid(
                "email",
                "local part must not contain whitespace",
            ));
        }
        if local.len() > Self::MAX_LOCAL_LEN {
            return Err(DomainError::invalid(
                "email",
                format!("local part must be at most {} bytes", Self::MAX_LOCAL_LEN),
            ));
        }
        if domain.is_empty() {
            return Err(DomainError::invalid("email", "domain is empty"));
        }
        if domain.len() > Self::MAX_DOMAIN_LEN {
            return Err(DomainError::invalid(
                "email",
                format!("domain must be at most {} bytes", Self::MAX_DOMAIN_LEN),
            ));
        }
        if !domain.contains('.') {
            return Err(DomainError::invalid(
                "email",
                "domain must contain at least one `.`",
            ));
        }
        if domain.starts_with('.') || domain.ends_with('.') {
            return Err(DomainError::invalid(
                "email",
                "domain must not start or end with `.`",
            ));
        }
        if domain.contains("..") {
            return Err(DomainError::invalid(
                "email",
                "domain must not contain an empty label",
            ));
        }
        if local.starts_with('.') || local.ends_with('.') {
            return Err(DomainError::invalid(
                "email",
                "local part must not start or end with `.`",
            ));
        }
        if local.contains("..") {
            return Err(DomainError::invalid(
                "email",
                "local part must not contain consecutive `.`",
            ));
        }
        if !domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err(DomainError::invalid(
                "email",
                "domain may contain only letters, digits, `.` and `-`",
            ));
        }

        Ok(Self(value.to_ascii_lowercase()))
    }

    /// Borrow the address as a string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The domain part.
    ///
    /// # Errors
    ///
    /// None. A constructed `EmailAddress` always has a domain, because
    /// `parse` proved it does. This returns `Option` only because `&str`
    /// splitting is a total operation; the invariant makes the `None` arm
    /// unreachable, and `expect` names why.
    ///
    /// # Panics
    ///
    /// Never for any value reachable through the public API — `parse` and
    /// `Deserialize` both refuse an address with no `@`. Reaching the `expect`
    /// requires a value that did not come from a constructor at all, which is
    /// undefined behaviour before this function ever runs.
    #[must_use]
    pub fn domain(&self) -> &str {
        self.0
            .split_once('@')
            .map(|(_, domain)| domain)
            .expect("EmailAddress::parse guarantees a domain part")
    }

    /// The local part.
    ///
    /// # Errors
    ///
    /// None, for the same reason as [`EmailAddress::domain`].
    ///
    /// # Panics
    ///
    /// Never, for the same reason as [`EmailAddress::domain`].
    #[must_use]
    pub fn local_part(&self) -> &str {
        self.0
            .split_once('@')
            .map(|(local, _)| local)
            .expect("EmailAddress::parse guarantees a local part")
    }
}

impl core::fmt::Display for EmailAddress {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for EmailAddress {
    type Error = DomainError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<EmailAddress> for String {
    fn from(value: EmailAddress) -> Self {
        value.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_addresses_are_accepted_and_lowercased() {
        let e = EmailAddress::parse("Ada.Lovelace@Example.COM").expect("valid");
        assert_eq!(e.as_str(), "ada.lovelace@example.com");
        assert_eq!(e.local_part(), "ada.lovelace");
        assert_eq!(e.domain(), "example.com");
    }

    #[test]
    fn a_dotted_local_part_is_accepted() {
        // Not a real deliverable address, but a legal one. The type is
        // structural; refusing it would be claiming knowledge it does not have.
        assert!(EmailAddress::parse("a.b.c@sub.example.co.uk").is_ok());
    }

    #[test]
    fn structurally_impossible_addresses_are_refused() {
        for bad in [
            "",
            "no-at-sign",
            "@example.com",
            "ada@",
            "ada@@example.com",
            "ada@example.com@evil.com",
            "ada@nodot",
            "ada@.example.com",
            "ada@example.com.",
            "ada@exa..mple.com",
            ".ada@example.com",
            "ada.@example.com",
            "ada.lovelace @example.com",
            "ada\n@example.com",
        ] {
            assert!(
                EmailAddress::parse(bad).is_err(),
                "{bad:?} must be refused as an email address"
            );
        }
    }

    #[test]
    fn an_over_long_address_is_refused_rather_than_truncated() {
        let local = "a".repeat(EmailAddress::MAX_LOCAL_LEN + 1);
        let long = format!("{local}@example.com");
        assert!(EmailAddress::parse(&long).is_err());
    }

    #[test]
    fn domain_case_folding_does_not_change_the_local_part_beyond_case() {
        // Lowercasing the whole address is a deliberate simplification: the
        // local part is *technically* case-sensitive, but treating it as
        // case-insensitive is what every mainstream provider does, and the
        // alternative invites two accounts differing only in local-part case.
        let a = EmailAddress::parse("Ada@Example.com").expect("valid");
        assert_eq!(a.as_str(), "ada@example.com");
    }

    #[test]
    fn a_hyphenated_domain_is_accepted() {
        assert!(EmailAddress::parse("ada@my-org.example.com").is_ok());
    }

    #[test]
    fn serde_round_trips_through_the_validating_representation() {
        let e = EmailAddress::parse("ada@example.com").expect("valid");
        let json = serde_json::to_string(&e).expect("serializable");
        assert_eq!(json, "\"ada@example.com\"");
        let back: EmailAddress = serde_json::from_str(&json).expect("valid");
        assert_eq!(back, e);
        // Deserialising an invalid address is an error, not a stored bad value.
        assert!(serde_json::from_str::<EmailAddress>("\"nonsense\"").is_err());
    }
}
