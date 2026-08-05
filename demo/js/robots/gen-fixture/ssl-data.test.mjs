// ssl-data.test.mjs - self-test for demo/js/robots/ssl/{decode.js, data.js}.
//
//   node demo/js/robots/gen-fixture/ssl-data.test.mjs
//
// This directory is in .assetsignore, so nothing here is ever served. It is the natural home for
// a test that has to import the real generated modules.
//
// What it proves:
//   1  the byte decoder reproduces the exporter's own published METAdata
//   2  every channel field carries complete two-dimensional provenance
//   3  no channel needs more than two y-axis unit groups (chart.js labels exactly two)
//   4  every synthesized value sits in a physically plausible range (Tier S20)
//   5  every finding window is inside the mission and focuses a channel that exists
//   6  every number quoted in a finding is the value at that exact sample (prose == plot)
//   7  every real anchor a finding leans on is really in the decoded data
//   8  buildData is deterministic and pure of Math.random
//   9  buildData throws if it runs before loadSceneData resolves
//  10  decode is fast enough to sit in the demo's mount path
//  11  the degenerate-interval rule (FORMAT.md 4.2) snaps to the LATER sample, checked against
//      the producer's one real back-to-back ball pair rather than a fabricated one
//  12  the VISION_2014 cross-check ships UNCROPPED, checked against the exporter's own
//      pre-publication extract (ssl-vision-cache.fixture.json) rather than against itself
//  13  every beat of the anatomy step's directed fly-through is over footage that shows what its
//      card claims, measured off this same decoded payload

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SSL = path.join(HERE, '..', 'ssl');

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

// ---------------------------------------------------------------- 9. tripwire, BEFORE any load

section('tripwire');
const D = await import('../ssl/data.js');
let threw = null;
try {
  D.buildData(() => 0.5);
} catch (err) {
  threw = err;
}
ok(threw !== null, 'buildData() throws before loadSceneData() resolves');
ok(
  threw && /loadSceneData/.test(threw.message),
  'the tripwire message names loadSceneData so the caller knows the fix',
);
ok(D.isSceneDataLoaded() === false, 'isSceneDataLoaded() is false before loading');
ok(D.previewData !== null, 'previewData decoded at module scope without a load');
ok(D.getSceneData() === D.previewData, 'getSceneData() falls back to the preview slice');

// ---------------------------------------------------------------- 1. decoder vs published META

section('decoder');
const decode = await import('../ssl/decode.js');
const IP = await import('../ssl/in-play.js');
const matchMod = await import('../ssl/match-data.js');
const previewMod = await import('../ssl/preview-data.js');

const tDec0 = performance.now();
const M = decode.decodeMatchData(matchMod);
const decodeMs = performance.now() - tDec0;
console.log(`  decode: ${decodeMs.toFixed(1)} ms`);
ok(decodeMs < 50, `match decode under 50 ms (was ${decodeMs.toFixed(1)} ms)`);

const tPrev0 = performance.now();
const PV = decode.decodeMatchData(previewMod);
const previewMs = performance.now() - tPrev0;
console.log(`  preview decode: ${previewMs.toFixed(2)} ms`);
ok(previewMs < 5, `preview decode under 5 ms, which is what makes module-scope decoding fair game`);

eq(M.datasetHash, PV.datasetHash, 'both modules carry the same DATASET_HASH');
eq(M.formatVersion, 1, 'format version 1');
eq(M.variant, 'match', 'match variant');
eq(PV.variant, 'preview', 'preview variant');
eq(M.robots.length, matchMod.META.robots.length, 'robot count matches META');
for (const meta of matchMod.META.robots) {
  const r = M.robots.find((x) => x.refereeColor === meta.refereeColor && x.id === meta.id);
  ok(!!r, `robot ${meta.refereeColor}${meta.id} decoded`);
  eq(r.nPresent, meta.nPresent, `${r.name} nPresent popcount matches META`);
  near(r.presentFrac, meta.presentFrac, 5e-4, `${r.name} presentFrac matches META`);
}
// STRUCTURAL EQUIVALENCE of the two payloads' geometry. `getSceneData()` hands either one to the
// same `buildScene`, so every geometry key that module reads has to be in BOTH, carrying the same
// value. The preview's geometry was a hand-listed subset written once and never re-derived when the
// scene grew, so it lost `boundaryWidthGoalLine` (the picker card and the brief hero drew a 0.3 m
// goal-line run-off where the packet says 0.6 m) and `goalCenterToPenaltyMark` (no penalty marks at
// all) - a different pitch under a contract that says the shapes are the same.
//
// The consumed set is READ OUT OF scene.js rather than written here, because a second hand-written
// copy of it would go stale the same way the first one did.
{
  const sceneSrc = await readFile(path.join(SSL, 'scene.js'), 'utf8');
  const readKeys = [
    ...new Set(
      [...sceneSrc.matchAll(/\b(?:geo|data\.geometry|D\.geometry)\.([A-Za-z]+)/g)].map((m) => m[1]),
    ),
  ].sort();
  // the two the preview used to drop, pinned so an empty regex result cannot pass this silently
  for (const k of ['boundaryWidthGoalLine', 'goalCenterToPenaltyMark']) {
    ok(readKeys.includes(k), `the scene really does read geometry.${k}`);
  }
  for (const k of readKeys) {
    ok(M.geometry[k] !== undefined, `match geometry carries ${k}, which the scene reads`);
    ok(PV.geometry[k] !== undefined, `preview geometry carries ${k}, which the scene reads`);
  }
  // and every key the preview does carry agrees with the match: a preview that has the right keys
  // and the wrong numbers is the same bug with an extra step.
  const differing = Object.keys(PV.geometry).filter(
    (k) => JSON.stringify(M.geometry[k]) !== JSON.stringify(PV.geometry[k]),
  );
  eq(differing.join(',') || 'none', 'none', 'every geometry value the preview carries is the match\'s');
}

