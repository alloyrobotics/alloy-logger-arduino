// donna-decode.test.mjs - decoder, parity, corruption and budget suite for Donna Phase 2/4.
//
//   node demo/js/robots/gen-fixture/donna-decode.test.mjs

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DONNA = path.join(HERE, '..', 'donna');

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
function section(name) {
  console.log(`\n${name}`);
}

const decode = await import('../donna/decode.js');
const fullMod = await import('../donna/donna-data.js');
const previewMod = await import('../donna/preview-data.js');

// ---------------------------------------------------------------- 1. module ABI

section('1. module ABI');
const ABI = ['BLOB_B64', 'DATASET_HASH', 'FORMAT_VERSION', 'META', 'VARIANT'];
for (const [name, mod] of [['donna-data.js', fullMod], ['preview-data.js', previewMod]]) {
  eq(JSON.stringify(Object.keys(mod).sort()), JSON.stringify(ABI), `${name}: exactly five exports`);
  eq(mod.FORMAT_VERSION, decode.SUPPORTED_FORMAT_VERSION, `${name}: supported format`);
  ok(typeof mod.BLOB_B64 === 'string' && mod.BLOB_B64.length > 0, `${name}: blob present`);
  const source = await readFile(path.join(DONNA, name), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bimport\b/.test(code), `${name}: imports nothing`);
  ok(!/decodeDonnaData/.test(code), `${name}: does not decode at evaluation time`);
}
eq(fullMod.VARIANT, 'full', 'heavy module variant');
eq(previewMod.VARIANT, 'preview', 'preview module variant');
eq(fullMod.DATASET_HASH, previewMod.DATASET_HASH, 'one dataset hash');

// ---------------------------------------------------------------- 2. full decode shape

section('2. full decode shape');
const M = decode.decodeDonnaData(fullMod);
eq(M.variant, 'full', 'decoded full variant');
eq(M.formatVersion, 'donna-team-v2', 'decoded format');
eq(M.meta.window[0], 0, 'full starts at zero');
eq(M.meta.window[1], 250, 'full ends at 250');
eq(M.events.length, 20, 'complete event ledger');
eq(Object.keys(M.tracks).length, 29, 'full track count');
eq(Object.keys(M.mesh.parts).length, 52, 'decoded mesh part count');
eq(M.mesh.instances.length, 133, 'decoded visual instance count');
eq(M.mesh.proxy, false, 'full mesh is not proxy');
eq(Object.keys(M.mesh.materials).sort().join(','), 'dark,light', 'material classes exposed');
for (const [name, track] of Object.entries(M.tracks)) {
  const spec = M.meta.tracks[name];
  eq(JSON.stringify(Object.keys(track)), JSON.stringify(spec.columns.map((column) => column.name)), `${name}: decoded column order`);
  for (const column of spec.columns) {
    eq(track[column.name].length, spec.count, `${name}.${column.name}: sample count`);
    ok([...track[column.name]].every(Number.isFinite), `${name}.${column.name}: finite values`);
  }
}

// ---------------------------------------------------------------- 3. picker-render-only preview

