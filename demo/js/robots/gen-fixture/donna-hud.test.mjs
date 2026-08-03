// donna-hud.test.mjs - the scene HUD strip contract of donna/scene.js, in plain Node.
//
//   node demo/js/robots/gen-fixture/donna-hud.test.mjs
//
// The battle-hud pattern, minus the browser. battle-hud.test.mjs drives the REAL viewer through
// Playwright because it is proving what viewer.js RENDERS; this one proves what the scene
// PRODUCES, which is the half that belongs to donna and the half a sign error can hide in.
// donna/scene.js never touches `document`, so the whole state machine runs under `node` and this
// gate cannot silently skip itself on a machine without Playwright.
//
// SCOPE. This file is the donna PRODUCER only. The viewer-side proof that the three per-robot chips
// are additive - that the six missions which send no chips render a byte-identical strip - lives
// with the viewer change, not here, and no cross-mission assertion is made below.
//
// What it proves:
//
//   1  PRE-LOAD. A scene that has never been handed a payload returns null and the viewer hides
//      the strip.
//
//   2  SHAPE. Two teams, name + colour + score and NOTHING else: this league has no cards, no
//      timeouts, no max-bots limit, and these logs export no keeper id and no half, so those keys
//      are absent rather than sent as zeroes that would render a truthful-looking "0Y". Plus the
//      chip extension: `chipsAbi` and exactly three chips of {name, state, note, tone}.
//
//   3  THREE ROBOTS, THREE LOGS. Every chip's `penalized` is read from that robot's OWN aligned
//      gamestate and is never inferred from a teammate's array (FORMAT-V2), and every chip's tone
//      is that robot's own presence class. Both are swept across the whole match.
//
//   4  VERSION COMPLETENESS. The viewer only touches the DOM when `version` changes, so a rendered
//      field missing from the version key goes stale on screen. A dense sweep of the whole 250 s
//      match asserts that equal version implies equal rendering across EVERY rendered field, the
//      twelve chip fields included.
//
//   5  TRANSITIONS, BOTH DIRECTIONS. Rory's re-entry, the 5-0 goal at clock 162, Donna's penalty
//      start and end, the 6-0 goal in added time at clock -31, FINISHED at clock -33, and Jack's
//      first fall crossing LIVE -> HOLD -> LIVE. Each pair moves the fields it should and no
//      others, the version moves with it, and seeking BACK restores the earlier strip byte for
//      byte - a producer that mutated one shared object without re-deriving would pass forwards and
//      fail backwards.
//
//   6  THE CLOCK. This match's game controller ran past zero while secondary_state stayed
//      STATE_NORMAL, so the tail is added time and renders with a leading "+".

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function section(name) {
  console.log(`\n${name}`);
}

const THREE = await import('../../../vendor/three.module.js');
const { buildScene } = await import('../donna/scene.js');
const { decodeDonnaData } = await import('../donna/decode.js');
const fullMod = await import('../donna/donna-data.js');
const M = decodeDonnaData(fullMod);

const ROBOTS = ['donna', 'jack', 'rory'];
const eventAt = (id) => M.events.find((e) => e.id === id);
const GOAL_5 = eventAt('goal-5-0').t;
const GOAL_6 = eventAt('goal-6-0').t;
const DURATION = M.meta.window[1];

/** The presence row covering t, for one robot. */
function presenceAt(robot, t) {
  let out = M.presence[robot][0];
  for (const s of M.presence[robot]) if (t >= s.startT) out = s;
  return out;
}
const segment = (robot, className, nth = 0) =>
  M.presence[robot].filter((s) => s.className === className)[nth];

// ---------------------------------------------------------------- 1. before any data arrives

section('before any data arrives');

const coldMount = new THREE.Group();
const cold = buildScene(THREE, coldMount);
eq(cold.hudState(0), null, 'hudState is null on a scene that has never been handed a payload');
eq(cold.hudState(187.6), null, 'and stays null at any time');
cold.dispose();

const mount = new THREE.Group();
const api = buildScene(THREE, mount);
api.update(0, M);

