// do-shelve.js - the SQL helpers DemoGenDO delegates to so they can be tested.
//
// They live outside do.js for one reason: do.js imports `DurableObject` from "cloudflare:workers",
// which only exists inside workerd, so nothing in that file can be driven from a plain-node test.
// Each function here is the whole of one piece of new behaviour, touches nothing but the `sql`
// handle it is handed, and worker/demo-gen.unit.test.mjs runs it against the REAL schema on
// node:sqlite. The DO keeps ownership of what they are called with: the state enum, the review
// states, the purgeable states and the lead caps are all passed in from do.js, which stays the
// single source of truth for the machine's shape.
//
// The file is named for the shelve because that is what it was opened for; it is now simply where
// a DO method's body goes when the method has to be provable outside workerd. The 2026-07-28 lead
// capture is the second occupant (see applyLeadCapture / selectLeads at the bottom).
//
// `sql` is Cloudflare's SqlStorage: `exec(query, ...bindings)` returning a cursor with
// `.toArray()` and `.one()`. Nothing here awaits, so each call stays atomic inside the DO's
// input gate exactly like the rest of do.js.

/**
 * The UTC day a timestamp falls in, byte for byte what do.js's own `dayOf` returns. Every daily
 * counter in this Worker is a UTC day, so the lead caps below use the same key the job cap does
 * and a day boundary means one thing across the whole machine.
 */
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Event kinds the lead capture appends. Counted per UTC day; never updated in place. */
const LEAD_EVENT = "signup_lead";
const LEAD_NOTIFY_EVENT = "signup_lead_notified";

/**
 * Add a column to a table only if it is not already there. Returns true when it added one.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot do this job, and that is the whole reason this exists: the DO
 * constructor runs on every wake, but for an instance created before the column was declared the
 * CREATE is a NO-OP that leaves the old six-column table exactly as it was. Only an ALTER reaches
 * it, and sqlite has no `ADD COLUMN IF NOT EXISTS`, so a second wake would throw "duplicate column
 * name" out of a constructor and take the whole object down.
 *
 * The guard is a PRAGMA read rather than a try/catch around the ALTER. A catch would swallow every
 * other reason an ALTER can fail (a locked table, a typo in the type, a table that is not there at
 * all) and leave a silently unmigrated DO answering requests. Asking what columns exist is a
 * question with an exact answer, so ask it.
 *
 * ADD COLUMN only, and only nullable ones: it is O(1) in sqlite, it rewrites no rows, and every
 * pre-existing row reads back NULL for the new column. That is the correct value for a lead
 * captured before the field existed, and it is why nothing here backfills.
 */
