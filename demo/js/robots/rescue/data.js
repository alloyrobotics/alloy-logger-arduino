// rescue/data.js - tracked rescue robot, 85 s mission over flat debris and up a 28 deg rubble pile.
//
// Story encoded in the signals:
//   0.0 - 43.x  traverse flat debris, two speed changes around obstacles
//   ~44.0       front of the chassis breaks over onto a 28 deg rubble incline
//   47.4-48.4   left track loses grip: cmd_l held, vel_l collapses, i_l runs away to stall current
//   48.4        stall peak, robot yaws off line and starts sliding back
//   48.4-50.6   slides ~0.6 m back down the face, operator gives up at 52.2 and stops
//   57.0-58.4   operator drops the front flippers 0 -> -35 deg
//   59.0-65.x   second attempt: slip back inside budget, crests the top
//   65.x-85     runs out onto the plateau, stops, motors cool
//
// Everything is deterministic: the only randomness is the seeded mulberry32 stream app.js passes in
// plus fixed-seed value-noise lattices. Math.random() is never called.

import { mulberry32, gaussian, fbm1D, clamp, smoothstep } from '../../core/prng.js';

export const duration = 85.0;
export const rate = 50;
const SYS_RATE = 10;

/** Track centre-to-centre separation, m. Used to derive heading from the two track velocities. */
export const TRACK_SEP = 0.56;
/** Half of the track ground-contact length, m. The chassis rides on the chord between +/- this. */
export const CONTACT_HALF = 0.31;

export const channels = [
  {
    path: '/drive',
    fields: [
      { key: 'cmd_l', label: 'cmd_l', unit: 'm/s' },
      { key: 'cmd_r', label: 'cmd_r', unit: 'm/s' },
      { key: 'vel_l', label: 'vel_l', unit: 'm/s' },
      { key: 'vel_r', label: 'vel_r', unit: 'm/s' },
      { key: 'i_l', label: 'i_l', unit: 'A' },
      { key: 'i_r', label: 'i_r', unit: 'A' },
    ],
  },
  {
    path: '/imu',
    fields: [
      { key: 'roll', label: 'roll', unit: 'deg' },
      { key: 'pitch', label: 'pitch', unit: 'deg' },
    ],
  },
  {
    path: '/flipper',
    fields: [
      { key: 'front', label: 'front', unit: 'deg' },
      { key: 'rear', label: 'rear', unit: 'deg' },
    ],
  },
  {
    path: '/sys',
    fields: [
      { key: 'temp_l', label: 'temp_l', unit: 'C' },
      { key: 'temp_r', label: 'temp_r', unit: 'C' },
      { key: 'batt_v', label: 'batt_v', unit: 'V' },
    ],
  },
];

export const findings = [
  {
    id: 'stall',
    title: 'Left track stall at 48.4 s',
    window: [46.0, 54.0],
    t: 48.4,
    severity: 'alert',
    focus: { channel: '/drive', fields: ['cmd_l', 'vel_l', 'i_l'] },
    highlight: 'track_l',
    slowmo: true,
  },
  {
    id: 'thermal',
    title: 'Left drive heating all mission',
    window: [0, 85],
    t: 66.0,
    severity: 'warn',
    focus: { channel: '/sys', fields: ['temp_l', 'temp_r'] },
    highlight: null,
    slowmo: false,
  },
  {
    id: 'retry',
    title: 'Flippers down, second attempt crests',
    window: [56.0, 66.0],
    t: 61.0,
    severity: 'info',
    focus: { channel: '/drive', fields: ['cmd_l', 'vel_l', 'i_l'] },
    highlight: null,
    slowmo: false,
  },
];

// ---------------------------------------------------------------------------- terrain
// The rubble pile is ground truth. Body pitch in /imu is derived from it (two-point track contact),
// and scene.js builds the ramp mesh from the same functions, so the chart and the 3D view can never
// disagree about where the incline is.

/** Distance along the path, in metres, where the rubble incline begins. Measured from the drive
 *  profile: this is d(t=44.0 s), so the robot breaks over exactly at the 44 s mark. */
export const RAMP_D0 = 15.56;
/** Slope length of the incline face, m. */
export const RAMP_LEN = 2.45;
/** Face angle, deg. */
export const RAMP_DEG = 28.0;
const RAMP_BLEND = 0.3;

/** Terrain slope in degrees at arc length d along the path. */
export function terrainPitchDeg(d) {
  const x = d - RAMP_D0;
  if (x <= 0 || x >= RAMP_LEN) return 0;
  const up = smoothstep(x / RAMP_BLEND);
  const down = 1 - smoothstep((x - (RAMP_LEN - RAMP_BLEND)) / RAMP_BLEND);
  return RAMP_DEG * up * down;
}