eq(M.ball.segments.length, matchMod.META.ball.segments.length, 'ball segment count matches META');
eq(M.tBall.length, matchMod.META.grid.nBall, 'ball grid length');
eq(M.tRobot.length, matchMod.META.grid.nRobot, 'robot grid length');
ok(M.tBall[0] === 0, 'the replay axis starts at 0');
let monotone = true;
for (let i = 1; i < M.tBall.length; i++) if (M.tBall[i] <= M.tBall[i - 1]) monotone = false;
ok(monotone, 'the replay axis is strictly increasing');

// the exporter's own visibility-dip statistics, recomputed from the decoded bytes
const dip = M.visibilityDips[1];
const b13 = M.robots.find((r) => r.name === `${dip.refereeColor}${dip.id}`);
let dipMin = Infinity;
let dipSum = 0;
let dipN = 0;
for (let i = 0; i < M.tRobot.length; i++) {
  const t = M.tRobot[i];
  if (t < dip.t || t > dip.tEnd || !b13.present[i]) continue;
  dipMin = Math.min(dipMin, b13.vis[i]);
  dipSum += b13.vis[i];
  dipN++;
}
near(dipMin, dip.minVisibility, 0.005, 'decoded visibility dip minimum matches META');
near(dipSum / dipN, dip.meanVisibility, 0.005, 'decoded visibility dip mean matches META');

// geometry sanity: everything on the pitch
let inBounds = true;
for (const r of M.robots) {
  for (let i = 0; i < M.tRobot.length; i++) {
    if (!r.present[i]) continue;
    if (Math.abs(r.x[i]) > 6.7 || Math.abs(r.y[i]) > 5.2) inBounds = false;
  }
}
ok(inBounds, 'every tracked robot sample is inside the carpet');

// interpolation contract: never crosses a gap
const y2 = M.robots.find((r) => r.name === 'yellow2');
const gapT = (M.tRobot[y2.runs[0][0] + y2.runs[0][1] - 1] + M.tRobot[M.tRobot.length - 1]) / 2;
const held = decode.sampleSeries(M.tRobot, y2.present, y2.x, y2.vx, gapT);
ok(Number.isFinite(held), 'sampling inside an absence holds instead of producing NaN');

// ---------------------------------------------------------------- load + build

section('build');
const loaded = await D.loadSceneData();
ok(D.isSceneDataLoaded(), 'isSceneDataLoaded() is true after loadSceneData()');
ok(D.getSceneData() === loaded, 'getSceneData() returns the decoded match data once loaded');
ok((await D.loadSceneData()) === loaded, 'loadSceneData() is idempotent and returns one promise');

const { mulberry32, seedFor } = await import('../../core/prng.js');
const tB0 = performance.now();
const data = D.buildData(mulberry32(seedFor('ssl')));
console.log(`  buildData: ${(performance.now() - tB0).toFixed(1)} ms`);

// ---------------------------------------------------------------- 2, 3. channels + provenance

section('channels');
const ORIGINS = new Set(['REAL_TRACKER', 'REAL_GAME_CONTROLLER', 'REAL_VISION', 'SYNTHETIC']);
const paths = D.channels.map((c) => c.path);
eq(paths.length, new Set(paths).size, 'channel paths are unique');
eq(
  JSON.stringify(Object.keys(data).sort()),
  JSON.stringify([...paths].sort()),
  'buildData returns exactly the declared channels',
);

for (const ch of D.channels) {
  ok(ch.fields.length >= 1 && ch.fields.length <= 6, `${ch.path}: 1-6 fields`);
  const units = new Set(ch.fields.map((f) => f.unit));
  ok(
    units.size <= 2,
    `${ch.path}: at most two unit groups (chart.js labels only axes 0 and 1) - has ${units.size}`,
  );
  ok(typeof D.rates[ch.path] === 'number', `${ch.path}: declared in rates`);
  ok(typeof D.rateNotes[ch.path] === 'string', `${ch.path}: declared in rateNotes`);
  const built = data[ch.path];
  ok(!!built && built.t && built.t.length > 1, `${ch.path}: built with a time axis`);
  near(
    (built.t.length - 1) / (built.t[built.t.length - 1] - built.t[0]),
    D.rates[ch.path],
    0.02,
    `${ch.path}: built cadence matches its declared rate`,
  );
  for (const f of ch.fields) {
    const p = f.provenance;
    ok(!!p, `${ch.path}.${f.key}: has provenance`);
    ok(p && ORIGINS.has(p.origin), `${ch.path}.${f.key}: origin is in the vocabulary`);
    ok(
      p && (p.transform === 'WIRE' || p.transform === 'NONE' || p.transform === 'FIRMWARE_FLAG_DECODE' || /^DERIVED_[A-Z_]+$/.test(p.transform)),
      `${ch.path}.${f.key}: transform is WIRE | NONE | FIRMWARE_FLAG_DECODE | DERIVED_<X>`,
    );
    ok(p && typeof p.note === 'string' && p.note.length > 10, `${ch.path}.${f.key}: provenance note`);
    ok(typeof f.unit === 'string', `${ch.path}.${f.key}: unit string`);
    const arr = built[f.key];
    ok(arr && arr.length === built.t.length, `${ch.path}.${f.key}: array is the length of t`);
    let finite = true;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) finite = false;
    ok(finite, `${ch.path}.${f.key}: every sample is finite`);
  }
}

