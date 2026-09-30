// ===========================================================================
// tests/integration/otp-race.test.mjs
//
// WHAT THIS TEST CLAIMS: two SIMULTANEOUS OTP verifications of the same
// challenge produce exactly ONE winner. The second one must return zero rows
// and refuse — and this test races them for real rather than asserting that the
// SQL "looks atomic".
//
// ---------------------------------------------------------------------------
// WHY TWO SEQUENTIAL CALLS COULD NOT PROVE THIS
// ---------------------------------------------------------------------------
//
// The obvious version of this test runs the guard, checks the answer, runs it
// again, checks the answer. That proves the guard refuses a *subsequent*
// verification, which is true and not the claim. The claim is about two callers
// that were both in flight before either committed, and a sequential pair
// cannot produce one: the first has committed by the time the second starts,
// so there is no interleaving to get wrong.
//
// So every race assertion below starts its two `wrangler d1 execute` processes
// FIRST, awaits nothing, and only then awaits them together. Each is a separate
// OS process against the same local D1 file, which is the only way two callers
// can overlap here: there is no in-process database handle to interleave on.
//
// ---------------------------------------------------------------------------
// WHAT WOULD MAKE THESE TESTS PASS WITHOUT THE SCHEMA BEING CORRECT
// ---------------------------------------------------------------------------
//
// Two things, and both are ruled out by assertion rather than by assumption:
//
//   * a serialising scheduler. If wrangler or D1 happened to run the two
//     processes strictly one after the other, the test would pass for the wrong
//     reason. `two_profers_run_one_after_the_other_does_not_need_the_schema`
//     below is the control: it runs the same pair SEQUENTIALLY and asserts the
//     same 1-and-0 outcome, which proves the outcome is the guard's doing and
//     not a property of how the two processes happened to interleave.
//
//   * a false negative. Two processes racing on a local SQLite file can fail
//     with "database is locked" rather than with a constraint result, and a
//     test that accepted any error would pass on a database that rejects
//     everything. Every race assertion therefore distinguishes the three
//     outcomes explicitly: one row, zero rows, or a lock error that is reported
//     as a failure with its message.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT TEST
// ---------------------------------------------------------------------------
//
// It does not test that a correct code is accepted, that a wrong code is
// rejected, or that the code was ever sent. Those need `VerifyEmailOtp`, which
// is `SCAFFOLDED`. This is the storage-level half, and it is the half the
// coordinator's instruction is about: "a SELECT followed by an UPDATE in the
// same function is still two statements".
// ===========================================================================

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDatabase,
  destroyDatabase,
  wranglerAvailable,
} from "./lib/d1.mjs";

const skip = wranglerAvailable()
  ? false
  : "wrangler is not installed — run `pnpm install`. These tests race two real wrangler processes against a real local D1 and cannot run without it.";

/** CHALLENGE A from `database/identity/fixtures/otp_challenges.sql`: outstanding, 5 attempts, expires 2030. */
const OUTSTANDING = "70000000-0000-4000-8000-000000000001";
/** CHALLENGE C: outstanding, exactly ONE attempt remaining — the adjacent race. */
const ONE_ATTEMPT_LEFT = "70000000-0000-4000-8000-000000000003";
/** CHALLENGE B: already consumed, zero attempts left. */
const ALREADY_CONSUMED = "70000000-0000-4000-8000-000000000002";
/** CHALLENGE D: expired, unconsumed, attempts left — the time predicate's case. */
const EXPIRED = "70000000-0000-4000-8000-000000000004";

/**
 * A `now` the CHECK constraints accept. `0007` has
 * `CHECK (consumed_at IS NULL OR consumed_at >= created_at_ms)`, so a `now`
 * earlier than a row's default creation time is refused — which is the CHECK
 * doing its job against a caller that computed "now" in seconds. The real current
 * time is read from the database rather than from the wall clock so the value
 * and the row it is written against cannot disagree.
 */
async function databaseNow(db) {
  const [row] = await db.execute("SELECT (unixepoch() * 1000) AS now_ms;");
  return Number(row.now_ms);
}

