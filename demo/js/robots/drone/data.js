// drone/data.js - 90 s quad survey flight, 50 Hz, seeded and deterministic.
//
// The mission: arm, climb to 6 m, fly a five-lane lawnmower survey over a 20 x 14 m field,
// then lose motor 3 to a failing bearing and land under failsafe.
//
// Nothing here is hand-drawn on top of the failure. The chain is generated forward:
//   bearing health h3(t) decays
//     -> the speed loop pushes pwm3 up to hold rpm3, and pins at 100 %
//        -> once pinned, rpm3 sags and motor 3 stops making its share of thrust
//           -> motors 1/2/4 take up the deficit (rpm and pwm rise, current rises)
//              -> at 61.2 s the bearing binds, thrust breaks, the airframe drops and yaws
// Attitude comes from the actual path (roll/pitch are the tilt needed for the measured
// acceleration plus drag trim), motor rpm comes from the thrust needed for the actual vertical
// acceleration, and pack current comes from motor rpm. So every channel agrees with every other.

import { mulberry32, gaussian, fbm1D, clamp, smoothstep } from '../../core/prng.js';

export const duration = 90.0;
export const rate = 50;

/** /bat is ESC telemetry, which comes back slower than the flight controller loop. */
const BAT_RATE = 25;

export const channels = [
  {
    path: '/att',
    fields: [
      { key: 'roll', label: 'roll', unit: 'deg' },
      { key: 'pitch', label: 'pitch', unit: 'deg' },
      { key: 'yaw', label: 'yaw', unit: 'deg' },
    ],
  },
  {
    path: '/pos',
    fields: [
      { key: 'alt', label: 'alt', unit: 'm' },
      { key: 'x', label: 'x', unit: 'm' },
      { key: 'y', label: 'y', unit: 'm' },
    ],
  },
  {
    path: '/motors',
    fields: [
      { key: 'rpm1', label: 'rpm1', unit: 'rpm' },
      { key: 'rpm2', label: 'rpm2', unit: 'rpm' },
      { key: 'rpm4', label: 'rpm4', unit: 'rpm' },
      { key: 'rpm3', label: 'rpm3', unit: 'rpm' },
      { key: 'pwm1', label: 'pwm1', unit: '%' },
      { key: 'pwm2', label: 'pwm2', unit: '%' },
      { key: 'pwm4', label: 'pwm4', unit: '%' },
      { key: 'pwm3', label: 'pwm3', unit: '%' },
    ],
  },
  {
    path: '/bat',
    fields: [
      { key: 'v', label: 'v', unit: 'V' },
      { key: 'a', label: 'a', unit: 'A' },
    ],
  },
];