// the two real channels must not be labelled synthetic, and vice versa
const originOf = (p, k) =>
  D.channels.find((c) => c.path === p).fields.find((f) => f.key === k).provenance.origin;
eq(originOf('/bot13/vision', 'visibility'), 'REAL_TRACKER', '/bot13/vision visibility is real');
eq(originOf('/bot13/vision', 'detections'), 'REAL_VISION', '/bot13/vision detections are real');
eq(originOf('/match', 'ballSpeed'), 'REAL_TRACKER', '/match ballSpeed is real');
for (const p of ['/bot8/kicker', '/bot8/power', '/bot7/radio', '/bot3/dribbler']) {
  for (const f of D.channels.find((c) => c.path === p).fields) {
    eq(f.provenance.origin, 'SYNTHETIC', `${p}.${f.key} is declared synthetic`);
  }
}

// ---------------------------------------------------------------- 4. plausible ranges (S20)

section('ranges');
const range = (p, k) => {
  const a = data[p][k];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    lo = Math.min(lo, a[i]);
    hi = Math.max(hi, a[i]);
  }
  return [lo, hi];
};
const within = (p, k, lo, hi) => {
  const [a, b] = range(p, k);
  ok(a >= lo && b <= hi, `${p}.${k} inside [${lo}, ${hi}] (is [${a.toFixed(2)}, ${b.toFixed(2)}])`);
};
within('/bot8/kicker', 'kickerLevel', 0, 240);
within('/bot8/kicker', 'kickerMax', 240, 240);
within('/bot8/power', 'batteryV', 19.8, 25.2);
within('/bot8/power', 'batteryPercent', 0, 100);
within('/bot7/radio', 'rxRssi', -90, -40);
within('/bot7/radio', 'rxPacketsLost', 0, 400);
within('/bot7/radio', 'rxCrcErrors', 0, 400);
within('/bot3/dribbler', 'dribCurrent', 0, 15);
within('/bot3/dribbler', 'dribTempEstC', 20, 120);
within('/bot13/vision', 'visibility', 0, 1);
within('/bot13/vision', 'detections', 0, 60);
within('/match', 'ballSpeed', 0, 6.5); // the rules cap; the reconstruction must not exceed it
within('/match', 'ballHeight', 0, 1.0);

// the fault must actually leave the published dribbler band, and must be inside it free-spinning
ok(range('/bot3/dribbler', 'dribCurrent')[1] > 8, 'dribCurrent really does leave the 2-8 A band');
// the kicker must never reach its own set point after the fault develops
let latePeak = 0;
for (let i = 0; i < data['/bot8/kicker'].t.length; i++) {
  if (data['/bot8/kicker'].t[i] < 35) continue;
  latePeak = Math.max(latePeak, data['/bot8/kicker'].kickerLevel[i]);
}
ok(latePeak < 240, `kickerLevel never reaches kickerMax after 35 s (peak ${latePeak} V)`);

// ---------------------------------------------------------------- 5. findings

section('findings');
const SEVERITIES = new Set(['info', 'warn', 'alert']);
const HEALTH = new Set(['READY', 'DEGRADED', 'UNUSABLE']);
const robotKeys = new Set(M.robots.map((r) => r.key));
eq(D.findings.length, 4, 'four findings, one per fault');
eq(D.findings.length, new Set(D.findings.map((f) => f.id)).size, 'finding ids are unique');
for (const f of D.findings) {
  ok(Array.isArray(f.window) && f.window.length === 2, `${f.id}: window is a pair`);
  ok(f.window[0] >= 0 && f.window[1] <= D.duration, `${f.id}: window inside [0, ${D.duration}]`);
  ok(f.window[0] < f.window[1], `${f.id}: window is ordered`);
  ok(f.t >= f.window[0] && f.t <= f.window[1], `${f.id}: t is inside its own window`);
  ok(SEVERITIES.has(f.severity), `${f.id}: severity in {info, warn, alert}`);
  ok(typeof f.slowmo === 'boolean', `${f.id}: slowmo is a boolean`);
  const ch = D.channels.find((c) => c.path === f.focus.channel);
  ok(!!ch, `${f.id}: focus channel exists`);
  for (const key of f.focus.fields) {
    ok(ch.fields.some((x) => x.key === key), `${f.id}: focus field ${key} exists on ${ch.path}`);
  }
  ok(
    f.highlight === null || robotKeys.has(f.highlight),
    `${f.id}: highlight "${f.highlight}" is a real decoded robot key`,
  );
  ok(
    f.healthState === null || HEALTH.has(f.healthState),
    `${f.id}: healthState is an ERobotHealthState or null`,
  );
  ok(typeof f.honesty === 'string' && f.honesty.length > 40, `${f.id}: carries an honesty line`);
}
eq(
  D.findings.find((f) => f.id === 'vision-confidence').healthState,
  null,
  'the opponent robot gets no health state',
);

// ---------------------------------------------------------------- 6. quoted values are pinned

section('quoted values');
const at = (p, s) => {
  const t = data[p].t;
  let lo = 0;
  let hi = t.length - 1;
  if (s <= t[0]) return 0;
  if (s >= t[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= s) lo = mid;
    else hi = mid;
  }
  return s - t[lo] <= t[hi] - s ? lo : hi;
};
const sample = (p, k, s) => data[p][k][at(p, s)];
const noteOf = (id) => D.findings.find((f) => f.id === id).note;

