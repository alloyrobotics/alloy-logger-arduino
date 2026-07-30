// battle-data.test.mjs - self-test for demo/js/robots/battle/{data.js, claims.mjs}.
//
//   node demo/js/robots/gen-fixture/battle-data.test.mjs
//
// This directory is in .assetsignore, so nothing here is ever served.
//
// What it proves:
//   1  the def's channel table is the payload's channel table, field for field
//   2  every field carries complete two-dimensional provenance, and every cadence is declared
//   3  no channel needs more than two y-axis unit groups, and each channel's ACTUAL grouping is
//      asserted rather than merely counted
//   4  the referee arithmetic re-derived IN THIS FILE from the event ledger, using only the manual
//      equations, is sample-exact against the exported remainHP and shooterHeat0, reproduces the
//      frozen incident table, the ledger-contract totals, the zero-early-hits property and the
//      counterfactual winner flip
//   5  every finding window is inside the round and focuses a channel and fields that exist
//   6  every DATA_CLAIM resolves to the exact exported sample, and no finding narrative contains a
//      number that is not in the ledger
//   7  buildData is deterministic and pure of Math.random
//   8  buildData and eventLines throw their tripwires before loadSceneData resolves
//   9  the anachronism ban list appears nowhere in META or in any battle source file
//  10  the fire gate exactly brackets the burst, and the zero-order-held planner source never
//      transitions faster than its native rate

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BATTLE = path.join(HERE, '..', 'battle');

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
  ok(Object.is(actual, expected), `${msg}  (got ${actual}, want ${expected})`);
}
function near(actual, expected, tol, msg) {
  ok(Math.abs(actual - expected) <= tol, `${msg}  (got ${actual}, want ${expected} +/- ${tol})`);
}
function section(name) {
  console.log(`\n${name}`);
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- 8. tripwires, BEFORE any load

section('tripwires');
const D = await import('../battle/data.js');
{
  let threw = null;
  try {
    D.buildData(() => 0.5);
  } catch (err) {
    threw = err;
  }
  ok(threw !== null, 'buildData() throws before loadSceneData() resolves');
  eq(threw && threw.code, 'BATTLE_BUILD_BEFORE_LOAD', 'the tripwire is named');
  ok(threw && /loadSceneData/.test(threw.message), 'and its message names loadSceneData, so the caller knows the fix');

  let threw2 = null;
  try {
    D.eventLines();
  } catch (err) {
    threw2 = err;
  }
  ok(threw2 !== null, 'eventLines() throws before loadSceneData() resolves');
  eq(threw2 && threw2.code, 'BATTLE_EVENTS_BEFORE_LOAD', 'the event-ledger tripwire is named');
}
eq(D.isSceneDataLoaded(), false, 'isSceneDataLoaded() is false before loading');
ok(D.previewData !== null, 'previewData decoded at module scope without a load');
ok(D.getSceneData() === D.previewData, 'getSceneData() falls back to the preview slice');
eq(D.duration, 180.0, 'the mission is the full 180 s round');

// ---------------------------------------------------------------- load

section('load');
const M = await D.loadSceneData();
ok(D.isSceneDataLoaded(), 'isSceneDataLoaded() is true after loadSceneData()');
ok(D.getSceneData() === M, 'getSceneData() returns the decoded round once loaded');
ok((await D.loadSceneData()) === M, 'loadSceneData() is idempotent and returns one promise');
{
  // the retryable-vs-reload split is a source contract: a decoder failure clears the cache and a
  // module EVALUATION failure cannot, because the module map caches it for the life of the document
  const src = await readFile(path.join(BATTLE, 'data.js'), 'utf8');
  ok(/retryable = false/.test(src), 'a module evaluation failure is marked NOT retryable');
  ok(/retryable = true/.test(src), 'a decoder failure is marked retryable');
  ok(/matchPromise === p\) matchPromise = null/.test(src), 'and a retryable failure clears the cached promise');
}

const META = M.meta;
const data = D.buildData(() => 0.5);
const paths = D.channels.map((c) => c.path);

// ---------------------------------------------------------------- 1, 2, 3. channels

section('channels');
eq(paths.length, 6, 'six channels');
eq(paths.length, new Set(paths).size, 'channel paths are unique');
eq(
  JSON.stringify([...paths].sort()),
  JSON.stringify(Object.keys(META.channels).sort()),
  'the def declares exactly the channels the payload carries',
);
eq(
  JSON.stringify(Object.keys(data).sort()),
  JSON.stringify([...paths].sort()),
  'buildData returns exactly the declared channels',
);

// the grouping each channel ACTUALLY has, asserted rather than counted. Only unit groups 0 and 1
// get a labelled axis in the chart, so a third would silently lose its scale.
const EXPECTED_GROUPS = {
  '/blue1/vision': { '': ['confidence'], s: ['trackAgeS'] },
  '/blue1/localization': { m: ['xM', 'yM', 'uwbResidualM'], deg: ['yawDeg'] },
  '/blue1/planner': { m: ['goalDistM', 'pathLenM'] },
  '/blue1/chassis': { 'm/s': ['cmdSpeedMps', 'measSpeedMps'], A: ['chassisCurrentA'] },
  '/blue1/gimbal_launcher': { deg: ['gimbalYawDeg', 'targetBearingDeg'], '': ['fireGate'] },
  '/blue1/referee': { HP: ['remainHP'], heat: ['shooterHeat0'] },
};
const TRANSFORMS = /^DERIVED_[A-Z_]+$/;

