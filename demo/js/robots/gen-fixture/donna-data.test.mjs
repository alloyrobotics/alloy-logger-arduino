// donna-data.test.mjs - contract test for donna/{data.js, claims.mjs}.
//
//   node demo/js/robots/gen-fixture/donna-data.test.mjs
//
// Proves the RobotDefinition telemetry contract, canonical fixture slices, mask semantics, frozen
// event rows, claim bindings, deterministic build, and the generated modules' five-symbol ABI.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DONNA = path.join(HERE, '..', 'donna');
const FIXTURES = path.join(HERE, 'donna-fixtures');

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

const D = await import('../donna/data.js');
const C = await import('../donna/claims.mjs');
const fullMod = await import('../donna/donna-data.js');
const previewMod = await import('../donna/preview-data.js');

// ---------------------------------------------------------------- 1. pre-load tripwires

section('tripwires and mission constants');
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
  ok(/loadSceneData/.test(error && error.message), `${label} tripwire names loadSceneData`);
}
eq(D.isSceneDataLoaded(), false, 'scene data starts unloaded');
ok(D.previewData !== null, 'preview data decodes eagerly');
ok(D.getSceneData() === D.previewData, 'getSceneData falls back to the preview');
eq(D.duration, 306.0, 'duration is the full 306.0 s recording');
eq(D.rate, 20, 'summary rate is 20 Hz');
eq(D.factsSeriesPoints, 53, 'factsSeriesPoints keeps the six-channel default');
eq(D.eventsSection.title, 'Match and onboard events', 'event section title is def-owned');
ok(
  typeof D.eventsSection.preamble === 'string' && /recorded match and diagnostic events/.test(D.eventsSection.preamble),
  'event section carries one honest preamble line',
);

// ---------------------------------------------------------------- 2. load and cached promise

section('load and cache');
const firstPromise = D.loadSceneData();
const secondPromise = D.loadSceneData();
ok(firstPromise === secondPromise, 'concurrent loadSceneData calls return one cached promise');
const M = await firstPromise;
ok(D.isSceneDataLoaded(), 'scene data is loaded after the promise resolves');
ok(D.getSceneData() === M, 'getSceneData returns the full decoded mission after load');
ok((await D.loadSceneData()) === M, 'subsequent loads resolve to the same decoded object');
const PV = D.previewData;

// ---------------------------------------------------------------- 3. five-symbol generated-module ABI

section('five-symbol ABI');
const ABI = ['BLOB_B64', 'DATASET_HASH', 'FORMAT_VERSION', 'META', 'VARIANT'];
for (const [name, mod] of [['donna-data.js', fullMod], ['preview-data.js', previewMod]]) {
  eq(JSON.stringify(Object.keys(mod).sort()), JSON.stringify(ABI), `${name}: exactly five exports`);
  ok(typeof mod.BLOB_B64 === 'string' && mod.BLOB_B64.length > 0, `${name}: non-empty base64 blob`);
  ok(/^[0-9a-f]{64}$/.test(mod.DATASET_HASH), `${name}: lowercase sha256 dataset hash`);
  eq(mod.FORMAT_VERSION, 'donna-int16-delta-v1', `${name}: frozen format version`);
  const source = await readFile(path.join(DONNA, name), 'utf8');
  ok(!/\bimport\b/.test(source), `${name}: side-effect-free module imports nothing`);
}
eq(fullMod.VARIANT, 'full', 'full module variant');
eq(previewMod.VARIANT, 'preview', 'preview module variant');
eq(fullMod.DATASET_HASH, previewMod.DATASET_HASH, 'both variants use one dataset hash');
for (const [name, mod] of [['donna-data.js', fullMod], ['preview-data.js', previewMod]]) {
  eq(JSON.stringify(mod.META.rateNotes), JSON.stringify(D.rateNotes), `${name}: emitted rateNotes equal data.js`);
}

// ---------------------------------------------------------------- 4. channels, cadence, units, and provenance