section('3. picker-render-only preview');
const PV = decode.decodeDonnaData(previewMod);
const PREVIEW_TRACKS = [
  'donnaJoints', 'donnaTorsoQuaternion', 'donnaPose1', 'donnaPresence',
  'jackJoints', 'jackTorsoQuaternion', 'jackPose3', 'jackPresence',
  'roryJoints', 'roryTorsoQuaternion', 'roryPose0', 'roryPresence',
  'donnaBallField',
];
eq(PV.variant, 'preview', 'decoded preview variant');
eq(PV.meta.window[0], 184, 'preview starts at 184');
eq(PV.meta.window[1], 190, 'preview ends at 190');
eq(PV.datasetHash, M.datasetHash, 'same dataset');
eq(PV.events.length, 0, 'preview omits the full event ledger');
eq(JSON.stringify(Object.keys(PV.meta)), JSON.stringify(['window', 'mission', 'jointNames', 'codeTables', 'tracks', 'mesh']), 'Amendment 2 META surface');
eq(JSON.stringify(Object.keys(PV.meta.codeTables)), JSON.stringify(['presenceClass', 'renderMode']), 'preview keeps only rendered presence code tables');
eq(JSON.stringify(Object.keys(PV.tracks)), JSON.stringify(PREVIEW_TRACKS), 'preview carries only rendered scene series');
eq(PV.meta.mesh.format, 'wolfgang-mesh-columns-proxy/1', 'preview proxy mesh lane tag');
eq(PV.meta.mesh.proxy, true, 'preview declares proxy rendering seam');
eq(PV.mesh.proxy, true, 'decoded mesh exposes proxy rendering seam');
eq(JSON.stringify(Object.keys(PV.meta.mesh)), JSON.stringify(['format', 'proxy', 'moduleByteRange', 'meshes', 'visualInstances']), 'preview mesh metadata is runtime-only');
for (const robot of ['donna', 'jack', 'rory']) {
  ok(PV.tracks[`${robot}RobotState`] && PV.tracks[`${robot}Hud`], `${robot}: decoder supplies scene-binding adapters`);
  ok(!Object.keys(PV.tracks).includes(`${robot}RobotState`), `${robot}: state adapter is not a shipped series`);
  ok(!Object.keys(PV.tracks).includes(`${robot}Hud`), `${robot}: HUD adapter is not a shipped series`);
}
for (const name of PREVIEW_TRACKS) {
  const spec = PV.meta.tracks[name];
  const track = PV.tracks[name];
  eq(JSON.stringify(Object.keys(track)), JSON.stringify(spec.columns.map((column) => column.name)), `${name}: preview column order`);
  if (spec.timing.kind === 'uniform') {
    eq(spec.count, 1, `${name}: one hero sample`);
    eq(spec.timing.startMs, 187600, `${name}: sample is exactly heroTime`);
  } else if (/Pose\d+$/.test(name)) {
    eq(spec.count, 2, `${name}: two native samples bracket heroTime`);
  } else if (name.endsWith('Presence')) {
    eq(spec.count, 1, `${name}: one LIVE preview interval`);
  }
}

// ---------------------------------------------------------------- 4. full and preview runtime parity

section('4. full and preview runtime parity');
for (const [name, previewTrack] of Object.entries(PV.tracks)) {
  const previewSpec = PV.meta.tracks[name];
  if (name.endsWith('Presence')) {
    const robot = name.slice(0, -'Presence'.length);
    eq(previewTrack.start10ms[0], 18400, `${name}: clipped start`);
    eq(previewTrack.end10ms[0], 19000, `${name}: clipped end`);
    eq(PV.presence[robot][0].className, 'live', `${name}: hero presence is live`);
    continue;
  }
  const fullTrack = M.tracks[name];
  const fullSpec = M.meta.tracks[name];
  let indices;
  if (/Pose\d+$/.test(name)) {
    const fullTicks = [...fullTrack.t10ms].map((tick) => fullSpec.timing.segmentStart10ms + tick);
    indices = [...previewTrack.t10ms].map((tick) => {
      const absolute = previewSpec.timing.segmentStart10ms + tick;
      return fullTicks.indexOf(absolute);
    });
    ok(indices.every((index) => index >= 0), `${name}: bracketing ticks exist in full track`);
  } else {
    indices = [Math.round((previewSpec.timing.startMs - fullSpec.timing.startMs) / fullSpec.timing.stepMs)];
  }
  for (const column of previewSpec.columns) {
    const same = [...previewTrack[column.name]].every((value, index) => {
      if (/Pose\d+$/.test(name) && column.name === 't10ms') {
        return (
          previewSpec.timing.segmentStart10ms + value ===
          fullSpec.timing.segmentStart10ms + fullTrack.t10ms[indices[index]]
        );
      }
      return Object.is(value, fullTrack[column.name][indices[index]]);
    });
    ok(same, `${name}.${column.name}: preview values are sample-exact full values`);
  }
}