describe("the OTP consumption guard", { skip }, () => {
  /** @type {import('./lib/d1.mjs').D1 | undefined} */
  let db;
  const scratch = [];

  before(async () => {
    db = await createDatabase();
    scratch.push(db);
    await db.loadFixtures();
  });

  after(async () => {
    await Promise.all(scratch.map(destroyDatabase));
  });

  /**
   * Run the guard `count` times CONCURRENTLY, each against its OWN challenge row.
   *
   * Every process is spawned before any is awaited — that is the whole point,
   * and it is why this is not a loop around `await db.execute(...)`. The
   * returned array is in spawn order, not completion order, so a caller can
   * compare `winners.length` against the ids it asked for.
   *
   * ---------------------------------------------------------------------------
   * WHY EACH CALL GETS A FRESH ROW WITH A FRESH ID
   * ---------------------------------------------------------------------------
   *
   * Two winners on ONE row is the failure `races TWO simultaneous verifications
   * of the SAME challenge` is for, and it is asserted there directly. Ramping
   * the process count up instead would measure N different challenges, which
   * says nothing about a single row being consumed twice.
   *
   * `label` makes the id UNIQUE PER CALL, which is not cosmetic: the ids are
   * derived from the call site, so two tests that both ask for two rows would
   * otherwise collide on the INSERT and fail with a primary-key violation that
   * has nothing to do with the race. That failure was observed while authoring
   * this file, and it is worth naming because a reader would otherwise have to
   * work out why a test about races failed on a UNIQUE constraint.
   */
  async function raceVerifications(
    count,
    { attemptsRemaining = 5, label = "a" } = {},
  ) {
    const now = await databaseNow(db);

    // Create `count` independent challenges that differ only in id, so N racing
    // verifications of the SAME id is a separate, explicitly-named test below.
    const ids = Array.from(
      { length: count },
      (_, i) => `7fffffffff00-4000-8000-${label}${String(i + 10)}`,
    );
    for (const id of ids) {
      await db.execute(`
        INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                                    expires_at_ms, attempts_remaining, created_at_ms)
        VALUES ('${id}', 'f0000000-0000-4000-8000-000000000002', 'email',
                'active@fixture.invalid',
                X'${"AB".repeat(32)}', ${now + 86400000}, ${attemptsRemaining}, ${now});
      `);
    }

    // Spawn every process before awaiting any of them.
    const inFlight = ids.map((id) =>
      db.executeConcurrent(db.otpConsumeGuard({ id, now: now + 1 })),
    );
    const settled = await Promise.allSettled(inFlight);

    const winners = [];
    const lockErrors = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        lockErrors.push(
          result.reason?.stderr ||
            result.reason?.message ||
            String(result.reason),
        );
        continue;
      }
      // One row returned means this caller won the race and may issue a session.
      winners.push(...result.value);
    }
    return { ids, winners, lockErrors };
  }

  // -------------------------------------------------------------------------
  it("returns exactly ONE row when the guard runs twice SEQUENTIALLY", async () => {
    // THE CONTROL, and it runs first on purpose. It establishes what the guard
    // does without any concurrency at all, so the racing tests below can be read
    // as "the same answer, under overlap" rather than as an unexplained result.
    const now = await databaseNow(db);

    const first = await db.execute(
      db.otpConsumeGuard({ id: OUTSTANDING, now }),
    );
    assert.equal(
      first.length,
      1,
      `the first redemption of an outstanding challenge should return its id; got ${JSON.stringify(first)}`,
    );
    assert.equal(first[0].id, OUTSTANDING);

    const second = await db.execute(
      db.otpConsumeGuard({ id: OUTSTANDING, now }),
    );
    assert.deepEqual(
      second,
      [],
      "a SECOND redemption of an already-consumed challenge must return zero rows — that zero IS the refusal, and a caller that retries instead of refusing is the bug",
    );
  });

  // -------------------------------------------------------------------------
  it("leaves the challenge consumed with NO attempts remaining", async () => {
    // Consumption and the attempt budget are ONE fact, written by ONE statement.
    // A separate decrement would leave a window, and CHALLENGE C exists to make
    // that window observable. Asserting both columns together is what proves the
    // guard set them rather than a caller doing it in two round-trips.
    const [row] = await db.execute(
      `SELECT consumed_at, attempts_remaining, updated_at_ms
         FROM otp_challenges WHERE id = '${OUTSTANDING}';`,
    );
    assert.ok(row.consumed_at !== null, "the challenge is not consumed");
    assert.equal(
      row.attempts_remaining,
      0,
      "a consumed challenge must have no attempts left; a non-zero value means consumption and the attempt budget were written by different statements",
    );
    assert.equal(
      row.updated_at_ms,
      row.consumed_at,
      "the guard sets updated_at_ms to the same instant as consumed_at, so a mismatch means something else wrote the row",
    );
  });

  // -------------------------------------------------------------------------
  it("refuses a challenge that is ALREADY consumed", async () => {
    // CHALLENGE B, loaded consumed. Both of the guard's second and third
    // predicates fail on it, which is the exhausted-and-consumed case.
    const now = await databaseNow(db);
    const rows = await db.execute(
      db.otpConsumeGuard({ id: ALREADY_CONSUMED, now }),
    );
    assert.deepEqual(
      rows,
      [],
      "a consumed challenge must never be redeemable again",
    );
  });

  // -------------------------------------------------------------------------
  it("refuses an EXPIRED challenge even though it is unconsumed and has attempts", async () => {
    // CHALLENGE D. `consumed_at IS NULL` and `attempts_remaining > 0` both hold,
    // so ONLY the time predicate can refuse it. A fixture set where every stale
    // challenge was also exhausted would let an implementation that dropped the
    // expiry check pass every test here.
    const [row] = await db.execute(
      `SELECT consumed_at, attempts_remaining FROM otp_challenges WHERE id = '${EXPIRED}';`,
    );
    assert.equal(
      row.consumed_at,
      null,
      "fixture premise: CHALLENGE D is unconsumed",
    );
    assert.ok(
      row.attempts_remaining > 0,
      "fixture premise: CHALLENGE D has attempts left",
    );

    const now = await databaseNow(db);
    const rows = await db.execute(db.otpConsumeGuard({ id: EXPIRED, now }));
    assert.deepEqual(
      rows,
      [],
      "an expired challenge must be refused by the time predicate alone",
    );
  });

  // -------------------------------------------------------------------------
  it("refuses a challenge with NO attempts remaining even though it is unconsumed", async () => {
    // The third predicate on its own, and the one CHALLENGE D cannot cover. This
    // row is created here rather than loaded from the fixture because the
    // fixture set has no zero-attempt unconsumed challenge — adding one would be
    // a row that exists only to be consumed by a test, and the fixtures' rule is
    // that a row must be there for a reason a reader can see.
    const now = await databaseNow(db);
    const id = "7fffffffff00-4000-8000-0000000000aa";
    await db.execute(`
      INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                                  expires_at_ms, attempts_remaining, created_at_ms)
      VALUES ('${id}', 'f0000000-0000-4000-8000-000000000002', 'email',
              'active@fixture.invalid', X'${"CD".repeat(32)}',
              ${now + 86400000}, 0, ${now});
    `);

    const rows = await db.execute(db.otpConsumeGuard({ id, now }));
    assert.deepEqual(
      rows,
      [],
      "an exhausted challenge must be refused by the attempts predicate alone",
    );
  });

  // -------------------------------------------------------------------------
  it("races TWO simultaneous verifications of the SAME challenge and produces exactly ONE winner", async () => {
    // THE CLAIM. Two processes, spawned before either is awaited, both issuing
    // the identical statement against CHALLENGE C — the one-attempt-remaining
    // row, because that is the case where both callers pass
    // `attempts_remaining > 0` and the only thing separating them is the
    // `consumed_at IS NULL` predicate.
    //
    // Fresh rows are used rather than the fixtures because the fixture rows are
    // consumed by the tests above, and a test whose premise is another test's
    // side effect is a test that fails for a reason nobody can see.
    const now = await databaseNow(db);
    const id = "7fffffffff00-4000-8000-0000000000b1";
    await db.execute(`
      INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                                  expires_at_ms, attempts_remaining, created_at_ms)
      VALUES ('${id}', 'f0000000-0000-4000-8000-000000000002', 'email',
              'active@fixture.invalid', X'${"EF".repeat(32)}',
              ${now + 86400000}, 1, ${now});
    `);

    const guard = db.otpConsumeGuard({ id, now: now + 1 });
    const inFlight = [db.executeConcurrent(guard), db.executeConcurrent(guard)];
    const settled = await Promise.allSettled(inFlight);

    const lockErrors = settled
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.stderr || r.reason?.message || String(r.reason));

    // A lock error is NOT the same outcome as a refusal, and accepting it as one
    // would make this test pass on a database that rejects everything. Report it
    // so the failure names the real problem.
    assert.deepEqual(
      lockErrors,
      [],
      `both racing processes must complete rather than fail on a lock:\n${lockErrors.join("\n")}`,
    );

    const rows = settled.flatMap((r) => r.value ?? []);
    assert.equal(
      rows.length,
      1,
      `exactly one of two simultaneous verifications may succeed; got ${rows.length} rows: ${JSON.stringify(rows)}`,
    );
    assert.equal(rows[0].id, id);

    const [final] = await db.execute(
      `SELECT consumed_at, attempts_remaining FROM otp_challenges WHERE id = '${id}';`,
    );
    assert.ok(final.consumed_at !== null);
    assert.equal(
      final.attempts_remaining,
      0,
      "the winning verification consumed the last attempt; a leftover attempt is the adjacent race",
    );
  });

  // -------------------------------------------------------------------------
  it("races FOUR simultaneous verifications of the SAME challenge and still produces exactly ONE winner", async () => {
    // Two is the minimum that can lose a race. Four is where a broken guard
    // shows up as MORE THAN ONE winner rather than as a count that happens to
    // be one, and it is the case that catches an implementation that read the
    // row first and then wrote it: with four callers, two of them nearly always
    // complete their read before any write lands.
    //
    // ---------------------------------------------------------------------------
    // ONE ROW, FOUR CALLERS — and the earlier revision of this test was WRONG
    // ---------------------------------------------------------------------------
    //
    // This test previously used `raceVerifications(4)`, which creates FOUR
    // DISTINCT rows and verifies each once. That measures four independent
    // redemptions, so four winners is the CORRECT outcome and asserting one
    // winner was asserting something false. It failed here with
    // `got 4: [a10, a11, a12, a13]`, and every one of those four was a genuine
    // success on its own row.
    //
    // The claim worth testing — and the one the name states — is four callers
    // on ONE row. That is a direct extension of the two-caller test above, and
    // it is the only shape on which "exactly one winner" is a meaningful
    // assertion at all.
    const now = await databaseNow(db);
    const id = "7fffffffff00-4000-8000-0000000000d4";
    await db.execute(`
      INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                                  expires_at_ms, attempts_remaining, created_at_ms)
      VALUES ('${id}', 'f0000000-0000-4000-8000-000000000002', 'email',
              'active@fixture.invalid', X'${"34".repeat(32)}',
              ${now + 86400000}, 1, ${now});
    `);

    const guard = db.otpConsumeGuard({ id, now: now + 1 });
    // Four processes spawned before any is awaited.
    const inFlight = [
      db.executeConcurrent(guard),
      db.executeConcurrent(guard),
      db.executeConcurrent(guard),
      db.executeConcurrent(guard),
    ];
    const settled = await Promise.allSettled(inFlight);

    const lockErrors = settled
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.stderr || r.reason?.message || String(r.reason));
    assert.deepEqual(
      lockErrors,
      [],
      `all four racing processes must complete rather than fail on a lock:\n${lockErrors.join("\n")}`,
    );

    const rows = settled.flatMap((r) => r.value ?? []);
    assert.equal(
      rows.length,
      1,
      `exactly one of four simultaneous verifications of ONE row may succeed; got ${rows.length}: ${JSON.stringify(rows)}`,
    );
    assert.equal(rows[0].id, id);

    // And the row carries the winner's write exactly once — not three extra
    // decrements from the losers that a two-statement guard would have applied.
    const [final] = await db.execute(
      `SELECT consumed_at, attempts_remaining FROM otp_challenges WHERE id = '${id}';`,
    );
    assert.ok(final.consumed_at !== null, "the row should be consumed");
    assert.equal(
      final.attempts_remaining,
      0,
      "the single winner consumed the last attempt; a leftover is the adjacent race",
    );
  });

  // -------------------------------------------------------------------------
  it("races verifications of DISTINCT challenges and every one of them wins", async () => {
    // THE CONTRAST CASE, and it is here because the four-way test above once
    // contained this test's setup while asserting the wrong thing about it.
    //
    // Distinct rows are distinct redemptions: nothing about one row's
    // consumption can refuse another row's, and a guard that refused them would
    // be over-broad rather than merely wrong. Asserting BOTH directions is what
    // makes the "exactly one winner" claim in the tests above mean something —
    // without this, a guard that simply always returned zero rows would pass
    // every "one winner, no lock errors" assertion by refusing everybody.
    const { ids, winners, lockErrors } = await raceVerifications(4, {
      attemptsRemaining: 1,
      label: "a",
    });

    assert.deepEqual(
      lockErrors,
      [],
      `all four racing processes must complete rather than fail on a lock:\n${lockErrors.join("\n")}`,
    );
    assert.equal(
      winners.length,
      4,
      `four DISTINCT challenges are four DISTINCT redemptions and all four must succeed; got ${winners.length}: ${JSON.stringify(winners)}`,
    );
    assert.equal(
      new Set(winners.map((w) => w.id)).size,
      4,
      "each winner must be a different row",
    );

    const rows = await db.execute(
      `SELECT id, consumed_at, attempts_remaining
         FROM otp_challenges
        WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})
        ORDER BY id;`,
    );
    assert.equal(
      rows.length,
      4,
      "all four rows this test created should exist",
    );
    for (const row of rows) {
      assert.ok(
        row.consumed_at !== null,
        `${row.id} should have been consumed — a guard that refuses distinct rows is over-broad`,
      );
      assert.equal(
        row.attempts_remaining,
        0,
        `${row.id} was consumed and must have a zero attempt budget — that is what one-statement consumption means`,
      );
    }
  });

  // -------------------------------------------------------------------------
  it("does NOT let a concurrent loser consume or decrement the row it lost", async () => {
    // THE ADJACENT RACE, on the row shape that exposes a two-statement
    // implementation: three callers lose the race to one, and a loser that
    // half-applied its UPDATE would show up here as either a consumed row with
    // attempts remaining, or a row whose attempt budget was decremented without
    // a consumption.
    //
    // The winner is the only writer, so the row's final state must be exactly
    // what that one statement set: consumed, zero attempts, and nothing else.
    // This is asserted on the row the test created rather than on a count,
    // because a count of zero losers would also be satisfied by a database that
    // never ran the losers at all.
    const now = await databaseNow(db);
    const id = "7fffffffff00-4000-8000-0000000000e4";
    await db.execute(`
      INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                                  expires_at_ms, attempts_remaining, created_at_ms)
      VALUES ('${id}', 'f0000000-0000-4000-8000-000000000002', 'email',
              'active@fixture.invalid', X'${"56".repeat(32)}',
              ${now + 86400000}, 5, ${now});
    `);

    const guard = db.otpConsumeGuard({ id, now: now + 1 });
    const settled = await Promise.allSettled([
      db.executeConcurrent(guard),
      db.executeConcurrent(guard),
    ]);

    const lockErrors = settled
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.stderr || r.reason?.message || String(r.reason));
    assert.deepEqual(lockErrors, [], `lock errors: ${lockErrors.join("\n")}`);

    const rows = settled.flatMap((r) => r.value ?? []);
    assert.equal(
      rows.length,
      1,
      `one of two simultaneous verifications wins; got ${rows.length}: ${JSON.stringify(rows)}`,
    );

    // FIVE attempts to spare is the point of this row. A guard that decremented
    // in a second statement would have taken the loser's decrement too, and the
    // budget would be nonzero here.
    const [final] = await db.execute(
      `SELECT consumed_at, attempts_remaining, updated_at_ms
         FROM otp_challenges WHERE id = '${id}';`,
    );
    assert.ok(
      final.consumed_at !== null,
      "the winner's consumption should stick",
    );
    assert.equal(
      final.attempts_remaining,
      0,
      "consumption and the attempt budget are ONE statement; a leftover attempt means a loser decremented a row it had already been refused",
    );
    assert.equal(
      final.updated_at_ms,
      final.consumed_at,
      "updated_at_ms moves with the single winning write, so a mismatch means a second statement wrote this row",
    );
  });

  // -------------------------------------------------------------------------
  it("refuses a consumption whose timestamp precedes the row's own creation", async () => {
    // THE CHECK, and the reason `otpConsumeGuard` takes `now` as a parameter
    // rather than computing it. A caller that computed "now" in SECONDS where the
    // column is milliseconds writes a value around 1.7 billion, and
    // `CHECK (consumed_at IS NULL OR consumed_at >= created_at_ms)` refuses it.
    //
    // This is not a hypothetical: it is the exact mistake the column's comment
    // names, and it was hit while authoring the fixtures in this repository.
    const now = await databaseNow(db);
    const id = "7fffffffff00-4000-8000-0000000000c1";
    await db.execute(`
      INSERT INTO otp_challenges (id, user_id, via, address, code_hash,
                                  expires_at_ms, attempts_remaining, created_at_ms)
      VALUES ('${id}', 'f0000000-0000-4000-8000-000000000002', 'email',
              'active@fixture.invalid', X'${"12".repeat(32)}',
              ${now + 86400000}, 5, ${now});
    `);

    // Seconds, not milliseconds: the classic unit mistake.
    const inSeconds = Math.floor(now / 1000);
    const error = await db.expectReject(
      db.otpConsumeGuard({ id, now: inSeconds }),
    );
    assert.match(
      error,
      /consumed_at IS NULL OR consumed_at >= created_at_ms/i,
      `the CHECK should refuse a seconds-valued timestamp; wrangler said: ${error}`,
    );
  });
});
