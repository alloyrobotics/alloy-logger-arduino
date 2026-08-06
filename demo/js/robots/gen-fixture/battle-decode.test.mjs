// battle-decode.test.mjs - self-test for demo/js/robots/battle/decode.js.
//
//   node demo/js/robots/gen-fixture/battle-decode.test.mjs
//
// This directory is in .assetsignore, so nothing here is ever served. It is the natural home for a
// test that has to import the real generated modules.
//
// What it proves:
//   1  the module ABI: exactly five exported symbols on BOTH generated modules, one shared
//      DATASET_HASH, the two VARIANT values, one FORMAT_VERSION
//   2  the byte decoder reproduces every invariant the payload publishes about itself, decodes the
//      full round in under 50 ms, and decodes the preview through EXACTLY the same function
//   3  every documented failure is a loud, typed, retryable error and not a silently short column
//   4  the decoder never mutates META
//  11  the UWB wire conversion fixture: 100 cm is 1 m, applied where the payload says it is

import { readFile } from 'node:fs/promises';
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

/**
 * The FASTEST of `n` runs, which is the only honest reading of a decode budget.
 *
 * The two timings below are claims about the decoder, not about the machine, and a single timed run
 * cannot separate the two: it measures the decode plus whatever the box did in that millisecond,
 * and the full gate runs this beside three headless browsers. A scheduler preemption or one major
 * GC is enough to read a sub-millisecond decode as tens of milliseconds and fail a budget with an
 * order of magnitude of headroom.
 *
 * Wall-clock noise is strictly additive, so the smallest sample carries the least of it, and a
 * decoder that has really regressed cannot produce a fast run at all. Section 4 of this same file
 * proves `decodeBattleData` does not mutate META, and it allocates its output fresh, so repeating
 * it has no side effects; the value returned is still the FIRST run's, so nothing downstream is
 * reading a warmed decode.
 *
 * @template T @param {number} n @param {() => T} fn @returns {{value: T, ms: number}}
 */
function bestOf(n, fn) {
  let value;
  let ms = Infinity;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const v = fn();
    ms = Math.min(ms, performance.now() - t);
    if (i === 0) value = v;
  }
  return { value, ms };
}

const decode = await import('../battle/decode.js');
const matchMod = await import('../battle/battle-data.js');
const previewMod = await import('../battle/preview-data.js');

// ---------------------------------------------------------------- 1. the 5-symbol ABI

section('module ABI');
const ABI = ['BLOB_B64', 'DATASET_HASH', 'FORMAT_VERSION', 'META', 'VARIANT'];
for (const [name, mod] of [['battle-data.js', matchMod], ['preview-data.js', previewMod]]) {
  eq(
    JSON.stringify(Object.keys(mod).sort()),
    JSON.stringify(ABI),
    `${name} exports exactly the five ABI symbols`,
  );
  ok(typeof mod.BLOB_B64 === 'string' && mod.BLOB_B64.length > 0, `${name} BLOB_B64 is a string`);
  ok(/^sha256:[0-9a-f]{64}$/.test(mod.DATASET_HASH), `${name} DATASET_HASH is a sha256 content hash`);
  eq(mod.FORMAT_VERSION, decode.SUPPORTED_FORMAT_VERSION, `${name} FORMAT_VERSION is the supported one`);
}
eq(matchMod.VARIANT, 'match', 'the heavy module is the match variant');
eq(previewMod.VARIANT, 'preview', 'the light module is the preview variant');
eq(matchMod.DATASET_HASH, previewMod.DATASET_HASH, 'both modules carry the SAME DATASET_HASH');
// side-effect freedom: the generated modules must decode nothing at import time, or a decoder
// failure would be cached forever by the module map instead of being retryable.
for (const f of ['battle-data.js', 'preview-data.js']) {
  const src = await readFile(path.join(BATTLE, f), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bimport\b/.test(code), `${f} imports nothing`);
  ok(!/decodeBattleData/.test(code), `${f} decodes nothing at import time`);
}

// ---------------------------------------------------------------- 2. decode + META invariants

section('decoder');
const { value: M, ms: decodeMs } = bestOf(3, () => decode.decodeBattleData(matchMod));
console.log(`  decode: ${decodeMs.toFixed(1)} ms  (best of 3)`);
ok(decodeMs < 50, `full round decodes under 50 ms (was ${decodeMs.toFixed(1)} ms)`);

const { value: PV, ms: previewMs } = bestOf(5, () => decode.decodeBattleData(previewMod));
console.log(`  preview decode: ${previewMs.toFixed(2)} ms  (best of 5)`);
ok(
  previewMs < 5,
  `preview decodes under 5 ms (was ${previewMs.toFixed(2)} ms), which is what makes module-scope decoding fair game`,
);