const fullInstances = M.meta.mesh.visualInstances.instances;
const previewInstances = PV.meta.mesh.visualInstances.instances;
eq(previewInstances.length, 133, 'preview retains 133 runtime visual instances');
eq(Object.keys(PV.meta.mesh.visualInstances.buckets).length, 21, 'preview retains 21 runtime bucket names');
for (let i = 0; i < previewInstances.length; i++) {
  for (const key of ['mesh', 'material_class', 'driven_ancestor', 'pre_composed']) {
    eq(JSON.stringify(previewInstances[i][key]), JSON.stringify(fullInstances[i][key]), `instance ${i}: ${key} runtime parity`);
  }
}

// ---------------------------------------------------------------- 5. mesh topology and assembly

section('5. mesh topology and assembly');
const geometryVariants = [
  { decoded: M, vertices: 4361, triangles: 8922, instancedTriangles: 20902 },
  { decoded: PV, vertices: 645, triangles: 1072, instancedTriangles: 1954 },
];
for (const { decoded, vertices, triangles, instancedTriangles } of geometryVariants) {
  let vertexTotal = 0;
  let triangleTotal = 0;
  for (const part of Object.values(decoded.mesh.parts)) {
    eq(part.positions.length, part.vertexCount * 3, `${decoded.variant}.${part.name}: position cardinality`);
    eq(part.indices.length, part.triangleCount * 3, `${decoded.variant}.${part.name}: triangle grouping`);
    eq(part.normals.length, part.positions.length, `${decoded.variant}.${part.name}: normals cardinality`);
    ok([...part.indices].every((index) => index < part.vertexCount), `${decoded.variant}.${part.name}: absolute indices in range`);
    ok([...part.normals].every(Number.isFinite), `${decoded.variant}.${part.name}: finite normals`);
    vertexTotal += part.vertexCount;
    triangleTotal += part.triangleCount;
  }
  eq(vertexTotal, vertices, `${decoded.variant}: frozen unique vertex total`);
  eq(triangleTotal, triangles, `${decoded.variant}: frozen unique triangle total`);
  const renderedTriangles = decoded.mesh.instances.reduce(
    (total, instance) => total + decoded.mesh.parts[instance.part].triangleCount,
    0,
  );
  eq(renderedTriangles, instancedTriangles, `${decoded.variant}: frozen instanced triangle total`);
  const buckets = new Set(decoded.mesh.instances.map((instance) => instance.bucket));
  eq(buckets.size, 21, `${decoded.variant}: all 21 driven buckets represented`);
  eq(decoded.mesh.instances.filter((instance) => instance.bucket === 'ROOT/TORSO').length, 24, `${decoded.variant}: 24 torso placements`);
}

// ---------------------------------------------------------------- 6. timing semantics

section('6. timing semantics');
for (const [name, track] of Object.entries(PV.tracks)) {
  const spec = PV.meta.tracks[name];
  if (/Pose\d+$/.test(name)) {
    eq(track.t10ms[0], 0, `${name}: relative base is zero`);
    ok(track.t10ms[1] > 0, `${name}: second bracket tick advances`);
    const start = spec.timing.segmentStart10ms + track.t10ms[0];
    const end = spec.timing.segmentStart10ms + track.t10ms[1];
    ok(start <= 18760 && end >= 18760, `${name}: native samples bracket heroTime`);
  }
}
eq(M.presence.donna.find((segment) => segment.className === 'penalty-outage').renderMode, 'HIDDEN', 'penalty outage hidden');
ok(M.presence.jack.filter((segment) => segment.className === 'fall-outage').every((segment) => segment.renderMode === 'HOLD'), 'fall outages held');
eq(M.presence.rory.find((segment) => segment.className === 'pre-first-fix').renderMode, 'HIDDEN', 'pre-first-fix hidden');

