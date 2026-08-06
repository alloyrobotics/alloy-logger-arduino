// arm6/data.js - 6-DOF pick-and-place arm, 80 s @ 50 Hz, 12 transfer cycles between pad A and pad B.
//
// Kinematic chain (0-indexed joints, matching q0..q5 / tau0..tau5; driver boards on the bus are
// numbered 1..6, so J2's driver is drv3):
//   J0 base yaw      - turret rotation about the vertical
//   J1 torso pitch   - short column lean, leans forward as reach grows (26 Nm envelope)
//   J2 shoulder lift - THE load-bearing pitch axis, 12 Nm current clamp   <-- the story
//   J3 elbow pitch   - 8 Nm
//   J4 wrist pitch   - 4 Nm
//   J5 wrist roll    - 2 Nm, counter-rotates the base yaw to keep the part square to the pads
//
// Authoring model: taught poses are converted ONCE to joint vectors by ik(), then the mission is
// interpolated in JOINT space (which is what a real teach-pendant program does). q0..q5 are the
// master signal; /ee is fk(q) using the exact same fk() scene.js imports, so the chat numbers, the
// chart and the 3D replay can never disagree.
//
// Physics: tau1/tau2/tau3 are real gravity moments about their joint origins (sum of m*g*horizontal
// offset over every distal body plus the payload) with an inertial term from the pose-dependent
// distal inertia. tau2 is then hard-clamped at the driver's 12.0 Nm current limit. Whenever demand
// exceeds the clamp the joint back-drives against gearbox damping, which is where err2 comes from.

import { mulberry32, gaussian, fbm1D, clamp, remap } from '../../core/prng.js';

export const duration = 80.0;
export const rate = 50;
/** /sys is a housekeeping channel, logged at 10 Hz like the real firmware does. */
export const SYS_RATE = 10;

// ---------------------------------------------------------------------------
// geometry (metres) - exported so scene.js builds the identical arm
// ---------------------------------------------------------------------------

export const LINKS = {
  Y1: 0.24, // J1 (torso pitch) height above the ground plane
  L1: 0.26, // column,   J1 -> J2
  L2: 0.52, // upper arm, J2 -> J3
  L3: 0.46, // forearm,  J3 -> J4
  L4: 0.20, // wrist + gripper, J4 -> TCP (the point between the jaws)
};

export const CUBE = 0.07; // payload edge length
export const PAD_TOP = 0.10; // pad plate top surface
export const GRASP_Y = PAD_TOP + CUBE / 2; // TCP height when a part is on a pad

/** Masses (kg) and COM offsets (m) of each body, distal to its own joint. */
const BODY = {
  col: { m: 0.30, c: 0.13 }, // column, from J1
  ua: { m: 0.55, c: 0.24 }, // upper arm, from J2
  fa: { m: 0.34, c: 0.21 }, // forearm, from J3
  wr: { m: 0.22, c: 0.10 }, // wrist + gripper, from J4
};

const G = 9.81;

/** Per-joint current clamps (Nm). J2 is the tight one. */
export const TAU_CLAMP = [8.0, 26.0, 12.0, 10.0, 4.0, 2.0];

/** Payload masses (kg): what the program was taught for, and what cycle 9 actually carried. */
export const PAYLOADS = { nominal: 0.25, heavy: 1.2 };
const PAYLOAD_NOMINAL = PAYLOADS.nominal; // printed nylon blank
const PAYLOAD_HEAVY = PAYLOADS.heavy; // cycle 9: same 70 mm envelope, steel blank

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// pads
// ---------------------------------------------------------------------------

/** Taught pad poses in the arm's own polar frame. */
export const PADS = {
  A: { r: 0.60, yaw: -34 },
  B: { r: 0.92, yaw: 38 },
};

function padWorld(p) {
  return { x: p.r * Math.cos(p.yaw * DEG), y: PAD_TOP, z: -p.r * Math.sin(p.yaw * DEG) };
}
export const PAD_A = padWorld(PADS.A);
export const PAD_B = padWorld(PADS.B);

// ---------------------------------------------------------------------------
// forward kinematics - the single source of truth for /ee AND for scene.js
// ---------------------------------------------------------------------------