const META = matchMod.META;
eq(M.variant, 'match', 'decoded match variant');
eq(PV.variant, 'preview', 'decoded preview variant');
eq(M.datasetHash, PV.datasetHash, 'both decodes carry the same dataset hash');
eq(M.formatVersion, 1, 'format version 1');
eq(M.durationS, 180, 'the round is 180 s');
eq(M.window.t0, META.clock.tStartS, 'decoded window opens where META says');
eq(M.window.t1, META.clock.tEndS, 'decoded window closes where META says');
eq(M.stageRemainTime(0), 180, 'stage clock reads the full round at t = 0');
eq(M.stageRemainTime(72), 108, 'stage clock is 180 minus replay time');
eq(M.stageRemainTime(200), 0, 'stage clock clamps at zero');

// blob accounting: the stream table fully determines the byte length
{
  const codes = META.streams.reduce((a, s) => a + s.count, 0);
  const bytes = Buffer.from(matchMod.BLOB_B64, 'base64').length;
  eq(bytes, 2 * codes, `the blob is exactly 2 bytes per declared code (${codes} codes)`);
  ok(META.streams.length >= 30, `the match blob carries every stream it declares (${META.streams.length})`);
}

// poses
eq(M.poses.rateHz, META.poseRateHz, 'pose rate matches META');
for (const robot of Object.keys(META.poseStreams)) {
  const cols = M.poses[robot];
  ok(!!cols, `${robot} pose decoded`);
  for (const f of ['xM', 'yM', 'yawDeg', 'gimbalYawDeg']) {
    eq(cols[f].length, M.poses.t.length, `${robot}.${f} is the length of the pose axis`);
  }
  // angles come out of a wrapping stream, so they are inside the wrapped range by construction
  let wrapped = true;
  for (let i = 0; i < cols.yawDeg.length; i++) {
    if (!(cols.yawDeg[i] >= -180 && cols.yawDeg[i] < 180)) wrapped = false;
    if (!(cols.gimbalYawDeg[i] >= -180 && cols.gimbalYawDeg[i] < 180)) wrapped = false;
  }
  ok(wrapped, `${robot} yaw and gimbal yaw are wrapped into [-180, 180)`);
}
// the pose axis really is the uniform grid the format specifies
near(M.poses.t[0], META.clock.tStartS, 1e-9, 'pose axis starts at the window start');
near(
  M.poses.t[M.poses.t.length - 1] - M.poses.t[0],
  (M.poses.t.length - 1) / META.poseRateHz,
  1e-9,
  'pose axis is the uniform grid tStart + n / rate',
);

// organizer HP timeline
eq(M.hp.rateHz, META.hpTimeline.rateHz, 'HP timeline rate matches META');
eq(M.hp.t.length, META.hpTimeline.sampleCount, 'HP timeline length matches META');
for (const robot of Object.keys(META.hpTimeline.streams)) {
  eq(M.hp[robot].length, META.hpTimeline.sampleCount, `${robot} HP series length matches META`);
  eq(M.hp[robot][0], 2000, `${robot} starts the round on the initial HP`);
}
// the payload says the organizer HP timeline for Blue 1 and the referee channel are the same
// numbers by construction; that is a claim the decoder can be held to.
{
  const ref = M.channels['/blue1/referee'];
  let same = ref.t.length === M.hp.t.length;
  if (same) {
    for (let i = 0; i < ref.t.length; i++) {
      if (ref.fields.remainHP[i] !== M.hp.blue1[i]) same = false;
    }
  }
  ok(same, 'hpTimeline.blue1 and /blue1/referee.remainHP are the same numbers, sample for sample');
}

// channels
for (const p of Object.keys(META.channels)) {
  const spec = META.channels[p];
  const block = M.channels[p];
  ok(!!block, `${p} decoded`);
  eq(block.rateHz, spec.rateHz, `${p} block rate matches META`);
  eq(block.t.length, spec.sampleCount, `${p} sample count matches META`);
  near(block.t[0], spec.tStartS, 1e-9, `${p} axis starts where META says`);
  near(
    block.t[block.t.length - 1] - block.t[0],
    (spec.sampleCount - 1) / spec.rateHz,
    1e-9,
    `${p} axis is uniform at its declared rate`,
  );
  const groups = new Set();
  for (const name of Object.keys(spec.fields)) {
    const f = spec.fields[name];
    eq(block.fields[name].length, spec.sampleCount, `${p}.${name} is the length of its axis`);
    eq(block.units[name], f.unit, `${p}.${name} unit passes through`);
    eq(block.unitGroups[name], f.unitGroup, `${p}.${name} unit group passes through`);
    eq(block.provenance[name].origin, f.origin, `${p}.${name} origin passes through`);
    eq(block.provenance[name].transform, f.transform, `${p}.${name} transform passes through`);
    groups.add(f.unitGroup);
    let finite = true;
    for (let i = 0; i < block.fields[name].length; i++) {
      if (!Number.isFinite(block.fields[name][i])) finite = false;
    }
    ok(finite, `${p}.${name} decodes to finite numbers everywhere`);
  }
  eq(groups.size, spec.unitGroupCount, `${p} decodes the unit-group count META declares`);
}