/**
 * Everything viewer.js writes to the DOM off one state, as a flat record. If a field is on this
 * list it must be inside `version`; if it is inside `version` it must be on this list.
 */
function rendered(t) {
  const s = api.hudState(t);
  if (!s) return null;
  const r = {
    version: s.version,
    clock: s.clock,
    score: `${s.teams[0].score} : ${s.teams[1].score}`,
    name0: s.teams[0].name,
    name1: s.teams[1].name,
    color0: s.teams[0].color,
    color1: s.teams[1].color,
    label: s.state.label,
    tone: s.state.tone,
    note: s.state.note || '',
  };
  s.chips.forEach((c, i) => {
    r[`chip${i}name`] = c.name;
    r[`chip${i}state`] = c.state;
    r[`chip${i}note`] = c.note || '';
    r[`chip${i}tone`] = c.tone;
  });
  return r;
}
const FIELDS = [
  'clock', 'score', 'name0', 'name1', 'color0', 'color1', 'label', 'tone', 'note',
  'chip0name', 'chip0state', 'chip0note', 'chip0tone',
  'chip1name', 'chip1state', 'chip1note', 'chip1tone',
  'chip2name', 'chip2state', 'chip2note', 'chip2tone',
];
const key = (r) => FIELDS.map((f) => r[f]).join('|');

// ---------------------------------------------------------------- 2. shape

section('shape');

{
  const s = api.hudState(M.meta.mission.heroTime);
  ok(!!s, 'the scene produces a HUD state once it has data');
  eq(s.teams.length, 2, 'two teams');
  eq(
    Object.keys(s.teams[0]).sort().join(','),
    'color,name,score',
    'the own team defines name, colour and score and NOTHING else',
  );
  eq(Object.keys(s.teams[1]).sort().join(','), 'color,name,score', 'and so does the opposing team');
  eq(s.teams[0].name, 'Bit-Bots', 'the recording team is named');
  eq(s.teams[1].name, 'Opponent', 'the opposing team is not, because the logs do not identify it');
  eq(s.teams[0].color, 'blue', 'the own dot is one of the strip\'s three colours');
  eq(s.teams[1].color, 'red', 'and so is the rival dot');
  eq(s.stage, undefined, 'no half is claimed: the exported gamestate carries no half indicator');
  eq(s.teams[0].keeper, undefined, 'no keeper id is claimed');
  eq(s.teams[0].cards, undefined, 'no card count is claimed for a league that has none');
  eq(s.teams[0].timeouts, undefined, 'no timeout count is claimed');
  eq(s.state.label, 'PLAYING', 'the match is live at the hero moment');
  eq(s.state.tone, 'live', 'with the live tone');

  // the chip extension
  eq(s.chipsAbi, 1, 'the state declares the HUD chip ABI it was written against');
  eq(Array.isArray(s.chips), true, 'and carries a chip array');
  eq(s.chips.length, 3, 'one chip per recorded robot');
  eq(
    s.chips.map((c) => c.name).join(','),
    'Donna,Jack,Rory',
    'named with the approved factual robot names, in payload robot order',
  );
  for (const c of s.chips) {
    eq(Object.keys(c).sort().join(','), 'name,note,state,tone', `${c.name}'s chip defines name, state, note and tone`);
  }
  eq(s.chips.every((c) => c.tone === 'live'), true, 'all three are live at the hero moment');
  eq(s.chips.every((c) => c.note === ''), true, 'and none of them carries a note there');
}

// The numbers on the strip are the recorded master gamestate, zero-order held, which is the same
// grid the chart plots. One source, so the strip and the chart can never disagree about the score.
{
  const g = M.tracks.donnaHud;
  const spec = M.meta.tracks.donnaHud;
  let mismatch = 0;
  for (let i = 0; i < spec.count; i += 3) {
    const t = (spec.timing.startMs + i * spec.timing.stepMs) / 1000;
    const r = rendered(t);
    if (r.score !== `${Math.round(g.ownScore[i])} : ${Math.round(g.rivalScore[i])}`) mismatch++;
  }
  eq(mismatch, 0, 'every sampled score is the recorded gamestate tick at or before that instant');
  // Score, clock and match state are sample-identical across all three HUD tracks (FORMAT-V2), so
  // the strip cannot depend on which robot's copy it read.
  let divergent = 0;
  for (let i = 0; i < spec.count; i++) {
    for (const col of ['secondsRemaining', 'ownScore', 'rivalScore', 'gameState']) {
      if (M.tracks.jackHud[col][i] !== M.tracks.donnaHud[col][i]) divergent++;
      if (M.tracks.roryHud[col][i] !== M.tracks.donnaHud[col][i]) divergent++;
    }
  }
  eq(divergent, 0, 'the three HUD tracks agree on score, clock and match state at every tick');
}

