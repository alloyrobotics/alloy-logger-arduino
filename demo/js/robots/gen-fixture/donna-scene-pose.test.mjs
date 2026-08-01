// donna-scene-pose.test.mjs - the rig contract of donna/scene.js, in plain Node.
//
//   node demo/js/robots/gen-fixture/donna-scene-pose.test.mjs
//
// No browser and no Playwright. `viewer.js` hands buildScene a THREE.Group, so a bare Group off the
// vendored three IS the real calling convention (the same one gen-fixture/harness.mjs uses for the
// generated scenes), and donna/scene.js deliberately never touches `document`. That makes the whole
// rig - frame map, joint tree, axes, signs - provable by `node`, which is the only kind of gate that
// actually runs on every machine.
//
// What it proves:
//
//   1  FRAME MAP. The scene root implements the frozen ROS FLU -> three.js map exactly
//      (three.x = -ros.y, three.y = ros.z, three.z = -ros.x), and the map it implements is the one
//      the payload's own `meta.scene.frameMap` declares.
//
//   2  KNOWN POSES. The two frozen fixture instants, driven through the scene's real torso path,
//      produce the fixture's attitude: upright at t=240.3 s (tilt <= 20 deg) and fallen at
//      t=95.83 s (tilt >= 60 deg). Attitude is measured the way the Phase 0 contract defines it -
//      the full angle between the torso up axis and world vertical, never Euler pitch alone - and
//      it is read off the SCENE's world matrices, not recomputed from the payload, so a rig that
//      applied the quaternion in the wrong frame fails here.
//
//   3  SIGN SANITY. On a mid-walk frame, bending both knees by their recorded angles swings both
//      feet BACKWARD from where a straight knee would put them, by the same amount on both sides.
//      A flipped axis or a flipped sign on either knee sends that foot forward instead, which is
//      the backwards-bending robot this test exists to stop shipping.
//
//   4  APPLIED ANGLES. The rotation the scene actually applies at a joint equals the decoded joint
//      value at that instant, so nothing is scaled, offset or clamped on the way to the screen.
//
//   5  HOLD THEN JUMP. The pose track is never interpolated across a segment boundary.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'donna-fixtures');

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg}  (got ${actual}, want ${expected})`);
}
function near(actual, expected, tol, msg) {
  ok(Math.abs(actual - expected) <= tol, `${msg}  (got ${actual}, want ${expected} +/- ${tol})`);
}
function section(name) {
  console.log(`\n${name}`);
}

const THREE = await import('../../../vendor/three.module.js');
const { buildScene } = await import('../donna/scene.js');
const { decodeDonnaData } = await import('../donna/decode.js');
const fullMod = await import('../donna/donna-data.js');
const M = decodeDonnaData(fullMod);
const known = JSON.parse(await readFile(path.join(FIXTURES, 'known-poses.json'), 'utf8'));

const DEG = 180 / Math.PI;
const scenes = [];
/** A fresh scene over a payload, posed at t. Each one owns its own mount, exactly as the viewer's. */
function stage(data, t) {
  const mount = new THREE.Group();
  const api = buildScene(THREE, mount);
  api.update(t, data);
  scenes.push(api);
  return { mount, api };
}
const node = (mount, name) => mount.getObjectByName(name);

/** The angle between a link's own up axis (ROS +z) and world vertical (three +y), in degrees. */
function tiltOf(mount, linkName) {
  const dir = new THREE.Vector3(0, 0, 1).transformDirection(node(mount, linkName).matrixWorld);
  return Math.acos(Math.max(-1, Math.min(1, dir.y))) * DEG;
}

// ---------------------------------------------------------------- 1. the frame map

section('frame map');

const hero = stage(M, 240.3);
const root = node(hero.mount, 'donna-root');
ok(!!root, 'the scene builds a root node');
eq(
  M.meta.scene.frameMap,
  'three.x=-ros.y; three.y=ros.z; three.z=-ros.x',
  'the payload declares the frozen frame map',
);
for (const [v, want] of [
  [[1, 0, 0], [0, 0, -1]],
  [[0, 1, 0], [-1, 0, 0]],
  [[0, 0, 1], [0, 1, 0]],
  [[1, 2, 3], [-2, 3, -1]],
]) {
  const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(root.matrixWorld);
  const got = [p.x, p.y, p.z].map((n) => Math.round(n * 1e6) / 1e6);
  eq(
    JSON.stringify(got),
    JSON.stringify(want),
    `ros (${v.join(', ')}) lands on three (${want.join(', ')})`,
  );
}
// A rotation, not a reflection: a mirrored root would turn every wound face inside out and would
// swap this robot's left leg for its right one without changing a single number on screen.
const det = new THREE.Matrix3().setFromMatrix4(root.matrixWorld).determinant();
near(det, 1, 1e-9, 'the frame map is a proper rotation (det = +1)');

// ---------------------------------------------------------------- 2. the known-pose fixtures

section('known poses');

// Tolerance, and why it is what it is. The fixture times are RAW IMU message instants
// (240.3011868 s, 95.830722094 s); the replay carries a 25 Hz nearest-sample grid quantized at
// scale 30000, and the scene slerps between the two grid samples that bracket the requested time.
// The residual is the difference between the raw instant and that interpolation, which measures at
// 0.17 deg on both fixtures. 0.5 deg leaves room for the grid without leaving room for a bug: a
// wrong axis, a wrong frame or a doubled yaw all move this by tens of degrees.
const TILT_TOL_DEG = 0.5;

for (const pose of known.poses) {
  const s = pose.name === 'upright' ? hero : stage(M, pose.targetT);
  const tilt = tiltOf(s.mount, 'donna:torso');
  console.log(`  ${pose.name} @ ${pose.targetT}s: scene tilt ${tilt.toFixed(4)} deg, fixture ${pose.tiltDeg} deg`);
  near(tilt, pose.tiltDeg, TILT_TOL_DEG, `${pose.name}: the scene's torso attitude matches the fixture`);
  if (pose.assertion.operator === '<=') {
    ok(tilt <= pose.assertion.degrees, `${pose.name}: scene tilt is inside the upright ceiling (${tilt.toFixed(2)} deg)`);
  } else {
    ok(tilt >= pose.assertion.degrees, `${pose.name}: scene tilt is beyond the fallen floor (${tilt.toFixed(2)} deg)`);
  }
}