// kicker
eq(sample('/bot8/kicker', 'kickerLevel', 6.0), 236, 'kickerLevel is 236 V at 6.00 s');
eq(sample('/bot8/kicker', 'kickerLevel', 53.95), 179, 'kickerLevel is 179 V just before the kick');
eq(sample('/bot8/kicker', 'kickerLevel', 54.15), 21, 'kickerLevel is 21 V just after the kick');
eq(sample('/bot8/kicker', 'kickerLevel', 108.9), 41, 'kickerLevel is 41 V at 108.90 s');
eq(sample('/bot8/kicker', 'kickerMax', 55.0), 240, 'kickerMax is 240 V');
for (const n of ['236', '179', '21', '41', '240']) {
  ok(noteOf('kicker-charge').includes(n), `the kicker note quotes ${n}`);
}

// radio
eq(sample('/bot7/radio', 'rxRssi', 33.4), -88.1, 'rxRssi floors at -88.1 dBm at 33.40 s');
eq(sample('/bot7/radio', 'rxPacketsLost', 33.3), 164, 'rxPacketsLost peaks at 164 pkt/s at 33.30 s');
eq(sample('/bot7/radio', 'rxCrcErrors', 34.0), 46, 'rxCrcErrors peaks at 46 pkt/s at 34.00 s');
eq(sample('/bot7/radio', 'rxRssi', 32.5), -59.4, 'rxRssi baseline is -59.4 dBm before the burst');
eq(range('/bot7/radio', 'rxPacketsLost')[1], 164, 'the quoted loss peak really is the maximum');
// The floor is quoted as the floor OF THE FIRST BURST, not of the channel: the four bursts all
// reach the same modelled fade floor and the deepest sample of the window sits in the second one.
{
  const t = data['/bot7/radio'].t;
  const v = data['/bot7/radio'].rxRssi;
  let lo = Infinity;
  for (let i = 0; i < t.length; i++) if (t[i] >= 32.5 && t[i] <= 34.6) lo = Math.min(lo, v[i]);
  eq(lo, -88.1, 'the quoted floor really is the minimum of the first burst');
}
for (const n of ['-88.1', '164', '46', '-59.4']) {
  ok(noteOf('radio-degraded').includes(n), `the radio note quotes ${n}`);
}

// dribbler
eq(sample('/bot3/dribbler', 'dribCurrent', 32.9), 11.5, 'dribCurrent peaks at 11.5 A at 32.90 s');
eq(range('/bot3/dribbler', 'dribCurrent')[1], 11.5, 'the quoted current peak really is the maximum');
eq(sample('/bot3/dribbler', 'dribCurrent', 30.0), 3.2, 'dribCurrent free-spins at 3.2 A');
eq(sample('/bot3/dribbler', 'dribTempEstC', 33.7), 92.4, 'dribTempEstC peaks at 92.4 degC at 33.70 s');
eq(range('/bot3/dribbler', 'dribTempEstC')[1], 92.4, 'the quoted temperature peak really is the maximum');
eq(sample('/bot3/dribbler', 'dribCurrent', 33.85), 0, 'the OVERHEATED trip really does cut the motor');
for (const n of ['11.5', '3.2', '92.4', '32.90', '33.70']) {
  ok(noteOf('dribbler-overheat').includes(n), `the dribbler note quotes ${n}`);
}

// the DRIB_TEMP ladder table matches the plotted series
const ladder = D.ladderEventsFor(data['/bot3/dribbler'].t, data['/bot3/dribbler'].dribTempEstC);
eq(
  JSON.stringify(ladder),
  JSON.stringify(D.findings.find((f) => f.id === 'dribbler-overheat').events),
  'the DRIB_TEMP event table matches the built series',
);
ok(ladder.some((e) => e.flag === 'OVERHEATED'), 'the ladder really does reach OVERHEATED');

// vision - REAL values, so these assert the decoder, not a pin
near(sample('/bot13/vision', 'visibility', 28.8), 3 / 255, 1e-6, 'Ferrum #13 bottoms out at 3/255');
eq(sample('/bot13/vision', 'visibility', 40.0), 0, 'visibility is 0 once #13 is in no tracked frame');
ok(noteOf('vision-confidence').includes('0.012'), 'the vision note quotes the 0.012 low');
ok(noteOf('vision-confidence').includes('250'), 'the vision note quotes the 250 detections');

// ---------------------------------------------------------------- 7. real anchors are real

