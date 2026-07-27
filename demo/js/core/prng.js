// prng.js - deterministic random helpers. Math.random() is banned in data generators.
// Every generator in this demo draws from mulberry32 so two page loads produce identical data.

/**
 * Stable per-robot seed so two page loads produce identical data. Lives here (not app.js)
 * because worker/build-facts.mjs must use the exact same seed to describe the same noise the
 * page draws, and app.js is DOM-heavy and cannot be imported by Node.
 * @param {string} id robot id
 */
export function seedFor(id) {
  let h = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h ^ id.charCodeAt(i), 0x85ebca6b) >>> 0) + 1;
  return h >>> 0;
}

/**
 * mulberry32 - fast, seeded 32-bit PRNG.
 * @param {number} seed integer seed
 * @returns {() => number} function returning a float in [0,1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller normal deviate drawn from a mulberry32 stream.
 * @param {() => number} rnd
 * @param {number} [mean=0]
 * @param {number} [sd=1]
 */
export function gaussian(rnd, mean = 0, sd = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 1D value noise with smoothstep interpolation over a seeded lattice.
 * @param {() => number} rnd source of lattice values
 * @param {number} [size=256] lattice size (wraps)
 * @returns {(x:number) => number} sampler returning a value in [0,1)
 */
export function valueNoise1D(rnd, size = 256) {
  const lattice = new Float64Array(size);
  for (let i = 0; i < size; i++) lattice[i] = rnd();
  return function sample(x) {
    const xi = Math.floor(x);
    const f = x - xi;
    const a = lattice[((xi % size) + size) % size];
    const b = lattice[(((xi + 1) % size) + size) % size];
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  };
}

/**
 * Sum of octaves of valueNoise1D. Returns a sampler in roughly [0,1).
 * @param {() => number} rnd
 * @param {number} [octaves=4]
 * @param {number} [persistence=0.5]
 */
export function fbm1D(rnd, octaves = 4, persistence = 0.5) {
  const layers = [];
  for (let i = 0; i < octaves; i++) layers.push(valueNoise1D(rnd, 256));
  return function sample(x) {
    let total = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < layers.length; i++) {
      total += layers[i](x * freq) * amp;
      norm += amp;
      amp *= persistence;
      freq *= 2;
    }
    return total / norm;
  };
}

/** Linear interpolate. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Clamp v into [min,max]. */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Hermite smoothstep of t in [0,1]. */
export function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Map v from [a0,a1] to [b0,b1] without clamping. */
export function remap(v, a0, a1, b0, b1) {
  if (a1 === a0) return b0;
  return b0 + ((v - a0) / (a1 - a0)) * (b1 - b0);
}

/**
 * Sample a Float64Array channel at an arbitrary time, linearly interpolated.
 * @param {Float64Array} t monotonic time array
 * @param {Float64Array} v value array, same length
 * @param {number} at time in seconds
 */
export function sampleAt(t, v, at) {
  const n = t.length;
  if (n === 0) return 0;
  if (at <= t[0]) return v[0];
  if (at >= t[n - 1]) return v[n - 1];
  // channels are uniformly sampled; estimate then correct
  let i = Math.floor(((at - t[0]) / (t[n - 1] - t[0])) * (n - 1));
  i = clamp(i, 0, n - 2);
  while (i > 0 && t[i] > at) i--;
  while (i < n - 2 && t[i + 1] < at) i++;
  const span = t[i + 1] - t[i];
  const f = span === 0 ? 0 : (at - t[i]) / span;
  return v[i] + (v[i + 1] - v[i]) * f;
}

/** Index of the sample at or just before `at`. */
export function indexAt(t, at) {
  const n = t.length;
  if (n === 0) return 0;
  if (at <= t[0]) return 0;
  if (at >= t[n - 1]) return n - 1;
  let i = Math.floor(((at - t[0]) / (t[n - 1] - t[0])) * (n - 1));
  i = clamp(i, 0, n - 1);
  while (i > 0 && t[i] > at) i--;
  while (i < n - 1 && t[i + 1] <= at) i++;
  return i;
}
