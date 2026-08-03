// donna/decode.js - synchronous decoder for the generated three-robot Donna replay modules.
//
// Generated modules stay side-effect-free literals. Module import failures are reload-only, while
// every failure thrown here is retryable because the byte decode can be attempted again.

export const SUPPORTED_FORMAT_VERSION = 'donna-team-v2';

const FULL_TRACK_ORDER = [
  'summaryImu',
  'summaryMotion',
  'summaryServos',
  'summaryGame',
  'summaryBall',
  'summaryCompute',
  'donnaJoints',
  'donnaTorsoQuaternion',
  'donnaPose0',
  'donnaPose1',
  'donnaRobotState',
  'donnaPresence',
  'donnaBallField',
  'jackJoints',
  'jackTorsoQuaternion',
  'jackPose0',
  'jackPose1',
  'jackPose2',
  'jackPose3',
  'jackRobotState',
  'jackPresence',
  'roryJoints',
  'roryTorsoQuaternion',
  'roryPose0',
  'roryRobotState',
  'roryPresence',
  'donnaHud',
  'jackHud',
  'roryHud',
];

// FORMAT-V2 Amendment 2: the eager variant is the single hero frame the picker and connect card
// actually draw. Chart, event, robot-state and HUD series remain full-module only.
const PREVIEW_TRACK_ORDER = [
  'donnaJoints',
  'donnaTorsoQuaternion',
  'donnaPose1',
  'donnaPresence',
  'jackJoints',
  'jackTorsoQuaternion',
  'jackPose3',
  'jackPresence',
  'roryJoints',
  'roryTorsoQuaternion',
  'roryPose0',
  'roryPresence',
  'donnaBallField',
];

const EVENT_IDS = [
  'window-open',
  'jack-fall-1',
  'jack-speak-1',
  'rory-re-entry',
  'goal-5-0',
  'jack-fall-2',
  'jack-speak-2',
  'donna-penalty-start',
  'donna-penalty-end',
  'jack-fall-3',
  'jack-speak-3',
  'goal-6-0',
  'finished',
  'donna-fall-count',
  'jack-fall-count',
  'rory-fall-count',
  'donna-queue-full',
  'jack-queue-full',
  'rory-queue-full',
  'donna-low-power',
];

const JOINT_NAMES = [
  'HeadPan',
  'HeadTilt',
  'LHipYaw',
  'LHipRoll',
  'LHipPitch',
  'LKnee',
  'LAnklePitch',
  'LAnkleRoll',
  'RHipYaw',
  'RHipRoll',
  'RHipPitch',
  'RKnee',
  'RAnklePitch',
  'RAnkleRoll',
  'RShoulderPitch',
  'LShoulderPitch',
  'RShoulderRoll',
  'LShoulderRoll',
  'RElbow',
  'LElbow',
];

const SUMMARY_SCHEMAS = {
  summaryImu: [
    ['accelMagMps2', 'int16-delta-le', 100, 'm/s^2'],
    ['pitchDeg', 'int16-delta-le', 100, 'deg'],
    ['rollDeg', 'int16-delta-le', 100, 'deg'],
  ],
  summaryMotion: [
    ['cmdVxMps', 'int16-delta-le', 10000, 'm/s'],
    ['odomVxMps', 'int16-delta-le', 10000, 'm/s'],
    ['cmdYawRadps', 'int16-delta-le', 10000, 'rad/s'],
  ],
  summaryServos: [
    ['maxTempC', 'int16-delta-le', 100, 'degC'],
    ['minBusVoltageV', 'int16-delta-le', 1000, 'V'],
  ],
  summaryGame: [
    ['secondsRemaining', 'int16-delta-le', 1, 's'],
    ['ownScore', 'int16-delta-le', 1, 'count'],
    ['rivalScore', 'int16-delta-le', 1, 'count'],
  ],
  summaryBall: [
    ['ballDistM', 'int16-delta-le', 1000, 'm'],
    ['ballBearingDeg', 'int16-wrapped-delta-le', 100, 'deg', 360],
    ['ballSeen', 'int16-delta-le', 1, 'bool'],
  ],
  summaryCompute: [
    ['cpuLoadPct', 'int16-delta-le', 100, 'percent'],
    ['memUsedPct', 'int16-delta-le', 100, 'percent'],
  ],
};