section('real anchors');
const kicksY8 = M.kicks.filter((k) => k.robot.color === 'yellow' && k.robot.id === 8);
eq(kicksY8.length, 2, 'yellow 8 has two kick reports in the window');
near(kicksY8[0].t, 53.977, 1e-3, 'yellow 8 kick at 53.977 s');
const crash = M.referee.gameEvents.find((e) => e.type === 'BOT_CRASH_DRAWN');
ok(crash && crash.botYellow === 8 && crash.botBlue === 2, 'BOT_CRASH_DRAWN really is yellow 8 vs blue 2');
near(crash.t, 53.8672, 1e-3, 'the crash is at 53.867 s');
const dbl = M.referee.gameEvents.filter((e) => e.type === 'ATTACKER_DOUBLE_TOUCHED_BALL');
ok(
  dbl.some((e) => e.byRefereeColor === 'yellow' && e.byBot === 3 && Math.abs(e.t - 34.1216) < 1e-3),
  'ATTACKER_DOUBLE_TOUCHED_BALL really is yellow bot 3 at 34.122 s',
);
const subs = M.referee.gameEvents.filter((e) => e.type === 'BOT_SUBSTITUTION');
eq(subs.length, 1, 'exactly one BOT_SUBSTITUTION in the window');
eq(subs[0].byRefereeColor, 'yellow', 'and it is yellow\'s, not blue\'s');
const abs13 = M.absences.find((a) => a.robot === 'blue13');
eq(abs13.class, 'unknown', "Ferrum #13's absence is classified `unknown`, never `substitution`");
eq(abs13.gcEvidence.length, 0, 'and it has no affirmative game-controller evidence');
// ---- the cross-check, against the UNTRIMMED extract rather than against itself
//
// The published cross-check used to be cropped to the neighbourhood of the visibility dip. That
// crop began after the camera-0 stretch AND after the two-camera overlap, so what shipped was the
// camera-1-only tail - and every check here ran on the crop and agreed with it. A test that reads
// the shipped payload can only ever confirm the payload. The golden fixture beside this file is
// the exporter's own pre-publication extract for #13, so a re-crop fails instead of validating.
const CACHE = JSON.parse(
  await readFile(path.join(HERE, 'ssl-vision-cache.fixture.json'), 'utf8'),
);
const vc = M.visionCrossCheck.robots.blue13;
const truth = CACHE.robotBins.blue13;
eq(M.visionCrossCheck.binSeconds, CACHE.binSeconds, 'the shipped bin grid is the extract\'s');
eq(vc.bins.length, truth.length, `every bin the extract holds for #13 ships (${truth.length})`);
eq(
  JSON.stringify(vc.bins),
  JSON.stringify(truth),
  'and they ship bin for bin, count for count, camera for camera - no crop',
);
eq(
  vc.bins.reduce((a, b) => a + b[1], 0),
  CACHE.totalDetections,
  `${CACHE.totalDetections} detections across the cross-check bins`,
);

// camera composition: 76 bins camera 0 alone, 7 with both, 28 camera 1 alone
const kind = (b) => (b[2].length === 2 ? 'both' : b[2][0] === 0 ? 'cam0' : 'cam1');
const byKind = { cam0: [], both: [], cam1: [] };
for (const b of vc.bins) byKind[kind(b)].push(b);
const comp = CACHE.composition;
eq(byKind.cam0.length, comp.camera0Only.bins, 'camera 0 alone covers 76 bins');
eq(byKind.both.length, comp.bothCameras.bins, 'both cameras cover 7 bins');
eq(byKind.cam1.length, comp.camera1Only.bins, 'camera 1 alone covers 28 bins');
eq(
  byKind.cam0.reduce((a, b) => a + b[1], 0),
  comp.camera0Only.detections,
  `camera 0 alone accounts for ${comp.camera0Only.detections} detections`,
);
eq(
  byKind.both.reduce((a, b) => a + b[1], 0),
  comp.bothCameras.detections,
  `the overlap accounts for ${comp.bothCameras.detections}`,
);
eq(
  byKind.cam1.reduce((a, b) => a + b[1], 0),
  comp.camera1Only.detections,
  `the final camera-1-only interval accounts for ${comp.camera1Only.detections}`,
);
ok(
  new Set(vc.bins.flatMap((b) => b[2])).size === 2,
  'BOTH cameras see #13 at some point: "one camera only" was an artefact of the crop',
);

// handoff ORDERING: camera 0, then the overlap, then camera 1. Never interleaved, which is what
// makes "hands off" the right word and "one camera only" the wrong one.
const runs = [];
for (const k of vc.bins.map(kind)) if (runs[runs.length - 1] !== k) runs.push(k);
eq(
  runs.join(','),
  'cam0,both,cam1',
  'the three stretches run in order and none of them recurs',
);
ok(
  byKind.cam0[byKind.cam0.length - 1][0] < byKind.both[0][0] &&
    byKind.both[byKind.both.length - 1][0] < byKind.cam1[0][0],
  'the overlap sits between the two single-camera stretches',
);
ok(
  byKind.cam1[0][1] >= 18 && byKind.cam1[byKind.cam1.length - 1][1] <= 2,
  'and the camera-1 interval decays: it opens at 18+ per bin and ends at 1-2',
);

// THE END OF THE SERIES IS NOT A ZERO. The copy used to say the detection rate "decays to zero"
// and "to nothing", and the payload holds neither: the covered bins end at ones and twos, and what
// follows each of them is not a smaller count, it is a bin with NO count. Reading a gap as a zero
// is precisely what the coverage mask exists to stop, so the chronology is pinned bin by bin here
// and the wording is swept off every surface below.
{
  const tail = vc.bins.slice(-6).map((b) => [b[0], b[1]]);
  eq(
    JSON.stringify(tail),
    JSON.stringify([
      [105, 1],
      [106, 2],
      [107, 1],
      [108, 2],
      [110, 1],
      [127, 1],
    ]),
    'the last six covered bins are ones and twos, at the bins the copy names',
  );
  const covered = new Set(vc.bins.map((b) => b[0]));
  const gaps = [];
  for (let b = tail[0][0]; b <= tail[tail.length - 1][0]; b++) if (!covered.has(b)) gaps.push(b);
  eq(gaps[0], 109, 'bin 109 carries no count: the reading after 108 is unknown, not smaller');
  eq(
    `${gaps[1]}..${gaps[gaps.length - 1]}`,
    '111..126',
    'and bins 111 to 126 carry none either, which is the gap before the last isolated reading',
  );
  eq(gaps.length, 17, 'seventeen uncovered bins inside the tail, every one of them unknown');
  ok(
    vc.bins.every((b) => b[1] > 0),
    'NO covered bin anywhere in this series holds a zero: nothing here measured one',
  );
}

