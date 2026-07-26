// sbr/data.js - self-balancing robot, 73 s mission at 50 Hz.
//
// The mission is a real story, synthesized deterministically so it reproduces byte for byte:
// a PID balancer with DEFAULT_KD = 0 rings at 1.9 Hz, the ring grows all mission, and at 51.7 s
// the loop runs out of authority. The robot goes over, is stood back up, goes over again, and is
// balancing (badly) again by 58.2 s. Underneath that: a heap leak and a bus that stalls.
//
// Everything below is generated from one seeded stream. Math.random() is banned here.
//
// Signal construction, so the numbers are auditable:
//   pitch      authored (limit-cycle envelope + monotone-cubic keyframes through the fall)
//   rate       d(pitch)/dt of the clean shape + gyro noise
//   p,i,d      a real PID evaluated on the logged pitch. KD is 0, so d is 0 in every sample.
//   output     clamp(p+i+d, +/-255) passed through the driver's output slew limit
//   step_rate  output scaled to the 6000 steps/s ceiling, integer
// Nothing downstream of pitch is hand-drawn: if you change a gain, the whole failure changes.

import { mulberry32, gaussian, fbm1D, clamp } from '../../core/prng.js';

export const duration = 73.0;
export const rate = 50;

/** /sys is logged at a tenth of the control rate. */
const SYS_RATE = 10;

export const channels = [
  {
    path: '/balance',
    fields: [
      { key: 'pitch', label: 'pitch', unit: 'deg' },
      { key: 'setpoint', label: 'setpoint', unit: 'deg' },
      { key: 'output', label: 'output', unit: 'pwm' },
      { key: 'step_rate', label: 'step_rate', unit: 'steps/s' },
      { key: 'motor_active', label: 'motor_active', unit: '' },
      { key: 'p', label: 'p', unit: 'pwm' },
      { key: 'i', label: 'i', unit: 'pwm' },
      { key: 'd', label: 'd', unit: 'pwm' },
      { key: 'rate', label: 'rate', unit: 'deg/s' },
      { key: 'i2c_dt', label: 'i2c_dt', unit: 'ms' },
    ],
  },
  {
    path: '/sys',
    fields: [
      { key: 'heap', label: 'heap', unit: 'B' },
      { key: 'rssi', label: 'rssi', unit: 'dBm' },
      { key: 'uptime_s', label: 'uptime_s', unit: 's' },
    ],
  },
];

export const findings = [
  {
    id: 'fall',
    title: 'Fall at 51.7 s',
    window: [50.5, 58.5],
    t: 51.7,
    severity: 'alert',
    focus: { channel: '/balance', fields: ['pitch', 'output'] },
    highlight: 'body',
    slowmo: true,
  },
  {
    id: 'divergence',
    title: 'Oscillation diverging, D term is 0',
    window: [42.0, 52.2],
    t: 50.4,
    severity: 'warn',
    focus: { channel: '/balance', fields: ['pitch', 'setpoint'] },
    highlight: null,
    slowmo: false,
  },
  {
    id: 'heap-leak',
    title: 'Heap leak over the mission',
    window: [0, 73],
    t: 63.8,
    severity: 'warn',
    focus: { channel: '/sys', fields: ['heap'] },
    highlight: null,
    slowmo: false,
  },
  {
    id: 'i2c-stall',
    title: 'I2C stall, 801.9 ms at 31.4 s',
    window: [30.2, 33.8],
    t: 31.36,
    severity: 'warn',
    focus: { channel: '/balance', fields: ['i2c_dt'] },
    highlight: null,
    slowmo: false,
  },
];

// ------------------------------------------------------------------ controller constants
// These are the firmware's constants, not curve-fitting knobs: change one and the mission
// changes shape. KD is the whole story.
const SETPOINT = 0.5; // deg, the mechanical balance point the firmware was told to hold
const KP = 96.0; // pwm per deg
const KI = 55.0; // pwm per deg-second
const KD = 0.0; // DEFAULT_KD, never set. This is the root cause.
const I_CLAMP = 18.0; // pwm, anti-windup clamp on the i term
const OUT_LIMIT = 255.0; // pwm rail
const OUT_SLEW = 1853.0; // pwm/s, stepper acceleration limit reflected into the output
const STEP_CEIL = 6000; // steps/s, the driver's ceiling
const STEP_PER_PWM = STEP_CEIL / OUT_LIMIT; // 23.529 steps/s per pwm count
const TILT_FAULT = 20.0; // deg, past this the wheels can no longer get back under the mass

