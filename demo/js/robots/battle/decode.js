// battle/decode.js - byte decoder for the generated `battle` round modules.
//
// The wire format and the decoded object shape are frozen in the private generator repo
// (reels/_scratch/battle-sim/FORMAT.md, format version 1). This file is the ONLY place in the
// battle mission that knows about bytes; everything downstream sees typed arrays.
//
// This decoder is battle-specific and is shared with NO other mission. The other lazy mission's
// decoder reads a different schema entirely and is neither reused nor extended here.
//
// Why the decoding lives outside the generated modules: an ES module that throws while evaluating
// is cached as FAILED by specifier for the life of the document and can never be retried.
// battle-data.js and preview-data.js therefore export nothing but strings, numbers and plain
// literals, and every byte is turned into a number inside this function, which data.js can call
// again after a failure.
//
// Nothing in this module has side effects at import time.

/** The only format version this decoder implements. */
export const SUPPORTED_FORMAT_VERSION = 1;

/**
 * UWB wire units. `cmd_uwb_info` carries the position as int16 CENTIMETRES on the CAN wire and the
 * chassis driver divides by 100 to publish metres, so 100 cm is 1 m and nothing in this payload is
 * ever in centimetres: `/blue1/localization`'s xM, yM and uwbResidualM are all metres already.
 * The constant and the converter are exported so that conversion is a named, testable fixture
 * rather than a magic literal somewhere in a comment.
 */
export const UWB_WIRE_CM_PER_M = 100;

/** Wire centimetres to metres, the one conversion the UWB path performs. */
export function uwbWireCmToM(cm) {
  return cm / UWB_WIRE_CM_PER_M;
}

/**
 * Everything this file throws. `code` is the machine-readable reason; `retryable` is true on all of
 * them because a decoder failure, unlike a module evaluation failure, can be attempted again.
 */
export class BattleDecodeError extends Error {
  constructor(code, message, cause) {
    super(`battle/decode: ${message}`);
    this.name = 'BattleDecodeError';
    this.code = code;
    this.retryable = true;
    if (cause !== undefined) this.cause = cause;
  }
}

// ------------------------------------------------------------------ primitives

/** base64 to bytes. atob everywhere modern; Buffer is the Node-without-atob fallback. */
function b64ToBytes(b64) {
  if (typeof b64 !== 'string' || !b64.length) {
    throw new BattleDecodeError('BAD_BASE64', 'BLOB_B64 is missing or not a string');
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
    throw new BattleDecodeError('BAD_BASE64', 'BLOB_B64 is not valid base64', err);
  }
  /* c8 ignore next 1 */
  throw new BattleDecodeError('BAD_BASE64', 'no base64 decoder is available in this runtime');
}

/** Wrap a degree value into [-180, 180), the format's rule for every `wrapDeg` stream. */
export function wrap180(v) {
  return ((((v + 180) % 360) + 360) % 360) - 180;
}

/**
 * Decode one stream out of the packed blob (FORMAT.md section 2).
 *
 * Streams are little-endian signed 16-bit codes, concatenated in `META.streams` order with no
 * header, no padding and no alignment. `delta` streams carry first differences and are prefix
 * summed before scaling, which is what keeps an unwrapped angle inside int16 across a 180 s round.
 *
 * @param {Uint8Array} bytes the whole blob
 * @param {object} spec one `META.streams` entry
 * @param {number} byteOffset where this stream starts
 * @returns {Float64Array} decoded values
 */
function readStream(bytes, spec, byteOffset) {
  if (spec.dtype !== 'i16') {
    throw new BattleDecodeError('UNKNOWN_DTYPE', `stream "${spec.key}" has unknown dtype "${spec.dtype}"`);
  }
  const delta = spec.encoding === 'delta';
  if (!delta && spec.encoding !== 'raw') {
    throw new BattleDecodeError(
      'UNKNOWN_ENCODING',
      `stream "${spec.key}" has unknown encoding "${spec.encoding}"`,
    );
  }
  const n = spec.count;
  const out = new Float64Array(n);
  const scale = spec.scale;
  const offset = spec.offset;
  const wrap = spec.wrapDeg !== undefined;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const o = byteOffset + 2 * i;
    // little-endian signed 16
    let code = bytes[o] | (bytes[o + 1] << 8);
    if (code & 0x8000) code -= 0x10000;
    acc = delta ? (i === 0 ? code : acc + code) : code;
    const v = acc * scale + offset;
    out[i] = wrap ? wrap180(v) : v;
  }
  return out;
}

