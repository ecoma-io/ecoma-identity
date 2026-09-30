// Fixture Admin Worker reaching up into a frontend.
//
// VIOLATION (check 4, BOTH halves, in one file on purpose):
//
//   1. The relative import below climbs out of apps/identity-admin/worker/ and
//      lands in apps/identity/web/src/main.ts. Its text never contains the
//      word "web" in a place a grep would trust, and it is a Rust file, so a
//      check that only read manifest dependencies would never see it.
//   2. The string literal names `vue`, a frontend package, with no import to
//      resolve at all.
//
// Either judgement alone would miss half of this. That is the argument for
// running both.
pub fn build_frontend() -> &'static str {
    include_str!("../../../identity/web/src/main.ts")
}

pub const RUNTIME: &str = "vue";
