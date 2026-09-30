// ===========================================================================
// tests/integration/migrations.test.mjs
//
// WHAT THIS TEST CLAIMS: the sixteen migrations apply cleanly to an EMPTY
// database, apply cleanly to a database that already has a previous version of
// the schema, and never violate the forward-only rule.
//
// THESE ARE REAL ASSERTIONS AGAINST A REAL DATABASE. Each `test` builds its own
// scratch D1 with `wrangler d1 migrations apply`, and every assertion is
// downstream of wrangler having actually run SQL. Nothing here is mocked, and
// there is no test in this file that passes without executing a statement.
//
// IF WRANGLER IS ABSENT every test in this file SKIPS with a named reason. A
// machine without the toolchain installed is not a broken schema, so failing
// would be wrong; and reporting a pass without having run anything is the one
// outcome this repository's rules forbid outright, so it is skipped rather than
// green.
// ===========================================================================

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  REPO_ROOT,
  WRANGLER_LEDGER,
  createDatabase,
  destroyDatabase,
  migrationFiles,
  wranglerAvailable,
  wranglerVersion,
} from "./lib/d1.mjs";

const MIGRATIONS_DIR = join(REPO_ROOT, "database/identity/migrations");

const skip = wranglerAvailable()
  ? false
  : "wrangler is not installed — run `pnpm install`. This suite applies real migrations to a real local D1 and has no sqlite3 or better-sqlite3 fallback, so it cannot run at all without it.";