for (const ch of D.channels) {
  const spec = META.channels[ch.path];
  ok(!!spec, `${ch.path}: in the payload`);
  ok(ch.fields.length >= 1 && ch.fields.length <= 6, `${ch.path}: 1 to 6 series, the chart's limit`);
  eq(
    JSON.stringify(ch.fields.map((f) => f.key).sort()),
    JSON.stringify(Object.keys(spec.fields).sort()),
    `${ch.path}: the def's fields are the payload's fields`,
  );

  // unit grouping
  const grouping = {};
  for (const f of ch.fields) (grouping[f.unit] = grouping[f.unit] || []).push(f.key);
  eq(
    JSON.stringify(grouping),
    JSON.stringify(EXPECTED_GROUPS[ch.path]),
    `${ch.path}: unit grouping is exactly what the chart will draw`,
  );
  const nGroups = Object.keys(grouping).length;
  ok(nGroups <= 2, `${ch.path}: at most two unit groups (has ${nGroups})`);
  eq(nGroups, spec.unitGroupCount, `${ch.path}: the def and the payload agree on the group count`);
  // and the payload's own unitGroup indices are 0 and 1 in the same partition
  const byIndex = {};
  for (const f of ch.fields) {
    const g = spec.fields[f.key].unitGroup;
    ok(g === 0 || g === 1, `${ch.path}.${f.key}: unit group index is 0 or 1`);
    (byIndex[g] = byIndex[g] || new Set()).add(f.unit);
  }
  for (const g of Object.keys(byIndex)) {
    eq(byIndex[g].size, 1, `${ch.path}: unit group ${g} holds exactly one unit`);
  }

  // cadence
  eq(D.rates[ch.path], spec.rateHz, `${ch.path}: declared block rate matches the payload`);
  ok(typeof D.rateNotes[ch.path] === 'string' && D.rateNotes[ch.path].length > 20, `${ch.path}: has a cadence note`);
  const built = data[ch.path];
  ok(!!built && built.t && built.t.length > 1, `${ch.path}: built with a time axis`);
  near(
    (built.t.length - 1) / (built.t[built.t.length - 1] - built.t[0]),
    D.rates[ch.path],
    1e-6,
    `${ch.path}: the built cadence is EXACTLY the declared block rate`,
  );

  for (const f of ch.fields) {
    const p = f.provenance;
    ok(!!p, `${ch.path}.${f.key}: has provenance`);
    eq(p && p.origin, 'SYNTHETIC', `${ch.path}.${f.key}: origin is SYNTHETIC, because nothing here was recorded`);
    ok(p && TRANSFORMS.test(p.transform), `${ch.path}.${f.key}: transform is a DERIVED_<X>`);
    eq(p && p.transform, spec.fields[f.key].transform, `${ch.path}.${f.key}: transform matches the payload`);
    ok(p && typeof p.note === 'string' && p.note.length > 20, `${ch.path}.${f.key}: carries an honest note`);
    eq(f.unit, spec.fields[f.key].unit, `${ch.path}.${f.key}: unit matches the payload`);
    const key = `${ch.path}.${f.key}`;
    ok(typeof D.fieldRateNotes[key] === 'string', `${key}: has a per-field native cadence note`);
    const arr = built[f.key];
    eq(arr.length, built.t.length, `${key}: array is the length of t`);
    let finite = true;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) finite = false;
    ok(finite, `${key}: every sample is finite`);
  }
}
eq(
  Object.keys(D.fieldRateNotes).length,
  D.channels.reduce((a, c) => a + c.fields.length, 0),
  'fieldRateNotes covers every field and nothing else',
);
ok(
  /INFERRED/.test(D.fieldRateNotes['/blue1/chassis.measSpeedMps']),
  'the odometry cadence is labelled INFERRED, because no public source documents it',
);
ok(
  /100/.test(D.fieldRateNotes['/blue1/localization.uwbResidualM']),
  'the UWB note states the centimetre-to-metre wire conversion',
);

// ---------------------------------------------------------------- 4. referee arithmetic

section('referee arithmetic, re-derived');
// Re-derived HERE, from the event ledger only, with the manual's equations written out: heat rises
// by the measured muzzle speed of each shot; at each 10 Hz settlement tick the pre-settlement heat
// is recorded, anything over the limit deducts (Q - limit) * 4 HP, and the barrel then cools.
// Nothing below reads the exported remainHP or shooterHeat0 arrays; they are only diffed against.
const HP_INITIAL = 2000;
const HEAT_LIMIT = 180;
const HEAT_MULT = 4;
const COOL_PER_TICK = 6.0;
const COOL_PER_TICK_LOW_HP = 12.0;
const LOW_HP = 400;
const DMG = 50;
const DMG_BUFFED = 25;
const TICK = 0.1;
const N_TICKS = 1801;
const WIRE = { 3: 'red1', 4: 'red2', 13: 'blue1', 14: 'blue2' };
const TEAM_OF = { 3: 'red', 4: 'red', 13: 'blue', 14: 'blue' };

const E = M.events;
const shots = [...E.shots].sort((a, b) => a.t - b.t || a.robotId - b.robotId);
const hits = [...E.hits].sort((a, b) => a.t - b.t || a.targetId - b.targetId);
const buffedAt = (team, t) =>
  E.buffs.some((b) => b.team === team && b.tStartS - 1e-9 <= t && t < b.tEndS - 1e-9);

const hp = {};
const heat = {};
const hpSeries = {};
const heatSeries = {};
for (const id of Object.keys(WIRE)) {
  hp[id] = HP_INITIAL;
  heat[id] = 0;
  hpSeries[id] = new Float64Array(N_TICKS);
  heatSeries[id] = new Float64Array(N_TICKS);
}
const myExceed = [];
const myDeduction = { red: 0, blue: 0 };
let amountMismatch = 0;
let si = 0;
let hj = 0;
for (let n = 0; n < N_TICKS; n++) {
  const T = n * TICK;
  while (si < shots.length && shots[si].t < T - 1e-9) {
    heat[shots[si].robotId] += shots[si].muzzleMps;
    si++;
  }
  while (hj < hits.length && hits[hj].t < T - 1e-9) {
    const h = hits[hj];
    const want = buffedAt(TEAM_OF[h.targetId], h.t) ? DMG_BUFFED : DMG;
    if (Math.abs(want - h.amount) > 1e-9) amountMismatch++;
    hp[h.targetId] = Math.max(0, hp[h.targetId] - want);
    myDeduction[TEAM_OF[h.sourceId]] += want;
    hj++;
  }
  for (const id of Object.keys(WIRE)) {
    heatSeries[id][n] = heat[id];
    if (heat[id] > HEAT_LIMIT + 1e-9) {
      const ded = (heat[id] - HEAT_LIMIT) * HEAT_MULT;
      hp[id] = Math.max(0, hp[id] - ded);
      myDeduction[TEAM_OF[id] === 'blue' ? 'red' : 'blue'] += ded;
      myExceed.push({ t: r3(T), targetId: Number(id), amount: ded });
    }
    heat[id] = Math.max(0, heat[id] - (hp[id] < LOW_HP ? COOL_PER_TICK_LOW_HP : COOL_PER_TICK));
    hpSeries[id][n] = hp[id];
  }
}