// ---- preview / full parity through ONE decoder
section('preview parity');
eq(
  JSON.stringify(Object.keys(M.channels).sort()),
  JSON.stringify(Object.keys(PV.channels).sort()),
  'the preview carries exactly the same channel set as the full round',
);
for (const p of Object.keys(M.channels)) {
  eq(
    JSON.stringify(Object.keys(M.channels[p].fields).sort()),
    JSON.stringify(Object.keys(PV.channels[p].fields).sort()),
    `${p}: the preview carries the same fields`,
  );
  for (const name of Object.keys(M.channels[p].fields)) {
    eq(PV.channels[p].units[name], M.channels[p].units[name], `${p}.${name}: same unit in the preview`);
    eq(
      PV.channels[p].provenance[name].transform,
      M.channels[p].provenance[name].transform,
      `${p}.${name}: same transform in the preview`,
    );
  }
}
eq(
  JSON.stringify(Object.keys(M.poses).sort()),
  JSON.stringify(Object.keys(PV.poses).sort()),
  'the preview carries the same pose roster',
);
ok(PV.window.t0 > M.window.t0 && PV.window.t1 < M.window.t1, 'the preview is a slice inside the round');
// the four reference sections are match-only, so a consumer branches on presence and never on a
// variant string it had to remember to check
for (const key of ['incident', 'claimLedger', 'engineScope', 'rules']) {
  ok(M[key] !== undefined, `the full round carries ${key}`);
  ok(PV[key] === undefined, `the preview does not carry ${key}, and says so by absence`);
}

// ---------------------------------------------------------------- 3. typed failures

section('typed failures');
const clone = (mod, patch) => {
  const out = { ...mod, META: structuredClone(mod.META) };
  return patch ? patch(out) || out : out;
};
const throwsWith = (code, build, msg) => {
  let err = null;
  try {
    decode.decodeBattleData(build());
  } catch (e) {
    err = e;
  }
  ok(err instanceof decode.BattleDecodeError, `${msg}: throws a BattleDecodeError`);
  eq(err && err.code, code, `${msg}: error code`);
  // EVERY decoder failure is retryable. A module evaluation failure is the one that is not, and
  // that one never reaches this function.
  ok(err && err.retryable === true, `${msg}: is retryable`);
};

throwsWith('BAD_MODULE', () => ({}), 'a module with no META');
throwsWith('BAD_MODULE', () => clone(matchMod, (m) => { delete m.META.clock; }), 'META missing clock');
throwsWith('BAD_MODULE', () => clone(matchMod, (m) => { delete m.META.channels; }), 'META missing channels');
throwsWith('BAD_MODULE', () => clone(matchMod, (m) => { m.VARIANT = 'rehearsal'; }), 'an unknown VARIANT');
throwsWith(
  'UNSUPPORTED_FORMAT_VERSION',
  () => clone(matchMod, (m) => { m.FORMAT_VERSION = 99; }),
  'a format version this decoder does not implement',
);
throwsWith('BAD_BASE64', () => clone(previewMod, (m) => { m.BLOB_B64 = ''; }), 'an empty blob');
throwsWith('BAD_BASE64', () => clone(previewMod, (m) => { m.BLOB_B64 = '@@@@'; }), 'a blob that is not base64');
throwsWith(
  'BLOB_LENGTH_MISMATCH',
  () => clone(previewMod, (m) => { m.BLOB_B64 = m.BLOB_B64.slice(0, m.BLOB_B64.length - 8); }),
  'a truncated blob',
);
throwsWith(
  'MISSING_STREAM',
  () => clone(previewMod, (m) => { m.META.channels['/blue1/referee'].fields.remainHP.stream = 'ch.nope'; }),
  'a channel field pointing at a stream that is not in the table',
);
throwsWith(
  'MISSING_STREAM',
  () => clone(previewMod, (m) => { m.META.poseStreams.blue1.xM = 'pose.nope'; }),
  'a pose column pointing at a stream that is not in the table',
);
throwsWith(
  'UNKNOWN_ENCODING',
  () => clone(previewMod, (m) => { m.META.streams[0].encoding = 'zigzag'; }),
  'an encoding this decoder does not implement',
);
throwsWith(
  'UNKNOWN_DTYPE',
  () => clone(previewMod, (m) => { m.META.streams[0].dtype = 'i32'; }),
  'a dtype this decoder does not implement',
);
throwsWith(
  'BAD_MODULE',
  () => clone(previewMod, (m) => { m.META.streams[1].key = m.META.streams[0].key; }),
  'a duplicate stream key',
);

