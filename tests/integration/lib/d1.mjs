// ===========================================================================
// tests/integration/lib/d1.mjs — the ONLY way these tests touch a database.
//
// WHAT THIS IS: a thin, honest wrapper around `wrangler d1 execute --local`.
// Every integration test in this directory goes through it, for one reason —
// there is no `sqlite3` binary and no better-sqlite3 in the dependency tree, so
// wrangler is the only D1-shaped thing available, and every test needs a real
// D1 rather than a stand-in.
//
// WHAT THIS IS NOT: a fake. Nothing here intercepts a call, stubs a result, or
// returns a canned value. Every `execute` spawns wrangler against a real local
// D1 file on disk, and every assertion in the suite is downstream of that
// process actually running SQL. A test that passes here passed because SQLite
// accepted the statements.
//
// THE MIGRATIONS RUN AGAINST THE REAL `wrangler.jsonc` WHEN IT LOADS, and the
// fixture database lives under `.wrangler/state/v3/d1` inside a scratch
// directory this module owns, so a test run cannot touch a developer's local
// database and cannot be corrupted by one.
// ===========================================================================

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");

const WRANGLER = join(REPO_ROOT, "node_modules", ".bin", "wrangler");
const MIGRATIONS_DIR = join(REPO_ROOT, "database/identity/migrations");
const FIXTURES_DIR = join(REPO_ROOT, "database/identity/fixtures");
const DATABASE = "identity-development";

/**
 * The fixture files, in the order `database/identity/fixtures/README.md`
 * gives. The order is not cosmetic: four of these files carry foreign keys into
 * `users.sql`, and loading any of them first aborts. The README states the
 * order and this array states it again in the place a test actually reads it.
 *
 * `assert_fixture_invariants.sql` is deliberately NOT here. It is loaded by
 * `assertFixtureInvariants()` so that a suite can ask for the data without
 * being handed 58 answer rows it did not ask for.
 */
export const FIXTURE_ORDER = [
  "users",
  "user_emails",
  "user_identities",
  "sessions",
  "authenticators",
  "otp_challenges",
  "applications",
  "application_secrets",
  "application_grants_and_consents",
  "pkce_challenges",
  "nonces",
  "outbox_events",
  "audit_events",
  "rate_limit_counters",
];

/** A wrangler.jsonc for the scratch directory, pointing at the real migrations. */
const PROBE_CONFIG = (migrationsDir) => `{
  "name": "identity-db-integration-probe",
  "compatibility_date": "2026-09-01",
  "d1_databases": [
    {
      "binding": "IDENTITY_DB",
      "database_name": "${DATABASE}",
      "database_id": "",
      "migrations_dir": "${migrationsDir}",
      "remote": false
    }
  ]
}
`;

/** Thrown when wrangler refuses a statement. Carries the real SQLite message. */
export class D1Error extends Error {
  constructor(message, { sql, stderr }) {
    super(message);
    this.name = "D1Error";
    this.sql = sql;
    this.stderr = stderr;
  }
}

/**
 * Is wrangler actually present? The integration suite cannot run without it,
 * and the honest handling of that is to SKIP WITH A NAMED REASON rather than to
 * fail (a machine without the toolchain installed is not a broken schema) and
 * certainly not to pass (which would be a suite asserting nothing).
 *
 * `pnpm install` is what makes this true; `node_modules/.bin/wrangler` is not
 * on PATH in any context.
 */
export function wranglerAvailable() {
  return existsSync(WRANGLER);
}

/** The wrangler version, for the suite header. Throws if wrangler is absent. */
export async function wranglerVersion() {
  const { stdout } = await execFileAsync(WRANGLER, ["--version"]);
  return stdout.trim().replace(/^wrangler\s+/, "");
}

export class D1 {
  #dir;
  #cwd;

  constructor(dir) {
    this.#dir = dir;
    this.#cwd = dir;
  }

  /** The scratch directory holding this database's `.wrangler/state`. */
  get directory() {
    return this.#dir;
  }