eq(amountMismatch, 0, 'every armour amount in the ledger equals the rules value for its buff state');

const ref = data['/blue1/referee'];
eq(ref.t.length, N_TICKS, 'the referee channel has one sample per settlement tick');
// "Sample-exact" means exact IN THE QUANTIZED WIRE CODES, which is the only comparison that means
// anything here: the payload stores integer codes at a declared scale, so the decoded float32 of
// 38.9 and a double-precision 38.9 differ in the seventh decimal and neither is wrong. Comparing
// codes is what the offline verifier does and it is what the format defines.
const scaleOf = (key) => {
  const s = META.streams.find((x) => x.key === key);
  if (!s) throw new Error(`no stream ${key}`);
  return s.scale;
};
const codesMatch = (exported, mine, scale) => {
  for (let n = 0; n < exported.length; n++) {
    if (Math.round(exported[n] / scale) !== Math.round(mine[n] / scale)) return n;
  }
  return -1;
};
eq(
  codesMatch(ref.remainHP, hpSeries[13], scaleOf('ch./blue1/referee.remainHP')),
  -1,
  'remainHP is sample-exact against the independent re-derivation',
);
eq(
  codesMatch(ref.shooterHeat0, heatSeries[13], scaleOf('ch./blue1/referee.shooterHeat0')),
  -1,
  'shooterHeat0 is sample-exact against the independent re-derivation',
);
// and the organizer HP timeline for all four robots
for (const id of Object.keys(WIRE)) {
  eq(
    codesMatch(M.hp[WIRE[id]], hpSeries[id], scaleOf(`hp.${WIRE[id]}`)),
    -1,
    `the organizer HP timeline for ${WIRE[id]} is sample-exact`,
  );
}

// ---- the frozen incident table
section('frozen incident table');
const FROZEN_TICKS = [
  [74.2, 24, 1976],
  [74.4, 68, 1908],
  [74.5, 136, 1772],
  [74.6, 112, 1660],
  [74.7, 88, 1572],
  [74.8, 64, 1508],
  [74.9, 40, 1468],
  [75.0, 16, 1452],
];
const tickIndex = (t) => Math.round(t * 10);
eq(myExceed.length, 8, 'exactly eight deducting ticks, re-derived');
eq(
  JSON.stringify(myExceed.map((e) => [r2(e.t), e.amount])),
  JSON.stringify(FROZEN_TICKS.map(([t, d]) => [t, d])),
  'the re-derived deductions are the frozen table, tick for tick',
);
for (const [t, , hpAfter] of FROZEN_TICKS) {
  eq(ref.remainHP[tickIndex(t)], hpAfter, `exported remainHP after the t = ${t} deduction`);
}
eq(myExceed.reduce((a, e) => a + e.amount, 0), 548, 're-derived self-inflicted loss is 548 HP');
{
  let peak = 0;
  for (let n = 0; n < N_TICKS; n++) peak = Math.max(peak, ref.shooterHeat0[n]);
  eq(peak, 214, 'peak pre-settlement barrel heat is 214');
  eq(ref.shooterHeat0[tickIndex(74.5)], 214, 'and it sits on the 74.5 s tick');
}
eq(ref.remainHP[tickIndex(75.0)], 1452, 'Blue 1 comes out of the incident on 1452 HP');
eq(ref.remainHP[tickIndex(72.5)], 2000, 'and went into it on the initial HP, untouched');
// the EXCEED_HEAT events in the payload land on exactly those ticks and nowhere else
{
  const exported = E.damage.filter((d) => d.damageType === 'EXCEED_HEAT');
  eq(exported.length, 8, 'the payload carries eight EXCEED_HEAT events');
  eq(
    JSON.stringify(exported.map((d) => [r2(d.t), d.amount, d.targetId])),
    JSON.stringify(FROZEN_TICKS.map(([t, d]) => [t, d, 13])),
    'and they are the frozen ticks, amounts and target',
  );
  ok(
    exported.every((d) => d.sourceId === null && d.damageSource === null),
    'an overheat has no damage source, because nothing shot the robot',
  );
}
// source exclusivity: inside the fault window every Blue 1 loss is the overheat and nothing else
{
  const window = E.damage.filter((d) => d.targetId === 13 && d.t >= 72.0 && d.t <= 76.0);
  ok(window.length > 0, 'Blue 1 does lose HP inside the fault window');
  ok(
    window.every((d) => d.damageType === 'EXCEED_HEAT'),
    'and every one of those losses is EXCEED_HEAT, so nothing else can be credited with the damage',
  );
}

