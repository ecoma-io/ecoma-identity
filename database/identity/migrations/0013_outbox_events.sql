-- ===========================================================================
-- 0013_outbox_events.sql
--
-- WHAT THIS ADDS: `outbox_events` — the transactional outbox. One row per
-- committed fact, written in the SAME TRANSACTION as the state change it
-- describes, so that "the fact happened" and "the fact was announced" cannot
-- come apart.
--
-- WHERE THE RUST PUTS THIS: `identity_domain::outbox::OutboxEvent`:
--   { id, event_type, payload, occurred_at_ms, dispatch_attempts }
-- and `OutboxEventType`, whose `parse` refuses any type without a `.vN` suffix.
--
-- BACKWARD-COMPATIBILITY: additive only. CREATEs one table and three indexes.
-- The table is referenced by nothing that exists yet, so its appearing cannot
-- break a canaried Worker version. Full rule: 0001_schema_migrations.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS outbox_events (
    -- `OutboxEvent.id` — and this is NOT a database surrogate, which is the most
    -- important sentence in this file.
    --
    -- `event-model.md` says it directly: "this is why the outbox row's id is not
    -- a database surrogate. A surrogate bigint would differ between the original
    -- write and a re-dispatch of the same fact, and the consumer would have no
    -- way to recognise the repeat." The UUID minted at write time IS the
    -- consumer's idempotency key, and it travels inside the queue message, so a
    -- redelivery is byte-identical to the original delivery.
    --
    -- That is the whole mechanism by which at-least-once delivery is survivable:
    -- "for a given event id, the observable effect happens at most once".
    --
    -- Stored as TEXT, UUID canonical form. No UNIQUE constraint, because the
    -- primary key already is one — and a second one would be a second B-tree on
    -- the hottest write in the system.
    id      TEXT    PRIMARY KEY NOT NULL,

    -- `OutboxEvent.event_type` — `identity.email.send.v1` and its two siblings.
    --
    -- The `.vN` SUFFIX IS ENFORCED HERE, NOT ONLY IN RUST. `OutboxEventType::
    -- parse` "requires a .vN suffix" in the domain, and that is the first line of
    -- defence. This CHECK is the second, and the second matters because the
    -- first only runs on paths that go through the type's constructor — an
    -- INSERT written by hand, by a script, or by a future producer that
    -- mistakes a string for a type would otherwise write an unversioned event
    -- that a consumer binds to the wrong schema with total confidence.
    --
    -- `OutboxEventType::version()` "returns 0 for an unparseable suffix and no
    -- consumer supports version 0, so a malformed type surfaces as unsupported
    -- rather than as a plausible version binding to the wrong schema". This
    -- CHECK makes that outcome reachable only through a direct database write,
    -- and there is no third door.
    --
    -- The GLOB is: starts with "identity.", ends with ".v<digits>", where the
    -- digits are at least one character and nothing may follow them.
    --
    --   GLOB 'identity.*'          the type's namespace. `event-model.md` calls
    --                              these values "the names", and they all begin
    --                              with the service name so a queue carrying
    --                              events from more than one producer can tell
    --                              them apart without a registry.
    --   GLOB '*.*'                at least one further dot, which is what makes
    --                              the two patterns below mean the same thing
    --                              they mean in Rust
    --   GLOB '*.[vV][0-9]*'       a .v prefix somewhere...
    --   NOT GLOB '*.[vV][0-9]*[^0-9]'  ...whose digits run to the end, which is
    --                              what rejects ".v1beta" and ".vx" and ".v".
    --
    -- SQLite's GLOB is case-SENSITIVE, which is why the two shapes are spelled
    -- separately below — and the reason is `OutboxEventType::parse` itself,
    -- which does `value.to_ascii_lowercase()` on the way in and so can never
    -- produce an uppercase type name at all. The CHECK is therefore STRICTER
    -- than the Rust on one point and LOOSER on another, deliberately, in
    -- opposite directions:
    --
    --   stricter  it requires the "identity." prefix, which the Rust does not
    --             check. A type without that prefix is refused here even though
    --             `parse` would accept it. The prefix is this schema's
    --             namespace, and a database-level rule that "event types on
    --             this platform are named identity.<thing>.<action>.vN" is
    --             exactly the kind of thing a CHECK is for.
    --   looser    it requires the version suffix to be preceded by a dot. The
    --             Rust does not: it does `rsplit_once(".v")` and takes what
    --             follows, so a name component that itself begins with "v"
    --             after a dot parses fine.
    --
    -- Two consequences of "looser", both verified by probe rather than reasoned
    -- about, and both stated because a reader will trip on them:
    --
    -- 1. `identity.email.send.v1.v2` is ACCEPTED here and by `parse`. Neither is
    --    wrong about it: the value's version is 2, its name is
    --    "identity.email.send.v1", and nothing in either layer claims a dotted
    --    version is illegal. `event-model.md` describes the mechanism as "a new
    --    version is a new type name", which is a statement about how the
    --    platform will NAME things rather than a syntactic rule either enforces.
    -- 2. `identity.email.send.V1` is ACCEPTED by `parse` — the value is
    --    lowercased before it is stored, so what lands in the column is
    --    "identity.email.send.v1" — and ACCEPTED by this CHECK, which takes
    --    either case so that a value written through the type is never refused
    --    here. A hand-written INSERT of the uppercase spelling is accepted and
    --    stays uppercase on disk, which is a cosmetic inconsistency rather than
    --    a safety one: `rsplit_once(".v")` does not match an uppercase "V", so
    --    such a row reads back as having no version at all and
    --    `OutboxEventType::version()` returns 0 — "no consumer supports version
    --    0, so a malformed type surfaces as unsupported rather than as a
    --    plausible version binding to the wrong schema". The fail direction is
    --    closed, which is the direction that matters.
    --
    -- A producer writing through the constructor always stores the lowercase
    -- form. The lowercase normalisation is the code's job and is deliberately
    -- NOT duplicated here, because a CHECK that re-implemented a constructor
    -- would be a second source of truth with a second answer the first time
    -- either changed.
    --
    -- MAX_LEN 128 is `OutboxEventType::MAX_LEN`, and it is enforced here too for
    -- the same reason — an unbounded type name in an index is an unbounded index
    -- key.
    event_type TEXT NOT NULL
              CHECK (
                    length(event_type) BETWEEN 1 AND 128
                    AND event_type GLOB 'identity.*'
                    AND event_type GLOB '*.*'
                    AND event_type GLOB '*.[vV][0-9]*'
                    AND event_type NOT GLOB '*.[vV][0-9]*[^0-9]'
              ),

    -- `OutboxEvent.payload` — the message body, JSON, as TEXT.
    --
    -- WHY TEXT AND NOT A JSON COLUMN: SQLite's JSON is a function set, not a
    -- storage type, and a CHECK cannot validate a JSON document without
    -- JSON1 — which D1 does not guarantee. What this column does check is
    -- emptiness and a ceiling, because an unbounded payload in a queue message
    -- is a queue-size problem discovered in production rather than in review.
    --
    -- 256 KiB is far larger than any of the three payloads
    -- (`identity.email.send.v1` carries a recipient and a template name; the
    -- notification carries a subject and a reference; the archive event carries
    -- an id). The ceiling is a sanity bound, not a size budget, and the real
    -- limit on a message is Cloudflare's queue payload limit rather than this
    -- one.
    --
    -- THE PAYLOAD'S SCHEMA IS NOT HERE. It is in contracts/events/v1/, and the
    -- two are related the way every producer/consumer pair is: additive within a
    -- version, new version for a change. `event-model.md` §"Backward
    -- compatibility" is the rule, and the `.vN` suffix on `event_type` is the
    -- mechanism that makes it enforceable across two separately-promoted
    -- Workers.
    payload TEXT NOT NULL CHECK (length(payload) BETWEEN 2 AND 262144),

    -- `OutboxEvent.occurred_at_ms` — when the FACT was committed, integer
    -- milliseconds since the epoch.
    --
    -- NOT when the row was written and NOT when it was dispatched, and the
    -- difference is the point: a message that sat in the outbox for two hours
    -- during a queue outage describes a fact that happened two hours ago. A
    -- consumer that used the dispatch time would think a user was notified then;
    -- a consumer that uses this column knows when the thing happened. The
    -- `Dispatched` timestamp would be "when did we manage to send this", which
    -- is an operational fact about us rather than a fact about the user.
    --
    -- It is set by the PRODUCER at write time, inside the state transaction, and
    -- it is why the column has no DEFAULT: a default would be "when the row was
    -- inserted", which is the same thing for a correctly-written producer and a
    -- subtly different thing for one that batches, and the difference is
    -- invisible until someone asks why a security notification says it fired
    -- before the session revocation it describes.
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),

    -- `OutboxEvent.dispatch_attempts` — how many times the dispatcher has tried
    -- to enqueue this row. ZERO when the producer wrote it.
    --
    -- WRITTEN BY THE DISPATCHER, NEVER THE PRODUCER. `event-model.md` is
    -- explicit about the second rule: "The producer must not write
    -- dispatch_attempts. That column belongs to the dispatcher. If a command
    -- could increment it, a command that failed to publish would advance the
    -- retry counter itself, and a misconfigured queue would exhaust its budget
    -- without the dispatcher ever having tried." Nothing in the schema can
    -- enforce that — it is an application-layer obligation — so it is stated on
    -- the column where the dispatcher will read it.
    --
    -- BOUNDED AT 25, which is `OutboxEvent::MAX_DISPATCH_ATTEMPTS`. Past the
    -- ceiling the row is dead-lettered rather than retried forever, and
    -- `record_dispatch_attempt` returns `DomainError::IllegalTransition` on an
    -- exhausted row, "which is a dispatcher bug and should be visible as one".
    --
    -- The CHECK is `BETWEEN 0 AND 25` rather than `>= 0` deliberately. The column
    -- is not meant to be able to express "past the ceiling" — a dead letter is a
    -- row sitting AT the ceiling that nobody will pick up again, not a row
    -- counting past it. `should_dispatch()` is what decides, in Rust. The CHECK's
    -- job is to refuse the value that a careless increment past the ceiling
    -- would produce, so that a dispatcher's off-by-one is a constraint violation
    -- on a single row rather than a column of numbers that quietly means
    -- "attempt 26" when the code believes it means "dead".
    dispatch_attempts INTEGER NOT NULL DEFAULT 0
                      CHECK (dispatch_attempts BETWEEN 0 AND 25),

    -- When the dispatcher actually got it onto the queue. NULL until it does.
    --
    -- THE ANSWER TO "is there an undelivered fact?" is
    -- `dispatched_at_ms IS NULL AND occurred_at_ms < :now`, and it is an index
    -- range scan rather than a scan of everything — which is index #1 below.
    --
    -- There is deliberately NO boolean. `dispatched` and `dispatched_at` are two
    -- columns that can disagree, and the disagreement is exactly the state an
    -- operator would be staring at at 3am: "the outbox says the email was
    -- dispatched and the queue says it never arrived". One nullable timestamp
    -- cannot disagree with itself.
    dispatched_at_ms INTEGER CHECK (dispatched_at_ms IS NULL OR dispatched_at_ms >= 0),

    -- Generic created_at_ms / updated_at_ms, integer milliseconds since the
    -- epoch (the rule is stated once in 0001). For this table `created_at_ms`
    -- agrees with `occurred_at_ms` on the insert and then diverges the first time
    -- the dispatcher touches the row, which is the intended behaviour: the
    -- dispatcher's writes are bookkeeping, the fact's timestamp is not.
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- INDEXES — each names the query it serves.
-- ---------------------------------------------------------------------------

