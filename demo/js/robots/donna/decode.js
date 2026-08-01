// donna/decode.js - byte decoder for the generated Donna MCAP replay modules.
//
// The wire format is frozen as donna-int16-delta-v1 in the private extraction project. Generated
// modules are side-effect-free literals. All base64 and int16 work happens here so a decoder error
// can be retried, while an ES module evaluation error remains a reload-only failure.
//
// Nothing in this module has side effects at import time.

/** The only format version this decoder implements. */
export const SUPPORTED_FORMAT_VERSION = 'donna-int16-delta-v1';

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

const columns = (names, scale, unit) => names.map((name) => ({ name, scale, unit }));
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

const TRACK_SCHEMA = {
  summaryImu: {
    stepMs: 50,
    columns: [
      { name: 'accelMagMps2', scale: 100, unit: 'm/s^2' },
      { name: 'pitchDeg', scale: 100, unit: 'deg' },
      { name: 'rollDeg', scale: 100, unit: 'deg' },
    ],
  },
  summaryMotion: {
    stepMs: 100,
    columns: [
      { name: 'cmdVxMps', scale: 10000, unit: 'm/s' },
      { name: 'odomVxMps', scale: 10000, unit: 'm/s' },
      { name: 'cmdYawRadps', scale: 10000, unit: 'rad/s' },
    ],
  },
  summaryServos: {
    stepMs: 500,
    columns: [
      { name: 'maxTempC', scale: 100, unit: 'degC' },
      { name: 'minBusVoltageV', scale: 1000, unit: 'V' },
    ],
  },
  summaryGame: {
    stepMs: 500,
    columns: [
      { name: 'secondsRemaining', scale: 1, unit: 's' },
      { name: 'ownScore', scale: 1, unit: 'count' },
      { name: 'rivalScore', scale: 1, unit: 'count' },
    ],
  },
  summaryBall: {
    stepMs: 200,
    columns: [
      { name: 'ballDistM', scale: 1000, unit: 'm' },
      { name: 'ballBearingDeg', scale: 100, unit: 'deg' },
      { name: 'ballSeen', scale: 1, unit: 'bool' },
    ],
  },
  summaryCompute: {
    stepMs: 500,
    columns: [
      { name: 'cpuLoadPct', scale: 100, unit: 'percent' },
      { name: 'memUsedPct', scale: 100, unit: 'percent' },
    ],
  },
  joints: { stepMs: 40, columns: columns(JOINT_NAMES, 10000, 'rad') },
  torsoQuaternion: {
    stepMs: 40,
    columns: columns(['qx', 'qy', 'qz', 'qw'], 30000, 'quaternion'),
  },
  pose: {
    irregular: true,
    columns: [
      { name: 'tMs', scale: 1, unit: 'ms' },
      { name: 'xM', scale: 1000, unit: 'm' },
      { name: 'yM', scale: 1000, unit: 'm' },
      { name: 'yawRad', scale: 5000, unit: 'rad' },
      { name: 'segment', scale: 1, unit: 'index' },
    ],
  },
  ballField: {
    stepMs: 200,
    columns: [
      { name: 'xM', scale: 1000, unit: 'm' },
      { name: 'yM', scale: 1000, unit: 'm' },
      { name: 'zM', scale: 1000, unit: 'm' },
      { name: 'ballSeen', scale: 1, unit: 'bool' },
    ],
  },
};

/** Every decoder failure is retryable because no module evaluation happens in this function. */
export class DonnaDecodeError extends Error {
  constructor(code, message, cause) {
    super(`donna/decode: ${message}`);
    this.name = 'DonnaDecodeError';
    this.code = code;
    this.retryable = true;
    if (cause !== undefined) this.cause = cause;
  }
}

// ------------------------------------------------------------------ primitives

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 to bytes. atob is preferred; Buffer is the Node fallback. */
function b64ToBytes(b64) {
  if (typeof b64 !== 'string' || !b64.length) {
    throw new DonnaDecodeError('BAD_BASE64', 'BLOB_B64 is missing or not a string');
  }
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) {
    throw new DonnaDecodeError('BAD_BASE64', 'BLOB_B64 is not valid standard base64');
  }
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    /* c8 ignore next 1 */
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch (err) {
    throw new DonnaDecodeError('BAD_BASE64', 'BLOB_B64 is not valid standard base64', err);
  }
  /* c8 ignore next 1 */
  throw new DonnaDecodeError('BAD_BASE64', 'no base64 decoder is available in this runtime');
}