// ---------------------------------------------------------------- 7. typed corruption fixtures

section('7. typed corruption failures');
const clone = (mod, patch) => {
  const out = { ...mod, META: structuredClone(mod.META) };
  return patch ? patch(out) || out : out;
};
const withBlobMutation = (mod, mutate) => {
  const out = clone(mod);
  const bytes = Buffer.from(out.BLOB_B64, 'base64');
  mutate(bytes, out.META);
  out.BLOB_B64 = bytes.toString('base64');
  return out;
};
const throwsWith = (code, build, message) => {
  let error = null;
  try {
    decode.decodeDonnaData(build());
  } catch (caught) {
    error = caught;
  }
  ok(error instanceof decode.DonnaDecodeError, `${message}: DonnaDecodeError`);
  eq(error && error.code, code, `${message}: code`);
  ok(error && error.retryable === true, `${message}: retryable`);
};

throwsWith('BAD_MODULE', () => ({}), 'missing META');
throwsWith('BAD_MODULE', () => clone(previewMod, (mod) => { mod.VARIANT = 'match'; }), 'unknown variant');
throwsWith('UNSUPPORTED_FORMAT_VERSION', () => clone(previewMod, (mod) => { mod.FORMAT_VERSION = 'next'; }), 'unsupported format');
throwsWith('BAD_MODULE', () => clone(previewMod, (mod) => { mod.DATASET_HASH = 'bad'; }), 'bad dataset hash');
throwsWith('BAD_MODULE', () => clone(fullMod, (mod) => { mod.META.events.pop(); }), 'short full event ledger');
throwsWith('BAD_MODULE', () => clone(fullMod, (mod) => { delete mod.META.events[2].text; }), 'full speech not verbatim');
throwsWith('BAD_BASE64', () => clone(previewMod, (mod) => { mod.BLOB_B64 = ''; }), 'empty base64');
throwsWith('BAD_BASE64', () => clone(previewMod, (mod) => { mod.BLOB_B64 = '@@@@'; }), 'invalid base64');
throwsWith('BLOB_LENGTH_MISMATCH', () => clone(previewMod, (mod) => { mod.BLOB_B64 = mod.BLOB_B64.slice(0, -8); }), 'truncated blob');
throwsWith('UNKNOWN_ENCODING', () => clone(previewMod, (mod) => { mod.META.tracks.donnaJoints.columns[0].encoding = 'raw-i16'; }), 'unknown track encoding');
throwsWith('BAD_OFFSET', () => clone(previewMod, (mod) => { mod.META.tracks.donnaJoints.columns[1].byteOffset += 2; }), 'non-contiguous offset');
throwsWith('COLUMN_LENGTH_MISMATCH', () => clone(previewMod, (mod) => { mod.META.tracks.donnaJoints.columns[0].byteLength -= 2; }), 'bad byte length');
throwsWith('BAD_TIMING', () => clone(previewMod, (mod) => { mod.META.tracks.donnaJoints.timing.stepMs = 50; }), 'bad preview uniform timing');
throwsWith('BAD_MODULE', () => clone(previewMod, (mod) => { mod.META.tracks.donnaPose1.columns[3].wrapPeriod = Math.PI; }), 'bad pose wrap period');
throwsWith('BAD_TIMING', () => clone(previewMod, (mod) => { mod.META.tracks.donnaPose1.count = 1; }), 'preview pose loses its second bracket');
throwsWith('BAD_CARRY_IN', () => withBlobMutation(fullMod, (bytes, meta) => {
  bytes.writeInt16LE(1, meta.tracks.donnaRobotState.columns[0].byteOffset);
}), 'full module missing carry-in boundary');
throwsWith('BAD_PRESENCE', () => withBlobMutation(previewMod, (bytes, meta) => {
  bytes.writeInt16LE(1, meta.tracks.jackPresence.columns[3].byteOffset);
}), 'live segment marked hidden');
throwsWith('BAD_MESH', () => clone(previewMod, (mod) => {
  const first = Object.values(mod.META.mesh.meshes)[0];
  first.columns.indices.encoding = 'int16-delta-le';
}), 'mesh indices are not uint16 absolute');
throwsWith('BAD_MESH', () => withBlobMutation(previewMod, (bytes, meta) => {
  const first = Object.values(meta.mesh.meshes)[0];
  bytes.writeUInt16LE(65535, first.columns.indices.byteOffset);
}), 'mesh index out of range');
throwsWith('BAD_MODULE', () => clone(previewMod, (mod) => {
  const first = mod.META.tracks.donnaJoints;
  delete mod.META.tracks.donnaJoints;
  mod.META.tracks.donnaJoints = first;
}), 'changed preview track insertion order');