export const findings = [
  {
    id: 'dip',
    title: 'Altitude dip at 61.2 s',
    window: [58.0, 66.0],
    // The 3D replay loop, tight around the break: 0.5 s of the airframe holding 6 m on the last
    // survey lane, the bearing binding at 61.2 s (T_FAIL below; findings is evaluated before it, so
    // this window is written out in full exactly as `t` is), the 2.10 m drop and the yaw kick that
    // comes with it, then 0.6 s of the failsafe holding the altitude it has accepted. The trough
    // is at 62.30 s and the loss is back to 1.82 m of the 2.10 by 62.9 s, so the lap ends on the
    // settled fail state rather than mid-recovery. 2.2 s of data.
    //
    // ROUND 12 RE-MEASURED THIS AND LEFT IT ALONE, which is worth writing down because the round's
    // note was that a replay must not spend its head and tail on normal flight. Sampled at 0.1 s:
    // altitude is 6.002 m at 60.7 and still 6.004 at 61.2, so the head is 0.50 s of level cruise -
    // the lead the break needs to read as a break and no more. The tail is not cruise either: 61.3
    // is already 5.633 m and -7.03 deg of yaw, the trough is 3.900 m at 62.30, and 62.9 is 4.170 m
    // at -15.94 deg, still 1.83 m and 16 deg from where the lap opened. There is no normal operation
    // anywhere inside these 2.2 s to cut.
    loop: [60.7, 62.9],
    t: 61.2,
    severity: 'alert',
    focus: { channel: '/pos', fields: ['alt'] },
    highlight: 'm3',
    // NOT slow motion any more. The break itself takes 1.1 s and is 2.1 m of altitude plus a yaw
    // runaway: it reads at 1x, and 0.4x on a window this tight is 5.5 s a lap, which is the length
    // this round was called out for.
    slowmo: false,
    note:
      'alt is the height the controller is holding against the survey setpoint. It leaves the band ' +
      'and climbs back on its own; motor 3 is the part lit in the replay below.',
  },
  {
    id: 'motor-wear',
    title: 'Motor 3 throttle diverging from 38 s',
    window: [38.0, 62.0],
    // The 3D replay loop, and until this round there was none: `core/embeds.js` looped this
    // finding's CHART window, so the block under the root-cause answer ran a 24 s lap of an aircraft
    // flying survey lanes. The window is unchanged, because the walk from 60 to 100 percent is a
    // 24 s shape and the chart is where a reader can see it; what the 3D needs is the seconds where
    // that walk becomes an EVENT.
    //
    // There is exactly one, and it is the diagnosis. Measured off the built /motors: pwm3 first
    // touches 99.0 percent at 57.24 s, 99.9 at 57.46, and is pinned at 100.00 continuously from
    // 57.48 s - the drive runs out of range. The consequence is on the other side of the same
    // channel: rpm3's half-second mean peaks at 6159 rpm at 57.20 s and then falls away with nothing
    // left to hold it - 6001 at 58.0, 5730 at 59.0, 5650 by 59.4 - while the three healthy motors
    // walk the other way, rpm1's own half-second mean going 6120 at 56.9 s to 6183 at 59.4 s. Same
    // throttle ceiling, less rpm, and the other three taking up the difference.
    //
    // So the lap opens 0.58 s early, at a pwm3 of 97.48 percent already 37.2 points over the median
    // of the healthy three and still climbing, and closes 1.9 s after the ceiling is reached. 2.5 s
    // at 1x against 24.0 s. Nothing in it is normal operation on the channel this finding is about.
    // The head is not padding either: it is the last of the headroom, which is the only reason the
    // ceiling reads as a ceiling.
    //
    // AND THE AIRFRAME LOOKS FINE FOR EVERY SECOND OF IT, which is this finding's whole claim and is
    // why the loop is worth having at 1x rather than a chart alone. Over 56.9 to 59.4 s altitude
    // holds 5.985 to 6.001 m, yaw stays inside -0.42 to 0.41 deg, and the aircraft flies 5.7 m of
    // the last survey lane. The fault is only in the throttle, 1.8 s before the bearing binds.
    loop: [56.9, 59.4],
    t: 52.0,
    severity: 'warn',
    // NOTE (deviation, see report): the chart shares one y axis across the selected fields, so
    // rpm3 + pwm3 together would flatten pwm3 into the floor of a 4000-9000 rpm axis. Throttle
    // for all four motors is the same story on one readable axis, and it is the only view where
    // the divergence spans the whole window: pwm3 walks 60 -> 100 % while 1/2/4 sit flat at 60 %.
    // pwm3 is listed last so it takes the alert-red series colour.
    focus: { channel: '/motors', fields: ['pwm1', 'pwm2', 'pwm4', 'pwm3'] },
    highlight: 'm3',
    slowmo: false,
    note:
      'All four throttles are plotted on one axis. Three sit flat while pwm3 walks up alone, which ' +
      'is one drive spending more of its range for the same lift.',
  },
  {
    id: 'battery',
    title: 'Pack sag steepens from 40 s',
    // NO `loop`, DELIBERATELY, and it is the one finding in this mission where a tight one would be
    // both dead code and a lie about the channel.
    //
    // Dead code first, because it settles the question: this window IS the log, and
    // `core/embeds.js` tests `w[1] - w[0] >= duration * 0.95` before it reads `loop` at all. A
    // whole-log finding is a declaration that the channel is context for every second of the
    // mission, so the block seeks to `t` minus 8 s and plays free rather than lapping anything. A
    // `loop` written here would never be read by the one consumer that reads loops.
    //
    // And there is no onset to write one around even if there were. Measured off the built /bat,
    // centred over 4 s: dV/dt averages -0.0284 V/s across 10 to 30 s, first passes 1.5x that at
    // 36.32 s and 2x at 48.08 s. That is a curve bending over twenty seconds, not an edge - which
    // is the finding's own point, since the thing that bends it is one motor's current climbing the
    // whole time (mean pack current 14.18 A over 20 to 30 s against 23.39 A over 55 to 60 s). The
    // 3D has nothing to show inside two seconds either: the pack's charge gauge is lit from this
    // same voltage and moves by less than one of its four segments across any 2 s of the flight.
    // The chart over the whole mission is the evidence, and this window is what says so.
    window: [0, 90],
    t: 40.0,
    severity: 'warn',
    focus: { channel: '/bat', fields: ['v'] },
    highlight: null,
    slowmo: false,
    note:
      'v is the pack voltage across the whole flight. The sag steepens once one motor starts ' +
      'drawing more than the other three, so the window plotted here is the mission rather than a ' +
      'moment inside it.',
  },
];