/**
 * @param {number[]|Float64Array} q six joint angles in degrees
 * @returns {{a1:number,a2:number,a3:number,a4:number,yaw:number,
 *            J1:{r:number,y:number},J2:object,J3:object,J4:object,TCP:object,
 *            world:{J1:object,J2:object,J3:object,J4:object,TCP:object}}}
 *          Sagittal-plane (r, y) frames plus their world (x, y, z) counterparts.
 */
export function fk(q) {
  const a1 = q[1] * DEG;
  const a2 = a1 + q[2] * DEG;
  const a3 = a2 + q[3] * DEG;
  const a4 = a3 + q[4] * DEG;

  const J1 = { r: 0, y: LINKS.Y1 };
  const J2 = { r: J1.r + LINKS.L1 * Math.sin(a1), y: J1.y + LINKS.L1 * Math.cos(a1) };
  const J3 = { r: J2.r + LINKS.L2 * Math.sin(a2), y: J2.y + LINKS.L2 * Math.cos(a2) };
  const J4 = { r: J3.r + LINKS.L3 * Math.sin(a3), y: J3.y + LINKS.L3 * Math.cos(a3) };
  const TCP = { r: J4.r + LINKS.L4 * Math.sin(a4), y: J4.y + LINKS.L4 * Math.cos(a4) };

  const yaw = q[0] * DEG;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const w = (p) => ({ x: p.r * c, y: p.y, z: -p.r * s });

  return {
    a1, a2, a3, a4, yaw,
    J1, J2, J3, J4, TCP,
    world: { J1: w(J1), J2: w(J2), J3: w(J3), J4: w(J4), TCP: w(TCP) },
  };
}

/** Sagittal-plane COM positions of every body, given an fk() frame. */
function coms(f) {
  return {
    col: { r: f.J1.r + BODY.col.c * Math.sin(f.a1), y: f.J1.y + BODY.col.c * Math.cos(f.a1) },
    ua: { r: f.J2.r + BODY.ua.c * Math.sin(f.a2), y: f.J2.y + BODY.ua.c * Math.cos(f.a2) },
    fa: { r: f.J3.r + BODY.fa.c * Math.sin(f.a3), y: f.J3.y + BODY.fa.c * Math.cos(f.a3) },
    wr: { r: f.J4.r + BODY.wr.c * Math.sin(f.a4), y: f.J4.y + BODY.wr.c * Math.cos(f.a4) },
  };
}

// ---------------------------------------------------------------------------
// inverse kinematics - taught poses -> joint vectors (run once per taught point)
// ---------------------------------------------------------------------------

/**
 * Planar IK for the taught pose {r, y, yaw}. The tool is held vertical (pointing straight down),
 * which is how the pick-and-place program was taught.
 * @returns {number[]} q0..q5 in degrees
 */
export function ik(target) {
  const tool = (target.tool == null ? 180 : target.tool) * DEG;

  // the torso leans forward as the program reaches out, exactly as the taught program does
  const q1 = clamp(remap(target.r, 0.34, 0.92, 0.5, 6.0), 0.5, 6.0);
  const a1 = q1 * DEG;
  const J2 = { r: LINKS.L1 * Math.sin(a1), y: LINKS.Y1 + LINKS.L1 * Math.cos(a1) };

  const P4 = { r: target.r - LINKS.L4 * Math.sin(tool), y: target.y - LINKS.L4 * Math.cos(tool) };
  const dr = P4.r - J2.r;
  const dy = P4.y - J2.y;
  const reach = Math.min(Math.hypot(dr, dy), (LINKS.L2 + LINKS.L3) * 0.999);

  const ang = Math.atan2(dr, dy);
  const alpha = Math.acos(
    clamp((LINKS.L2 * LINKS.L2 + reach * reach - LINKS.L3 * LINKS.L3) / (2 * LINKS.L2 * reach), -1, 1)
  );
  const beta = Math.acos(
    clamp((LINKS.L3 * LINKS.L3 + reach * reach - LINKS.L2 * LINKS.L2) / (2 * LINKS.L3 * reach), -1, 1)
  );

  const a2 = ang - alpha; // elbow-up
  const a3 = ang + beta;
  const a4 = tool;

  return [
    target.yaw,
    q1,
    (a2 - a1) / DEG,
    (a3 - a2) / DEG,
    (a4 - a3) / DEG,
    -target.yaw * 0.85, // wrist roll keeps the part square to the pad
  ];
}

// ---------------------------------------------------------------------------
// mission program
// ---------------------------------------------------------------------------