// ...and no SHIPPED COPY may describe that tail as a decay to zero. A sweep rather than an
// assertion on one string, because the claim leaked from the scripted answer into the finding note
// into the generated facts pack, one copy-paste at a time, and an assertion on the sentence it
// started in would have watched the other two go by.
//
// Scoped to what a reader is actually told: the findings a visitor sees, and the whole facts pack
// the analyst is given (which build-facts composes from the scripted answers, the finding notes,
// the honesty lines and the channel provenance, so one file covers every one of them, and
// `npm run facts:fresh` is what stops it going stale). DESIGN.md and the comments in this repo are
// documentation ABOUT the ban and have to be able to quote it; they are not surfaces.
//
// "to zero" about a SYNTHESIZED channel is a different sentence and stays: the modelled dribbler
// cutout really does drive its current to zero, and that is a measurement of a model. The ban is on
// saying it about a MASKED DETECTION series, where the number is missing rather than small.
{
  const BANNED_ZERO = /to zero|to nothing/i;
  const visionFinding = D.findings.find((f) => f.id === 'vision-confidence');
  ok(!!visionFinding, 'the vision finding is there to be swept');
  for (const key of ['note', 'honesty', 'title', 'healthStateNote']) {
    const s = visionFinding[key];
    ok(
      typeof s !== 'string' || !BANNED_ZERO.test(s),
      `vision-confidence.${key} does not call the masked tail a decay to zero`,
    );
  }
  const pack = await readFile(
    path.join(HERE, '..', '..', '..', '..', 'worker', 'facts.generated.js'),
    'utf8',
  );
  const bad = [];
  for (const m of pack.matchAll(/to zero|to nothing/gi)) {
    const near = pack.slice(Math.max(0, m.index - 220), m.index + 60);
    if (/detection|visibility|coverage|camera/i.test(near)) {
      bad.push(near.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim().slice(-140));
    }
  }
  eq(bad.length, 0, `the facts pack makes no masked-detection claim of a decay to zero  ${bad[0] || ''}`);
}

// the coverage mask: exactly the bins that carry a count, over a span that covers #13's life
{
  const [lo, hi] = vc.binSpan;
  const covered = new Set(vc.bins.map((b) => b[0]));
  eq(vc.coverage.length, hi - lo + 1, 'coverage carries one character per bin of binSpan');
  let disagree = 0;
  for (let b = lo; b <= hi; b++) if ((vc.coverage[b - lo] === '1') !== covered.has(b)) disagree++;
  eq(disagree, 0, 'and it agrees with the bins exactly');
  eq([...vc.coverage].filter((c) => c === '1').length, truth.length, 'covering every shipped bin');
  ok(vc.coverage.includes('0'), 'with real gaps in it, which is the whole point of a mask');
  const life = vc.trackedLifetimeS;
  const b13 = M.robots.find((r) => r.refereeColor === 'blue' && r.id === 13);
  const firstPresent = b13.present.indexOf(1);
  let lastPresent = b13.present.length - 1;
  while (lastPresent >= 0 && !b13.present[lastPresent]) lastPresent--;
  near(life[0], M.tRobot[firstPresent], 1e-3, 'trackedLifetimeS opens at #13\'s first tracked sample');
  near(life[1], M.tRobot[lastPresent], 1e-3, 'and closes at its last');
  ok(
    lo <= Math.floor(life[0] / CACHE.binSeconds) && hi >= Math.floor(life[1] / CACHE.binSeconds),
    'and binSpan covers that whole lifetime, not a window around the flagged event',
  );
}
ok(
  Object.values(M.visionCrossCheck.cameraFramesInWindow).every((n) => n > 8000),
  'both cameras produce detection frames across the window (an aggregate, not per-bin uptime)',
);
ok(
  /aggregate/i.test(M.visionCrossCheck.cameraFramesNote || ''),
  'and the payload says so, so nothing downstream reads it as "up throughout"',
);

// the in-play stalls the radio bursts sit on. The intervals come from the SHARED derivation the
// synthesis and the renderer both use - this test used to carry a fourth copy of the regex, which
// is exactly how the site ended up quoting a 12.0 s charge that never happened.
const live = IP.livePlayIntervals(M.referee, M.ball, M.tBall, D.WINDOW_S);
eq(live.length, 4, 'four in-play stretches in the window');
near(live[0][0], 0, 1e-6, 'the held pre-window free kick was already in play at t = 0');
near(live[1][0], 33.07495, 1e-4, 'the 28.551 s free kick comes into play at 33.075 s');
near(live[2][0], 46.3376, 1e-4, 'the 41.95 s free kick comes into play at 46.338 s');
near(live[3][0], 107.83735, 1e-4, 'the 103.996 s kickoff comes into play at 107.837 s');
ok(
  live.every(([a, b]) => b > a && b <= D.WINDOW_S),
  'every in-play stretch is non-empty and inside the window',
);
// The ceilings never bind here: every restart's ball moves 0.05 m first. Assert the RULE anyway,
// because a kick-off gets ten seconds and a Division A free kick five, and one number for both is
// what the renderer used to do.
eq(IP.restartCeilingS('NORMAL_START'), 10, 'a kick-off has a ten-second ceiling');
eq(IP.restartCeilingS('DIRECT_FREE_BLUE'), 5, 'a Division A free kick has a five-second ceiling');
{
  const cmds = M.referee.commands;
  const times = IP.inPlayTimes(M.referee, M.ball, M.tBall);
  for (let i = 0; i < cmds.length; i++) {
    if (!IP.RESTART_COMMAND.test(cmds[i].command) || cmds[i].heldFromBeforeWindow) continue;
    ok(
      times[i] < cmds[i].t + IP.restartCeilingS(cmds[i].command),
      `${cmds[i].command} at ${cmds[i].t} came into play on real ball movement, not on its ceiling`,
    );
  }
}
const y7 = M.robots.find((r) => r.name === 'yellow7');
const stalls = D.liveStalls(M, y7, live);
eq(stalls.length, 4, 'Polaris #7 has four in-play stalls, which is what the radio note claims');
near(stalls[0][0], 33.075, 1e-2, 'the first stall starts at 33.07 s');
// and #7 really does have the most of any Polaris FIELD robot (the keeper, #6, is excluded
// because standing still on the line is its job, and the note says so).
{
  const worse = M.robots.filter(
    (r) => r.refereeColor === 'yellow' && r.id !== 7 && r.id !== 6 && D.liveStalls(M, r, live).length >= stalls.length,
  );
  eq(worse.length, 0, 'no other Polaris field robot has as many in-play stalls as #7');
}
// and they really are bot-specific, not a referee stoppage
const iAt = (s) => {
  let b = 0;
  for (let i = 0; i < M.tRobot.length; i++) if (Math.abs(M.tRobot[i] - s) < Math.abs(M.tRobot[b] - s)) b = i;
  return b;
};
const i5895 = iAt(58.95);
const movers = M.robots.filter(
  (r) => r.refereeColor === 'yellow' && r.id !== 7 && r.present[i5895] && Math.hypot(r.vx[i5895], r.vy[i5895]) > 0.8,
);
ok(movers.length >= 4, 'at 58.95 s at least four other Polaris robots are moving while #7 is not');

