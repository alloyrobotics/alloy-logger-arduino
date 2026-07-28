// demo-gen.unit.test.mjs - the shelve's executable contract for worker/demo-gen.js.
//
//   node --test worker/demo-gen.unit.test.mjs
//
// worker/demo-gen.test.md is the curl matrix against a real `wrangler dev`, and it stays the
// integration layer. This file is the part that must not need a running Worker: the submit
// tombstone's ZERO SIDE EFFECTS, the paused verify making no state transition, and the two new
// runner routes' auth, shape and read-only-ness. A prose assertion cannot fail a build; this can.
//
// How it runs outside workerd at all:
//   - demo-gen.js imports nothing and uses only Request/Response/Headers/crypto.subtle/btoa,
//     all of which Node has, so the real handler is exercised, not a copy of it.
//   - do.js cannot be imported here (it imports "cloudflare:workers"), so the DO is a stub whose
//     two new methods call the REAL helpers from do-shelve.js against the REAL schema, read out
//     of do.js's own source and run on node:sqlite. The state enum, the review states and the
//     purgeable states are read out of do.js too, so this file cannot silently drift from the
//     machine it is asserting about.
//   - no test here makes an outbound fetch. `fetch` is replaced by a throwing stub for the
//     tombstone cases, which is also how "zero Resend sends" is proved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import handleDemoGen from './demo-gen.js';
import { applyShelvePurge, computeStateSnapshot } from './do-shelve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DO_SRC = readFileSync(join(HERE, 'do.js'), 'utf8');

const TOKEN = 'test-runner-token-12345';
const SIGNING_KEY = 'test-signing-key-0123456789abcdef';

// ---------------------------------------------------------------------------------------------
// do.js is the source of truth, so read the shapes out of it rather than restating them
// ---------------------------------------------------------------------------------------------