const TER_STEP = 0.004;
const TER_MAX = 26;
const TER_N = Math.round(TER_MAX / TER_STEP) + 1;
const TER_RUN = new Float64Array(TER_N);
const TER_RISE = new Float64Array(TER_N);
(function buildTerrainTables() {
  let run = 0;
  let rise = 0;
  for (let i = 0; i < TER_N; i++) {
    TER_RUN[i] = run;
    TER_RISE[i] = rise;
    const p = (terrainPitchDeg(i * TER_STEP + TER_STEP / 2) * Math.PI) / 180;
    run += Math.cos(p) * TER_STEP;
    rise += Math.sin(p) * TER_STEP;
  }
})();

function terTable(tab, d) {
  if (d <= 0) return tab === TER_RUN ? d : 0;
  if (d >= TER_MAX) return tab[TER_N - 1] + (tab === TER_RUN ? d - TER_MAX : 0);
  const f = d / TER_STEP;
  const i = Math.floor(f);
  return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
}

/** Horizontal run, m, covered by arc length d along the terrain. */
export function terrainRun(d) {
  return terTable(TER_RUN, d);
}
/** Elevation, m, at arc length d along the terrain. */
export function terrainRise(d) {
  return terTable(TER_RISE, d);
}

/**
 * Two-point track contact model: the chassis rides on the chord between the ground contacts at
 * d - CONTACT_HALF and d + CONTACT_HALF. Returns the chassis pitch and the centre of that chord.
 * @param {number} d arc length along the path, m
 */
export function contactAt(d) {
  const a = d - CONTACT_HALF;
  const b = d + CONTACT_HALF;
  const ra = terrainRun(a);
  const rb = terrainRun(b);
  const ha = terrainRise(a);
  const hb = terrainRise(b);
  return {
    pitchDeg: (Math.atan2(hb - ha, rb - ra) * 180) / Math.PI,
    run: (ra + rb) / 2,
    rise: (ha + hb) / 2,
  };
}

// ---------------------------------------------------------------------------- shaping helpers

/** Smoothstep-interpolated keyframe track. pts = [[t, v], ...] ascending in t. */
function kf(s, pts) {
  const n = pts.length;
  if (s <= pts[0][0]) return pts[0][1];
  if (s >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && pts[i + 1][0] < s) i++;
  const t0 = pts[i][0];
  const v0 = pts[i][1];
  const t1 = pts[i + 1][0];
  const v1 = pts[i + 1][1];
  return v0 + (v1 - v0) * smoothstep((s - t0) / (t1 - t0));
}

/** Rise at t0 over `rise` seconds, fall at t1 over `fall` seconds. Returns 0..1. */
function win(s, t0, rise, t1, fall) {
  return smoothstep((s - t0) / rise) * (1 - smoothstep((s - t1) / fall));
}

// Commanded body speed. The operator holds 0.35 m/s straight through the stall (52.2) before
// backing off, which is exactly why the currents get so ugly.
const KF_CMD = [
  [0.0, 0.0],
  [0.8, 0.0],
  [2.4, 0.42],
  [13.0, 0.42],
  [15.2, 0.2],
  [17.4, 0.2],
  [19.4, 0.46],
  [33.0, 0.46],
  [36.2, 0.3],
  [43.4, 0.3],
  [44.2, 0.35],
  [52.2, 0.35],
  [52.9, 0.0],
  [58.6, 0.0],
  [59.4, 0.35],
  [68.4, 0.35],
  [70.6, 0.3],
  [71.8, 0.0],
  [85.0, 0.0],
];

// Commanded differential (cmd_l - cmd_r). Small course corrections on the flat, then a deliberate
// counter-steer on the second attempt to unwind the 15 deg the stall cost.
const KF_STEER = [
  [0.0, 0.0],
  [6.0, 0.0],
  [7.6, 0.055],
  [9.2, 0.0],
  [10.8, -0.055],
  [12.4, 0.0],
  [24.0, 0.0],
  [25.4, -0.05],
  [27.0, 0.0],
  [28.6, 0.05],
  [30.2, 0.0],
  [59.2, 0.0],
  [60.2, 0.031],
  [64.2, 0.031],
  [65.4, 0.0],
  [85.0, 0.0],
];

// Front flipper angle, deg. Negative is tip down into the rubble.
const KF_FLIP_F = [
  [0.0, 0.0],
  [56.9, 0.0],
  [58.4, -35.0],
  [69.0, -35.0],
  [70.6, -8.0],
  [85.0, -8.0],
];
// Rear flipper angle, deg. Comes down to push once the front bites.
const KF_FLIP_R = [
  [0.0, 0.0],
  [59.8, 0.0],
  [61.2, -15.0],
  [67.5, -15.0],
  [69.0, 0.0],
  [85.0, 0.0],
];

