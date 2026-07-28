// A genuine `delivery_failed` row, and whether the next sweep can actually retry it.
//
// runner.test.mjs already covers the sent-marker dedupe contract (a real send happens at most
// once) and the "a failed send takes its own marker back" case. Neither of those reaches the bug
// this file is about, because the fixture transport has no state: after a failed send its
// review.json still says `approved`, so the second tick retries through the `approved` branch and
// never exercises the `delivery_failed` one at all.
//
// Here the review fixture is REWRITTEN between ticks to the state the DO would really report, so
// the second tick enters sweepOne() with `state: 'delivery_failed'` and nothing else. Before the
// intent marker that was a dead end: the send that failed had deleted the only marker that
// recorded the mail kind, so the sweep logged "nothing to retry" and skipped the job forever.
//
// Same posture as runner.test.mjs: fixture transport, no network, no model, no browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, tick } from '../runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_ROOT = join(process.env.HOME, '.local/state/alloylogger-demo-runner');

const REVIEW = JSON.parse(readFileSync(join(ROOT, 'fixtures/api/review.json'), 'utf8'));
const REVIEW_JOB = REVIEW.jobs[0];

/** A scratch state dir plus a scratch fixture dir, so review.json can be rewritten per tick. */
function scratch(t, extraEnv = {}) {
  const stateDir = mkdtempSync(join(STATE_ROOT, 'test-'));
  const fixtureDir = mkdtempSync(join(STATE_ROOT, 'fixt-'));
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });
  for (const f of ['queue.json', 'claim.json']) {
    writeFileSync(join(fixtureDir, f), readFileSync(join(ROOT, 'fixtures/api', f)));
  }
  const cfg = loadConfig({
    HOME: process.env.HOME,
    DEMOGEN_STATE_DIR: stateDir,
    DEMO_FIXTURE_DIR: 'fixtures/api',
    DEMO_MAILER: 'resend',
    ...extraEnv,
  });
  cfg.fixtureDir = fixtureDir;
  // No brief, so the tick stops right after the review sweep. The claim still happens and hands
  // its lease straight back, which is why every assertion below filters by job id.
  cfg.briefPath = join(ROOT, 'definitely-not-a-brief.md');
  return cfg;
}

function setReviewState(cfg, state) {
  writeFileSync(join(cfg.fixtureDir, 'review.json'), JSON.stringify({ jobs: [{ ...REVIEW_JOB, state }] }));
}

function capture() {
  const lines = [];
  const log = (event, data) => lines.push({ event, data: data || {} });
  log.lines = lines;
  log.events = () => lines.map((l) => l.event);
  log.find = (e) => lines.find((l) => l.event === e);
  return log;
}

/** Swap global fetch for one that answers like Resend, and count the calls. */
function stubResend(t, respond = () => ({ ok: true, status: 200, body: { id: 'msg-1' } })) {
  const before = globalThis.fetch;
  const beforeKey = process.env.RESEND_API_KEY;
  const calls = [];
  process.env.RESEND_API_KEY = 're_stub_key';
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const r = respond(calls.length);
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  t.after(() => {
    globalThis.fetch = before;
    if (beforeKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = beforeKey;
  });
  return calls;
}

function ledgerFor(cfg, jobId) {
  const raw = readFileSync(join(cfg.stateDir, 'fixture-transport.jsonl'), 'utf8').trim();
  return raw
    .split('\n')
    .map(JSON.parse)
    .filter((e) => e.op === 'status' && e.job_id === jobId)
    .map((e) => e.state);
}

const markers = (cfg) => ({
  sent: join(cfg.jobsDir, REVIEW_JOB.id, 'sent-ready.marker'),
  intent: join(cfg.jobsDir, REVIEW_JOB.id, 'intent-ready.marker'),
});

test('a failed send records the mail kind in an intent marker that survives the failure', async (t) => {
  stubResend(t, () => ({ ok: false, status: 422, body: { message: 'invalid recipient' } }));
  const cfg = scratch(t);
  setReviewState(cfg, 'approved');

  const log = capture();
  await tick(cfg, log);

  assert.equal(log.find('mail.ready').data.ok, false);
  const m = markers(cfg);
  assert.ok(!existsSync(m.sent), 'a send that did not land must not leave a sent marker claiming it did');
  assert.ok(existsSync(m.intent), 'but the kind of mail it was must survive the failure');
  assert.equal(JSON.parse(readFileSync(m.intent, 'utf8')).kind, 'ready');
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), ['delivery_failed']);
});