// ---------------------------------------------------------------------------
// mission constants (shared with scene.js)
// ---------------------------------------------------------------------------

export const FIELD = { x: 20, y: 14 }; // survey box, metres
export const LANE_Y = [-7, -3.5, 0, 3.5, 7];
export const SURVEY_ALT = 6.0;

export const T_SPOOL = 0.35;
export const T_CLIMB = 1.2;
export const T_SURVEY = 6.0;
export const LANE_DUR = 9.1;
export const TURN_DUR = 3.5;
export const T_FAIL = 61.2; // bearing binds
export const T_DESCENT = 70.0;
export const T_TOUCHDOWN = 78.0;

const G = 9.81;
const MASS = 1.28; // kg, all-up
const CT = 8.474e-8; // N per rpm^2, one prop
const K_RPM = 101.6; // rpm per pwm %, healthy motor under hover load
const T_MAX = 20.5; // N, total thrust the airframe can actually make
const KP_ALT = 4.6; // N per m of altitude error
const KD_ALT = 1.4; // N per m/s of altitude error rate
const DIP_DEPTH = 2.1; // m, mandated
const YAW_PEAK = 18.0; // deg, mandated

/** Trapezoidal distance profile over u in [0,1]; `a` is the accel/decel fraction of the leg. */
function trap(u, a) {
  const x = clamp(u, 0, 1);
  const vmax = 1 / (1 - a);
  if (x < a) return (vmax * x * x) / (2 * a);
  if (x > 1 - a) return 1 - (vmax * (1 - x) * (1 - x)) / (2 * a);
  return vmax * (a / 2 + (x - a));
}

/** Ideal lawnmower path (before the failure aborts it). Returns [x, y] in metres. */
function surveyPath(s) {
  if (s <= T_SURVEY) return [-10, LANE_Y[0]];
  let u = s - T_SURVEY;
  for (let lane = 0; lane < LANE_Y.length; lane++) {
    const dir = lane % 2 === 0 ? 1 : -1;
    const x0 = dir === 1 ? -10 : 10;
    if (u < LANE_DUR) {
      return [x0 + dir * 20 * trap(u / LANE_DUR, 0.16), LANE_Y[lane]];
    }
    u -= LANE_DUR;
    const xEnd = dir === 1 ? 10 : -10;
    if (lane === LANE_Y.length - 1) return [xEnd, LANE_Y[lane]];
    if (u < TURN_DUR) {
      const k = smoothstep(u / TURN_DUR);
      return [xEnd, LANE_Y[lane] + (LANE_Y[lane + 1] - LANE_Y[lane]) * k];
    }
    u -= TURN_DUR;
  }
  return [10, LANE_Y[LANE_Y.length - 1]];
}

/** Bearing health of motor 3: 1.0 healthy, falls as the race wears, steps when it binds. */
function health3(s) {
  const wear = 0.55 * Math.pow(clamp((s - 32) / 31.3, 0, 1), 1.6);
  const bind = 0.11 * smoothstep((s - T_FAIL) / 0.35);
  return 1 - wear - bind;
}

/** Commanded altitude: climb, survey hold, failsafe descent to touchdown. */
function altCommand(s) {
  if (s < T_CLIMB) return 0;
  if (s < T_SURVEY) return SURVEY_ALT * smoothstep((s - T_CLIMB) / (T_SURVEY - T_CLIMB));
  if (s < T_DESCENT) return SURVEY_ALT;
  if (s < T_TOUCHDOWN) return SURVEY_ALT * (1 - smoothstep((s - T_DESCENT) / (T_TOUCHDOWN - T_DESCENT)));
  return 0;
}

