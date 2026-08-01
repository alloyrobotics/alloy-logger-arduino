// donna-decode.test.mjs - self-test for donna/decode.js and the generated Donna modules.
//
//   node demo/js/robots/gen-fixture/donna-decode.test.mjs
//
// Proves the five-symbol ABI, one full/preview decoder path, typed corruption failures, retry versus
// reload semantics, known-pose fidelity, and the unconditional Node module/decode budgets.

import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
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

const decode = await import('../donna/decode.js');
const fullMod = await import('../donna/donna-data.js');
const previewMod = await import('../donna/preview-data.js');

// ---------------------------------------------------------------- 1. five-symbol module ABI

section('module ABI');
const ABI = ['BLOB_B64', 'DATASET_HASH', 'FORMAT_VERSION', 'META', 'VARIANT'];
for (const [name, mod] of [['donna-data.js', fullMod], ['preview-data.js', previewMod]]) {
  eq(JSON.stringify(Object.keys(mod).sort()), JSON.stringify(ABI), `${name} exports exactly five ABI symbols`);
  ok(typeof mod.BLOB_B64 === 'string' && mod.BLOB_B64.length > 0, `${name} carries a base64 blob`);
  ok(/^[0-9a-f]{64}$/.test(mod.DATASET_HASH), `${name} carries a lowercase sha256 digest`);
  eq(mod.FORMAT_VERSION, decode.SUPPORTED_FORMAT_VERSION, `${name} uses the supported format`);
  const src = await readFile(path.join(DONNA, name), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bimport\b/.test(code), `${name} imports nothing`);
  ok(!/decodeDonnaData/.test(code), `${name} decodes nothing during module evaluation`);
}
eq(fullMod.VARIANT, 'full', 'the heavy module is the full variant');
eq(previewMod.VARIANT, 'preview', 'the light module is the preview variant');
eq(fullMod.DATASET_HASH, previewMod.DATASET_HASH, 'both variants carry one dataset hash');

// ---------------------------------------------------------------- 2. full decode and format shape

section('full decode');
const started = performance.now();
const M = decode.decodeDonnaData(fullMod);
const decodeMs = performance.now() - started;
console.log(`  decode: ${decodeMs.toFixed(2)} ms`);
ok(decodeMs < 80, `full decode stays under 80 ms (was ${decodeMs.toFixed(2)} ms)`);
eq(M.variant, 'full', 'decoded full variant');
eq(M.formatVersion, 'donna-int16-delta-v1', 'decoded format version');
eq(M.datasetHash, fullMod.DATASET_HASH, 'decoded dataset hash');
eq(M.events.length, 20, 'decoded frozen 20-row event ledger');
eq(M.meta.window[0], 0, 'full window starts at zero');
eq(M.meta.window[1], 306, 'full window ends at 306 s');

const TRACK_ORDER = [
  'summaryImu',
  'summaryMotion',
  'summaryServos',
  'summaryGame',
  'summaryBall',
  'summaryCompute',
  'joints',
  'torsoQuaternion',
  'pose',
  'ballField',
];
eq(JSON.stringify(Object.keys(M.tracks)), JSON.stringify(TRACK_ORDER), 'decoded tracks preserve frozen insertion order');

let declaredBytes = 0;
for (const trackName of TRACK_ORDER) {
  const spec = M.meta.tracks[trackName];
  const track = M.tracks[trackName];
  eq(JSON.stringify(Object.keys(track)), JSON.stringify(spec.columns.map((c) => c.name)), `${trackName}: column order`);
  for (const column of spec.columns) {
    eq(track[column.name].length, spec.count, `${trackName}.${column.name}: declared sample count`);
    let finite = true;
    for (const value of track[column.name]) if (!Number.isFinite(value)) finite = false;
    ok(finite, `${trackName}.${column.name}: every value is finite`);
    declaredBytes += column.length * 2;
  }
}
eq(Buffer.from(fullMod.BLOB_B64, 'base64').length, declaredBytes, 'blob is exactly two bytes per declared word');

// ---------------------------------------------------------------- 3. preview/full parity through one decoder