const FIXED_SCHEMAS = {
  TorsoQuaternion: ['qx', 'qy', 'qz', 'qw'].map((name) => [name, 'int16-delta-le', 30000, 'quaternion']),
  Pose: [
    ['t10ms', 'int16-delta-le', 1, '10ms'],
    ['xM', 'int16-delta-le', 1000, 'm'],
    ['yM', 'int16-delta-le', 1000, 'm'],
    ['yawRad', 'int16-wrapped-delta-le', 5000, 'rad', 2 * Math.PI],
  ],
  RobotState: [
    ['t10ms', 'int16-delta-le', 1, '10ms'],
    ['state', 'int16-delta-le', 1, 'enum'],
  ],
  Presence: [
    ['start10ms', 'int16-delta-le', 1, '10ms'],
    ['end10ms', 'int16-delta-le', 1, '10ms'],
    ['class', 'int16-delta-le', 1, 'enum'],
    ['renderMode', 'int16-delta-le', 1, 'enum'],
  ],
  BallField: [
    ['xM', 'int16-delta-le', 1000, 'm'],
    ['yM', 'int16-delta-le', 1000, 'm'],
    ['zM', 'int16-delta-le', 1000, 'm'],
    ['ballSeen', 'int16-delta-le', 1, 'bool'],
  ],
  Hud: [
    ['secondsRemaining', 'int16-delta-le', 1, 's'],
    ['ownScore', 'int16-delta-le', 1, 'count'],
    ['rivalScore', 'int16-delta-le', 1, 'count'],
    ['gameState', 'int16-delta-le', 1, 'enum'],
    ['penalized', 'int16-delta-le', 1, 'bool'],
  ],
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class DonnaDecodeError extends Error {
  constructor(code, message, cause) {
    super(`donna/decode: ${message}`);
    this.name = 'DonnaDecodeError';
    this.code = code;
    this.retryable = true;
    if (cause !== undefined) this.cause = cause;
  }
}

function b64ToBytes(b64) {
  if (typeof b64 !== 'string' || !b64.length) {
    throw new DonnaDecodeError('BAD_BASE64', 'BLOB_B64 is missing or not a string');
  }
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) {
    throw new DonnaDecodeError('BAD_BASE64', 'BLOB_B64 is not valid standard base64');
  }
  try {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    /* c8 ignore next 7 */
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch (err) {
    throw new DonnaDecodeError('BAD_BASE64', 'BLOB_B64 is not valid standard base64', err);
  }
  /* c8 ignore next 1 */
  throw new DonnaDecodeError('BAD_BASE64', 'no base64 decoder is available in this runtime');
}

function sameArray(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function reverseTable(table) {
  const out = {};
  for (const [name, code] of Object.entries(table || {})) out[code] = name;
  return out;
}

function schemaForTrack(name) {
  if (SUMMARY_SCHEMAS[name]) return SUMMARY_SCHEMAS[name];
  if (/^(donna|jack|rory)Joints$/.test(name)) {
    return JOINT_NAMES.map((joint) => [joint, 'int16-delta-le', 10000, 'rad']);
  }
  for (const [suffix, schema] of Object.entries(FIXED_SCHEMAS)) {
    if (name.endsWith(suffix) || (suffix === 'Pose' && /Pose\d+$/.test(name))) return schema;
  }
  return null;
}

function expectedStepMs(name) {
  if (name === 'summaryImu' || /TorsoQuaternion$/.test(name)) return 50;
  if (name === 'summaryMotion' || /^(jack|rory)Joints$/.test(name)) return 100;
  if (name === 'summaryServos' || name === 'summaryGame' || name === 'summaryCompute' || /Hud$/.test(name)) {
    return 500;
  }
  if (name === 'summaryBall' || name === 'donnaBallField') return 200;
  if (name === 'donnaJoints') return 40;
  return null;
}

function normalizeWrapped(value, period) {
  const half = period / 2;
  while (value > half) value -= period;
  while (value < -half) value += period;
  return value;
}

function readLogicalColumn(view, spec) {
  const out = new Float64Array(spec.length);
  const delta = spec.encoding === 'int16-delta-le' || spec.encoding === 'int16-wrapped-delta-le';
  const absolute = spec.encoding === 'int16-absolute-le';
  if (!delta && !absolute) {
    throw new DonnaDecodeError('UNKNOWN_ENCODING', `column "${spec.name}" has encoding "${spec.encoding}"`);
  }
  let acc = 0;
  for (let i = 0; i < spec.length; i++) {
    const word = view.getInt16(spec.byteOffset + i * 2, true);
    acc = delta ? (i === 0 ? word : acc + word) : word;
    let value = acc / spec.scale;
    if (spec.encoding === 'int16-wrapped-delta-le') value = normalizeWrapped(value, spec.wrapPeriod);
    out[i] = value;
  }
  return out;
}

export function decodeInt16DeltaColumn(bytes, scale) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new DonnaDecodeError('BAD_COLUMN', 'fixture bytes must be a non-empty even-length Uint8Array');
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new DonnaDecodeError('BAD_COLUMN', 'fixture scale must be positive');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readLogicalColumn(view, {
    name: 'fixture',
    byteOffset: 0,
    length: bytes.length / 2,
    scale,
    encoding: 'int16-delta-le',
  });
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length !== EVENT_IDS.length) {
    throw new DonnaDecodeError('BAD_MODULE', 'META.events is not the frozen 20-row ledger');
  }
  for (let i = 0; i < events.length; i++) {
    const row = events[i];
    if (
      !row ||
      row.id !== EVENT_IDS[i] ||
      typeof row.kind !== 'string' ||
      typeof row.robot !== 'string' ||
      !Number.isFinite(row.t) ||
      typeof row.title !== 'string' ||
      typeof row.detail !== 'string'
    ) {
      throw new DonnaDecodeError('BAD_MODULE', `META.events row ${i} does not match the frozen schema`);
    }
    if (row.kind === 'speak' && row.text !== row.detail) {
      throw new DonnaDecodeError('BAD_MODULE', `META.events row ${i} does not preserve verbatim speech`);
    }
  }
}

