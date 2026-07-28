// gendata.js - the deterministic telemetry interpreter for GENSPEC v1 `data_spec`.
//
// Pure isomorphic ES module: nothing from `node:` is imported, nothing touches the DOM, so the
// browser, the validator and the facts builder all run the SAME arithmetic. Every helper it
// needs (mulberry32, gaussian, fbm1D, clamp, smoothstep, sampleAt) already lives in
// `./prng.js` and is imported from there rather than re-implemented, because a second copy of
// mulberry32 is a second set of numbers waiting to drift.
//
// This file is byte-for-byte the interpreter the generator runner evaluates specs with. It is a
// PUBLISHED API: every emailed demo link renders through it forever, so changes are additive
// only and `spec_version` gates anything breaking.
//
// Contract (GENSPEC section 3):
//   buildDataFromSpec(def) -> { "<path>": { t: Float64Array, "<key>": Float64Array, ... }, ... }
//
// Evaluation order per field, no exceptions: base segments -> couplings -> events ->
// noise -> clamp. Every field draws from its OWN PRNG stream,
// mulberry32(hash(seed, "<path>.<key>")), so adding a field never shifts another
// field's numbers.
//
// Determinism rules:
//   - Math.random() is never called. Anywhere. The validator asserts this.
//   - Couplings consume the source field's FINAL array (post clamp), which is why the
//     coupling graph has to be acyclic: fields are built in topological order.
//   - Two builds of the same def are bit-identical.

import { mulberry32, gaussian, fbm1D, clamp as clampTo, smoothstep, sampleAt } from './prng.js';

/** Every hard bound GENSPEC states, in one place so validate.mjs can quote them. */
export const LIMITS = {
  durationMin: 15,
  durationMax: 180,
  rateMin: 10,
  rateMax: 100,
  channelRateMin: 1,
  channelRateMax: 100,
  seedMin: 1,
  seedMax: 2147483647,
  absMax: 1e6,
  freqMax: 30,
  samplesMin: 500,
  samplesMax: 60000,
  segMin: 1,
  segMax: 12,
  coupleMax: 2,
  eventMax: 8,
  octavesMin: 1,
  octavesMax: 6,
  /** t[last] must land within this fraction of `duration`. */
  durationTolerance: 0.02,
};

const SEGMENT_KINDS = new Set(['ramp', 'hold', 'sine', 'decay']);
const EVENT_KINDS = new Set(['spike', 'step', 'dropout', 'burst']);
const COUPLE_KINDS = new Set(['lag1', 'scale']);
const NOISE_KINDS = new Set(['fbm', 'gauss']);

// ---------------------------------------------------------------------------
// stable hashing
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32 bit, over the UTF-16 code units masked to a byte. Chosen because it is
 * four lines, has no lookup table, and produces identical output in the browser, the
 * validator and the facts builder without any shared binary. All def display strings
 * and field paths are printable ASCII, so the `& 0xff` mask is lossless here.
 *
 * @param {string} str
 * @returns {number} uint32
 */
export function hashString(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ (str.charCodeAt(i) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The documented stable hash GENSPEC section 3 refers to as `hash(seed, "<path>.<key>")`.
 * The pre-image is `"<seed>:<name>"`, seed rendered as an unsigned decimal integer.
 *
 * @param {number} seed integer 1..2147483647
 * @param {string} name usually "<path>.<key>"
 * @returns {number} uint32
 */
export function hash(seed, name) {
  return hashString(`${seed >>> 0}:${name}`);
}

/** Seed of one field's PRNG stream. @param {number} seed @param {string} fieldPath */
export function streamSeed(seed, fieldPath) {
  return hash(seed, fieldPath);
}

/** The field's PRNG stream itself. @param {number} seed @param {string} fieldPath */
export function streamFor(seed, fieldPath) {
  return mulberry32(streamSeed(seed, fieldPath));
}

// ---------------------------------------------------------------------------
// bound checking (throws with a precise JSON path)
// ---------------------------------------------------------------------------

class SpecError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'SpecError';
    this.specPath = path;
  }
}

function fail(path, message) {
  throw new SpecError(path, message);
}