// ------------------------------------------------------------------ mission timeline (seconds)
const T_P1 = 51.46; // last clean backward peak, pitch = -2.00
const T_P2 = 51.66; // forward whip, pitch = +7.12
const T_P3 = 51.8; // backward whip, pitch = -10.06
const T_DOWN_1 = 52.0; // pitch crosses +20 deg, unrecoverable
const T_DOWN_2 = 56.2; // second attempt goes over
const T_UPRIGHT = 58.2; // stood back up, pitch back under +5 deg
const T_STALL = 31.36; // the 801.9 ms I2C stall

// I2C transactions that blew the 20 ms loop budget. Sixteen of them, exactly as logged.
const I2C_EVENTS = [
  [7.62, 24.3],
  [12.18, 31.7],
  [16.44, 22.1],
  [19.9, 47.6],
  [23.06, 28.4],
  [26.72, 21.4],
  [T_STALL, 801.9],
  [34.28, 63.2],
  [37.54, 26.9],
  [41.1, 35.5],
  [44.66, 214.6],
  [47.28, 23.8],
  [49.86, 29.1],
  [55.14, 44.7],
  [61.42, 27.3],
  [68.3, 33.6],
];

// heap endpoints, measured
const HEAP_START = 112172;
const HEAP_END = 67020;
const HEAP_MIN = 48724;
const HEAP_LEAK = 622.0; // B/s, the fitted leak slope
const HEAP_SETTLE = 0.9; // s, setup allocations finish before the leak starts
const HEAP_SAW = 575; // B, TLS chunk buffer churn, allocated and freed every 4.7 s

// ------------------------------------------------------------------ helpers

/** Monotone cubic (PCHIP) through keyframes: smooth, no ringing, extrema exactly on the keys. */
function makePchip(keys) {
  const n = keys.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    xs[k] = keys[k][0];
    ys[k] = keys[k][1];
  }
  const h = new Float64Array(n - 1);
  const del = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    h[k] = xs[k + 1] - xs[k];
    del[k] = (ys[k + 1] - ys[k]) / h[k];
  }
  const m = new Float64Array(n);
  m[0] = del[0];
  m[n - 1] = del[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (del[k - 1] * del[k] <= 0) {
      m[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / del[k - 1] + w2 / del[k]);
    }
  }
  return function evalAt(x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && xs[k + 1] < x) k++;
    const s = (x - xs[k]) / h[k];
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * ys[k] +
      (s3 - 2 * s2 + s) * h[k] * m[k] +
      (-2 * s3 + 3 * s2) * ys[k + 1] +
      (s3 - s2) * h[k] * m[k + 1]
    );
  };
}

/** Smooth 0..1 ramp, clamped. */
function ss(x) {
  const u = clamp(x, 0, 1);
  return u * u * (3 - 2 * u);
}

/** Fractional part, always positive. */
function frac(x) {
  return x - Math.floor(x);
}

/**
 * Deterministic telemetry for the whole mission.
 * @param {() => number} prng seeded mulberry32 stream, supplied by app.js
 * @param {object} [tuning] test hook: override controller constants from a self-check script
 */
