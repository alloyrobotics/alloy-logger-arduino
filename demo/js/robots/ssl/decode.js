// ssl/decode.js - byte decoder for the exported SSL match modules.
//
// The wire format and the decoded MatchData shape are specified in the private exporter repo
// (reels/_scratch/ssl-mujoco/src/FORMAT.md, format version 1). This file is the ONLY place that
// knows about bytes; everything downstream sees typed arrays.
//
// Why this lives outside match-data.js: an ES module that throws while evaluating is cached as
// FAILED by specifier for the life of the document and can never be retried. match-data.js
// therefore exports nothing but strings, numbers and plain literals, and all decoding happens
// here, inside a function data.js can call again after a failure.
//
// Nothing in this module has side effects at import time.

export const SUPPORTED_FORMAT_VERSION = 1;

// ------------------------------------------------------------------ primitives

/** base64 -> bytes. atob everywhere modern; Buffer is the Node-without-atob fallback. */
function b64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* c8 ignore next 2 */
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  throw new Error('ssl/decode: no base64 decoder available');
}

/** zigzag-16 -> signed. u = (v << 1) ^ (v >> 15). */
function unzig(u) {
  return (u >>> 1) ^ -(u & 1);
}

/**
 * Read one section's raw integers. Branch on `enc`, NEVER on `len`: u32 and u32p occupy the same
 * 4n bytes and are distinguishable only by the declared encoding.
 */
function readSection(bytes, sec, kind) {
  const { off, len, enc } = sec;
  if (off + len > bytes.length) throw new Error(`ssl/decode: section ${kind} runs past the blob`);
  if (enc === 'i16' || enc === 'i16p') {
    const n = len >> 1;
    const out = new Int32Array(n);
    if (enc === 'i16') {
      for (let k = 0; k < n; k++) out[k] = unzig(bytes[off + 2 * k] | (bytes[off + 2 * k + 1] << 8));
    } else {
      const hi = off + n;
      for (let k = 0; k < n; k++) out[k] = unzig(bytes[off + k] | (bytes[hi + k] << 8));
    }
    return out;
  }
  if (enc === 'u32' || enc === 'u32p') {
    const n = len >> 2;
    const out = new Float64Array(n); // u32 deltas prefix-sum past 2^32; Float64 is exact to 2^53
    if (enc === 'u32') {
      for (let k = 0; k < n; k++) {
        const o = off + 4 * k;
        out[k] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
      }
    } else {
      const p1 = off + n;
      const p2 = off + 2 * n;
      const p3 = off + 3 * n;
      for (let k = 0; k < n; k++) {
        out[k] = (bytes[off + k] | (bytes[p1 + k] << 8) | (bytes[p2 + k] << 16) | (bytes[p3 + k] << 24)) >>> 0;
      }
    }
    return out;
  }
  if (enc === 'u8') {
    const out = new Int32Array(len);
    for (let k = 0; k < len; k++) out[k] = bytes[off + k];
    return out;
  }
  if (enc === 'bits') {
    return bytes.subarray(off, off + len);
  }
  throw new Error(`ssl/decode: unknown encoding "${enc}" for section ${kind}`);
}

/** Bitmask -> Uint8Array(n) of 0/1. Sample k is bit (k & 7) of byte (k >> 3), LSB first. */
function unpackBits(raw, n, byteOffset = 0) {
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = (raw[byteOffset + (k >> 3)] >> (k & 7)) & 1;
  return out;
}