const HOME = { r: 0.34, y: 0.62, yaw: 0 };

/**
 * Taught waypoint fractions of a nominal transfer cycle: [fraction, kind, height, tool angle].
 * The tool is held vertical except through the transfer, where the program tilts it back 12 deg so
 * the part is pressed into the jaw seat instead of sliding on the pads.
 */
const CYCLE_KF = [
  [0.00, 'over-pick', 0.44, 180],
  [0.18, 'over-pick', 0.33, 180],
  [0.34, 'at-pick', GRASP_Y, 180],
  [0.42, 'at-pick', GRASP_Y, 180],
  [0.56, 'over-pick', 0.40, 174],
  [0.72, 'mid', 0.46, 168],
  [0.88, 'over-place', 0.34, 174],
  [1.00, 'at-place', GRASP_Y, 180],
];

const GRIP_CLOSE_F = 0.38;
const GRIP_OPEN_F = 0.99;

/** Cycle schedule: [start, end, from-pad, to-pad]. Cycle 9 is the fault cycle. */
export const CYCLES = [
  [2.0, 8.0, 'A', 'B'],
  [8.0, 14.0, 'B', 'A'],
  [14.0, 20.0, 'A', 'B'],
  [20.0, 26.0, 'B', 'A'],
  [26.0, 32.0, 'A', 'B'],
  [32.0, 38.0, 'B', 'A'],
  [38.0, 44.0, 'A', 'B'],
  [44.0, 50.0, 'B', 'A'],
  [50.0, 58.4, 'A', 'B'], // fault cycle, bespoke keyframes below
  [61.4, 67.6, 'A', 'B'],
  [67.6, 73.8, 'B', 'A'],
  [73.8, 80.0, 'A', 'B'],
];

/** t of the heavy part being swapped onto pad A by the operator, between cycle 8 and cycle 9. */
export const SWAP_T = 50.6;
/** t of a fresh nominal part being placed on pad A after the arm re-homes. */
export const RESET_T = 61.6;
/** t at which the jaw gap encoder reports the part gone. */
export const DROP_T = 56.3;
/** t of the release the program actually commanded, at the pad B place point. */
export const PROGRAMMED_RELEASE_T = 58.4;

function poseFor(kind, y, tool, from, to) {
  if (kind === 'mid') {
    return {
      r: (PADS[from].r + PADS[to].r) / 2 + 0.06,
      y,
      tool,
      yaw: (PADS[from].yaw + PADS[to].yaw) / 2,
    };
  }
  const pad = kind === 'at-pick' || kind === 'over-pick' ? PADS[from] : PADS[to];
  return { r: pad.r, y, tool, yaw: pad.yaw };
}

/** Build the whole mission as an ordered list of taught points plus gripper events. */
function buildProgram() {
  const kf = [{ t: 0.0, pose: { ...HOME } }];
  const grip = [{ t: 0.0, v: 0 }];

  CYCLES.forEach(([t0, t1, from, to], idx) => {
    const cycle = idx + 1;

    if (cycle === 9) {
      // The fault cycle is taught with absolute times. Same pads, same pick-lift-transfer-place
      // sequence as every other A to B cycle, but it runs long: the motion controller waits for J2
      // to reach position and J2 is back-driving, so the transfer stretches to ~5.9 s.
      const P = PADS[from];
      const Q = PADS[to];
      kf.push({ t: 51.1, pose: { r: P.r, y: 0.33, yaw: P.yaw, tool: 180 } });
      kf.push({ t: 52.1, pose: { r: P.r, y: GRASP_Y, yaw: P.yaw, tool: 180 } });
      kf.push({ t: 52.8, pose: { r: P.r, y: GRASP_Y, yaw: P.yaw, tool: 180 } });
      kf.push({ t: 54.0, pose: { r: 0.685, y: 0.34, yaw: -26, tool: 174 } });
      kf.push({ t: 55.6, pose: { r: 0.90, y: 0.46, yaw: -4, tool: 168 } });
      kf.push({ t: 57.4, pose: { r: Q.r, y: 0.34, yaw: Q.yaw, tool: 174 } });
      kf.push({ t: 58.4, pose: { r: Q.r, y: GRASP_Y, yaw: Q.yaw, tool: 180 } });
      // recovery: lift clear, then re-home
      kf.push({ t: 59.2, pose: { r: Q.r, y: 0.40, yaw: Q.yaw, tool: 180 } });
      kf.push({ t: 60.2, pose: { r: 0.55, y: 0.60, yaw: 8, tool: 180 } });
      kf.push({ t: 61.0, pose: { ...HOME } });
      grip.push({ t: 52.5, v: 1 });
      grip.push({ t: DROP_T, v: 0 });
      return;
    }

    const T = t1 - t0;
    CYCLE_KF.forEach(([f, kind, y, tool], j) => {
      // the first taught point of a cycle is the last of the previous one; skip the duplicate
      if (j === 0 && idx > 0) return;
      kf.push({ t: t0 + f * T, pose: poseFor(kind, y, tool, from, to) });
    });
    grip.push({ t: t0 + GRIP_CLOSE_F * T, v: 1 });
    grip.push({ t: t0 + GRIP_OPEN_F * T, v: 0 });
  });

  kf.sort((a, b) => a.t - b.t);
  grip.sort((a, b) => a.t - b.t);
  return { kf, grip };
}