// yellow 3 really does hold the ball longest
const ballAt = (i) => [M.ball.x[i * M.grid.robotStrideOverBall], M.ball.y[i * M.grid.robotStrideOverBall]];
const contactSeconds = (r) => {
  let n = 0;
  for (let i = 0; i < M.tRobot.length; i++) {
    if (!r.present[i]) continue;
    const [bx, by] = ballAt(i);
    if (Math.hypot(r.x[i] - bx, r.y[i] - by) < 0.20) n++;
  }
  return (n * M.durationS) / (M.tRobot.length - 1);
};
const yellows = M.robots.filter((r) => r.refereeColor === 'yellow');
const best = yellows.slice().sort((a, b) => contactSeconds(b) - contactSeconds(a))[0];
eq(best.id, 3, 'Polaris #3 has the most ball contact of any Polaris robot');

// ---------------------------------------------------------------- 11. degenerate intervals

// FORMAT.md 4.2: an interval under 1e-4 s snaps to the LATER sample. This window's ball track has
// exactly ONE such pair, 20 us wide, and the two samples hold different positions, so "later" and
// "earlier" are distinguishable and the test is not vacuous. It is found here rather than pinned
// by index, so a re-export moves the test with the data.
section('degenerate intervals');
{
  const tb = loaded.tBall;
  const pairs = [];
  for (let i = 1; i < tb.length; i++) if (tb[i] - tb[i - 1] < 1e-4) pairs.push(i - 1);
  ok(pairs.length >= 1, `the ball track carries the producer's back-to-back frame pair (${pairs.length})`);
  const j = pairs[0];
  const dt = tb[j + 1] - tb[j];
  ok(dt > 0 && dt < 1e-4, `the pair is degenerate by the format's rule (${(dt * 1e6).toFixed(1)} us)`);
  ok(
    loaded.ball.present[j] === 1 && loaded.ball.present[j + 1] === 1,
    'both samples of the pair are present, so this is rule 4.2 and not rule 4.1',
  );
  ok(
    loaded.ball.x[j] !== loaded.ball.x[j + 1] || loaded.ball.y[j] !== loaded.ball.y[j + 1],
    'the two samples differ, so snapping later is observable',
  );

  const { locate: loc, sampleSeries: samp } = await import('../ssl/decode.js');
  const l = loc(tb, loaded.ball.present, tb[j] + dt / 2);
  eq(l.j, j, 'locate() brackets the degenerate pair');
  eq(l.ok, false, 'locate() refuses to interpolate across it');
  eq(l.snapLater, true, 'locate() reports snapLater');
  eq(
    samp(tb, loaded.ball.present, loaded.ball.x, loaded.ball.vx, tb[j] + dt / 2),
    loaded.ball.x[j + 1],
    'sampleSeries() returns the LATER sample across the degenerate pair',
  );

  // and the presence rule still wins: a gap holds at j whatever the interval is
  const held = new Uint8Array(loaded.ball.present.length);
  held.set(loaded.ball.present);
  held[j + 1] = 0;
  const l2 = loc(tb, held, tb[j] + dt / 2);
  eq(l2.snapLater, false, 'an absent later endpoint is a HOLD, not a snap');
  eq(
    samp(tb, held, loaded.ball.x, loaded.ball.vx, tb[j] + dt / 2),
    loaded.ball.x[j],
    'sampleSeries() holds the earlier sample when the later one is absent',
  );
}

// The scene duplicates this branch twice (robots, ball) rather than calling the decoder, so the
// source is checked directly: a scene that snapped to the earlier sample would be a silent
// divergence from the module every other consumer uses.
{
  const scene = await readFile(path.join(SSL, 'scene.js'), 'utf8');
  const snaps = scene.match(/dt[RB] <= 1e-4 \? [jk]1 : [jk]/g) || [];
  eq(snaps.length, 2, "scene.js snaps to the later sample in both of its hold branches");
}

// ---------------------------------------------------------------- 8. determinism + purity