function validateColumn(column, expected, trackName, trackCount, expectedOffset) {
  const [name, encoding, scale, unit, wrapPeriod] = expected;
  if (!column || column.name !== name) {
    throw new DonnaDecodeError('BAD_MODULE', `track "${trackName}" does not carry column "${name}" in order`);
  }
  if (column.encoding !== encoding) {
    throw new DonnaDecodeError(
      'UNKNOWN_ENCODING',
      `column "${trackName}.${name}" has encoding "${column.encoding}", expected "${encoding}"`,
    );
  }
  if (column.scale !== scale || column.unit !== unit) {
    throw new DonnaDecodeError('BAD_MODULE', `column "${trackName}.${name}" has the wrong scale or unit`);
  }
  if (wrapPeriod !== undefined && Math.abs(column.wrapPeriod - wrapPeriod) > 1e-12) {
    throw new DonnaDecodeError('BAD_MODULE', `column "${trackName}.${name}" has the wrong wrap period`);
  }
  if (!Number.isInteger(column.length) || column.length !== trackCount) {
    throw new DonnaDecodeError(
      'COLUMN_LENGTH_MISMATCH',
      `column "${trackName}.${name}" has ${column.length} samples, track declares ${trackCount}`,
    );
  }
  if (column.byteLength !== column.length * 2) {
    throw new DonnaDecodeError('COLUMN_LENGTH_MISMATCH', `column "${trackName}.${name}" has a bad byteLength`);
  }
  if (!Number.isInteger(column.byteOffset) || column.byteOffset !== expectedOffset) {
    throw new DonnaDecodeError(
      'BAD_OFFSET',
      `column "${trackName}.${name}" starts at ${column.byteOffset}, expected ${expectedOffset}`,
    );
  }
  return expectedOffset + column.byteLength;
}

