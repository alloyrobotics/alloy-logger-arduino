// battle-hud.test.mjs - the viewer's scene HUD strip, both variants, in a real browser.
//
//   node demo/js/robots/gen-fixture/battle-hud.test.mjs
//
// The strip is DOM that viewer.js writes, so Node cannot answer any question about it: app.js and
// viewer.js reach three.js and `document` on their first line. This drives the REAL viewer inside
// Chromium, over `hud-contract.fixture.html`, which mounts three of them (a controllable stub, the
// real match replay, the real simulated round). Playwright is a dev-only dependency this repo does
// not install, so a machine without one SKIPS loudly rather than failing.
//
// What it proves:
//
//   1  SSL REGRESSION. The strip the match replay renders is BYTE-IDENTICAL to what it rendered
//      before the battle mission needed a red dot, optional discipline fields and a state note.
//      Not against a captured golden: the fixture carries `referenceRender`, the pre-change
//      algorithm copied verbatim out of viewer.js, and every field is compared against it on the
//      states the real SSL scene actually produces, across the whole window. Cards ("0Y") and the
//      keeper chip are asserted present by name, because those are the two the change touched.
//
//   2  BATTLE VARIANT. `color: 'red'` gets a styled dot; a team that defines no cards, no keeper
//      and no timeouts renders NO discipline text at all rather than a truthful-looking "0Y" for a
//      competition that has no cards; and `state.note` renders when present and clears when not.
//
//   3  VERSION COMPLETENESS. The viewer only touches the DOM when `state.version` changes, so a
//      rendered field missing from the version key goes stale on screen. Proven two ways: a dense
//      sweep of the whole round asserting that equal version implies equal rendering across EVERY
//      rendered field, and named single-field pairs (clock alone, score alone, note alone in BOTH
//      directions across a buff boundary) where the version and the seeked DOM both have to move.
//
//   4  PRE-LOAD. A scene that has never been handed data returns null and the strip is hidden.

import { serve, loadPlaywright, launchChromium, harness, waitFor } from './browser-fixture.mjs';

const H = harness('battle-hud');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright is not installed on this machine');