// The yaw rule, from the other end: the tilt quaternion carries no yaw of its own, so the torso's
// heading is the localization pose's heading and nothing else.
{
  const p = M.tracks.pose;
  const i = (() => {
    let k = 0;
    while (k + 1 < p.tMs.length && p.tMs[k + 1] <= 240300) k++;
    return k;
  })();
  const robot = node(hero.mount, 'donna:robot');
  near(robot.rotation.z, p.yawRad[i], 0.02, 'the robot heading is the segmented localization yaw');
  eq(robot.rotation.x, 0, 'no heading is applied about ROS x');
  eq(robot.rotation.y, 0, 'no heading is applied about ROS y');
  const q = node(hero.mount, 'donna:torso').quaternion;
  near(q.z, 0, 1e-6, 'the torso attitude quaternion is yaw-free, so yaw is never applied twice');
}

// ---------------------------------------------------------------- 3. knee sign sanity

section('knee sign sanity');

// The same mid-walk instant, once as recorded and once with both knee columns forced to zero. Only
// the knees differ, so the difference in each foot IS the knee's contribution.
const zeroCol = new Float64Array(M.tracks.joints.LKnee.length);
const kneesStraight = {
  ...M,
  tracks: { ...M.tracks, joints: { ...M.tracks.joints, LKnee: zeroCol, RKnee: zeroCol } },
};
const straight = stage(kneesStraight, 240.3);