function validateTiming(name, track, window, variant) {
  const stepMs = expectedStepMs(name);
  if (stepMs !== null) {
    const previewHeroSample = variant === 'preview';
    const expectedCount = previewHeroSample
      ? 1
      : Math.round(((window[1] - window[0]) * 1000) / stepMs) + 1;
    const expectedStartMs = previewHeroSample ? 187600 : window[0] * 1000;
    if (
      track.timing.kind !== 'uniform' ||
      track.timing.startMs !== expectedStartMs ||
      track.timing.stepMs !== stepMs ||
      track.count !== expectedCount
    ) {
      throw new DonnaDecodeError(
        'BAD_TIMING',
        `track "${name}" does not carry the frozen ${previewHeroSample ? 'preview hero sample' : 'uniform grid'}`,
      );
    }
    return;
  }
  if (/Pose\d+$/.test(name)) {
    if (
      (variant === 'preview' && track.count !== 2) ||
      track.timing.kind !== 'irregular-segment' ||
      track.timing.timeColumn !== 't10ms' ||
      track.timing.tickSec !== 0.01 ||
      !Number.isInteger(track.timing.segmentStart10ms) ||
      !Number.isInteger(track.timing.sourcePresenceSegment)
    ) {
      throw new DonnaDecodeError('BAD_TIMING', `track "${name}" does not carry segment-relative 10 ms timing`);
    }
    return;
  }
  if (/RobotState$/.test(name)) {
    if (track.timing.kind !== 'irregular' || track.timing.timeColumn !== 't10ms' || track.timing.tickSec !== 0.01) {
      throw new DonnaDecodeError('BAD_TIMING', `track "${name}" does not carry 10 ms transition timing`);
    }
    return;
  }
  if (/Presence$/.test(name)) {
    if (track.timing.kind !== 'interval-table' || track.timing.tickSec !== 0.01) {
      throw new DonnaDecodeError('BAD_TIMING', `track "${name}" does not carry the frozen interval timing`);
    }
    return;
  }
  throw new DonnaDecodeError('BAD_MODULE', `track "${name}" has no frozen schema`);
}

function validateDecodedTrackSemantics(name, track, spec, window) {
  if (/Pose\d+$/.test(name)) {
    if (track.t10ms[0] !== 0) {
      throw new DonnaDecodeError('BAD_TIMING', `track "${name}" does not start at relative tick zero`);
    }
    for (let i = 1; i < track.t10ms.length; i++) {
      if (!(track.t10ms[i] > track.t10ms[i - 1])) {
        throw new DonnaDecodeError('BAD_TIMING', `track "${name}" pose ticks are not strictly increasing`);
      }
    }
    const first = spec.timing.segmentStart10ms;
    const last = first + track.t10ms[track.t10ms.length - 1];
    if (first < Math.round(window[0] * 100) || last > Math.round(window[1] * 100)) {
      throw new DonnaDecodeError('BAD_TIMING', `track "${name}" escapes the module window`);
    }
  }
  if (/RobotState$/.test(name)) {
    const startTick = Math.round(window[0] * 100);
    const endTick = Math.round(window[1] * 100);
    if (track.t10ms[0] !== startTick) {
      throw new DonnaDecodeError('BAD_CARRY_IN', `track "${name}" has no carry-in row at the window start`);
    }
    for (let i = 1; i < track.t10ms.length; i++) {
      if (!(track.t10ms[i] > startTick && track.t10ms[i] > track.t10ms[i - 1] && track.t10ms[i] <= endTick)) {
        throw new DonnaDecodeError('BAD_CARRY_IN', `track "${name}" violates the start < t <= end carry-in rule`);
      }
    }
  }
}