section('determinism');
const again = D.buildData(mulberry32(seedFor('ssl')));
let identical = true;
for (const p of paths) {
  for (const k of Object.keys(data[p])) {
    const a = data[p][k];
    const b = again[p][k];
    if (a.length !== b.length) identical = false;
    else for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) identical = false;
  }
}
ok(identical, 'two buildData runs with the same seed are byte-identical');

const sources = await Promise.all(
  ['data.js', 'decode.js'].map((f) => readFile(path.join(SSL, f), 'utf8')),
);
// strip comments first: both files TALK about Math.random in their headers
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [i, src] of sources.entries()) {
  ok(
    !/Math\.random\s*\(/.test(stripComments(src)),
    `${['data.js', 'decode.js'][i]} never calls Math.random`,
  );
}
ok(
  /export let previewData/.test(sources[0]),
  'data.js exports previewData for the picker and the brief',
);
ok(
  !/^\s*(?!\/\/).*decodeMatchData/m.test(await readFile(path.join(SSL, 'match-data.js'), 'utf8')),
  'match-data.js decodes nothing at import time',
);

// ---------------------------------------------------------------- 13. the anatomy tour is honest
//
// Each card of the anatomy step is held over a named passage of THIS log, and the whole point of
// naming passages instead of one contiguous window is that the footage has to show the mechanism
// the card is about. That is a claim about the payload, so it is checked against the payload. The
// first version of the tour shipped a dribbler card over 2.9 s in which bot 8 was never closer than
// 1.87 m to the ball; these are the assertions that would have caught it.
section('anatomy tour beats');
{
  const { EXPERIENCE, applyExperience } = await import('../ssl/experience.js');
  const tourDef = {};
  applyExperience(tourDef);
  const tour = tourDef.anatomyTour;
  const beats = new Map((tour.beats || []).map((b) => [b.part, b]));
  const parts = (EXPERIENCE.anatomy.parts || []).map((p) => p.id);

  ok(beats.size === parts.length && parts.every((id) => beats.has(id)), 'every anatomy card has exactly one beat');
  for (const beat of tour.beats || []) {
    const w = beat.window;
    ok(
      Array.isArray(w) && w[0] >= 0 && w[1] > w[0] && w[1] <= D.duration,
      `${beat.part} window is ordered inside 0..${D.duration} (${JSON.stringify(w)})`,
    );
    ok(Array.isArray(beat.pos) && beat.pos.length === 3 && beat.pos.every(Number.isFinite), `${beat.part} has a finite start pose`);
    ok(beat.frame === undefined || beat.frame === 'robot' || beat.frame === 'world', `${beat.part} names a known frame`);
  }

  // The subject, and the samples of it inside a beat. `present` matters: a card held over seconds
  // the tracker never saw this robot is a camera locked to a stale pose.
  const bot = M.robots.find((r) => r.name === 'yellow8');
  ok(!!bot, 'bot 8 is in the decoded roster');
  const dtBall = M.tBall[1] - M.tBall[0];
  const samples = (w) => {
    const out = [];
    for (let i = 0; i < M.tRobot.length; i++) {
      const t = M.tRobot[i];
      if (t < w[0] || t > w[1]) continue;
      const j = Math.max(0, Math.min(M.tBall.length - 1, Math.round(t / dtBall)));
      const dx = M.ball.x[j] - bot.x[i];
      const dy = M.ball.y[j] - bot.y[i];
      let bearing = Math.atan2(dy, dx) - bot.yaw[i];
      while (bearing > Math.PI) bearing -= 2 * Math.PI;
      while (bearing < -Math.PI) bearing += 2 * Math.PI;
      out.push({
        t,
        present: !!bot.present[i],
        speed: Math.hypot(bot.vx[i], bot.vy[i]),
        yawRate: Math.abs(bot.w[i]),
        yaw: bot.yaw[i],
        ball: Math.hypot(dx, dy),
        bearing: Math.abs(bearing),
      });
    }
    return out;
  };

  for (const beat of tour.beats || []) {
    const rows = samples(beat.window);
    ok(rows.length >= 8, `${beat.part} beat has samples to play (${rows.length})`);
    ok(rows.every((r) => r.present), `${beat.part} beat never runs over an untracked stretch of bot 8`);
  }

  // omni: translating hard, and NOT turning to do it. Both halves are the card's claim.
  const omni = samples(beats.get('omni').window);
  ok(Math.max(...omni.map((r) => r.speed)) > 2.0, 'omni beat reaches over 2 m/s');
  ok(
    Math.max(...omni.map((r) => r.yaw)) - Math.min(...omni.map((r) => r.yaw)) < 0.25,
    'omni beat holds its heading inside a quarter radian while it does it',
  );

  // imu: the robot's own rotation, which is the only thing on the overlay that beat can show.
  ok(Math.max(...samples(beats.get('imu').window).map((r) => r.yawRate)) > 4.0, 'imu beat turns faster than 4 rad/s');

  // dribbler: the ball at the mouth, not merely somewhere on the same pitch. The 0.2 m is a hull
  // radius (0.09 m) plus a ball radius (0.0215 m) plus tracker slack; the bearing is the mouth.
  const drib = samples(beats.get('dribbler').window);
  const contact = drib.filter((r) => r.ball < 0.2 && r.bearing < 0.7);
  ok(contact.length >= 3, `dribbler beat has the ball in the mouth (${contact.length} samples under 0.20 m and 40 deg)`);
  ok(Math.max(...drib.map((r) => r.speed)) > 0.35, 'dribbler beat is not a stationary robot');
}

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
