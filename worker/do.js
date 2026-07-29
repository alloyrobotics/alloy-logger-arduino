// do.js - DemoGenDO, the serialization point for the personalized-demo generator.
//
// One named instance ("main") owns every piece of mutable state in the funnel: the job
// state machine, the claim leases, the dedupe window, the rate windows, the daily cap,
// the published bundles and the suppression list. KV has no CAS, so a lost write there
// is a lost lead; here every read-modify-write below is one SQL statement inside the
// DO's input gate, and no two of them can interleave.
//
// The Worker (demo-gen.js) does all of the async crypto (sha256, HMAC) BEFORE calling in,
// so every method here is straight-line synchronous SQL. That keeps each method atomic:
// an `await` in the middle of a transition would open a window for another request.
//
// State machine (guarded, see LEGAL_TRANSITIONS):
//   unverified -> pending -> claimed -> generated -> approved -> emailed
// terminals: rejected, refused, error, delivery_failed, expired.

import { DurableObject } from "cloudflare:workers";

import { applyLeadCapture, applyShelvePurge, computeStateSnapshot, selectLeads } from "./do-shelve.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A generation job that has not published inside the lease is dead and goes back in the
 *  queue. Overridable only so the lease-expiry path is testable without a 30 minute wait. */
const DEFAULT_LEASE_MS = 30 * 60_000;
const DEDUPE_WINDOW_MS = 30 * DAY_MS;

/** Same alphabet for job ids and slugs: RFC 4648 base32, lowercased. 32 divides 256, so
 *  masking a random byte with 31 is uniform - no rejection sampling needed. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

const SUBMITS_PER_IP_HOUR = 3;
const SUBMITS_PER_EMAIL_DAY = 2;

// Every transition the machine allows. Anything else is a 409 for the caller.
// Notes on the less obvious edges:
//  - claimed -> pending: the runner handing a lease back after a clean abort.
//  - pending -> error: a job that has burned its attempt budget being retired by claim().
//  - generated -> emailed: the 48h stale sweep mails an apology without an approval.
//  - approved -> rejected: Hugh changing his mind before the runner picks the job up.
//  - delivery_failed -> emailed: a retried send that lands.
const LEGAL_TRANSITIONS = {
  unverified: ["pending", "expired"],
  pending: ["claimed", "expired", "error"],
  claimed: ["generated", "pending", "error", "refused", "expired"],
  generated: ["approved", "rejected", "error", "expired", "emailed", "delivery_failed"],
  approved: ["emailed", "delivery_failed", "rejected"],
  refused: ["emailed", "delivery_failed"],
  error: ["emailed", "delivery_failed"],
  expired: ["emailed", "delivery_failed"],
  delivery_failed: ["emailed"],
  emailed: [],
  rejected: [],
};

/**
 * The machine's full state enum, derived from the transition table above so the two can never
 * drift. This is what `runnerState()` reports one count per, and the drain gate for the shelve
 * reads those counts directly, so a state missing from here would read as an empty queue.
 */
const ALL_STATES = Object.keys(LEGAL_TRANSITIONS);

/** States an explicitly allowlisted slug may be deleted from by the one-time shelve purge. */
const SHELF_PURGEABLE_STATES = ["pending", "delivery_failed"];

/** States a job can be in and still be worth talking about in the queue counters. */
const OPEN_STATES = ["unverified", "pending", "claimed", "generated", "approved"];
/**
 * States the runner's delivery sweep has an email template for.
 * `delivery_failed` is in the list because a job that reached it has an email that WAS composed
 * and did not land. Leaving it out made the state a black hole: nothing ever listed the job
 * again, so the retry the `delivery_failed -> emailed` edge exists for could never happen.
 */
const REVIEW_STATES = ["generated", "approved", "refused", "error", "expired", "delivery_failed"];

/** Generation attempts after which a job is poison and stops being claimable. */
const MAX_ATTEMPTS = 3;
/**
 * States whose bundle the live analyst (worker/chat.js) will answer questions about.
 * Deliberately one state wider than the def.json serving gate: a demo Hugh is previewing from
 * the confirm page sits in `generated`, and a preview whose chat panel 400s is not a preview of
 * anything. Widening leaks nothing: the slug is 100 bits of unguessable secret, the pack is
 * derived from the same bundle the def.json would hand over, and `reject` deletes the bundle,
 * so a rejected demo stops answering the moment it stops serving.
 */
const CHATTABLE_STATES = ["generated", "approved", "emailed"];