/** Every key of LEGAL_TRANSITIONS, which the plan names as the normative state enum. */
function parseStates(src) {
  const block = /const LEGAL_TRANSITIONS = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'could not find LEGAL_TRANSITIONS in do.js');
  const states = [...block[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(states.length >= 10, `parsed only ${states.length} states out of do.js`);
  return states;
}

function parseStringArray(src, name) {
  const m = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(src);
  assert.ok(m, `could not find ${name} in do.js`);
  return JSON.parse(m[1].replace(/'/g, '"'));
}

/** The CREATE statements out of the DO constructor, so the fixture runs the real schema. */
function parseSchema(src) {
  const stmts = [...src.matchAll(/sql\.exec\(\s*`\s*(CREATE[\s\S]*?)`\s*\)/g)].map((m) => m[1]);
  assert.ok(stmts.length >= 6, `parsed only ${stmts.length} CREATE statements out of do.js`);
  return stmts;
}

const STATES = parseStates(DO_SRC);
const REVIEW_STATES = parseStringArray(DO_SRC, 'REVIEW_STATES');
const PURGEABLE_STATES = parseStringArray(DO_SRC, 'SHELF_PURGEABLE_STATES');
const SCHEMA = parseSchema(DO_SRC);

// ---------------------------------------------------------------------------------------------
// a DO stub with the real SQL behind it
// ---------------------------------------------------------------------------------------------

/** Cloudflare's SqlStorage surface (exec -> cursor with toArray/one) over node:sqlite. */
function sqlHandle(db) {
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`one() expected exactly 1 row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
}

function freshDb(t) {
  const db = new DatabaseSync(':memory:');
  for (const stmt of SCHEMA) db.exec(stmt);
  t.after(() => db.close());
  return db;
}

// The same alphabet do.js mints ids and slugs from, so a seeded slug passes the Worker's own
// `^[a-z2-7]{20}$` gate instead of being rejected before the purge ever sees it.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function b32seq(n, len) {
  let out = '';
  let v = n;
  for (let i = 0; i < len; i++) {
    out = B32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

let seedN = 0;
/** One job row. `slug` and `id` are generated unless given, so seeding stays one line per job. */
function seedJob(db, { state, slug, id, email, useCase = 'a robot that does a thing on a shop floor', leaseUntil = null, claimToken = null }) {
  seedN += 1;
  const jobId = id ?? b32seq(seedN, 22);
  const jobSlug = slug ?? b32seq(seedN, 20);
  const at = Date.now();
  db.prepare(
    `INSERT INTO jobs(id, slug, state, created_at, updated_at, email, use_case, ip_hash, dedupe_key,
                      attempts, claim_token, lease_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'iphash', ?, '[]', ?, ?)`,
  ).run(jobId, jobSlug, state, at, at, email ?? `seed${seedN}@example.com`, useCase, `dedupe${seedN}`, claimToken, leaseUntil);
  return { id: jobId, slug: jobSlug };
}

function seedBundle(db, slug) {
  db.prepare('INSERT INTO bundles(slug, def_json, published_at, bytes, sha256) VALUES (?, ?, ?, ?, ?)')
    .run(slug, '{"robot_name":"seed"}', Date.now(), 22, 'deadbeef');
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function stateOf(db, id) {
  return db.prepare('SELECT state FROM jobs WHERE id = ?').get(id)?.state ?? null;
}

/**
 * The DO the Worker sees. The two shelve methods run the real do-shelve.js helpers; everything
 * else throws, so a route that reaches for a method it has no business calling fails loudly.
 * `verify` is implemented (and would really move the row) purely so the paused verify page can be
 * asserted as "did not transition" rather than "could not have".
 */
function makeDoStub(db, calls = []) {
  const sql = sqlHandle(db);
  return {
    runnerState: async (now) => {
      calls.push('runnerState');
      return computeStateSnapshot(sql, { now, states: STATES, reviewStates: REVIEW_STATES });
    },
    shelvePurge: async ({ allowSlugs, now }) => {
      calls.push('shelvePurge');
      const res = applyShelvePurge(sql, { allowSlugs, purgeableStates: PURGEABLE_STATES });
      // The real DemoGenDO emits one event beside the purge; mirror it so "every other row is
      // preserved" is asserted against a table the purge really does write to.
      db.prepare('INSERT INTO events(day, kind, job_id, at) VALUES (?, ?, ?, ?)')
        .run('2026-07-28', 'shelf_purge', null, now ?? Date.now());
      return res;
    },
    verify: async (jobId) => {
      calls.push('verify');
      db.prepare("UPDATE jobs SET state = 'pending' WHERE id = ? AND state = 'unverified'").run(jobId);
      return { status: 'confirmed' };
    },
    note: async () => {
      throw new Error('DO.note() must not be reached');
    },
    submit: async () => {
      throw new Error('DO.submit() must not be reached');
    },
  };
}

function envWith(db, extra = {}, calls = []) {
  const stub = makeDoStub(db, calls);
  return {
    DEMOGEN_TOKEN: TOKEN,
    DEMOGEN_SIGNING_KEY: SIGNING_KEY,
    DEMOGEN_DO: { idFromName: () => 'main-id', get: () => stub },
    ...extra,
  };
}

const noopCtx = { waitUntil: () => {} };

function callWorker(request, env, ctx = noopCtx) {
  return handleDemoGen(request, env, ctx, new URL(request.url));
}

function get(path, { bearer, ...init } = {}) {
  return new Request(`https://alloylogger.com${path}`, {
    ...init,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(init.headers || {}) },
  });
}

function postJson(path, body, { bearer } = {}) {
  return new Request(`https://alloylogger.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function assertNoStore(res, what) {
  assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${what} must answer no-store`);
}

// ---------------------------------------------------------------------------------------------
// submit tombstone: 410, no-store, and provably zero side effects
// ---------------------------------------------------------------------------------------------

/**
 * A request that answers headers and nothing else. Every way of getting at the body throws, so a
 * handler that reads one fails this test instead of quietly costing a body read on every bot.
 */