/** How much of the altitude loss the failsafe has stopped fighting and accepted as the new hold. */
function accept(s) {
  return smoothstep((s - (T_FAIL + 2.6)) / 1.8);
}

/** Fade of the loss offset as the descent profile takes over the altitude command. */
function lossFade(s) {
  return 1 - smoothstep((s - T_DESCENT) / 6.0);
}

/** Unnormalised shape of the altitude loss: fast break, overshoot, partial hold. */
function dipShape(s) {
  const u = s - T_FAIL;
  if (u <= 0) return 0;
  const settle = 0.667 * smoothstep(u / 1.2);
  const transient = 0.42 * (u / 0.6) * Math.exp(1 - u / 0.6);
  return settle + transient;
}

/** Unnormalised shape of the yaw runaway: sharp kick, ring-down, standing heading error. */
function yawShape(s) {
  const u = s - T_FAIL;
  if (u <= 0) return 0;
  const kick = 0.78 * (u / 0.62) * Math.exp(1 - u / 0.62);
  const ring = Math.exp(-u / 1.9) * Math.sin(u * 4.3) * 0.16;
  const standing = 0.52 * smoothstep(u / 2.4);
  return Math.max(kick + standing + ring, 0);
}

/** Causal one-pole lag. Used wherever a controller reacts, so it never leads the event. */
function lowpass(src, tau, dt) {
  const k = dt / (tau + dt);
  const out = new Float64Array(src.length);
  let acc = src[0];
  for (let i = 0; i < src.length; i++) {
    acc += (src[i] - acc) * k;
    out[i] = acc;
  }
  return out;
}

/** Zero-phase one-pole smoother (forward then backward), for accel-derived attitude. */
function filtfilt(src, tau, dt) {
  const n = src.length;
  const k = dt / (tau + dt);
  const out = new Float64Array(n);
  let acc = src[0];
  for (let i = 0; i < n; i++) {
    acc += (src[i] - acc) * k;
    out[i] = acc;
  }
  acc = out[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    acc += (out[i] - acc) * k;
    out[i] = acc;
  }
  return out;
}

/**
 * @param {() => number} prng seeded mulberry32 stream from app.js
 */