// ---- the ledger contract and the decisive-causality pair
section('ledger contract');
{
  const blueToRed = hits.filter((h) => TEAM_OF[h.sourceId] === 'blue');
  const redToBlue = hits.filter((h) => TEAM_OF[h.sourceId] === 'red');
  eq(blueToRed.reduce((a, h) => a + h.amount, 0), 1150, 'Blue to Red armour damage');
  eq(redToBlue.reduce((a, h) => a + h.amount, 0), 900, 'Red to Blue armour damage');
  eq(blueToRed.filter((h) => h.amount === 25).length, 4, 'four Blue hits land halved, inside the Red buff');
  eq(redToBlue.filter((h) => h.amount === 25).length, 4, 'four Red hits land halved, inside the Blue buff');
  eq(myDeduction.red, 1448, 're-derived Red deduction, armour plus the self-inflicted loss credited per S3.2');
  eq(myDeduction.blue, 1150, 're-derived Blue deduction');
  eq(E.result.deduction.red, myDeduction.red, 'the exported Red deduction agrees');
  eq(E.result.deduction.blue, myDeduction.blue, 'the exported Blue deduction agrees');
  const ladder = (d) => (d.red > d.blue ? 'RED_WIN' : d.blue > d.red ? 'BLUE_WIN' : 'DRAW');
  eq(ladder(myDeduction), 'RED_WIN', 'the win ladder re-derived from the deduction ledger');
  eq(E.result.winner, 'RED_WIN', 'and the exported result agrees');
  for (const [id, key] of Object.entries(WIRE)) {
    eq(hpSeries[id][N_TICKS - 1], E.result.finalHP[
      key === 'red1' ? 'Red 1' : key === 'red2' ? 'Red 2' : key === 'blue1' ? 'Blue 1' : 'Blue 2'
    ], `final HP for ${key} matches the re-derivation`);
  }
  // zero early hits on Blue 1: the incident's absolute HP values depend on it
  eq(hits.filter((h) => h.targetId === 13 && h.t < 75.0).length, 0, 'Blue 1 takes ZERO enemy hits before 75.0 s');
  // counterfactual: remove ONLY the overheat deductions and the round flips
  const cf = { ...myDeduction };
  for (const e of myExceed) cf[TEAM_OF[e.targetId] === 'blue' ? 'red' : 'blue'] -= e.amount;
  eq(cf.red, 900, 'without the overheat, Red is credited only its armour damage');
  eq(ladder(cf), 'BLUE_WIN', 'and the winner FLIPS: the self-inflicted overheat decided the round');
  // the engine scope is honest: none of the unimplemented paths appears anywhere
  eq(
    JSON.stringify(M.engineScope.notImplemented),
    JSON.stringify(['overspeed penalty', 'module-offline penalty', 'ejection penalty', 'collision damage']),
    'the engine declares exactly which mechanics it does not implement',
  );
  for (const k of ['overspeed', 'offline', 'ejection', 'collision']) {
    eq(E.forbidden[k].length, 0, `no ${k} event exists in this round`);
  }
  const types = new Set(E.damage.map((d) => d.damageType));
  eq(JSON.stringify([...types].sort()), JSON.stringify(['ARMOR', 'EXCEED_HEAT']), 'only two damage types occur');
  // survivor bits are a boolean bitmask, never a health array
  ok(
    E.survivors.every((s) => Object.values(s.bits).every((v) => typeof v === 'boolean')),
    'survivors ship as a boolean bitmask, not as a health array',
  );
  // wire ids are the hard-gated set for this event
  const wireIds = {};
  for (const team of META.teams) wireIds[team.key] = team.wireIds;
  eq(JSON.stringify(wireIds.red), JSON.stringify([3, 4]), 'red wire ids');
  eq(JSON.stringify(wireIds.blue), JSON.stringify([13, 14]), 'blue wire ids');
}

// ---------------------------------------------------------------- 10. gate + ZOH cadence

section('fire gate and cadence');
{
  const g = data['/blue1/gimbal_launcher'];
  const rateHz = D.rates['/blue1/gimbal_launcher'];
  const inc = M.incident;
  const high = [];
  for (let i = 0; i < g.t.length; i++) if (g.fireGate[i] > 0.5) high.push(g.t[i]);
  const burst = E.shots.filter((s) => s.kind === 'BURST');
  eq(burst.length, 14, 'fourteen rounds in the burst');
  const inWindow = high.filter((t) => t >= 71.5 && t <= 76.0);
  near(Math.min(...inWindow), inc.fireGateOpenS, 1e-6, 'the first high sample is exactly the gate opening');
  near(Math.min(...inWindow), burst[0].t, 1e-6, 'which is exactly the first round of the burst');
  const lastGrid = Math.max(...g.t.filter((t) => t < inc.fireGateCloseS));
  near(Math.max(...inWindow), lastGrid, 1e-6, 'the last high sample is the final one before the gate closes');
  ok(
    burst.every((s) => s.t >= inc.fireGateOpenS - 1e-9 && s.t < inc.fireGateCloseS),
    'every burst round falls inside the gate window',
  );
  // and the gate is genuinely low either side, so "brackets" is not a coincidence of sampling
  const idxOf = (t) => Math.round((t - g.t[0]) * rateHz);
  eq(g.fireGate[idxOf(inc.fireGateOpenS) - 1], 0, 'the gate is low on the sample before it opens');
  eq(g.fireGate[idxOf(lastGrid) + 1], 0, 'and low on the first sample after it closes');
  // the run is contiguous: one burst, not a stutter that happens to span the same seconds
  let contiguous = true;
  for (let i = 1; i < inWindow.length; i++) {
    if (Math.abs(inWindow[i] - inWindow[i - 1] - 1 / rateHz) > 1e-6) contiguous = false;
  }
  ok(contiguous, 'the gate stays high for one contiguous run across the burst');
  // no Blue 1 shot anywhere in the round is fired while the gate reads zero
  const ungated = E.shots.filter((s) => s.robotId === 13 && g.fireGate[Math.min(g.t.length - 1, idxOf(s.t))] < 0.5);
  eq(ungated.length, 0, 'no Blue 1 round is fired while the gate reads zero');
  // and the cadence never exceeds the platform limit
  let maxCadence = 0;
  for (let i = 1; i < burst.length; i++) maxCadence = Math.max(maxCadence, 1 / (burst[i].t - burst[i - 1].t));
  ok(maxCadence <= 10 + 1e-6, `burst cadence stays inside the 10 rounds per second limit (peak ${maxCadence.toFixed(2)})`);
  ok(burst.every((s) => s.muzzleMps <= 25), 'every round is inside the 25 m/s muzzle limit');
}
{
  // A zero-order-held source cannot be verified to run at its native rate from a coarser grid, so
  // what is asserted is the checkable UPPER BOUND: no two transitions closer than
  // 1/native - 1/block, and never more than `native` transitions in any one-second window.
  const spec = META.channels['/blue1/planner'];
  const p = data['/blue1/planner'];
  for (const key of ['goalDistM', 'pathLenM']) {
    const native = spec.fields[key].nativeZohHz;
    eq(native, 3, `${key}: the payload declares a 3 Hz native source`);
    const trans = [];
    for (let i = 1; i < p.t.length; i++) if (p[key][i] !== p[key][i - 1]) trans.push(p.t[i]);
    ok(trans.length > 0, `${key}: the series does transition, so the bound is not vacuous`);
    const floorGap = 1 / native - 1 / spec.rateHz;
    let tooClose = 0;
    for (let i = 1; i < trans.length; i++) if (trans[i] - trans[i - 1] < floorGap - 1e-9) tooClose++;
    eq(tooClose, 0, `${key}: no two transitions closer than ${floorGap.toFixed(4)} s`);
    let worstWindow = 0;
    for (let i = 0; i < trans.length; i++) {
      let n = 0;
      for (let j = i; j < trans.length && trans[j] < trans[i] + 1 - 1e-9; j++) n++;
      worstWindow = Math.max(worstWindow, n);
    }
    ok(worstWindow <= native, `${key}: never more than ${native} transitions in a one-second window (worst ${worstWindow})`);
  }
}