function boobyTrappedRequest(method, headers, shape) {
  return {
    method,
    url: 'https://alloylogger.com/api/demo-gen/submit',
    // The shape is carried, not served: the point is that nothing may reach it.
    _shape: shape,
    headers: new Headers(headers),
    get body() {
      throw new Error('request.body was read by the tombstone');
    },
    text: async () => {
      throw new Error('request.text() was called by the tombstone');
    },
    json: async () => {
      throw new Error('request.json() was called by the tombstone');
    },
    arrayBuffer: async () => {
      throw new Error('request.arrayBuffer() was called by the tombstone');
    },
    formData: async () => {
      throw new Error('request.formData() was called by the tombstone');
    },
  };
}

/** env whose every property access throws: the tombstone may not look up the DO, or anything. */
const trapEnv = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`env.${String(prop)} was touched by the tombstone`);
    },
  },
);

const trapCtx = {
  waitUntil() {
    throw new Error('ctx.waitUntil() was called by the tombstone');
  },
  passThroughOnException() {
    throw new Error('ctx.passThroughOnException() was called by the tombstone');
  },
};

const SUBMIT_SHAPES = [
  {
    name: 'valid',
    headers: { 'content-type': 'application/json', 'content-length': '220' },
    body: JSON.stringify({
      email: 'lead@example.com',
      use_case: 'Cold store AMR fleet, twelve units on a shared map, one browns out on the ramp',
      dwell_ms: 9000,
      robot_seen: 'sbr',
      website: '',
    }),
  },
  { name: 'malformed json', headers: { 'content-type': 'application/json' }, body: '{oops' },
  { name: 'wrong content-type', headers: { 'content-type': 'text/plain' }, body: 'email=lead@example.com' },
  {
    name: 'oversized',
    headers: { 'content-type': 'application/json', 'content-length': '600000' },
    body: JSON.stringify({ email: 'lead@example.com', use_case: 'x'.repeat(200_000), dwell_ms: 9000 }),
  },
];

test('POST /api/demo-gen/submit is a 410 tombstone for every shape, with no side effects', async (t) => {
  const beforeFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the tombstone made an outbound fetch');
  };
  t.after(() => {
    globalThis.fetch = beforeFetch;
  });

  for (const shape of SUBMIT_SHAPES) {
    // 1. the real Request, so the shape under test really is that shape
    const real = new Request('https://alloylogger.com/api/demo-gen/submit', {
      method: 'POST',
      headers: shape.headers,
      body: shape.body,
    });
    const res = await callWorker(real, trapEnv, trapCtx);
    assert.equal(res.status, 410, `${shape.name} must answer 410`);
    assertNoStore(res, `${shape.name} submit`);
    assert.deepEqual(await res.json(), { ok: false, reason: 'gone', error: 'demo generation is paused' });
    assert.equal(real.bodyUsed, false, `${shape.name}: the request body must not be consumed`);

    // 2. the booby-trapped request, so "nothing was read" is proved rather than assumed
    const trapped = boobyTrappedRequest('POST', shape.headers, shape.body);
    const res2 = await callWorker(trapped, trapEnv, trapCtx);
    assert.equal(res2.status, 410, `${shape.name} (trapped) must answer 410`);
    assertNoStore(res2, `${shape.name} submit (trapped)`);
  }
});

test('the submit tombstone answers every method, and never 405s into a live handler', async () => {
  for (const method of ['POST', 'GET', 'PUT', 'DELETE']) {
    const req = boobyTrappedRequest(method, { 'content-type': 'application/json' }, '{}');
    const res = await callWorker(req, trapEnv, trapCtx);
    assert.equal(res.status, 410, `${method} /submit`);
    assertNoStore(res, `${method} /submit`);
  }
});

test('a submit with a live DO and ctx still creates nothing', async (t) => {
  const db = freshDb(t);
  const calls = [];
  const waited = [];
  const env = envWith(db, {}, calls);
  const res = await callWorker(
    postJson('/api/demo-gen/submit', { email: 'lead@example.com', use_case: 'x'.repeat(80), dwell_ms: 9000 }),
    env,
    { waitUntil: (p) => waited.push(p) },
  );
  assert.equal(res.status, 410);
  assert.deepEqual(calls, [], 'the tombstone must not call the DO at all');
  assert.deepEqual(waited, [], 'the tombstone must not schedule background work');
  assert.equal(countRows(db, 'jobs'), 0, 'no job row');
  assert.equal(countRows(db, 'events'), 0, 'not even a counter');
});

