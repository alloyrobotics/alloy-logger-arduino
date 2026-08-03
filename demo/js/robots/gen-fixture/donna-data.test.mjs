// donna-data.test.mjs - twelve-property contract suite for Donna Phase 2.
//
//   node demo/js/robots/gen-fixture/donna-data.test.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DONNA = path.join(HERE, '..', 'donna');
const FIXTURES = path.join(HERE, 'donna-fixtures');

let failures = 0;
let checks = 0;
function ok(condition, message) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${message}`);
  }
}
function eq(actual, expected, message) {
  ok(Object.is(actual, expected), `${message}  (got ${actual}, want ${expected})`);
}
function near(actual, expected, tolerance, message) {
  ok(Math.abs(actual - expected) <= tolerance, `${message}  (got ${actual}, want ${expected} +/- ${tolerance})`);
}
function section(name) {
  console.log(`\n${name}`);
}

const D = await import('../donna/data.js');
const C = await import('../donna/claims.mjs');
const decode = await import('../donna/decode.js');
const fullMod = await import('../donna/donna-data.js');
const previewMod = await import('../donna/preview-data.js');
const fixture = async (name) => JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));

// ---------------------------------------------------------------- 1. tripwires and mission constants

section('1. tripwires and mission constants');
D.__resetSceneDataForTests();
for (const [call, code, label] of [
  [() => D.buildData(() => 0.5), 'DONNA_BUILD_BEFORE_LOAD', 'buildData'],
  [() => D.eventLines(), 'DONNA_EVENTS_BEFORE_LOAD', 'eventLines'],
]) {
  let error = null;
  try {
    call();
  } catch (caught) {
    error = caught;
  }
  ok(error !== null, `${label} throws before loadSceneData resolves`);
  eq(error && error.code, code, `${label} tripwire code`);
  ok(/loadSceneData/.test(error && error.message), `${label} names loadSceneData`);
}
eq(D.isSceneDataLoaded(), false, 'scene data starts unloaded');
ok(D.previewData !== null, 'preview decodes eagerly');
eq(D.getSceneData(), D.previewData, 'getSceneData falls back to preview');
eq(D.duration, 250, 'duration is the frozen 250 s window');
eq(D.heroTime, 187.6, 'hero time is frozen');
eq(D.rate, D.rates['/imu'], 'def.rate follows the SSL summary-rate convention');
eq(D.findings.length, 4, 'Fable cut is exactly four findings');

// ---------------------------------------------------------------- 2. load and cache

section('2. load and cache');
const firstPromise = D.loadSceneData();
const secondPromise = D.loadSceneData();
ok(firstPromise === secondPromise, 'concurrent loads share one promise');
const M = await firstPromise;
const PV = D.previewData;
ok(D.isSceneDataLoaded(), 'scene data is loaded');
eq(D.getSceneData(), M, 'getSceneData returns full mission after load');
eq(await D.loadSceneData(), M, 'later loads resolve to the cached decoded object');

// ---------------------------------------------------------------- 3. five-symbol ABI

section('3. five-symbol ABI');
const ABI = ['BLOB_B64', 'DATASET_HASH', 'FORMAT_VERSION', 'META', 'VARIANT'];
for (const [name, mod] of [['donna-data.js', fullMod], ['preview-data.js', previewMod]]) {
  eq(JSON.stringify(Object.keys(mod).sort()), JSON.stringify(ABI), `${name}: exactly five exports`);
  eq(mod.FORMAT_VERSION, 'donna-team-v2', `${name}: frozen format`);
  ok(/^[0-9a-f]{64}$/.test(mod.DATASET_HASH), `${name}: dataset hash is lowercase sha256`);
  ok(typeof mod.BLOB_B64 === 'string' && mod.BLOB_B64.length > 0, `${name}: non-empty blob`);
  const source = await readFile(path.join(DONNA, name), 'utf8');
  ok(!/\bimport\b/.test(source), `${name}: side-effect-free generated module`);
}
eq(fullMod.VARIANT, 'full', 'full variant name');
eq(previewMod.VARIANT, 'preview', 'preview variant name');
eq(fullMod.DATASET_HASH, previewMod.DATASET_HASH, 'variants share one extraction manifest hash');

// ---------------------------------------------------------------- 4. channel, cadence and provenance contract

section('4. channels, cadence and provenance');
const PATHS = ['/imu', '/motion', '/servos', '/game', '/ball', '/compute'];
const FIELDS = {
  '/imu': ['accelMagMps2', 'pitchDeg', 'rollDeg'],
  '/motion': ['cmdVxMps', 'odomVxMps', 'cmdYawRadps'],
  '/servos': ['maxTempC', 'minBusVoltageV'],
  '/game': ['secondsRemaining', 'ownScore', 'rivalScore'],
  '/ball': ['ballDistM', 'ballBearingDeg'],
  '/compute': ['cpuLoadPct', 'memUsedPct'],
};
eq(JSON.stringify(D.channels.map((channel) => channel.path)), JSON.stringify(PATHS), 'six Donna telemetry channels in order');
eq(JSON.stringify(Object.keys(D.rates)), JSON.stringify(PATHS), 'rates cover exactly the channel table');
eq(JSON.stringify(Object.keys(D.rateNotes)), JSON.stringify(PATHS), 'rateNotes cover exactly the channel table');
for (const channel of D.channels) {
  eq(JSON.stringify(channel.fields.map((field) => field.key)), JSON.stringify(FIELDS[channel.path]), `${channel.path}: exact fields`);
  ok(D.rateNotes[channel.path].includes(`${D.rates[channel.path]} Hz`), `${channel.path}: cadence note names block rate`);
  for (const field of channel.fields) {
    const key = `${channel.path}.${field.key}`;
    eq(field.provenance.origin, 'REAL_MCAP', `${key}: real MCAP origin`);
    ok(field.provenance.transform.includes('+') || field.provenance.transform.includes('_'), `${key}: composite transform token`);
    eq(field.provenance.note, D.fieldRateNotes[key], `${key}: per-field rate note is wired into provenance`);
  }
}
for (const field of D.channels.find((channel) => channel.path === '/ball').fields) {
  eq(field.mask, 'ballSeen', `/ball.${field.key}: mask name`);
  ok(/validity rules/.test(field.maskNote), `/ball.${field.key}: mask note`);
}

// ---------------------------------------------------------------- 5. build shape, cadence and determinism

section('5. build shape, cadence and determinism');
const data = D.buildData(() => 0.25);
const again = D.buildData(() => 0.99);
const TRACK_FOR = {
  '/imu': 'summaryImu',
  '/motion': 'summaryMotion',
  '/servos': 'summaryServos',
  '/game': 'summaryGame',
  '/ball': 'summaryBall',
  '/compute': 'summaryCompute',
};
eq(JSON.stringify(Object.keys(data)), JSON.stringify(PATHS), 'buildData returns exactly six channels');
for (const channel of D.channels) {
  const block = data[channel.path];
  const track = M.tracks[TRACK_FOR[channel.path]];
  const spec = M.meta.tracks[TRACK_FOR[channel.path]];
  eq(block.t.length, spec.count, `${channel.path}: time length`);
  near((block.t.length - 1) / (block.t.at(-1) - block.t[0]), D.rates[channel.path], 1e-9, `${channel.path}: cadence`);
  for (const field of channel.fields) {
    eq(block[field.key].length, block.t.length, `${channel.path}.${field.key}: field length`);
    let exact = true;
    for (let i = 0; i < block.t.length; i++) {
      if (!Object.is(block[field.key][i], track[field.key][i])) exact = false;
      if (!Object.is(block[field.key][i], again[channel.path][field.key][i])) exact = false;
    }
    ok(exact, `${channel.path}.${field.key}: sample-exact and deterministic`);
  }
}
eq(data['/ball'].ballSeen.length, data['/ball'].t.length, 'ball mask length');

// ---------------------------------------------------------------- 6. physical bounds and ball sentinel masking

section('6. physical bounds and ball sentinel masking');
const every = (values, predicate) => {
  for (const value of values) if (!predicate(value)) return false;
  return true;
};
ok(every(data['/imu'].accelMagMps2, (value) => value >= 0 && value < 300), 'IMU magnitude bounded');
ok(every(data['/motion'].cmdVxMps, (value) => Math.abs(value) <= 2), 'commanded forward speed bounded');
ok(every(data['/motion'].odomVxMps, (value) => Math.abs(value) <= 2), 'odometry forward speed bounded');
ok(every(data['/servos'].maxTempC, (value) => value >= 0 && value <= 100), 'servo temperature physical');
ok(every(data['/servos'].minBusVoltageV, (value) => value > 0 && value <= 30), 'bus voltage physical');
ok(every(data['/compute'].cpuLoadPct, (value) => value >= 0 && value <= 100), 'CPU percentage bounded');
ok(every(data['/compute'].memUsedPct, (value) => value >= 0 && value <= 100), 'memory percentage bounded');
let maskValid = true;
for (let i = 0; i < data['/ball'].t.length; i++) {
  const seen = data['/ball'].ballSeen[i];
  if (seen !== 0 && seen !== 1) maskValid = false;
  if (seen === 0 && (data['/ball'].ballDistM[i] !== 0 || data['/ball'].ballBearingDeg[i] !== 0)) maskValid = false;
}
ok(maskValid, 'ball absence is binary and zero-filled');
eq(M.meta.ball.rawFrameId, 'map', 'ball source frame is map');
eq(M.meta.ball.maxNearestAgeSec, 0.4, 'nearest-age gate');
eq(M.meta.ball.covarianceTraceMax, 1500, 'high-covariance sentinel gate');
eq(M.meta.ball.sentinel, 'exact (0,0,0) pose is absent', 'exact zero-pose sentinel is explicit');

// ---------------------------------------------------------------- 7. sample-exact fixture re-derivation

section('7. sample-exact fixture re-derivation');
const ballMask = await fixture('ball-mask-segments.json');
const zeroRuns = [];
let runStart = -1;
for (let i = 0; i <= M.tracks.summaryBall.ballSeen.length; i++) {
  const absent = i < M.tracks.summaryBall.ballSeen.length && M.tracks.summaryBall.ballSeen[i] === 0;
  if (absent && runStart < 0) runStart = i;
  if (!absent && runStart >= 0) {
    zeroRuns.push({ startT: runStart / D.rates['/ball'], endT: (i - 1) / D.rates['/ball'], samples: i - runStart });
    runStart = -1;
  }
}
eq(zeroRuns.length, ballMask.segments.length, 'ball mask segment count');
for (let i = 0; i < zeroRuns.length; i++) {
  eq(zeroRuns[i].startT, ballMask.segments[i].startT, `ball mask ${i}: start sample exact`);
  eq(zeroRuns[i].endT, ballMask.segments[i].endT, `ball mask ${i}: end sample exact`);
  eq(zeroRuns[i].samples, ballMask.segments[i].samples, `ball mask ${i}: count sample exact`);
}

const goals = await fixture('goal-samples.json');
const eventsById = Object.fromEntries(M.events.map((event) => [event.id, event]));
for (const goal of goals.goals) {
  const event = eventsById[goal.id];
  eq(event.t, goal.t, `${goal.id}: aligned ledger time`);
  const donna = goal.samples.donna;
  eq(event.secondsRemaining, donna.secondsRemaining, `${goal.id}: event clock`);
  eq(event.ownScore, donna.ownScore, `${goal.id}: event own score`);
  eq(event.rivalScore, donna.rivalScore, `${goal.id}: event rival score`);
  for (const robot of ['donna', 'jack', 'rory']) {
    const expected = goal.samples[robot];
    eq(expected.secondsRemaining, donna.secondsRemaining, `${goal.id}.${robot}: cross-log clock`);
    eq(expected.ownScore, donna.ownScore, `${goal.id}.${robot}: cross-log score`);
    eq(expected.secondaryState, 0, `${goal.id}.${robot}: STATE_NORMAL code`);
    const spec = M.meta.tracks[`${robot}Hud`];
    const index = Math.ceil((goal.t * 1000 - spec.timing.startMs) / spec.timing.stepMs);
    eq(M.tracks[`${robot}Hud`].secondsRemaining[index], donna.secondsRemaining, `${goal.id}.${robot}: HUD clock`);
    eq(M.tracks[`${robot}Hud`].ownScore[index], donna.ownScore, `${goal.id}.${robot}: HUD score`);
  }
}

const fallsFixture = await fixture('jack-fall-windows.json');
const stateTrack = M.tracks.jackRobotState;
for (const fall of fallsFixture.falls) {
  for (const transition of fall.stateTransitions) {
    const tick = Math.round(transition.t * 100);
    const index = [...stateTrack.t10ms].indexOf(tick);
    ok(index >= 0, `fall ${fall.fall}: transition tick ${tick} exported`);
    if (index >= 0) eq(stateTrack.state[index], transition.state, `fall ${fall.fall}: state code at ${tick}`);
  }
  for (const code of [...fall.jointQ10000AtOnset, ...fall.torsoQuaternionQ30000AtOnset]) {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 0, true);
    view.setInt16(2, code, true);
    const scale = fall.jointQ10000AtOnset.includes(code) ? 10000 : 30000;
    eq(Math.round(decode.decodeInt16DeltaColumn(bytes, scale)[1] * scale), code, `fall ${fall.fall}: fixture code round-trips exactly`);
  }
}

// ---------------------------------------------------------------- 8. event ledger and eventLines

section('8. event ledger and eventLines');
const EVENT_IDS = [
  'window-open', 'jack-fall-1', 'jack-speak-1', 'rory-re-entry', 'goal-5-0',
  'jack-fall-2', 'jack-speak-2', 'donna-penalty-start', 'donna-penalty-end',
  'jack-fall-3', 'jack-speak-3', 'goal-6-0', 'finished', 'donna-fall-count',
  'jack-fall-count', 'rory-fall-count', 'donna-queue-full', 'jack-queue-full',
  'rory-queue-full', 'donna-low-power',
];
eq(JSON.stringify(M.events.map((event) => event.id)), JSON.stringify(EVENT_IDS), 'frozen 20-row event order');
eq(PV.events.length, 0, 'picker preview omits the event ledger');
const rows = D.eventLines();
eq(rows.length, EVENT_IDS.length, 'eventLines returns every ledger row');
for (let i = 0; i < rows.length; i++) {
  eq(rows[i].t, M.events[i].t, `${EVENT_IDS[i]}: time`);
  eq(rows[i].kind, M.events[i].kind, `${EVENT_IDS[i]}: kind`);
  eq(rows[i].detail, M.events[i].detail, `${EVENT_IDS[i]}: detail`);
  ok(rows[i].source.startsWith('/'), `${EVENT_IDS[i]}: source channel`);
  eq(Object.keys(rows[i]).length, 4, `${EVENT_IDS[i]}: fixed row shape`);
}
ok(M.events.filter((event) => event.kind === 'speak').every((event) => event.text === event.detail), 'speech stays verbatim');

// ---------------------------------------------------------------- 9. frozen findings and copy number bindings

section('9. frozen findings and copy number bindings');
const FINDING_IDS = ['one-match-three-logs', 'jack-falls-foul-line', 'penalty-traffic', 'added-time-finish'];
eq(JSON.stringify(D.findings.map((finding) => finding.id)), JSON.stringify(FINDING_IDS), 'exact frozen finding cut');
const findingText = D.findings.map((finding) => `${finding.title} ${finding.note}`).join('\n');
ok(findingText.includes('One match, three onboard logs'), 'F1 locked title');
ok(/application queue filled 239 times on Donna, 229 on Jack and 0 on Rory/.test(findingText), 'F1 application-queue facts');
ok(/Donna 0, Jack 3 and Rory 0/.test(findingText), 'F2 per-robot window fall counts');
ok(findingText.includes('This was definitely a foul.'), 'F2 verbatim foul line');
ok(/37\.071 s off-field/.test(findingText) && /28\.072 s/.test(findingText), 'F3 penalty traffic numbers');
ok(/5-0 with 162 s/.test(findingText) && /6-0 at -31 s/.test(findingText) && /-33 s/.test(findingText), 'F4 added-time sequence');
const scoreExpanded = findingText.replace(/(\d+)-(\d+)/g, '$1 $2');
for (const token of scoreExpanded.match(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g) || []) {
  ok(C.allowedTexts().has(token), `rendered numeric token ${token} is ledger-owned`);
}
const numberWords = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'first', 'second', 'third']);
for (const word of findingText.match(/[A-Za-z]+/g) || []) {
  if (numberWords.has(word.toLowerCase())) ok(C.allowedNumberWords().has(word), `rendered number word ${word} is ledger-owned`);
}

// ---------------------------------------------------------------- 10. claim bindings resolve

section('10. claim bindings resolve');
function resolveClaim(claim) {
  if (claim.eventId) {
    const event = eventsById[claim.eventId];
    if (!event) return undefined;
    if (claim.field === 'eventCount') return 1;
    if (claim.field === 'recordedRobotCount') {
      return new Set(M.events.filter((row) => row.id.endsWith('-queue-full')).map((row) => row.robot)).size;
    }
    if (claim.field === 't minus donna-penalty-start.t') return event.t - eventsById['donna-penalty-start'].t;
    return event[claim.field];
  }
  if (claim.field === 'windowEnd') return M.meta.window[1];
  if (claim.field === 'ballSeen timestamp') {
    const index = Math.round(claim.t * D.rates['/ball']);
    return M.tracks.summaryBall.ballSeen[index] === 1 ? claim.t : NaN;
  }
  return undefined;
}
for (const [name, claim] of Object.entries(C.DATA_CLAIMS)) {
  ok(
    (claim.eventId && claim.t === null) ||
      (claim.eventId === null && typeof claim.channel === 'string' && Number.isFinite(claim.t)),
    `${name}: bound to eventId or channel timestamp`,
  );
  ok(typeof claim.field === 'string' && claim.field.length > 0, `${name}: field binding`);
  ok(typeof claim.unit === 'string' && typeof claim.text === 'string', `${name}: unit and text`);
  near(resolveClaim(claim), claim.expected, 1e-9, `${name}: resolves to payload`);
}
eq(Object.keys(C.CITED_CONSTANTS).length, 0, 'no cited constants masquerade as data claims');

// ---------------------------------------------------------------- 11. presence and penalty fixtures

section('11. presence and penalty fixtures');
const boundaries = await fixture('penalty-boundaries.json');
const donnaOutage = M.presence.donna.find((segment) => segment.className === 'penalty-outage');
const roryOutage = M.presence.rory.find((segment) => segment.className === 'pre-first-fix');
near(donnaOutage.startT, boundaries.donnaPoseOutage[0].start_t, 0.005, 'Donna outage start quantizes to fixture');
near(donnaOutage.endT, boundaries.donnaPoseOutage[0].end_t, 0.005, 'Donna outage end quantizes to fixture');
eq(donnaOutage.renderMode, 'HIDDEN', 'Donna penalty outage is hidden');
near(roryOutage.startT, boundaries.roryPreFirstFix[0].start_t, 0.005, 'Rory outage start');
near(roryOutage.endT, boundaries.roryPreFirstFix[0].end_t, 0.005, 'Rory outage end quantizes to fixture');
eq(roryOutage.renderMode, 'HIDDEN', 'Rory pre-fix outage is hidden');
eq(M.presence.jack.filter((segment) => segment.className === 'fall-outage').length, 3, 'Jack has three fall outages');
ok(M.presence.jack.filter((segment) => segment.className === 'fall-outage').every((segment) => segment.renderMode === 'HOLD'), 'Jack fall outages disclose HOLD');

// ---------------------------------------------------------------- 12. cross-robot fixtures, carry-in rule and purity

section('12. cross-robot fixtures, carry-in and purity');
function poseSegments(robot, decoded = M) {
  return Object.entries(decoded.tracks)
    .filter(([name]) => name.startsWith(`${robot}Pose`))
    .map(([name, track]) => ({ track, spec: decoded.meta.tracks[name] }));
}
function poseAt(robot, t, decoded = M) {
  for (const { track, spec } of poseSegments(robot, decoded)) {
    const base = spec.timing.segmentStart10ms;
    const firstT = (base + track.t10ms[0]) / 100;
    const lastT = (base + track.t10ms.at(-1)) / 100;
    if (t < firstT - 1e-9 || t > lastT + 1e-9) continue;
    let i = 0;
    while (i + 1 < track.t10ms.length && (base + track.t10ms[i + 1]) / 100 <= t) i++;
    if (i + 1 === track.t10ms.length) return [track.xM[i], track.yM[i], track.yawRad[i]];
    const a = (base + track.t10ms[i]) / 100;
    const b = (base + track.t10ms[i + 1]) / 100;
    const u = (t - a) / (b - a);
    let yawDelta = track.yawRad[i + 1] - track.yawRad[i];
    while (yawDelta > Math.PI) yawDelta -= 2 * Math.PI;
    while (yawDelta < -Math.PI) yawDelta += 2 * Math.PI;
    return [
      track.xM[i] + (track.xM[i + 1] - track.xM[i]) * u,
      track.yM[i] + (track.yM[i + 1] - track.yM[i]) * u,
      track.yawRad[i] + yawDelta * u,
    ];
  }
  return null;
}
const relative = await fixture('cross-robot-relative-positions.json');
let mirroredMismatch = 0;
for (const sample of relative.samples) {
  const donna = poseAt('donna', sample.t);
  ok(donna !== null, `${sample.label}: Donna pose is live`);
  for (const robot of ['jack', 'rory']) {
    const pose = poseAt(robot, sample.t);
    ok(pose !== null, `${sample.label}: ${robot} pose is live`);
    const expected = sample.relativeToDonna[robot];
    near(pose[0] - donna[0], expected.dxM, 0.003, `${sample.label}.${robot}: relative x`);
    near(pose[1] - donna[1], expected.dyM, 0.003, `${sample.label}.${robot}: relative y`);
    near(pose[2] - donna[2], expected.dHeadingRad, 0.003, `${sample.label}.${robot}: relative heading`);
    if (Math.abs(-pose[0] - donna[0] - expected.dxM) > 0.003) mirroredMismatch++;
    if (Math.abs(-pose[1] - donna[1] - expected.dyM) > 0.003) mirroredMismatch++;
  }
}
ok(mirroredMismatch >= relative.samples.length * 2, 'x/y mirror mutation fails the relative-position fixtures');
{
  const startTick = Math.round(M.meta.window[0] * 100);
  const endTick = Math.round(M.meta.window[1] * 100);
  for (const robot of ['donna', 'jack', 'rory']) {
    const state = M.tracks[`${robot}RobotState`];
    eq(state.t10ms[0], startTick, `full.${robot}: one carry-in row at start`);
    ok([...state.t10ms].slice(1).every((tick) => tick > startTick && tick <= endTick), `full.${robot}: later rows satisfy start < t <= end`);

    const adapter = PV.tracks[`${robot}RobotState`];
    eq(adapter.t10ms.length, 1, `preview.${robot}: one inert scene-binding adapter row`);
    eq(adapter.t10ms[0], 18760, `preview.${robot}: adapter row is exactly heroTime`);
  }
}
const forbiddenDashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
for (const file of ['data.js', 'decode.js', 'claims.mjs']) {
  const source = await readFile(path.join(DONNA, file), 'utf8');
  ok(!forbiddenDashes.test(source), `${file}: no em or en dashes`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