// thermal model: dT/dt = K*i^2 - (C0 + CV*|v|)*(T - AMB). CV is airflow cooling, which is why the
// motors run away once the robot stops moving with current still in them.
const T_AMB = 24.0;
const T_K = 0.01436;
const T_C0 = 0.0058;
const T_CV = 0.0128;

/**
 * @param {() => number} prng seeded mulberry32 stream from app.js
 */
export function buildData(prng) {
  const rnd = prng || mulberry32(0x2e5c);
  const bumpN = fbm1D(mulberry32(0x51f3), 4, 0.55);
  const rockN = fbm1D(mulberry32(0x7a11), 3, 0.6);
  const velN = fbm1D(mulberry32(0x1d47), 3, 0.5);
  const velN2 = fbm1D(mulberry32(0x9c02), 3, 0.5);

  const n = Math.round(duration * rate) + 1;
  const dt = 1 / rate;

  const t = new Float64Array(n);
  const cmdL = new Float64Array(n);
  const cmdR = new Float64Array(n);
  const velL = new Float64Array(n);
  const velR = new Float64Array(n);
  const iL = new Float64Array(n);
  const iR = new Float64Array(n);
  const roll = new Float64Array(n);
  const pitch = new Float64Array(n);
  const flipF = new Float64Array(n);
  const flipR = new Float64Array(n);
  const dist = new Float64Array(n);
  const terPitch = new Float64Array(n);

  // ---- pass 1: commands and track velocities (time scheduled, terrain independent) ----
  for (let i = 0; i < n; i++) {
    const s = i * dt;
    t[i] = s;

    const cmd = kf(s, KF_CMD);
    const steer = kf(s, KF_STEER);
    cmdL[i] = cmd + steer / 2;
    cmdR[i] = cmd - steer / 2;

    // how much of the machine is on the incline (time gated so the drive profile stays independent
    // of the terrain tables, which are keyed off distance)
    const onIncline = win(s, 43.6, 1.6, 64.6, 1.8);
    const moving = clamp(cmd * 9, 0, 1);

    // nominal loss of traction: 5% on packed debris, 14% on loose rubble
    const slipNom = 0.05 + 0.09 * onIncline;

    // the failure: left track lets go first, right follows a second later
    const collapseL = win(s, 47.35, 1.05, 50.9, 1.2);
    const collapseR = win(s, 48.3, 0.5, 50.9, 1.2);
    // the whole machine sliding back down the face under a forward command
    const slide = -0.41 * win(s, 48.45, 0.45, 50.15, 0.65);

    const noiseAmp = (0.011 + 0.026 * onIncline) * (0.14 + 0.86 * moving);
    const nl = (velN(s * 3.1) - 0.5) * 2 * noiseAmp + gaussian(rnd, 0, 0.0035);
    const nr = (velN2(s * 3.0 + 11) - 0.5) * 2 * noiseAmp + gaussian(rnd, 0, 0.0035);

    const baseL = cmdL[i] * (1 - slipNom);
    // when the left track quits, the right one alone cannot hold the climb rate on a 28 deg face,
    // so it droops too. The residual difference is what yaws the machine off line.
    const baseR = cmdR[i] * (1 - slipNom) * (1 - 0.475 * collapseL);
    velL[i] = baseL * (1 - 0.975 * collapseL) + slide + nl;
    velR[i] = baseR * (1 - 0.975 * collapseR) + slide * 0.925 + nr;

    flipF[i] = kf(s, KF_FLIP_F) + (bumpN(s * 1.7 + 40) - 0.5) * 0.7 * onIncline;
    flipR[i] = kf(s, KF_FLIP_R) + (bumpN(s * 1.9 + 70) - 0.5) * 0.7 * onIncline;
  }

  // ---- pass 2: integrate the two tracks into a path, then read pitch off the terrain ----
  let d = 0;
  for (let i = 0; i < n; i++) {
    const v = (velL[i] + velR[i]) / 2;
    d += v * dt;
    dist[i] = d;
    const c = contactAt(d);
    terPitch[i] = c.pitchDeg;
  }

  for (let i = 0; i < n; i++) {
    const s = t[i];
    const onIncline = win(s, 43.6, 1.6, 64.6, 1.8);
    const moving = clamp(Math.abs(velL[i]) * 9, 0, 1);
    // ride noise: packed debris is bumpy, loose rubble is much worse
    const amp = 1.15 + 2.4 * onIncline;
    pitch[i] = terPitch[i] + (bumpN(s * 2.3) - 0.5) * 2 * amp * (0.25 + 0.75 * moving);
    // the left track digging into a void rolls the machine over onto its left side during the stall
    const rollEvent = -7.4 * win(s, 47.6, 0.9, 50.2, 1.6);
    roll[i] =
      (rockN(s * 1.9 + 5) - 0.5) * 2 * (2.4 + 2.3 * onIncline) * (0.3 + 0.7 * moving) + rollEvent;
  }

  // ---- pass 3: currents (need pitch), then thermals and pack voltage ----
  for (let i = 0; i < n; i++) {
    const s = t[i];
    const cmd = (cmdL[i] + cmdR[i]) / 2;
    const onIncline = win(s, 43.6, 1.6, 64.6, 1.8);
    const moving = clamp(cmd * 9, 0, 1);
    const grade = Math.max(0, terPitch[i]);

    // rolling resistance + grade load + flippers ploughing into the rubble
    const base =
      1.12 +
      8.6 * Math.abs(cmd) +
      0.148 * grade * moving +
      0.175 * Math.abs(flipF[i]) * moving * onIncline +
      2.4 * onIncline * (1 - moving); // holding brake current parked on the face

    const stallShape = win(s, 47.35, 1.02, 48.55, 2.1);
    const ripple = (bumpN(s * 6.1 + 3) - 0.5) * 0.9 * moving;

    iL[i] = Math.max(0.35, base + 14.0 * stallShape + 0.6 * onIncline * moving + ripple);
    iR[i] = Math.max(
      0.35,
      base + 2.6 * stallShape + (bumpN(s * 5.7 + 21) - 0.5) * 0.9 * moving
    );
  }

  // thermals integrated at full rate, published at 10 Hz
  const m = Math.round(duration * SYS_RATE) + 1;
  const st = new Float64Array(m);
  const tempL = new Float64Array(m);
  const tempR = new Float64Array(m);
  const battV = new Float64Array(m);

  let tl = 41.0;
  let tr = 39.6;
  const tlFull = new Float64Array(n);
  const trFull = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.abs((velL[i] + velR[i]) / 2);
    const cool = T_C0 + T_CV * v;
    tl += (T_K * iL[i] * iL[i] - cool * (tl - T_AMB)) * dt;
    tr += (T_K * iR[i] * iR[i] - cool * (tr - T_AMB)) * dt;
    tlFull[i] = tl;
    trFull[i] = tr;
  }

  for (let j = 0; j < m; j++) {
    const s = j / SYS_RATE;
    st[j] = s;
    const k = Math.min(Math.round(s * rate), n - 1);
    tempL[j] = tlFull[k] + gaussian(rnd, 0, 0.06);
    tempR[j] = trFull[k] + gaussian(rnd, 0, 0.06);
    battV[j] = 25.3 - 0.0165 * s - 0.062 * (iL[k] + iR[k]) + gaussian(rnd, 0, 0.014);
  }

  return {
    '/drive': { t, cmd_l: cmdL, cmd_r: cmdR, vel_l: velL, vel_r: velR, i_l: iL, i_r: iR },
    '/imu': { t: t.slice(), roll, pitch },
    '/flipper': { t: t.slice(), front: flipF, rear: flipR },
    '/sys': { t: st, temp_l: tempL, temp_r: tempR, batt_v: battV },
  };
}

