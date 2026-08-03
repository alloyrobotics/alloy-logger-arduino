// donna-scene-pose.test.mjs - the three-robot rig contract of donna/scene.js, in plain Node.
//
//   node demo/js/robots/gen-fixture/donna-scene-pose.test.mjs
//
// No browser and no Playwright. `viewer.js` hands buildScene a THREE.Group, so a bare Group off the
// vendored three IS the real calling convention (the same one gen-fixture/harness.mjs uses for the
// generated scenes), and donna/scene.js deliberately never touches `document` - the CAD bodies and
// the bitmap name tags included. That makes the whole rig - frame map, joint tree, axes, signs,
// visual assembly, presence classes - provable by `node`, which is the only kind of gate that
// actually runs on every machine.
//
// What it proves:
//
//   1  FRAME MAP. The scene root implements the frozen ROS FLU -> three.js map exactly
//      (three.x = -ros.y, three.y = ros.z, three.z = -ros.x), and the map it implements is the one
//      the payload's own `meta.scene.frameMap` declares.
//
//   2  KNOWN POSES - EXACTLY FOUR, and four is all there can be. donna-upright, jack-upright and
//      rory-upright at the frozen hero moment, plus jack-fallen inside his first fall. Donna and
//      Rory never fall inside the mission window (the ledger's window fall counts are 0 / 3 / 0),
//      so a donna-fallen or a rory-fallen fixture could only be invented, and none is claimed.
//      Attitude is measured the way the contract defines it - the full angle between the torso up
//      axis and world vertical, never Euler pitch alone - and it is read off the SCENE's world
//      matrices, not recomputed from the payload, so a rig that applied the quaternion in the wrong
//      frame fails here.
//
//   3  VISUAL ASSEMBLY. The frozen contract is
//      `instance_world = bone_world[driven_ancestor] * pre_composed`. scene.js honours it by BAKING
//      each pre-composed transform into a merged per-(bucket, material class) geometry, which is a
//      performance decision that must not become a correctness one. So six named instances - two on
//      the ROOT/TORSO bucket, a foot cleat at the deepest leg chain, the head camera, a hand and a
//      lower leg - are re-derived here by an FK written from the URDF rig table, checked against the
//      frozen fixture, and then LOCATED inside the scene's merged geometry. An instance hung off the
//      wrong ancestor lands centimetres away and is not found.
//
//   4  SIGN SANITY. On the hero frame, bending both knees by their recorded angles swings both feet
//      BACKWARD from where a straight knee would put them, by the same amount on both sides. A
//      flipped axis or a flipped sign on either knee sends that foot forward instead, which is the
//      backwards-bending robot this test exists to stop shipping.
//
//   5  APPLIED ANGLES. The rotation the scene actually applies at a joint equals the decoded joint
//      value at that instant, so nothing is scaled, offset or clamped on the way to the screen.
//
//   6  PRESENCE CLASSES. LIVE interpolates inside a segment and holds across a boundary; HOLD
//      freezes the ROOT while joints and IMU keep replaying (which is what makes Jack's recorded
//      fall visible at all); HIDDEN removes the body from the pitch entirely and never back-fills
//      an unobserved pose.
//
//   7  THE BALL. Masked on `ballSeen`, and masked again whenever Donna herself is not on the pitch.

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
const fallWindows = JSON.parse(await readFile(path.join(FIXTURES, 'jack-fall-windows.json'), 'utf8'));

const DEG = 180 / Math.PI;
const ROBOTS = ['donna', 'jack', 'rory'];
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

/** Joint value at t on that robot's own grid, linearly interpolated - the frozen consumer rule. */
function jointAt(robot, name, t) {
  const spec = M.meta.tracks[`${robot}Joints`];
  const col = M.tracks[`${robot}Joints`][name];
  let x = (t * 1000 - spec.timing.startMs) / spec.timing.stepMs;
  x = Math.max(0, Math.min(spec.count - 1, x));
  const i0 = Math.floor(x);
  const i1 = Math.min(i0 + 1, spec.count - 1);
  return col[i0] + (col[i1] - col[i0]) * (x - i0);
}