// ---------------------------------------------------------------- 5. findings

section('findings');
const SEVERITIES = new Set(['info', 'warn', 'alert']);
const ROBOT_KEYS = new Set(Object.keys(META.poseStreams));
eq(D.findings.length, 6, 'six findings: four chain hops and two secondary beats');
eq(D.findings.length, new Set(D.findings.map((f) => f.id)).size, 'finding ids are unique');
for (const f of D.findings) {
  ok(Array.isArray(f.window) && f.window.length === 2, `${f.id}: window is a pair`);
  ok(f.window[0] >= 0 && f.window[1] <= D.duration, `${f.id}: window inside [0, ${D.duration}]`);
  ok(f.window[0] < f.window[1], `${f.id}: window is ordered`);
  ok(f.t >= f.window[0] && f.t <= f.window[1], `${f.id}: t is inside its own window`);
  ok(SEVERITIES.has(f.severity), `${f.id}: severity in {info, warn, alert}`);
  ok(typeof f.slowmo === 'boolean', `${f.id}: slowmo is a boolean`);
  ok(ROBOT_KEYS.has(f.highlight), `${f.id}: highlight "${f.highlight}" is a robot in the payload`);
  const ch = D.channels.find((c) => c.path === f.focus.channel);
  ok(!!ch, `${f.id}: focus channel exists`);
  ok(f.focus.fields.length >= 1, `${f.id}: focuses at least one field`);
  for (const key of f.focus.fields) {
    ok(ch && ch.fields.some((x) => x.key === key), `${f.id}: focus field ${key} exists on ${f.focus.channel}`);
  }
  ok(typeof f.note === 'string' && f.note.length > 120, `${f.id}: carries a narrative`);
  ok(typeof f.honesty === 'string' && f.honesty.length > 80, `${f.id}: carries an honesty line`);
  ok(!/\brecorded\b/i.test(`${f.title} ${f.note} ${f.honesty}`), `${f.id}: never calls this mission recorded`);
  ok(/^Synthetic/.test(f.honesty), `${f.id}: the honesty line opens by saying the data is synthetic`);
}
eq(
  JSON.stringify(D.findings.map((f) => f.id)),
  JSON.stringify(['stale-track', 'frozen-goal', 'blind-burst', 'overheat-self-damage', 'buff-halved-damage', 'uwb-yaw-residual']),
  'the chain reads in order and the two secondary beats follow it',
);
// the chain hops line up in time, one channel per hop
{
  const t = (id) => D.findings.find((f) => f.id === id).t;
  ok(t('stale-track') <= t('frozen-goal'), 'the track goes stale before the goal freezes');
  ok(t('frozen-goal') <= t('blind-burst'), 'the goal freezes before the burst starts');
  ok(t('blind-burst') <= t('overheat-self-damage'), 'the burst starts before the heat crosses');
  const chans = ['stale-track', 'frozen-goal', 'blind-burst', 'overheat-self-damage'].map(
    (id) => D.findings.find((f) => f.id === id).focus.channel,
  );
  eq(new Set(chans).size, 4, 'each hop of the chain lands on its own channel');
}

// ---------------------------------------------------------------- 6. the claim ledger

section('claim ledger');
const C = await import('../battle/claims.mjs');
const ch = (p) => data[p];
const at = (p, f, t) => {
  const b = ch(p);
  const i = Math.round((t - b.t[0]) * D.rates[p]);
  return b[f][Math.max(0, Math.min(b.t.length - 1, i))];
};
const reduceWindow = (p, f, a, b, pick) => {
  const blk = ch(p);
  let bestT = null;
  let bestV = null;
  for (let i = 0; i < blk.t.length; i++) {
    if (blk.t[i] < a - 1e-9 || blk.t[i] > b + 1e-9) continue;
    if (bestV === null || pick(blk[f][i], bestV)) {
      bestV = blk[f][i];
      bestT = blk.t[i];
    }
  }
  return { t: bestT, v: bestV };
};
const maxIn = (p, f, a, b) => reduceWindow(p, f, a, b, (x, y) => x > y);
const burst = E.shots.filter((s) => s.kind === 'BURST');
const exceed = E.damage.filter((d) => d.damageType === 'EXCEED_HEAT');
const blueBuff = E.buffs.find((b) => b.team === 'blue');