/** Decode one little-endian signed int16 delta column into logical values. */
function readColumn(view, spec) {
  const out = new Float64Array(spec.length);
  let acc = 0;
  for (let i = 0; i < spec.length; i++) {
    const word = view.getInt16(spec.byteOffset + i * 2, true);
    acc = i === 0 ? word : acc + word;
    out[i] = acc / spec.scale;
  }
  return out;
}

/** Decode a standalone fixture column through the same int16 delta primitive as the mission blob. */
export function decodeInt16DeltaColumn(bytes, scale) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new DonnaDecodeError('BAD_COLUMN', 'fixture column bytes must be a non-empty even-length Uint8Array');
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new DonnaDecodeError('BAD_COLUMN', 'fixture column scale must be positive');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readColumn(view, { byteOffset: 0, length: bytes.length / 2, scale });
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

// ------------------------------------------------------------------ decoder

/**
 * Decode donna-data.js or preview-data.js through one byte path.
 *
 * VARIANT selects the frozen window and pose time-origin invariants only. Track and column decoding
 * is identical for full and preview, which makes preview/full parity a property of one decoder.
 *
 * @param {{DATASET_HASH:string, FORMAT_VERSION:string, VARIANT:string, META:object, BLOB_B64:string}} mod
 * @returns {{datasetHash:string, formatVersion:string, variant:string, meta:object, tracks:object, events:Array}}
 * @throws {DonnaDecodeError}
 */