function decodePresence(tracks, meta, window) {
  const classNames = reverseTable(meta.codeTables.presenceClass);
  const modeNames = reverseTable(meta.codeTables.renderMode);
  const out = {};
  for (const robot of ['donna', 'jack', 'rory']) {
    const track = tracks[`${robot}Presence`];
    const segments = [];
    for (let i = 0; i < track.start10ms.length; i++) {
      const classCode = track.class[i];
      const renderModeCode = track.renderMode[i];
      const className = classNames[classCode];
      const renderMode = modeNames[renderModeCode];
      if (!className || !renderMode) {
        throw new DonnaDecodeError('BAD_PRESENCE', `${robot} presence row ${i} has an unknown code`);
      }
      if (
        (className === 'live' && renderMode !== 'LIVE') ||
        (className === 'fall-outage' && renderMode !== 'HOLD') ||
        ((className === 'penalty-outage' || className === 'pre-first-fix') && renderMode !== 'HIDDEN')
      ) {
        throw new DonnaDecodeError('BAD_PRESENCE', `${robot} presence row ${i} has the wrong render mode`);
      }
      const startT = track.start10ms[i] / 100;
      const endT = track.end10ms[i] / 100;
      if (!(endT >= startT)) throw new DonnaDecodeError('BAD_PRESENCE', `${robot} presence row ${i} is reversed`);
      if (i && track.start10ms[i] !== track.end10ms[i - 1]) {
        throw new DonnaDecodeError('BAD_PRESENCE', `${robot} presence rows do not form a continuous partition`);
      }
      segments.push({ startT, endT, classCode, className, renderModeCode, renderMode });
    }
    const windowStartTick = Math.round(window[0] * 100);
    const windowEndTick = Math.round(window[1] * 100);
    if (
      !segments.length ||
      track.start10ms[0] < windowStartTick ||
      track.end10ms[track.end10ms.length - 1] > windowEndTick
    ) {
      throw new DonnaDecodeError('BAD_PRESENCE', `${robot} presence escapes the module window`);
    }
    out[robot] = segments;
  }
  return out;
}