test('a genuine delivery_failed row is retried with a REAL second provider call', async (t) => {
  const calls = stubResend(t, (n) => (n === 1
    ? { ok: false, status: 422, body: { message: 'temporarily unavailable' } }
    : { ok: true, status: 200, body: { id: 'msg-second' } }));
  const cfg = scratch(t);

  // tick 1: the job is approved, the send fails, the DO records delivery_failed
  setReviewState(cfg, 'approved');
  await tick(cfg, capture());
  assert.equal(calls.length, 1);
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), ['delivery_failed']);

  // tick 2: the DO now reports the row exactly as it is, and this is the path that used to skip
  setReviewState(cfg, 'delivery_failed');
  const log2 = capture();
  await tick(cfg, log2);

  assert.ok(!log2.events().includes('review.skip'), 'a delivery_failed row with an intent marker is not skipped');
  assert.equal(calls.length, 2, 'the retry is a REAL second provider call, not a bare status post');
  assert.equal(calls[1].body.to[0], REVIEW_JOB.email, 'and it goes to the same visitor');
  assert.equal(log2.find('mail.ready').data.ok, true);
  assert.ok(!log2.find('mail.ready').data.deduped, 'nothing was deduped: the first send never landed');
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), ['delivery_failed', 'emailed']);
  assert.ok(existsSync(markers(cfg).sent), 'the landed send leaves its sent marker behind');
});

test('a delivery_failed row that fails again stays delivery_failed, with no duplicate send', async (t) => {
  const calls = stubResend(t, (n) => (n <= 2
    ? { ok: false, status: 422, body: { message: 'invalid recipient' } }
    : { ok: true, status: 200, body: { id: 'msg-third' } }));
  const cfg = scratch(t);

  setReviewState(cfg, 'approved');
  await tick(cfg, capture());
  setReviewState(cfg, 'delivery_failed');
  await tick(cfg, capture());

  assert.equal(calls.length, 2, 'one attempt per tick, never two');
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), ['delivery_failed', 'delivery_failed']);
  const m = markers(cfg);
  assert.ok(!existsSync(m.sent), 'still nothing delivered, so still no sent marker');
  assert.ok(existsSync(m.intent), 'and the job is still classifiable for the next retry');

  // a permanently failing address never converges, so it is the allowlisted shelve purge that
  // ends it; until then every tick is one attempt and exactly one attempt
  const log3 = capture();
  await tick(cfg, log3);
  assert.equal(calls.length, 3);
  assert.equal(log3.find('mail.ready').data.ok, true);
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), ['delivery_failed', 'delivery_failed', 'emailed']);
});

test('a delivery_failed row with no marker of either kind is still skipped, not guessed at', async (t) => {
  const calls = stubResend(t);
  const cfg = scratch(t);
  setReviewState(cfg, 'delivery_failed');

  const log = capture();
  await tick(cfg, log);

  assert.equal(calls.length, 0, 'nothing is sent to a visitor on a guess at which mail failed');
  assert.match(log.find('review.skip').data.reason, /no send or intent marker/);
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), []);
});

test('the sent marker still wins: a mail that really left is not sent twice by the retry path', async (t) => {
  const calls = stubResend(t);
  const cfg = scratch(t);

  // tick 1 delivers for real, so both markers exist
  setReviewState(cfg, 'approved');
  await tick(cfg, capture());
  assert.equal(calls.length, 1);
  const m = markers(cfg);
  assert.ok(existsSync(m.sent) && existsSync(m.intent));

  // the status post is then imagined to have been lost, and the row comes back as delivery_failed
  setReviewState(cfg, 'delivery_failed');
  const log2 = capture();
  await tick(cfg, log2);

  assert.equal(calls.length, 1, 'the mail already left the provider: the retry is the status post alone');
  assert.ok(log2.find('mail.deduped'), 'and the skip is stated, not silent');
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), ['emailed', 'emailed']);
});

test('a dry sweep writes an intent marker and still no sent marker', async (t) => {
  const cfg = scratch(t, { DEMO_MAILER: 'dry' });
  setReviewState(cfg, 'approved');

  const log = capture();
  await tick(cfg, log);

  assert.equal(log.find('mail.ready').data.dry, true);
  const m = markers(cfg);
  assert.ok(!existsSync(m.sent), 'a dry write leaves no sent marker, or the real send later would be skipped');
  assert.ok(existsSync(m.intent), 'the kind is still recorded: a dry send can fail its template check too');
  assert.deepEqual(ledgerFor(cfg, REVIEW_JOB.id), [], 'and a dry write posts no status at all');
});