-- INDEX 1: THE DISPATCHER'S CLAIM. This is the index the outbox exists for.
--
-- `data-model.md` names it exactly: `outbox_events (dispatch_attempts,
-- occurred_at_ms)` — "the dispatcher claims un-dispatched rows in order".
--
-- Serves:
--   SELECT ... FROM outbox_events
--    WHERE dispatch_attempts < 25
--      AND dispatched_at_ms IS NULL
--      AND occurred_at_ms <= :now
--    ORDER BY occurred_at_ms ASC
--    LIMIT :batch;
--
-- which is "what has not been sent yet, oldest first". `dispatch_attempts`
-- leads so the ceiling predicate is evaluated on a bounded prefix of the
-- index, and `occurred_at_ms` carries the ordering so the ORDER BY is satisfied
-- by the index rather than by a sort.
--
-- NOT PARTIAL, and this is a decision worth defending because the partial form is
-- the obvious one:
--
--   * partial would be `WHERE dispatched_at_ms IS NULL`, which is smaller — and
--     it is smaller only until the first dispatch. `identity.email.send.v1` is
--     high-volume and short-lived; a partial index over undispatched rows would
--     be small when the queue works and would have to be rebuilt — no, would
--     have to GROW, index-by-index, the moment the queue is misconfigured, which
--     is precisely when the dispatcher needs to find rows fastest and least
--     predictably. A full index has the same worst case, and does not depend on
--     the failure to be catastrophic.
--   * a full index over dispatched rows is write amplification. That cost is
--     paid on every dispatch, once per event, forever. It buys an index whose
--     size does not depend on the health of an external system, which is the
--     trade this table makes.
--
-- The trade is named here rather than hidden: outbox_events is the highest-
-- write-volume table in the schema, and this is the index that makes it so. The
-- alternative — not indexing the outbox and letting a full scan find pending
-- work — is a scan whose cost grows with total history, which is worse.
CREATE INDEX IF NOT EXISTS ix_outbox_events_dispatch
    ON outbox_events (dispatch_attempts, occurred_at_ms);