// ---------------------------------------------------------------- 3. three robots, three logs

section('per-robot chips are per-robot facts');

{
  const spec = M.meta.tracks.donnaHud;
  let penalizedWrong = 0;
  let toneWrong = 0;
  let stateWrong = 0;
  let sampled = 0;
  const CHIP_TONE = { LIVE: 'live', HOLD: 'hold', HIDDEN: 'hidden' };
  for (let i = 0; i < spec.count; i++) {
    const t = (spec.timing.startMs + i * spec.timing.stepMs) / 1000 + 0.01;
    if (t > DURATION) continue;
    const s = api.hudState(t);
    sampled++;
    for (let k = 0; k < ROBOTS.length; k++) {
      const robot = ROBOTS[k];
      const chip = s.chips[k];
      const pres = presenceAt(robot, t);
      // tone is that robot's own presence render mode
      if (chip.tone !== CHIP_TONE[pres.renderMode]) toneWrong++;
      // the note states WHY, from the presence class first and the robot's own flag second
      const own = M.tracks[`${robot}Hud`].penalized[i] > 0.5;
      let wantNote = '';
      if (pres.className === 'penalty-outage') wantNote = 'penalized';
      else if (pres.className === 'fall-outage') wantNote = 'fallen';
      else if (pres.className === 'pre-first-fix') wantNote = own ? 'penalized, no fix' : 'no fix';
      else if (own) wantNote = 'penalized';
      if (chip.note !== wantNote) penalizedWrong++;
      // state is that robot's own zero-order-held RobotControlState
      const tr = M.tracks[`${robot}RobotState`];
      let j = 0;
      while (j + 1 < tr.t10ms.length && tr.t10ms[j + 1] <= t * 100) j++;
      if (chip.state !== M.meta.codeTables.robotState[Math.round(tr.state[j])]) stateWrong++;
    }
  }
  ok(sampled > 490, `the sweep covered the whole match  (${sampled} ticks x 3 robots)`);
  eq(toneWrong, 0, 'every chip tone is that robot\'s own presence render mode');
  eq(penalizedWrong, 0, 'every chip note is that robot\'s own presence class and its own penalized flag');
  eq(stateWrong, 0, 'every chip state is that robot\'s own recorded RobotControlState, zero-order held');
}

// A teammate's flag can never leak into another chip: at Donna's penalty exactly one flag is set,
// and at Rory's exactly one, and they are different robots.
{
  const spec = M.meta.tracks.donnaHud;
  const flagsAt = (t) => {
    const i = Math.floor((t * 1000 - spec.timing.startMs) / spec.timing.stepMs + 1e-6);
    return ROBOTS.map((r) => (M.tracks[`${r}Hud`].penalized[i] > 0.5 ? 1 : 0)).join('');
  };
  eq(flagsAt(100), '100', 'mid-penalty only Donna\'s own flag is set');
  eq(flagsAt(10), '001', 'and in the opening window only Rory\'s is');
  const s100 = api.hudState(100);
  eq(s100.chips[0].note, 'penalized', 'so Donna\'s chip says penalized at 100 s');
  eq(s100.chips[1].note, '', 'and Jack\'s says nothing');
  eq(s100.chips[2].note, '', 'and neither does Rory\'s');
  eq(s100.chips[0].tone, 'hidden', 'Donna is off the pitch, and the chip is the only thing that says so');
  const s10 = api.hudState(10);
  eq(s10.chips[2].note, 'penalized, no fix', 'Rory is both penalized and unlocalized before her re-entry');
  eq(s10.chips[2].tone, 'hidden', 'and is not drawn while that is true');
}

