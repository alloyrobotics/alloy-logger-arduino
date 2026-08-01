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
// What it proves:
//
//   1  PRE-LOAD. A scene that has never been handed a payload returns null and the viewer hides
//      the strip.
//
//   2  SHAPE. Two teams, name + colour + score and NOTHING else: this league has no cards, no
//      timeouts, no max-bots limit, and this log exports no keeper id and no half, so those keys
//      are absent rather than sent as zeroes that would render a truthful-looking "0Y".
//
//   3  VERSION COMPLETENESS. The viewer only touches the DOM when `version` changes, so a rendered
//      field missing from the version key goes stale on screen. A dense sweep of the whole 306 s
//      match asserts that equal version implies equal rendering across EVERY rendered field.
//
//   4  TRANSITIONS, BOTH DIRECTIONS. The goal at 278.197 s, the score digit on the next recorded
//      /game tick, the READY/SET blip at 285.571-286.191 s, the final whistle at 286.596 s and the
//      opening penalty window at 31.207 s. Each pair moves the fields it should and no others, the
//      version moves with it, and seeking BACK restores the earlier strip byte for byte - a
//      producer that mutated one shared object without re-deriving would pass forwards and fail
//      backwards.
//
//   5  THE CLOCK. This match's game controller ran past zero while secondary_state stayed
//      STATE_NORMAL, so the last 76 s are added time and render with a leading "+".

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

const eventAt = (id) => M.events.find((e) => e.id === id);
const GOAL_T = eventAt('goal-2-0').t;
const BLIP = eventAt('ready-set-blip');
const WHISTLE_T = eventAt('final-whistle').t;
const PENALTY_T = eventAt('penalty-reentry').t;

// ---------------------------------------------------------------- 1. before any data arrives

section('before any data arrives');

const coldMount = new THREE.Group();
const cold = buildScene(THREE, coldMount);
eq(cold.hudState(0), null, 'hudState is null on a scene that has never been handed a payload');
eq(cold.hudState(240.3), null, 'and stays null at any time');
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
  return {
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
}
const key = (r) =>
  `${r.clock}|${r.score}|${r.name0}/${r.color0}|${r.name1}/${r.color1}|${r.label}|${r.tone}|${r.note}`;

// ---------------------------------------------------------------- 2. shape

section('shape');

{
  const s = api.hudState(240.3);
  ok(!!s, 'the scene produces a HUD state once it has data');
  eq(s.teams.length, 2, 'two teams');
  eq(
    Object.keys(s.teams[0]).sort().join(','),
    'color,name,score',
    'the own team defines name, colour and score and NOTHING else',
  );
  eq(
    Object.keys(s.teams[1]).sort().join(','),
    'color,name,score',
    'and so does the opposing team',
  );
  eq(s.teams[0].name, 'Bit-Bots', 'the recording team is named');
  eq(s.teams[1].name, 'Opponent', 'the opposing team is not, because the log does not identify it');
  eq(s.teams[0].color, 'blue', 'the own dot is one of the strip\'s three colours');
  eq(s.teams[1].color, 'red', 'and so is the rival dot');
  eq(s.stage, undefined, 'no half is claimed: the exported /game columns carry no half indicator');
  eq(s.teams[0].keeper, undefined, 'no keeper id is claimed');
  eq(s.teams[0].cards, undefined, 'no card count is claimed for a league that has none');
  eq(s.teams[0].timeouts, undefined, 'no timeout count is claimed');
  eq(s.state.label, 'PLAYING', 'the match is live at the hero moment');
  eq(s.state.tone, 'live', 'with the live tone');
}

// The numbers on the strip are the recorded /game channel, zero-order held, which is the same grid
// the chart plots. One source, so the strip and the chart can never disagree about the score.
{
  const g = M.tracks.summaryGame;
  const spec = M.meta.tracks.summaryGame;
  let mismatch = 0;
  for (let i = 0; i < spec.count; i += 7) {
    const t = (spec.timing.startMs + i * spec.timing.stepMs) / 1000;
    const r = rendered(t);
    if (r.score !== `${Math.round(g.ownScore[i])} : ${Math.round(g.rivalScore[i])}`) mismatch++;
  }
  eq(mismatch, 0, 'every sampled score is the recorded /game tick at or before that instant');
}

// ---------------------------------------------------------------- 3. version completeness

section('the version key covers every rendered field');