// ---------------------------------------------------------------------------
// channels / findings
// ---------------------------------------------------------------------------

export const channels = [
  {
    path: '/joints',
    fields: [
      { key: 'q0', label: 'q0 base', unit: 'deg' },
      { key: 'q1', label: 'q1 torso', unit: 'deg' },
      { key: 'q2', label: 'q2 shoulder', unit: 'deg' },
      { key: 'q3', label: 'q3 elbow', unit: 'deg' },
      { key: 'q4', label: 'q4 wrist', unit: 'deg' },
      { key: 'q5', label: 'q5 roll', unit: 'deg' },
      { key: 'tau0', label: 'tau0', unit: 'Nm' },
      { key: 'tau1', label: 'tau1', unit: 'Nm' },
      { key: 'tau2', label: 'tau2', unit: 'Nm' },
      { key: 'tau3', label: 'tau3', unit: 'Nm' },
      { key: 'tau4', label: 'tau4', unit: 'Nm' },
      { key: 'tau5', label: 'tau5', unit: 'Nm' },
    ],
  },
  {
    path: '/ee',
    fields: [
      { key: 'x', label: 'x', unit: 'm' },
      { key: 'y', label: 'y', unit: 'm' },
      { key: 'z', label: 'z', unit: 'm' },
      { key: 'grip', label: 'grip', unit: '0|1' },
    ],
  },
  {
    path: '/ctl',
    fields: [
      { key: 'err2', label: 'err2', unit: 'deg' },
      { key: 'err_max', label: 'err_max', unit: 'deg' },
    ],
  },
  {
    path: '/sys',
    fields: [
      { key: 'bus_v', label: 'bus_v', unit: 'V' },
      { key: 'drv3_temp', label: 'drv3_temp', unit: 'C' },
    ],
  },
];

export const findings = [
  {
    id: 'drop',
    title: 'Payload dropped at 56.3 s',
    window: [52, 60],
    // The 3D replay loop, tight around the drop: 0.5 s of the arm carrying the steel blank with
    // tau2 already flat on its 12 Nm clamp, the jaw-gap encoder reporting the part gone at 56.3 s,
    // the 0.29 s fall to the floor (scene.js integrates it ballistically from /ee at the release)
    // and its damped bounce, then the arm finishing the place move with empty jaws. 1.5 s of data,
    // 3.8 s a lap at the slowmo speed, against 20 s a lap when this looped the chart window.
    loop: [DROP_T - 0.5, DROP_T + 1.0],
    t: DROP_T,
    severity: 'alert',
    focus: { channel: '/joints', fields: ['tau2', 'tau1', 'tau3'] },
    highlight: 'j2',
    slowmo: true,
    note:
      'tau2 is the torque the J2 drive reports holding, and tau1 and tau3 are its neighbours. ' +
      'The J2 estimate collapses at the drop instant while the other two barely move: the shoulder ' +
      'back-drives under the commanded path and the arm finishes the place move with empty jaws.',
  },
  {
    id: 'follow-err',
    title: 'J2 following error, 53.9 s',
    window: [53.0, 58.0],
    t: 54.0,
    severity: 'warn',
    focus: { channel: '/ctl', fields: ['err2', 'err_max'] },
    highlight: 'j2',
    slowmo: false,
    note:
      'err2 is the gap between where J2 was commanded to be and where its encoder says it is, and ' +
      'err_max is the worst gap the run has seen. Both open before the payload leaves the gripper.',
  },
  {
    id: 'overtemp',
    title: 'drv3 heating across the run',
    window: [0, 80],
    t: 74.0,
    severity: 'warn',
    focus: { channel: '/sys', fields: ['drv3_temp'] },
    highlight: 'drv3',
    slowmo: false,
    note:
      'drv3_temp is the drive stage\'s own heatsink estimate. It climbs across the whole run ' +
      'rather than during any one move, which is why the window plotted here is the mission.',
  },
];