// The URDF rig, transcribed here from `rig/RIG.json` INDEPENDENTLY of scene.js. Duplicating it is
// the point: an FK built from the same source but not from the same code is what makes section 3 a
// cross-check rather than a tautology.
const RIG = [
  ['HeadPan', 'torso', 'neck', [-0.0095, 0, 0.2345], [-3.14159, 0, 0], [0, 0, -1]],
  ['HeadTilt', 'neck', 'head', [0.036, 0.0235, -0.024], [-1.5708, 0, 0], [0, 0, 1]],
  ['LShoulderPitch', 'torso', 'l_shoulder', [-0.0015, 0.0765, 0.2035], [-3.14159, 0, 3.14159], [0, 1, 0]],
  ['LShoulderRoll', 'l_shoulder', 'l_upper_arm', [-0.01695, 0.042, 0], [-1.5708, 0, 1.5708], [0, 0, -1]],
  ['LElbow', 'l_upper_arm', 'l_lower_arm', [-0.024, -0.144, -0.0235], [-1.5708, 0, 1.5708], [0, 0, 1]],
  ['RShoulderPitch', 'torso', 'r_shoulder', [-0.0015, -0.0765, 0.2035], [0, 0, -3.14159], [0, 1, 0]],
  ['RShoulderRoll', 'r_shoulder', 'r_upper_arm', [-0.01695, 0.042, 0], [1.5708, 0, -1.5708], [0, 0, -1]],
  ['RElbow', 'r_upper_arm', 'r_lower_arm', [0.024, -0.144, -0.0235], [-1.5708, 0, -1.5708], [0, 0, 1]],
  ['LHipYaw', 'torso', 'l_hip_1', [0, 0.055, 0], [-1.5708, 0, 0], [0, 1, 0]],
  ['LHipRoll', 'l_hip_1', 'l_hip_2', [-0.046, 0.0414, 0], [3.14159, 1.5708, 0], [0, 0, -1]],
  ['LHipPitch', 'l_hip_2', 'l_upper_leg', [0.026, 0, -0.0691], [0, -1.5708, 0], [0, 0, -1]],
  ['LKnee', 'l_upper_leg', 'l_lower_leg', [0.00435596, -0.168793, 0.049], [1.5708, 0, 2.87979], [0, 1, 0]],
  ['LAnklePitch', 'l_lower_leg', 'l_ankle', [0, -0.0505, -0.17], [-1.5708, 0, 3.14159], [0, 0, -1]],
  ['LAnkleRoll', 'l_ankle', 'l_foot', [0.0691, 0, -0.026], [1.5708, -1.5708, 0], [0, -1, 0]],
  ['RHipYaw', 'torso', 'r_hip_1', [0, -0.055, 0], [-1.5708, 0, 0], [0, 1, 0]],
  ['RHipRoll', 'r_hip_1', 'r_hip_2', [-0.046, 0.0414, 0], [-3.14159, 1.5708, 0], [0, 0, -1]],
  ['RHipPitch', 'r_hip_2', 'r_upper_leg', [-0.0265, 0, -0.0691], [-1.5708, 1.5708, 0], [0, 1, 0]],
  ['RKnee', 'r_upper_leg', 'r_lower_leg', [-0.00392295, -0.051, -0.169043], [0, -0.261799, 0], [0, -1, 0]],
  ['RAnklePitch', 'r_lower_leg', 'r_ankle', [0, 0.0505, -0.17], [-1.5708, 0, 0], [0, 0, -1]],
  ['RAnkleRoll', 'r_ankle', 'r_foot', [-0.0691, 0, -0.026], [0, 1.54833, -1.5708], [0, -1, 0]],
];
const CHILD_OF = {};
const ORIGIN_RPY = {};
const ORIGIN_AXIS = {};
for (const [name, , child, , rpy, axis] of RIG) {
  CHILD_OF[name] = child;
  ORIGIN_RPY[name] = rpy;
  ORIGIN_AXIS[name] = axis;
}

/** bone_local[bucket]: each driven bucket's frame expressed in the TORSO link frame, at pose t. */
function boneLocal(robot, t) {
  const out = { 'ROOT/TORSO': new THREE.Matrix4() };
  const world = { torso: new THREE.Matrix4() };
  const one = new THREE.Vector3(1, 1, 1);
  for (const [name, parent, child, xyz, rpy, axis] of RIG) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
    q.multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(),
        jointAt(robot, name, t),
      ),
    );
    const m = new THREE.Matrix4().compose(new THREE.Vector3(xyz[0], xyz[1], xyz[2]), q, one);
    world[child] = new THREE.Matrix4().multiplyMatrices(world[parent], m);
    out[name] = world[child];
  }
  return out;
}

const instById = {};
for (const inst of M.mesh.instances) instById[inst.id] = inst;

// ---------------------------------------------------------------- 1. the frame map

section('frame map');