const srv = await serve();
const browser = await launchChromium(pw);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const eq = (actual, expected, msg) =>
  H.ok(Object.is(actual, expected), `${msg}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

try {
  await page.goto(`${srv.origin}/demo/js/robots/gen-fixture/hud-contract.fixture.html`, { waitUntil: 'load' });
  const ready = await waitFor(page, () => window.__ready === true, 60000, 'the fixture to boot');
  H.ok(ready, 'the fixture booted');
  const bootErr = await page.evaluate(() => window.__error);
  H.ok(!bootErr, `the fixture booted without throwing${bootErr ? `:\n${bootErr}` : ''}`);
  if (!ready || bootErr) throw new Error('fixture unusable');

  // ------------------------------------------------------------ 1. SSL regression

  H.section('1. the SSL strip is unchanged');

  const duration = await page.evaluate(() => window.__sslDuration);
  const sslTimes = [];
  for (let t = 0; t <= duration; t += duration / 60) sslTimes.push(Number(t.toFixed(3)));

  const sslRows = await page.evaluate((times) => {
    const out = [];
    for (const t of times) {
      const { state, strip } = window.__sslAt(t);
      out.push({ t, state, strip, want: state ? window.__referenceRender(state) : null });
    }
    return out;
  }, sslTimes);

  let sslMismatch = 0;
  let sawCards = 0;
  let sawKeeper = 0;
  let sawDots = 0;
  for (const row of sslRows) {
    if (!row.state) continue;
    const got = row.strip;
    const want = row.want;
    for (const key of ['score', 'stage', 'clock', 'state', 'tone', 'note', 'max']) {
      if (got[key] !== want[key]) {
        sslMismatch++;
        console.error(`  FAIL  t=${row.t} ${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want[key])}`);
      }
    }
    for (const key of ['dots', 'names', 'keeps']) {
      if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) {
        sslMismatch++;
        console.error(`  FAIL  t=${row.t} ${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want[key])}`);
      }
    }
    if (/\b\dY\b/.test(got.note)) sawCards++;
    if (got.keeps.some((k) => /^K\d+$/.test(k))) sawKeeper++;
    if (got.dots.includes('yellow') && got.dots.includes('blue')) sawDots++;
  }
  H.ok(sslRows.filter((r) => r.state).length >= 50, 'the SSL replay produced a HUD state across the window');
  eq(sslMismatch, 0, 'every rendered SSL field matches the pre-change algorithm exactly');
  H.ok(sawCards === sslRows.filter((r) => r.state).length, 'the SSL strip still prints a yellow-card count at every sample');
  H.ok(sawKeeper > 0, 'the SSL strip still prints a keeper chip');
  H.ok(sawDots === sslRows.filter((r) => r.state).length, 'the SSL strip still styles a yellow dot and a blue dot');

  // The discipline note is where cards and timeouts live, so pin one rendered example whole.
  const sslSample = sslRows.find((r) => r.state && /TO/.test(r.strip.note));
  H.ok(!!sslSample, 'the SSL strip renders the cards/timeouts note');
  if (sslSample) {
    eq(sslSample.strip.note, sslSample.want.note, 'the rendered discipline note is verbatim the old one');
    H.ok(/ 0Y| \dY/.test(sslSample.strip.note), `the note carries the card count  (${sslSample.strip.note})`);
  }

  // ------------------------------------------------------------ 2. the battle variant

  H.section('2. the battle variant');

  const battle = await page.evaluate(() => window.__battleAt(74.5));
  H.ok(!!battle.state, 'the battle scene produces a HUD state');
  eq(battle.strip.hidden, false, 'the strip is shown');
  eq(battle.state.teams.length, 2, 'two teams');
  eq(battle.state.teams[0].color, 'blue', 'team 0 is blue');
  eq(battle.state.teams[1].color, 'red', 'team 1 is red');
  eq(JSON.stringify(battle.strip.dots), '["blue","red"]', 'the dots carry blue and red');
  eq(
    Object.keys(battle.state.teams[1]).sort().join(','),
    'color,name,score',
    'a battle team object defines name, color and score and NOTHING else',
  );
  eq(JSON.stringify(battle.strip.keeps), '["",""]', 'no keeper chip is rendered');
  eq(battle.strip.max, '', 'no max-bots field is rendered');
  H.ok(!/\dY/.test(battle.strip.note), `no card count is rendered  (note: ${JSON.stringify(battle.strip.note)})`);
  H.ok(!/TO\b/.test(battle.strip.note), 'no timeout count is rendered');
  eq(battle.strip.names.join('|'), 'Halcyon Labs|Redline Dynamics', 'the fictional team names render');
  eq(battle.strip.state, 'ROUND', 'the round state renders');
  eq(battle.strip.tone, 'live', 'the round tone is live');
  eq(battle.strip.clock, '1:46', 'the stage clock counts down from 180');
  eq(battle.strip.score, '3672 : 3450', 'the score slot carries the organizer-view HP totals');

  // the red dot is STYLED, not just labelled
  const redDotBg = await page.evaluate(() => {
    const el = document.querySelector('#pane-battle .v-sh-dot[data-c="red"]');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  H.ok(
    redDotBg && redDotBg !== 'rgba(0, 0, 0, 0)' && redDotBg !== 'transparent',
    `the red dot has its own background colour  (${redDotBg})`,
  );

  // the note renders while a buff stands and CLEARS when it lifts
  const noteOn = await page.evaluate(() => window.__battleAt(45).strip.note);
  const noteOff = await page.evaluate(() => window.__battleAt(80).strip.note);
  const noteRed = await page.evaluate(() => window.__battleAt(110).strip.note);
  const noteSupply = await page.evaluate(() => window.__battleAt(16).strip.note);
  eq(noteOn, 'BLUE DEFENSE +', 'the blue defense note renders while that buff stands');
  eq(noteRed, 'RED DEFENSE +', 'the red defense note renders while that buff stands');
  eq(noteSupply, 'RED SUPPLY 50', 'the supplier note renders during a dispense');
  eq(noteOff, '', 'the note clears when nothing is active');

  // a stub state proves the two shapes cannot leak into each other on ONE viewer
  const stub = await page.evaluate(() => {
    const disciplined = {
      version: 'a',
      clock: '2:34',
      stage: '1ST HALF',
      state: { label: 'RUNNING', tone: 'live' },
      teams: [
        { name: 'Alpha', color: 'yellow', score: 0, cards: 0, reds: 0, maxBots: 11, keeper: 7, timeouts: 2 },
        { name: 'Beta', color: 'blue', score: 2, cards: 1, reds: 1, maxBots: 11, keeper: 13, timeouts: 3 },
      ],
    };
    const bare = {
      version: 'b',
      clock: '1:46',
      state: { label: 'ROUND', tone: 'live', note: 'RED DEFENSE +' },
      teams: [
        { name: 'Halcyon Labs', color: 'blue', score: 3672 },
        { name: 'Redline Dynamics', color: 'red', score: 3450 },
      ],
    };
    return {
      disciplined: window.__pushStub(disciplined),
      wantDisciplined: window.__referenceRender(disciplined),
      bare: window.__pushStub(bare),
      backAgain: window.__pushStub({ ...disciplined, version: 'c' }),
      hiddenAfterNull: window.__pushStub(null),
    };
  });
  eq(
    JSON.stringify(stub.disciplined),
    JSON.stringify(stub.wantDisciplined),
    'a discipline-carrying state renders exactly as the pre-change algorithm renders it',
  );
  eq(stub.disciplined.note, 'Alpha 0Y 2TO · Beta 1Y 1R 3TO', 'the discipline note is unchanged, "0Y" and all');
  eq(stub.bare.note, 'RED DEFENSE +', 'a bare state renders its note and no discipline text');
  eq(JSON.stringify(stub.bare.keeps), '["",""]', 'a bare state renders no keeper chips');
  eq(stub.backAgain.note, 'Alpha 0Y 2TO · Beta 1Y 1R 3TO', 'switching back restores the discipline note');
  eq(stub.hiddenAfterNull.hidden, true, 'a null state hides the strip');

  // ------------------------------------------------------------ 3. version completeness

  H.section('3. the version key covers every rendered field');

  const sweep = await page.evaluate(() => {
    const seen = new Map();
    const clashes = [];
    const rendered = (r) => `${r.clock} ${r.blue} ${r.red} ${r.label} ${r.tone} ${r.note}`;
    let n = 0;
    for (let i = 0; i <= 3600; i++) {
      const t = i * 0.05;
      const r = window.__battleHud(t);
      if (!r) continue;
      n++;
      const key = rendered(r);
      const prev = seen.get(r.version);
      if (prev === undefined) seen.set(r.version, key);
      else if (prev !== key) clashes.push({ t, version: r.version, a: prev, b: key });
    }
    return { n, versions: seen.size, clashes: clashes.slice(0, 6), clashCount: clashes.length };
  });
  H.ok(sweep.n > 3500, `the sweep sampled the whole round  (${sweep.n} samples)`);
  H.ok(sweep.versions > 150, `the version moves as the round moves  (${sweep.versions} distinct versions)`);
  eq(sweep.clashCount, 0, 'no two samples share a version while rendering differently');
  if (sweep.clashCount) console.error('  ', JSON.stringify(sweep.clashes, null, 2));

  // Named single-field pairs. Each pair moves exactly ONE rendered field, so a version that did
  // not cover that field would hold and the strip would go stale.
  const PAIRS = [
    { name: 'clock alone', a: 10.0, b: 11.0, field: 'clock' },
    { name: 'score alone', a: 40.0, b: 40.12, field: 'blue' },
    { name: 'note alone, buff opening', a: 99.94, b: 99.96, field: 'note' },
    { name: 'note alone, buff closing', a: 129.94, b: 129.96, field: 'note' },
  ];
  const pairRows = await page.evaluate(
    (pairs) => pairs.map((p) => ({ p, a: window.__battleHud(p.a), b: window.__battleHud(p.b) })),
    PAIRS,
  );
  for (const row of pairRows) {
    const { p, a, b } = row;
    const moved = ['clock', 'blue', 'red', 'label', 'tone', 'note'].filter((k) => a[k] !== b[k]);
    eq(moved.join(','), p.field, `${p.name}: exactly one rendered field moves between t=${p.a} and t=${p.b}`);
    H.ok(a.version !== b.version, `${p.name}: the version moves with it`);
  }

  // ...and the same pairs, seeked through the real viewer, actually repaint the DOM.
  const domPairs = await page.evaluate(
    (pairs) =>
      pairs.map((p) => ({
        p,
        a: window.__battleAt(p.a).strip,
        b: window.__battleAt(p.b).strip,
      })),
    PAIRS,
  );
  for (const row of domPairs) {
    const { p, a, b } = row;
    const key = (s) => `${s.clock}|${s.score}|${s.state}|${s.tone}|${s.note}`;
    H.ok(key(a) !== key(b), `${p.name}: the seeked DOM repaints  (${key(a)} -> ${key(b)})`);
  }

  // the round-end transition moves the label AND the tone, which are both in the key
  const end = await page.evaluate(() => ({ before: window.__battleHud(179.5), after: window.__battleHud(180) }));
  eq(end.before.label, 'ROUND', 'the round label stands until the clock runs out');
  eq(end.after.label, 'CALCULATION', 'the round ends in CALCULATION');
  eq(end.after.tone, 'goal', 'the CALCULATION tone is the settled one');
  H.ok(end.before.version !== end.after.version, 'the version moves with the label and tone');
  const endDom = await page.evaluate(() => ({
    before: window.__battleAt(179.5).strip,
    after: window.__battleAt(180).strip,
  }));
  eq(endDom.after.state, 'CALCULATION', 'the seeked DOM shows CALCULATION at the end of the round');
  eq(endDom.after.tone, 'goal', 'the seeked DOM carries the settled tone');
  eq(endDom.before.state, 'ROUND', 'the seeked DOM shows ROUND before it');

  // ------------------------------------------------------------ 4. pre-load

  H.section('4. before any data arrives');

  const cold = await page.evaluate(() => window.__coldHud());
  eq(cold, null, 'hudState is null on a scene that has never been handed a payload');

  H.ok(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
} finally {
  await browser.close();
  await srv.close();
}

H.done();