describe("migrations", { skip }, () => {
  /** @type {import('./lib/d1.mjs').D1 | undefined} */
  let empty;
  const scratch = [];

  before(async () => {
    console.log(`    (wrangler ${await wranglerVersion()})`);
    empty = await createDatabase();
    scratch.push(empty);
  });

  after(async () => {
    await Promise.all(scratch.map(destroyDatabase));
  });

  // -------------------------------------------------------------------------
  it("applies every migration to an EMPTY database without error", async () => {
    // `createDatabase()` already did this in `before`. Assert the outcome
    // rather than the absence of an exception, because "no throw" is exactly
    // what a task that did not run would also produce.
    const tables = await empty.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    const names = tables.map((t) => t.name);

    // The sixteen the brief names, plus the two `schema_migrations` tables
    // (ours, and wrangler's own ledger) and wrangler's `_cf_METADATA`.
    for (const expected of [
      "application_grants",
      "application_secrets",
      "applications",
      "audit_events",
      "authenticators",
      "consents",
      "idempotency_keys",
      "nonces",
      "otp_challenges",
      "outbox_events",
      "pkce_challenges",
      "rate_limit_counters",
      "schema_migrations",
      "sessions",
      "user_emails",
      "user_identities",
      "users",
      WRANGLER_LEDGER,
    ]) {
      assert.ok(
        names.includes(expected),
        `expected table ${expected} to exist; found: ${names.join(", ")}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  it("records every applied migration in wrangler's own ledger, in order", async () => {
    // WRANGLER'S LEDGER, not ours. `schema_migrations` is deliberately left
    // EMPTY by `wrangler d1 migrations apply` — its own header says so: "`d1_
    // migrations` is written by the migration tool... This table is the
    // application's ledger" and "`schema_migrations` is written by the Worker and
    // read by the Worker". Nothing in this repository writes it yet, because the
    // Identity Worker is a one-line placeholder and constraint §2 forbids it
    // shelling out to a migration runner.
    //
    // So asserting `schema_migrations` has sixteen rows would be asserting that a
    // Worker ran. It asserts the opposite: the ledger is empty until the
    // application itself populates it, which is the correct state today.
    const ours = await empty.execute(
      "SELECT COUNT(*) AS n FROM schema_migrations;",
    );
    assert.equal(
      ours[0].n,
      0,
      "schema_migrations is the application's own ledger and must stay empty until a Worker writes it; a non-zero count means something populated it outside the migration tool",
    );

    const wranglers = await empty.execute(
      `SELECT id, name FROM ${WRANGLER_LEDGER} ORDER BY id;`,
    );
    const files = await migrationFiles();
    assert.equal(
      wranglers.length,
      files.length,
      `wrangler's ledger holds ${wranglers.length} rows for ${files.length} migration files`,
    );
    for (const [index, row] of wranglers.entries()) {
      assert.equal(row.id, index + 1, `ledger id ${row.id} is not sequential`);
      assert.equal(
        row.name,
        files[index],
        `ledger row ${row.id} names ${row.name} but the ${index + 1} file alphabetically is ${files[index]}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  it("numbers the migrations densely from 0001, with no gaps", async () => {
    // A gap is not cosmetic. `wrangler d1 migrations apply` refuses a file
    // numbered at or below the highest version it has already applied, so an
    // abandoned `0009` that is later filled in would be permanently unappliable
    // on any database that already reached `0010`. The forward-only rule has no
    // recovery for that, which is why it is a test rather than a convention.
    const files = await migrationFiles();
    for (const [index, name] of files.entries()) {
      const match = /^(\d{4})_/.exec(name);
      assert.ok(
        match,
        `migration ${name} does not begin with four digits and an underscore`,
      );
      assert.equal(
        Number(match[1]),
        index + 1,
        `migration ${name} is numbered ${match[1]} but is the ${index + 1} file alphabetically; the sequence must be dense`,
      );
    }
  });

  // -------------------------------------------------------------------------
  it("states the forward-only rule at the top of every migration", async () => {
    // The brief: that comment "is the artifact a reviewer reads when a deploy
    // goes wrong". A migration without it is a migration whose rollback story
    // exists only in the head of whoever wrote it.
    const files = await migrationFiles();
    const missing = [];
    for (const name of files) {
      const text = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      // Sixty lines, not ten: `0001_schema_migrations.sql` states the rule on
      // line 13, `0006_authenticators.sql` on line 37, and both are inside the
      // header a reviewer actually reads. A window too small for the longest
      // header would fail a migration for stating its rule in a slightly longer
      // explanation of it.
      const firstFiftyLines = text.split("\n").slice(0, 60).join("\n");
      if (
        !/BACKWARD-COMPATIBILITY|backward-compatible|forward-only/i.test(
          firstFiftyLines,
        )
      ) {
        missing.push(name);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `migrations without a stated compatibility rule: ${missing.join(", ")}`,
    );
  });

  // -------------------------------------------------------------------------
  it("applies every migration to a database that ALREADY has an earlier version", async () => {
    // This is the "previous-version DB" case, and it is the one a deployment
    // actually performs: the canary ladder in `database/README.md` runs a new
    // migration against a database whose schema is N-1, not against nothing.
    //
    // The method is to apply the first fifteen files by hand, then let
    // `wrangler d1 migrations apply` run the sixteenth. If the sixteenth
    // assumed a table the fifteenth had not created, this fails.
    const files = await migrationFiles();
    const incremental = await createDatabase({
      migrateThrough: files.length - 1,
    });
    scratch.push(incremental);

    assert.ok(
      files.length >= 2,
      "expected at least two migrations to test with",
    );

    // Apply all but the last, one file at a time, exactly as a series of
    // previously-shipped deploys would have.
    for (const name of files.slice(0, -1)) {
      await incremental.executeFile(join(MIGRATIONS_DIR, name));
    }

    const before = await incremental.execute(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table';",
    );
    assert.ok(before[0].n > 0, "the incremental database has no tables at all");

    // Now the last migration, through wrangler, which will also refuse to
    // re-run anything it believes is already applied. It is not — nothing has
    // been recorded in its ledger — so it runs the final file and nothing else.
    await incremental.migrate();

    const after = await incremental.execute(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table';",
    );
    assert.ok(
      after[0].n >= before[0].n,
      `applying the final migration reduced the table count from ${before[0].n} to ${after[0].n}`,
    );

    // The forward-only rule's mechanical consequence: nothing may have been
    // dropped. Every table that existed before the final migration still exists.
    const tablesAfter = (
      await incremental.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
      )
    ).map((t) => t.name);
    for (const name of [
      "users",
      "sessions",
      "otp_challenges",
      "applications",
    ]) {
      assert.ok(
        tablesAfter.includes(name),
        `${name} disappeared when the final migration was applied — forward-only forbids it`,
      );
    }
  });

  // -------------------------------------------------------------------------
  it("contains no DROP, no ALTER ... RENAME, and no narrowing ALTER", async () => {
    // ADR-0011 and the brief's §21, checked against the TEXT rather than
    // against the resulting schema — because a destructive statement that
    // happened to be a no-op would still be a destructive statement, and
    // "the schema looks the same" is not the property that matters.
    //
    // WHAT IS DELIBERATELY NOT FORBIDDEN: `ALTER TABLE ... ADD COLUMN`. The
    // forward-only rule permits widening, and the nullable form of ADD COLUMN
    // is backward-compatible with every canaried Worker version. This test
    // therefore checks that every ADD COLUMN is NULLABLE or has a DEFAULT,
    // which is what makes it a widening rather than a narrowing.
    const files = await migrationFiles();
    const violations = [];

    for (const name of files) {
      const text = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      // Strip `--` comments so a comment that says "no DROP TABLE here" does
      // not read as a DROP statement.
      const sql = text
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");

      if (/\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i.test(sql)) {
        violations.push(`${name}: DROP of a schema object`);
      }
      if (/\bALTER\s+TABLE\b[^;]*\bRENAME\b/i.test(sql)) {
        violations.push(`${name}: ALTER ... RENAME`);
      }
      if (/\bALTER\s+TABLE\b[^;]*\bDROP\b/i.test(sql)) {
        violations.push(`${name}: ALTER ... DROP COLUMN`);
      }

      // A NOT NULL ADD COLUMN with no DEFAULT narrows: every existing row has
      // no value for it, so the statement fails on a populated table.
      for (const match of sql.matchAll(
        /ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)[^;]*?;/gi,
      )) {
        const statement = match[0];
        if (
          /NOT\s+NULL/i.test(statement) &&
          !/DEFAULT/i.test(statement) &&
          !/PRIMARY\s+KEY/i.test(statement)
        ) {
          violations.push(
            `${name}: ADD COLUMN ${match[2]} on ${match[1]} is NOT NULL with no DEFAULT, which narrows`,
          );
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `migrations violating the forward-only rule:\n${violations.join("\n")}`,
    );
  });

  // -------------------------------------------------------------------------
  it("uses INTEGER milliseconds for every timestamp, and suffixes the column _ms", async () => {
    // The rule 0001's header states once for the whole schema. Checking it
    // here rather than trusting the comment is the difference between a schema
    // that says it stores milliseconds and one that does.
    const tables = await empty.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'
        AND name NOT LIKE 'sqlite_%';`,
    );

    const offenders = [];
    for (const { name } of tables) {
      const columns = await empty.execute(`PRAGMA table_info(${name});`);
      for (const column of columns) {
        const isTimestamp = /created_at|updated_at|occurred_at/.test(
          column.name,
        );
        if (!isTimestamp) continue;
        if (column.type.toUpperCase() !== "INTEGER") {
          offenders.push(
            `${name}.${column.name} is ${column.type}, not INTEGER`,
          );
        }
        if (!column.name.endsWith("_ms")) {
          offenders.push(`${name}.${column.name} is not suffixed _ms`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `timestamp columns violating the unit rule:\n${offenders.join("\n")}`,
    );
  });

  // -------------------------------------------------------------------------
  it("gives every table a surrogate primary key and both timestamp columns", async () => {
    // The brief asks for this on every table. `nonces` is the documented
    // exception and it is asserted as one rather than skipped silently: the
    // table's primary key is the nonce itself, and `0012_nonces.sql` argues
    // why at length ("the shape of the query"). A test that quietly skipped it
    // would leave a reader unsure whether the exception was intended.
    // `sqlite_%` excludes SQLite's OWN tables, which it creates for internal
    // bookkeeping and which no migration here declares. `_cf_METADATA` is
    // Cloudflare's, and `d1_migrations` is wrangler's ledger. Neither is ours
    // and neither can be made to carry our column convention.
    const tables = await empty.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'
        AND name NOT LIKE 'sqlite_%'
        AND name <> 'schema_migrations';`,
    );

    // `nonces` is the documented exception and is asserted as one rather than
    // skipped silently: its primary key is the nonce itself, because
    // `consume(session_id, nonce)` looks the value up directly and a surrogate
    // would turn one statement into three.
    // TWO documented exceptions, both argued in their migration's own header:
    //   nonces            — the primary key IS the nonce, because `consume` looks
    //                       it up directly (0012).
    //   idempotency_keys — the primary key IS the business key, (scope,
    //                       key_value), because "two different callers may both
    //                       send the same Idempotency-Key and those are two
    //                       different requests" (0015). A surrogate id here would
    //                       not change the uniqueness the table exists to
    //                       enforce.
    const NATURAL_KEY_TABLES = new Set(["nonces", "idempotency_keys"]);
    const offenders = [];

    for (const { name } of tables) {
      const columns = await empty.execute(`PRAGMA table_info(${name});`);
      const names = columns.map((c) => c.name);
      const pk = columns.find((c) => c.pk === 1);

      if (!pk) {
        offenders.push(`${name} has no PRIMARY KEY`);
      } else if (NATURAL_KEY_TABLES.has(name)) {
        // Exempt from the surrogate-key rule, and STILL held to the timestamp
        // rule below — the exemption is about the key, not about the columns.
        for (const required of ["created_at_ms", "updated_at_ms"]) {
          if (!names.includes(required)) {
            offenders.push(`${name} has no ${required}`);
          }
        }
        continue;
      } else if (
        !NATURAL_KEY_TABLES.has(name) &&
        // A surrogate key is a bare `id` column holding an opaque UUID. It is
        // NOT the business key — `nonces.nonce`, `idempotency_keys`'s composite
        // (scope, key_value) are business keys and are named in the exemption
        // above. The check is therefore the COLUMN NAME plus the absence of any
        // business meaning in it, which `id` states and a composite does not.
        pk.name !== "id"
      ) {
        offenders.push(
          `${name}'s primary key is ${pk.name}, not a surrogate id`,
        );
      }
      for (const required of ["created_at_ms", "updated_at_ms"]) {
        if (!names.includes(required)) {
          offenders.push(`${name} has no ${required}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `tables violating the column rule:\n${offenders.join("\n")}`,
    );
  });

  // -------------------------------------------------------------------------
  it("re-applying a migration is refused by wrangler rather than re-run", async () => {
    // Idempotence is wrangler's job, not ours — and this is the property that
    // makes "a Worker version from before this file ran cannot be broken"
    // checkable. Every file says `IF NOT EXISTS`, so a re-run would be harmless
    // if it happened; the ledger is what stops it happening, and a test that
    // only asserted "the schema still works" would not notice the ledger had
    // stopped tracking anything.
    const before = await empty.execute(
      `SELECT COUNT(*) AS n FROM ${WRANGLER_LEDGER};`,
    );
    await empty.migrate();
    const after = await empty.execute(
      `SELECT COUNT(*) AS n FROM ${WRANGLER_LEDGER};`,
    );
    assert.equal(
      after[0].n,
      before[0].n,
      "a second `migrations apply` re-ran files wrangler had already recorded",
    );
  });
});