// ---------------------------------------------------------------------------------------------
// verify: a paused page, and no state transition
// ---------------------------------------------------------------------------------------------

/** The same signed link token demo-gen.js mints, so the test drives a genuine verify link. */
async function mintToken(purpose, subject, ttlMs = 7 * 86_400_000) {
  const expiry = ttlMs > 0 ? Date.now() + ttlMs : 0;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${subject}|${expiry}|${purpose}`)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return Buffer.from(`${subject}.${expiry}.${sig}`, 'utf8').toString('base64url');
}

test('GET and POST /api/demo-gen/verify render the paused page and move nothing', async (t) => {
  const db = freshDb(t);
  const calls = [];
  const env = envWith(db, {}, calls);
  const job = seedJob(db, { state: 'unverified', id: 'abcdefghijklmnopqrstuv' });
  const token = await mintToken('verify', job.id);

  for (const method of ['GET', 'POST']) {
    const res = await callWorker(get(`/api/demo-gen/verify?t=${token}`, { method }), env);
    assert.equal(res.status, 200, `${method} verify`);
    assertNoStore(res, `${method} verify`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Demo generation is paused/, `${method} verify page says it is paused`);
    assert.ok(!html.includes('<form'), 'the paused page has nothing to submit');
    assert.ok(!/[—–―]/.test(html), 'no em dash, en dash or horizontal bar in visitor copy');
    assert.equal(stateOf(db, job.id), 'unverified', `${method} verify must not transition the job`);
  }

  assert.deepEqual(calls, [], 'the paused verify must not reach the DO at all');
  // and the stub really would have moved it, so the assertion above is not vacuous
  await env.DEMOGEN_DO.get().verify(job.id);
  assert.equal(stateOf(db, job.id), 'pending');
});

test('an unsupported method on verify still 405s', async (t) => {
  const db = freshDb(t);
  const res = await callWorker(get('/api/demo-gen/verify?t=abc', { method: 'PUT' }), envWith(db));
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------------------------
// GET /api/demo-gen/runner/state
// ---------------------------------------------------------------------------------------------

test('runner/state is bearer gated', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  for (const bearer of [undefined, 'nope', `${TOKEN}x`]) {
    const res = await callWorker(get('/api/demo-gen/runner/state', { bearer }), env);
    assert.equal(res.status, 401, `bearer ${String(bearer)}`);
    assertNoStore(res, 'unauthorized runner/state');
    assert.deepEqual(await res.json(), { ok: false, error: 'unauthorized' });
  }
});

test('runner/state reports one count per state in the machine enum, plus the two extras', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  seedJob(db, { state: 'unverified' });
  seedJob(db, { state: 'unverified' });
  seedJob(db, { state: 'pending' });
  seedJob(db, { state: 'generated' });
  seedJob(db, { state: 'approved' });
  seedJob(db, { state: 'delivery_failed' });
  seedJob(db, { state: 'emailed' });

  const res = await callWorker(get('/api/demo-gen/runner/state', { bearer: TOKEN }), env);
  assert.equal(res.status, 200);
  assertNoStore(res, 'runner/state');
  const body = await res.json();

  assert.deepEqual(
    Object.keys(body).sort(),
    [...STATES, 'unknown', 'review_total', 'next_claim_expiry_s'].sort(),
    'the field contract is exactly the state enum plus unknown, review_total, next_claim_expiry_s',
  );
  assert.equal(body.unverified, 2);
  assert.equal(body.pending, 1);
  assert.equal(body.claimed, 0);
  assert.equal(body.generated, 1);
  assert.equal(body.approved, 1);
  assert.equal(body.delivery_failed, 1);
  assert.equal(body.emailed, 1);
  assert.equal(body.rejected, 0);
  // generated + approved + delivery_failed, the three REVIEW_STATES with rows
  assert.equal(body.review_total, 3);
  assert.equal(body.unknown, 0, 'every seeded row is in the enum, so nothing rolls up');
  assert.equal(body.next_claim_expiry_s, null, 'no claim means null, not 0');
});

test('a state outside the enum rolls into `unknown` and cannot invent a field', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  // Seeded straight into sqlite, which is the only way to get here: transition() would refuse
  // both of these. This is the legacy/corrupt row case, and the response's field set is
  // machine-read by the runner's fixture test, so a row must never be able to add a key to it.
  seedJob(db, { state: 'awaiting_carrier_pigeon' });
  seedJob(db, { state: 'awaiting_carrier_pigeon' });
  seedJob(db, { state: 'verified' }); // a real state from an older schema, retired since
  seedJob(db, { state: 'pending' });

  const res = await callWorker(get('/api/demo-gen/runner/state', { bearer: TOKEN }), env);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(
    Object.keys(body).sort(),
    [...STATES, 'unknown', 'review_total', 'next_claim_expiry_s'].sort(),
    'the field set is unchanged: no `awaiting_carrier_pigeon` key, no `verified` key',
  );
  assert.equal(body.unknown, 3, 'both illegal values and the legacy one are counted, not dropped');
  assert.equal(body.pending, 1, 'the legal row is still counted normally');
  for (const s of STATES) {
    if (s !== 'pending') assert.equal(body[s], 0, `${s} stays 0`);
  }
  assert.equal(body.review_total, 0);
  assert.equal(body.next_claim_expiry_s, null);
});

test('runner/state carries no PII and no secrets', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  const job = seedJob(db, {
    state: 'claimed',
    email: 'someone.private@example.com',
    useCase: 'a very identifiable warehouse in Wetherill Park',
    claimToken: 'claimtoken-abcdef0123456789',
    leaseUntil: Date.now() + 600_000,
  });

  const res = await callWorker(get('/api/demo-gen/runner/state', { bearer: TOKEN }), env);
  const text = await res.text();
  for (const secret of ['someone.private@example.com', 'Wetherill Park', 'claimtoken-abcdef0123456789', job.slug, job.id]) {
    assert.ok(!text.includes(secret), `runner/state leaked ${secret}`);
  }
  assert.ok(!text.includes('@'), 'no address-shaped text at all');
  assert.equal(JSON.parse(text).claimed, 1);
});

test('runner/state is read-only: an expired lease is reported, not reclaimed', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  const job = seedJob(db, { state: 'claimed', claimToken: 'ct', leaseUntil: Date.now() - 5_000 });
  const fresh = seedJob(db, { state: 'claimed', claimToken: 'ct2', leaseUntil: Date.now() + 90_000 });

  for (let i = 0; i < 2; i++) {
    const res = await callWorker(get('/api/demo-gen/runner/state', { bearer: TOKEN }), env);
    const body = await res.json();
    assert.equal(body.claimed, 2, 'both claims are still claims');
    assert.equal(body.pending, 0, 'observing an expired lease must not put the job back in pending');
    assert.equal(body.next_claim_expiry_s, 0, 'an already-expired lease reads as reclaimable now');
  }

  assert.equal(stateOf(db, job.id), 'claimed');
  assert.equal(stateOf(db, fresh.id), 'claimed');
  assert.equal(countRows(db, 'events'), 0, 'runner_seen (or any event) must not be written by a read');
});

test('next_claim_expiry_s counts down to the EARLIEST lease', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  seedJob(db, { state: 'claimed', claimToken: 'a', leaseUntil: Date.now() + 900_000 });
  seedJob(db, { state: 'claimed', claimToken: 'b', leaseUntil: Date.now() + 120_000 });

  const body = await (await callWorker(get('/api/demo-gen/runner/state', { bearer: TOKEN }), env)).json();
  assert.ok(body.next_claim_expiry_s > 110 && body.next_claim_expiry_s <= 120, `got ${body.next_claim_expiry_s}`);
});

test('a POST to runner/state is not a route', async (t) => {
  const db = freshDb(t);
  const res = await callWorker(postJson('/api/demo-gen/runner/state', {}, { bearer: TOKEN }), envWith(db));
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------------------------
// POST /api/demo-gen/runner/shelf-purge
// ---------------------------------------------------------------------------------------------

const PURGE_ENV = { DEMOGEN_SHELF_PURGE: '1' };

test('the shelve-purge route does not exist without DEMOGEN_SHELF_PURGE=1', async (t) => {
  const db = freshDb(t);
  const calls = [];
  seedJob(db, { state: 'unverified' });

  for (const extra of [{}, { DEMOGEN_SHELF_PURGE: '0' }, { DEMOGEN_SHELF_PURGE: 'true' }]) {
    const res = await callWorker(
      postJson('/api/demo-gen/runner/shelf-purge', { allow_slugs: [] }, { bearer: TOKEN }),
      envWith(db, extra, calls),
    );
    assert.equal(res.status, 404, `flag ${JSON.stringify(extra)}`);
  }
  assert.deepEqual(calls, [], 'no flag, no DO call');
  assert.equal(countRows(db, 'jobs'), 1, 'and nothing was deleted');
});

test('the shelve purge is bearer gated and POST only', async (t) => {
  const db = freshDb(t);
  seedJob(db, { state: 'unverified' });
  const env = envWith(db, PURGE_ENV);

  for (const bearer of [undefined, 'nope']) {
    const res = await callWorker(postJson('/api/demo-gen/runner/shelf-purge', { allow_slugs: [] }, { bearer }), env);
    assert.equal(res.status, 401, `bearer ${String(bearer)}`);
  }
  const getRes = await callWorker(get('/api/demo-gen/runner/shelf-purge', { bearer: TOKEN }), env);
  assert.equal(getRes.status, 404, 'a GET is not the purge');
  assert.equal(countRows(db, 'jobs'), 1);
});

test('the shelve purge refuses a body that is not an allowlist of slugs', async (t) => {
  const db = freshDb(t);
  seedJob(db, { state: 'unverified' });
  const env = envWith(db, PURGE_ENV);

  const bad = [
    { allow_slugs: 'lvcvdgyf42x7i5eqrkwu' },
    { allow_slugs: ['not a slug'] },
    { allow_slugs: ['LVCVDGYF42X7I5EQRKWU'] },
    { allow_slugs: ['%'] },
    { allow_slugs: new Array(101).fill('lvcvdgyf42x7i5eqrkwu') },
  ];
  for (const body of bad) {
    const res = await callWorker(postJson('/api/demo-gen/runner/shelf-purge', body, { bearer: TOKEN }), env);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(countRows(db, 'jobs'), 1, 'a rejected body deletes nothing');
});

test('the shelve purge deletes unverified rows and allowlisted stragglers, and nothing else', async (t) => {
  const db = freshDb(t);
  const env = envWith(db, PURGE_ENV);

  const u1 = seedJob(db, { state: 'unverified' });
  const u2 = seedJob(db, { state: 'unverified' });
  const pendingKeep = seedJob(db, { state: 'pending' });
  const pendingDrop = seedJob(db, { state: 'pending' });
  const failedDrop = seedJob(db, { state: 'delivery_failed' });
  const approvedKeep = seedJob(db, { state: 'approved' });
  const emailedKeep = seedJob(db, { state: 'emailed' });

  seedBundle(db, failedDrop.slug);
  seedBundle(db, approvedKeep.slug);
  seedBundle(db, emailedKeep.slug);
  db.prepare('INSERT INTO suppression(email, at) VALUES (?, ?)').run('unsubbed@example.com', Date.now());
  db.prepare('INSERT INTO events(day, kind, job_id, at) VALUES (?, ?, ?, ?)').run('2026-07-27', 'submit', u1.id, Date.now());

  const res = await callWorker(
    postJson(
      '/api/demo-gen/runner/shelf-purge',
      { allow_slugs: [pendingDrop.slug, failedDrop.slug, approvedKeep.slug, 'aaaaaaaaaaaaaaaaaaaa'] },
      { bearer: TOKEN },
    ),
    env,
  );
  assert.equal(res.status, 200);
  assertNoStore(res, 'shelf-purge');
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.unverified_deleted, 2);
  assert.equal(body.allowlisted_deleted, 2, 'the pending and the delivery_failed slug, not the approved one');
  assert.equal(body.bundles_deleted, 1, 'only the deleted job had a bundle');
  assert.deepEqual(
    body.deleted.map((d) => d.slug).sort(),
    [u1.slug, u2.slug, pendingDrop.slug, failedDrop.slug].sort(),
  );
  assert.deepEqual(body.refused, [{ slug: approvedKeep.slug, state: 'approved' }], 'a non-purgeable state is refused by name');
  assert.deepEqual(body.not_found, ['aaaaaaaaaaaaaaaaaaaa']);

  // what survived
  assert.equal(stateOf(db, pendingKeep.id), 'pending', 'a pending job nobody named is untouched');
  assert.equal(stateOf(db, approvedKeep.id), 'approved');
  assert.equal(stateOf(db, emailedKeep.id), 'emailed');
  assert.equal(stateOf(db, pendingDrop.id), null);
  assert.equal(stateOf(db, failedDrop.id), null);
  assert.equal(countRows(db, 'jobs'), 3);
  assert.deepEqual(
    db.prepare('SELECT slug FROM bundles ORDER BY slug').all().map((r) => r.slug).sort(),
    [approvedKeep.slug, emailedKeep.slug].sort(),
    'only the purged job lost its bundle',
  );
  assert.equal(countRows(db, 'suppression'), 1, 'an unsubscribe stays honoured through the purge');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'submit'").get().n,
    1,
    'the append-only event log is not rewritten',
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'shelf_purge'").get().n, 1);
});

test('the shelve purge is idempotent', async (t) => {
  const db = freshDb(t);
  const env = envWith(db, PURGE_ENV);
  seedJob(db, { state: 'unverified' });
  const pendingDrop = seedJob(db, { state: 'pending' });
  const keep = seedJob(db, { state: 'approved' });

  const call = () =>
    callWorker(
      postJson('/api/demo-gen/runner/shelf-purge', { allow_slugs: [pendingDrop.slug] }, { bearer: TOKEN }),
      env,
    );

  const first = await (await call()).json();
  assert.equal(first.unverified_deleted, 1);
  assert.equal(first.allowlisted_deleted, 1);

  const second = await (await call()).json();
  assert.equal(second.unverified_deleted, 0);
  assert.equal(second.allowlisted_deleted, 0);
  assert.equal(second.bundles_deleted, 0);
  assert.deepEqual(second.deleted, []);
  assert.deepEqual(second.not_found, [pendingDrop.slug], 'a slug already gone is not found, not an error');
  assert.equal(countRows(db, 'jobs'), 1);
  assert.equal(stateOf(db, keep.id), 'approved');
});

test('an empty allowlist purges only unverified rows', async (t) => {
  const db = freshDb(t);
  const env = envWith(db, PURGE_ENV);
  seedJob(db, { state: 'unverified' });
  const pending = seedJob(db, { state: 'pending' });

  const body = await (await callWorker(postJson('/api/demo-gen/runner/shelf-purge', {}, { bearer: TOKEN }), env)).json();
  assert.equal(body.unverified_deleted, 1);
  assert.equal(body.allowlisted_deleted, 0);
  assert.equal(stateOf(db, pending.id), 'pending');
});

// ---------------------------------------------------------------------------------------------
// the routes the shelve does NOT touch are still routed
// ---------------------------------------------------------------------------------------------

test('unsubscribe, approve and reject still route', async (t) => {
  const db = freshDb(t);
  const env = envWith(db);
  for (const path of ['/api/demo-gen/unsubscribe?t=zzz', '/api/demo-gen/approve?t=zzz', '/api/demo-gen/reject?t=zzz']) {
    const res = await callWorker(get(path), env);
    // A junk token is a 400 "not valid" page, which is the live handler answering, not a 404 or a
    // 410: these three are explicitly NOT shelved.
    assert.equal(res.status, 400, path);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/, path);
  }
  const unknown = await callWorker(get('/api/demo-gen/nope'), env);
  assert.equal(unknown.status, 404);
});