export function decodeDonnaData(mod) {
  const META = mod && mod.META;
  if (!META || typeof META !== 'object') {
    throw new DonnaDecodeError('BAD_MODULE', 'the module carries no META object');
  }
  if (mod.FORMAT_VERSION !== SUPPORTED_FORMAT_VERSION) {
    throw new DonnaDecodeError(
      'UNSUPPORTED_FORMAT_VERSION',
      `unsupported format version "${mod.FORMAT_VERSION}"`,
    );
  }
  if (mod.VARIANT !== 'full' && mod.VARIANT !== 'preview') {
    throw new DonnaDecodeError('BAD_MODULE', `unknown VARIANT "${mod.VARIANT}"`);
  }
  if (typeof mod.DATASET_HASH !== 'string' || !/^[0-9a-f]{64}$/.test(mod.DATASET_HASH)) {
    throw new DonnaDecodeError('BAD_MODULE', 'DATASET_HASH is not a lowercase sha256 hex digest');
  }
  if (!META.tracks || typeof META.tracks !== 'object') {
    throw new DonnaDecodeError('BAD_MODULE', 'META carries no tracks table');
  }
  if (!Array.isArray(META.events) || META.events.length !== EVENT_IDS.length) {
    throw new DonnaDecodeError('BAD_MODULE', 'META.events is not the frozen 20-row ledger');
  }
  for (let i = 0; i < META.events.length; i++) {
    const event = META.events[i];
    if (
      !event ||
      event.id !== EVENT_IDS[i] ||
      typeof event.kind !== 'string' ||
      !Number.isFinite(event.t) ||
      typeof event.title !== 'string' ||
      typeof event.detail !== 'string'
    ) {
      throw new DonnaDecodeError('BAD_MODULE', `META.events row ${i} does not match the frozen event schema`);
    }
    if (event.kind === 'speak' && typeof event.text !== 'string') {
      throw new DonnaDecodeError('BAD_MODULE', `META.events row ${i} is speech without verbatim text`);
    }
    if (event.id === 'ready-set-blip' && !Number.isFinite(event.endT)) {
      throw new DonnaDecodeError('BAD_MODULE', 'the READY/SET event has no end time');
    }
  }

  const trackNames = Object.keys(META.tracks);
  if (!sameKeys(trackNames, TRACK_ORDER)) {
    throw new DonnaDecodeError(
      'BAD_MODULE',
      `track order is ${trackNames.join(', ')}, expected ${TRACK_ORDER.join(', ')}`,
    );
  }

  if (!Array.isArray(META.window) || META.window.length !== 2) {
    throw new DonnaDecodeError('BAD_MODULE', 'META.window is not a pair');
  }
  if (mod.VARIANT === 'full') {
    if (META.window[0] !== 0 || META.window[1] !== 306) {
      throw new DonnaDecodeError('BAD_MODULE', 'the full variant window is not [0, 306]');
    }
    if (META.tracks.pose.timing.timeOriginMs !== 0) {
      throw new DonnaDecodeError('BAD_MODULE', 'the full pose time origin is not 0 ms');
    }
  } else {
    if (META.window[0] !== 237 || META.window[1] !== 243) {
      throw new DonnaDecodeError('BAD_MODULE', 'the preview variant window is not [237, 243]');
    }
    if (META.tracks.pose.timing.timeOriginMs !== 237000) {
      throw new DonnaDecodeError('BAD_MODULE', 'the preview pose time origin is not 237000 ms');
    }
  }

  const windowStartMs = META.window[0] * 1000;
  const windowEndMs = META.window[1] * 1000;
  let expectedOffset = 0;
  for (const trackName of trackNames) {
    const track = META.tracks[trackName];
    const schema = TRACK_SCHEMA[trackName];
    if (!track || !Number.isInteger(track.count) || track.count <= 0 || !track.timing) {
      throw new DonnaDecodeError('BAD_MODULE', `track "${trackName}" is malformed`);
    }
    if (schema.irregular) {
      if (
        track.timing.kind !== 'irregular' ||
        track.timing.timeColumn !== 'tMs' ||
        track.timing.timeOriginMs !== windowStartMs
      ) {
        throw new DonnaDecodeError('BAD_TIMING', `track "${trackName}" does not carry the frozen irregular timing`);
      }
    } else {
      const expectedCount = Math.round((windowEndMs - windowStartMs) / schema.stepMs) + 1;
      if (
        track.timing.kind !== 'uniform' ||
        track.timing.startMs !== windowStartMs ||
        track.timing.stepMs !== schema.stepMs ||
        track.count !== expectedCount
      ) {
        throw new DonnaDecodeError('BAD_TIMING', `track "${trackName}" does not carry the frozen uniform timing`);
      }
    }
    if (!Array.isArray(track.columns) || track.columns.length !== schema.columns.length) {
      throw new DonnaDecodeError('BAD_MODULE', `track "${trackName}" does not carry the frozen column count`);
    }
    for (let columnIndex = 0; columnIndex < track.columns.length; columnIndex++) {
      const column = track.columns[columnIndex];
      const expectedColumn = schema.columns[columnIndex];
      if (!column || column.name !== expectedColumn.name) {
        throw new DonnaDecodeError(
          'BAD_MODULE',
          `track "${trackName}" column ${columnIndex} is not "${expectedColumn.name}"`,
        );
      }
      if (column.encoding !== 'int16-delta-le') {
        throw new DonnaDecodeError(
          'UNKNOWN_ENCODING',
          `column "${trackName}.${column.name}" has encoding "${column.encoding}"`,
        );
      }
      if (!Number.isInteger(column.byteOffset) || column.byteOffset !== expectedOffset) {
        throw new DonnaDecodeError(
          'BAD_OFFSET',
          `column "${trackName}.${column.name}" starts at ${column.byteOffset}, expected ${expectedOffset}`,
        );
      }
      if (!Number.isInteger(column.length) || column.length !== track.count) {
        throw new DonnaDecodeError(
          'COLUMN_LENGTH_MISMATCH',
          `column "${trackName}.${column.name}" has ${column.length} samples, track declares ${track.count}`,
        );
      }
      if (column.scale !== expectedColumn.scale || column.unit !== expectedColumn.unit) {
        throw new DonnaDecodeError(
          'BAD_MODULE',
          `column "${trackName}.${column.name}" does not carry the frozen scale and unit`,
        );
      }
      expectedOffset += column.length * 2;
    }
  }

  const bytes = b64ToBytes(mod.BLOB_B64);
  if (bytes.length !== expectedOffset) {
    throw new DonnaDecodeError(
      'BLOB_LENGTH_MISMATCH',
      `the blob is ${bytes.length} bytes but the column table declares ${expectedOffset}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks = {};
  for (const trackName of trackNames) {
    const track = META.tracks[trackName];
    const decoded = {};
    for (const column of track.columns) decoded[column.name] = readColumn(view, column);
    tracks[trackName] = decoded;
  }

  return {
    datasetHash: mod.DATASET_HASH,
    formatVersion: mod.FORMAT_VERSION,
    variant: mod.VARIANT,
    meta: META,
    tracks,
    events: META.events,
  };
}