// ---------------------------------------------------------------- 4. META is never mutated

section('purity');
{
  const before = JSON.stringify(previewMod.META);
  decode.decodeBattleData(previewMod);
  eq(JSON.stringify(previewMod.META), before, 'decoding leaves META byte-identical');
  ok(PV.meta === previewMod.META, 'the decoded object hands META back by reference, untouched');
}

// ---------------------------------------------------------------- 11. the UWB wire fixture

section('UWB wire conversion');
// The UWB position arrives as int16 CENTIMETRES on the CAN wire and the chassis driver divides by
// 100 to publish metres. That conversion is a named, exported fixture rather than a comment, and
// the payload is checked to be on the metre side of it: a channel that had skipped the division
// would put a robot at 505 on an 8 m field.
eq(decode.UWB_WIRE_CM_PER_M, 100, '100 cm is 1 m');
eq(decode.uwbWireCmToM(100), 1, 'the converter turns 100 cm into 1 m');
eq(decode.uwbWireCmToM(0), 0, 'and zero into zero');
near(decode.uwbWireCmToM(-250), -2.5, 1e-12, 'and it is signed, like the int16 it reads');
{
  const loc = M.channels['/blue1/localization'];
  eq(loc.units.xM, 'm', 'localization x is published in metres');
  eq(loc.units.yM, 'm', 'localization y is published in metres');
  eq(loc.units.uwbResidualM, 'm', 'the UWB residual is published in metres');
  const arena = M.meta.geometry.arena;
  let inside = true;
  for (let i = 0; i < loc.t.length; i++) {
    if (loc.fields.xM[i] < 0 || loc.fields.xM[i] > arena.xM) inside = false;
    if (loc.fields.yM[i] < 0 || loc.fields.yM[i] > arena.yM) inside = false;
  }
  ok(inside, `every localization sample is inside the ${arena.xM} by ${arena.yM} m field, so the metres are metres`);
  // and the round trip through the wire encoding is exact at centimetre resolution
  let roundTrip = true;
  for (let i = 0; i < loc.t.length; i += 7) {
    const cm = Math.round(loc.fields.xM[i] * decode.UWB_WIRE_CM_PER_M);
    if (Math.abs(decode.uwbWireCmToM(cm) - loc.fields.xM[i]) > 0.005) roundTrip = false;
  }
  ok(roundTrip, 'every sampled x round-trips through the centimetre wire encoding inside half a centimetre');
}

// ---------------------------------------------------------------- angle wrapping

section('angle wrapping');
eq(decode.wrap180(0), 0, 'wrap180 leaves zero alone');
eq(decode.wrap180(179.5), 179.5, 'wrap180 leaves the top of the range alone');
eq(decode.wrap180(180), -180, 'wrap180 sends 180 to the bottom of the half-open range');
eq(decode.wrap180(-180), -180, 'wrap180 keeps -180');
near(decode.wrap180(540), -180, 1e-9, 'wrap180 folds multiple turns');
near(decode.wrap180(-190), 170, 1e-9, 'wrap180 folds negatives');

// ---------------------------------------------------------------- sampling helpers

section('sampling helpers');
{
  const ref = M.channels['/blue1/referee'];
  eq(decode.indexAtUniform(ref.t[0], ref.rateHz, ref.t.length, 74.5), 745, 'uniform index arithmetic');
  eq(decode.indexAtUniform(ref.t[0], ref.rateHz, ref.t.length, -5), 0, 'index clamps low');
  eq(decode.indexAtUniform(ref.t[0], ref.rateHz, ref.t.length, 9999), ref.t.length - 1, 'index clamps high');
  eq(decode.sampleChannel(ref, 'shooterHeat0', 74.5), 214, 'sampleChannel reads the peak heat tick');
  near(
    decode.lerpUniform(ref.fields.remainHP, ref.t[0], ref.rateHz, 74.25),
    (ref.fields.remainHP[742] + ref.fields.remainHP[743]) / 2,
    1e-6,
    'lerpUniform interpolates between the bracketing samples',
  );
}

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