/** Presence runs [[startIndex, length], ...] from a 0/1 mask. */
function runsOf(present) {
  const runs = [];
  let i = 0;
  while (i < present.length) {
    if (!present[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < present.length && present[i]) i++;
    runs.push([start, i - start]);
  }
  return runs;
}

/**
 * Scatter one delta-encoded column into a full-grid Float32Array.
 *
 * Delta encoding is per presence RUN, never across one: the first sample of each run is absolute,
 * the rest are first differences. That is what keeps an unwrapped yaw inside int16 over 110 s, and
 * what makes it structurally impossible to smear a value across a tracking gap.
 *
 * Absent samples are hold-filled (last present value) purely so downstream code never reads a
 * NaN - callers MUST check `present` before rendering a sample as motion.
 */
function expandRuns(col, colOffset, runs, nGrid, scale) {
  const out = new Float32Array(nGrid);
  let c = colOffset;
  for (const [start, len] of runs) {
    let acc = 0;
    for (let j = 0; j < len; j++) {
      acc = j === 0 ? col[c] : acc + col[c];
      out[start + j] = acc * scale;
      c++;
    }
  }
  holdFill(out, runs, nGrid);
  return out;
}

/** Absolute (non-delta) column, e.g. u8 visibility. */
function expandAbsolute(col, colOffset, runs, nGrid, scale) {
  const out = new Float32Array(nGrid);
  let c = colOffset;
  for (const [start, len] of runs) {
    for (let j = 0; j < len; j++) out[start + j] = col[c++] * scale;
  }
  holdFill(out, runs, nGrid);
  return out;
}

function holdFill(out, runs, nGrid) {
  if (!runs.length) return;
  const first = runs[0][0];
  for (let i = 0; i < first; i++) out[i] = out[first];
  for (let r = 0; r < runs.length; r++) {
    const end = runs[r][0] + runs[r][1];
    const nextStart = r + 1 < runs.length ? runs[r + 1][0] : nGrid;
    const held = out[end - 1];
    for (let i = end; i < nextStart; i++) out[i] = held;
  }
}

/** Constant-filled column, for optional sections the export omitted. */
function constantColumn(n, value) {
  const out = new Float32Array(n);
  if (value !== 0) out.fill(value);
  return out;
}

/**
 * Finite-difference derivative inside each presence run, one-sided at run endpoints.
 * Used only when the producer had no velocity field; provenance becomes DERIVED_FINITE_DIFFERENCE.
 */
function finiteDifference(values, times, runs, nGrid) {
  const out = new Float32Array(nGrid);
  for (const [start, len] of runs) {
    for (let j = 0; j < len; j++) {
      const i = start + j;
      const a = j === 0 ? i : i - 1;
      const b = j === len - 1 ? i : i + 1;
      const dt = times[b] - times[a];
      out[i] = dt > 1e-9 ? (values[b] - values[a]) / dt : 0;
    }
  }
  holdFill(out, runs, nGrid);
  return out;
}

// ------------------------------------------------------------------ the decoder

/**
 * Decode one generated module (match-data.js or preview-data.js) into MatchData.
 *
 * @param {{DATASET_HASH:string, FORMAT_VERSION:number, VARIANT:string, META:object, BLOB_B64:string}} mod
 * @returns {object} MatchData, per FORMAT.md section 3
 */
export function decodeMatchData(mod) {
  const META = mod && mod.META;
  if (!META || !META.sections || !META.grid) throw new Error('ssl/decode: module is missing META');
  if (mod.FORMAT_VERSION !== SUPPORTED_FORMAT_VERSION) {
    throw new Error(`ssl/decode: unsupported format version ${mod.FORMAT_VERSION}`);
  }

  const bytes = b64ToBytes(mod.BLOB_B64);
  const S = META.sections;
  const q = META.quant;
  const has = META.has || {};
  const nBall = META.grid.nBall;
  const nRobot = META.grid.nRobot;
  const stride = META.grid.robotStrideOverBall;

  const sec = (key) => {
    const s = S[key];
    if (!s) throw new Error(`ssl/decode: required section "${key}" is absent`);
    return s;
  };
  const optional = (key) => (S[key] ? readSection(bytes, S[key], key) : null);

  // ---- time axes. grid.t is a single delta-encoded segment, no runs.
  const tRaw = readSection(bytes, sec('grid.t'), 'grid.t');
  if (tRaw.length !== nBall) throw new Error('ssl/decode: grid.t length disagrees with grid.nBall');
  const tBall = new Float64Array(nBall);
  let acc = 0;
  for (let i = 0; i < nBall; i++) {
    acc = i === 0 ? tRaw[0] : acc + tRaw[i];
    tBall[i] = acc * q.timeScale;
  }
  const tRobot = new Float64Array(nRobot);
  for (let i = 0; i < nRobot; i++) tRobot[i] = tBall[i * stride];

  // ---- robots. Columns are every robot's PRESENT samples concatenated, in META.robots order.
  const robPresRaw = readSection(bytes, sec('rob.pres'), 'rob.pres');
  const robBytesEach = Math.ceil(nRobot / 8);
  const cols = {
    x: readSection(bytes, sec('rob.x'), 'rob.x'),
    y: readSection(bytes, sec('rob.y'), 'rob.y'),
    yaw: readSection(bytes, sec('rob.yaw'), 'rob.yaw'),
    vx: optional('rob.vx'),
    vy: optional('rob.vy'),
    w: optional('rob.w'),
    vis: optional('rob.vis'),
  };

  const teams = META.teams;
  const robots = [];
  let colOff = 0;
  META.robots.forEach((meta, i) => {
    const present = unpackBits(robPresRaw, nRobot, i * robBytesEach);
    const runs = runsOf(present);
    let nPresent = 0;
    for (const [, len] of runs) nPresent += len;
    if (meta.nPresent != null && meta.nPresent !== nPresent) {
      throw new Error(`ssl/decode: robot ${meta.refereeColor}${meta.id} presence popcount disagrees with META`);
    }
    const x = expandRuns(cols.x, colOff, runs, nRobot, q.posScale);
    const y = expandRuns(cols.y, colOff, runs, nRobot, q.posScale);
    const yaw = expandRuns(cols.yaw, colOff, runs, nRobot, q.yawScale);
    const vx = cols.vx
      ? expandRuns(cols.vx, colOff, runs, nRobot, q.velScale)
      : finiteDifference(x, tRobot, runs, nRobot);
    const vy = cols.vy
      ? expandRuns(cols.vy, colOff, runs, nRobot, q.velScale)
      : finiteDifference(y, tRobot, runs, nRobot);
    const w = cols.w
      ? expandRuns(cols.w, colOff, runs, nRobot, q.angVelScale)
      : finiteDifference(yaw, tRobot, runs, nRobot);
    const vis = cols.vis
      ? expandAbsolute(cols.vis, colOff, runs, nRobot, 1 / 255)
      : constantColumn(nRobot, 1);

    const letter = meta.refereeColor === 'yellow' ? 'y' : 'b';
    robots.push({
      refereeColor: meta.refereeColor,
      id: meta.id,
      // Shared naming with scene.js: highlight keys and scene part ids are `bot_<colorLetter><id>`.
      key: `bot_${letter}${meta.id}`,
      name: `${meta.refereeColor}${meta.id}`,
      team: teams ? teams[meta.refereeColor] : null,
      present,
      runs,
      x,
      y,
      yaw,
      vx,
      vy,
      w,
      vis,
      nPresent,
      presentFrac: nPresent / nRobot,
    });
    colOff += nPresent;
  });

  // ---- ball
  const ballPresRaw = readSection(bytes, sec('ball.pres'), 'ball.pres');
  const ballPresent = unpackBits(ballPresRaw, nBall, 0);
  const ballRuns = runsOf(ballPresent);
  const ballX = expandRuns(readSection(bytes, sec('ball.x'), 'ball.x'), 0, ballRuns, nBall, q.posScale);
  const ballY = expandRuns(readSection(bytes, sec('ball.y'), 'ball.y'), 0, ballRuns, nBall, q.posScale);
  const bz = optional('ball.z');
  const ballZ = bz ? expandRuns(bz, 0, ballRuns, nBall, q.posScale) : constantColumn(nBall, 0);
  const bvx = optional('ball.vx');
  const bvy = optional('ball.vy');
  const bvz = optional('ball.vz');
  const bvis = optional('ball.vis');
  const ball = {
    present: ballPresent,
    segments: ballRuns.map(([i0, n]) => ({ i0, n })),
    x: ballX,
    y: ballY,
    z: ballZ,
    vx: bvx ? expandRuns(bvx, 0, ballRuns, nBall, q.velScale) : finiteDifference(ballX, tBall, ballRuns, nBall),
    vy: bvy ? expandRuns(bvy, 0, ballRuns, nBall, q.velScale) : finiteDifference(ballY, tBall, ballRuns, nBall),
    vz: bvz ? expandRuns(bvz, 0, ballRuns, nBall, q.velScale) : finiteDifference(ballZ, tBall, ballRuns, nBall),
    vis: bvis ? expandAbsolute(bvis, 0, ballRuns, nBall, 1 / 255) : constantColumn(nBall, 1),
  };

  // ---- camera focus track. Absent -> the decoded ball track, hold-filled, on the robot grid.
  let focusX;
  let focusY;
  if (has.cameraFocus !== false && S['focus.x'] && S['focus.y']) {
    const oneRun = [[0, nRobot]];
    focusX = expandRuns(readSection(bytes, S['focus.x'], 'focus.x'), 0, oneRun, nRobot, q.posScale);
    focusY = expandRuns(readSection(bytes, S['focus.y'], 'focus.y'), 0, oneRun, nRobot, q.posScale);
  } else {
    focusX = new Float32Array(nRobot);
    focusY = new Float32Array(nRobot);
    for (let i = 0; i < nRobot; i++) {
      focusX[i] = ball.x[i * stride];
      focusY[i] = ball.y[i * stride];
    }
  }

  return {
    formatVersion: mod.FORMAT_VERSION,
    variant: mod.VARIANT,
    datasetHash: mod.DATASET_HASH,

    tBall,
    tRobot,
    durationS: META.grid.durationS,
    grid: META.grid,

    robots,
    ball,
    focus: {
      x: focusX,
      y: focusY,
      windowSamples: META.focus ? META.focus.windowSamples : 0,
      windowSeconds: META.focus ? META.focus.windowSeconds : 0,
    },

    // verbatim from META
    teams: META.teams,
    identity: META.identity,
    geometry: META.geometry,
    quant: META.quant,
    source: META.source,
    capabilities: META.capabilities,
    provenance: META.provenance,
    interpolation: META.interpolation,
    absences: META.absences,
    absenceClasses: META.absenceClasses,
    absenceTally: META.absenceTally,
    gcStateChanges: META.gcStateChanges,
    referee: META.referee,
    kicks: META.kicks,
    visibilityDips: META.visibilityDips,
    visionCrossCheck: META.visionCrossCheck,
    match: META.match,
    has: META.has,
    shortGapSeconds: META.shortGapSeconds,
  };
}

// ------------------------------------------------------------------ interpolation contract

/**
 * The SOLE interpolation for robots and the ball (FORMAT.md section 4). Cubic Hermite with the
 * exported tracker velocities as derivatives, overshoot-clamped.
 *
 * Never crosses a presence gap or a ball-segment boundary: if either endpoint is absent, the
 * caller gets the held sample and `ok:false`, and must render ghost/hold instead of motion.
 *
 * Degenerate intervals (FORMAT.md 4.2) SNAP TO THE LATER sample, and say so with `snapLater`.
 * The producer emits the occasional back-to-back pair (this window's ball track has one 16.7 us
 * pair) where `(p1 - p0) / dt` is meaningless but both samples are good positions, so holding the
 * earlier one replays the older of two simultaneous fixes. The presence rule is checked FIRST: a
 * degenerate gap is not a licence to cross an absent endpoint.
 *
 * @param {Float64Array} times grid times
 * @param {Uint8Array} present grid presence mask
 * @param {number} t query time
 * @returns {{j:number, s:number, dt:number, ok:boolean, snapLater:boolean}} interval, normalized
 *   position, whether interpolation is legal, and whether a `!ok` caller reads `j + 1` not `j`
 */
export function locate(times, present, t) {
  const n = times.length;
  let lo = 0;
  let hi = n - 1;
  if (t <= times[0]) return { j: 0, s: 0, dt: 0, ok: false, snapLater: false };
  if (t >= times[n - 1]) return { j: n - 1, s: 0, dt: 0, ok: false, snapLater: false };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const dt = times[lo + 1] - times[lo];
  const both = !!(present[lo] && present[lo + 1]);
  const degenerate = dt < 1e-4;
  return {
    j: lo,
    s: dt > 0 ? (t - times[lo]) / dt : 0,
    dt,
    ok: both && !degenerate,
    snapLater: both && degenerate,
  };
}

/** Cubic Hermite with the overshoot clamp of FORMAT.md 4.3-4.4. */
export function hermite(p0, v0, p1, v1, s, dt) {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  let p = h00 * p0 + h10 * dt * v0 + h01 * p1 + h11 * dt * v1;
  const m = 0.5 * dt * Math.max(Math.abs(v0), Math.abs(v1));
  const lo = Math.min(p0, p1) - m;
  const hi = Math.max(p0, p1) + m;
  if (p < lo) p = lo;
  else if (p > hi) p = hi;
  return p;
}

/**
 * Sample one (value, derivative) column pair at time t under the interpolation contract.
 * Yaw is exported CONTINUOUS/unwrapped: pass yaw/w straight in and do NOT apply shortest-arc.
 */
export function sampleSeries(times, present, values, derivs, t) {
  const { j, s, dt, ok, snapLater } = locate(times, present, t);
  if (!ok) return values[snapLater ? j + 1 : j];
  return hermite(values[j], derivs[j], values[j + 1], derivs[j + 1], s, dt);
}