const deltas = {};
for (const side of ['l', 'r']) {
  const at = (s) => {
    const p = new THREE.Vector3();
    node(s.mount, `donna:${side}_foot`).getWorldPosition(p);
    node(s.mount, 'donna:torso').worldToLocal(p); // torso frame: heading, tilt and lift all removed
    return p;
  };
  deltas[side] = at(hero).sub(at(straight));
}
const jointsSpec = M.meta.tracks.joints;
const kneeAt = (name, t) => {
  const x = (t * 1000 - jointsSpec.timing.startMs) / jointsSpec.timing.stepMs;
  const i0 = Math.floor(x);
  const col = M.tracks.joints[name];
  return col[i0] + (col[i0 + 1] - col[i0]) * (x - i0);
};
const lKnee = kneeAt('LKnee', 240.3);
const rKnee = kneeAt('RKnee', 240.3);
console.log(
  `  knee contribution at 240.3 s: left dx ${deltas.l.x.toFixed(4)} m, right dx ${deltas.r.x.toFixed(4)} m` +
    ` (LKnee ${lKnee.toFixed(4)} rad, RKnee ${rKnee.toFixed(4)} rad)`,
);
ok(lKnee > 0.5, `the fixture frame really has a bent left knee  (LKnee ${lKnee.toFixed(3)} rad)`);
ok(rKnee < -0.5, `the fixture frame really has a bent right knee  (RKnee ${rKnee.toFixed(3)} rad)`);
// The URDF gives the two knees OPPOSITE axes and therefore opposite limit ranges (LKnee 0..2.9671,
// RKnee -2.9671..0). Both bends must still take the foot the same way: backwards.
ok(
  deltas.l.x <= -0.15,
  `bending the left knee swings the left foot BACKWARD  (dx ${deltas.l.x.toFixed(3)} m, want <= -0.15)`,
);
ok(
  deltas.r.x <= -0.15,
  `bending the right knee swings the right foot BACKWARD  (dx ${deltas.r.x.toFixed(3)} m, want <= -0.15)`,
);
near(
  deltas.l.x,
  deltas.r.x,
  0.06,
  'both knees bend by the same amount in the same direction (a flipped sign would differ by ~0.55 m)',
);

// ---------------------------------------------------------------- 4. applied joint angles

section('applied joint angles');

// Recover the rotation the scene applied at a joint by undoing that joint's fixed URDF origin, and
// compare it with the decoded value at the same instant. Nothing is scaled, offset or clamped.
const ORIGIN_RPY = {
  LKnee: [1.5708, 0, 2.87979],
  RKnee: [0, -0.261799, 0],
  LAnklePitch: [-1.5708, 0, 3.14159],
  RAnklePitch: [-1.5708, 0, 0],
  LHipPitch: [0, -1.5708, 0],
  RHipPitch: [-1.5708, 1.5708, 0],
  HeadPan: [-3.14159, 0, 0],
};
const ORIGIN_AXIS = {
  LKnee: [0, 1, 0],
  RKnee: [0, -1, 0],
  LAnklePitch: [0, 0, -1],
  RAnklePitch: [0, 0, -1],
  LHipPitch: [0, 0, -1],
  RHipPitch: [0, 1, 0],
  HeadPan: [0, 0, -1],
};
const CHILD_OF = {
  LKnee: 'l_lower_leg',
  RKnee: 'r_lower_leg',
  LAnklePitch: 'l_ankle',
  RAnklePitch: 'r_ankle',
  LHipPitch: 'l_upper_leg',
  RHipPitch: 'r_upper_leg',
  HeadPan: 'neck',
};
for (const name of Object.keys(CHILD_OF)) {
  const rpy = ORIGIN_RPY[name];
  const qFixed = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  const applied = qFixed.invert().multiply(node(hero.mount, `donna:${CHILD_OF[name]}`).quaternion);
  const axis = new THREE.Vector3(...ORIGIN_AXIS[name]);
  const v = new THREE.Vector3(applied.x, applied.y, applied.z);
  let angle = 2 * Math.atan2(v.length(), applied.w);
  if (angle > Math.PI) angle -= Math.PI * 2;
  if (v.dot(axis) < 0) angle = -angle;
  const want = kneeAt(name, 240.3);
  near(angle, want, 1e-6, `${name}: the scene applies the decoded angle about the URDF axis`);
}