// ---------------------------------------------------------------- 4. version completeness

section('the version key covers every rendered field');

{
  const seen = new Map();
  const clashes = [];
  let n = 0;
  for (let i = 0; i <= DURATION * 20; i++) {
    const t = i * 0.05;
    const r = rendered(t);
    if (!r) continue;
    n++;
    const k = key(r);
    const prev = seen.get(r.version);
    if (prev === undefined) seen.set(r.version, k);
    else if (prev !== k) clashes.push({ t, version: r.version, a: prev, b: k });
  }
  ok(n > 4900, `the sweep sampled the whole match  (${n} samples)`);
  ok(seen.size > 150, `the version moves as the match moves  (${seen.size} distinct versions)`);
  eq(clashes.length, 0, 'no two samples share a version while rendering differently');
  if (clashes.length) console.error('  ', JSON.stringify(clashes.slice(0, 6), null, 2));
}

// ---------------------------------------------------------------- 5. transitions, both directions

section('transitions, seeked in both directions');

const roryFix = segment('rory', 'pre-first-fix').endT;
const donnaPenalty = segment('donna', 'penalty-outage');
const jackFall1 = segment('jack', 'fall-outage', 0);

// Each pair names exactly which rendered fields are allowed to move between a and b. Anything else
// moving, or one of these NOT moving, is a failure - and the strip is re-seeked back to `a`
// afterwards, which is where a scene that mutated shared state without re-deriving falls over.
const PAIRS = [
  {
    name: 'Rory\'s body appears at her first map fix',
    a: roryFix - 0.05,
    b: roryFix + 0.05,
    fields: ['chip2note', 'chip2tone'],
  },
  {
    name: 'and her penalized flag clears on the next recorded tick',
    a: 28.45,
    b: 28.55,
    fields: ['clock', 'chip2note'],
  },
  {
    name: 'the 5-0 goal callout opens at its recorded instant',
    a: GOAL_5 - 0.05,
    b: GOAL_5 + 0.05,
    fields: ['note'],
  },
  {
    name: 'the score digit and the restart land on the next recorded tick',
    a: 36.4,
    b: 36.6,
    fields: ['clock', 'score', 'label', 'tone'],
  },
  {
    name: 'the 5-0 callout closes again',
    a: GOAL_5 + 2.95,
    b: GOAL_5 + 3.05,
    fields: ['note'],
  },
  {
    name: 'Jack leaves the pitch\'s truth and enters a disclosed HOLD (fall 1)',
    a: jackFall1.startT - 0.05,
    b: jackFall1.startT + 0.05,
    fields: ['chip1state', 'chip1note', 'chip1tone'],
  },
  {
    name: 'and comes back to LIVE when his localization does',
    a: jackFall1.endT - 0.05,
    b: jackFall1.endT + 0.05,
    fields: ['chip1note', 'chip1tone'],
  },
  {
    name: 'Donna is hidden the moment her own pose stream goes dark',
    a: donnaPenalty.startT - 0.05,
    b: donnaPenalty.startT + 0.05,
    fields: ['chip0note', 'chip0tone'],
  },
  {
    name: 'and returns the moment it comes back',
    a: donnaPenalty.endT - 0.05,
    b: donnaPenalty.endT + 0.05,
    fields: ['chip0note', 'chip0tone'],
  },
  {
    name: 'the 6-0 goal callout opens in added time',
    a: GOAL_6 - 0.05,
    b: GOAL_6 + 0.05,
    fields: ['note'],
  },
  {
    name: 'the second score digit and the restart land on the next recorded tick',
    a: 229.9,
    b: 230.1,
    fields: ['clock', 'score', 'label', 'tone'],
  },
  {
    // 232.45/232.55 rather than a wider bracket on purpose: the 6-0 callout closes at 232.598,
    // three seconds after its goal, which is close enough to the whistle to land inside a sloppier
    // pair and make this look like a two-field transition.
    name: 'FINISHED',
    a: 232.45,
    b: 232.55,
    fields: ['label', 'tone'],
  },
  {
    // A 50 ms bracket, because this stretch of the recording is busy: the callout closes at 232.598
    // and Donna's own robot_state moves to ANIMATION_RUNNING at 232.64. Both are real, and this
    // pair is about the first one.
    name: 'and the 6-0 callout closes just after it',
    a: 232.57,
    b: 232.62,
    fields: ['note'],
  },
  {
    name: 'the clock crosses into added time',
    a: 199.4,
    b: 199.6,
    fields: ['clock'],
  },
];
for (const p of PAIRS) {
  const a = rendered(p.a);
  const b = rendered(p.b);
  const moved = FIELDS.filter((f) => a[f] !== b[f]);
  eq(moved.join(','), p.fields.join(','), `${p.name}: exactly the expected fields move`);
  ok(a.version !== b.version, `${p.name}: the version moves with them`);
  // ...and back. A seek is not a one-way street: the viewer scrubs.
  const again = rendered(p.a);
  eq(key(again), key(a), `${p.name}: seeking back restores the strip byte for byte`);
  eq(again.version, a.version, `${p.name}: and restores the version with it`);
}