section('channel contract');
const EXPECTED_PATHS = ['/imu', '/motion', '/servos', '/game', '/ball', '/compute'];
const EXPECTED_FIELDS = {
  '/imu': ['accelMagMps2', 'pitchDeg', 'rollDeg'],
  '/motion': ['cmdVxMps', 'odomVxMps', 'cmdYawRadps'],
  '/servos': ['maxTempC', 'minBusVoltageV'],
  '/game': ['secondsRemaining', 'ownScore', 'rivalScore'],
  '/ball': ['ballDistM', 'ballBearingDeg'],
  '/compute': ['cpuLoadPct', 'memUsedPct'],
};
const EXPECTED_GROUPS = {
  '/imu': { 'm/s^2': ['accelMagMps2'], deg: ['pitchDeg', 'rollDeg'] },
  '/motion': { 'm/s': ['cmdVxMps', 'odomVxMps'], 'rad/s': ['cmdYawRadps'] },
  '/servos': { degC: ['maxTempC'], V: ['minBusVoltageV'] },
  '/game': { s: ['secondsRemaining'], count: ['ownScore', 'rivalScore'] },
  '/ball': { m: ['ballDistM'], deg: ['ballBearingDeg'] },
  '/compute': { percent: ['cpuLoadPct', 'memUsedPct'] },
};
const EXPECTED_TRANSFORMS = {
  '/imu.accelMagMps2': 'DERIVED_MAGNITUDE+RESAMPLED_20HZ',
  '/imu.pitchDeg': 'DERIVED_ANGLES+RESAMPLED_20HZ',
  '/imu.rollDeg': 'DERIVED_ANGLES+RESAMPLED_20HZ',
  '/motion.cmdVxMps': 'RESAMPLED_10HZ',
  '/motion.odomVxMps': 'RESAMPLED_10HZ',
  '/motion.cmdYawRadps': 'RESAMPLED_10HZ',
  '/servos.maxTempC': 'DERIVED_DIAG_AGGREGATE+RESAMPLED_2HZ',
  '/servos.minBusVoltageV': 'DERIVED_DIAG_AGGREGATE+RESAMPLED_2HZ',
  '/game.secondsRemaining': 'RESAMPLED_2HZ',
  '/game.ownScore': 'RESAMPLED_2HZ',
  '/game.rivalScore': 'RESAMPLED_2HZ',
  '/ball.ballDistM': 'DERIVED_DISTANCE+RESAMPLED_5HZ',
  '/ball.ballBearingDeg': 'DERIVED_BEARING+RESAMPLED_5HZ',
  '/compute.cpuLoadPct': 'RESAMPLED_2HZ',
  '/compute.memUsedPct': 'DERIVED_RATIO+RESAMPLED_2HZ',
};
const CANONICAL_TRANSFORM_TOKENS = new Set([
  ...Object.values(EXPECTED_TRANSFORMS),
  'RESAMPLED_NEAREST_25HZ',
  'DERIVED_TILT_QUATERNION_YAW_REMOVED+RESAMPLED_NEAREST_25HZ',
  'NATIVE_7.59HZ_SEGMENTED_HOLD_THEN_JUMP',
  'FIELD_FRAME_FILTERED+RESAMPLED_5HZ_VALIDATED_MASK',
]);
for (const [name, mod] of [['donna-data.js', fullMod], ['preview-data.js', previewMod]]) {
  for (const [trackName, track] of Object.entries(mod.META.tracks)) {
    for (const token of track.transform.split(/;\s*/)) {
      ok(CANONICAL_TRANSFORM_TOKENS.has(token), `${name}.${trackName}: canonical transform token ${token}`);
    }
  }
}
const META_CHANNELS = Object.fromEntries(M.meta.channels.map((channel) => [channel.path, channel]));
eq(JSON.stringify(D.channels.map((channel) => channel.path)), JSON.stringify(EXPECTED_PATHS), 'six frozen channel paths in order');
eq(JSON.stringify(Object.keys(D.rates)), JSON.stringify(EXPECTED_PATHS), 'rates cover exactly the channel table');
eq(JSON.stringify(Object.keys(D.rateNotes)), JSON.stringify(EXPECTED_PATHS), 'rateNotes cover exactly the channel table');
const NATIVE_RATE_TOKENS = {
  '/imu': '342.75',
  '/motion': '28.49',
  '/servos': '107',
  '/game': '1.75',
  '/ball': '47.21',
  '/compute': '19.95',
};
for (const channel of D.channels) {
  const meta = META_CHANNELS[channel.path];
  ok(!!meta, `${channel.path}: payload metadata exists`);
  eq(D.rates[channel.path], meta.rateHz, `${channel.path}: def rate equals payload rate`);
  ok(D.rateNotes[channel.path].includes(NATIVE_RATE_TOKENS[channel.path]), `${channel.path}: cadence note names native rate`);
  eq(JSON.stringify(channel.fields.map((field) => field.key)), JSON.stringify(EXPECTED_FIELDS[channel.path]), `${channel.path}: exact chart fields`);
  const groups = {};
  for (const field of channel.fields) {
    (groups[field.unit] = groups[field.unit] || []).push(field.key);
    const key = `${channel.path}.${field.key}`;
    eq(field.provenance.origin, 'REAL_MCAP', `${key}: provenance origin is real MCAP`);
    eq(field.provenance.transform, EXPECTED_TRANSFORMS[key], `${key}: exact composite transform token`);
    ok(field.provenance.note.length > 20, `${key}: provenance note is present`);
  }
  eq(JSON.stringify(groups), JSON.stringify(EXPECTED_GROUPS[channel.path]), `${channel.path}: exact unit grouping`);
  ok(Object.keys(groups).length <= 2, `${channel.path}: at most two unit groups`);
}
const ballDef = D.channels.find((channel) => channel.path === '/ball');
for (const field of ballDef.fields) {
  eq(field.mask, 'ballSeen', `/ball.${field.key}: uses the ballSeen mask`);
  ok(/frozen validity rules/.test(field.maskNote), `/ball.${field.key}: mask note names the validated semantics`);
  eq(
    field.provenance.note,
    'relative to Donna, derived by differencing two map-frame estimates (filtered ball pose and localization pose), not a direct robot-frame measurement',
    `/ball.${field.key}: field description freezes the Donna-relative derivation`,
  );
}