function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const j of [ia, ib, ic]) {
      normals[j] += nx;
      normals[j + 1] += ny;
      normals[j + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (!length) continue;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  return normals;
}

function decodeMesh(view, meshMeta, expectedStart, blobLength) {
  const geometryTotals = {
    'wolfgang-mesh-columns/1': [4361, 8922],
    'wolfgang-mesh-columns-proxy/1': [645, 1072],
  }[meshMeta && meshMeta.format];
  if (!geometryTotals) {
    throw new DonnaDecodeError('BAD_MESH', 'META.mesh is missing the Wolfgang mesh contract');
  }
  const [meshStart, meshLength] = meshMeta.moduleByteRange || [];
  if (meshStart !== expectedStart || meshStart + meshLength !== blobLength) {
    throw new DonnaDecodeError('BAD_MESH', 'mesh byte range is not the exact tail of the module blob');
  }
  const meshRows = Array.isArray(meshMeta.meshes)
    ? meshMeta.meshes
    : Object.entries(meshMeta.meshes || {}).map(([name, part]) => ({ name, ...part }));
  if (meshRows.length !== 52) {
    throw new DonnaDecodeError('BAD_MESH', 'mesh manifest is not the frozen 52-part set');
  }
  const parts = {};
  const materials = {};
  let offset = meshStart;
  let vertices = 0;
  let triangles = 0;
  for (const part of meshRows) {
    const positionsSpec = part.columns && part.columns.positions;
    const indicesSpec = part.columns && part.columns.indices;
    if (
      !part.name ||
      positionsSpec.encoding !== 'int16-absolute-le' ||
      indicesSpec.encoding !== 'uint16-absolute-le' ||
      positionsSpec.byteOffset !== offset ||
      positionsSpec.byteLength !== positionsSpec.length * 2 ||
      positionsSpec.length !== part.vertex_count * 3
    ) {
      throw new DonnaDecodeError('BAD_MESH', `mesh part "${part.name || '?'}" has a bad position column`);
    }
    offset += positionsSpec.byteLength;
    if (
      indicesSpec.byteOffset !== offset ||
      indicesSpec.byteLength !== indicesSpec.length * 2 ||
      indicesSpec.length !== part.triangle_count * 3
    ) {
      throw new DonnaDecodeError('BAD_MESH', `mesh part "${part.name}" has a bad absolute index column`);
    }
    offset += indicesSpec.byteLength;

    const positions = new Float32Array(positionsSpec.length);
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      positions[i] =
        view.getInt16(positionsSpec.byteOffset + i * 2, true) * part.quant_scale[axis] + part.quant_offset[axis];
    }
    const indices = new Uint16Array(indicesSpec.length);
    for (let i = 0; i < indices.length; i++) {
      const index = view.getUint16(indicesSpec.byteOffset + i * 2, true);
      if (index >= part.vertex_count) {
        throw new DonnaDecodeError('BAD_MESH', `mesh part "${part.name}" references vertex ${index}`);
      }
      indices[i] = index;
    }
    const materialClass = part.material_class;
    materials[materialClass] = materials[materialClass] || { class: materialClass };
    parts[part.name] = {
      name: part.name,
      positions,
      indices,
      normals: computeNormals(positions, indices),
      vertexCount: part.vertex_count,
      triangleCount: part.triangle_count,
      materialClass,
    };
    vertices += part.vertex_count;
    triangles += part.triangle_count;
  }
  const [expectedVertices, expectedTriangles] = geometryTotals;
  if (offset !== meshStart + meshLength || vertices !== expectedVertices || triangles !== expectedTriangles) {
    throw new DonnaDecodeError('BAD_MESH', 'decoded mesh totals do not match the frozen manifest');
  }

  const visual = meshMeta.visualInstances;
  if (!visual || !Array.isArray(visual.instances) || visual.instances.length !== 133) {
    throw new DonnaDecodeError('BAD_MESH', 'visual instance manifest is not the frozen 133 placements');
  }
  const instances = visual.instances.map((instance) => {
    if (!parts[instance.mesh] || !instance.pre_composed || !visual.buckets[instance.driven_ancestor]) {
      throw new DonnaDecodeError('BAD_MESH', `visual instance "${instance.instance_id || '?'}" is malformed`);
    }
    return {
      id: instance.instance_id,
      link: instance.link,
      part: instance.mesh,
      materialClass: instance.material_class,
      bucket: instance.driven_ancestor,
      translation: Float64Array.from(instance.pre_composed.translation),
      quaternionWxyz: Float64Array.from(instance.pre_composed.quaternion_wxyz),
    };
  });

  return { parts, meshes: parts, instances, materials, proxy: meshMeta.proxy === true };
}