section('preview parity');
const PV = decode.decodeDonnaData(previewMod);
eq(PV.variant, 'preview', 'decoded preview variant');
eq(PV.datasetHash, M.datasetHash, 'preview and full decode the same dataset');
eq(JSON.stringify(PV.events), JSON.stringify(M.events), 'preview retains the complete frozen event table');
eq(JSON.stringify(Object.keys(PV.tracks)), JSON.stringify(Object.keys(M.tracks)), 'preview carries every track');
eq(PV.meta.window[0], 237, 'preview starts at 237 s');
eq(PV.meta.window[1], 243, 'preview ends at 243 s');

for (const trackName of TRACK_ORDER) {
  const fullSpec = M.meta.tracks[trackName];
  const previewSpec = PV.meta.tracks[trackName];
  eq(
    JSON.stringify(previewSpec.columns.map((c) => [c.name, c.scale, c.unit, c.encoding])),
    JSON.stringify(fullSpec.columns.map((c) => [c.name, c.scale, c.unit, c.encoding])),
    `${trackName}: preview has the same column contract`,
  );
  if (previewSpec.timing.kind === 'uniform') {
    eq(previewSpec.timing.stepMs, fullSpec.timing.stepMs, `${trackName}: same uniform step`);
    const start = Math.round((previewSpec.timing.startMs - fullSpec.timing.startMs) / fullSpec.timing.stepMs);
    for (const column of previewSpec.columns) {
      let same = true;
      for (let i = 0; i < previewSpec.count; i++) {
        if (!Object.is(PV.tracks[trackName][column.name][i], M.tracks[trackName][column.name][start + i])) {
          same = false;
          break;
        }
      }
      ok(same, `${trackName}.${column.name}: preview is sample-exact slice of full`);
    }
  } else {
    const fullTimes = M.tracks.pose.tMs;
    const previewTimes = PV.tracks.pose.tMs;
    const fullOrigin = fullSpec.timing.timeOriginMs;
    const previewOrigin = previewSpec.timing.timeOriginMs;
    const byTime = new Map();
    for (let i = 0; i < fullTimes.length; i++) byTime.set(fullOrigin + fullTimes[i], i);
    let same = true;
    for (let i = 0; i < previewTimes.length; i++) {
      const fullIndex = byTime.get(previewOrigin + previewTimes[i]);
      if (fullIndex === undefined) {
        same = false;
        break;
      }
      for (const column of previewSpec.columns) {
        if (column.name === 'tMs') continue;
        if (!Object.is(PV.tracks.pose[column.name][i], M.tracks.pose[column.name][fullIndex])) same = false;
      }
    }
    ok(same, 'pose: preview absolute times and values are sample-exact inside full');
  }
}

// ---------------------------------------------------------------- 4. typed corruption fixtures

section('typed corruption failures');
const clone = (mod, patch) => {
  const out = { ...mod, META: structuredClone(mod.META) };
  return patch ? patch(out) || out : out;
};
const throwsWith = (code, build, msg) => {
  let err = null;
  try {
    decode.decodeDonnaData(build());
  } catch (caught) {
    err = caught;
  }
  ok(err instanceof decode.DonnaDecodeError, `${msg}: throws DonnaDecodeError`);
  eq(err && err.code, code, `${msg}: error code`);
  ok(err && err.retryable === true, `${msg}: decoder failure is retryable`);
};

