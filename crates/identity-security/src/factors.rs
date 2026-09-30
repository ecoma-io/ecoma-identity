//! Factor gates: OTP, TOTP, passkey, recovery codes.

use serde::{Deserialize, Serialize};

use crate::error::{SecurityError, SecurityResult};

/// Where a one-time code was sent.
///
/// A destination is not a free-text string: it names a *transport* and an
/// *address*, because the rate limit, the audit record and the "do not send to
/// an unverified address" check all key on the pair. A single `String` would
/// make `sms:+1555…` and an unverifiable pair ambiguous at the call site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "via", content = "address", rename_all = "snake_case")]
pub enum DeliveryDestination {
    /// Delivered to an email address.
    Email(String),
    /// Delivered to a phone number, E.164.
    Sms(String),
}

/// A one-time code to deliver.
///
/// The code itself is deliberately **not** a field of anything that gets
/// logged. A delivered code is a live credential, and the types here carry the
/// challenge's identity and its destination — enough to verify a response
/// against storage, and nothing that should ever reach a log line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OtpChallenge {
    /// The challenge's identifier. This is what a verification request names;
    /// the code is never echoed back into a request that could be logged.
    pub challenge_id: String,
    /// Where it was sent.
    pub destination: DeliveryDestination,
    /// How long it stays valid, in seconds.
    pub ttl_seconds: u32,
    /// How many verification attempts remain before the challenge is dead.
    /// Every attempt decrements it, whether or not the code was right, so a
    /// six-digit code cannot be found by guessing inside its window.
    pub attempts_remaining: u32,
}

/// The length of an emailed code, in digits.
pub const OTP_LENGTH: u32 = 6;

/// The gate for delivered one-time codes.
///
/// # Security
///
/// Implementations must compare the presented code in constant time, must
/// decrement `attempts_remaining` on **every** attempt, and must fail closed
/// when the rate limiter is unavailable.
pub trait OtpService {
    /// Issue a code for a destination and arrange for its delivery.
    ///
    /// # Errors
    ///
    /// [`SecurityError::RateLimiterUnavailable`] when the limiter is down —
    /// and it must fail rather than proceed. [`SecurityError::MissingSecret`]
    /// when the mail transport is not configured. A delivery failure is an
    /// error even when the address is unknown, so the caller cannot tell an
    /// unknown address from a failed send by whether it got an `Err`.
    fn issue(&self, destination: &DeliveryDestination) -> SecurityResult<OtpChallenge>;

    /// Verify a code against a challenge.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] for a wrong code,
    /// [`SecurityError::Expired`] for a stale one,
    /// [`SecurityError::AlreadyRedeemed`] for a reuse, and
    /// [`SecurityError::ChallengeMismatch`] for an unknown challenge. Each
    /// decrements the attempt budget.
    fn verify(&self, challenge_id: &str, code: &str) -> SecurityResult<()>;

    /// Invalidate a challenge without redeeming it.
    ///
    /// # Errors
    ///
    /// [`SecurityError::ChallengeMismatch`] for an unknown challenge.
    fn revoke(&self, challenge_id: &str) -> SecurityResult<()>;
}

/// A shared secret for time-based one-time passwords.
///
/// The `Debug` and `Display` impls are redacted by hand. This type's whole
/// purpose is to hold a secret, and a derived `Debug` printing it is how a TOTP
/// seed ends up in a log line, a panic message and a Sentry event in one
/// afternoon.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TotpSecret(String);

impl TotpSecret {
    /// The number of bytes of entropy a TOTP secret must carry.
    ///
    /// RFC 4226 recommends 160 bits, which is 20 bytes. 30 characters of
    /// unpadded base32 is exactly 150 bits and is the most a phone
    /// authenticator app reliably accepts.
    pub const MIN_SECRET_CHARS: usize = 30;

    /// Adopt a base32 secret.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the value is shorter than
    /// [`TotpSecret::MIN_SECRET_CHARS`] or contains a character outside the
    /// RFC 4648 base32 alphabet. A short seed is the one mistake here that is
    /// silently weak: a 6-character seed is a million possibilities, and a
    /// stolen database of them falls to a GPU in seconds.
    pub fn new(base32: impl Into<String>) -> SecurityResult<Self> {
        let value = base32.into();
        if value.len() < Self::MIN_SECRET_CHARS {
            return Err(SecurityError::Cryptographic {
                reason: format!(
                    "TOTP secret must be at least {} base32 characters",
                    Self::MIN_SECRET_CHARS
                ),
            });
        }
        if !value
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '=')
        {
            return Err(SecurityError::Cryptographic {
                reason: "TOTP secret must be base32".to_string(),
            });
        }
        Ok(Self(value))
    }

    /// Borrow the secret for the verifier.
    ///
    /// Named for the narrowest caller: an enrolment flow generating a code, or
    /// a verification comparing one. Nothing else needs it, and a method with
    /// a narrow name is easier to notice being called from a wide place.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn expose_for_verification(&self) -> &str {
        &self.0
    }
}