// ---------------------------------------------------------------- 5. hold then jump

section('hold then jump across a segment boundary');

{
  const p = M.tracks.pose;
  let boundary = -1;
  for (let i = 1; i < p.segment.length; i++) {
    if (p.segment[i] !== p.segment[i - 1] && p.tMs[i] - p.tMs[i - 1] > 60) {
      boundary = i;
      break;
    }
  }
  ok(boundary > 0, 'the payload carries a segment boundary with a gap to hold across');
  const robot = node(hero.mount, 'donna:robot');
  const tBefore = (p.tMs[boundary] - 1) / 1000;
  hero.api.update(tBefore, M);
  near(robot.position.x, p.xM[boundary - 1], 1e-9, 'the pose HOLDS at the last sample of the old segment');
  near(robot.position.y, p.yM[boundary - 1], 1e-9, 'and holds in y too');
  hero.api.update(p.tMs[boundary] / 1000, M);
  near(robot.position.x, p.xM[boundary], 1e-9, 'and JUMPS to the first sample of the new one');
  near(robot.position.y, p.yM[boundary], 1e-9, 'and jumps in y too');

  // inside a segment it interpolates, which is the other half of the rule
  let inside = -1;
  for (let i = 1; i < p.segment.length - 1; i++) {
    if (p.segment[i] === p.segment[i + 1] && Math.abs(p.xM[i + 1] - p.xM[i]) > 0.01) {
      inside = i;
      break;
    }
  }
  ok(inside > 0, 'the payload carries a moving sample pair inside one segment');
  const mid = (p.tMs[inside] + p.tMs[inside + 1]) / 2000;
  hero.api.update(mid, M);
  near(
    robot.position.x,
    (p.xM[inside] + p.xM[inside + 1]) / 2,
    1e-6,
    'inside a segment the pose interpolates',
  );
}

// ---------------------------------------------------------------- 6. the ball marker

section('ball marker');

{
  hero.api.update(240.3, M);
  const ball = node(hero.mount, 'donna:ball');
  const b = M.tracks.ballField;
  const i = Math.round((240.3 * 1000 - M.meta.tracks.ballField.timing.startMs) / 200);
  ok(ball.visible, 'the ball is drawn at the hero moment, where the log has an estimate');
  near(ball.position.x, b.xM[i], 0.02, 'at the recorded field x');
  near(ball.position.y, b.yM[i], 0.02, 'at the recorded field y');

  // This log masks exactly two of its 1531 ball ticks, and both are isolated, so the hidden window
  // around one of them is the only place the absence path is exercised by the real payload.
  const absent = [];
  for (let k = 0; k < b.ballSeen.length; k++) if (b.ballSeen[k] < 0.5) absent.push(k);
  ok(absent.length > 0, `the log carries masked-absent ball ticks  (${absent.length})`);
  const step = M.meta.tracks.ballField.timing.stepMs;
  const at = (idx) => (M.meta.tracks.ballField.timing.startMs + idx * step) / 1000;
  for (const k of absent) {
    hero.api.update(at(k), M);
    eq(ball.visible, false, `the ball is HIDDEN at masked tick ${k}  (t=${at(k)} s)`);
    if (k > 0) {
      hero.api.update(at(k) - step / 2000, M);
      eq(ball.visible, false, `and stays hidden approaching tick ${k}, never interpolating into filler zeros`);
    }
  }
  // ...and comes back the moment the mask does
  hero.api.update(at(absent[absent.length - 1] + 2), M);
  eq(ball.visible, true, 'and returns as soon as the mask says the filter has an estimate again');
}

// ---------------------------------------------------------------- 7. teardown

section('teardown');

for (const api of scenes) api.dispose();
ok(true, 'every staged scene disposes without throwing');

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