throwsWith('BAD_MODULE', () => ({}), 'module without META');
throwsWith('BAD_MODULE', () => clone(fullMod, (m) => { m.VARIANT = 'match'; }), 'unknown variant');
throwsWith(
  'UNSUPPORTED_FORMAT_VERSION',
  () => clone(fullMod, (m) => { m.FORMAT_VERSION = 'donna-next'; }),
  'unsupported format',
);
throwsWith('BAD_MODULE', () => clone(fullMod, (m) => { m.DATASET_HASH = 'nope'; }), 'invalid dataset hash');
throwsWith('BAD_MODULE', () => clone(fullMod, (m) => { m.META.events.pop(); }), 'short event ledger');
throwsWith(
  'BAD_MODULE',
  () => clone(fullMod, (m) => { [m.META.events[0], m.META.events[1]] = [m.META.events[1], m.META.events[0]]; }),
  'changed event order',
);
throwsWith(
  'BAD_MODULE',
  () => clone(fullMod, (m) => { delete m.META.events.find((event) => event.kind === 'speak').text; }),
  'speech event without verbatim text',
);
throwsWith('BAD_BASE64', () => clone(previewMod, (m) => { m.BLOB_B64 = ''; }), 'empty base64');
throwsWith('BAD_BASE64', () => clone(previewMod, (m) => { m.BLOB_B64 = '@@@@'; }), 'invalid base64');
throwsWith(
  'BLOB_LENGTH_MISMATCH',
  () => clone(previewMod, (m) => { m.BLOB_B64 = m.BLOB_B64.slice(0, -8); }),
  'truncated blob',
);
throwsWith(
  'UNKNOWN_ENCODING',
  () => clone(previewMod, (m) => { m.META.tracks.summaryImu.columns[0].encoding = 'raw-i16'; }),
  'unknown column encoding',
);
throwsWith(
  'BAD_OFFSET',
  () => clone(previewMod, (m) => { m.META.tracks.summaryImu.columns[1].byteOffset += 2; }),
  'non-contiguous byte offset',
);
throwsWith(
  'COLUMN_LENGTH_MISMATCH',
  () => clone(previewMod, (m) => { m.META.tracks.summaryImu.columns[0].length -= 1; }),
  'column length mismatch',
);
throwsWith(
  'BAD_TIMING',
  () => clone(previewMod, (m) => { m.META.tracks.summaryImu.timing.stepMs = 40; }),
  'uniform timing outside the frozen cadence',
);
throwsWith(
  'BAD_MODULE',
  () => clone(previewMod, (m) => { m.META.tracks.summaryImu.columns[0].unit = 'g'; }),
  'column unit outside the frozen schema',
);
throwsWith(
  'BAD_MODULE',
  () => clone(previewMod, (m) => { m.META.tracks.summaryMotion.columns[0].name = 'cmdX'; }),
  'column name outside the frozen order',
);
throwsWith(
  'BAD_MODULE',
  () => clone(previewMod, (m) => {
    const first = m.META.tracks.summaryImu;
    delete m.META.tracks.summaryImu;
    m.META.tracks.summaryImu = first;
  }),
  'changed track insertion order',
);

// ---------------------------------------------------------------- 5. purity and retry versus reload split

section('purity and retry split');
{
  const before = JSON.stringify(previewMod.META);
  decode.decodeDonnaData(previewMod);
  eq(JSON.stringify(previewMod.META), before, 'decode leaves META byte-identical');
  ok(PV.meta === previewMod.META, 'decoded object returns the untouched META by reference');
}
{
  const src = await readFile(path.join(DONNA, 'data.js'), 'utf8');
  ok(/wrapped\.retryable = false/.test(src), 'module evaluation failure is marked not retryable');
  ok(/wrapped\.retryable = true/.test(src), 'decoder or validation failure is marked retryable');
  ok(/donnaPromise === p\) donnaPromise = null/.test(src), 'retryable failure clears the cached promise');
  ok(/if \(err && err\.retryable === false\) throw err/.test(src), 'reload-only failure keeps the cached rejection');
}

// ---------------------------------------------------------------- 6. known-pose fidelity

section('known-pose fidelity');
const known = JSON.parse(await readFile(path.join(FIXTURES, 'known-poses.json'), 'utf8'));
const jointSpec = M.meta.tracks.joints;
const quatSpec = M.meta.tracks.torsoQuaternion;
const jointScale = Object.fromEntries(jointSpec.columns.map((column) => [column.name, column.scale]));
const halfAwayFromZero = (value) => value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
const encodeCodes = (codes) => {
  const bytes = new Uint8Array(codes.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < codes.length; i++) {
    const word = i === 0 ? codes[i] : codes[i] - codes[i - 1];
    ok(word >= -32768 && word <= 32767, `fixture delta ${i} fits signed int16`);
    view.setInt16(i * 2, word, true);
  }
  return bytes;
};
const normalizeQuaternion = (values) => {
  const norm = Math.hypot(...values);
  return norm ? values.map((value) => value / norm) : [0, 0, 0, 1];
};
const upVector = (values) => {
  const [x, y, z, w] = normalizeQuaternion(values);
  return [
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ];
};
const tiltOnlyQuaternion = (values) => {
  const up = upVector(values);
  const uz = Math.max(-1, Math.min(1, up[2]));
  if (uz < -0.999999) return [1, 0, 0, 0];
  const w = Math.sqrt(Math.max(0, (1 + uz) / 2));
  return normalizeQuaternion([-up[1] / (2 * w), up[0] / (2 * w), 0, w]);
};
const tiltDeg = (values) => {
  const up = upVector(values);
  return Math.acos(Math.max(-1, Math.min(1, up[2]))) * 180 / Math.PI;
};
const moduleTiltAt = (index) => tiltDeg([
  M.tracks.torsoQuaternion.qx[index],
  M.tracks.torsoQuaternion.qy[index],
  M.tracks.torsoQuaternion.qz[index],
  M.tracks.torsoQuaternion.qw[index],
]);