const hero = stage(M, M.meta.mission.heroTime);
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
// swap every robot's left leg for its right one without changing a single number on screen.
const det = new THREE.Matrix3().setFromMatrix4(root.matrixWorld).determinant();
near(det, 1, 1e-9, 'the frame map is a proper rotation (det = +1)');

// ---------------------------------------------------------------- 2. the four known poses

section('known poses - exactly four');

eq(known.poses.length, 4, 'the fixture set is EXACTLY four poses');
eq(
  known.poses.map((p) => p.name).join(','),
  'donna-upright,jack-upright,rory-upright,jack-fallen',
  'and they are the four the contract names',
);
eq(
  known.poses.filter((p) => p.assertion.operator === '>=').length,
  1,
  'exactly one fallen fixture exists, because only Jack falls inside the window',
);
for (const robot of ['donna', 'rory']) {
  const row = M.events.find((e) => e.id === `${robot}-fall-count`);
  ok(!!row, `the ledger carries ${robot}'s window fall-count row`);
  ok(
    /\b0\b/.test(row.detail),
    `and it reports zero falls, which is why no ${robot}-fallen fixture is claimed  (${row.detail})`,
  );
}

// Tolerance, and why it is what it is. The fixture instants are read off the module's own 20 Hz
// torso grid quantized at scale 30000, and the scene slerps between the two grid samples that
// bracket the requested time - the same interpolation the fixture used, so the only residual is
// float noise plus the scene's own frame chain. 0.25 deg leaves room for that without leaving room
// for a bug: a wrong axis, a wrong frame or a doubled yaw all move this by tens of degrees.
const TILT_TOL_DEG = 0.25;

for (const pose of known.poses) {
  const s = pose.targetT === M.meta.mission.heroTime ? hero : stage(M, pose.targetT);
  const tilt = tiltOf(s.mount, `${pose.robot}:torso`);
  console.log(
    `  ${pose.name.padEnd(14)} @ ${pose.targetT}s: scene tilt ${tilt.toFixed(4)} deg, fixture ${pose.tiltDeg} deg` +
      `  [${pose.presence.className}/${pose.presence.renderMode}, ${pose.robotState}]`,
  );
  near(tilt, pose.tiltDeg, TILT_TOL_DEG, `${pose.name}: the scene's torso attitude matches the fixture`);
  if (pose.assertion.operator === '<=') {
    ok(tilt <= pose.assertion.degrees, `${pose.name}: scene tilt is inside the upright ceiling (${tilt.toFixed(2)} deg)`);
  } else {
    ok(tilt >= pose.assertion.degrees, `${pose.name}: scene tilt is beyond the fallen floor (${tilt.toFixed(2)} deg)`);
  }

  // the body is on the pitch for a fixture that has a body, at the pose the module recorded
  const group = node(s.mount, `${pose.robot}:robot`);
  eq(group.visible, pose.presence.renderMode !== 'HIDDEN', `${pose.name}: presence decides whether a body is drawn`);
  near(group.position.x, pose.fieldPose.xM, 1e-6, `${pose.name}: field x`);
  near(group.position.y, pose.fieldPose.yM, 1e-6, `${pose.name}: field y`);
  near(group.rotation.z, pose.fieldPose.yawRad, 1e-6, `${pose.name}: heading is the localization yaw and nothing else`);
  eq(group.rotation.x, 0, `${pose.name}: no heading about ROS x`);
  eq(group.rotation.y, 0, `${pose.name}: no heading about ROS y`);
  near(
    node(s.mount, `${pose.robot}:torso`).quaternion.z,
    0,
    1e-6,
    `${pose.name}: the torso attitude quaternion is yaw-free, so yaw is never applied twice`,
  );

  // knees and ankles, the four joints the fixture calls out by name
  for (const [jointName, want] of Object.entries(pose.kneeAnkleRad)) {
    near(jointAt(pose.robot, jointName, pose.targetT), want, 1e-9, `${pose.name}: the module's ${jointName} is frozen`);
    const rpy = ORIGIN_RPY[jointName];
    const qFixed = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
    const applied = qFixed.invert().multiply(node(s.mount, `${pose.robot}:${CHILD_OF[jointName]}`).quaternion);
    const axis = new THREE.Vector3(...ORIGIN_AXIS[jointName]).normalize();
    const v = new THREE.Vector3(applied.x, applied.y, applied.z);
    let angle = 2 * Math.atan2(v.length(), applied.w);
    if (angle > Math.PI) angle -= Math.PI * 2;
    if (v.dot(axis) < 0) angle = -angle;
    near(angle, want, 1e-6, `${pose.name}: the scene applies the decoded ${jointName} about the URDF axis`);
  }
  pose.scene = s;
}