function randB32(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < n; i++) out += B32[bytes[i] & 31];
  return out;
}

function randHex(nBytes) {
  const bytes = new Uint8Array(nBytes);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10); // UTC; the daily cap is a UTC day
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function illegal(from, to) {
  return { ok: false, error: "illegal_transition", from, to };
}

export class DemoGenDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      email TEXT NOT NULL,
      use_case TEXT NOT NULL,
      robot_seen TEXT,
      ip_hash TEXT,
      ua TEXT,
      dedupe_key TEXT,
      claim_token TEXT,
      lease_until INTEGER,
      attempts TEXT,
      robot_name TEXT,
      device_id TEXT,
      email_summary TEXT,
      approved_at INTEGER,
      approved_by TEXT,
      emailed_at INTEGER,
      message_id TEXT,
      error TEXT
    );`);
    sql.exec(`CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, created_at);`);
    sql.exec(`CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe_key, created_at);`);

    sql.exec(`CREATE TABLE IF NOT EXISTS bundles(
      slug TEXT PRIMARY KEY,
      def_json TEXT NOT NULL,
      facts_json TEXT,
      published_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL
    );`);

    // Append-only. Counters, rate windows and the daily cap are all derived from here,
    // so nothing in this table is ever updated in place.
    sql.exec(`CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      job_id TEXT,
      at INTEGER NOT NULL
    );`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_kind_at ON events(kind, at);`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_day_kind ON events(day, kind);`);

    sql.exec(`CREATE TABLE IF NOT EXISTS suppression(
      email TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    );`);

    // Signup-popup leads (worker/signup-lead.js). Nothing to do with the job state machine above:
    // a lead is one address and how it got here, with no lifecycle at all. The email is the primary
    // key, which is what makes dedupe a constraint rather than a query, and `last_seen` is the only
    // column a repeat submission ever moves. `ip_hash` is the Worker's keyed digest and exists only
    // to hold the per-IP daily cap; the raw IP is never stored here or anywhere else.
    sql.exec(`CREATE TABLE IF NOT EXISTS leads(
      email TEXT PRIMARY KEY,
      robot TEXT,
      src TEXT,
      dwell_ms INTEGER,
      ip_hash TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );`);
    sql.exec(`CREATE INDEX IF NOT EXISTS leads_ip_at ON leads(ip_hash, created_at);`);
  }

  // ---------------------------------------------------------------- internals

  get sql() {
    return this.ctx.storage.sql;
  }

  get leaseMs() {
    const raw = Number(this.env?.DEMOGEN_LEASE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_MS;
  }

  emit(kind, jobId, at) {
    const ms = at ?? Date.now();
    this.sql.exec(
      "INSERT INTO events(day, kind, job_id, at) VALUES (?, ?, ?, ?)",
      dayOf(ms),
      kind,
      jobId ?? null,
      ms,
    );
  }

  countSince(kind, sinceMs) {
    const row = this.sql
      .exec("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ?", kind, sinceMs)
      .one();
    return Number(row.n);
  }

  job(id) {
    return this.sql.exec("SELECT * FROM jobs WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** Leases are reclaimed lazily: a job whose runner died goes back to pending on the
   *  next queue/claim, with attempts preserved so the retry budget still counts. */
  reclaimExpired(now) {
    const stale = this.sql
      .exec("SELECT id FROM jobs WHERE state = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?", now)
      .toArray();
    for (const row of stale) {
      this.sql.exec(
        "UPDATE jobs SET state = 'pending', claim_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?",
        now,
        row.id,
      );
      this.emit("lease_reclaimed", row.id, now);
    }
    return stale.length;
  }

  /** The one place a state ever changes. Returns null on success, an error object on a
   *  transition the machine does not allow. */
  transition(row, to, now, extraSql = "", extraArgs = []) {
    const allowed = LEGAL_TRANSITIONS[row.state] ?? [];
    if (!allowed.includes(to)) return illegal(row.state, to);
    this.sql.exec(
      `UPDATE jobs SET state = ?, updated_at = ?${extraSql} WHERE id = ?`,
      to,
      now,
      ...extraArgs,
      row.id,
    );
    this.emit(to, row.id, now);
    return null;
  }

  // ------------------------------------------------------------------ public

  /**
   * Suppression, rate, dedupe and creation, in that order, atomically.
   * The Worker has already validated shape and computed every hash.
   */
  submit({ email, emailHash, useCase, robotSeen, ipHash, ua, dedupeKey, now }) {
    const at = now ?? Date.now();

    const suppressed = this.sql.exec("SELECT 1 AS x FROM suppression WHERE email = ?", email).toArray();
    if (suppressed.length > 0) {
      this.emit("submit_suppressed", null, at);
      return { ok: true, suppressed: true };
    }

    if (this.countSince(`submit_ip:${ipHash}`, at - HOUR_MS) >= SUBMITS_PER_IP_HOUR) {
      this.emit("rate_block_ip", null, at);
      return { ok: false, reason: "rate" };
    }
    if (this.countSince(`submit_email:${emailHash}`, at - DAY_MS) >= SUBMITS_PER_EMAIL_DAY) {
      this.emit("rate_block_email", null, at);
      return { ok: false, reason: "rate" };
    }

    const prior = this.sql
      .exec(
        "SELECT id, slug, state FROM jobs WHERE dedupe_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
        dedupeKey,
        at - DEDUPE_WINDOW_MS,
      )
      .toArray()[0];
    if (prior) {
      // The caller answers generically either way. Nothing is enqueued: if the prior job
      // already emailed, the visitor has the link; if it has not, it is still coming.
      this.emit("submit_dedupe", prior.id, at);
      this.emit(`submit_ip:${ipHash}`, prior.id, at);
      this.emit(`submit_email:${emailHash}`, prior.id, at);
      return { ok: true, duplicate: true, prior_state: prior.state, slug: prior.slug };
    }

    const id = randB32(22);
    // The slug is a SEPARATE secret from the job id: the id shows up in signed tokens
    // Hugh clicks, the slug is the unguessable public URL. Neither derives from the other.
    let slug = randB32(20);
    for (let i = 0; i < 5; i++) {
      const clash = this.sql.exec("SELECT 1 AS x FROM jobs WHERE slug = ?", slug).toArray();
      if (clash.length === 0) break;
      slug = randB32(20);
    }

    this.sql.exec(
      `INSERT INTO jobs(id, slug, state, created_at, updated_at, email, use_case, robot_seen,
                        ip_hash, ua, dedupe_key, attempts)
       VALUES (?, ?, 'unverified', ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      id,
      slug,
      at,
      at,
      email,
      useCase,
      robotSeen ?? null,
      ipHash,
      ua ?? null,
      dedupeKey,
    );
    this.emit("submit", id, at);
    this.emit(`submit_ip:${ipHash}`, id, at);
    this.emit(`submit_email:${emailHash}`, id, at);

    return { ok: true, job: { id, slug, email, use_case: useCase } };
  }

  /** Records a bare counter for the Worker (honeypot, dwell, gen_view, ...). */
  note(kind, jobId) {
    this.emit(kind, jobId ?? null);
    return { ok: true };
  }

  /** Single-use by construction: only unverified -> pending does anything. */
  verify(jobId, now) {
    const at = now ?? Date.now();
    const row = this.job(jobId);
    if (!row) return { status: "unknown" };
    if (row.state !== "unverified") return { status: "already", state: row.state };
    const err = this.transition(row, "pending", at);
    if (err) return { status: "already", state: row.state };
    return { status: "confirmed" };
  }

  suppress(email, now) {
    const at = now ?? Date.now();
    this.sql.exec("INSERT OR REPLACE INTO suppression(email, at) VALUES (?, ?)", email, at);
    this.emit("unsubscribe", null, at);
    return { ok: true };
  }

  queue(now) {
    const at = now ?? Date.now();
    this.reclaimExpired(at);
    const count = (states) => {
      const marks = states.map(() => "?").join(",");
      return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM jobs WHERE state IN (${marks})`, ...states).one().n);
    };
    const oldest = this.sql
      .exec("SELECT MIN(created_at) AS m FROM jobs WHERE state = 'pending'")
      .one().m;
    this.emit("runner_seen", null, at);
    const claimable = count(["pending"]);
    return {
      open: count(OPEN_STATES),
      claimable,
      approved_unsent: count(["approved"]),
      // Aliases the runner's api.mjs already reads.
      pending: claimable,
      oldest_age_s: oldest == null ? 0 : Math.max(0, Math.round((at - Number(oldest)) / 1000)),
      claimed_today: this.sql
        .exec("SELECT COUNT(*) AS n FROM events WHERE kind = 'claimed' AND day = ?", dayOf(at))
        .one().n,
    };
  }

  claim(runner, now, maxPerDay) {
    const at = now ?? Date.now();
    this.reclaimExpired(at);

    // Number.isFinite, not `|| 8`: `DEMOGEN_MAX_JOBS_PER_DAY=0` is a deliberate pause of the
    // funnel, and `Number("0") || 8` silently turned that pause into the default cap.
    const parsed = Number(maxPerDay);
    const cap = Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
    const today = Number(
      this.sql.exec("SELECT COUNT(*) AS n FROM events WHERE kind = 'claimed' AND day = ?", dayOf(at)).one().n,
    );
    if (today >= cap) return { job: null, reason: "daily_cap", claimed_today: today, cap };

    // Defense in depth against a poison job. The runner refuses to generate one that has already
    // burned its attempts, but a runner with that check disabled, or an older one, would re-claim
    // the same failing job every tick forever. Here it is retired server-side instead: at the cap
    // the job goes to `error` (which the delivery sweep then apologises for) and the claim moves
    // on to the next pending one. The bound is the queue itself, one retirement per iteration.
    let row = null;
    for (let i = 0; i < 16; i++) {
      const candidate = this.sql
        .exec("SELECT * FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1")
        .toArray()[0];
      if (!candidate) break;
      let attempts = [];
      try {
        attempts = candidate.attempts ? JSON.parse(candidate.attempts) : [];
      } catch {
        attempts = [];
      }
      const n = Array.isArray(attempts) ? attempts.length : Number(attempts) || 0;
      if (n < MAX_ATTEMPTS) {
        row = candidate;
        break;
      }
      this.transition(candidate, "error", at, ", error = ?", ["attempts_exhausted"]);
      this.emit("attempts_exhausted", candidate.id, at);
    }
    if (!row) return { job: null };

    const claimToken = randHex(24);
    const err = this.transition(row, "claimed", at, ", claim_token = ?, lease_until = ?", [
      claimToken,
      at + this.leaseMs,
    ]);
    if (err) return { job: null, ...err };

    this.emit("runner_seen", null, at);
    return {
      job: {
        id: row.id,
        slug: row.slug,
        email: row.email,
        use_case: row.use_case,
        robot_seen: row.robot_seen,
        created_at: iso(Number(row.created_at)),
        attempts: row.attempts ? JSON.parse(row.attempts) : [],
        claim_token: claimToken,
        lease_until: iso(at + this.leaseMs),
        runner: runner ?? null,
      },
      claim_token: claimToken,
    };
  }

  /** Create-only. The slug is never taken from the request: it comes off the job row. */
  publish({ jobId, claimToken, defJson, factsJson, robotName, deviceId, emailSummary, bytes, sha256, now }) {
    const at = now ?? Date.now();
    const row = this.job(jobId);
    if (!row) return { ok: false, error: "unknown_job" };
    if (row.state !== "claimed") return illegal(row.state, "generated");
    if (!row.claim_token || row.claim_token !== claimToken) return { ok: false, error: "bad_claim_token" };

    this.sql.exec(
      `INSERT INTO bundles(slug, def_json, facts_json, published_at, bytes, sha256)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET def_json = excluded.def_json, facts_json = excluded.facts_json,
                                       published_at = excluded.published_at, bytes = excluded.bytes,
                                       sha256 = excluded.sha256`,
      row.slug,
      defJson,
      factsJson ?? null,
      at,
      bytes,
      sha256,
    );

    const err = this.transition(row, "generated", at, ", robot_name = ?, device_id = ?, email_summary = ?, claim_token = NULL, lease_until = NULL", [
      robotName ?? null,
      deviceId ?? null,
      emailSummary ?? null,
    ]);
    if (err) return err;
    return { ok: true, slug: row.slug, sha256 };
  }

  /**
   * Runner-driven transition. The claim token is REQUIRED to leave `claimed` (that is the
   * lease being spent) and ignored elsewhere, because the delivery sweep works off review
   * rows that never carried one. Bearer auth still gates the whole route.
   */
  status({ jobId, claimToken, state, error, messageId, attempts, now }) {
    const at = now ?? Date.now();
    const row = this.job(jobId);
    if (!row) return { ok: false, error: "unknown_job" };
    if (row.state === "claimed" && (!row.claim_token || row.claim_token !== claimToken)) {
      return { ok: false, error: "bad_claim_token" };
    }

    let extraSql = "";
    const extraArgs = [];
    if (row.state === "claimed") {
      extraSql += ", claim_token = NULL, lease_until = NULL";
    }
    if (error != null) {
      extraSql += ", error = ?";
      extraArgs.push(String(error).slice(0, 500));
    }
    if (attempts != null) {
      extraSql += ", attempts = ?";
      extraArgs.push(JSON.stringify(attempts).slice(0, 4000));
    }
    if (state === "emailed") {
      extraSql += ", emailed_at = ?, message_id = ?";
      extraArgs.push(at, messageId == null ? null : String(messageId).slice(0, 200));
    }
    if (state === "approved") {
      extraSql += ", approved_at = ?, approved_by = ?";
      extraArgs.push(at, "runner-timer");
    }

    const err = this.transition(row, state, at, extraSql, extraArgs);
    if (err) return err;
    return { ok: true, state };
  }

  review(now) {
    const at = now ?? Date.now();
    this.reclaimExpired(at);
    const marks = REVIEW_STATES.map(() => "?").join(",");
    const rows = this.sql
      .exec(
        `SELECT id, slug, state, robot_name, use_case, email, email_summary, device_id,
                created_at, updated_at, approved_at, error
         FROM jobs WHERE state IN (${marks}) ORDER BY created_at ASC`,
        ...REVIEW_STATES,
      )
      .toArray();
    this.emit("runner_seen", null, at);
    return {
      jobs: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        state: r.state,
        robot_name: r.robot_name,
        use_case: r.use_case,
        email: r.email,
        email_summary: r.email_summary,
        device_id: r.device_id,
        created_at: iso(Number(r.created_at)),
        updated_at: iso(Number(r.updated_at)),
        // The runner reads generated_at first for its staleness clock; for a job sitting in
        // `generated` that is exactly when it entered the state.
        generated_at: r.state === "generated" ? iso(Number(r.updated_at)) : null,
        approved_at: r.approved_at == null ? null : iso(Number(r.approved_at)),
        error: r.error,
      })),
    };
  }

  /** Everything the approval confirm page needs, in one round trip. */
  approvalView(jobId) {
    const row = this.job(jobId);
    if (!row) return { ok: false, error: "unknown_job" };
    const bundle = this.sql.exec("SELECT bytes, sha256 FROM bundles WHERE slug = ?", row.slug).toArray()[0];
    return {
      ok: true,
      job: {
        id: row.id,
        slug: row.slug,
        state: row.state,
        robot_name: row.robot_name,
        email_summary: row.email_summary,
        use_case: row.use_case,
        email: row.email,
        device_id: row.device_id,
        created_at: iso(Number(row.created_at)),
      },
      bundle: bundle ? { bytes: Number(bundle.bytes), sha256: bundle.sha256 } : null,
    };
  }

  approve(jobId, now, by) {
    const at = now ?? Date.now();
    const row = this.job(jobId);
    if (!row) return { ok: false, error: "unknown_job" };
    // Single-use: a second click finds the job in `approved` and gets a 409-shaped answer
    // the page renders as "already approved".
    const err = this.transition(row, "approved", at, ", approved_at = ?, approved_by = ?", [
      at,
      (by ?? "link").slice(0, 64),
    ]);
    if (err) return err;
    return { ok: true, slug: row.slug };
  }

  reject(jobId, now) {
    const at = now ?? Date.now();
    const row = this.job(jobId);
    if (!row) return { ok: false, error: "unknown_job" };
    const err = this.transition(row, "rejected", at);
    if (err) return err;
    // The bundle goes with it: a rejected demo must stop being servable immediately.
    this.sql.exec("DELETE FROM bundles WHERE slug = ?", row.slug);
    return { ok: true, slug: row.slug };
  }

  /** Serving path. `preview` skips the approved gate for Hugh's signed pre-approval look. */
  bundle(slug, { preview = false } = {}) {
    const row = this.sql.exec("SELECT id, state FROM jobs WHERE slug = ?", slug).toArray()[0];
    if (!row) return { ok: false, error: "not_found" };
    if (!preview && row.state !== "approved" && row.state !== "emailed") {
      return { ok: false, error: "not_approved", state: row.state };
    }
    const bundle = this.sql.exec("SELECT def_json, sha256 FROM bundles WHERE slug = ?", slug).toArray()[0];
    if (!bundle) return { ok: false, error: "not_found" };
    return { ok: true, job_id: row.id, def_json: bundle.def_json, sha256: bundle.sha256 };
  }

  /**
   * Chat path. The facts pack the runner published for this slug: `{ facts, evidenceIds, ... }`,
   * the same shape worker/facts.generated.js holds for the canned robots. Returns the
   * parsed object so chat.js never handles the stored JSON itself.
   */
  factsPack(slug) {
    const row = this.sql.exec("SELECT id, state FROM jobs WHERE slug = ?", slug).toArray()[0];
    if (!row) return { ok: false, error: "not_found" };
    if (!CHATTABLE_STATES.includes(row.state)) return { ok: false, error: "not_chattable", state: row.state };
    const bundle = this.sql.exec("SELECT facts_json FROM bundles WHERE slug = ?", slug).toArray()[0];
    if (!bundle || bundle.facts_json == null) return { ok: false, error: "no_facts" };
    let pack;
    try {
      pack = JSON.parse(bundle.facts_json);
    } catch {
      // Stored bytes are the runner's; a parse failure here is a publish-side bug, not a caller
      // one, so it reads as "no live analyst for this demo" rather than a 500.
      return { ok: false, error: "bad_facts" };
    }
    return { ok: true, job_id: row.id, pack };
  }

  /** Slug for a job id, so the preview token can be checked against the requested path. */
  slugFor(jobId) {
    const row = this.sql.exec("SELECT slug FROM jobs WHERE id = ?", jobId).toArray()[0];
    return row ? row.slug : null;
  }

  // ------------------------------------------------------------------ shelve

  /**
   * Counts per state plus the earliest reclaimable lease, for the drain gate the shelve runs
   * against (`GET /api/demo-gen/runner/state`). READ ONLY, and that is the whole point: unlike
   * `queue()` and `review()` it does not call `reclaimExpired()` and does not emit `runner_seen`,
   * so polling it while the queue drains cannot itself move a job or restart the staleness clock.
   */
  runnerState(now) {
    return computeStateSnapshot(this.sql, {
      now: now ?? Date.now(),
      states: ALL_STATES,
      reviewStates: REVIEW_STATES,
    });
  }

  /**
   * The one-time shelve purge. Deletes every `unverified` row, plus `pending` and
   * `delivery_failed` jobs whose slug Hugh put on the allowlist, and nothing else. Scope,
   * refusals and idempotence all live in do-shelve.js. The route in front of this only exists
   * while `DEMOGEN_SHELF_PURGE=1` is set, so there is no standing bulk-delete surface.
   */
  shelvePurge({ allowSlugs = [], now } = {}) {
    const at = now ?? Date.now();
    const res = applyShelvePurge(this.sql, { allowSlugs, purgeableStates: SHELF_PURGEABLE_STATES });
    this.emit("shelf_purge", null, at);
    return res;
  }

  // ------------------------------------------------------------------ signup leads

  /**
   * Capture one signup-popup lead: dedupe, per-IP cap, global daily cap, insert and the day's
   * notification budget, atomically. Returns `{ ok, status, notify }` with status `new`,
   * `duplicate`, `capped` or `daily_capped`; the Worker answers 202 to all four and only mails
   * Hugh when the status is `new` AND `notify` is true. Scope and reasoning live in do-shelve.js.
   *
   * Nothing else in this class reads or writes the `leads` table. It also appends two event kinds
   * (`signup_lead`, `signup_lead_notified`) to the shared append-only `events` ledger, which is
   * where every daily counter in this DO lives; it writes to no other table, so a popup submission
   * still cannot move a demo job.
   */
  recordLead({ email, robot, src, dwellMs, ipHash, now, ipCap, windowMs, dailyCap, notifyBudget }) {
    return applyLeadCapture(this.sql, {
      email,
      robot,
      src,
      dwellMs,
      ipHash,
      now: now ?? Date.now(),
      ipCap,
      windowMs,
      dailyCap,
      notifyBudget,
    });
  }

  /**
   * The export path. Newest first, no `ip_hash`, ISO timestamps. `(before, beforeEmail)` is a
   * compound cursor over the total ordering (created_at DESC, email DESC): rows come back strictly
   * after that position, so the Worker can page the table without an offset that would shift under
   * it as new leads land at the top, and without a millisecond tie ever hiding a row.
   */
  listLeads(limit, before = null, beforeEmail = null) {
    return selectLeads(this.sql, { limit, before, beforeEmail });
  }

  /** Read-only introspection for the curl matrix and the funnel digest. */
  debug(jobId) {
    if (jobId) return { job: this.job(jobId) };
    return {
      jobs: this.sql
        .exec("SELECT id, slug, state, email, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT 50")
        .toArray(),
      events: this.sql.exec("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind").toArray(),
      suppression: this.sql.exec("SELECT email FROM suppression").toArray(),
      bundles: this.sql.exec("SELECT slug, bytes, sha256 FROM bundles").toArray(),
    };
  }
}

export default DemoGenDO;
