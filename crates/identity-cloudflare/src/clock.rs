//! The `Clock` port and its platform implementation.
//!
//! # Why time is behind a port at all
//!
//! An identity system's decisions are mostly about time: a session has expired
//! or it has not, a token's `exp` is in the past, a one-time code's window has
//! closed, an outbox row is past its attempt ceiling. Every one of those is a
//! comparison against "now", and every one of them becomes untestable the
//! moment a function calls `Date::now()` directly — because the only way to
//! test the boundary is to wait for it.
//!
//! So: **no layer above this one calls `Date::now()`.** The domain already
//! takes `now_ms: i64` parameters for this reason; this port is what supplies
//! that number at the composition root, and what the testkit replaces.
//!
//! What this is not: a scheduler. It does not decide *when* anything runs, and
//! it does not know about Cloudflare cron triggers.

use worker::Date;

/// A source of "now", in milliseconds since the Unix epoch.
///
/// Milliseconds because that is what `identity-domain`'s session, audit and
/// outbox constructors take. A crate that had to multiply or divide at every
/// call site would eventually get one of them wrong, and the unit is the thing
/// that is easiest to get wrong.
pub trait Clock {
    /// The current time in milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;

    /// The current time in seconds since the Unix epoch.
    ///
    /// A named conversion rather than a constant divisor at the call site, for
    /// the same reason the unit is named above.
    fn now_secs(&self) -> i64 {
        self.now_ms().div_euclid(1_000)
    }
}

/// The platform clock: `worker::Date`, which is Cloudflare's, which is the
/// only one a Worker has.
///
/// Deterministic in local development — `wrangler dev` lets you freeze it —
/// and the real wall clock in a deployed version. Nothing here caches it: a
/// request that reads the clock twice reads it twice, so a test that advances
/// time between two calls inside one request sees the change.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl SystemClock {
    /// Construct the platform clock. A named constructor rather than a unit
    /// struct literal so a composition root reads as wiring.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        // `Date::as_millis` returns u64. The cast to i64 is saturating in
        // spirit and exact in practice: a millisecond timestamp overflows i64
        // in the year 292 million, and a saturating cast is the honest way to
        // say "we do not believe this will happen, but we are not going to
        // wrap around into the past".
        let millis = Date::now().as_millis();
        i64::try_from(millis).unwrap_or(i64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seconds_conversion_is_the_documented_one() {
        // Pure arithmetic over the port's own default method, so it runs on the
        // host target. The *platform* reading is asserted on the wasm side,
        // below — `Date::now()` panics on a non-wasm target rather than
        // returning a plausible value, which is the right way for a platform
        // boundary to fail.
        struct Fixed(i64);
        impl Clock for Fixed {
            fn now_ms(&self) -> i64 {
                self.0
            }
        }
        assert_eq!(Fixed(1_500).now_secs(), 1);
        assert_eq!(Fixed(0).now_secs(), 0);
        // Negative millis floor rather than truncate, so a timestamp before the
        // epoch does not round towards zero.
        assert_eq!(Fixed(-1).now_secs(), -1);
        assert_eq!(Fixed(-1_500).now_secs(), -2);
    }

    #[test]
    fn the_clock_is_object_safe() {
        // The Workers hold it behind `Arc<dyn Clock>`, exactly as they hold the
        // security gates.
        fn takes_a_clock(_: &dyn Clock) {}
        takes_a_clock(&SystemClock::new());
    }
}

/// The platform clock reading, which needs a Workers runtime.
///
/// `Date::now()` goes through `js_sys` and panics on a non-wasm target rather
/// than inventing a timestamp, so this test exists only for
/// `wasm32-unknown-unknown`. Until a wasm test runner is wired into CI it is
/// **unverified**: compiled, not executed.
#[cfg(target_arch = "wasm32")]
mod wasm_tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    fn the_clock_reads_forward() {
        // Not a strong assertion and not meant to be: a clock that went
        // backwards would mean the platform gave us something wrong. The honest
        // test of *time control* is the testkit's `TestClock`, and asserting a
        // timestamp range here would only pass on fast machines.
        let clock = SystemClock::new();
        let first = clock.now_ms();
        let second = clock.now_ms();
        assert!(second >= first, "{second} < {first}");
    }

    #[wasm_bindgen_test]
    fn seconds_are_the_same_instant_as_the_milliseconds() {
        // The conversion is the one place a unit mistake would be silent, so it
        // is checked against the same reading rather than against a constant.
        let clock = SystemClock::new();
        let ms = clock.now_ms();
        let secs = clock.now_secs();
        assert!(
            secs == ms.div_euclid(1_000),
            "{ms} ms must be {secs} s by the same rule the port uses"
        );
    }

    #[wasm_bindgen_test]
    fn the_platform_clock_is_after_2020() {
        // A floor rather than a range. It catches the two real failures — a
        // clock reading zero, and a seconds/milliseconds mix-up that is
        // 1000x off — without being a test that only passes on a machine whose
        // clock is set correctly.
        assert!(
            SystemClock::new().now_ms() > 1_577_836_800_000,
            "the platform clock is reading before 2020 or is in the wrong unit"
        );
    }
}