// Jack's fallen fixture is sampled at the deepest point of fall 1 rather than inside the FALLEN
// enum, which the recording holds for 21 ms. Both facts are asserted so neither can rot.
{
  const w = known.fallenEnumWindow;
  const f1 = fallWindows.falls.find((f) => f.fall === 1);
  near(w.fallenT, f1.stateTransitions.find((s) => s.stateName === 'FALLEN').t, 1e-9, 'the FALLEN enum instant is frozen');
  near(w.gettingUpT, f1.gettingUpT, 1e-9, 'and so is the GETTING_UP instant that ends it');
  ok(w.gettingUpT - w.fallenT < 0.05, `the FALLEN enum window really is too narrow to sample  (${((w.gettingUpT - w.fallenT) * 1000).toFixed(1)} ms)`);
  const tr = M.tracks.jackRobotState;
  const mid = (w.fallenT + w.gettingUpT) / 2;
  let i = 0;
  while (i + 1 < tr.t10ms.length && tr.t10ms[i + 1] <= mid * 100) i++;
  eq(M.meta.codeTables.robotState[Math.round(tr.state[i])], 'FALLEN', 'and inside it Jack really is FALLEN');
}

// ---------------------------------------------------------------- 3. the visual assembly

section('visual instance assembly');

eq(M.mesh.instances.length, 133, 'the manifest is the frozen 133 placements');
eq(Object.keys(M.mesh.parts).length, 52, 'over the frozen 52 unique meshes');
eq(Object.keys(M.meta.mesh.visualInstances.buckets).length, 21, 'on 21 driven buckets');
eq(
  M.meta.mesh.visualInstances.buckets['ROOT/TORSO'],
  24,
  'with the 24 torso placements on the ROOT/TORSO bucket, which has no revolute ancestor',
);

// The merged geometry must carry every instance's vertices, per robot. A bucket that quietly
// dropped an instance would still render and still look plausible.
{
  const wantVerts = {};
  const wantTris = {};
  for (const inst of M.mesh.instances) {
    const part = M.mesh.parts[inst.part];
    const k = `${inst.bucket}:${inst.materialClass}`;
    wantVerts[k] = (wantVerts[k] || 0) + part.positions.length / 3;
    wantTris[k] = (wantTris[k] || 0) + part.triangleCount;
  }
  let missing = 0;
  let vertBad = 0;
  let triTotal = 0;
  for (const robot of ROBOTS) {
    for (const k of Object.keys(wantVerts)) {
      const mesh = node(hero.mount, `${robot}:${k}`);
      if (!mesh) {
        missing++;
        continue;
      }
      if (mesh.geometry.attributes.position.count !== wantVerts[k]) vertBad++;
      if (mesh.geometry.index.count / 3 !== wantTris[k]) vertBad++;
      triTotal += mesh.geometry.index.count / 3;
    }
  }
  eq(missing, 0, `every (bucket, material class) merge exists on all three bodies  (${Object.keys(wantVerts).length} per body)`);
  eq(vertBad, 0, 'and each one carries exactly its instances\' vertices and triangles');
  eq(triTotal, 20902 * 3, 'three bodies instance the frozen 20,902 triangles each');
}