// ---------------------------------------------------------------- 5. build shape, prose-to-array parity, and determinism

section('buildData shape and determinism');
const data = D.buildData(() => 0.25);
eq(JSON.stringify(Object.keys(data)), JSON.stringify(EXPECTED_PATHS), 'buildData returns exactly six channels');
const TRACK_FOR = {
  '/imu': 'summaryImu',
  '/motion': 'summaryMotion',
  '/servos': 'summaryServos',
  '/game': 'summaryGame',
  '/ball': 'summaryBall',
  '/compute': 'summaryCompute',
};
for (const channel of D.channels) {
  const block = data[channel.path];
  const trackName = TRACK_FOR[channel.path];
  const track = M.tracks[trackName];
  const spec = M.meta.tracks[trackName];
  ok(block.t instanceof Float64Array, `${channel.path}: time axis is Float64Array`);
  eq(block.t.length, spec.count, `${channel.path}: time axis length matches payload`);
  near((block.t.length - 1) / (block.t[block.t.length - 1] - block.t[0]), D.rates[channel.path], 1e-9, `${channel.path}: exact block cadence`);
  for (const field of channel.fields) {
    const values = block[field.key];
    eq(values.length, block.t.length, `${channel.path}.${field.key}: field length matches t`);
    let exact = values.length === track[field.key].length;
    let finite = true;
    for (let i = 0; i < values.length; i++) {
      if (!Object.is(values[i], track[field.key][i])) exact = false;
      if (!Number.isFinite(values[i])) finite = false;
    }
    ok(exact, `${channel.path}.${field.key}: build array equals decoded payload sample for sample`);
    ok(finite, `${channel.path}.${field.key}: every sample is finite`);
  }
}
ok(data['/ball'].ballSeen instanceof Float64Array, '/ball exports the mask beside its chart fields');
eq(data['/ball'].ballSeen.length, data['/ball'].t.length, '/ball mask length matches t');
const again = D.buildData(() => 0.99);
let deterministic = true;
for (const channel of EXPECTED_PATHS) {
  for (const key of Object.keys(data[channel])) {
    const a = data[channel][key];
    const b = again[channel][key];
    if (a.length !== b.length) deterministic = false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) deterministic = false;
  }
}
ok(deterministic, 'buildData is deterministic regardless of the supplied seeded stream');
const dataSource = await readFile(path.join(DONNA, 'data.js'), 'utf8');
ok(!/Math\.random\s*\(/.test(dataSource), 'Donna data source never calls Math.random');

// ---------------------------------------------------------------- 6. plausibility bounds and mask zero-fill

section('plausibility and mask zero-fill');
const every = (values, predicate) => {
  for (const value of values) if (!predicate(value)) return false;
  return true;
};
ok(every(data['/imu'].accelMagMps2, (value) => value >= 0 && value < 300), 'IMU magnitude is non-negative and bounded');
ok(every(data['/imu'].pitchDeg, (value) => value >= -180 && value <= 180), 'pitch stays in degree bounds');
ok(every(data['/imu'].rollDeg, (value) => value >= -180 && value <= 180), 'roll stays in degree bounds');
ok(every(data['/motion'].cmdVxMps, (value) => Math.abs(value) <= 2), 'forward commands stay in humanoid range');
ok(every(data['/motion'].odomVxMps, (value) => Math.abs(value) <= 2), 'forward odometry stays in humanoid range');
ok(every(data['/servos'].maxTempC, (value) => value >= 0 && value <= 100), 'servo temperatures stay physical');
ok(every(data['/servos'].minBusVoltageV, (value) => value > 0 && value <= 30), 'positive bus voltage stays physical');
ok(every(data['/game'].ownScore, Number.isInteger), 'own score is integral');
ok(every(data['/game'].rivalScore, Number.isInteger), 'rival score is integral');
ok(every(data['/compute'].cpuLoadPct, (value) => value >= 0 && value <= 100), 'CPU load stays in percent bounds');
ok(every(data['/compute'].memUsedPct, (value) => value >= 0 && value <= 100), 'memory use stays in percent bounds');
let zeroFilled = true;
let seenImpliesValid = true;
for (let i = 0; i < data['/ball'].t.length; i++) {
  const seen = data['/ball'].ballSeen[i];
  if (seen !== 0 && seen !== 1) zeroFilled = false;
  if (seen === 0 && (data['/ball'].ballDistM[i] !== 0 || data['/ball'].ballBearingDeg[i] !== 0)) zeroFilled = false;
  if (seen === 1 && data['/ball'].ballDistM[i] === 0 && data['/ball'].ballBearingDeg[i] === 0) seenImpliesValid = false;
}
ok(zeroFilled, 'ballSeen is binary and absent numeric values are zero filler');
ok(seenImpliesValid, 'ballSeen implies a valid non-sentinel distance and bearing pair');
eq(M.meta.maskRule.covarianceTraceMax, 1500, 'payload freezes the ball covariance trace threshold');
eq(M.meta.maskRule.ballCovarianceModes.rawSentinelCount, 808, 'payload records all 808 raw sentinel poses');
ok(
  M.meta.maskRule.ballCovarianceModes.credibleModeMaxTrace < M.meta.maskRule.covarianceTraceMax &&
    M.meta.maskRule.covarianceTraceMax < M.meta.maskRule.ballCovarianceModes.sentinelModeMinTrace,
  'ball covariance threshold sits between the two measured modes',
);

// ---------------------------------------------------------------- 7. sample-exact verifier fixture slices

section('sample-exact fixture slices');
const slices = JSON.parse(await readFile(path.join(FIXTURES, 'expected-value-slices.json'), 'utf8'));
for (const [variant, decoded] of [['full', M], ['preview', PV]]) {
  for (const [trackName, fixture] of Object.entries(slices[variant])) {
    const spec = decoded.meta.tracks[trackName];
    const scales = Object.fromEntries(spec.columns.map((column) => [column.name, column.scale]));
    for (const [columnName, expected] of Object.entries(fixture.columns)) {
      const actual = fixture.indices.map((index) => Math.round(decoded.tracks[trackName][columnName][index] * scales[columnName]));
      eq(JSON.stringify(actual), JSON.stringify(expected), `${variant}.${trackName}.${columnName}: quantized fixture slice`);
    }
  }
}

// ---------------------------------------------------------------- 8. bracketing-sample mask semantics

section('ball mask bracketing semantics');
const maskFixture = JSON.parse(await readFile(path.join(FIXTURES, 'ball-mask-segments.json'), 'utf8'));
eq(maskFixture.maxNearestAgeSec, 0.4, 'fixture freezes the 0.4 s presence threshold');
eq(M.meta.maskRule.absentAt, 'bracketing-sample rule', 'payload names the bracketing-sample rule');
for (const [segmentIndex, segment] of maskFixture.segments.entries()) {
  for (const sample of segment.gridSamples) {
    const nearestAge = Math.min(...segment.bracketingRawSamples.map((raw) => Math.abs(raw.t - sample.t)));
    const expectedFresh = nearestAge <= maskFixture.maxNearestAgeSec + 1e-12;
    eq(expectedFresh, sample.fresh, `mask segment ${segmentIndex + 1} at ${sample.t}: fixture follows bracketing ages`);
    const index = Math.round(sample.t * D.rates['/ball']);
    eq(Boolean(M.tracks.summaryBall.ballSeen[index]), sample.ballSeen, `summaryBall at ${sample.t}: validated mask matches fixture`);
    eq(Boolean(M.tracks.ballField.ballSeen[index]), sample.fieldSeen, `ballField at ${sample.t}: validated estimate mask matches fixture`);
  }
  const centerIndex = Math.round(segment.gridStart * D.rates['/ball']);
  eq(M.tracks.summaryBall.ballSeen[centerIndex], 0, `mask segment ${segmentIndex + 1}: absent run is clear`);
}

// ---------------------------------------------------------------- 9. exact frozen 20-row event ledger

section('frozen event rows');
const EVENT_IDS = [
  'penalty-reentry',
  'fall-1',
  'fall-2',
  'fall-3',
  'fall-4',
  'fall-5',
  'fall-6',
  'speak-1',
  'speak-2',
  'speak-3',
  'speak-4',
  'speak-5',
  'speak-6',
  'servo-clamps',
  'servo-undervoltage',
  'localization-drops',
  'stream-backpressure',
  'goal-2-0',
  'ready-set-blip',
  'final-whistle',
];
eq(M.events.length, 20, 'payload contains exactly 20 events');
eq(JSON.stringify(M.events.map((event) => event.id)), JSON.stringify(EVENT_IDS), 'event ids preserve frozen ledger order');
const rows = D.eventLines();
eq(rows.length, 20, 'eventLines returns exactly the 20 frozen rows');
for (let i = 0; i < rows.length; i++) {
  eq(rows[i].t, M.events[i].t, `${EVENT_IDS[i]}: row timestamp is exact`);
  eq(rows[i].kind, M.events[i].kind, `${EVENT_IDS[i]}: row kind is exact`);
  eq(rows[i].detail, M.events[i].detail, `${EVENT_IDS[i]}: row detail is exact`);
  ok(typeof rows[i].source === 'string' && rows[i].source.startsWith('/'), `${EVENT_IDS[i]}: row source is a channel`);
  eq(Object.keys(rows[i]).length, 4, `${EVENT_IDS[i]}: fixed four-field row shape`);
}
eq(M.events.filter((event) => event.kind === 'fall').length, 6, 'six fall rows');
eq(M.events.filter((event) => event.kind === 'speak').length, 6, 'six verbatim speech rows');
ok(M.events.filter((event) => event.kind === 'speak').every((event) => event.text === event.detail), 'speech detail is verbatim text');

// ---------------------------------------------------------------- 10. final five findings

section('final five findings');
const FINDING_IDS = ['falls-recoveries', 'battery-sag', 'servo-command-clamps', 'added-time-finish', 'stream-backpressure'];
eq(JSON.stringify(D.findings.map((finding) => finding.id)), JSON.stringify(FINDING_IDS), 'exact final five findings in order');
for (const finding of D.findings) {
  ok(finding.window[0] >= 0 && finding.window[1] <= D.duration && finding.window[0] < finding.window[1], `${finding.id}: ordered in-mission window`);
  ok(finding.t >= finding.window[0] && finding.t <= finding.window[1], `${finding.id}: marker lies inside its window`);
  const channel = D.channels.find((candidate) => candidate.path === finding.focus.channel);
  ok(!!channel, `${finding.id}: focus channel exists`);
  for (const field of finding.focus.fields) ok(channel.fields.some((candidate) => candidate.key === field), `${finding.id}: focus field ${field} exists`);
}
const findingById = Object.fromEntries(D.findings.map((finding) => [finding.id, finding]));
ok(/first CONTROLLABLE state/.test(findingById['falls-recoveries'].note), 'F1 defines fall 6 recovery to first CONTROLLABLE');
ok(/does not establish battery sag as their root cause/.test(findingById['battery-sag'].note), 'F2 states correlation, not causation');
ok(/441 LAnklePitch clamps, 189 RElbow clamps and 177 LElbow clamps/.test(findingById['servo-command-clamps'].note), 'F3 quotes all three frozen clamp counts');
for (const message of Object.values(M.events.find((event) => event.id === 'servo-clamps').firstMessages)) {
  ok(findingById['servo-command-clamps'].note.includes(message), 'F3 quotes a log-owned limit string verbatim');
}
ok(/2-0/.test(findingById['added-time-finish'].title) && /FINISHED/.test(findingById['added-time-finish'].note), 'F4 carries the 2-0 added-time finish and whistle');
ok(/secondary_state STATE_NORMAL/.test(M.events.find((event) => event.id === 'goal-2-0').detail), 'event row 18 locks the added-time reading to STATE_NORMAL');
ok(/299 messages dropped from the live stream/.test(findingById['stream-backpressure'].title), 'F5 states 299 dropped-from-stream messages');
ok(/recording retained/.test(findingById['stream-backpressure'].note), 'F5 distinguishes live stream loss from recording completeness');

// ---------------------------------------------------------------- 11. every claim-ledger binding resolves

section('claim ledger bindings');
const byId = Object.fromEntries(M.events.map((event) => [event.id, event]));
const falls = M.events.filter((event) => event.kind === 'fall');
const clamp = byId['servo-clamps'];
const clampParts = Object.fromEntries(Object.entries(clamp.firstMessages).map(([joint, message]) => {
  const match = message.match(/^Invalid position for [^:]+: (-?\d+(?:\.\d+)?) not in \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)$/);
  return [joint, { value: Number(match[1]), low: Number(match[2]), high: Number(match[3]) }];
}));
const score = byId['goal-2-0'].detail.match(/changed (-?\d+)-(-?\d+) to (-?\d+)-(-?\d+) with secondsRemaining (-?\d+)/);
const detailRecovery = (id) => Number(byId[id].detail.match(/recovery (\d+(?:\.\d+)?) s/)[1]);
const knownPoseFixture = JSON.parse(await readFile(path.join(FIXTURES, 'known-poses.json'), 'utf8'));
const RESOLVERS = {
  fallCount: () => falls.length,
  recoveryCount: () => falls.filter((event) => event.recoveredState === 'WALKING' || event.recoveredState === 'CONTROLLABLE').length,
  recoveryCeilingS: () => Math.max(...falls.map((event) => event.recoverySec)) <= C.DATA_CLAIMS.recoveryCeilingS.expected ? C.DATA_CLAIMS.recoveryCeilingS.expected : Infinity,
  utteranceCount: () => M.events.filter((event) => event.kind === 'speak').length,
  distinctSpeakLineCount: () => new Set(M.events.filter((event) => event.kind === 'speak').map((event) => event.detail)).size,
  channelCount: () => D.channels.length,
  heroBallDistM: () => knownPoseFixture.heroBall.ballDistM,
  undervoltageCount: () => byId['servo-undervoltage'].count,
  minBusVoltageV: () => byId['servo-undervoltage'].minBusVoltageV,
  clampLAnklePitchCount: () => clamp.counts.LAnklePitch,
  clampRElbowCount: () => clamp.counts.RElbow,
  clampLElbowCount: () => clamp.counts.LElbow,
  clampLAnklePitchValue: () => clampParts.LAnklePitch.value,
  clampLAnklePitchLow: () => clampParts.LAnklePitch.low,
  clampLAnklePitchHigh: () => clampParts.LAnklePitch.high,
  clampRElbowValue: () => clampParts.RElbow.value,
  clampRElbowLow: () => clampParts.RElbow.low,
  clampRElbowHigh: () => clampParts.RElbow.high,
  clampLElbowValue: () => clampParts.LElbow.value,
  clampLElbowLow: () => clampParts.LElbow.low,
  clampLElbowHigh: () => clampParts.LElbow.high,
  scoreBeforeOwn: () => Number(score[1]),
  scoreFinalOwn: () => Number(score[3]),
  scoreRival: () => Number(score[4]),
  secondsRemainingAtGoal: () => Number(score[5]),
  finalWhistleT: () => byId['final-whistle'].t,
  streamDroppedCount: () => byId['stream-backpressure'].count,
  penaltyReentryT: () => byId['penalty-reentry'].t,
  fall1T: () => byId['fall-1'].t,
  fall2T: () => byId['fall-2'].t,
  fall3T: () => byId['fall-3'].t,
  fall4T: () => byId['fall-4'].t,
  fall5T: () => byId['fall-5'].t,
  fall6T: () => byId['fall-6'].t,
  speak1T: () => byId['speak-1'].t,
  speak2T: () => byId['speak-2'].t,
  speak3T: () => byId['speak-3'].t,
  speak4T: () => byId['speak-4'].t,
  speak5T: () => byId['speak-5'].t,
  speak6T: () => byId['speak-6'].t,
  servoClampsT: () => byId['servo-clamps'].t,
  servoUndervoltageT: () => byId['servo-undervoltage'].t,
  localizationDropsT: () => byId['localization-drops'].t,
  streamBackpressureT: () => byId['stream-backpressure'].t,
  goalT: () => byId['goal-2-0'].t,
  readySetStartT: () => byId['ready-set-blip'].t,
  readySetEndT: () => byId['ready-set-blip'].endT,
  fall1RecoveryRoundedS: () => detailRecovery('fall-1'),
  fall2RecoveryRoundedS: () => detailRecovery('fall-2'),
  fall3RecoveryRoundedS: () => detailRecovery('fall-3'),
  fall4RecoveryRoundedS: () => detailRecovery('fall-4'),
  fall5RecoveryRoundedS: () => detailRecovery('fall-5'),
  fall6RecoveryRoundedS: () => detailRecovery('fall-6'),
  fall1PeakAccelMps2: () => byId['fall-1'].peakAccelMps2,
  fall2PeakAccelMps2: () => byId['fall-2'].peakAccelMps2,
  fall3PeakAccelMps2: () => byId['fall-3'].peakAccelMps2,
  fall4PeakAccelMps2: () => byId['fall-4'].peakAccelMps2,
  fall5PeakAccelMps2: () => byId['fall-5'].peakAccelMps2,
  fall6PeakAccelMps2: () => byId['fall-6'].peakAccelMps2,
  localizationDropCount: () => byId['localization-drops'].count,
};
const unresolved = Object.keys(C.DATA_CLAIMS).filter((name) => !RESOLVERS[name]);
eq(JSON.stringify(unresolved), '[]', 'every DATA_CLAIM has a payload resolver');
for (const [name, claim] of Object.entries(C.DATA_CLAIMS)) {
  ok(
    (typeof claim.eventId === 'string' && claim.eventId.length > 0) ||
      (typeof claim.structure === 'string' && claim.structure.length > 0) ||
      (typeof claim.channel === 'string' && typeof claim.field === 'string' && Number.isFinite(claim.t)),
    `${name}: bound to a ledger event, structural source or timed channel sample`,
  );
  ok(typeof claim.unit === 'string', `${name}: unit declared`);
  const actual = RESOLVERS[name]();
  if (typeof claim.expected === 'number') near(actual, claim.expected, 1e-9, `${name}: resolves to frozen payload value`);
  else eq(actual, claim.expected, `${name}: resolves to frozen payload value`);
}
eq(Object.keys(C.CITED_CONSTANTS).length, 0, 'Phase 2 carries no cited constants');
eq(C.DATA_CLAIMS.channelCount.structure, 'channels.length', 'channelCount binds to the channel table structure');
eq(C.DATA_CLAIMS.heroBallDistM.channel, '/ball', 'hero distance binds to the ball channel');
eq(C.DATA_CLAIMS.heroBallDistM.field, 'ballDistM', 'hero distance binds to ballDistM');
eq(C.DATA_CLAIMS.heroBallDistM.t, 240.3, 'hero distance binds to the frozen hero instant');
eq(byId['fall-6'].recoveredState, 'CONTROLLABLE', 'fall 6 binding uses CONTROLLABLE');
ok(falls.slice(0, 5).every((event) => event.recoveredState === 'WALKING'), 'falls 1 to 5 bind recovery to WALKING');

// ---------------------------------------------------------------- 12. source purity and result

section('source purity');
const donnaSources = ['claims.mjs', 'data.js', 'decode.js'];
const forbiddenDashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
for (const file of donnaSources) {
  const source = await readFile(path.join(DONNA, file), 'utf8');
  ok(!forbiddenDashes.test(source), `${file}: contains no em or en dashes`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