// ---------------------------------------------------------------------------
// generator
// ---------------------------------------------------------------------------

const B_DROOP = 0.645; // Nm.s/deg - gearbox back-drive damping at J2
const SERVO_W = 11.0; // rad/s - J2 position-loop natural frequency
const SERVO_Z = 0.62; // damping ratio of the catch-up after the load leaves

/** Drive current-feedback filter: what the drive actually logs is a filtered torque estimate. */
const TAU_LPF = 0.10; // s

/** Quintic ease: zero velocity AND zero acceleration at every taught point (no jerk steps). */
function ease5(u) {
  const x = clamp(u, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

const THERM_K = 0.01485; // C/s per Nm^2 into the drv3 heatsink
const THERM_A = 0.0040; // 1/s newtonian cooling to ambient
const THERM_AMB = 26.0;
const THERM_T0 = 38.0; // drv3 starts warm from the previous run

/**
 * @param {() => number} prng seeded mulberry32 stream from app.js
 * @param {{debug?:boolean}} [opts] debug adds a `_debug` channel (generator self-check only)
 */
export function buildData(prng, opts) {
  const rnd = prng || mulberry32(0x4a12);
  const mesh = fbm1D(mulberry32(0x2f13), 3, 0.5); // gear-mesh ripple on the torque channels
  const { kf, grip: gripEvents } = buildProgram();

  const jointsAt = kf.map((k) => ik(k.pose));

  const n = Math.round(duration * rate) + 1;
  const dt = 1 / rate;

  const t = new Float64Array(n);
  const q = [];
  const tau = [];
  for (let j = 0; j < 6; j++) {
    q.push(new Float64Array(n));
    tau.push(new Float64Array(n));
  }
  const eeX = new Float64Array(n);
  const eeY = new Float64Array(n);
  const eeZ = new Float64Array(n);
  const gripA = new Float64Array(n);
  const err2A = new Float64Array(n);
  const errMaxA = new Float64Array(n);
  const dbg = opts && opts.debug ? { grav2: new Float64Array(n), inert2: new Float64Array(n), dem2: new Float64Array(n), payload: new Float64Array(n) } : null;

  let seg = 0;
  let gi = 0;
  let gripV = 0;
  let errS = 0; // signed J2 following error, deg (positive = the arm has drooped)
  let errV = 0; // deg/s
  const qCmdPrev = new Float64Array(6);
  const qCmdPrev2 = new Float64Array(6);
  const qMeas = new Float64Array(6);
  const demF = new Float64Array(6); // filtered torque command, carried across samples

  for (let i = 0; i < n; i++) {
    const s = i * dt;
    t[i] = s;

    // ---- commanded joint vector: joint-space interpolation between taught points ----
    while (seg < kf.length - 2 && kf[seg + 1].t <= s) seg++;
    const t0 = kf[seg].t;
    const t1 = kf[seg + 1].t;
    const u = ease5(t1 > t0 ? (s - t0) / (t1 - t0) : 1);
    const A = jointsAt[seg];
    const Bq = jointsAt[seg + 1];
    const qCmd = new Array(6);
    for (let j = 0; j < 6; j++) qCmd[j] = A[j] + (Bq[j] - A[j]) * u;

    // ---- gripper state ----
    while (gi < gripEvents.length - 1 && gripEvents[gi + 1].t <= s) gi++;
    gripV = gripEvents[gi].v;
    gripA[i] = gripV;

    const inFault = s >= 52.5 && s < DROP_T;
    const payload = gripV ? (inFault ? PAYLOAD_HEAVY : PAYLOAD_NOMINAL) : 0;

    // ---- measured pose = command + last sample's droop (one-step lag, physically causal) ----
    for (let j = 0; j < 6; j++) qMeas[j] = qCmd[j];
    qMeas[2] += errS;
    const f = fk(qMeas);
    const c = coms(f);

    // ---- joint velocities / accelerations of the cumulative link angles ----
    const dq = new Array(6);
    const ddq = new Array(6);
    for (let j = 0; j < 6; j++) {
      dq[j] = i > 0 ? (qCmd[j] - qCmdPrev[j]) / dt : 0;
      ddq[j] = i > 1 ? (qCmd[j] - 2 * qCmdPrev[j] + qCmdPrev2[j]) / (dt * dt) : 0;
    }
    // cumulative (world-referenced) pitch rates for J1..J4
    const cumDD = [0, ddq[1], ddq[1] + ddq[2], ddq[1] + ddq[2] + ddq[3], ddq[1] + ddq[2] + ddq[3] + ddq[4]];
    const cumD = [0, dq[1], dq[1] + dq[2], dq[1] + dq[2] + dq[3], dq[1] + dq[2] + dq[3] + dq[4]];

    // ---- gravity moments (Nm) about J1, J2, J3, J4 ----
    const mArm = (px, jx) => px - jx;
    const g1 =
      G *
      (BODY.col.m * mArm(c.col.r, f.J1.r) +
        BODY.ua.m * mArm(c.ua.r, f.J1.r) +
        BODY.fa.m * mArm(c.fa.r, f.J1.r) +
        BODY.wr.m * mArm(c.wr.r, f.J1.r) +
        payload * mArm(f.TCP.r, f.J1.r));
    const g2 =
      G *
      (BODY.ua.m * mArm(c.ua.r, f.J2.r) +
        BODY.fa.m * mArm(c.fa.r, f.J2.r) +
        BODY.wr.m * mArm(c.wr.r, f.J2.r) +
        payload * mArm(f.TCP.r, f.J2.r));
    const g3 =
      G *
      (BODY.fa.m * mArm(c.fa.r, f.J3.r) +
        BODY.wr.m * mArm(c.wr.r, f.J3.r) +
        payload * mArm(f.TCP.r, f.J3.r));
    const g4 = G * (BODY.wr.m * mArm(c.wr.r, f.J4.r) + payload * mArm(f.TCP.r, f.J4.r));

    // ---- pose-dependent distal inertia about each pitch axis (kg.m^2) ----
    const d2 = (p, j) => (p.r - j.r) * (p.r - j.r) + (p.y - j.y) * (p.y - j.y);
    const I2 =
      BODY.ua.m * d2(c.ua, f.J2) +
      BODY.fa.m * d2(c.fa, f.J2) +
      BODY.wr.m * d2(c.wr, f.J2) +
      payload * d2(f.TCP, f.J2);
    const I1 =
      BODY.col.m * d2(c.col, f.J1) +
      BODY.ua.m * d2(c.ua, f.J1) +
      BODY.fa.m * d2(c.fa, f.J1) +
      BODY.wr.m * d2(c.wr, f.J1) +
      payload * d2(f.TCP, f.J1);
    const I3 = BODY.fa.m * d2(c.fa, f.J3) + BODY.wr.m * d2(c.wr, f.J3) + payload * d2(f.TCP, f.J3);
    // base yaw sees the horizontal moment of inertia of everything outboard
    const I0 =
      BODY.ua.m * c.ua.r * c.ua.r +
      BODY.fa.m * c.fa.r * c.fa.r +
      BODY.wr.m * c.wr.r * c.wr.r +
      payload * f.TCP.r * f.TCP.r +
      0.06;

    const ripple = (k) => (mesh(s * k) - 0.5) * 0.09;

    // ---- torque demand per joint ----
    const dem = new Array(6);
    dem[0] = I0 * ddq[0] * DEG + 0.009 * dq[0] + gaussian(rnd, 0, 0.05) + ripple(6.1);
    dem[1] = g1 + I1 * cumDD[1] * DEG + 0.014 * cumD[1] + gaussian(rnd, 0, 0.07) + ripple(4.3);
    dem[2] = g2 + I2 * cumDD[2] * DEG + 0.012 * cumD[2] + gaussian(rnd, 0, 0.06) + ripple(5.2);
    dem[3] = g3 + I3 * cumDD[3] * DEG + 0.008 * cumD[3] + gaussian(rnd, 0, 0.04) + ripple(7.4);
    dem[4] = g4 + 0.004 * cumD[4] + gaussian(rnd, 0, 0.025) + ripple(9.1);
    dem[5] = 0.0016 * ddq[5] * DEG + 0.002 * dq[5] + gaussian(rnd, 0, 0.015) + ripple(11.3);

    // The drive filters its torque command, then the current limit clips it. Filtering before the
    // clamp is what makes the saturated top a clean flat line at exactly the clamp value.
    const lpf = dt / (TAU_LPF + dt);
    for (let j = 0; j < 6; j++) {
      demF[j] = i === 0 ? dem[j] : demF[j] + (dem[j] - demF[j]) * lpf;
      tau[j][i] = clamp(demF[j], -TAU_CLAMP[j], TAU_CLAMP[j]);
    }

    if (dbg) {
      dbg.grav2[i] = g2;
      dbg.inert2[i] = I2 * cumDD[2] * DEG;
      dbg.dem2[i] = demF[2];
      dbg.payload[i] = payload;
    }

    // ---- J2 following error: back-drive while saturated, servo catch-up once it is not ----
    const deficit = Math.max(0, Math.abs(demF[2]) - TAU_CLAMP[2]);
    if (deficit > 0) {
      errV = deficit / B_DROOP;
      errS += errV * dt;
    } else {
      errV += (-SERVO_W * SERVO_W * errS - 2 * SERVO_Z * SERVO_W * errV) * dt;
      errS += errV * dt;
      if (Math.abs(errS) < 1e-4 && Math.abs(errV) < 1e-3) {
        errS = 0;
        errV = 0;
      }
    }

    // ---- logged following errors (magnitudes, as the drive reports them) ----
    const errs = new Array(6);
    for (let j = 0; j < 6; j++) errs[j] = Math.abs(0.0165 * dq[j]) + Math.abs(gaussian(rnd, 0, 0.012));
    errs[2] = Math.abs(errS) + errs[2];
    err2A[i] = errs[2];
    errMaxA[i] = Math.max.apply(null, errs);

    // ---- log the measured joint vector ----
    for (let j = 0; j < 6; j++) q[j][i] = qMeas[j] + gaussian(rnd, 0, 0.02);

    eeX[i] = f.world.TCP.x;
    eeY[i] = f.world.TCP.y;
    eeZ[i] = f.world.TCP.z;

    for (let j = 0; j < 6; j++) {
      qCmdPrev2[j] = qCmdPrev[j];
      qCmdPrev[j] = qCmd[j];
    }
  }

  // ---- /sys at 10 Hz: bus sag from total drive effort, drv3 thermal state ----
  const m = Math.round(duration * SYS_RATE) + 1;
  const st = new Float64Array(m);
  const busV = new Float64Array(m);
  const drv3 = new Float64Array(m);
  let temp = THERM_T0;
  const sdt = 1 / SYS_RATE;

  for (let j = 0; j < m; j++) {
    const s = j / SYS_RATE;
    st[j] = s;
    const i = Math.min(Math.round(s * rate), n - 1);

    // integrate the thermal state over the fast samples inside this housekeeping tick
    const i0 = Math.max(0, Math.min(Math.round((s - sdt) * rate), n - 1));
    for (let k = i0; k < i; k++) {
      const tq = tau[2][k];
      temp += (THERM_K * tq * tq - THERM_A * (temp - THERM_AMB)) * dt;
    }
    drv3[j] = temp + gaussian(rnd, 0, 0.08);

    let effort = 0;
    for (let jj = 0; jj < 6; jj++) effort += Math.abs(tau[jj][i]);
    const saturated = Math.abs(tau[2][i]) >= TAU_CLAMP[2] - 1e-9 ? 1 : 0;
    const amps = 0.9 + 0.42 * effort + 6.0 * saturated;
    busV[j] = 48.2 - 0.152 * amps + gaussian(rnd, 0, 0.028);
  }

  const out = {
    '/joints': {
      t,
      q0: q[0], q1: q[1], q2: q[2], q3: q[3], q4: q[4], q5: q[5],
      tau0: tau[0], tau1: tau[1], tau2: tau[2], tau3: tau[3], tau4: tau[4], tau5: tau[5],
    },
    '/ee': { t, x: eeX, y: eeY, z: eeZ, grip: gripA },
    '/ctl': { t, err2: err2A, err_max: errMaxA },
    '/sys': { t: st, bus_v: busV, drv3_temp: drv3 },
  };
  if (dbg) out._debug = { t, ...dbg };
  return out;
}