// Six named instances, re-derived by the independent FK, checked against the frozen fixture, then
// located inside the scene's merged geometry.
{
  const TOL = 2e-5; // the merged positions are float32; the fixture is float64
  for (const pose of known.poses) {
    if (pose.presence.renderMode === 'HIDDEN') continue;
    const bones = boneLocal(pose.robot, pose.targetT);
    const torso = node(pose.scene.mount, `${pose.robot}:torso`);
    torso.updateWorldMatrix(true, true);
    for (const probe of pose.visualInstances) {
      const inst = instById[probe.instanceId];
      ok(!!inst, `${probe.instanceId} is in the decoded manifest`);
      eq(inst.bucket, probe.bucket, `${probe.instanceId} hangs off the ${probe.bucket} bucket`);
      const part = M.mesh.parts[probe.mesh];
      const qw = inst.quaternionWxyz;
      const pre = new THREE.Matrix4().compose(
        new THREE.Vector3(inst.translation[0], inst.translation[1], inst.translation[2]),
        new THREE.Quaternion(qw[1], qw[2], qw[3], qw[0]),
        new THREE.Vector3(1, 1, 1),
      );
      const full = new THREE.Matrix4().multiplyMatrices(bones[inst.bucket], pre);
      const mesh = node(pose.scene.mount, `${pose.robot}:${probe.bucket}:${probe.materialClass}`);
      ok(!!mesh, `${pose.name}: the ${probe.bucket}/${probe.materialClass} merge is in the scene`);
      const pos = mesh.geometry.attributes.position;
      const scratch = new THREE.Vector3();
      for (let k = 0; k < probe.vertexIndices.length; k++) {
        const vi = probe.vertexIndices[k];
        // (a) the independent FK reproduces the frozen fixture point
        const derived = new THREE.Vector3(
          part.positions[vi * 3],
          part.positions[vi * 3 + 1],
          part.positions[vi * 3 + 2],
        ).applyMatrix4(full);
        const want = probe.torsoLocalXYZ[k];
        near(derived.x, want[0], 1e-7, `${pose.name}/${probe.instanceId}#${vi}: FK reproduces the fixture x`);
        near(derived.y, want[1], 1e-7, `${pose.name}/${probe.instanceId}#${vi}: FK reproduces the fixture y`);
        near(derived.z, want[2], 1e-7, `${pose.name}/${probe.instanceId}#${vi}: FK reproduces the fixture z`);
        // (b) and the scene actually put a vertex there. `mesh.matrixWorld` carries the whole chain
        // up through the bucket node, the torso, the body group and the frame map; undoing it back
        // to the torso frame leaves exactly bone_local * pre_composed, which is the contract.
        let best = Infinity;
        for (let i = 0; i < pos.count; i++) {
          scratch.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          torso.worldToLocal(scratch);
          const d = scratch.distanceTo(derived);
          if (d < best) best = d;
        }
        ok(
          best <= TOL,
          `${pose.name}: ${probe.instanceId} vertex ${vi} sits where bone_world[${probe.bucket}] * pre_composed puts it` +
            `  (nearest merged vertex ${best.toExponential(2)} m away, tol ${TOL})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------- 4. knee sign sanity

section('knee sign sanity');

// The same hero instant, once as recorded and once with Donna's two knee columns forced to zero.
// Only the knees differ, so the difference in each foot IS the knee's contribution.
{
  const HERO_T = M.meta.mission.heroTime;
  const zeroCol = new Float64Array(M.tracks.donnaJoints.LKnee.length);
  const kneesStraight = {
    ...M,
    tracks: {
      ...M.tracks,
      donnaJoints: { ...M.tracks.donnaJoints, LKnee: zeroCol, RKnee: zeroCol },
    },
  };
  const straight = stage(kneesStraight, HERO_T);
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
  const lKnee = jointAt('donna', 'LKnee', HERO_T);
  const rKnee = jointAt('donna', 'RKnee', HERO_T);
  console.log(
    `  knee contribution at ${HERO_T} s: left dx ${deltas.l.x.toFixed(4)} m, right dx ${deltas.r.x.toFixed(4)} m` +
      ` (LKnee ${lKnee.toFixed(4)} rad, RKnee ${rKnee.toFixed(4)} rad)`,
  );
  ok(lKnee > 0.5, `the hero frame really has a bent left knee  (LKnee ${lKnee.toFixed(3)} rad)`);
  ok(rKnee < -0.5, `the hero frame really has a bent right knee  (RKnee ${rKnee.toFixed(3)} rad)`);
  // The URDF gives the two knees OPPOSITE axes and therefore opposite limit ranges (LKnee 0..2.9671,
  // RKnee -2.9671..0). Both bends must still take the foot the same way: backwards.
  ok(deltas.l.x <= -0.15, `bending the left knee swings the left foot BACKWARD  (dx ${deltas.l.x.toFixed(3)} m)`);
  ok(deltas.r.x <= -0.15, `bending the right knee swings the right foot BACKWARD  (dx ${deltas.r.x.toFixed(3)} m)`);
  near(deltas.l.x, deltas.r.x, 0.06, 'both knees bend the same way by the same amount');
}

// ---------------------------------------------------------------- 5. applied angles, all 20, all 3

section('applied joint angles');

{
  const HERO_T = M.meta.mission.heroTime;
  let bad = 0;
  for (const robot of ROBOTS) {
    for (const name of Object.keys(CHILD_OF)) {
      const rpy = ORIGIN_RPY[name];
      const qFixed = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
      const applied = qFixed.invert().multiply(node(hero.mount, `${robot}:${CHILD_OF[name]}`).quaternion);
      const axis = new THREE.Vector3(...ORIGIN_AXIS[name]).normalize();
      const v = new THREE.Vector3(applied.x, applied.y, applied.z);
      let angle = 2 * Math.atan2(v.length(), applied.w);
      if (angle > Math.PI) angle -= Math.PI * 2;
      if (v.dot(axis) < 0) angle = -angle;
      if (Math.abs(angle - jointAt(robot, name, HERO_T)) > 1e-6) bad++;
    }
  }
  eq(bad, 0, 'all 20 joints on all three bodies apply their decoded angle about the URDF axis, unscaled and unclamped');
  // ...and each robot is driven by ITS OWN column, not by Donna's.
  const spread = ROBOTS.map((r) => jointAt(r, 'LKnee', HERO_T));
  ok(
    new Set(spread.map((v) => v.toFixed(4))).size === 3,
    `the three bodies are driven by three different logs  (LKnee ${spread.map((v) => v.toFixed(3)).join(' / ')})`,
  );
}

// ---------------------------------------------------------------- 6. presence classes

section('presence classes');

// ---- HOLD. Jack's fall outages: the ROOT freezes at the last observed sample while the joints and
// the IMU keep replaying, which is the only reason the recorded fall is visible at all.
{
  const outage = M.presence.jack.find((s) => s.className === 'fall-outage');
  ok(!!outage, 'Jack has a fall outage to hold across');
  eq(outage.renderMode, 'HOLD', 'and it is classed HOLD, not HIDDEN');
  const group = node(hero.mount, 'jack:robot');
  const knee = node(hero.mount, 'jack:l_lower_leg');
  const inside = [outage.startT + 0.2, (outage.startT + outage.endT) / 2, outage.endT - 0.2];
  hero.api.update(inside[0], M);
  const frozen = group.position.clone();
  const kneeA = knee.quaternion.clone();
  for (const t of inside.slice(1)) {
    hero.api.update(t, M);
    eq(group.visible, true, `HOLD keeps Jack on the pitch at t=${t.toFixed(2)}`);
    near(group.position.x, frozen.x, 1e-12, `HOLD freezes the root x at t=${t.toFixed(2)}`);
    near(group.position.y, frozen.y, 1e-12, `HOLD freezes the root y at t=${t.toFixed(2)}`);
  }
  hero.api.update(inside[2], M);
  ok(knee.quaternion.angleTo(kneeA) > 0.05, `and the joints keep replaying through it  (knee moved ${knee.quaternion.angleTo(kneeA).toFixed(3)} rad)`);
  // the held pose IS the last observed sample, not an average and not the next segment's first
  const before = M.presence.jack.filter((s) => s.className === 'live' && s.endT <= outage.startT).pop();
  ok(!!before, 'the outage follows a live segment');
  hero.api.update(before.endT - 0.02, M);
  near(group.position.x, frozen.x, 2e-3, 'and the frozen pose is the last observed one');
}

// ---- HIDDEN. Donna's penalty and Rory's pre-first-fix window: no body, no decals, no back-fill.
for (const [robot, className] of [['donna', 'penalty-outage'], ['rory', 'pre-first-fix']]) {
  const seg = M.presence[robot].find((s) => s.className === className);
  ok(!!seg, `${robot} has a ${className} interval`);
  eq(seg.renderMode, 'HIDDEN', `and it is classed HIDDEN`);
  const group = node(hero.mount, `${robot}:robot`);
  const contact = node(hero.mount, `${robot}:contact`);
  const ring = node(hero.mount, `${robot}:ring`);
  for (const t of [seg.startT + 0.5, (seg.startT + seg.endT) / 2, seg.endT - 0.5]) {
    hero.api.update(t, M);
    eq(group.visible, false, `${robot} is off the pitch at t=${t.toFixed(2)}`);
    eq(contact.visible, false, `and casts no contact patch at t=${t.toFixed(2)}`);
    eq(ring.visible, false, `and carries no ring at t=${t.toFixed(2)}`);
  }
  hero.api.update(seg.endT + 0.5, M);
  eq(group.visible, true, `${robot} returns the moment her own log observes her again`);
}

// ---- LIVE. Inside a segment the pose interpolates; across a boundary it holds then jumps.
{
  const spec = M.meta.tracks.donnaPose1;
  const c = M.tracks.donnaPose1;
  const base = spec.timing.segmentStart10ms;
  let i = 0;
  while (i + 1 < c.t10ms.length && Math.abs(c.xM[i + 1] - c.xM[i]) < 0.01) i++;
  ok(i + 1 < c.t10ms.length, 'the payload carries a moving sample pair inside one live segment');
  const group = node(hero.mount, 'donna:robot');
  const midTick = (base + c.t10ms[i] + base + c.t10ms[i + 1]) / 2;
  hero.api.update(midTick / 100, M);
  near(group.position.x, (c.xM[i] + c.xM[i + 1]) / 2, 1e-6, 'inside a segment the pose interpolates');
  hero.api.update((base + c.t10ms[i]) / 100, M);
  near(group.position.x, c.xM[i], 1e-9, 'and lands exactly on a sample at its own instant');
}

// ---------------------------------------------------------------- 7. the ball marker

section('ball marker');

{
  const HERO_T = M.meta.mission.heroTime;
  hero.api.update(HERO_T, M);
  const ball = node(hero.mount, 'donna:ball');
  const b = M.tracks.donnaBallField;
  const spec = M.meta.tracks.donnaBallField;
  const i = Math.round((HERO_T * 1000 - spec.timing.startMs) / spec.timing.stepMs);
  ok(ball.visible, 'the ball is drawn at the hero moment, where the log has an estimate');
  near(ball.position.x, b.xM[i], 0.02, 'at the recorded map-frame x');
  near(ball.position.y, b.yM[i], 0.02, 'at the recorded map-frame y');
  ok(ball.position.z >= 0.0684 - 1e-9, 'and never sinks below its own radius');

  const at = (idx) => (spec.timing.startMs + idx * spec.timing.stepMs) / 1000;
  const absent = [];
  for (let k = 0; k < b.ballSeen.length; k++) if (b.ballSeen[k] < 0.5) absent.push(k);
  ok(absent.length > 0, `the log carries masked-absent ball ticks  (${absent.length})`);
  let shown = 0;
  for (const k of absent) {
    hero.api.update(at(k), M);
    if (ball.visible) shown++;
  }
  eq(shown, 0, 'the ball is HIDDEN at every masked tick, never interpolating into filler zeros');

  // The second mask, which the track itself does not carry: `donnaBallField` deliberately does not
  // require Donna's localization to be valid, so it still holds estimates she published while she
  // was off the field. Those are not observations of play and are not drawn.
  const penalty = M.presence.donna.find((s) => s.className === 'penalty-outage');
  let drawnWhileOff = 0;
  let seenTicks = 0;
  for (let k = 0; k < b.ballSeen.length; k++) {
    const t = at(k);
    if (t <= penalty.startT || t >= penalty.endT) continue;
    if (b.ballSeen[k] < 0.5) continue;
    seenTicks++;
    hero.api.update(t, M);
    if (ball.visible) drawnWhileOff++;
  }
  ok(seenTicks > 0, `the track really does carry ball estimates during Donna's penalty  (${seenTicks} ticks)`);
  eq(drawnWhileOff, 0, 'and not one of them is drawn while Donna is off the pitch');
}

// ---------------------------------------------------------------- 8. the proxy material branch

section('proxy lane material');

// CONTRACTS-V2 audit F3: the decimated proxy leaves 14 of the 52 parts with boundary or
// non-manifold edges and two parts with inverted or zero signed volume, so a single-sided material
// renders them with holes. The preview module DOES ship that proxy: `preview-data.js` declares
// `META.mesh.proxy = true` with format `wolfgang-mesh-columns-proxy/1`, so the shipped preview
// takes the branch for real. This asserts both halves: the SEAM (a payload declaring a proxy on
// either surface a producer could put the flag on flips every body material, and ONLY `side`, to
// DoubleSide) and the SHIPPED ARTIFACT (the real decoded preview renders DoubleSide at 645/1072,
// the real full module renders FrontSide at 4361/8922).
{
  const bodyMats = (mount) => {
    const out = [];
    mount.traverse((o) => {
      if (o.isMesh && /:(light|dark)$/.test(o.name)) out.push(o.material);
    });
    return out;
  };
  const sides = (mount) => [...new Set(bodyMats(mount).map((m) => m.side))];

  const fullMats = bodyMats(hero.mount);
  eq(fullMats.length, 114, 'three bodies carry 38 merged materialed meshes each');
  eq(sides(hero.mount).join(','), String(THREE.FrontSide), 'the full CAD renders FrontSide, which is the saving at 63k triangles');

  for (const [label, payload] of [
    ['mesh.proxy', { ...M, mesh: { ...M.mesh, proxy: true } }],
    ['META.mesh.proxy', { ...M, meta: { ...M.meta, mesh: { ...M.meta.mesh, proxy: true } } }],
  ]) {
    const s = stage(payload, M.meta.mission.heroTime);
    eq(sides(s.mount).join(','), String(THREE.DoubleSide), `a proxy declared on ${label} renders DoubleSide`);
    // ...and the branch changes NOTHING else
    const proxyMats = bodyMats(s.mount);
    eq(proxyMats.length, fullMats.length, `${label}: the same meshes exist`);
    let drift = 0;
    for (let i = 0; i < proxyMats.length; i++) {
      const a = fullMats[i];
      const b = proxyMats[i];
      if (a.color.getHex() !== b.color.getHex()) drift++;
      if (a.roughness !== b.roughness || a.metalness !== b.metalness) drift++;
      if (a.emissive.getHex() !== b.emissive.getHex() || a.transparent !== b.transparent) drift++;
    }
    eq(drift, 0, `${label}: colour, roughness, metalness, emissive and transparency are untouched`);
  }
  // the ball is a generated sphere, not decimated CAD, and is not part of the caveat
  eq(node(hero.mount, 'donna:ball').material.side, THREE.FrontSide, 'the ball is unaffected either way');
}

// The seam above is a hand-mutated payload. This block is the ARTIFACT gate: the module the picker
// actually ships, decoded by the real decoder, must BE the proxy and must take the branch. Break
// the flag in preview-data.js, or disconnect the preview lane, and this fails where the seam alone
// would stay green.
{
  const previewMod = await import('../donna/preview-data.js');
  const P = decodeDonnaData(previewMod);

  const bodyMats = (mount) => {
    const out = [];
    mount.traverse((o) => {
      if (o.isMesh && /:(light|dark)$/.test(o.name)) out.push(o.material);
    });
    return out;
  };
  const sides = (mount) => [...new Set(bodyMats(mount).map((m) => m.side))];
  const totals = (m) => {
    const parts = Object.values(m.mesh.meshes);
    return {
      declaredVerts: parts.reduce((a, p) => a + p.vertexCount, 0),
      declaredTris: parts.reduce((a, p) => a + p.triangleCount, 0),
      bufferVerts: parts.reduce((a, p) => a + p.positions.length / 3, 0),
      bufferTris: parts.reduce((a, p) => a + p.indices.length / 3, 0),
    };
  };

  // 1. the shipped preview declares and decodes as a proxy, on both surfaces scene.js reads
  eq(previewMod.META.mesh.proxy, true, 'preview-data.js META.mesh.proxy is true');
  eq(previewMod.META.mesh.format, 'wolfgang-mesh-columns-proxy/1', 'preview ships the proxy Wolfgang lane');
  eq(P.mesh.proxy, true, 'the decoded preview payload carries mesh.proxy = true');

  // 2. and it really is the decimated geometry, not the full CAD wearing a flag
  const pt = totals(P);
  eq(pt.declaredVerts, 645, 'the real preview decodes to 645 proxy vertices');
  eq(pt.declaredTris, 1072, 'the real preview decodes to 1072 unique proxy triangles');
  eq(pt.bufferVerts, 645, 'and its position buffers hold exactly those vertices');
  eq(pt.bufferTris, 1072, 'and its index buffers hold exactly those triangles');

  // 3. so the shipped preview takes the DoubleSide branch, for real, through buildScene
  const previewScene = stage(P, P.meta.mission.heroTime);
  const previewMats = bodyMats(previewScene.mount);
  ok(previewMats.length > 0, 'the preview stages body meshes at all');
  eq(sides(previewScene.mount).join(','), String(THREE.DoubleSide), 'the SHIPPED preview renders DoubleSide');

  // 4. while the full module - the one the viewer loads - is still the clean FrontSide lane
  eq(fullMod.META.mesh.proxy, undefined, 'donna-data.js META declares no proxy flag');
  eq(fullMod.META.mesh.format, 'wolfgang-mesh-columns/1', 'the full module ships the full Wolfgang lane');
  eq(M.mesh.proxy, false, 'the decoded full payload carries mesh.proxy = false');
  const ft = totals(M);
  eq(ft.declaredVerts, 4361, 'the full module decodes to 4361 vertices');
  eq(ft.declaredTris, 8922, 'the full module decodes to 8922 unique triangles');
  eq(ft.bufferVerts, 4361, 'and its position buffers hold exactly those vertices');
  eq(ft.bufferTris, 8922, 'and its index buffers hold exactly those triangles');
  eq(sides(hero.mount).join(','), String(THREE.FrontSide), 'the SHIPPED full module renders FrontSide');
}

// ---------------------------------------------------------------- 9. teardown

section('teardown');

for (const api of scenes) api.dispose();
ok(true, 'every staged scene disposes without throwing');

// ---------------------------------------------------------------- result

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