/** Uniform time axis: sample n sits at `tStartS + n / rateHz`. No per-sample timestamps exist. */
function gridOf(tStartS, rateHz, count) {
  const t = new Float64Array(count);
  for (let i = 0; i < count; i++) t[i] = tStartS + i / rateHz;
  return t;
}

/** Float64 stream to the Float32 the decoded shape publishes for value columns. */
function toF32(src, count, key) {
  if (src.length !== count) {
    throw new BattleDecodeError(
      'STREAM_LENGTH_MISMATCH',
      `stream "${key}" holds ${src.length} samples but its section declares ${count}`,
    );
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = src[i];
  return out;
}

// ------------------------------------------------------------------ the decoder

/**
 * Decode one generated module (battle-data.js or preview-data.js) into BattleData.
 *
 * ONE decoder, ONE code path. `VARIANT` selects nothing but which optional META sections exist:
 * the preview drops `rules`, `rateNotes`, `engineScope` and `claimLedger`, which only the full
 * mission renders, and carries the same stream and channel structure otherwise. The preview
 * therefore decodes through exactly this function, which is what makes the picker card and the
 * replay provably the same round.
 *
 * META is never mutated: everything derived is written into fresh objects and typed arrays, and
 * the pass-through sections are handed back by reference for provenance and facts to read.
 *
 * @param {{DATASET_HASH:string, FORMAT_VERSION:number, VARIANT:string, META:object, BLOB_B64:string}} mod
 * @returns {object} BattleData, per FORMAT.md section 4
 * @throws {BattleDecodeError}
 */
export function decodeBattleData(mod) {
  const META = mod && mod.META;
  if (!META || typeof META !== 'object') {
    throw new BattleDecodeError('BAD_MODULE', 'the module carries no META object');
  }
  if (mod.FORMAT_VERSION !== SUPPORTED_FORMAT_VERSION) {
    throw new BattleDecodeError(
      'UNSUPPORTED_FORMAT_VERSION',
      `unsupported format version ${mod.FORMAT_VERSION}, this decoder implements ${SUPPORTED_FORMAT_VERSION}`,
    );
  }
  if (mod.VARIANT !== 'match' && mod.VARIANT !== 'preview') {
    throw new BattleDecodeError('BAD_MODULE', `unknown VARIANT "${mod.VARIANT}"`);
  }
  for (const key of ['clock', 'geometry', 'teams', 'poseStreams', 'hpTimeline', 'channels', 'streams', 'events']) {
    if (!META[key]) throw new BattleDecodeError('BAD_MODULE', `META is missing "${key}"`);
  }
  if (!Array.isArray(META.streams) || !META.streams.length) {
    throw new BattleDecodeError('BAD_MODULE', 'META.streams is empty');
  }

  // ---- blob. Length is fully determined by the stream table, so a truncated or padded blob is a
  // loud failure rather than a silently short last column.
  const bytes = b64ToBytes(mod.BLOB_B64);
  const byName = new Map();
  let expected = 0;
  for (const spec of META.streams) {
    if (!spec || typeof spec.key !== 'string' || typeof spec.count !== 'number') {
      throw new BattleDecodeError('BAD_MODULE', 'META.streams holds a malformed entry');
    }
    if (byName.has(spec.key)) {
      throw new BattleDecodeError('BAD_MODULE', `duplicate stream key "${spec.key}"`);
    }
    byName.set(spec.key, { spec, byteOffset: expected });
    expected += 2 * spec.count;
  }
  if (bytes.length !== expected) {
    throw new BattleDecodeError(
      'BLOB_LENGTH_MISMATCH',
      `the blob is ${bytes.length} bytes but the stream table declares ${expected}`,
    );
  }

  /** Decode a stream by key, or fail loudly naming who asked for it. */
  const stream = (key, owner) => {
    const entry = byName.get(key);
    if (!entry) {
      throw new BattleDecodeError('MISSING_STREAM', `${owner} references stream "${key}", which is not in META.streams`);
    }
    return readStream(bytes, entry.spec, entry.byteOffset);
  };

  const clock = META.clock;
  const t0 = clock.tStartS;
  const t1 = clock.tEndS;
  const durationS = clock.durationS;

  // ---- poses. One shared grid; the four robots hang off it.
  const poseRateHz = META.poseRateHz;
  const poseKeys = Object.keys(META.poseStreams);
  let poseCount = 0;
  const poses = { rateHz: poseRateHz };
  for (const robot of poseKeys) {
    const set = META.poseStreams[robot];
    const cols = {};
    for (const field of ['xM', 'yM', 'yawDeg', 'gimbalYawDeg']) {
      const key = set[field];
      if (typeof key !== 'string') {
        throw new BattleDecodeError('BAD_MODULE', `poseStreams.${robot} is missing "${field}"`);
      }
      const values = stream(key, `poseStreams.${robot}.${field}`);
      if (!poseCount) poseCount = values.length;
      cols[field] = toF32(values, poseCount, key);
    }
    poses[robot] = cols;
  }
  poses.t = gridOf(t0, poseRateHz, poseCount);

  // ---- organizer-view HP for all four robots. HUD only: no Blue 1 channel carries enemy state.
  const hpMeta = META.hpTimeline;
  const hp = { rateHz: hpMeta.rateHz, t: gridOf(hpMeta.tStartS, hpMeta.rateHz, hpMeta.sampleCount) };
  for (const robot of Object.keys(hpMeta.streams)) {
    hp[robot] = toF32(
      stream(hpMeta.streams[robot], `hpTimeline.${robot}`),
      hpMeta.sampleCount,
      hpMeta.streams[robot],
    );
  }

  // ---- channels. Every channel has ONE time axis and ONE block rate, per the cadence contract:
  // slower native sources are zero-order held onto the grid and say so in their rate note.
  const channels = {};
  for (const path of Object.keys(META.channels)) {
    const spec = META.channels[path];
    const block = {
      rateHz: spec.rateHz,
      t: gridOf(spec.tStartS, spec.rateHz, spec.sampleCount),
      fields: {},
      units: {},
      unitGroups: {},
      provenance: {},
    };
    for (const name of Object.keys(spec.fields)) {
      const f = spec.fields[name];
      block.fields[name] = toF32(stream(f.stream, `${path}.${name}`), spec.sampleCount, f.stream);
      block.units[name] = f.unit;
      block.unitGroups[name] = f.unitGroup;
      block.provenance[name] = { origin: f.origin, transform: f.transform };
    }
    if (spec.rateNote) block.rateNote = spec.rateNote;
    channels[path] = block;
  }

  const out = {
    formatVersion: mod.FORMAT_VERSION,
    variant: mod.VARIANT,
    datasetHash: mod.DATASET_HASH,
    durationS,
    window: { t0, t1 },
    // The referee stage clock counts DOWN from the round length, so it is 180 minus replay time.
    stageRemainTime: (t) => Math.max(0, Math.min(durationS, durationS - t)),

    meta: META,

    poses,
    hp,
    channels,
    events: META.events,
  };

  // The four match-only reference sections. A preview genuinely does not carry them, so they are
  // absent rather than empty, and every consumer branches on presence instead of on VARIANT.
  if (META.incident) out.incident = META.incident;
  if (META.claimLedger) out.claimLedger = META.claimLedger;
  if (META.engineScope) out.engineScope = META.engineScope;
  if (META.rules) out.rules = META.rules;

  return out;
}

// ------------------------------------------------------------------ sampling helpers

/**
 * Nearest sample index on a uniform grid. Every axis in this payload is uniform by construction
 * (`tStartS + n / rateHz`), so this is arithmetic and not a search.
 */
export function indexAtUniform(tStartS, rateHz, count, t) {
  const i = Math.round((t - tStartS) * rateHz);
  return i < 0 ? 0 : i >= count ? count - 1 : i;
}

/** Nearest sample of one decoded channel field at time t. */
export function sampleChannel(block, field, t) {
  const i = indexAtUniform(block.t[0], block.rateHz, block.t.length, t);
  return block.fields[field][i];
}

/**
 * Linear interpolation on a uniform grid. Used by the scene for pose playback; charts read raw
 * samples. There are no presence gaps in this payload, so there is no gap rule to honour.
 */
export function lerpUniform(values, tStartS, rateHz, t) {
  const x = (t - tStartS) * rateHz;
  if (!(x > 0)) return values[0];
  const n = values.length;
  if (x >= n - 1) return values[n - 1];
  const i = Math.floor(x);
  const u = x - i;
  return values[i] + (values[i + 1] - values[i]) * u;
}