{
  const seen = new Map();
  const clashes = [];
  let n = 0;
  for (let i = 0; i <= 6120; i++) {
    const t = i * 0.05;
    const r = rendered(t);
    if (!r) continue;
    n++;
    const k = key(r);
    const prev = seen.get(r.version);
    if (prev === undefined) seen.set(r.version, k);
    else if (prev !== k) clashes.push({ t, version: r.version, a: prev, b: k });
  }
  ok(n > 6000, `the sweep sampled the whole match  (${n} samples)`);
  ok(seen.size > 150, `the version moves as the match moves  (${seen.size} distinct versions)`);
  eq(clashes.length, 0, 'no two samples share a version while rendering differently');
  if (clashes.length) console.error('  ', JSON.stringify(clashes.slice(0, 6), null, 2));
}

// ---------------------------------------------------------------- 4. transitions, both directions

section('transitions, seeked in both directions');

// Each pair names exactly which rendered fields are allowed to move between a and b. Anything else
// moving, or one of these NOT moving, is a failure - and the strip is re-seeked back to `a`
// afterwards, which is where a scene that mutated shared state without re-deriving falls over.
const PAIRS = [
  {
    name: 'the goal callout opens at its recorded instant',
    a: GOAL_T - 0.05,
    b: GOAL_T + 0.05,
    fields: ['note'],
  },
  {
    name: 'the score digit turns on the next recorded /game tick',
    a: 278.4,
    b: 278.6,
    fields: ['clock', 'score'],
  },
  {
    name: 'the goal callout closes again',
    a: GOAL_T + 2.9,
    b: GOAL_T + 3.1,
    fields: ['note'],
  },
  {
    name: 'the READY/SET blip opens',
    a: BLIP.t - 0.05,
    b: BLIP.t + 0.05,
    fields: ['label', 'tone'],
  },
  {
    name: 'the READY/SET blip closes',
    a: BLIP.endT - 0.05,
    b: BLIP.endT + 0.05,
    fields: ['label', 'tone'],
  },
  {
    name: 'the final whistle',
    a: WHISTLE_T - 0.05,
    b: WHISTLE_T + 0.05,
    fields: ['label', 'tone'],
  },
  {
    name: 'the opening penalty window closes at the re-entry',
    a: PENALTY_T - 0.05,
    b: PENALTY_T + 0.05,
    fields: ['note'],
  },
];
const FIELDS = ['clock', 'score', 'name0', 'name1', 'color0', 'color1', 'label', 'tone', 'note'];
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

// The named states themselves, so a rename cannot pass as "a field moved".
eq(rendered(10).note, 'penalized', 'the opening window notes the penalty');
eq(rendered(40).note, '', 'and the note clears after the re-entry');
eq(rendered(GOAL_T + 0.5).note, 'GOAL 2-0', 'the goal callout names the score it produced');
eq(rendered(BLIP.t + 0.2).label, 'READY/SET', 'the blip renders as the prep state');
eq(rendered(BLIP.t + 0.2).tone, 'prep', 'with the prep tone');
eq(rendered(BLIP.endT + 0.2).label, 'PLAYING', 'and hands back to PLAYING when it lifts');
eq(rendered(WHISTLE_T + 1).label, 'FINISHED', 'the whistle finishes the match');
eq(rendered(WHISTLE_T + 1).tone, 'goal', 'with the settled tone');
eq(rendered(WHISTLE_T + 1).score, '2 : 0', 'at the final score');
eq(rendered(306).label, 'FINISHED', 'and it stays finished to the end of the recording');

// ---------------------------------------------------------------- 5. the clock

section('the clock');

eq(rendered(0).clock, '3:49', 'the recorded clock counts down at the start of the window');
eq(rendered(240.3).clock, '+0:10', 'and renders added time with a leading +');
eq(rendered(278.6).clock, '+0:49', 'the goal lands at +0:49, which is what the copy quotes');
eq(rendered(306).clock, '+0:57', 'the recording ends at +0:57');
{
  // The sign flip itself. The recorded controller steps 1 -> -1 and never publishes a zero, so
  // this asserts what the log DOES, not a tidied 0:00 the match never showed.
  const g = M.tracks.summaryGame;
  const spec = M.meta.tracks.summaryGame;
  let i = 0;
  while (i < spec.count && g.secondsRemaining[i] >= 0) i++;
  const t = (spec.timing.startMs + i * spec.timing.stepMs) / 1000;
  eq(g.secondsRemaining[i - 1], 1, 'the last regulation tick the log recorded is 1 s');
  eq(g.secondsRemaining[i], -1, 'and the next one is already -1');
  eq(rendered(t - 0.5).clock, '0:01', 'the last regulation tick renders without a sign');
  eq(rendered(t).clock, '+0:01', 'and the first added-time tick renders with one');
}

api.dispose();
ok(true, 'the scene disposes without throwing');

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