for (const pose of known.poses) {
  eq(
    pose.tiltMetric,
    'angle between torso up axis and world vertical from the full IMU quaternion',
    `${pose.name}: fixture freezes the full up-vector metric`,
  );

  // The fixture times are raw-message instants and the published joint track is a 25 Hz nearest-
  // sample grid, so 240.3 s and 95.83 s are not themselves exported grid ticks. Decode the fixture's
  // frozen quantized values through the same primitive instead of pretending a neighbouring grid
  // tick is the raw message. This proves int16 fidelity and the raw-value quantization bound exactly.
  for (let j = 0; j < pose.jointNames.length; j++) {
    const name = pose.jointNames[j];
    const scale = jointScale[name];
    const decoded = decode.decodeInt16DeltaColumn(encodeCodes([0, pose.jointInt16[j]]), scale)[1];
    eq(Math.round(decoded * scale), pose.jointInt16[j], `${pose.name}.${name}: decoded int16 exact`);
    near(decoded, pose.decodedJointRad[j], 5e-12, `${pose.name}.${name}: decoded radians exact`);
    near(decoded, pose.rawJointRad[j], 0.000051, `${pose.name}.${name}: inside quantization error of raw MCAP`);
  }

  // Reproduce the extractor's yaw-free torso quaternion from the FULL raw IMU quaternion, quantize
  // each component at scale 30000, and decode every component through the mission primitive.
  const tiltQuaternion = tiltOnlyQuaternion(pose.rawQuaternion);
  const decodedQuaternion = tiltQuaternion.map((value) => {
    const code = halfAwayFromZero(value * 30000);
    return decode.decodeInt16DeltaColumn(encodeCodes([0, code]), 30000)[1];
  });
  eq(Math.round(decodedQuaternion[2] * 30000), 0, `${pose.name}: tilt-only quaternion removes yaw`);
  const fixtureTilt = tiltDeg(decodedQuaternion);
  near(fixtureTilt, pose.tiltDeg, 0.01, `${pose.name}: decoded full up-vector tilt matches fixture`);
  if (pose.assertion.operator === '<=') ok(fixtureTilt <= pose.assertion.degrees, `${pose.name}: fixture tilt is inside upright ceiling`);
  else ok(fixtureTilt >= pose.assertion.degrees, `${pose.name}: fixture tilt is beyond fallen floor`);

  // The nearest published 25 Hz replay frame must preserve the same posture classification. Exact
  // joint equality is intentionally checked above against the raw-time fixture, not against this
  // neighbouring grid tick.
  const replayIndex = Math.round((pose.targetT * 1000 - quatSpec.timing.startMs) / quatSpec.timing.stepMs);
  const replayTilt = moduleTiltAt(replayIndex);
  if (pose.assertion.operator === '<=') ok(replayTilt <= pose.assertion.degrees, `${pose.name}: nearest replay frame remains upright`);
  else ok(replayTilt >= pose.assertion.degrees, `${pose.name}: nearest replay frame remains fallen`);
}

// ---------------------------------------------------------------- 7. unconditional module budget

section('module budget');
const moduleBytes = await readFile(path.join(DONNA, 'donna-data.js'));
const gzipBytes = gzipSync(moduleBytes, { level: 9 }).length;
console.log(`  donna-data.js gzip -9: ${gzipBytes} bytes`);
ok(gzipBytes <= 256000, `donna-data.js gzip -9 is at most 256000 bytes (was ${gzipBytes})`);
ok(decodeMs < 80, `timed full decode remains under 80 ms (was ${decodeMs.toFixed(2)} ms)`);

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