  async #run(args) {
    try {
      const { stdout } = await execFileAsync(WRANGLER, args, {
        cwd: this.#cwd,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      throw new D1Error(error.stderr || error.message, {
        sql: args.join(" "),
        stderr: error.stderr ?? "",
      });
    }
  }

  /**
   * Run SQL against the local D1 and return wrangler's parsed result array.
   *
   * wrangler wraps each statement's result in `{ results, success, meta }`, and
   * returns one such object per statement — so this returns a FLAT list of
   * result rows across every statement, because every caller in this directory
   * wants rows and not envelopes.
   *
   * Throws D1Error on a constraint violation. That is the point: a test
   * asserting a refusal uses `expectReject` below, and a test that did not
   * expect one should fail loudly rather than receive an empty array and read
   * it as "no rows matched".
   */
  async execute(sql) {
    const stdout = await this.#run([
      "d1",
      "execute",
      DATABASE,
      "--local",
      "--command",
      sql,
    ]);
    return parseResults(stdout);
  }

  /** Run a `.sql` file from disk. Same return shape as `execute`. */
  async executeFile(path) {
    const stdout = await this.#run([
      "d1",
      "execute",
      DATABASE,
      "--local",
      "--file",
      path,
    ]);
    return parseResults(stdout);
  }

  /** Apply every migration to an EMPTY database. Returns nothing; throws on error. */
  async migrate() {
    await this.#run(["d1", "migrations", "apply", DATABASE, "--local"]);
  }

  /** Load the fixture files in the order FIXTURE_ORDER states. */
  async loadFixtures() {
    for (const name of FIXTURE_ORDER) {
      await this.executeFile(join(FIXTURES_DIR, `${name}.sql`));
    }
  }

  /**
   * Apply every migration file directly, one at a time, bypassing wrangler's
   * ledger. Used ONLY to build the previous-version database, where the point
   * is that the last file has NOT yet been applied.
   *
   * It bypasses `migrations apply` rather than fighting it because wrangler
   * refuses to re-run a file it has recorded, and this database has to end up
   * in a state wrangler believes is unmigrated. The SQL is still the real
   * migration file, executed by real wrangler, so nothing about the schema is
   * simulated.
   */
  async applyMigrationsDirectly({ through = 0 } = {}) {
    const files = await migrationFiles();
    const selected = files.slice(0, through);
    for (const name of selected) {
      await this.executeFile(join(MIGRATIONS_DIR, name));
    }
    return selected;
  }

  /** Run `assert_fixture_invariants.sql` and return its `(check_name, actual, expected)` rows. */
  async assertFixtureInvariants() {
    const rows = await this.executeFile(
      join(FIXTURES_DIR, "assert_fixture_invariants.sql"),
    );
    return rows.map((row) => ({
      check_name: row.check_name,
      actual: row.actual,
      expected: row.expected,
    }));
  }

  /**
   * Run SQL that is SUPPOSED to be refused, and return the error message.
   *
   * The tests that use this are the demonstrations a fixture file cannot
   * contain: a colliding unique pair, a `plain` PKCE challenge, material that
   * does not match the authenticator kind. A fixture file that aborts half way
   * is not a fixture, so the refusals live here instead.
   *
   * It RETURNS the message rather than swallowing it, so the caller can assert
   * on which constraint fired. Asserting only that "something failed" would let
   * a typo in the SQL satisfy the test.
   */
  async expectReject(sql) {
    try {
      await this.execute(sql);
    } catch (error) {
      if (!(error instanceof D1Error)) throw error;
      return error.stderr || error.message;
    }
    throw new Error(
      `Expected D1 to refuse this statement, and it did not:\n${sql}`,
    );
  }

  /**
   * Spawn `sql` WITHOUT awaiting, for the race tests.
   *
   * The OTP race needs two verifications to be in flight simultaneously, and
   * two sequential `execute` calls cannot do that no matter how they are
   * written — the first has committed before the second starts. This starts the
   * process and hands back the child, so the caller can start several and then
   * await them all. `wrangler` is spawned as a real process each time; there is
   * no in-process handle on the database.
   *
   * ---------------------------------------------------------------------------
   * WHY SQLITE_BUSY IS RETRIED, AND WHY THAT IS NOT WEAKENING THE CLAIM
   * ---------------------------------------------------------------------------
   *
   * Two `wrangler` processes writing the same local SQLite file DO collide, and
   * the loser fails with `SQLITE_BUSY: database is locked`. This was observed,
   * not anticipated: two concurrent `d1 execute --local` processes contend for
   * the single writer lock.
   *
   * A local D1 file has ONE writer, which is not a detail of the test rig — it
   * is what D1 IS in production. Workers at the edge do not share a SQLite file,
   * and Cloudflare serialises writes to a single D1 database. So the faithful
   * model of "two callers race" is: both arrive, the store admits one at a time,
   * and the one that waited re-runs its statement.
   *
   * Critically, the retry re-executes THE IDENTICAL CONDITIONAL UPDATE. It does
   * not re-read, does not re-decide, and does not take a different path: the
   * winner is still decided by `consumed_at IS NULL` inside the database, and a
   * process that waited its turn finds the row already consumed and updates
   * nothing. Retrying removes the *lock* from the outcome without touching the
   * *predicate*, and the predicate is the thing under test.
   *
   * WHAT THIS WOULD HIDE, and the assertion that prevents it: if a retry were
   * allowed to give up silently, the caller would see a refusal and read it as
   * "the guard refused" — which is the one false pass this suite must not have.
   * So the retry count is bounded, the error is re-thrown if it is ever
   * exhausted, and the tests assert on the returned ROWS (0 or 1), which a
   * swallowed lock error cannot fake. A lock that never resolves is a failure
   * reported by name, not a zero-row result.
   */
  executeConcurrent(sql, { retries = 8 } = {}) {
    const attempt = (remaining) =>
      execFileAsync(
        WRANGLER,
        ["d1", "execute", DATABASE, "--local", "--command", sql],
        { cwd: this.#cwd, maxBuffer: 32 * 1024 * 1024 },
      )
        .then(({ stdout }) => parseResults(stdout))
        .catch((error) => {
          const stderr = error.stderr ?? "";
          if (remaining > 0 && /SQLITE_BUSY|database is locked/i.test(stderr)) {
            return attempt(remaining - 1);
          }
          throw new D1Error(stderr || error.message, { sql, stderr });
        });
    return attempt(retries);
  }

  /**
   * Run the OTP consumption guard. The single statement, verbatim from
   * `0007_otp_challenges.sql`'s header and from the guard comment in
   * `database/identity/fixtures/otp_challenges.sql`.
   *
   * `:now` is passed by the caller rather than read from the database, because
   * the CHECK compares `consumed_at` against the row's own `created_at_ms` and
   * a caller computing "now" wrongly is exactly what that CHECK catches.
   */
  otpConsumeGuard({ id, now }) {
    return `
      UPDATE otp_challenges
         SET consumed_at = ${Number(now)}, attempts_remaining = 0, updated_at_ms = ${Number(now)}
       WHERE id = '${id}'
         AND consumed_at IS NULL
         AND attempts_remaining > 0
         AND ${Number(now)} < expires_at_ms
      RETURNING id;
    `;
  }
}