-- INDEX 2: the dead-letter queue. "Which events exhausted their retries?"
--
-- PARTIAL on `dispatch_attempts = 25`, which is the exact predicate a dead
-- letter has. This index holds at most one row per dead event for the entire
-- life of the database, which is the whole reason it is worth having: an
-- operator action ("Replaying a dead letter is an operator action, deliberately,
-- on a row someone looked at") starts from a query that must not scan the
-- outbox, and the set it finds is by definition tiny.
CREATE INDEX IF NOT EXISTS ix_outbox_events_dead_letter
    ON outbox_events (occurred_at_ms) WHERE dispatch_attempts = 25;

-- INDEX 3: "which events were dispatched around this time?" — the
-- reconciliation query after a queue incident, when somebody has to answer "did
-- the 14:00 session-revocation notifications actually go out, or did they sit in
-- the outbox?".
--
-- Leads with dispatched_at_ms and is PARTIAL on it being non-null, because a row
-- that was never dispatched has no answer to give this query.
CREATE INDEX IF NOT EXISTS ix_outbox_events_dispatched
    ON outbox_events (dispatched_at_ms) WHERE dispatched_at_ms IS NOT NULL;

-- NO INDEX on payload. A B-tree over a 256 KiB document is a 256 KiB index key.
--
-- NO INDEX on event_type. No query asks "every event of type X" on a hot path —
-- and if one is ever asked, the answer is a scan by design: `event-model.md`'s
-- consumer rule is that a consumer receives ONE event type and counts the rest,
-- and an index that made cross-type scanning cheap would be an index that made
-- the wrong thing easy. Type is a routing key for the CONSUMER, not a query key
-- for the producer, and the queue's own subscription does the routing.

-- ===========================================================================
-- THE TWO RULES THE DISPATCHER OWNS, restated where the dispatcher will read
-- them
-- ===========================================================================
--
-- 1. Do not publish from a command. The producer writes a row and returns.
--    "If the producer published directly, a failure between the commit and the
--    publish loses the event permanently, and there is nothing to find."
--
-- 2. Do not write dispatch_attempts from a command. The dispatcher increments
--    it; nothing else may. A producer that increments its own counter exhausts a
--    budget it never spent, and the resulting dead letter points at the wrong
--    component.
--
-- NEITHER RULE IS ENFORCED HERE, and that is not an oversight in this schema —
-- it is the honest position. A database can express "this column holds 0..25";
-- it cannot express "only one named component may change it". The rules live in
-- the dispatcher, which is `DEFERRED`.
--
-- ===========================================================================
-- THERE IS NO ATOMICITY BETWEEN THIS TABLE AND THE QUEUE
-- ===========================================================================
--
-- The D1 commit and the enqueue are two different systems and there is no
-- two-phase commit between them. The outbox narrows the failure to ONE place —
-- "committed but not yet enqueued", which the dispatcher sweeps — instead of the
-- two places a naive implementation has ("committed but the publish was lost",
-- which nothing can find). It does not eliminate the failure.
--
-- `event-model.md` states the design in one line: "the outbox is a third table
-- written in the same transaction as the state change. ... The point is that the
-- DECISION to publish is committed atomically with the fact, and the ACT of
-- publishing is retried until it succeeds. The queue is the unreliable edge, and
-- the retry is what makes it reliable."
--
-- What that buys, stated as properties a consumer can rely on:
--   * every announced fact IS a committed fact. The reverse does not hold:
--     a committed fact may be announced late, or dead-lettered, or never.
--   * delivery is AT LEAST ONCE. Every consumer must be idempotent on
--     `outbox_events.id`, which is the primary key of this table and a field of
--     the message. `identity-jobs` has no idempotency trait yet — see
--     `event-model.md`, which says so — so this is `DEFERRED` and this schema is
--     only half of what it needs to be.
--   * ORDER IS NOT GUARANTEED, and nothing in these indexes claims it is. The
--     dispatcher claims in `occurred_at_ms` order, but two events claimed in one
--     batch can be enqueued or delivered in either order, and a re-dispatch
--     re-enters the queue at the end. A consumer that needs ordering must order
--     itself, keyed on `occurred_at_ms` plus `id`, and must expect to be
--     interrupted between two events it needed in sequence.

-- SECURITY: what an attacker gets from this table.
--
--   - `payload` for `identity.email.send.v1` contains a recipient address and,
--     depending on the template, a one-time code or a reset link. An outbox read
--     is a queue of live credentials waiting to be delivered to their legitimate
--     recipients — but only within the code's TTL, and only if the attacker can
--     intercept the delivery, which requires controlling the mail path or
--     reading it at the provider. It is a moderate finding, not a critical one,
--     and it is the reason the table has no read path outside the dispatcher.
--   - `id`, `occurred_at_ms` and `event_type` in bulk are a dated map of what
--     happened to whom — "this account had a factor enrolled at this time on this
--     day". Combined with `users`, that is a security-posture timeline per
--     account, and it is a targeting tool.
--   - NOTHING in this table authenticates anything, and WRITE access to it is
--     not a login bypass: writing an outbox row announces a fact that was never
--     true, and a consumer that trusts the payload without re-reading state is
--     the bug that would turn this into one. `identity-jobs` is barred from
--     evaluating identity rules at all (constraint §4, `jobs-isolation.md`),
--     which is the structural half of that defence.