export function buildData(prng) {
  const rnd = prng || mulberry32(0xd2a1);
  const gust = fbm1D(mulberry32(0x51f3), 4, 0.55);
  const drift = fbm1D(mulberry32(0x2c07), 3, 0.6);
  const heading = fbm1D(mulberry32(0x7b19), 3, 0.5);
  const rumble = fbm1D(mulberry32(0x3e5d), 2, 0.5);

  const n = Math.round(duration * rate) + 1;
  const dt = 1 / rate;

  const t = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const alt = new Float64Array(n);
  const roll = new Float64Array(n);
  const pitch = new Float64Array(n);
  const yaw = new Float64Array(n);

  // ---- 1. horizontal path -------------------------------------------------
  // Survey path until the bearing binds, then a coast-and-drift: the failsafe holds attitude,
  // not position, so the airframe carries its lane speed for a couple of seconds and creeps.
  const failIdx = Math.round(T_FAIL * rate);
  const p0 = surveyPath(T_FAIL);
  const pPrev = surveyPath(T_FAIL - dt);
  const vxFail = (p0[0] - pPrev[0]) / dt;
  const vyFail = (p0[1] - pPrev[1]) / dt;

  let cx = p0[0];
  let cy = p0[1];
  for (let i = 0; i < n; i++) {
    const s = i * dt;
    t[i] = s;
    if (i <= failIdx) {
      const p = surveyPath(s);
      // position hold is never perfect: sub-decimetre wander from wind
      x[i] = p[0] + (gust(s * 0.31) - 0.5) * 0.16;
      y[i] = p[1] + (drift(s * 0.27) - 0.5) * 0.16;
      cx = x[i];
      cy = y[i];
    } else {
      const u = s - T_FAIL;
      const decay = Math.exp(-u / 0.95);
      const vx = vxFail * decay + 0.055 * (1 - decay);
      const vy = vyFail * decay + 0.035 * (1 - decay);
      cx += vx * dt;
      cy += vy * dt;
      x[i] = cx + (gust(s * 0.31) - 0.5) * 0.16;
      y[i] = cy + (drift(s * 0.27) - 0.5) * 0.16;
    }
  }

  // ---- 2. altitude --------------------------------------------------------
  // Normalise the loss so the trough sits exactly DIP_DEPTH below the survey hold, then fade the
  // offset out as the failsafe descent takes over (otherwise it would push alt below ground).
  // altTarget is what the controller is still chasing: it holds 6 m through the break, then the
  // failsafe accepts the lost altitude and stops fighting for it. The gap between the two is the
  // error that drives the motors, which is why 1/2/4 spike while the aircraft is still falling.
  const altTarget = new Float64Array(n);
  const baroAt = (s) => (altCommand(s) > 0.5 ? (gust(s * 0.63 + 40) - 0.5) * 0.05 : 0);

  let shapeMax = 0;
  for (let i = 0; i < n; i++) shapeMax = Math.max(shapeMax, dipShape(i * dt));
  let dipK = DIP_DEPTH / shapeMax;

  const fillAlt = () => {
    for (let i = 0; i < n; i++) {
      const s = t[i];
      const loss = dipK * dipShape(s) * lossFade(s);
      alt[i] = Math.max(altCommand(s) - loss + baroAt(s), 0);
      altTarget[i] = Math.max(altCommand(s) - loss * accept(s), 0);
    }
  };
  fillAlt();
  // one correction pass so the measured trough is the mandated 2.10 m, noise included
  let trough = Infinity;
  for (let i = Math.round(58 * rate); i <= Math.round(66 * rate); i++) trough = Math.min(trough, alt[i]);
  dipK *= DIP_DEPTH / (SURVEY_ALT - trough);
  fillAlt();

  // ---- 3. attitude --------------------------------------------------------
  // roll/pitch are the tilt that produces the measured horizontal acceleration plus the drag
  // trim needed to hold lane speed. Heading is locked for the survey so image footprints line up.
  const axRaw = new Float64Array(n);
  const ayRaw = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    axRaw[i] = (x[i + 1] - 2 * x[i] + x[i - 1]) / (dt * dt);
    ayRaw[i] = (y[i + 1] - 2 * y[i] + y[i - 1]) / (dt * dt);
  }
  axRaw[0] = axRaw[1];
  ayRaw[0] = ayRaw[1];
  axRaw[n - 1] = axRaw[n - 2];
  ayRaw[n - 1] = ayRaw[n - 2];
  const ax = filtfilt(axRaw, 0.18, dt);
  const ay = filtfilt(ayRaw, 0.18, dt);

  // Solve the yaw gain against the noise-free heading wander so the measured excursion is 18 deg.
  const yawBase = (s) => (heading(s * 0.22) - 0.5) * 2.2;
  let yawK = YAW_PEAK;
  for (let pass = 0; pass < 3; pass++) {
    let peak = 0;
    for (let i = Math.round(58 * rate); i <= Math.round(66 * rate); i++) {
      const s = i * dt;
      peak = Math.min(peak, yawBase(s) - yawK * yawShape(s));
    }
    yawK *= YAW_PEAK / Math.abs(peak);
  }

  const DEG = 180 / Math.PI;
  for (let i = 0; i < n; i++) {
    const s = t[i];
    // Weight-on-skids is a transition, not a step. The old binary test dropped roll/pitch and,
    // worse, snapped yaw from the standing -18 deg back to 0 inside one sample, which read as a
    // data glitch and contradicted the answer's "the heading error never recovered".
    const airborne = clamp((alt[i] - 0.03) / 0.28, 0, 1);
    const vx = i > 0 ? (x[i] - x[i - 1]) / dt : 0;
    const vy = i > 0 ? (y[i] - y[i - 1]) / dt : 0;
    const dragX = 0.062 * vx * Math.abs(vx);
    const dragY = 0.062 * vy * Math.abs(vy);

    // bearing rumble the controller is still masking: grows from 40 s, then dies away once the
    // failsafe gives up on holding altitude and the motor is no longer being driven through the
    // failing bearing. Without the decay the last 30 s were a solid 4.2 Hz block of colour, which
    // contradicted the answer's "controlled failsafe descent".
    const tremorAmp =
      1.35 * smoothstep((s - 40) / 19) * (1 - 0.84 * smoothstep((s - (T_FAIL + 2.5)) / 7));
    const tremor = Math.sin(s * 2 * Math.PI * 4.2) * tremorAmp * (0.75 + 0.5 * rumble(s * 1.7));

    // the break: attitude authority is gone for about two seconds
    const u = s - T_FAIL;
    const burst = u > 0 ? 15.0 * Math.exp(-u / 1.55) * Math.sin(u * 2 * Math.PI * 3.1) : 0;

    roll[i] =
      (-Math.atan2(ay[i] + dragY, G) * DEG + tremor + burst) * airborne + gaussian(rnd, 0, 0.04 + 0.03 * airborne);
    pitch[i] =
      (-Math.atan2(ax[i] + dragX, G) * DEG + tremor * 0.42 + burst * 0.34) * airborne +
      gaussian(rnd, 0, 0.04 + 0.03 * airborne);
    // heading is a physical attitude: once it lands rotated off the lane it STAYS rotated
    yaw[i] = yawBase(s) - yawK * yawShape(s) + gaussian(rnd, 0, 0.03 + 0.03 * airborne);
  }

  // ---- 4. motors ----------------------------------------------------------
  // Vertical acceleration sets total thrust. Motor 3 runs a speed loop: pwm3 rises to hold its
  // rpm target against the failing bearing, saturates at 100 %, and after that rpm3 is whatever
  // the bearing allows. Motors 1/2/4 absorb the deficit.
  const rpm1 = new Float64Array(n);
  const rpm2 = new Float64Array(n);
  const rpm3 = new Float64Array(n);
  const rpm4 = new Float64Array(n);
  const pwm1 = new Float64Array(n);
  const pwm2 = new Float64Array(n);
  const pwm3 = new Float64Array(n);
  const pwm4 = new Float64Array(n);

  // Thrust demand is a feed-forward on the TARGET trajectory plus PD on altitude error, not a
  // back-solve from what actually happened. That is the difference between "the motors slowed so
  // it fell" and the truth here: the loop asked for everything it had and the airframe still fell.
  const azTargetRaw = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    azTargetRaw[i] = (altTarget[i + 1] - 2 * altTarget[i] + altTarget[i - 1]) / (dt * dt);
  }
  azTargetRaw[0] = azTargetRaw[1];
  azTargetRaw[n - 1] = azTargetRaw[n - 2];
  const azT = lowpass(azTargetRaw, 0.14, dt);

  const errArr = new Float64Array(n);
  for (let i = 0; i < n; i++) errArr[i] = altTarget[i] - alt[i];
  const errRate = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) errRate[i] = (errArr[i + 1] - errArr[i - 1]) / (2 * dt);
  errRate[0] = errRate[1];
  errRate[n - 1] = errRate[n - 2];
  const errRateF = lowpass(errRate, 0.12, dt);

  // pass 1: motor 3 only, so its thrust is known before the others are allocated
  const thrust3 = new Float64Array(n);
  const r3Arr = new Float64Array(n);
  const tTotArr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = t[i];
    const tilt = Math.cos((roll[i] * Math.PI) / 180) * Math.cos((pitch[i] * Math.PI) / 180);
    const tTot = clamp(
      (MASS * (G + clamp(azT[i], -7, 7))) / Math.max(tilt, 0.6) +
        KP_ALT * errArr[i] +
        KD_ALT * errRateF[i],
      0,
      T_MAX
    );
    tTotArr[i] = tTot;

    const h = health3(s);
    const rpmTarget = Math.sqrt(tTot / 4 / CT);
    const p3 = clamp(rpmTarget / (K_RPM * h), 0, 100);
    const oscAmp = 420 * smoothstep((s - 40) / 18) * (1 + 0.9 * smoothstep((s - T_FAIL) / 0.5));
    const osc = Math.sin(s * 2 * Math.PI * 4.2) * oscAmp * (0.7 + 0.6 * rumble(s * 1.7));
    const r3 = Math.max(K_RPM * p3 * h + osc, 0);
    r3Arr[i] = r3;
    pwm3[i] = p3;
    thrust3[i] = CT * r3 * r3;
  }

  // The attitude/altitude loop is nowhere near fast enough to chase a 4.2 Hz bearing rumble, so
  // motors 1/2/4 only take up the slow component of motor 3's shortfall.
  const thrust3Slow = lowpass(thrust3, 0.55, dt);

  // pass 2: allocate what is left across the healthy three
  for (let i = 0; i < n; i++) {
    const s = t[i];
    const spool = smoothstep((s - T_SPOOL) / 0.85) * (1 - smoothstep((s - (T_TOUCHDOWN + 0.2)) / 1.5));
    const share = Math.max((tTotArr[i] - thrust3Slow[i]) / 3, 0.02);
    const pBase = clamp(Math.sqrt(share / CT) / K_RPM, 0, 100);

    // small differential trim so the three healthy traces are not one line
    const trimA = (rumble(s * 0.9 + 11) - 0.5) * 0.9;
    const trimB = (rumble(s * 0.9 + 23) - 0.5) * 0.9;

    pwm1[i] = clamp(pBase + trimA, 0, 100) * spool;
    pwm2[i] = clamp(pBase - trimA * 0.6 + trimB, 0, 100) * spool;
    pwm4[i] = clamp(pBase - trimB, 0, 100) * spool;
    pwm3[i] = pwm3[i] * spool;

    rpm1[i] = Math.max(K_RPM * pwm1[i] + gaussian(rnd, 0, 9), 0);
    rpm2[i] = Math.max(K_RPM * pwm2[i] + gaussian(rnd, 0, 9), 0);
    rpm4[i] = Math.max(K_RPM * pwm4[i] + gaussian(rnd, 0, 9), 0);
    rpm3[i] = Math.max(r3Arr[i] * spool + gaussian(rnd, 0, 9), 0);
  }

  // ---- 5. pack ------------------------------------------------------------
  // Shaft power scales with rpm^3; the worn bearing burns extra on top, which is what bends the
  // voltage curve at ~40 s. Voltage is open-circuit minus charge drawn minus IR sag.
  const m = Math.round(duration * BAT_RATE) + 1;
  const bt = new Float64Array(m);
  const amps = new Float64Array(m);
  const volts = new Float64Array(m);

  const C_P = 2.355e-10; // W per rpm^3, one motor
  const C_BEAR = 5.2e-6; // W per rpm^2 per unit of lost health
  const R_INT = 0.024; // ohm, pack + wiring
  const V_OC0 = 16.9;
  const K_Q = 0.0016; // V lost per amp-second drawn

  let charge = 0;
  let vPrev = 16.6;
  for (let j = 0; j < m; j++) {
    const s = j / BAT_RATE;
    bt[j] = s;
    const i = Math.min(Math.round(s * rate), n - 1);
    const shaft =
      C_P * (Math.pow(rpm1[i], 3) + Math.pow(rpm2[i], 3) + Math.pow(rpm4[i], 3) + Math.pow(rpm3[i], 3));
    const h = health3(s);
    const bearing = rpm3[i] > 200 ? C_BEAR * (1 / h - 1) * rpm3[i] * rpm3[i] : 0;
    const a = (shaft + bearing) / Math.max(vPrev, 10) + 0.9;
    amps[j] = a;
    charge += a / BAT_RATE;
    const v = V_OC0 - K_Q * charge - R_INT * a;
    volts[j] = v;
    vPrev = v;
  }

  // Calibrate the pack curve to the mandated endpoints (16.80 V armed, 13.90 V at shutdown)
  // without touching its shape, then add ADC noise.
  const scale = (16.8 - 13.9) / (volts[0] - volts[m - 1]);
  const offset = 16.8 - volts[0] * scale;
  for (let j = 0; j < m; j++) {
    volts[j] = volts[j] * scale + offset + gaussian(rnd, 0, 0.011);
    amps[j] += gaussian(rnd, 0, 0.14);
  }

  return {
    '/att': { t, roll, pitch, yaw },
    '/pos': { t, x, y, alt },
    '/motors': { t, rpm1, rpm2, rpm3, rpm4, pwm1, pwm2, pwm3, pwm4 },
    '/bat': { t: bt, v: volts, a: amps },
  };
}