function num(path, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected a finite number, got ${JSON.stringify(v)}`);
  if (Math.abs(v) > LIMITS.absMax) fail(path, `absolute value exceeds ${LIMITS.absMax}`);
  return v;
}

function positive(path, v) {
  num(path, v);
  if (!(v > 0)) fail(path, 'must be greater than 0');
  return v;
}

function freq(path, v) {
  positive(path, v);
  if (v > LIMITS.freqMax) fail(path, `must be <= ${LIMITS.freqMax} Hz`);
  return v;
}

// ---------------------------------------------------------------------------
// field enumeration
// ---------------------------------------------------------------------------

/**
 * Declared "<path>.<key>" strings, in channel then field order.
 * @param {object} def
 * @returns {string[]}
 */
export function fieldPathsOf(def) {
  const out = [];
  for (const ch of def?.channels || []) {
    for (const f of ch?.fields || []) out.push(`${ch.path}.${f.key}`);
  }
  return out;
}

/**
 * path -> { rate, keys[] }
 * @param {object} def
 */
export function channelIndex(def) {
  const map = new Map();
  for (const ch of def?.channels || []) {
    map.set(ch.path, {
      rate: typeof ch.rate === 'number' ? ch.rate : def.rate,
      keys: (ch.fields || []).map((f) => f.key),
    });
  }
  return map;
}

/**
 * Topologically order the declared fields so every coupling source is built first.
 * Throws on a cycle or an unknown source, because the interpreter cannot proceed.
 *
 * @param {object} def
 * @returns {string[]} field paths in build order
 */
export function couplingOrder(def) {
  const declared = new Set(fieldPathsOf(def));
  const spec = def.data_spec || {};
  const state = new Map(); // 0 unvisited, 1 in-progress, 2 done
  const order = [];

  const visit = (fp, stack) => {
    const s = state.get(fp) || 0;
    if (s === 2) return;
    if (s === 1) fail(`data_spec["${fp}"].couple`, `coupling cycle: ${[...stack, fp].join(' -> ')}`);
    state.set(fp, 1);
    for (const c of spec[fp]?.couple || []) {
      const from = c?.from;
      if (!declared.has(from)) {
        fail(`data_spec["${fp}"].couple.from`, `"${from}" is not a declared channel field`);
      }
      visit(from, [...stack, fp]);
    }
    state.set(fp, 2);
    order.push(fp);
  };

  for (const fp of declared) visit(fp, []);
  return order;
}

// ---------------------------------------------------------------------------
// segment / event evaluation
// ---------------------------------------------------------------------------

function assertSegment(path, s, duration) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail(path, 'segment must be an object');
  if (!SEGMENT_KINDS.has(s.kind)) fail(`${path}.kind`, `unknown segment kind ${JSON.stringify(s.kind)}`);
  num(`${path}.t0`, s.t0);
  num(`${path}.t1`, s.t1);
  if (!(s.t1 > s.t0)) fail(`${path}.t1`, 't1 must be greater than t0');
  if (s.t0 < 0 || s.t1 > duration + 1e-9) fail(path, `segment [${s.t0},${s.t1}] lies outside [0,${duration}]`);
  if (s.kind === 'hold') num(`${path}.value`, s.value);
  if (s.kind === 'ramp') {
    num(`${path}.from`, s.from);
    num(`${path}.to`, s.to);
    if (s.ease != null && s.ease !== 'linear' && s.ease !== 'smooth') {
      fail(`${path}.ease`, 'ease must be "linear" or "smooth"');
    }
  }
  if (s.kind === 'sine') {
    num(`${path}.mean`, s.mean);
    num(`${path}.amp`, s.amp);
    freq(`${path}.freq`, s.freq);
    if (s.phase != null) num(`${path}.phase`, s.phase);
  }
  if (s.kind === 'decay') {
    num(`${path}.from`, s.from);
    num(`${path}.to`, s.to);
    positive(`${path}.tau`, s.tau);
  }
}

function evalSegment(s, t) {
  switch (s.kind) {
    case 'hold':
      return s.value;
    case 'ramp': {
      const span = s.t1 - s.t0;
      const u = span > 0 ? clampTo((t - s.t0) / span, 0, 1) : 1;
      const e = s.ease === 'smooth' ? smoothstep(u) : u;
      return s.from + (s.to - s.from) * e;
    }
    case 'sine':
      return s.mean + s.amp * Math.sin(2 * Math.PI * s.freq * (t - s.t0) + (s.phase || 0));
    case 'decay':
      return s.to + (s.from - s.to) * Math.exp(-(t - s.t0) / s.tau);
    default:
      return 0;
  }
}

function assertEvent(path, e, duration) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) fail(path, 'event must be an object');
  if (!EVENT_KINDS.has(e.kind)) fail(`${path}.kind`, `unknown event kind ${JSON.stringify(e.kind)}`);
  num(`${path}.t`, e.t);
  if (e.t < 0 || e.t > duration) fail(`${path}.t`, `event time ${e.t} lies outside [0,${duration}]`);
  if (e.kind === 'spike') {
    num(`${path}.amp`, e.amp);
    positive(`${path}.width`, e.width);
  }
  if (e.kind === 'step') num(`${path}.to`, e.to);
  if (e.kind === 'dropout') positive(`${path}.width`, e.width);
  if (e.kind === 'burst') {
    num(`${path}.amp`, e.amp);
    freq(`${path}.freq`, e.freq);
    positive(`${path}.width`, e.width);
  }
}

/**
 * Apply one event in place.
 *
 * spike   gaussian bump centred on t, sigma = width/2 (so `width` is roughly the
 *         visible full width of the bump).
 * step    forces the value to `to` from t until the NEXT event of any kind, or the
 *         end of the mission if this is the last one. GENSPEC: "holds until next
 *         event/end".
 * dropout freezes the last value sampled strictly before t, for `width` seconds.
 *         Never produces NaN because the frozen value is read before any write.
 * burst   decaying oscillation over [t, t+width), decay constant width/3 so it is
 *         about 95 percent gone by the end of the window.
 */
function applyEvent(v, t, e, nextT) {
  const n = v.length;
  switch (e.kind) {
    case 'spike': {
      const sigma = e.width / 2;
      for (let i = 0; i < n; i++) {
        const d = (t[i] - e.t) / sigma;
        if (d < -6 || d > 6) continue;
        v[i] += e.amp * Math.exp(-0.5 * d * d);
      }
      return;
    }
    case 'step': {
      for (let i = 0; i < n; i++) {
        if (t[i] >= e.t && t[i] < nextT) v[i] = e.to;
      }
      return;
    }
    case 'dropout': {
      let frozen = v[0];
      for (let i = 0; i < n; i++) {
        if (t[i] < e.t) frozen = v[i];
        else break;
      }
      const end = e.t + e.width;
      for (let i = 0; i < n; i++) {
        if (t[i] >= e.t && t[i] < end) v[i] = frozen;
      }
      return;
    }
    case 'burst': {
      const tau = e.width / 3;
      const end = e.t + e.width;
      for (let i = 0; i < n; i++) {
        if (t[i] < e.t || t[i] >= end) continue;
        const d = t[i] - e.t;
        v[i] += e.amp * Math.exp(-d / tau) * Math.sin(2 * Math.PI * e.freq * d);
      }
      return;
    }
    default:
      return;
  }
}

function assertCouple(path, c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail(path, 'coupling must be an object');
  if (!COUPLE_KINDS.has(c.kind)) fail(`${path}.kind`, `unknown coupling kind ${JSON.stringify(c.kind)}`);
  if (typeof c.from !== 'string') fail(`${path}.from`, 'from must be a "<path>.<key>" string');
  num(`${path}.gain`, c.gain);
  if (c.kind === 'lag1') positive(`${path}.tau`, c.tau);
}

function assertNoise(path, nz) {
  if (nz == null) return;
  if (typeof nz !== 'object' || Array.isArray(nz)) fail(path, 'noise must be an object or null');
  if (!NOISE_KINDS.has(nz.kind)) fail(`${path}.kind`, `unknown noise kind ${JSON.stringify(nz.kind)}`);
  if (nz.kind === 'fbm') {
    if (!Number.isInteger(nz.octaves) || nz.octaves < LIMITS.octavesMin || nz.octaves > LIMITS.octavesMax) {
      fail(`${path}.octaves`, `octaves must be an integer in [${LIMITS.octavesMin},${LIMITS.octavesMax}]`);
    }
    positive(`${path}.amp`, nz.amp);
    freq(`${path}.hz`, nz.hz);
  }
  if (nz.kind === 'gauss') positive(`${path}.sd`, nz.sd);
}

// ---------------------------------------------------------------------------
// the interpreter
// ---------------------------------------------------------------------------

/**
 * Evaluate a whole def's `data_spec` into channel arrays.
 *
 * @param {object} def a GENSPEC v1 def.json object
 * @returns {Record<string, {t: Float64Array} & Record<string, Float64Array>>}
 * @throws {Error} with a message of the form `<json path>: <what is wrong>`
 */
export function buildDataFromSpec(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) fail('$', 'def must be an object');

  const seed = def.seed;
  if (!Number.isInteger(seed) || seed < LIMITS.seedMin || seed > LIMITS.seedMax) {
    fail('seed', `seed must be an integer in [${LIMITS.seedMin},${LIMITS.seedMax}]`);
  }
  const duration = def.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < LIMITS.durationMin || duration > LIMITS.durationMax) {
    fail('duration', `duration must be a number in [${LIMITS.durationMin},${LIMITS.durationMax}] seconds`);
  }
  const baseRate = def.rate;
  if (typeof baseRate !== 'number' || !Number.isFinite(baseRate) || baseRate < LIMITS.rateMin || baseRate > LIMITS.rateMax) {
    fail('rate', `rate must be a number in [${LIMITS.rateMin},${LIMITS.rateMax}] Hz`);
  }

  const channels = channelIndex(def);
  if (channels.size === 0) fail('channels', 'at least one channel is required');

  // --- per channel time grids + the global sample budget ---
  const grids = new Map();
  let totalSamples = 0;
  for (const [path, ch] of channels) {
    const rate = ch.rate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < LIMITS.channelRateMin || rate > LIMITS.channelRateMax) {
      fail(`channels["${path}"].rate`, `rate must be a number in [${LIMITS.channelRateMin},${LIMITS.channelRateMax}] Hz`);
    }
    const n = Math.floor(duration * rate) + 1;
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i / rate;
    // GENSPEC: t monotonic from ~0 to within 2 percent of duration.
    const last = t[n - 1];
    if (Math.abs(last - duration) > duration * LIMITS.durationTolerance) {
      fail(`channels["${path}"].rate`, `time grid ends at ${last}s, more than ${LIMITS.durationTolerance * 100}% away from duration ${duration}s`);
    }
    grids.set(path, { t, n, dt: 1 / rate });
    totalSamples += n * ch.keys.length;
  }
  if (totalSamples < LIMITS.samplesMin || totalSamples > LIMITS.samplesMax) {
    fail('data_spec', `total samples ${totalSamples} is outside [${LIMITS.samplesMin},${LIMITS.samplesMax}]`);
  }

  const spec = def.data_spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('data_spec', 'data_spec must be an object');

  const declared = fieldPathsOf(def);
  for (const fp of declared) {
    if (!Object.prototype.hasOwnProperty.call(spec, fp)) {
      fail(`data_spec["${fp}"]`, 'missing entry for a declared channel field');
    }
  }

  const order = couplingOrder(def);
  /** field path -> { t, v } once built */
  const built = new Map();

  for (const fp of order) {
    const s = spec[fp];
    const jp = `data_spec["${fp}"]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail(jp, 'field spec must be an object');

    const chPath = fp.slice(0, fp.lastIndexOf('.'));
    const grid = grids.get(chPath);
    if (!grid) fail(jp, `no channel named "${chPath}"`);
    const { t, n, dt } = grid;
    const v = new Float64Array(n);

    // ---- 1. base segments ----
    const segs = s.base;
    if (!Array.isArray(segs) || segs.length < LIMITS.segMin || segs.length > LIMITS.segMax) {
      fail(`${jp}.base`, `base must be an array of ${LIMITS.segMin}..${LIMITS.segMax} segments`);
    }
    segs.forEach((seg, i) => assertSegment(`${jp}.base[${i}]`, seg, duration));
    if (Math.abs(segs[0].t0 - 0) > 1e-9) fail(`${jp}.base[0].t0`, 'first segment must start at t0 = 0');
    for (let i = 1; i < segs.length; i++) {
      if (Math.abs(segs[i].t0 - segs[i - 1].t1) > 1e-9) {
        fail(`${jp}.base[${i}].t0`, `segments must be contiguous: expected t0 = ${segs[i - 1].t1}, got ${segs[i].t0}`);
      }
    }
    if (Math.abs(segs[segs.length - 1].t1 - duration) > 1e-9) {
      fail(`${jp}.base[${segs.length - 1}].t1`, `last segment must end at duration = ${duration}`);
    }
    let si = 0;
    for (let i = 0; i < n; i++) {
      while (si < segs.length - 1 && t[i] >= segs[si].t1) si++;
      v[i] = evalSegment(segs[si], t[i]);
    }

    // ---- 2. couplings (source arrays are already final) ----
    const couples = s.couple || [];
    if (!Array.isArray(couples) || couples.length > LIMITS.coupleMax) {
      fail(`${jp}.couple`, `couple must be an array of 0..${LIMITS.coupleMax} entries`);
    }
    couples.forEach((c, i) => assertCouple(`${jp}.couple[${i}]`, c));
    for (const c of couples) {
      const src = built.get(c.from);
      if (!src) fail(`${jp}.couple.from`, `"${c.from}" was not built before this field`);
      const resampled = new Float64Array(n);
      for (let i = 0; i < n; i++) resampled[i] = sampleAt(src.t, src.v, t[i]);
      if (c.kind === 'scale') {
        for (let i = 0; i < n; i++) v[i] += c.gain * resampled[i];
      } else {
        // first-order lag, discretised on the TARGET field's own dt
        const a = Math.min(1, dt / c.tau);
        let y = resampled[0];
        for (let i = 0; i < n; i++) {
          y += a * (resampled[i] - y);
          v[i] += c.gain * y;
        }
      }
    }

    // ---- 3. events ----
    const events = s.events || [];
    if (!Array.isArray(events) || events.length > LIMITS.eventMax) {
      fail(`${jp}.events`, `events must be an array of 0..${LIMITS.eventMax} entries`);
    }
    events.forEach((e, i) => assertEvent(`${jp}.events[${i}]`, e, duration));
    const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i);
    for (let k = 0; k < sorted.length; k++) {
      const nextT = k + 1 < sorted.length ? sorted[k + 1].e.t : Infinity;
      applyEvent(v, t, sorted[k].e, nextT);
    }

    // ---- 4. noise ----
    const nz = s.noise === undefined ? null : s.noise;
    assertNoise(`${jp}.noise`, nz);
    if (nz) {
      const rnd = streamFor(seed, fp);
      if (nz.kind === 'fbm') {
        const sample = fbm1D(rnd, nz.octaves, 0.5);
        // fbm1D returns roughly [0,1); recentre to [-amp, +amp].
        for (let i = 0; i < n; i++) v[i] += (sample(t[i] * nz.hz) - 0.5) * 2 * nz.amp;
      } else {
        for (let i = 0; i < n; i++) v[i] += gaussian(rnd, 0, nz.sd);
      }
    }

    // ---- 5. clamp ----
    if (s.clamp != null) {
      if (!Array.isArray(s.clamp) || s.clamp.length !== 2) fail(`${jp}.clamp`, 'clamp must be [min,max]');
      num(`${jp}.clamp[0]`, s.clamp[0]);
      num(`${jp}.clamp[1]`, s.clamp[1]);
      if (!(s.clamp[1] > s.clamp[0])) fail(`${jp}.clamp`, 'clamp max must be greater than clamp min');
      for (let i = 0; i < n; i++) v[i] = clampTo(v[i], s.clamp[0], s.clamp[1]);
    }

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(v[i])) fail(jp, `produced a non-finite value at t = ${t[i]}s`);
    }

    built.set(fp, { t, v });
  }

  // Reject data_spec entries that do not correspond to a declared field. The
  // interpreter would silently ignore them, which is exactly the kind of drift the
  // published-API rule forbids.
  const declaredSet = new Set(declared);
  for (const k of Object.keys(spec)) {
    if (!declaredSet.has(k)) fail(`data_spec["${k}"]`, 'entry does not correspond to any declared channel field');
  }

  const out = {};
  for (const [path, ch] of channels) {
    const grid = grids.get(path);
    const bucket = { t: grid.t };
    for (const key of ch.keys) bucket[key] = built.get(`${path}.${key}`).v;
    out[path] = bucket;
  }
  return out;
}

export { SpecError };