/** Decode either generated module through the same synchronous byte path. */
export function decodeDonnaData(mod) {
  const meta = mod && mod.META;
  if (!meta || typeof meta !== 'object') throw new DonnaDecodeError('BAD_MODULE', 'the module carries no META object');
  if (mod.FORMAT_VERSION !== SUPPORTED_FORMAT_VERSION) {
    throw new DonnaDecodeError('UNSUPPORTED_FORMAT_VERSION', `unsupported format version "${mod.FORMAT_VERSION}"`);
  }
  if (mod.VARIANT !== 'full' && mod.VARIANT !== 'preview') {
    throw new DonnaDecodeError('BAD_MODULE', `unknown VARIANT "${mod.VARIANT}"`);
  }
  if (typeof mod.DATASET_HASH !== 'string' || !/^[0-9a-f]{64}$/.test(mod.DATASET_HASH)) {
    throw new DonnaDecodeError('BAD_MODULE', 'DATASET_HASH is not a lowercase sha256 digest');
  }
  const expectedWindow = mod.VARIANT === 'full' ? [0, 250] : [184, 190];
  if (!Array.isArray(meta.window) || !sameArray(meta.window, expectedWindow)) {
    throw new DonnaDecodeError('BAD_MODULE', `${mod.VARIANT} window is not [${expectedWindow.join(', ')}]`);
  }
  if (!meta.mission || meta.mission.durationSec !== 250 || meta.mission.heroTime !== 187.6) {
    throw new DonnaDecodeError('BAD_MODULE', 'META.mission does not carry the frozen duration and hero time');
  }
  if (!sameArray(meta.jointNames || [], JOINT_NAMES)) {
    throw new DonnaDecodeError('BAD_MODULE', 'META.jointNames is not the frozen 20-joint order');
  }
  if (mod.VARIANT === 'full') validateEvents(meta.events);

  const expectedTrackOrder = mod.VARIANT === 'full' ? FULL_TRACK_ORDER : PREVIEW_TRACK_ORDER;
  const trackNames = Object.keys(meta.tracks || {});
  if (!sameArray(trackNames, expectedTrackOrder)) {
    throw new DonnaDecodeError('BAD_MODULE', `track order is not the frozen ${mod.VARIANT} order`);
  }

  let expectedOffset = 0;
  for (const trackName of trackNames) {
    const track = meta.tracks[trackName];
    const schema = schemaForTrack(trackName);
    if (!track || !Number.isInteger(track.count) || track.count <= 0 || !track.timing || !schema) {
      throw new DonnaDecodeError('BAD_MODULE', `track "${trackName}" is malformed`);
    }
    validateTiming(trackName, track, expectedWindow, mod.VARIANT);
    if (!Array.isArray(track.columns) || track.columns.length !== schema.length) {
      throw new DonnaDecodeError('BAD_MODULE', `track "${trackName}" has the wrong column count`);
    }
    for (let i = 0; i < schema.length; i++) {
      expectedOffset = validateColumn(track.columns[i], schema[i], trackName, track.count, expectedOffset);
    }
  }

  const bytes = b64ToBytes(mod.BLOB_B64);
  const meshRange = meta.mesh && meta.mesh.moduleByteRange;
  const declaredBlobLength = meshRange && meshRange[0] + meshRange[1];
  if (!Number.isInteger(declaredBlobLength) || bytes.length !== declaredBlobLength) {
    throw new DonnaDecodeError(
      'BLOB_LENGTH_MISMATCH',
      `the blob is ${bytes.length} bytes but the track and mesh tables declare ${declaredBlobLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks = {};
  for (const trackName of trackNames) {
    const spec = meta.tracks[trackName];
    const decoded = {};
    for (const column of spec.columns) decoded[column.name] = readLogicalColumn(view, column);
    validateDecodedTrackSemantics(trackName, decoded, spec, expectedWindow);
    tracks[trackName] = decoded;
  }

  const presence = decodePresence(tracks, meta, expectedWindow);
  const mesh = decodeMesh(view, meta.mesh, expectedOffset, bytes.length);

  if (mod.VARIANT === 'preview') {
    // scene.js binds these references for its full viewer HUD, but neither eager surface calls
    // hudState(). Keep the producer honest by omitting the unused series, then provide non-enumerable
    // inert adapters at decode time so the unchanged scene binder can store the references.
    for (const robot of ['donna', 'jack', 'rory']) {
      Object.defineProperty(tracks, `${robot}RobotState`, {
        enumerable: false,
        value: {
          t10ms: Float64Array.of(18760),
          state: Float64Array.of(10),
        },
      });
      Object.defineProperty(tracks, `${robot}Hud`, {
        enumerable: false,
        value: {
          secondsRemaining: Float64Array.of(0),
          ownScore: Float64Array.of(0),
          rivalScore: Float64Array.of(0),
          gameState: Float64Array.of(0),
          penalized: Float64Array.of(0),
        },
      });
    }
  }

  return {
    datasetHash: mod.DATASET_HASH,
    formatVersion: mod.FORMAT_VERSION,
    variant: mod.VARIANT,
    meta,
    tracks,
    presence,
    mesh,
    events: mod.VARIANT === 'full' ? meta.events : [],
  };
}
