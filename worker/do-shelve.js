// do-shelve.js - the two shelve-time SQL helpers DemoGenDO delegates to.
//
// They live outside do.js for one reason: do.js imports `DurableObject` from "cloudflare:workers",
// which only exists inside workerd, so nothing in that file can be driven from a plain-node test.
// These two functions are the whole of the new behaviour, they touch nothing but the `sql` handle
// they are handed, and worker/demo-gen.unit.test.mjs runs them against the REAL schema on
// node:sqlite. The DO keeps ownership of what they are called with: the state enum, the review
// states and the purgeable states are all passed in from do.js, which stays the single source of
// truth for the machine's shape.
//
// `sql` is Cloudflare's SqlStorage: `exec(query, ...bindings)` returning a cursor with
// `.toArray()` and `.one()`. Nothing here awaits, so each call stays atomic inside the DO's
// input gate exactly like the rest of do.js.

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