// The named states themselves, so a rename cannot pass as "a field moved". Every clock value below
// is the frozen contract number for that event.
section('the frozen numbers');

eq(rendered(GOAL_5 + 0.5).note, 'GOAL 5-0', 'the first goal callout names the score it produced');
eq(rendered(36.6).score, '5 : 0', 'and the digit turns over on the next recorded tick');
eq(rendered(36.6).clock, '2:42', 'with 162 s on the clock, which is what the copy quotes');
eq(rendered(GOAL_6 + 0.5).note, 'GOAL 6-0', 'the second goal callout names the six');
eq(rendered(230.1).score, '6 : 0', 'and the digit turns over on its next tick');
eq(rendered(230.1).clock, '+0:31', 'at clock -31, which is added time, not the whistle');
eq(rendered(232.6).label, 'FINISHED', 'FINISHED arrives after it');
eq(rendered(232.6).clock, '+0:33', 'at clock -33, which is the whistle\'s number and not the goal\'s');
eq(rendered(232.6).score, '6 : 0', 'at the final score');
eq(rendered(DURATION).label, 'FINISHED', 'and it stays finished to the end of the window');
eq(rendered(DURATION).score, '6 : 0', 'at the same final score');
eq(rendered(0).label, 'PLAYING', 'the window opens mid-play');
eq(rendered(0).clock, '3:19', 'with 199 s left');
eq(rendered(0).score, '4 : 0', 'at 4-0');
eq(rendered(85).label, 'SET', 'the restart states are the recorded gamestate enum, not an invention');
eq(rendered(85).tone, 'prep', 'with the prep tone');
eq(rendered(37).label, 'READY', 'READY too');
eq(rendered(7.5).chip1note, 'fallen', 'Jack\'s chip says fallen while his pose is held');
eq(rendered(7.5).chip1tone, 'hold', 'and its tone is the disclosed hold');
eq(rendered(187.6).chip1note, '', 'and says nothing once he is up and localized');

// ---------------------------------------------------------------- 6. the clock

section('the clock');

{
  const g = M.tracks.donnaHud;
  const spec = M.meta.tracks.donnaHud;
  let i = 0;
  while (i < spec.count && g.secondsRemaining[i] >= 0) i++;
  const t = (spec.timing.startMs + i * spec.timing.stepMs) / 1000;
  eq(g.secondsRemaining[i - 1], 0, 'the last regulation tick this log recorded is an exact 0 s');
  eq(g.secondsRemaining[i], -1, 'and the next one is already -1');
  eq(rendered(t - 0.5).clock, '0:00', 'the last regulation tick renders without a sign');
  eq(rendered(t).clock, '+0:01', 'and the first added-time tick renders with one');
  // Added time is STATE_NORMAL, not overtime: the negative clock is the same period running on.
  eq(
    JSON.stringify(M.meta.gameController.secondaryStatesWhileClockNegative),
    '["STATE_NORMAL"]',
    'and the negative clock is STATE_NORMAL throughout, which is why it renders as added time',
  );
}

api.dispose();
ok(true, 'the scene disposes without throwing');

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