// ---------------------------------------------------------------- 8. purity and retry versus reload split

section('8. purity and retry split');
const before = JSON.stringify(previewMod.META);
decode.decodeDonnaData(previewMod);
eq(JSON.stringify(previewMod.META), before, 'decode leaves META byte-identical');
ok(PV.meta === previewMod.META, 'decoded object returns META by reference');
const dataSource = await readFile(path.join(DONNA, 'data.js'), 'utf8');
ok(/wrapped\.retryable = false/.test(dataSource), 'module evaluation failure is reload-only');
ok(/wrapped\.retryable = true/.test(dataSource), 'decode and validation failures are retryable');
ok(/donnaPromise === p\) donnaPromise = null/.test(dataSource), 'retryable failure clears promise cache');
ok(/if \(err && err\.retryable === false\) throw err/.test(dataSource), 'reload-only failure keeps cached rejection');

// ---------------------------------------------------------------- 9. unconditional module and decode budgets

section('9. unconditional budgets');
const moduleBytes = await readFile(path.join(DONNA, 'donna-data.js'));
const gzipBytes = gzipSync(moduleBytes, { level: 9, mtime: 0 }).length;
console.log(`  donna-data.js gzip -9 mtime=0: ${gzipBytes} bytes`);
eq(gzipBytes, 410559, 'emitted full module remains byte-size frozen');
ok(gzipBytes <= 472143, `module is within frozen 472143-byte ceiling (was ${gzipBytes})`);
ok(gzipBytes <= 524288, `module is within hard 512 KiB cap (was ${gzipBytes})`);

// Minimum-across-batches removes transient machine load while still bounding true decode cost:
// a genuinely slow decode exceeds the contract in all three independently warmed batches.
const benchmark = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import * as mod from './demo/js/robots/donna/donna-data.js';
       import { decodeDonnaData } from './demo/js/robots/donna/decode.js';
       const batches = [];
       for (let batch = 0; batch < 3; batch++) {
         for (let i = 0; i < 10; i++) decodeDonnaData(mod);
         const timings = [];
         for (let i = 0; i < 50; i++) {
           const started = performance.now();
           decodeDonnaData(mod);
           timings.push(performance.now() - started);
         }
         timings.sort((a, b) => a - b);
         batches.push({
           medianMs: timings[Math.floor(timings.length / 2)],
           p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
         });
       }
       console.log(JSON.stringify({
         batches,
         minimumP95Ms: Math.min(...batches.map(({ p95Ms }) => p95Ms)),
       }));`,
    ],
    { cwd: path.resolve(HERE, '..', '..', '..', '..'), encoding: 'utf8' },
  ),
);
console.log(
  `  full decode batch p95s: ${benchmark.batches.map(({ p95Ms }) => `${p95Ms.toFixed(3)} ms`).join(', ')}; ` +
    `minimum: ${benchmark.minimumP95Ms.toFixed(3)} ms`,
);
ok(
  benchmark.minimumP95Ms < 80,
  `full synchronous decode minimum batch p95 stays under 80 ms ` +
    `(was ${benchmark.minimumP95Ms.toFixed(3)} ms)`,
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