export function addColumnIfMissing(sql, table, column, type) {
  const cols = sql.exec(`PRAGMA table_info(${table})`).toArray();
  if (cols.some((c) => String(c.name) === column)) return false;
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

/**
 * Every additive migration the `leads` table has taken since it was first created, in order.
 *
 * do.js calls this straight after the CREATE, on every construction, and it is idempotent by
 * construction: on a fresh instance the CREATE already declared the columns and every call here is
 * a PRAGMA read that finds them; on an instance that predates one, that call adds it once and every
 * wake after is the same PRAGMA read. Both paths converge on the same table.
 *
 *  - `role` (2026-08-03): which of worker/roles.js's three registers the visitor picked in the demo,
 *    or NULL. NULL means "not asked" for a row captured before the picker shipped and "skipped" for
 *    one after it, and the export deliberately does not try to tell those apart: inventing a
 *    distinction the table never recorded would be worse than the honest null.
 */
export function migrateLeads(sql) {
  return { role: addColumnIfMissing(sql, "leads", "role", "TEXT") };
}

/**
 * Read-only drain visibility for the shelve (GET /api/demo-gen/runner/state).
 *
 * Strictly read-only, and that is a contract, not an implementation detail: the shutdown loop
 * watches this endpoint until every count is zero, so an expired lease observed here must NOT be
 * reclaimed and no `runner_seen` event may be written. Watching the queue drain cannot be allowed
 * to change what it is watching.
 *
 * Counts only. No email, no use case, no slug, no claim token: a bearer that leaks buys the size
 * of the queue and nothing about the people in it.
 *
 * The field set is EXACTLY one count per state in the enum it is handed, plus `unknown`,
 * `review_total` and `next_claim_expiry_s`. It is fixed by the enum and never by the data: no row
 * in the jobs table can add a key to this response.
 *
 * @param {object} sql            SqlStorage handle
 * @param {object} opts
 * @param {number} opts.now       epoch ms
 * @param {string[]} opts.states  every state in the machine's enum (do.js LEGAL_TRANSITIONS keys)
 * @param {string[]} opts.reviewStates states the runner's delivery sweep still lists
 */
export function computeStateSnapshot(sql, { now, states, reviewStates }) {
  const legal = new Set(states);
  const counts = {};
  for (const s of states) counts[s] = 0;
  // A row whose state is outside the enum cannot happen today (every write goes through
  // transition()), but a legacy value left by an older schema, or a state retired from the table,
  // still has to be VISIBLE: dropping it would let the drain gate read zero while work was queued.
  // It rolls into this one documented field rather than a key named after the offending value:
  // the response's field set is a contract the runner's fixture tests machine-read, so a row in
  // the database must never be able to invent a key in it.
  let unknown = 0;
  for (const row of sql.exec("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").toArray()) {
    const state = String(row.state);
    const n = Number(row.n);
    if (legal.has(state)) counts[state] = n;
    else unknown += n;
  }

  const marks = reviewStates.map(() => "?").join(",");
  const reviewTotal = Number(
    sql.exec(`SELECT COUNT(*) AS n FROM jobs WHERE state IN (${marks})`, ...reviewStates).one().n,
  );

  // Seconds until the EARLIEST claimed lease is reclaimable. A remediation tick cannot take a job
  // back from a dead runner before its lease expires, so this is the wait the operator is in for.
  // Already past its expiry reads as 0 (reclaimable now), no claim at all reads as null.
  const earliest = sql
    .exec("SELECT MIN(lease_until) AS m FROM jobs WHERE state = 'claimed' AND lease_until IS NOT NULL")
    .one().m;

  return {
    ...counts,
    unknown,
    review_total: reviewTotal,
    next_claim_expiry_s: earliest == null ? null : Math.max(0, Math.ceil((Number(earliest) - now) / 1000)),
  };
}

/**
 * One-time shelve purge.
 *
 * Scope, deliberately narrow and entirely explicit:
 *   - every `unverified` row goes. Nobody confirmed those addresses and no demo will ever be
 *     built for them, so holding the email and the use case is holding lead data for nothing.
 *   - a `pending` or `delivery_failed` job goes ONLY if its slug is in the allowlist the caller
 *     sent. Both states are otherwise undrainable while the runner is off: the machine has no
 *     pending -> rejected edge and `delivery_failed` can only ever go to `emailed`, so a job Hugh
 *     declines to build, or one whose address the provider permanently rejects, would keep the
 *     drain gate unreachable forever. Each allowlisted slug is a per-job decision Hugh made.
 *   - a slug in the allowlist whose job is in ANY other state is refused, by name, and nothing
 *     about it is touched. The allowlist is not a licence to delete arbitrary rows.
 *
 * The bundle of a deleted job goes with it, exactly as `reject()` does it: `bundle()` resolves a
 * slug through the jobs table first, so a bundle whose job row is gone can never be served again,
 * and leaving it behind would keep the visitor's own description on disk with nothing pointing at
 * it. Every other row, bundle and suppression entry is untouched, and suppression especially:
 * an unsubscribe stays honoured after the purge.
 *
 * Idempotent. A second identical call deletes nothing, reports zero counts, and lists the
 * already-gone slugs under `not_found`.
 *
 * @param {object} sql
 * @param {object} opts
 * @param {string[]} opts.allowSlugs        slugs Hugh approved for deletion (already validated)
 * @param {string[]} opts.purgeableStates   states an allowlisted slug may be deleted from
 */
export function applyShelvePurge(sql, { allowSlugs = [], purgeableStates = [] } = {}) {
  const deleted = [];
  const refused = [];
  const notFound = [];
  let bundlesDeleted = 0;

  const drop = (row) => {
    const hadBundle = sql.exec("SELECT 1 AS x FROM bundles WHERE slug = ?", row.slug).toArray().length > 0;
    sql.exec("DELETE FROM jobs WHERE id = ?", row.id);
    if (hadBundle) {
      sql.exec("DELETE FROM bundles WHERE slug = ?", row.slug);
      bundlesDeleted += 1;
    }
    deleted.push({ slug: row.slug, state: row.state });
  };

  const unverified = sql.exec("SELECT id, slug, state FROM jobs WHERE state = 'unverified'").toArray();
  for (const row of unverified) drop(row);
  const unverifiedDeleted = unverified.length;

  // Deduped by the caller, but do it again here: the same slug twice must not double-count.
  for (const slug of [...new Set(allowSlugs)]) {
    const row = sql.exec("SELECT id, slug, state FROM jobs WHERE slug = ?", slug).toArray()[0];
    if (!row) {
      notFound.push(slug);
      continue;
    }
    if (!purgeableStates.includes(String(row.state))) {
      refused.push({ slug: row.slug, state: row.state });
      continue;
    }
    drop(row);
  }

  return {
    ok: true,
    unverified_deleted: unverifiedDeleted,
    allowlisted_deleted: deleted.length - unverifiedDeleted,
    bundles_deleted: bundlesDeleted,
    deleted,
    refused,
    not_found: notFound,
  };
}

/**
 * Signup-popup lead capture (POST /api/signup-lead). One statement per branch, no awaits, so the
 * whole read-modify-write stays atomic inside the DO's input gate: two visitors submitting the same
 * address in the same instant cannot both come out as `new` and both trigger a notification.
 *
 * Four outcomes, and the Worker answers 202 to all of them. The status is for the log and for
 * "does this deserve an email", never for the response body:
 *   new          a row was inserted. The only status that can earn a notification.
 *   duplicate    the address is already on the list. `last_seen` is bumped so a returning lead is
 *                visible in the export, and nothing else about the row is rewritten: the first
 *                capture's robot, src and dwell are the ones that describe how they arrived.
 *   capped       this IP has already created `ipCap` NEW leads inside `windowMs`. No row, no mail.
 *   daily_capped the whole route has already created `dailyCap` NEW leads this UTC day, from any
 *                IP at all. No row, no mail. This is the ceiling the per-IP cap cannot enforce: a
 *                flood spread across enough addresses never trips a single-IP window, and without
 *                this the table, the export and Hugh's inbox all grow without a bound.
 *
 * `notify` rides alongside, and it is decided HERE rather than in the Worker for the same reason
 * the dedupe is: the read and the write have to be one atomic step. `notifyBudget` notifications
 * per UTC day, counted off the same append-only events table the job cap uses. Past the budget a
 * lead is still inserted and still exported, and only the mail is skipped, so the budget can never
 * cost a lead. The budget is spent at the moment the decision is made, not when Resend answers: a
 * send that fails must not hand its slot back and turn a provider outage into a retry storm.
 *
 * Dedupe is checked BEFORE either cap on purpose. An address already on the list costs nothing to
 * re-see, and letting a cap swallow it would mean a lead who submits twice from an office NAT
 * silently stops updating.
 *
 * The caps count rows, not attempts: a duplicate does not consume budget, and neither does a
 * capped attempt (there is no row to count). So `ipCap` is exactly "new leads per IP per window"
 * and `dailyCap` is exactly "new leads per UTC day".
 *
 * `ipHash` is a keyed digest computed by the Worker. The raw IP never reaches this table.
 *
 * @param {object} sql
 * @param {object} opts
 * @param {string} opts.email     already lowercased and trimmed by the Worker
 * @param {string|null} opts.robot
 * @param {string|null} opts.src
 * @param {string|null} opts.role  one of worker/roles.js's VISITOR_ROLES, or null
 * @param {number|null} opts.dwellMs
 * @param {string} opts.ipHash
 * @param {number} opts.now       epoch ms
 * @param {number} opts.ipCap
 * @param {number} opts.windowMs
 * @param {number} opts.dailyCap      new leads this UTC day, across every IP
 * @param {number} opts.notifyBudget  notification emails this UTC day
 */
export function applyLeadCapture(
  sql,
  { email, robot, src, role, dwellMs, ipHash, now, ipCap, windowMs, dailyCap, notifyBudget },
) {
  const existing = sql.exec("SELECT email FROM leads WHERE email = ?", email).toArray()[0];
  if (existing) {
    // `last_seen` stays the ONLY column a repeat submission moves, and `role` is not an exception.
    // The row records what the visitor said the first time they asked us for access; a second post
    // from the same address is a returning visitor, not a correction, and letting it rewrite the
    // attribution would mean the export's oldest and most useful field is the one most easily
    // overwritten by anyone who knows the address.
    sql.exec("UPDATE leads SET last_seen = ? WHERE email = ?", now, email);
    return { ok: true, status: "duplicate", notify: false };
  }

  const recent = Number(
    sql.exec("SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ? AND created_at >= ?", ipHash, now - windowMs).one().n,
  );
  if (recent >= ipCap) return { ok: true, status: "capped", notify: false };

  // Counted off `events` rather than off `leads`, and that is deliberate: the events table is the
  // append-only ledger every other daily counter in this DO is derived from, it is indexed on
  // (day, kind), and a row deleted out of `leads` must not hand the day's budget back.
  const day = dayOf(now);
  const today = Number(
    sql.exec("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND day = ?", LEAD_EVENT, day).one().n,
  );
  if (today >= dailyCap) return { ok: true, status: "daily_capped", notify: false };

  sql.exec(
    `INSERT INTO leads(email, robot, src, role, dwell_ms, ip_hash, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    email,
    robot ?? null,
    src ?? null,
    role ?? null,
    dwellMs ?? null,
    ipHash,
    now,
    now,
  );
  sql.exec("INSERT INTO events(day, kind, job_id, at) VALUES (?, ?, NULL, ?)", day, LEAD_EVENT, now);

  const notified = Number(
    sql.exec("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND day = ?", LEAD_NOTIFY_EVENT, day).one().n,
  );
  const notify = notified < notifyBudget;
  if (notify) {
    sql.exec("INSERT INTO events(day, kind, job_id, at) VALUES (?, ?, NULL, ?)", day, LEAD_NOTIFY_EVENT, now);
  }

  return { ok: true, status: "new", notify };
}

/**
 * The export path (GET /api/signup-lead/list). Newest first, so the top of the list is the reason
 * Hugh opened it.
 *
 * `(before, beforeEmail)` is a COMPOUND cursor over the total ordering (created_at DESC, email
 * DESC). Email is unique in this table (dedupe collapses repeats), so the ordering has no ties and
 * the page after one ending at (T, E) starts exactly at the next row and can neither repeat nor
 * skip. A timestamp-only cursor cannot do this: two leads sharing a millisecond across a page
 * boundary would leave the second one unreachable forever. It is the ordering key itself rather
 * than an offset, because an offset over a table that grows at the top would re-serve rows every
 * time a new lead landed mid-page.
 *
 * `ip_hash` is deliberately NOT projected. It is a rate-limit bucket, not a fact about the lead,
 * and an export that carries it is an export that has to be handled like one that carries IPs.
 * Timestamps go out as ISO strings, the same convention `review()` and `approvalView()` use.
 */
export function selectLeads(sql, { limit = 1000, before = null, beforeEmail = null } = {}) {
  const rows =
    before == null
      ? sql
          .exec(
            `SELECT email, robot, src, role, dwell_ms, created_at, last_seen
             FROM leads ORDER BY created_at DESC, email DESC LIMIT ?`,
            limit,
          )
          .toArray()
      : beforeEmail == null
        ? sql
            .exec(
              `SELECT email, robot, src, role, dwell_ms, created_at, last_seen
               FROM leads WHERE created_at < ? ORDER BY created_at DESC, email DESC LIMIT ?`,
              before,
              limit,
            )
            .toArray()
        : sql
            .exec(
              `SELECT email, robot, src, role, dwell_ms, created_at, last_seen
               FROM leads WHERE created_at < ? OR (created_at = ? AND email < ?)
               ORDER BY created_at DESC, email DESC LIMIT ?`,
              before,
              before,
              beforeEmail,
              limit,
            )
            .toArray();
  return rows.map((r) => ({
    email: r.email,
    robot: r.robot,
    src: r.src,
    // NULL for every row captured before the picker shipped, and for every visitor who skipped it.
    // `?? null` rather than a default: guessing "engineer" for a row that never recorded one would
    // put a number in this export that nobody ever told us, which is exactly what an export is for
    // avoiding.
    role: r.role ?? null,
    dwell_ms: r.dwell_ms == null ? null : Number(r.dwell_ms),
    created_at: new Date(Number(r.created_at)).toISOString(),
    last_seen: new Date(Number(r.last_seen)).toISOString(),
  }));
}