/// Redacted by hand, deliberately. See the type documentation.
impl core::fmt::Debug for TotpSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("TotpSecret(<redacted>)")
    }
}

/// Redacted by hand, deliberately. See the type documentation.
impl core::fmt::Display for TotpSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// The digits and time step a TOTP verification must check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TotpParameters {
    /// The time step, in seconds. 30 is the RFC 6238 default and the one
    /// every mainstream authenticator app assumes.
    pub period_seconds: u32,
    /// How many steps either side of now to accept, to absorb clock skew.
    ///
    /// A larger window is a weaker factor: a window of 5 would accept a code
    /// from ±2½ minutes, which is a code an attacker who observed one email or
    /// screen share could reuse long after the user logged in.
    pub window: u32,
    /// The number of digits in a code.
    pub digits: u32,
}

impl Default for TotpParameters {
    fn default() -> Self {
        Self {
            period_seconds: 30,
            window: 1,
            digits: 6,
        }
    }
}

/// A TOTP code, to deliver or to expect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TotpCode(String);

impl TotpCode {
    /// The code a user typed.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] when the value is not exactly
    /// [`TotpParameters::digits`] ASCII digits. Normalising here rather than in
    /// the verifier means a user who types a space gets a clear refusal
    /// instead of a silent mismatch.
    pub fn parse(typed: &str, digits: u32) -> SecurityResult<Self> {
        let trimmed = typed.trim();
        if trimmed.len() != digits as usize || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
            return Err(SecurityError::VerificationFailed);
        }
        Ok(Self(trimmed.to_string()))
    }
}

/// The gate for time-based one-time passwords.
///
/// # Security
///
/// Implementations must use a maintained RFC 6238 library and must compare in
/// constant time. The rewind window must be [`TotpParameters::window`], and
/// implementations must not widen it for a "user complained" support ticket —
/// a widened window is a silent AAL2 downgrade.
pub trait TotpService {
    /// Generate a fresh enrolment secret and the provisioning URI.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if a secure random source is
    /// unavailable. It must **not** fall back to a weaker source.
    fn generate_enrolment(
        &self,
        account_label: &str,
        issuer: &str,
    ) -> SecurityResult<(TotpSecret, String)>;

    /// Produce the code for a secret at the current time.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] on failure.
    fn current_code(&self, secret: &TotpSecret) -> SecurityResult<TotpCode>;

    /// Verify a code against a secret.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] for a wrong code, within or
    /// outside the window. Deliberately one outcome: a caller that could tell
    /// "right code, wrong step" from "wrong code" could use the difference to
    /// learn which codes were ever valid.
    fn verify(&self, secret: &TotpSecret, code: &TotpCode) -> SecurityResult<()>;
}

/// A `WebAuthn` challenge to issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasskeyChallenge {
    /// The challenge's identifier.
    pub challenge_id: String,
    /// The challenge bytes, base64url without padding. Generated by the
    /// implementation, never by the caller — a caller-chosen challenge is a
    /// caller-chosen nonce.
    pub challenge: String,
    /// Which user handle the credential must be scoped to, for
    /// discoverable-credential sign-in.
    pub rp_id: String,
    /// How long the challenge stays valid, in seconds.
    pub ttl_seconds: u32,
}

/// The gate for `WebAuthn` passkeys.
///
/// # Security
///
/// Implementations must delegate to a maintained `WebAuthn` verifier
/// (`webauthn-rs` or equivalent). The origin check, the RP ID hash, the
/// signature and the user-presence flag are all that verifier's job; this
/// repository does not implement any of them, and must not.
pub trait PasskeyService {
    /// Issue a challenge for a registration ceremony.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if a secure random source is
    /// unavailable.
    fn registration_challenge(
        &self,
        user_id: &identity_domain::user::UserId,
        rp_id: &str,
    ) -> SecurityResult<PasskeyChallenge>;

    /// Issue a challenge for an authentication ceremony.
    ///
    /// # Errors
    ///
    /// As [`PasskeyService::registration_challenge`].
    fn authentication_challenge(&self, rp_id: &str) -> SecurityResult<PasskeyChallenge>;