// One resolver per claim. Each reads the DECODED payload and returns what the copy asserts, so a
// claim is checked against the exact sample it names rather than against a digit string.
const RESOLVERS = {
  visionRateHz: () => ch('/blue1/vision').t.length - 1 === 4500 ? 25 : -1,
  localizationRateHz: () => D.rates['/blue1/localization'],
  plannerRateHz: () => D.rates['/blue1/planner'],
  plannerNativeZohHz: () => META.channels['/blue1/planner'].fields.goalDistM.nativeZohHz,
  chassisRateHz: () => D.rates['/blue1/chassis'],
  gimbalRateHz: () => D.rates['/blue1/gimbal_launcher'],
  refereeRateHz: () => D.rates['/blue1/referee'],

  confidencePeakPreLossS: () => r2(maxIn('/blue1/vision', 'confidence', 69.0, 72.0).t),
  confidencePeakPreLoss: () => r3(maxIn('/blue1/vision', 'confidence', 69.0, 72.0).v),
  lastAcceptedCaptureS: () => M.incident.lastAcceptedCaptureS,
  confidenceAtLastCapture: () => r3(at('/blue1/vision', 'confidence', 72.0)),
  firstOccludedSampleS: () => {
    const b = ch('/blue1/vision');
    for (let i = 0; i < b.t.length; i++) if (b.t[i] > 72.0 && b.confidence[i] < 0.1) return r2(b.t[i]);
    return -1;
  },
  confidenceAtFirstOccluded: () => r3(at('/blue1/vision', 'confidence', 72.04)),
  trackAgePeakS: () => r3(maxIn('/blue1/vision', 'trackAgeS', 72.0, 76.0).v),
  trackAgePeakTS: () => r2(maxIn('/blue1/vision', 'trackAgeS', 72.0, 76.0).t),
  staleTimeoutS: () => M.incident.staleTimeoutS,

  goalFrozenM: () => r3(at('/blue1/planner', 'goalDistM', 72.3)),
  goalFrozenStartS: () => r2(frozenRun().t0),
  goalFrozenEndS: () => r2(frozenRun().t1),
  goalFrozenSampleCount: () => frozenRun().n,

  heldBearingDeg: () => r2(at('/blue1/gimbal_launcher', 'targetBearingDeg', 73.0)),
  gimbalSaturatedDeg: () => r2(at('/blue1/gimbal_launcher', 'gimbalYawDeg', 72.6)),
  gimbalConvergedS: () => {
    const b = ch('/blue1/gimbal_launcher');
    const held = at('/blue1/gimbal_launcher', 'targetBearingDeg', 73.0);
    for (let i = 0; i < b.t.length; i++) {
      if (b.t[i] >= 72.6 && Math.abs(b.gimbalYawDeg[i] - held) < 5e-3) return r2(b.t[i]);
    }
    return -1;
  },
  chassisYawAtGateOpenDeg: () => r2(at('/blue1/localization', 'yawDeg', 72.6)),
  chassisYawAtBurstEndDeg: () => r2(at('/blue1/localization', 'yawDeg', 74.6)),
  measSpeedCeilingDuringRotationMps: () => r3(maxIn('/blue1/chassis', 'measSpeedMps', 72.6, 74.6).v),
  chassisCurrentPeakA: () => r3(maxIn('/blue1/chassis', 'chassisCurrentA', 72.6, 74.6).v),
  chassisCurrentPeakTS: () => r2(maxIn('/blue1/chassis', 'chassisCurrentA', 72.6, 74.6).t),
  fireGateOpenS: () => M.incident.fireGateOpenS,
  fireGateCloseS: () => M.incident.fireGateCloseS,
  burstShotCount: () => burst.length,
  burstCadenceHz: () => r2((burst.length - 1) / (burst[burst.length - 1].t - burst[0].t)),
  burstMuzzleMps: () => {
    const set = new Set(burst.map((s) => s.muzzleMps));
    return set.size === 1 ? [...set][0] : -1;
  },
  burstFirstShotS: () => r2(burst[0].t),
  burstLastShotS: () => r3(burst[burst.length - 1].t),

  burstHeatAdded: () => r3(burst.reduce((a, s) => a + s.muzzleMps, 0)),
  crossingShotIndex: () => {
    for (let i = 0; i < burst.length; i++) {
      const tick = Math.ceil(r3(burst[i].t) * 10 - 1e-9);
      if (ref.shooterHeat0[tick] > HEAT_LIMIT) return i + 1;
    }
    return -1;
  },
  crossingShotS: () => r3(burst[11].t),
  crossingHeat: () => r3(at('/blue1/referee', 'shooterHeat0', 74.2)),
  peakShooterHeat0: () => r3(maxIn('/blue1/referee', 'shooterHeat0', 0, 180).v),
  peakShooterHeat0TS: () => r2(maxIn('/blue1/referee', 'shooterHeat0', 0, 180).t),
  deductionTickCount: () => exceed.length,
  firstDeductionTickS: () => r2(exceed[0].t),
  lastDeductionTickS: () => r2(exceed[exceed.length - 1].t),
  hpAfterFirstDeduction: () => at('/blue1/referee', 'remainHP', 74.2),
  overheatLossHP: () => exceed.reduce((a, d) => a + d.amount, 0),
  hpAfterIncident: () => at('/blue1/referee', 'remainHP', 75.0),
  heatBackToZeroS: () => {
    const b = ch('/blue1/referee');
    for (let i = 0; i < b.t.length; i++) if (b.t[i] > 75.0 && b.shooterHeat0[i] === 0) return r2(b.t[i]);
    return -1;
  },

  blueBuffStartS: () => blueBuff.tStartS,
  blueBuffEndS: () => blueBuff.tEndS,
  buffedHitsOnBlue2: () => E.hits.filter((h) => h.targetId === 14 && h.amount === 25).length,
  firstEnemyHitOnBlue1S: () => r2(E.hits.filter((h) => h.targetId === 13).sort((a, b) => a.t - b.t)[0].t),
  blue1HPThroughBuffWindow: () => {
    const b = ch('/blue1/referee');
    const set = new Set();
    for (let i = 0; i < b.t.length; i++) if (b.t[i] >= 35.0 && b.t[i] <= 65.0) set.add(b.remainHP[i]);
    return set.size === 1 ? [...set][0] : -1;
  },

  uwbResidualBaselineM: () => {
    const b = ch('/blue1/localization');
    let s = 0;
    let n = 0;
    for (let i = 0; i < b.t.length; i++) {
      if (b.t[i] < 5.0 || b.t[i] > 35.0) continue;
      s += b.uwbResidualM[i];
      n++;
    }
    return r3(s / n);
  },
  uwbResidualPeakM: () => r3(maxIn('/blue1/localization', 'uwbResidualM', 43.0, 49.0).v),
  uwbResidualPeakTS: () => r2(maxIn('/blue1/localization', 'uwbResidualM', 43.0, 49.0).t),
  uwbResidualSettleM: () => Math.ceil(maxIn('/blue1/localization', 'uwbResidualM', 46.5, 47.5).v * 100) / 100,

  armorLossBlue1: () => E.hits.filter((h) => h.targetId === 13).reduce((a, h) => a + h.amount, 0),
  deductionRed: () => E.result.deduction.red,
  deductionBlue: () => E.result.deduction.blue,
  finalHPRed1: () => E.result.finalHP['Red 1'],
  finalHPRed2: () => E.result.finalHP['Red 2'],
  finalHPBlue1: () => ref.remainHP[ref.t.length - 1],
  finalHPBlue2: () => E.result.finalHP['Blue 2'],
  resultWinner: () => E.result.winner,
  counterfactualWinner: () => {
    const cf = { ...myDeduction };
    for (const e of myExceed) cf[TEAM_OF[e.targetId] === 'blue' ? 'red' : 'blue'] -= e.amount;
    return cf.red > cf.blue ? 'RED_WIN' : cf.blue > cf.red ? 'BLUE_WIN' : 'DRAW';
  },
  counterfactualDeductionRed: () => {
    let red = myDeduction.red;
    for (const e of myExceed) if (TEAM_OF[e.targetId] === 'blue') red -= e.amount;
    return red;
  },
};