// ---------------------------------------------------------------------------- derived pose
// Differential-drive dead reckoning off the two logged track velocities. This is how the chat can
// quote a heading error and a slide-back distance that were never logged as fields, and how
// scene.js knows where to put the robot. Memoized per data object.

const poseCache = new WeakMap();

/**
 * @param {{t:Float64Array, vel_l:Float64Array, vel_r:Float64Array}} drive the /drive channel
 * @returns {{t:Float64Array, dist:Float64Array, lat:Float64Array, yaw:Float64Array}}
 *   dist = arc length along the path (m, signed so the slide-back shows), lat = lateral offset (m),
 *   yaw = heading error (deg, positive turns left)
 */
export function derivePose(drive) {
  const hit = poseCache.get(drive);
  if (hit) return hit;

  const n = drive.t.length;
  const dist = new Float64Array(n);
  const lat = new Float64Array(n);
  const yaw = new Float64Array(n);
  let d = 0;
  let l = 0;
  let th = 0;
  for (let i = 0; i < n; i++) {
    const step = i === 0 ? 1 / rate : drive.t[i] - drive.t[i - 1];
    const v = (drive.vel_l[i] + drive.vel_r[i]) / 2;
    const om = (drive.vel_r[i] - drive.vel_l[i]) / TRACK_SEP;
    th += om * step;
    d += v * step;
    l += v * Math.sin(th) * step;
    dist[i] = d;
    lat[i] = l;
    yaw[i] = (th * 180) / Math.PI;
  }
  const out = { t: drive.t, dist, lat, yaw };
  poseCache.set(drive, out);
  return out;
}