    /// Complete a registration ceremony, storing the credential.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] for a malformed or unverifiable
    /// attestation, and [`SecurityError::ChallengeMismatch`] for an unknown or
    /// consumed challenge. A challenge must be consumed by a *failed*
    /// ceremony too, or a caller can retry indefinitely against one challenge.
    fn finish_registration(
        &self,
        challenge_id: &str,
        response: &str,
    ) -> SecurityResult<PasskeyCredential>;

    /// Complete an authentication ceremony.
    ///
    /// # Errors
    ///
    /// As [`PasskeyService::finish_registration`], plus
    /// [`SecurityError::TokenRejected`] when the credential is unknown or its
    /// signature does not verify.
    fn finish_authentication(
        &self,
        challenge_id: &str,
        response: &str,
    ) -> SecurityResult<PasskeyAssertion>;
}

/// A stored passkey credential.
///
/// The public key, and nothing private. A stored credential is a public key
/// and a signature counter; the private key never leaves the authenticator, so
/// there is nothing else to store and nothing to leak.
///
/// `deny_unknown_fields` is what enforces the second half of that sentence. By
/// default serde ignores fields it does not recognise, so a payload carrying
/// `private_key` would deserialise into a credential that looks fine and holds
/// nothing private — and the row that got stored would differ from the body
/// that was sent, which is its own class of bug. Refusing is louder and
/// safer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasskeyCredential {
    /// The credential identifier.
    pub credential_id: String,
    /// The COSE public key, base64url without padding.
    pub public_key: String,
    /// The stored signature counter. `0` when the authenticator does not
    /// implement counters — which is common, and must not be treated as a
    /// cloned credential.
    pub sign_count: u32,
}

/// A completed assertion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasskeyAssertion {
    /// The credential that signed.
    pub credential_id: String,
    /// The new signature counter.
    pub sign_count: u32,
    /// Whether the authenticator signalled user presence.
    pub user_present: bool,
    /// Whether the authenticator signalled user verification — a biometric or
    /// PIN check. Absent `user_verification` with a passkey still satisfies
    /// AAL2 under `WebAuthn`, because the credential is phishing-resistant; this
    /// flag is reported for the audit trail, not to decide the AAL.
    pub user_verified: bool,
}

/// A batch of single-use recovery codes.
///
/// `Debug` is redacted by hand for the same reason as [`TotpSecret`]: an
/// unused recovery code is a live credential that bypasses every other factor.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecoveryCodeBatch(Vec<String>);

impl RecoveryCodeBatch {
    /// How many codes a batch contains. Ten is the number a human can
    /// plausibly store; twenty is the number nobody can, and a code set that
    /// cannot be stored is a code set that gets written on a monitor.
    pub const BATCH_SIZE: usize = 10;

    /// Wrap a batch of codes.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] when the batch is empty. An empty
    /// batch is a bug in the generator, and accepting it would report success
    /// to a user who has no way back into their account.
    pub fn new(codes: Vec<String>) -> SecurityResult<Self> {
        if codes.is_empty() {
            return Err(SecurityError::Cryptographic {
                reason: "recovery code batch must not be empty".to_string(),
            });
        }
        Ok(Self(codes))
    }

    /// How many codes remain unused in the batch.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the batch is empty. Always false for a batch that exists.
    ///
    /// # Errors
    ///
    /// None.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Redacted by hand, deliberately. See the type documentation.
impl core::fmt::Debug for RecoveryCodeBatch {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "RecoveryCodeBatch({} codes, <redacted>)", self.0.len())
    }
}

/// The gate for single-use recovery codes.
///
/// # Security
///
/// Codes are stored hashed, compared in constant time, and consumed on use.
/// A code that verifies twice is a permanent bypass, so consumption must be
/// part of the same atomic step as the verification — the same discipline the
/// outbox gives the event write.
pub trait RecoveryCodeService {
    /// Generate a fresh batch for a user, invalidating any previous batch.
    ///
    /// # Errors
    ///
    /// [`SecurityError::Cryptographic`] if a secure random source is
    /// unavailable.
    fn generate(
        &self,
        user_id: &identity_domain::user::UserId,
    ) -> SecurityResult<RecoveryCodeBatch>;