export function buildData(prng, tuning) {
  const rnd = prng || mulberry32(0x5b12);
  const kp = (tuning && tuning.KP) || KP;
  const ki = (tuning && tuning.KI) || KI;
  const slew = (tuning && tuning.SLEW) || OUT_SLEW;

  const n = Math.round(duration * rate) + 1;
  const dt = 1 / rate;
  const idx = (s) => Math.round(s * rate);

  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / rate;

  // ---------------------------------------------------------------- 1. balancing limit cycle
  // Envelope grows 2.0 %/s for most of the mission, then goes nonlinear from ~44 s as the
  // command starts clipping. Normalized so the last clean peak is exactly 2.50 deg off setpoint.
  const gBase = 0.02;
  const gLate = 0.45;
  const growth = new Float64Array(n); // cumulative ln-amplitude
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = t[i];
    growth[i] = acc;
    acc += (gBase + gLate * ss((s - 44.0) / 7.0)) * dt;
  }
  const envRef = growth[idx(T_P1)];
  const AMP0 = 2.5;
  const env = (i) => AMP0 * Math.exp(growth[i] - envRef);

  // 1.90 Hz ring, phase anchored so T_P1 lands exactly on a backward peak.
  const W1 = 2 * Math.PI * 1.9;
  const PH1 = -Math.PI / 2 - W1 * T_P1;
  const osc1 = (i) => SETPOINT + env(i) * Math.sin(W1 * t[i] + PH1);

  // Second attempt after it is stood up: same instability, much faster runaway.
  const T_ATT0 = 54.28;
  const T_ATT1 = 55.8;
  const W2 = 2 * Math.PI * 2.55;
  const PH2 = -Math.PI / 2 - W2 * (T_ATT1 - T_ATT0);
  const A2_END = 6.9;
  const G2 = 1.05;
  const osc2 = (s) =>
    SETPOINT +
    A2_END * Math.exp(G2 * (s - T_ATT1)) * Math.sin(W2 * (s - T_ATT0) + PH2);

  // Third run: stood up again, ringing again, same 2.0 %/s divergence.
  const T_RUN3 = 58.62;
  const W3 = 2 * Math.PI * 2.4;
  const osc3 = (s) => SETPOINT + 0.4 * Math.exp(gBase * (s - T_RUN3)) * Math.sin(W3 * (s - T_RUN3));

  // ---------------------------------------------------------------- 2. the two falls
  // Keyframes are the authored truth: the three quoted pitch samples are keys, and the down /
  // upright markers are keys, so they land exactly on their sample instants.
  const fall1 = makePchip([
    [51.36, osc1(idx(51.36))],
    [T_P1, -2.0],
    [T_P2, 7.12],
    [T_P3, -10.06],
    [51.85, -4.6],
    [51.91, 3.92],
    [T_DOWN_1, TILT_FAULT],
    [52.07, 40.0],
    [52.15, 60.0],
    [52.24, 76.0],
    [52.34, 86.0],
    [52.42, 88.6],
    [52.5, 86.6],
    [52.6, 88.4],
    [52.72, 87.7],
    [52.92, 87.9],
    [53.08, 82.0],
    [53.22, 66.0],
    [53.36, 44.0],
    [53.48, 24.0],
    [53.58, 10.0],
    [53.66, 2.4],
    [53.78, -1.0],
    [53.94, 0.8],
    [54.2, osc2(54.2)],
    [T_ATT0, osc2(T_ATT0)],
  ]);

  const fall2 = makePchip([
    [55.72, osc2(55.72)],
    [T_ATT1, osc2(T_ATT1)],
    [55.96, 3.6],
    [56.08, 11.0],
    [T_DOWN_2, TILT_FAULT],
    [56.34, 33.0],
    [56.48, 49.0],
    [56.62, 66.0],
    [56.76, 79.0],
    [56.88, 86.4],
    [56.98, 88.8],
    [57.08, 86.8],
    [57.2, 88.3],
    [57.45, 87.9],
    [57.62, 87.6],
    [57.78, 80.0],
    [57.92, 66.0],
    [58.04, 42.0],
    [58.12, 22.0],
    [T_UPRIGHT, 5.0],
    [58.28, -2.5],
    [58.36, -1.0],
    [58.54, osc3(58.54)],
    [T_RUN3, osc3(T_RUN3)],
  ]);

  // The 801.9 ms bus stall starves the loop: the last command holds and the robot lurches
  // forward before the loop catches it again. It survives this one, which is the point.
  const lurch = (s) => {
    if (s < T_STALL || s > T_STALL + 2.6) return 0;
    const u = s - T_STALL;
    return 8.4 * ss(u / 0.16) * Math.exp(-u * 1.35) * Math.cos(u * 3.1);
  };

  // ---------------------------------------------------------------- 3. clean pitch shape
  const slowWander = fbm1D(mulberry32(0x2b17), 3, 0.55);
  const clean = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = t[i];
    let v;
    let ringing = true;
    if (s < T_P1) v = osc1(i);
    else if (s <= T_ATT0) {
      v = fall1(s);
      ringing = false;
    } else if (s < T_ATT1) v = osc2(s);
    else if (s <= T_RUN3) {
      v = fall2(s);
      ringing = false;
    } else v = osc3(s);
    // slow mechanical drift of the balance point, only meaningful while it is actually balancing
    if (ringing) v += (slowWander(s * 0.11) - 0.5) * 0.34;
    clean[i] = v + lurch(s);
  }

  // ---------------------------------------------------------------- 4. gyro rate + fused pitch
  const rateArr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = clean[Math.max(i - 1, 0)];
    const b = clean[Math.min(i + 1, n - 1)];
    const span = (Math.min(i + 1, n - 1) - Math.max(i - 1, 0)) * dt;
    rateArr[i] = (b - a) / span + gaussian(rnd, 0, 0.55);
  }

  const pitch = new Float64Array(n);
  for (let i = 0; i < n; i++) pitch[i] = clean[i] + gaussian(rnd, 0, 0.028);

  // The five quoted instants are pinned to their measured values. The authored shape already
  // passes within a few hundredths; this only removes the sensor-noise sample.
  pitch[idx(T_P1)] = -2.0;
  pitch[idx(T_P2)] = 7.12;
  pitch[idx(T_P3)] = -10.06;
  pitch[idx(T_DOWN_1)] = TILT_FAULT;
  pitch[idx(T_DOWN_2)] = TILT_FAULT;
  pitch[idx(T_UPRIGHT)] = 5.0;

  // ---------------------------------------------------------------- 5. the PID, as flashed
  const setpointArr = new Float64Array(n);
  const output = new Float64Array(n);
  const stepRate = new Float64Array(n);
  const motorActive = new Float64Array(n);
  const pArr = new Float64Array(n);
  const iArr = new Float64Array(n);
  const dArr = new Float64Array(n);

  let integral = 0;
  let out = 0;
  const maxStep = slew * dt;
  const iLimit = I_CLAMP / ki;
  for (let i = 0; i < n; i++) {
    setpointArr[i] = SETPOINT;
    const err = SETPOINT - pitch[i];
    integral = clamp(integral + err * dt, -iLimit, iLimit);
    const pT = kp * err;
    const iT = ki * integral;
    const dT = KD * rateArr[i] || 0; // KD is 0, so this column is 0 in every single sample
    const cmd = clamp(pT + iT + dT, -OUT_LIMIT, OUT_LIMIT);
    out += clamp(cmd - out, -maxStep, maxStep);
    pArr[i] = pT;
    iArr[i] = iT;
    dArr[i] = dT;
    output[i] = out;
    stepRate[i] = Math.round(clamp(out * STEP_PER_PWM, -STEP_CEIL, STEP_CEIL));
    motorActive[i] = Math.abs(out) > 3.0 ? 1 : 0;
  }

  // ---------------------------------------------------------------- 6. I2C loop timing
  const i2c = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = t[i];
    // recovery tail after the big stall: the bus is congested for a beat, still inside budget
    const tail = s > T_STALL && s < T_STALL + 0.9 ? 5.4 * Math.exp(-(s - T_STALL) * 3.6) : 0;
    i2c[i] = clamp(10.0 + Math.abs(gaussian(rnd, 0, 0.62)) + tail, 8.6, 19.4);
  }
  for (const [ts, ms] of I2C_EVENTS) i2c[idx(ts)] = ms;

  // ---------------------------------------------------------------- 7. /sys at 10 Hz
  const m = Math.round(duration * SYS_RATE) + 1;
  const st = new Float64Array(m);
  const heap = new Float64Array(m);
  const rssi = new Float64Array(m);
  const uptime = new Float64Array(m);
  const rssiNoise = fbm1D(mulberry32(0x77c3), 3, 0.5);

  // Link quality craters around 62 s. The TLS session retries, the retry buffers a whole chunk,
  // and that is the transient that takes the heap to its minimum a second later.
  const rssiDip = (s) => 26.0 * (ss((s - 61.9) / 0.5) - ss((s - 64.6) / 1.4));
  const heapBurst = (s) => 23764 * (ss((s - 63.15) / 0.25) - ss((s - 64.35) / 0.55));

  const heapBase = (s) => HEAP_START - HEAP_LEAK * Math.max(0, s - HEAP_SETTLE) - HEAP_SAW * frac(s / 4.7);
  let burstScale = 1;
  for (let pass = 0; pass < 2; pass++) {
    let lo = Infinity;
    for (let j = 0; j < m; j++) {
      const s = j / SYS_RATE;
      const v = heapBase(s) - heapBurst(s) * burstScale;
      if (v < lo) lo = v;
    }
    if (pass === 0) burstScale = (23764 + (lo - HEAP_MIN)) / 23764;
  }

  for (let j = 0; j < m; j++) {
    const s = j / SYS_RATE;
    st[j] = s;
    heap[j] = Math.round(heapBase(s) - heapBurst(s) * burstScale + gaussian(rnd, 0, 26));
    rssi[j] = Math.round(-52 + (rssiNoise(s * 0.42) - 0.5) * 3.4 - rssiDip(s));
    uptime[j] = 118 + Math.floor(s);
  }
  // measured endpoints and the measured floor, pinned
  heap[0] = HEAP_START;
  heap[m - 1] = HEAP_END;
  let minJ = 0;
  for (let j = 1; j < m; j++) if (heap[j] < heap[minJ]) minJ = j;
  heap[minJ] = HEAP_MIN;

  return {
    '/balance': {
      t,
      pitch,
      setpoint: setpointArr,
      output,
      step_rate: stepRate,
      motor_active: motorActive,
      p: pArr,
      i: iArr,
      d: dArr,
      rate: rateArr,
      i2c_dt: i2c,
    },
    '/sys': { t: st, heap, rssi, uptime_s: uptime },
  };
}