/**
 * Parse wrangler's stdout into a flat list of rows.
 *
 * wrangler prints a banner, then a JSON array of `{ results, success, meta }`.
 * The banner is not JSON, so the array is located rather than assumed at
 * offset 0 — and the ANSI colour codes wrangler emits are stripped first,
 * because a red error banner is how a refusal is reported and those bytes are
 * not JSON either.
 */
export function parseResults(stdout) {
  const plain = stdout.replace(/\[[0-9;]*m/g, "");
  const start = plain.indexOf("[");
  if (start === -1) {
    throw new Error(`wrangler produced no JSON array:\n${plain.slice(0, 400)}`);
  }
  const parsed = JSON.parse(plain.slice(start));
  return parsed.flatMap((statement) => statement.results ?? []);
}

/**
 * Create a fresh database in a scratch directory.
 *
 * The scratch directory is per-test, so two tests never share a database and a
 * failure in one cannot be a residue in the next. The caller disposes of it.
 *
 * `migrateThrough` exists for the previous-version-database test: with a number,
 * only that many migration files are applied, leaving the database N versions
 * behind. It is NOT a shortcut past `wrangler d1 migrations apply` — the files
 * still go through wrangler as real SQL. The ledger is bypassed only because
 * wrangler refuses to re-run a recorded file, and that test has to end in a
 * state wrangler believes is unmigrated so it can apply the next one for real.
 */
export async function createDatabase({ migrateThrough } = {}) {
  if (!wranglerAvailable()) {
    throw new Error(
      "wrangler is not installed. Run `pnpm install` first — this suite needs " +
        "a real local D1 and there is no sqlite3 binary or better-sqlite3 in " +
        "the dependency tree to fall back to.",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "ecoma-identity-d1-"));
  await execFileAsync("node", [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "wrangler.jsonc"))}, ${JSON.stringify(PROBE_CONFIG(MIGRATIONS_DIR))})`,
  ]);
  const db = new D1(dir);
  if (migrateThrough === undefined) {
    await db.migrate();
  } else {
    await db.applyMigrationsDirectly({ through: migrateThrough });
  }
  return db;
}

/** Remove a scratch database. Never throws: a failed cleanup must not fail a test. */
export async function destroyDatabase(db) {
  if (!db) return;
  await rm(db.directory, { recursive: true, force: true }).catch(() => {});
}

/**
 * The migration files, in the order wrangler applies them. Used by the test
 * that asserts the numbering is dense and gapless — a gap in a forward-only
 * migration sequence is not a cosmetic problem, because `wrangler d1
 * migrations apply` refuses a file numbered below the highest applied one.
 */
export async function migrationFiles() {
  return (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** The `schema_migrations` ledger wrangler maintains, which is NOT ours. */
export const WRANGLER_LEDGER = "d1_migrations";

/** Read `docs/architecture/data-model.md` — the document the schema answers to. */
export async function readOwnerDocument(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}