    /// Redeem one code, consuming it.
    ///
    /// # Errors
    ///
    /// [`SecurityError::VerificationFailed`] for a wrong code,
    /// [`SecurityError::AlreadyRedeemed`] for one that was spent, and
    /// [`SecurityError::InsufficientAssurance`] when redeeming a code must
    /// itself be an AAL2 operation.
    fn redeem(&self, user_id: &identity_domain::user::UserId, code: &str) -> SecurityResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_totp_secret_never_prints_itself() {
        // The one assertion that matters most in this module. A derived
        // Debug on a secret type is the single most common way a TOTP seed
        // reaches a log, and it is invisible until someone reads the log.
        let secret = TotpSecret::new("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP").expect("valid");
        assert_eq!(format!("{secret:?}"), "TotpSecret(<redacted>)");
        assert_eq!(format!("{secret}"), "<redacted>");
        assert!(!format!("{secret:?}").contains("JBSWY3DPEHPK3PXP"));
    }

    #[test]
    fn an_unused_recovery_code_batch_never_prints_itself() {
        let batch =
            RecoveryCodeBatch::new(vec!["AAAA-BBBB".into(), "CCCC-DDDD".into()]).expect("valid");
        let debug = format!("{batch:?}");
        assert!(debug.contains("2 codes"), "{debug}");
        assert!(!debug.contains("AAAA"), "{debug}");
    }

    #[test]
    fn a_short_totp_secret_is_refused() {
        // 150 bits is the floor. A shorter seed is silently brute-forceable
        // from a leaked database, and nothing else in the system would notice.
        assert!(TotpSecret::new("JBSWY3DPEHPK3PXP").is_err());
        assert!(TotpSecret::new("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP").is_ok());
    }

    #[test]
    fn a_non_base32_secret_is_refused() {
        assert!(TotpSecret::new("jbswy3dpehpk3pxpjbswy3dpehpk3pxp").is_err());
        assert!(TotpSecret::new("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!").is_err());
    }

    #[test]
    fn a_totp_code_must_be_exactly_the_right_digits() {
        assert!(TotpCode::parse("123456", 6).is_ok());
        assert!(TotpCode::parse("12345", 6).is_err());
        assert!(TotpCode::parse("1234567", 6).is_err());
        assert!(TotpCode::parse("12345a", 6).is_err());
        assert!(
            TotpCode::parse(" 123456 ", 6).is_ok(),
            "whitespace is trimmed"
        );
    }

    #[test]
    fn the_default_totp_window_is_one_step() {
        // A window of 1 accepts ±30s. Anything larger turns a phished or
        // shoulder-surfed code into a reusable one, and the failure is
        // invisible to the user.
        let p = TotpParameters::default();
        assert_eq!(p.period_seconds, 30);
        assert_eq!(p.window, 1);
        assert_eq!(p.digits, 6);
    }

    #[test]
    fn an_empty_recovery_batch_is_refused() {
        assert!(RecoveryCodeBatch::new(vec![]).is_err());
    }

    #[test]
    fn a_stored_credential_holds_no_private_key() {
        // A WebAuthn credential in our database is a public key. If a future
        // field were added for a private key, this fails.
        //
        // The forbidden names are checked against the *keys* of the serialized
        // object, not against the whole JSON text. A substring search over the
        // text would match `"cred"` — the `d` is simply the last character of a
        // perfectly ordinary credential id — and this test would fail for a
        // reason that has nothing to do with private keys, which is a test
        // people delete rather than fix.
        let credential = PasskeyCredential {
            credential_id: "cred".into(),
            public_key: "pk".into(),
            sign_count: 0,
        };
        let value = serde_json::to_value(&credential).expect("serializable");
        let fields: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();

        assert_eq!(fields, ["credential_id", "public_key", "sign_count"]);
        for forbidden in ["private", "d", "prf", "attestation_secret", "client_data"] {
            assert!(
                !fields.contains(&forbidden),
                "{forbidden} is a field of a stored credential"
            );
        }
        // And back the other way: a payload carrying a private key must not
        // deserialise into a credential, rather than dropping the field and
        // storing a credential that cannot verify anything.
        assert!(
            serde_json::from_value::<PasskeyCredential>(serde_json::json!({
                "credential_id": "cred",
                "public_key": "pk",
                "sign_count": 0,
                "private_key": "leaked",
            }))
            .is_err(),
            "a credential body carrying a private key must be refused"
        );
    }

    #[test]
    fn a_destination_names_its_transport() {
        // `sms:` and an email address are different transports with different
        // rate limits and different log redaction. One String would conflate
        // them at every call site.
        let d = DeliveryDestination::Email("ada@example.com".into());
        let json = serde_json::to_string(&d).expect("serializable");
        assert!(json.contains("\"via\":\"email\""), "{json}");
    }
}