/** The frozen run of the chase goal, computed once and shared by three claims. */
let _frozen = null;
function frozenRun() {
  if (_frozen) return _frozen;
  const b = ch('/blue1/planner');
  const anchor = Math.round((72.3 - b.t[0]) * D.rates['/blue1/planner']);
  const v = b.goalDistM[anchor];
  let lo = anchor;
  let hi = anchor;
  while (lo > 0 && b.goalDistM[lo - 1] === v) lo--;
  while (hi < b.t.length - 1 && b.goalDistM[hi + 1] === v) hi++;
  _frozen = { t0: b.t[lo], t1: b.t[hi], n: hi - lo + 1, v };
  return _frozen;
}

const claimNames = Object.keys(C.DATA_CLAIMS);
eq(
  JSON.stringify(claimNames.filter((n) => !RESOLVERS[n])),
  '[]',
  'every DATA_CLAIM has a resolver, so no claim can escape being checked',
);
for (const name of claimNames) {
  const claim = C.DATA_CLAIMS[name];
  const got = RESOLVERS[name]();
  if (typeof claim.expected === 'number') {
    near(got, claim.expected, 5e-4, `claim ${name} resolves to the exported value`);
  } else {
    eq(got, claim.expected, `claim ${name} resolves to the exported value`);
  }
  ok(typeof claim.unit === 'string' && claim.unit.length >= 0, `claim ${name} declares a unit`);
  ok(claim.tOrEventId !== undefined, `claim ${name} is bound to a timestamp or an event list`);
  if (claim.channel) ok(paths.includes(claim.channel), `claim ${name} names a real channel`);
  if (claim.channel && claim.field) {
    ok(
      D.channels.find((c) => c.path === claim.channel).fields.some((f) => f.key === claim.field),
      `claim ${name} names a real field on ${claim.channel}`,
    );
  }
}
// cited constants are validated against the frozen rules echo and NEVER against telemetry
{
  const R = M.rules;
  const RULE_OF = {
    initialHP: R.initialHP,
    roundDurationS: R.roundDurationS,
    heatLimit: R.heatLimit,
    heatOverDeductionMultiplier: R.heatOverDeductionMultiplier,
    settlementRateHz: R.settlementRateHz,
    coolingPerSecond: R.coolingPerSecond,
    coolingPerTick: R.coolingPerSecond / R.settlementRateHz,
    coolingPerSecondBelow400HP: R.coolingPerSecondBelow400HP,
    armorDamageHP: R.armorDamageHP,
    buffedArmorDamageHP: R.armorDamageBuffedHP,
    muzzleLimitMps: R.muzzleLimitMps,
    impactFloorMps: R.impactRegistrationFloorMps,
    armorDetectionMaxHz: R.armorDetectionMaxHz,
    burstCadenceMaxPerS: R.burstCadenceMaxPerS,
    defenseDwellS: R.defenseZone.dwellS,
    defenseBuffS: R.defenseZone.buffS,
    activationsPerWindow: R.defenseZone.activationsPerWindow,
    supplyRounds: R.supplier.roundsPerInstruction,
    instructionsPerTeamPerMinute: R.supplier.instructionsPerTeamPerMinute,
    preloadRounds: R.supplier.preloadRoundsOnOneRobotPerTeam,
    gimbalYawRelDegLimit: META.geometry.kinematicCaps.gimbalYawRelDeg,
    projectileMassG: R.projectile.massG,
    projectileDiameterMm: R.projectile.diameterMm,
    lowHpCoolingThresholdHP: 400,
    robotsPerTeam: META.teams[0].robots.length,
    arenaLengthM: META.geometry.arena.xM,
    arenaWidthM: META.geometry.arena.yM,
  };
  eq(META.teams[0].robots.length, META.teams[1].robots.length, 'both teams field the same robot count');
  for (const name of Object.keys(C.CITED_CONSTANTS)) {
    ok(RULE_OF[name] !== undefined, `cited constant ${name} has a frozen rules echo to check against`);
    eq(C.CITED_CONSTANTS[name].value, RULE_OF[name], `cited constant ${name} matches the frozen rules echo`);
    ok(/^S\d|Manual|60 heat|frozen/.test(C.CITED_CONSTANTS[name].source), `cited constant ${name} carries a source`);
  }
  // the V1.0 heat numbers are double these and must never be mixed in
  eq(R.heatLimit, 180, 'the heat limit is the V1.1 value');
  eq(R.coolingPerSecond, 60, 'the cooling rate is the V1.1 value');
}

// ---- no number in a narrative that the ledger does not carry
{
  const allowedNumbers = C.allowedNumbers();
  const allowedTexts = C.allowedTexts();
  // Identifiers are not claims. A field named shooterHeat0 puts a digit in a sentence that is part
  // of a NAME, so every declared field key and channel path comes out of the text before it is
  // tokenized; anything left that looks like a number has to be a claim.
  const identifiers = [];
  for (const c of D.channels) {
    identifiers.push(c.path);
    for (const f of c.fields) identifiers.push(f.key);
  }
  identifiers.sort((a, b) => b.length - a.length);
  const deIdentify = (s) => identifiers.reduce((acc, id) => acc.split(id).join(' '), s);
  const bad = [];
  for (const f of D.findings) {
    for (const key of ['title', 'note', 'honesty']) {
      const s = deIdentify(f[key] || '');
      for (const m of s.matchAll(/-?\d+(?:\.\d+)?/g)) {
        const tok = m[0];
        if (allowedTexts.has(tok)) continue;
        if (allowedNumbers.has(Number(tok))) continue;
        bad.push(`${f.id}.${key}: "${tok}"`);
      }
    }
  }
  eq(bad.length, 0, `every number in every narrative is in the claim ledger  ${bad.slice(0, 4).join(' | ')}`);
  // and the scan is not vacuous: the narratives really are full of numbers
  const total = D.findings.reduce(
    (a, f) => a + [...deIdentify(`${f.title} ${f.note} ${f.honesty}`).matchAll(/-?\d+(?:\.\d+)?/g)].length,
    0,
  );
  ok(total > 50, `the narratives quote ${total} numeric tokens, so the scan has something to catch`);
}

// ---------------------------------------------------------------- the round event ledger

section('event lines');
{
  const rows = D.eventLines();
  ok(Array.isArray(rows), 'eventLines() returns an array');
  ok(rows.length > 0 && rows.length <= 30, `at most thirty rows (${rows.length})`);
  const SOURCES = new Set(['field_supplier_status', 'field_bonus_status', 'robot_shoot', 'robot_damage', 'game_survivor', 'game_result']);
  let sorted = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].t < rows[i - 1].t) sorted = false;
  ok(sorted, 'rows are sorted by replay time');
  for (const r of rows) {
    ok(typeof r.t === 'number' && r.t >= 0 && r.t <= 180, `row at ${r.t}: t is inside the round`);
    ok(SOURCES.has(r.source), `row at ${r.t}: source "${r.source}" is a referee message name`);
    ok(typeof r.kind === 'string' && r.kind.length > 0, `row at ${r.t}: kind is a string`);
    ok(typeof r.detail === 'string' && r.detail.length > 0, `row at ${r.t}: detail is a string`);
    eq(Object.keys(r).length, 4, `row at ${r.t}: fixed format, four fields`);
  }
  const kinds = rows.map((r) => r.kind);
  eq(kinds.filter((k) => k === 'EXCEED_HEAT').length, 8, 'all eight overheat ticks are rendered, one row each');
  eq(kinds.filter((k) => k === 'PREPARING').length, 2, 'both supplier bookings are rendered');
  eq(kinds.filter((k) => k === 'CLOSE').length, 2, 'both supplier issues are rendered');
  eq(rows.filter((r) => r.source === 'field_bonus_status').length, E.zones.length, 'every zone transition and refresh mark is rendered');
  eq(kinds.filter((k) => k === 'REFRESH').length, 2, 'both activation-budget refresh marks are rendered');
  eq(kinds.filter((k) => k === 'BURST_FIRST').length, 1, 'the first round of the burst is rendered');
  eq(kinds.filter((k) => k === 'BURST_LAST').length, 1, 'the last round of the burst is rendered');
  eq(kinds.filter((k) => k === 'SURVIVORS').length, 1, 'the closing survivor bitmask is rendered');
  eq(kinds.filter((k) => k === 'CALCULATION').length, 1, 'the result is rendered');
  ok(rows.some((r) => r.kind === 'BEING_OCCUPIED'), 'the defense-zone dwell is rendered');
  ok(rows.some((r) => r.kind === 'OCCUPIED'), 'the defense-zone activation is rendered');
  ok(rows.some((r) => r.kind === 'UNOCCUPIED'), 'the defense-zone expiry is rendered');
  ok(/RED_WIN/.test(rows[rows.length - 1].detail), 'the last row carries the result');
}

// ---------------------------------------------------------------- 7. determinism and purity

section('determinism');
{
  const again = D.buildData(() => 0.25);
  let identical = true;
  for (const p of paths) {
    for (const k of Object.keys(data[p])) {
      const a = data[p][k];
      const b = again[p][k];
      if (a.length !== b.length) identical = false;
      else for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) identical = false;
    }
  }
  ok(identical, 'two buildData runs are byte-identical, whatever the seeded stream does');
}
// Built from code points so that this file does not itself contain the characters it bans.
const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
const BATTLE_FILES = (await readdir(BATTLE)).filter((f) => /\.(js|mjs)$/.test(f));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SOURCES = {};
for (const f of BATTLE_FILES) SOURCES[f] = await readFile(path.join(BATTLE, f), 'utf8');
ok(BATTLE_FILES.includes('claims.mjs'), 'the claim ledger ships beside the data');
for (const f of BATTLE_FILES) {
  ok(!/Math\.random\s*\(/.test(stripComments(SOURCES[f])), `${f} never calls Math.random`);
  ok(!DASHES.test(SOURCES[f]), `${f} contains no em or en dashes`);
}
ok(/export let previewData/.test(SOURCES['data.js']), 'data.js exports previewData for the picker and the brief');

// ---------------------------------------------------------------- 9. the anachronism ban list

section('anachronism ban list');
// A May-2019-faithful round must not contain anything from a later protocol revision, a different
// competition, or the other mission's private source. The tokens are ASSEMBLED FROM FRAGMENTS so
// that this test file does not itself contain the literals it is banning.
const BANNED = [
  ['0x00', '05'].join(''), // buff/debuff zone status, a 2020+ message
  ['0x02', '08'].join(''), // remaining-projectile message, a later revision
  ['bullet_', 'remaining'].join(''), // the same message by name
  ['game_robot_', 'HP'].join(''), // the health-array survivor form, a later revision
  ['buff_', 'debuff'].join(''),
  ['hurt_', 'type'].join(''), // the later revision shifts its semantics
  ['3.2', ' g'].join(''), // wrong projectile mass, a different competition
  ['3.4', ' g'].join(''), // wrong projectile mass, the robot user manual's figure
  ['RM', 'UC'].join(''), // the other, larger competition
  ['V2', '.0'].join(''), // the post-event protocol appendix
  ['Robo', 'Cup'].join(''), // the one competition name that must never appear in a battle file
  ['Small Size ', 'League'].join(''),
  ['TIG', 'ERs'].join(''),
  ['s', 'sl-'].join(''), // the other mission's identifier prefix
];
const HAYSTACKS = { 'match META': JSON.stringify(META), 'preview META': JSON.stringify(D.previewData.meta) };
for (const f of BATTLE_FILES) HAYSTACKS[f] = SOURCES[f];
for (const [where, text] of Object.entries(HAYSTACKS)) {
  const lower = text.toLowerCase();
  for (const token of BANNED) {
    ok(!lower.includes(token.toLowerCase()), `${where}: does not contain a banned token (${token.length} chars)`);
  }
}
// and the mission does name itself factually, which is the point of the attribution rule
ok(/RoboMaster/.test(META.mission.title), 'the mission names the competition factually');
ok(/SIMULATED|simulated/.test(META.mission.disclosure), 'and discloses that the round is simulated');
ok(/synthetic/i.test(META.mission.disclosure), 'and that the telemetry is synthetic');

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
