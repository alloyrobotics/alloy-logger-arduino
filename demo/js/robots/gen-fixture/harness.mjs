// harness.mjs - dev-only checks for the two generated-demo interpreters. NOT a registered robot:
// demo/js/robots/index.js does not know this directory exists, and nothing the site serves
// imports it. It is here rather than in a test/ dir so the fixture def and the code that proves
// the fixture still renders travel together.
//
//   node demo/js/robots/gen-fixture/harness.mjs     (from the repo root; exits 0 on success)
//
// What it proves:
//   1. gendata.js is byte-identical to the generator runner's gendata.mjs for this def. Parity
//      is the whole ballgame: the runner computes the facts pack an emailed demo's analyst
//      answers from, the browser computes the arrays the visitor sees, and a one-bit divergence
//      means the analyst is describing a mission nobody is watching.
//   2. buildDataFromSpec is deterministic across two builds in the same process.
//   3. genscene.js constructs a scene from the fixture's scene_spec with no DOM and no renderer
//      (viewer.js hands buildScene a THREE.Group, so a bare Group is the real calling
//      convention, not a stub), every highlight and binding reference resolves against the
//      parts map, update() moves something and does not throw, and dispose() is clean.
//
// The runner lives outside the repo until GENSPEC's interpreters rebase; point
// ALLOY_DEMO_RUNNER at it if it is not in the default place.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import v8 from 'node:v8';

import * as THREE from '../../../vendor/three.module.js';
import { buildDataFromSpec } from '../../core/gendata.js';
import { buildSceneFromSpec, archetypeParts, SCENE_CAPS } from '../../core/genscene.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = process.env.ALLOY_DEMO_RUNNER || join(process.env.HOME || '', '.local/bin/alloylogger-demo-runner');

let failures = 0;
const ok = (name) => console.log(`  ok    ${name}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
};
function check(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

const def = JSON.parse(readFileSync(resolve(here, 'def.json'), 'utf8'));

/**
 * Force a full GC so a heap reading means something. update() runs 60 times a second inside
 * viewer.js's rAF loop and must allocate nothing, and "nothing" is only measurable either side of
 * a collection. Node exposes the hook only behind a flag, so the flag is set from inside.
 */
const collect = (() => {
  try {
    v8.setFlagsFromString('--expose_gc');
    const fn = runInNewContext('gc');
    v8.setFlagsFromString('--no-expose_gc');
    return fn;
  } catch (_) {
    return () => {};
  }
})();

/**
 * Stable digest of a whole built data set. Keys are sorted so the hash depends on the numbers,
 * not on channel declaration order, and the raw Float64 bytes go in so a difference in the last
 * mantissa bit is a difference in the hash.
 */
function hashData(data) {
  const h = createHash('sha256');
  for (const path of Object.keys(data).sort()) {
    h.update(path);
    const bucket = data[path];
    for (const key of Object.keys(bucket).sort()) {
      const arr = bucket[key];
      h.update(key);
      h.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    }
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
console.log('gendata parity + determinism');
// ---------------------------------------------------------------------------

const mine = buildDataFromSpec(def);
const mineHash = hashData(mine);
const again = hashData(buildDataFromSpec(def));

check('two builds of the same def hash identically', mineHash === again, `${mineHash} vs ${again}`);

const runnerEntry = resolve(RUNNER_DIR, 'gendata.mjs');
if (!existsSync(runnerEntry)) {
  bad('runner gendata.mjs is reachable', `not found at ${runnerEntry}; set ALLOY_DEMO_RUNNER`);
} else {
  const runner = await import(pathToFileURL(runnerEntry).href);
  const theirHash = hashData(runner.buildDataFromSpec(def));
  check('demo gendata.js matches the runner byte for byte', mineHash === theirHash, `demo ${mineHash}\n        runner ${theirHash}`);
  check('hashString agrees across the two copies', runner.hashString('foobar') === 0xbf9cf968);
}

console.log(`  parity hash  ${mineHash}`);

// sanity on the shape the scene is about to be driven with
const chanCount = Object.keys(mine).length;
check('every declared channel produced a bucket', chanCount === def.channels.length, `${chanCount} buckets for ${def.channels.length} channels`);

// ---------------------------------------------------------------------------
console.log('genscene construction');
// ---------------------------------------------------------------------------

// viewer.js calls `robotDef.buildScene(THREE, robotRoot)` where robotRoot is a THREE.Group it
// added to the scene. No DOM, no renderer, so the real calling convention runs fine in Node.
const mount = new THREE.Group();
const buildScene = buildSceneFromSpec(def.scene_spec);
const api = buildScene(THREE, mount);

check('buildScene returns the RobotDefinition contract',
  typeof api.update === 'function' && typeof api.setHighlight === 'function' && typeof api.dispose === 'function' && !!api.cameraHome,
  `got ${Object.keys(api).join(', ')}`);
check('it parented itself under the mount group', mount.children.length === 1);
check('cameraHome has a position and a target',
  api.cameraHome.position && api.cameraHome.target && Number.isFinite(api.cameraHome.position.x) && Number.isFinite(api.cameraHome.target.y),
  JSON.stringify(api.cameraHome));

// Camera follow. viewer.js reads `cameraFocus()` every frame and translates both the camera and
// the orbit target onto the point it returns, which is the only thing that keeps a travelling
// unit in the shot. The fixture's rover drives ~5 units down the aisle, so a hook that returned a
// constant would leave it framing empty floor by the end of the mission - assert the point
// actually tracks the unit rather than merely existing.
check('buildScene exposes cameraFocus, like the canned drone and rescue scenes',
  typeof api.cameraFocus === 'function', `got ${Object.keys(api).join(', ')}`);
if (typeof api.cameraFocus === 'function') {
  const focusUnit = def.scene_spec.camera && def.scene_spec.camera.focus;
  const node = mount.getObjectByName(focusUnit);
  check(`camera.focus "${focusUnit}" names a unit in the built scene`, !!node);

  api.update(0, mine);
  const f0 = api.cameraFocus();
  check('cameraFocus() returns a finite point',
    f0 && Number.isFinite(f0.x) && Number.isFinite(f0.y) && Number.isFinite(f0.z), JSON.stringify(f0));
  // the opening shot has to be framed on the same point the follow starts from, or the very first
  // frame yanks the whole rig sideways
  const homeGap = Math.abs(f0.x - api.cameraHome.target.x) + Math.abs(f0.y - api.cameraHome.target.y)
    + Math.abs(f0.z - api.cameraHome.target.z);
  check(`cameraFocus() at t=0 agrees with cameraHome.target (gap ${homeGap.toExponential(2)})`, homeGap < 1e-9,
    `${JSON.stringify(f0)} vs ${JSON.stringify(api.cameraHome.target)}`);

  if (node) {
    const p0 = { x: node.position.x, y: node.position.y, z: node.position.z };
    const g0 = { x: f0.x, y: f0.y, z: f0.z };
    api.update(12, mine);
    const f12 = api.cameraFocus();
    const unitMoved = Math.abs(node.position.x - p0.x) + Math.abs(node.position.z - p0.z);
    check(`the focus unit really travels between t=0 and t=12 (${unitMoved.toFixed(3)} units)`, unitMoved > 0.5);
    // world = unit-local x the spec's scale, and viewer.js works in world units
    const scale = Math.min(Math.max(def.scene_spec.scale ?? 1, SCENE_CAPS.scaleMin), SCENE_CAPS.scaleMax);
    const err = Math.abs(f12.x - node.position.x * scale) + Math.abs(f12.z - node.position.z * scale);
    check(`cameraFocus() tracks the unit after update(12) (residual ${err.toExponential(2)})`, err < 1e-9,
      `focus ${JSON.stringify(f12)} vs unit ${JSON.stringify(node.position)}`);
    const focusMoved = Math.abs(f12.x - g0.x) + Math.abs(f12.z - g0.z);
    check(`the focus point moved with it (${focusMoved.toFixed(3)} units)`, focusMoved > 0.5);

    // scrubbing back must put the shot back exactly where it was, same contract as the pose
    api.update(0, mine);
    const fBack = api.cameraFocus();
    check('scrubbing back to t=0 reproduces the focus point',
      Math.abs(fBack.x - g0.x) + Math.abs(fBack.y - g0.y) + Math.abs(fBack.z - g0.z) < 1e-9);
  }
}

const keys = new Set(api.parts.keys());
for (const f of def.findings || []) {
  if (f.highlight == null) continue;
  check(`findings.highlight "${f.highlight}" resolves`, keys.has(f.highlight), `parts: ${[...keys].slice(0, 14).join(', ')}`);
}
for (const b of def.scene_spec.bindings || []) {
  check(`bindings.part "${b.part}" resolves`, keys.has(b.part));
}
for (const p of def.scene_spec.props || []) {
  check(`prop "${p.id}" is keyed bare`, keys.has(p.id));
}

check(`triangle tally ${api.triangles} is inside the ${SCENE_CAPS.maxTriangles} budget`, api.triangles <= SCENE_CAPS.maxTriangles);

// ---------------------------------------------------------------------------
console.log('genscene update, highlight, dispose');
// ---------------------------------------------------------------------------

/** Flat snapshot of every transform under the mount, so "did anything move" is answerable. */
function poseOf() {
  const out = [];
  mount.traverse((o) => {
    out.push(o.position.x, o.position.y, o.position.z, o.rotation.x, o.rotation.y, o.rotation.z);
  });
  return out;
}

let threw = null;
try {
  api.update(0, mine);
} catch (e) {
  threw = e;
}
check('update(0, data) does not throw', !threw, threw && threw.stack);
const pose0 = poseOf();

try {
  api.update(12, mine);
} catch (e) {
  threw = e;
}
check('update(12, data) does not throw', !threw, threw && threw.stack);
const pose12 = poseOf();

check('the two poses have the same node count', pose0.length === pose12.length);
let moved = 0;
for (let i = 0; i < pose0.length; i++) {
  if (Math.abs(pose0[i] - pose12[i]) > 1e-9) moved++;
}
check(`at least one transform moved between t=0 and t=12 (${moved} components changed)`, moved > 0);
check('every transform component stayed finite', pose12.every(Number.isFinite));

// seeking backwards has to land exactly where it did the first time, or scrubbing drifts
api.update(0, mine);
const poseBack = poseOf();
let drift = 0;
for (let i = 0; i < pose0.length; i++) drift = Math.max(drift, Math.abs(pose0[i] - poseBack[i]));
check(`seeking back to t=0 reproduces the pose (max drift ${drift.toExponential(2)})`, drift < 1e-9);

const target = (def.findings || []).find((f) => f.highlight)?.highlight || null;
if (target) {
  threw = null;
  try {
    api.setHighlight(target);
    api.update(4, mine);
    api.setHighlight(null);
    api.update(4, mine);
  } catch (e) {
    threw = e;
  }
  check(`setHighlight("${target}") round trips`, !threw, threw && threw.stack);
}
threw = null;
try {
  api.setHighlight('nope.not_a_part');
  api.update(4, mine);
} catch (e) {
  threw = e;
}
check('an unresolvable highlight is inert, not fatal', !threw, threw && threw.stack);

threw = null;
try {
  api.update(6, {});
} catch (e) {
  threw = e;
}
check('update with no telemetry at all is inert, not fatal', !threw, threw && threw.stack);

threw = null;
try {
  api.dispose();
} catch (e) {
  threw = e;
}
check('dispose() does not throw', !threw, threw && threw.stack);
check('dispose() detached the scene from the mount', mount.children.length === 0);

// ---------------------------------------------------------------------------
console.log('genscene archetype and environment coverage');
// ---------------------------------------------------------------------------
// The fixture is one wheeled rover in a warehouse. Every other archetype, environment, motion
// kind and binding kind still has to construct, pose and tear down, because a generated def
// picks from all of them and a builder that throws is a blank panel for that visitor.

const ARCHETYPES = {
  wheeled: [{ wheels: 2 }, { wheels: 4, mast: true }, { wheels: 6 }],
  legged: [{ legs: 4 }, { legs: 6 }],
  arm: [{ joints: 4 }, { joints: 6, pedestal: true }],
  multirotor: [{ rotors: 4 }, { rotors: 6 }, { rotors: 8 }],
  marine: [{}, { sub: true }],
};
const ENVIRONMENTS = ['grid', 'field', 'warehouse', 'water', 'rubble'];
const BINDING_KINDS = ['spin', 'rotate', 'tilt', 'glow', 'wobble', 'offset'];

/** Part ids an archetype guarantees, read back off a built scene rather than assumed. */
function buildOne(archetype, params, environment, motion, bindingKinds) {
  const m = new THREE.Group();
  const scene = {
    environment,
    scale: 1,
    units: [{ id: 'u1', archetype, tint: '#2a6fd6', params, motion }],
    props: [
      { id: 'ball', kind: 'sphere', radius: 0.11, color: '#f5f5f5', motion: { kind: 'waypoints', loop: true, points: [[0, 0, 0], [1, 1, 6], [0, 2, 12]] } },
      { id: 'gate', kind: 'box', size: [0.6, 0.3, 0.6], color: '#8a6b3f', motion: { kind: 'static', pos: [2, 0, 1], yaw: 0.4 } },
    ],
    bindings: [],
    camera: { height: 2.2, dist: 3.4, focus: 'u1' },
  };
  const built = buildSceneFromSpec(scene)(THREE, m);
  // bind every requested kind onto real part ids, then rebuild so the bindings are compiled
  const ids = [...built.parts.keys()].filter((k) => k.startsWith('u1.'));
  built.dispose();
  scene.bindings = bindingKinds.map((kind, i) => ({
    part: ids[i % ids.length],
    kind,
    axis: ['x', 'y', 'z'][i % 3],
    channel: i % 2 ? '/drive.vel' : '/sys.temp',
    gain: 1.5,
    min: 38,
    max: 70,
  }));
  const m2 = new THREE.Group();
  return { mount: m2, api: buildSceneFromSpec(scene)(THREE, m2), partIds: ids };
}

const MOTIONS = [
  { kind: 'waypoints', loop: false, points: [[0, 0, 0], [1.5, 2, 8], [0.5, 4, 16], [0, 6, 20]] },
  { kind: 'waypoints', loop: true, points: [[0, 0, 0], [2, 2, 10]] },
  { kind: 'channels', x: '/drive.vel', z: '/drive.current', yaw: '/sys.temp' },
  { kind: 'static', pos: [1, 0, 1], yaw: 0.7 },
];

let mi = 0;
for (const [archetype, paramSets] of Object.entries(ARCHETYPES)) {
  for (const params of paramSets) {
    const environment = ENVIRONMENTS[mi % ENVIRONMENTS.length];
    const motion = MOTIONS[mi % MOTIONS.length];
    mi++;
    const label = `${archetype} ${JSON.stringify(params)} in ${environment}`;
    let built = null;
    let err = null;
    try {
      built = buildOne(archetype, params, environment, motion, BINDING_KINDS);
      built.api.update(0, mine);
      built.api.update(7.5, mine);
      built.api.update(20, mine);
      built.api.setHighlight(built.partIds[0]);
      built.api.update(11, mine);
      built.api.setHighlight(null);
    } catch (e) {
      err = e;
    }
    if (err) {
      bad(label, err.stack);
      continue;
    }
    // every id the part table promises for these params must be a real key in the parts map
    const promised = archetypeParts(archetype, params);
    const have = new Set(built.api.parts.keys());
    const missing = promised.filter((p) => !have.has(`u1.${p}`));
    const overCap = promised.length > SCENE_CAPS.maxPartsPerUnit;
    const overBudget = built.api.triangles > SCENE_CAPS.maxTriangles;
    const badFocus = typeof built.api.cameraFocus !== 'function'
      || !Number.isFinite(built.api.cameraFocus().x + built.api.cameraFocus().y + built.api.cameraFocus().z);
    const nonFinite = [];
    built.mount.traverse((o) => {
      if (!Number.isFinite(o.position.x + o.position.y + o.position.z + o.rotation.x + o.rotation.y + o.rotation.z)) nonFinite.push(o.name || o.type);
    });
    check(`${label} (${promised.length} parts, ${built.api.triangles} tris)`,
      missing.length === 0 && !overCap && !overBudget && nonFinite.length === 0 && !badFocus,
      [missing.length ? `missing part ids: ${missing.join(', ')}` : '', overCap ? 'over the parts-per-unit cap' : '',
        overBudget ? 'over the triangle budget' : '', nonFinite.length ? `non-finite transform on ${nonFinite.join(', ')}` : '',
        badFocus ? 'cameraFocus() missing or non-finite' : ''].filter(Boolean).join('; '));
    built.api.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log('physical plausibility');
// ---------------------------------------------------------------------------
// Everything below is a property of the RENDERED scene rather than of the spec, and every one of
// them was a defect a human found by looking at a screenshot: things floating, things sliced by
// the floor, wheels turning the wrong way, a ball that spins in place. They are asserted here
// because a screenshot review does not run on every commit and these do.

/**
 * World-space extents of a node measured over its actual VERTICES, skipping contact-shadow quads.
 *
 * Box3.setFromObject transforms each geometry's own AABB corners, so a rotated part reports a box
 * up to 40 percent larger than the part - which would make "does this wheel touch the floor"
 * unanswerable to the millimetre. Contact shadows are excluded because they are deliberately 4x
 * the footprint and are not part of the robot.
 */
function worldBox(node) {
  node.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  box.makeEmpty();
  node.traverse((o) => {
    if (!o.isMesh || o.userData.contactShadow || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      box.expandByPoint(v);
    }
  });
  return box;
}

/** Build one scene from an inline scene_spec and hand back the api plus its mount. */
function build(scene) {
  const m = new THREE.Group();
  return { mount: m, api: buildSceneFromSpec(scene)(THREE, m) };
}

{
  // The probe def that the realism audit was written against: four 180 mm robots and a 43 mm ball
  // on a soccer field, which is the shape every one of the defects showed up in.
  const probe = {
    environment: 'field',
    scale: 1,
    units: [
      {
        id: 'blue1',
        archetype: 'wheeled',
        tint: '#3a7bd5',
        params: { wheels: 4, body_len: 0.18, body_w: 0.18, body_h: 0.14, wheel_r: 0.027 },
        extra_parts: [{ id: 'marker', kind: 'cylinder', size: [0.05, 0.05, 0.006], pos: [0, 0.145, 0], color: '#8ab6f0', parent: 'body' }],
        motion: { kind: 'waypoints', loop: false, points: [[0.2, 4.6, 0], [0.9, 6.8, 6], [1.6, 7.6, 12], [0.5, 6.5, 20]] },
      },
    ],
    props: [
      { id: 'ball', kind: 'sphere', radius: 0.043, color: '#ff8c1a', motion: { kind: 'waypoints', loop: false, points: [[0, 5.2, 0], [0.6, 7.4, 6], [1.8, 8.2, 12], [0.4, 7.1, 20]] } },
      { id: 'our_goal', kind: 'box', size: [1.8, 0.5, 0.1], color: '#2aa198', motion: { kind: 'static', pos: [0, 0, -0.2] } },
    ],
    bindings: [{ part: 'blue1.wheel_fl', kind: 'spin', axis: 'x', channel: '/drive.vel', gain: 8 }],
    camera: { height: 2.6, dist: 4.2, focus: 'blue1' },
  };
  const { mount: pm, api } = build(probe);
  api.update(0, mine);

  // ---- contact shadows. Nothing reads as touching the ground without one.
  const shadowCount = api.shadows ? api.shadows.length : 0;
  check(`a contact shadow exists per unit and per prop (${shadowCount} for 1 unit + 2 props)`, shadowCount === 3);

  // ---- a prop with no y given rests ON the floor, it is not half sunk into it
  const goal = api.parts.get('our_goal');
  const gb = worldBox(goal.node);
  check(`a static box prop rests on y = 0 (bbox min y ${gb.min.y.toExponential(2)})`, Math.abs(gb.min.y) < 1e-6, JSON.stringify(gb.min));
  check(`the goal prop is its full stated height above the floor (${(gb.max.y - gb.min.y).toFixed(3)} m of 0.5)`,
    Math.abs(gb.max.y - gb.min.y - 0.5) < 1e-6);

  // ---- the ball sits on the floor, not through it
  const ball = api.parts.get('ball');
  const bb = worldBox(ball.node);
  check(`the ball rests on y = 0 (bbox min y ${bb.min.y.toExponential(2)})`, Math.abs(bb.min.y) < 1e-6);

  // ---- ball roll tracks arc length, forwards and backwards
  //
  // The roll lives on the ball's MESH, not on its pivot. The pivot is the ball's ground anchor: it
  // sits on the floor with the mesh one radius above it, so a quaternion on the pivot swung the
  // ball around a circle of its own radius about the contact point and buried it in the floor for
  // half of every revolution. Reading it off the mesh here is not a detail of the test - it is the
  // contract, and the check below that the pivot stays unrotated is what holds it.
  const rollAt = (t) => {
    api.update(t, mine);
    const q = ball.meshes[0].quaternion;
    return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w);
  };
  const posAt = (t) => {
    api.update(t, mine);
    return { x: ball.node.position.x, z: ball.node.position.z };
  };
  const r0 = rollAt(4);
  const r1 = rollAt(5);
  const p0 = posAt(4);
  const p1 = posAt(5);
  const travelled = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  check(`ball roll advances as it travels (${(r1 - r0).toFixed(2)} rad over ${travelled.toFixed(3)} m)`, Math.abs(r1 - r0) > 1e-3);
  // the roll is arc length over radius, so a straightish 1 s hop rolls at least travel/r
  check(`ball roll is in the right ballpark for travel/radius (${(Math.abs(r1 - r0) / (travelled / 0.043)).toFixed(2)}x)`,
    Math.abs(r1 - r0) / (travelled / 0.043) > 0.3);
  const rBackA = rollAt(0);
  const rBackB = rollAt(0);
  check(`scrubbing to t=0 rewinds the ball roll exactly (${rBackA.toExponential(2)} rad)`, rBackA < 1e-9 && rBackB < 1e-9);
  // and the pivot itself never rotates: it carries the ball's POSITION and its contact shadow, and
  // a rotation on it takes both of them for a ride
  api.update(5, mine);
  check(`the ball's ground pivot carries no rotation of its own (${ball.node.quaternion.w.toFixed(9)})`,
    Math.abs(ball.node.quaternion.w - 1) < 1e-12 && Math.abs(ball.node.rotation.x) + Math.abs(ball.node.rotation.y) + Math.abs(ball.node.rotation.z) === 0);

  // ---- wheels roll off the ground the unit is driving on, not off a telemetry channel
  const wheel = api.parts.get('blue1.wheel_fl').node;
  const unit = pm.getObjectByName('blue1');
  api.update(2, mine);
  const w0 = wheel.rotation.x;
  const u0 = { x: unit.position.x, z: unit.position.z };
  api.update(5, mine);
  const w1 = wheel.rotation.x;
  const drove = Math.hypot(unit.position.x - u0.x, unit.position.z - u0.z);
  const wantRoll = drove / 0.027;
  check(`wheel roll matches distance driven (${(w1 - w0).toFixed(1)} rad vs ${wantRoll.toFixed(1)} expected)`,
    Math.abs((w1 - w0) - wantRoll) / Math.max(wantRoll, 1e-6) < 0.02);
  check('wheel roll is positive when the unit drives forward', w1 - w0 > 0);
  api.update(2, mine);
  check(`scrubbing back reproduces the wheel angle (${Math.abs(wheel.rotation.x - w0).toExponential(2)} rad)`,
    Math.abs(wheel.rotation.x - w0) < 1e-9);

  // ---- a size triple is [x, y, z] extents for every kind, not just for boxes
  const marker = api.parts.get('blue1.marker');
  const mg = marker.meshes[0].geometry;
  mg.computeBoundingBox();
  const me = mg.boundingBox.getSize(new THREE.Vector3());
  check(`a [0.05, 0.05, 0.006] cylinder builds as a 50 mm disc 6 mm thick (${me.x.toFixed(3)} x ${me.y.toFixed(3)} x ${me.z.toFixed(3)})`,
    Math.abs(me.x - 0.05) < 1e-3 && Math.abs(me.y - 0.006) < 1e-4 && Math.abs(me.z - 0.05) < 1e-3);

  check('the scene asks for its own rendering treatment', !!api.rendering && api.rendering.toneMap === 'aces' && api.rendering.env === true);
  check(`the shadow frustum is fitted to the play area (half ${api.rendering.shadow.half.toFixed(2)} m, was a fixed 9)`,
    api.rendering.shadow.half < 4);
  check('a generated environment turns the viewer blueprint chrome off', api.rendering.grids === false && api.rendering.ground === false);
  check('the scene asks for the spring follow rig', !!api.followTuning && api.followTuning.omega > 0);
  console.log(`  probe tris   ${api.triangles}`);
  api.dispose();
}

{
  // A ball must not occupy the same volume as the robot that is supposed to be dribbling it.
  const scene = {
    environment: 'field',
    scale: 1,
    units: [{ id: 'u1', archetype: 'wheeled', params: { wheels: 4, body_len: 0.18, body_w: 0.18, body_h: 0.14, wheel_r: 0.027 }, motion: { kind: 'static', pos: [0, 0, 0] } }],
    props: [{ id: 'ball', kind: 'sphere', radius: 0.043, motion: { kind: 'waypoints', loop: false, points: [[-0.6, 0, 0], [0.6, 0, 10]] } }],
    bindings: [],
    camera: { focus: 'u1' },
  };
  const { api } = build(scene);
  let worst = 0;
  for (let t = 0; t <= 10; t += 0.25) {
    api.update(t, mine);
    const b = api.parts.get('ball').node.position;
    const pen = Math.min(0.09 + 0.043 - Math.abs(b.x), 0.09 + 0.043 - Math.abs(b.z));
    if (Math.abs(b.x) < 0.09 + 0.043 && Math.abs(b.z) < 0.09 + 0.043) worst = Math.max(worst, pen);
  }
  check(`a ball driven straight through a parked robot never ends up inside it (worst overlap ${worst.toExponential(2)} m)`, worst < 1e-9);
  api.dispose();
}

{
  // A cylindrical hull is round from every direction. The box test resolved the ball out to the
  // AABB, whose corners overhang the hull by 41 percent of the half-width, so a ball pushed out
  // diagonally came to rest visibly off the flank. Drive one in on the diagonal and measure the
  // resting CENTRE DISTANCE, which is the only number that distinguishes a disc from a box.
  const R = 0.09;
  const BALL = 0.043;
  const scene = {
    environment: 'field',
    scale: 1,
    units: [{
      id: 'u1',
      archetype: 'wheeled',
      params: { wheels: 4, wheel_layout: 'radial', wheel_kind: 'omni', body_shape: 'cylinder', body_w: R * 2, body_h: 0.14, wheel_r: 0.027, front_flat: 0.16 },
      motion: { kind: 'static', pos: [0, 0, 0] },
    }],
    // straight through the centre at 45 degrees, which is where a box and a disc disagree most
    props: [{ id: 'ball', kind: 'sphere', radius: BALL, motion: { kind: 'waypoints', loop: false, points: [[-0.6, -0.6, 0], [0.6, 0.6, 10]] } }],
    bindings: [],
    camera: { focus: 'u1' },
  };
  const { api } = build(scene);
  let closest = Infinity;
  let widestGap = 0;
  for (let t = 0; t <= 10; t += 0.05) {
    api.update(t, mine);
    const b = api.parts.get('ball').node.position;
    const d = Math.hypot(b.x, b.z);
    if (d < closest) closest = d;
    // only measure the gap while the ball is actually in contact, i.e. resting on the hull
    if (d < (R + BALL) * 1.02) widestGap = Math.max(widestGap, d - (R + BALL));
  }
  check(`a ball never gets inside a cylindrical hull (closest centre distance ${closest.toFixed(4)} m, hull+ball ${(R + BALL).toFixed(4)})`,
    closest >= R + BALL - 1e-9, `${closest}`);
  // the box test would have parked it out at the AABB corner, ~1.41 x the radius away
  check(`it rests ON the hull rather than out at the AABB corner (${(widestGap * 1000).toFixed(2)} mm of daylight)`,
    widestGap < 1e-6, `${widestGap} m`);
  api.dispose();
}

// ---------------------------------------------------------------------------
console.log('unit-vs-unit contact');
// ---------------------------------------------------------------------------
// Three robots converging on the same waypoint used to end up sharing a volume - the defect a
// human found in a generated demo's evidence frame. Units are discs in XZ and a deterministic
// post-pass pushes them apart after every mover lands, with the same scrub guarantee the ball
// separation carries: computed from scratch off the raw track positions, never accumulated.

/** Every pairwise gap, as a fraction of the pair's summed collision radii. 1 = exactly touching. */
function worstSeparation(api2, mount2, ids) {
  const rOf = new Map(api2.unitDiscs.map((d) => [d.node.name, d.r]));
  let worst = Infinity;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = mount2.getObjectByName(ids[i]);
      const b = mount2.getObjectByName(ids[j]);
      const want = rOf.get(ids[i]) + rOf.get(ids[j]);
      worst = Math.min(worst, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) / want);
    }
  }
  return worst;
}

{
  // Two 180 mm robots on head-on converging tracks: each drives straight at the other's start, so
  // without a contact pass they pass clean through one another at t = 15.
  const headOn = () => ({
    environment: 'field',
    scale: 1,
    units: [
      {
        id: 'blue',
        archetype: 'wheeled',
        tint: '#3a7bd5',
        params: { wheels: 4, body_shape: 'cylinder', body_w: 0.18, body_h: 0.14, wheel_r: 0.027, wheel_layout: 'radial' },
        motion: { kind: 'waypoints', loop: false, points: [[-1.2, 0, 0], [1.2, 0, 30]] },
      },
      {
        id: 'gold',
        archetype: 'wheeled',
        tint: '#f2c500',
        params: { wheels: 4, body_shape: 'cylinder', body_w: 0.18, body_h: 0.14, wheel_r: 0.027, wheel_layout: 'radial' },
        motion: { kind: 'waypoints', loop: false, points: [[1.2, 0, 0], [-1.2, 0, 30]] },
      },
    ],
    props: [],
    bindings: [],
    camera: { focus: 'blue' },
  });

  const { mount: hm, api: hapi } = build(headOn());
  const radii = new Map(hapi.unitDiscs.map((d) => [d.node.name, d.r]));
  check(`a cylinder chassis gets body_w/2 as its collision radius (${radii.get('blue').toFixed(4)} m of 0.09)`,
    Math.abs(radii.get('blue') - 0.09) < 1e-9, `${radii.get('blue')}`);
  check('both top-level units are registered as discs', hapi.unitDiscs.length === 2 && hapi.unitDiscs.every((d) => d.movable));

  let worstFrac = Infinity;
  let atT = 0;
  for (let t = 0; t <= 30; t += 0.05) {
    hapi.update(t, mine);
    const f = worstSeparation(hapi, hm, ['blue', 'gold']);
    if (f < worstFrac) {
      worstFrac = f;
      atT = t;
    }
  }
  check(`two units on head-on tracks never interpenetrate (closest ${worstFrac.toFixed(4)} of contact at t=${atT.toFixed(2)}, floor 0.96)`,
    worstFrac >= 0.96, `${worstFrac}`);
  // and they DO meet: a pass that simply parked them at opposite ends would also satisfy the above
  check(`they actually make contact rather than never meeting (${worstFrac.toFixed(4)} <= 1.10)`, worstFrac <= 1.10, `${worstFrac}`);
  console.log(`  closest approach  ${worstFrac.toFixed(6)} x contact, at t=${atT.toFixed(2)}`);

  // ---- exact rewind. Run forward to t=30, scrub back to t=7, and compare against a scene that
  // has never seen any other time. Any accumulation inside the pass shows up here and nowhere else.
  for (let t = 0; t <= 30; t += 0.25) hapi.update(t, mine);
  hapi.update(7, mine);
  const scrubbed = ['blue', 'gold'].map((id) => {
    const n = hm.getObjectByName(id);
    return [n.position.x, n.position.y, n.position.z, n.rotation.x, n.rotation.y, n.rotation.z];
  });
  const { mount: fm, api: fapi } = build(headOn());
  fapi.update(7, mine);
  const fresh = ['blue', 'gold'].map((id) => {
    const n = fm.getObjectByName(id);
    return [n.position.x, n.position.y, n.position.z, n.rotation.x, n.rotation.y, n.rotation.z];
  });
  let rewindDrift = 0;
  for (let i = 0; i < scrubbed.length; i++) {
    for (let k = 0; k < scrubbed[i].length; k++) rewindDrift = Math.max(rewindDrift, Math.abs(scrubbed[i][k] - fresh[i][k]));
  }
  check(`scrubbing t=30 back to t=7 matches a fresh build at t=7 exactly (max drift ${rewindDrift.toExponential(2)})`,
    rewindDrift === 0, `${rewindDrift}`);
  hapi.dispose();
  fapi.dispose();
}

{
  // A static unit is scenery: the mover pays the whole separation, the anchor does not budge.
  const scene = {
    environment: 'warehouse',
    scale: 1,
    units: [
      { id: 'rock', archetype: 'wheeled', params: { wheels: 4, body_shape: 'cylinder', body_w: 0.3 }, motion: { kind: 'static', pos: [0, 0, 0] } },
      { id: 'runner', archetype: 'wheeled', params: { wheels: 4, body_shape: 'cylinder', body_w: 0.3 }, motion: { kind: 'waypoints', loop: false, points: [[-1.5, 0, 0], [1.5, 0, 20]] } },
    ],
    props: [],
    bindings: [],
    camera: { focus: 'runner' },
  };
  const { mount: sm, api } = build(scene);
  const rock = sm.getObjectByName('rock');
  const rock0 = { x: rock.position.x, z: rock.position.z };
  let rockDrift = 0;
  let worstFrac = Infinity;
  for (let t = 0; t <= 20; t += 0.05) {
    api.update(t, mine);
    rockDrift = Math.max(rockDrift, Math.hypot(rock.position.x - rock0.x, rock.position.z - rock0.z));
    worstFrac = Math.min(worstFrac, worstSeparation(api, sm, ['rock', 'runner']));
  }
  check(`a static unit is never pushed by a mover that runs into it (${rockDrift.toExponential(2)} m of drift)`, rockDrift === 0, `${rockDrift}`);
  check(`the mover still gets pushed clear of it (closest ${worstFrac.toFixed(4)} of contact)`, worstFrac >= 0.96, `${worstFrac}`);
  check(`a static unit is registered as an immovable disc`, api.unitDiscs.find((d) => d.node.name === 'rock').movable === false);
  api.dispose();
}

{
  // The reported defect verbatim: three robots converging on one waypoint. Two sweeps of a
  // pairwise pass is not a convergent solver, so the residue at three bodies is asserted rather
  // than assumed - and a mixed fleet checks that a box chassis and a cylinder both get a radius.
  const scene = {
    environment: 'field',
    scale: 1,
    units: [
      { id: 'a', archetype: 'wheeled', params: { wheels: 4, body_shape: 'cylinder', body_w: 0.18, wheel_r: 0.027 }, motion: { kind: 'waypoints', loop: false, points: [[-1, -1, 0], [0, 0, 12], [-1, -1, 24]] } },
      { id: 'b', archetype: 'wheeled', params: { wheels: 4, body_len: 0.2, body_w: 0.16, wheel_r: 0.027 }, motion: { kind: 'waypoints', loop: false, points: [[1, -1, 0], [0, 0, 12], [1, -1, 24]] } },
      { id: 'c', archetype: 'legged', params: { legs: 4, stance: 0.24, body_len: 0.3, body_w: 0.16 }, motion: { kind: 'waypoints', loop: false, points: [[0, 1.4, 0], [0, 0, 12], [0, 1.4, 24]] } },
    ],
    props: [],
    bindings: [],
    camera: { focus: 'a' },
  };
  const { mount: cm, api } = build(scene);
  const rs = api.unitDiscs.map((d) => `${d.node.name}=${d.r.toFixed(4)}`).join(' ');
  check(`every archetype in a mixed fleet gets a finite, positive radius (${rs})`,
    api.unitDiscs.length === 3 && api.unitDiscs.every((d) => Number.isFinite(d.r) && d.r > 0));
  let worstFrac = Infinity;
  let atT = 0;
  for (let t = 0; t <= 24; t += 0.05) {
    api.update(t, mine);
    const f = worstSeparation(api, cm, ['a', 'b', 'c']);
    if (f < worstFrac) {
      worstFrac = f;
      atT = t;
    }
  }
  check(`three units converging on ONE waypoint stay out of each other (closest ${worstFrac.toFixed(4)} of contact at t=${atT.toFixed(2)}, floor 0.96)`,
    worstFrac >= 0.96, `${worstFrac}`);
  console.log(`  3-way scramble    ${worstFrac.toFixed(6)} x contact, at t=${atT.toFixed(2)}`);

  // exact concentricity is the one input with no centre line to push along; it must still separate
  const stacked = build({
    environment: 'grid',
    scale: 1,
    units: ['p', 'q', 'r'].map((id) => ({
      id, archetype: 'wheeled', params: { wheels: 4, body_shape: 'cylinder', body_w: 0.2 },
      motion: { kind: 'waypoints', loop: false, points: [[0, 0, 0], [0, 0, 10]] },
    })),
    props: [],
    bindings: [],
    camera: {},
  });
  stacked.api.update(5, mine);
  const sep = worstSeparation(stacked.api, stacked.mount, ['p', 'q', 'r']);
  check(`three units at EXACTLY the same point still fan apart (closest ${sep.toFixed(4)} of contact)`, sep >= 0.96, `${sep}`);
  stacked.api.update(5, mine);
  const sep2 = worstSeparation(stacked.api, stacked.mount, ['p', 'q', 'r']);
  check(`and the degenerate fan-out is the same on a re-render of the same frame`, Math.abs(sep - sep2) < 1e-12, `${sep} vs ${sep2}`);
  stacked.api.dispose();
  api.dispose();
}

{
  // worldScale lives on the scene root, so radii and positions are BOTH pre-scale and the ratio
  // between them cannot depend on it. If a radius were ever scaled and a position were not, this
  // is the check that catches it.
  const at = (scale) => {
    const scene = {
      environment: 'field',
      scale,
      units: [
        { id: 'x1', archetype: 'wheeled', params: { wheels: 4, body_shape: 'cylinder', body_w: 0.18 }, motion: { kind: 'waypoints', loop: false, points: [[-1, 0, 0], [1, 0, 20]] } },
        { id: 'x2', archetype: 'wheeled', params: { wheels: 4, body_shape: 'cylinder', body_w: 0.18 }, motion: { kind: 'waypoints', loop: false, points: [[1, 0, 0], [-1, 0, 20]] } },
      ],
      props: [],
      bindings: [],
      camera: {},
    };
    const { mount: m, api } = build(scene);
    let worst = Infinity;
    for (let t = 0; t <= 20; t += 0.1) {
      api.update(t, mine);
      worst = Math.min(worst, worstSeparation(api, m, ['x1', 'x2']));
    }
    api.dispose();
    return worst;
  };
  const s1 = at(1);
  const s3 = at(3);
  const sHalf = at(0.4);
  check(`contact is identical at scale 1, 3 and 0.4 (${s1.toFixed(6)} / ${s3.toFixed(6)} / ${sHalf.toFixed(6)})`,
    Math.abs(s1 - s3) < 1e-12 && Math.abs(s1 - sHalf) < 1e-12 && s1 >= 0.96);
}

{
  // The pass runs 60 times a second inside the rAF loop with the worst pair count the DSL allows,
  // and it must mint nothing. Preallocated pair scratch is the whole point.
  //
  // This scene is also the worst input the DSL can express: all six units share ONE waypoint, so
  // at t=4 every disc wants the same point at once. Six mutually-overlapping discs are genuinely
  // over-constrained for a bounded pairwise relaxation - there is no arrangement a capped sweep
  // count reaches from a six-fold coincidence - so the guarantee here is deliberately weaker than
  // the 0.96 the three-way case holds. It is asserted anyway, at the level actually measured, so
  // that a future change to the sweep cap or the margin cannot quietly regress it back to the
  // total interpenetration this pass was written to fix.
  const N = SCENE_CAPS.maxUnits;
  const { mount: pm, api } = build({
    environment: 'rubble',
    scale: 1,
    units: Array.from({ length: N }, (_, i) => ({
      id: `u${i}`,
      archetype: 'wheeled',
      params: { wheels: 4, body_shape: 'cylinder', body_w: 0.24 },
      motion: { kind: 'waypoints', loop: true, points: [[Math.cos(i) * 0.6, Math.sin(i) * 0.6, 0], [0, 0, 4], [Math.cos(i) * 0.6, Math.sin(i) * 0.6, 8]] },
    })),
    props: [{ id: 'ball', kind: 'sphere', radius: 0.043, motion: { kind: 'waypoints', loop: true, points: [[0, 0.8, 0], [0, -0.8, 6]] } }],
    bindings: [],
    camera: {},
  });
  const pileIds = Array.from({ length: N }, (_, i) => `u${i}`);
  let pileWorst = Infinity;
  let pileAt = 0;
  for (let t = 0; t <= 8; t += 0.02) {
    api.update(t, mine);
    const f = worstSeparation(api, pm, pileIds);
    if (f < pileWorst) {
      pileWorst = f;
      pileAt = t;
    }
  }
  check(`a 6-way exact coincidence stays well clear of interpenetration (worst ${pileWorst.toFixed(4)} of contact at t=${pileAt.toFixed(2)})`,
    pileWorst >= 0.7, `${pileWorst}`);
  console.log(`  6-way pile-up     ${pileWorst.toFixed(6)} x contact, at t=${pileAt.toFixed(2)}`);

  for (let i = 0; i < 400; i++) api.update(i * 0.02, mine);
  collect();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20000; i++) api.update((i % 400) * 0.02, mine);
  collect();
  const grew = process.memoryUsage().heapUsed - before;
  check(`the contact pass allocates nothing across 20000 frames of a 6-unit pile-up (${(grew / 1024).toFixed(0)} KB net)`,
    grew < 256 * 1024, `${grew} bytes`);
  api.dispose();
}

{
  // G2 + G9 + G1: the RoboCup-shaped robot. Cylindrical hull, a flat kicker face, four omni
  // wheels at rulebook angles, each with its own steer pivot, and a white top marker.
  const scene = {
    environment: 'field',
    environment_params: {
      size: [2.19, 1.58],
      markings: 'soccer',
      goal: { width: 0.6, depth: 0.074, height: 0.1 },
      goal_colors: ['#2f7dff', '#f2c500'],
      penalty_area: { width: 0.8, depth: 0.25, corner_r: 0.15 },
      center_circle: 0.3,
      walls: { height: 0.22, band: 0.12 },
      wall_color: '#141414',
      floor_color: '#1d4a2c',
      line_color: '#f4f6f8',
    },
    scale: 1,
    units: [
      {
        id: 'bot',
        archetype: 'wheeled',
        tint: '#3a7bd5',
        params: {
          wheels: 4, body_shape: 'cylinder', body_w: 0.18, body_h: 0.14, wheel_r: 0.027,
          front_flat: 0.16, clearance: 0.005, wheel_layout: 'radial', wheel_angles: [60, -60, 135, -135], wheel_kind: 'omni',
        },
        extra_parts: [{ id: 'top_marker', kind: 'cylinder', size: [0.05, 0.05, 0.003], pos: [0, 0.071, 0], color: '#f2f4f8', parent: 'body' }],
        motion: { kind: 'waypoints', loop: false, points: [[0, -0.4, 0], [0.3, 0.4, 6]], yaw: 'face:ball' },
      },
    ],
    props: [{ id: 'ball', kind: 'sphere', radius: 0.021, color: '#ff8c1a', motion: { kind: 'waypoints', loop: false, points: [[0.2, 0.2, 0], [-0.3, -0.5, 6]] } }],
    bindings: [{ part: 'bot.wheel_1_steer', kind: 'rotate', axis: 'y', channel: '/drive.vel', gain: 0.1 }],
    camera: { height: 0.6, dist: 1.4, focus: 'bot' },
  };
  const { mount: m, api } = build(scene);
  api.update(0, mine);
  const have = new Set(api.parts.keys());
  const wantIds = ['bot.wheel_1', 'bot.wheel_2', 'bot.wheel_3', 'bot.wheel_4',
    'bot.wheel_1_steer', 'bot.wheel_2_steer', 'bot.wheel_3_steer', 'bot.wheel_4_steer'];
  check('a radial omni base publishes wheel_1..wheel_4 plus a steer pivot each',
    wantIds.every((k) => have.has(k)), wantIds.filter((k) => !have.has(k)).join(', '));
  check('archetypeParts agrees with what was actually built',
    archetypeParts('wheeled', scene.units[0].params).every((p) => have.has(`bot.${p}`)));
  const steer = api.parts.get('bot.wheel_1_steer').node;
  const roll = api.parts.get('bot.wheel_1').node;
  check('the roll pivot is a child of the steer pivot', roll.parent === steer);
  api.update(6, mine);
  check('a rotate binding on the steer pivot turns it', Math.abs(steer.rotation.y - (Math.PI / 3 - Math.PI / 2)) > 1e-6);

  // measured as built: the live pose carries a ride-height lift and a lean, both of which are
  // supposed to change the world bbox, and neither is what the rulebook limit is about
  const botNode = m.getObjectByName('bot');
  botNode.position.set(0, 0, 0);
  botNode.rotation.set(0, 0, 0);
  const botBox = worldBox(botNode);
  check(`the robot fits inside its stated 180 mm cylinder (${(botBox.max.x - botBox.min.x).toFixed(3)} m wide)`,
    botBox.max.x - botBox.min.x <= 0.185);
  // 1 mm of slack: an 8-segment roller's lowest VERTEX sits a fraction of a millimetre above the
  // circle it approximates, and that is tessellation, not a floating robot.
  check(`the robot's wheels reach the floor (lowest vertex at y ${botBox.min.y.toExponential(2)})`,
    botBox.min.y >= -1e-9 && botBox.min.y < 2e-3);
  check(`the robot is under its stated 180 mm height (${(botBox.max.y - botBox.min.y).toFixed(3)} m)`, botBox.max.y - botBox.min.y <= 0.18);

  // the field itself, from the rulebook numbers
  let wallTop = 0;
  let floorSpan = 0;
  let goalCount = 0;
  m.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.parameters) return;
    const par = o.geometry.parameters;
    if (par.width && par.height && par.depth) {
      const b = worldBox(o);
      if (b.max.y > wallTop && b.max.y < 0.3 && (b.max.x - b.min.x > 1.5 || b.max.z - b.min.z > 2)) wallTop = b.max.y;
      if (Math.abs(b.max.y - 0.1) < 0.02 && b.max.x - b.min.x < 0.7) goalCount++;
    }
    // the pitch is the one plane carrying a markings texture; the surround plane has none
    if (par.width && par.height && !par.depth && o.material.map) floorSpan = par.height;
  });
  check(`the field floor is the stated 2.19 m plus its 12 cm outer band each side (${floorSpan.toFixed(3)} m)`,
    Math.abs(floorSpan - 2.43) < 1e-6, `${floorSpan}`);
  check(`the perimeter wall is 22 cm of matte black (top at ${wallTop.toFixed(3)} m)`, Math.abs(wallTop - 0.22) < 1e-6);
  check(`both goals are built at the stated 10 cm height (${goalCount} side panels)`, goalCount >= 4);

  // G3: the robot faces the ball while it strafes, instead of pointing where it is going
  api.update(3, mine);
  const bot = m.getObjectByName('bot');
  const ballPos = api.parts.get('ball').node.position;
  const wantYaw = Math.atan2(ballPos.x - bot.position.x, ballPos.z - bot.position.z);
  check(`yaw "face:ball" points the chassis at the ball (${(bot.rotation.y - wantYaw).toExponential(2)} rad off)`,
    Math.abs(bot.rotation.y - wantYaw) < 1e-9);
  console.log(`  rcj tris     ${api.triangles}`);
  check(`the RCJ scene is inside the triangle budget (${api.triangles})`, api.triangles <= SCENE_CAPS.maxTriangles);
  api.dispose();
}

{
  // G2 table parity: the default radial wheel angles exist TWICE, in the runner's part-tables.mjs
  // (which validate.mjs resolves bindings and highlights against) and in genscene.js's hand-checked
  // mirror. A drift is a def the validator accepts and the visitor's browser lays out differently.
  //
  // The expected arrays below are copied from RADIAL_WHEEL_ANGLES in the runner's part-tables.mjs,
  // WHICH IS THE SOURCE OF TRUTH. They are hardcoded rather than imported because part-tables.mjs
  // lives outside this repo (see RUNNER_DIR) and this harness must run without it. If part-tables
  // changes, change these; never the other way around.
  const RADIAL_WHEEL_ANGLES = {
    3: [0, 120, 240],
    4: [33, -33, 135, -135],
    6: [30, -30, 90, -90, 150, -150],
  };
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  for (const n of [3, 4, 6]) {
    const scene = {
      environment: 'field',
      scale: 1,
      units: [{
        id: 'bot',
        archetype: 'wheeled',
        tint: '#3a7bd5',
        // no wheel_angles: this is exactly the case where the interpreter falls back to its table
        params: { wheels: n, wheel_layout: 'radial', body_shape: 'cylinder', body_w: 0.18, body_h: 0.09, wheel_r: 0.025 },
        motion: { kind: 'static', pos: [0, 0] },
      }],
      camera: { height: 0.6, dist: 1.4, focus: 'bot' },
    };
    const { api } = build(scene);
    api.update(0, mine);
    // The steer pivot sits at (sin(theta)*ring, wr, cos(theta)*ring) in the chassis frame, so the
    // built geometry gives the angle back exactly and this measures the interpreter, not a copy.
    const got = [];
    for (let i = 1; i <= n; i++) {
      const p = api.parts.get(`bot.wheel_${i}_steer`).node.position;
      got.push(wrap360((Math.atan2(p.x, p.z) * 180) / Math.PI));
    }
    const want = RADIAL_WHEEL_ANGLES[n].map(wrap360);
    const worst = Math.max(...got.map((g, i) => Math.abs(g - want[i])));
    check(`genscene's radial angle table matches part-tables.mjs for N=${n} [${RADIAL_WHEEL_ANGLES[n].join(', ')}]`,
      worst < 1e-9, `built ${got.map((g) => g.toFixed(3)).join(', ')} vs want ${want.join(', ')}`);
    api.dispose();
  }
}

{
  // G7: a manipulator riding a mobile base is ONE path, not two hand-copied waypoint lists.
  const scene = {
    environment: 'warehouse',
    scale: 1,
    units: [
      { id: 'base', archetype: 'wheeled', params: { wheels: 4 }, motion: { kind: 'waypoints', loop: false, points: [[0, 0, 0], [3, 4, 12]] } },
      { id: 'arm', archetype: 'arm', parent: 'base.body', params: { joints: 6, reach: 0.6 }, motion: { kind: 'static', pos: [0, 0.07, 0] } },
    ],
    props: [],
    bindings: [{ part: 'arm.j2', kind: 'rotate', axis: 'x', channel: '/drive.vel', gain: 0.2 }],
    camera: { focus: 'base' },
  };
  const { mount: m, api } = build(scene);
  const armRoot = m.getObjectByName('arm');
  const baseBody = api.parts.get('base.body').node;
  check('a parented unit attaches to the named part of its parent', armRoot && armRoot.parent === baseBody);
  api.update(0, mine);
  const a0 = worldBox(armRoot).min.clone();
  api.update(12, mine);
  const a12 = worldBox(armRoot).min;
  check(`the mounted arm rides the base without a track of its own (${a0.distanceTo(a12).toFixed(2)} m)`, a0.distanceTo(a12) > 1);
  check('the mounted arm still resolves its own part ids', api.parts.has('arm.j2') && api.parts.has('arm.gripper'));
  // it must not ALSO be driven as a mover, or its local offset would be overwritten by a track
  check('a mounted unit keeps its local offset instead of being posed as a mover',
    Math.abs(armRoot.position.y - 0.07) < 1e-9 && Math.abs(armRoot.position.x) < 1e-9,
    JSON.stringify(armRoot.position));
  check('a mounted unit gets no ground shadow of its own', api.shadows.every((s) => s.node !== armRoot));
  api.dispose();
}

{
  // G5 + G6 + G8: legs that stand on the floor, a gantry that hangs, a cone that is a cone.
  const legs = build({
    environment: 'grid',
    units: [{ id: 'dog', archetype: 'legged', params: { legs: 4, stance: 0.34, body_w: 0.16 }, motion: { kind: 'static', pos: [0, 0, 0] } }],
    props: [],
    bindings: [],
    camera: {},
  });
  legs.api.update(0, mine);
  const lb = worldBox(legs.mount.getObjectByName('dog'));
  check(`a quadruped stands ON the floor (feet at y ${lb.min.y.toExponential(2)})`, lb.min.y >= -1e-9 && lb.min.y < 1e-3);
  const bodyBox = worldBox(legs.api.parts.get('dog.body').node);
  check(`body width is independent of stance (${(bodyBox.max.x - bodyBox.min.x).toFixed(3)} m body on a 0.34 m stance)`,
    Math.abs(bodyBox.max.x - bodyBox.min.x - 0.16) < 1e-6);
  legs.api.dispose();

  const gantry = build({
    environment: 'warehouse',
    units: [{ id: 'g1', archetype: 'arm', params: { joints: 5, reach: 0.8, mount: 'gantry', mount_h: 1.6, span: 2.4 }, motion: { kind: 'static', pos: [0, 0, 0] } }],
    props: [{ id: 'beam', kind: 'cone', size: [0.3, 0.3, 0.5], finish: 'glass', color: '#2f78ff', motion: { kind: 'static', pos: [1, 0.6, 0] } }],
    bindings: [{ part: 'g1.carriage', kind: 'offset', axis: 'x', channel: '/drive.vel', gain: 0.4 }],
    camera: {},
  });
  gantry.api.update(0, mine);
  check('a gantry arm publishes rail and carriage', gantry.api.parts.has('g1.rail') && gantry.api.parts.has('g1.carriage'));
  const grip = worldBox(gantry.api.parts.get('g1.gripper').node);
  const railNode = gantry.api.parts.get('g1.rail').node;
  check(`the gantry chain hangs DOWN off its 1.6 m rail (gripper at y ${grip.max.y.toFixed(2)})`,
    grip.max.y < railNode.position.y && grip.min.y > 0);
  const coneGeo = gantry.api.parts.get('beam').meshes[0].geometry;
  check('a cone primitive is a cone', coneGeo.parameters && coneGeo.parameters.radiusTop < coneGeo.parameters.radiusBottom);
  check(`the cone honours its stated [x, y, z] (${coneGeo.parameters.height.toFixed(3)} m long, 0.5 asked)`,
    Math.abs(coneGeo.parameters.height - 0.5) < 1e-6);
  check('a glass finish is transparent and casts no shadow',
    gantry.api.parts.get('beam').meshes[0].material.transparent && !gantry.api.parts.get('beam').meshes[0].castShadow);
  gantry.api.dispose();
}

{
  // Worst case for the triangle budget: six of the heaviest unit the DSL can express, all with
  // omni wheels and a full extra-part load, in the busiest environment.
  const heavy = {
    environment: 'rubble',
    scale: 1,
    units: Array.from({ length: SCENE_CAPS.maxUnits }, (_, i) => ({
      id: `u${i}`,
      archetype: 'legged',
      params: { legs: 6, stance: 0.3 },
      extra_parts: Array.from({ length: SCENE_CAPS.maxExtraParts }, (_, k) => ({
        id: `x${k}`, kind: ['sphere', 'capsule', 'torus', 'cone'][k % 4], size: [0.09, 0.09, 0.14], pos: [0, 0.3 + k * 0.02, 0], parent: 'body',
      })),
      motion: { kind: 'waypoints', loop: true, points: [[i, 0, 0], [i, 4, 9]] },
    })),
    props: Array.from({ length: SCENE_CAPS.maxProps }, (_, i) => ({ id: `p${i}`, kind: 'sphere', radius: 0.2, motion: { kind: 'static', pos: [i, 0, 3] } })),
    bindings: [],
    camera: {},
  };
  const { api } = build(heavy);
  api.update(5, mine);
  check(`worst-case legged fleet stays inside the budget (${api.triangles} tris)`, api.triangles <= SCENE_CAPS.maxTriangles);
  api.dispose();

  const heavyWheels = { ...heavy, environment: 'field',
    units: heavy.units.map((u) => ({ ...u, archetype: 'wheeled', params: { wheels: 6, wheel_layout: 'radial', wheel_kind: 'omni', wheel_r: 0.06 } })) };
  const hw = build(heavyWheels);
  hw.api.update(5, mine);
  check(`worst-case omni fleet stays inside the budget (${hw.api.triangles} tris)`, hw.api.triangles <= SCENE_CAPS.maxTriangles);
  hw.api.dispose();
}

{
  // update() runs in a 60 fps rAF loop, so it must not allocate. A thousand frames that grow the
  // heap by more than a few hundred KB means something inside is minting objects per frame.
  const { api } = build({
    environment: 'field',
    units: [{ id: 'u1', archetype: 'wheeled', params: { wheels: 4, wheel_kind: 'omni', wheel_layout: 'radial' }, motion: { kind: 'waypoints', loop: true, points: [[0, 0, 0], [2, 3, 8]] } }],
    props: [{ id: 'ball', kind: 'sphere', radius: 0.1, motion: { kind: 'waypoints', loop: true, points: [[0, 1, 0], [1, 2, 5]] } }],
    bindings: [],
    camera: { focus: 'u1' },
  });
  for (let i = 0; i < 400; i++) api.update(i * 0.05, mine);
  collect();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20000; i++) api.update((i % 400) * 0.05, mine);
  collect();
  const grew = process.memoryUsage().heapUsed - before;
  check(`20000 update() calls allocate essentially nothing (${(grew / 1024).toFixed(0)} KB net)`, grew < 256 * 1024, `${grew} bytes`);
  api.dispose();
}

// A junk spec must still produce a usable scene rather than an exception: an unknown archetype,
// an unknown environment, out-of-range sizes, too many of everything.
{
  let err = null;
  let api2 = null;
  const m = new THREE.Group();
  try {
    api2 = buildSceneFromSpec({
      environment: 'lunar',
      scale: 99,
      units: Array.from({ length: 11 }, (_, i) => ({
        id: `u${i}`,
        archetype: i === 0 ? 'wheeled' : 'teleporter',
        tint: 'not-a-colour',
        params: { wheels: 7, body_len: 900 },
        extra_parts: Array.from({ length: 30 }, (_, k) => ({ id: `x${k}`, kind: 'blob', size: [-4, 0, 1e9], pos: ['a', null, 2], parent: 'nowhere' })),
        motion: { kind: 'orbit', points: [[0, 0, 0]] },
      })),
      props: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, kind: 'sphere', radius: 1e6 })),
      bindings: Array.from({ length: 90 }, () => ({ part: 'u0.body', kind: 'melt', axis: 'w', channel: 'nope', gain: NaN })),
      camera: { height: -5, dist: 1e9, focus: 'ghost' },
    })(THREE, m);
    api2.update(0, mine);
    api2.update(9, mine);
  } catch (e) {
    err = e;
  }
  check('a hostile spec degrades instead of throwing', !err, err && err.stack);
  if (api2) {
    const unitNodes = [...api2.parts.keys()].filter((k) => k.includes('.')).map((k) => k.split('.')[0]);
    check(`the unit cap held (${new Set(unitNodes).size} units)`, new Set(unitNodes).size <= SCENE_CAPS.maxUnits);
    check(`the triangle budget held (${api2.triangles} tris)`, api2.triangles <= SCENE_CAPS.maxTriangles);
    check('cameraHome is finite despite a junk camera block',
      Number.isFinite(api2.cameraHome.position.x + api2.cameraHome.position.y + api2.cameraHome.position.z));
    // camera.focus names a unit that does not exist, so there is nothing to chase: the hook still
    // has to answer, with the finite bbox point the home shot was framed on
    const ghost = api2.cameraFocus();
    check('cameraFocus is finite and inert when camera.focus names nothing',
      Number.isFinite(ghost.x + ghost.y + ghost.z)
        && Math.abs(ghost.x - api2.cameraHome.target.x) + Math.abs(ghost.z - api2.cameraHome.target.z) < 1e-9,
      JSON.stringify(ghost));
    api2.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log('vertical dynamics and contact motion, at both scales');
// ---------------------------------------------------------------------------
// Reported verbatim off the live regenerated RCJ demo: "the robot is bouncing around" and "the
// ball is inside the ground". Both were scale bugs in the same pass.
//
//   - every vertical amplitude and lean gain was an absolute constant tuned by eye on a
//     metre-scale rover, so the fixture rover bobbed 23.0 mm on a 594 mm body (3.9 percent of
//     itself, a hovercraft) while an 180 mm soccer robot got something else again;
//   - the ball's roll quaternion was applied to its ground pivot rather than to the ball, so the
//     ball's centre orbited the contact point at its own radius: measured centre y ran from
//     +37 mm to -37 mm on a 37 mm ball, i.e. the ball spent half of every revolution underground;
//   - two units whose generated tracks crossed near-concentrically were flung around each other at
//     3.09 m/s by a separation axis that spun with the centre line, while their own tracks were
//     travelling at 0.113 m/s.
//
// The numbers below are the measured ones and the thresholds are set where a REGRESSION shows up,
// not where the current code happens to sit.

/** Peak-to-peak root height of a unit over a run, as a fraction of its own body height. */
function bobFraction(api2, mount2, id, dur, step) {
  const n = mount2.getObjectByName(id);
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t <= dur; t += step) {
    api2.update(t, mine);
    lo = Math.min(lo, n.position.y);
    hi = Math.max(hi, n.position.y);
  }
  api2.update(0, mine);
  const b = worldBox(n);
  return { frac: (hi - lo) / (b.max.y - b.min.y), amp: hi - lo, height: b.max.y - b.min.y };
}

{
  // The live def's own shape: four 178 mm omni robots and a 37 mm ball on a 2.19 x 1.58 m RCJ
  // field, every chassis facing the ball, and tracks that converge on it because that is what a
  // generated soccer def always writes. str/opp cross almost exactly head on - 2 mm apart at
  // closest on the live def - which is the input that produced the bouncing.
  const soccer = {
    environment: 'field',
    scale: 1,
    environment_params: { size: [2.19, 1.58], markings: 'soccer' },
    units: [
      {
        id: 'str', archetype: 'wheeled', tint: '#c0392b',
        params: { wheels: 4, body_shape: 'cylinder', body_w: 0.178, body_h: 0.145, wheel_r: 0.024, wheel_layout: 'radial', wheel_kind: 'omni', front_flat: 0.3 },
        motion: { kind: 'waypoints', loop: false, yaw: 'face:ball', points: [[0, -0.55, 0], [0.05, -0.1, 4], [0.21, 0.22, 9], [-0.02, 0.02, 16], [-0.3, -0.4, 24], [0, -0.8, 32]] },
      },
      {
        id: 'gk', archetype: 'wheeled', tint: '#9b2f6f',
        params: { wheels: 4, body_shape: 'cylinder', body_w: 0.178, body_h: 0.145, wheel_r: 0.024, wheel_layout: 'radial', wheel_kind: 'omni' },
        motion: { kind: 'waypoints', loop: false, yaw: 'face:ball', points: [[0, -1, 0], [0.14, -1, 8], [-0.1, -0.99, 18], [0.02, -0.98, 26], [-0.06, -1, 32]] },
      },
      {
        // The head-on crosser. Its t=11.5 waypoint is exactly where the striker's spline is at
        // t=11.5, so the two tracks are CONCENTRIC there - the input that produced the reported
        // bouncing, reproduced to the millimetre rather than approximated.
        id: 'opp', archetype: 'wheeled', tint: '#1f6fd0',
        params: { wheels: 4, body_shape: 'cylinder', body_w: 0.178, body_h: 0.145, wheel_r: 0.024, wheel_layout: 'radial', wheel_kind: 'omni' },
        motion: { kind: 'waypoints', loop: false, yaw: 'face:ball', points: [[-0.25, 0.85, 0], [-0.1, 0.4, 7], [0.1564, 0.1957, 11.5], [0.2, 0.05, 15], [0.05, -0.35, 21], [0.25, -0.55, 28], [0.12, -0.6, 32]] },
      },
    ],
    props: [{
      id: 'ball', kind: 'sphere', radius: 0.037, color: '#f26722', finish: 'matte',
      motion: { kind: 'waypoints', loop: false, points: [[0, 0, 0], [0.15, 0.5, 5], [0.05, 0.1, 10], [-0.1, -0.3, 16], [0.05, -0.6, 22], [-0.05, -0.86, 30], [0, -0.9, 32]] },
    }],
    bindings: [],
    camera: { height: 0.55, dist: 0.85, focus: 'str' },
  };
  const DUR = 32;
  const { mount: sm, api } = build(soccer);

  // ---- G1: an 180 mm rigid omni robot on carpet barely moves vertically. The lean lift and the
  // rolling bob are both fractions of the unit's own height, so this number is the same order at
  // any scale - which is the whole point of the fix.
  for (const id of ['str', 'gk', 'opp']) {
    const b = bobFraction(api, sm, id, DUR, 1 / 60);
    check(`${id} bobs at most 1.5 percent of its own body height (${(b.frac * 100).toFixed(2)}%, ${(b.amp * 1000).toFixed(2)} mm on ${(b.height * 1000).toFixed(0)} mm)`,
      b.frac <= 0.015, `${b.frac}`);
  }

  // ---- G2: the ball rests ON the carpet. Its centre is one radius up at every single frame,
  // including the frames where a chassis is squeezing it, where the only thing it is allowed to do
  // is ride a fraction of its own radius UP.
  const ballNode = api.parts.get('ball').node;
  const ballMesh = api.parts.get('ball').meshes[0];
  const R = 0.037;
  const cw = new THREE.Vector3();
  let loY = Infinity;
  let hiY = -Infinity;
  let atLo = 0;
  for (let t = 0; t <= DUR; t += 1 / 60) {
    api.update(t, mine);
    ballMesh.updateWorldMatrix(true, false);
    cw.setFromMatrixPosition(ballMesh.matrixWorld);
    if (cw.y < loY) {
      loY = cw.y;
      atLo = t;
    }
    hiY = Math.max(hiY, cw.y);
  }
  check(`the ball's centre never drops below 0.98 of its radius (lowest ${(loY / R).toFixed(4)} R at t=${atLo.toFixed(2)})`,
    loY >= 0.98 * R, `${loY} vs ${R}`);
  check(`and it is never lifted more than a slice of itself off the carpet (highest ${(hiY / R).toFixed(3)} R)`,
    hiY <= 1.13 * R, `${hiY}`);
  check(`the ball's own pivot stays on the floor rather than being sunk or lifted (${ballNode.position.y.toFixed(5)} m)`,
    ballNode.position.y >= 0 && ballNode.position.y <= R * 0.13);

  // ---- G3: the contact passes may not fling anything. A unit's rendered speed is bounded by a
  // small multiple of what its OWN track does, which is the number that was 27x before: the
  // separation axis spun with the centre line of two near-coincident robots and teleported both of
  // them around each other every time their generated tracks crossed.
  const rawTop = (id) => {
    const u = soccer.units.find((x) => x.id === id);
    const { mount: m2, api: a2 } = build({ ...soccer, units: [{ ...u, motion: { ...u.motion, yaw: undefined } }], props: [] });
    const n = m2.getObjectByName(id);
    let prev = null;
    let top = 0;
    for (let t = 0; t <= DUR; t += 1 / 60) {
      a2.update(t, mine);
      if (prev) top = Math.max(top, Math.hypot(n.position.x - prev.x, n.position.z - prev.z) * 60);
      prev = { x: n.position.x, z: n.position.z };
    }
    a2.dispose();
    return top;
  };
  //
  // The bound is against the whole fleet's top track speed rather than each unit's own, because a
  // contact is a transaction: the unit that gets shoved hardest is the one standing still when
  // something quick arrives.
  const fleetTop = Math.max(...['str', 'gk', 'opp'].map(rawTop));
  for (const id of ['str', 'gk', 'opp']) {
    const n = sm.getObjectByName(id);
    let prev = null;
    let top = 0;
    let atTop = 0;
    for (let t = 0; t <= DUR; t += 1 / 60) {
      api.update(t, mine);
      if (prev) {
        const v = Math.hypot(n.position.x - prev.x, n.position.z - prev.z) * 60;
        if (v > top) {
          top = v;
          atTop = t;
        }
      }
      prev = { x: n.position.x, z: n.position.z };
    }
    check(`${id} is never pushed faster than 4x the fleet's own top track speed (${top.toFixed(3)} m/s rendered, ${(top / fleetTop).toFixed(2)}x of ${fleetTop.toFixed(3)} m/s, at t=${atTop.toFixed(2)})`,
      top <= fleetTop * 4, `${top} vs ${fleetTop}`);
  }

  // ---- G4: and it is not jitter either. The second difference of the ground-plane position at
  // 60 fps is the acceleration the contact passes are adding, and the honest bound on it is a
  // velocity STEP of one closing speed in one frame: that is what a contact making or breaking
  // physically IS, and demanding zero would be demanding that robots pass through each other
  // politely. Two closing speeds is therefore the cap - enough for a contact to reverse a unit,
  // not enough to move it anywhere it was not already going. It was 207 percent of a robot's
  // radius in a single frame before the axis was conditioned; two track-speeds is 4 percent.
  const collR = api.unitDiscs.find((d) => d.node.name === 'str').r;
  const jumpCap = (2 * fleetTop) / 60;
  for (const id of ['str', 'gk', 'opp']) {
    const n = sm.getObjectByName(id);
    let p1 = null;
    let p2 = null;
    let worst = 0;
    let atWorst = 0;
    for (let t = 0; t <= DUR; t += 1 / 60) {
      api.update(t, mine);
      const p = { x: n.position.x, z: n.position.z };
      if (p1 && p2) {
        const d2 = Math.hypot(p.x - 2 * p1.x + p2.x, p.z - 2 * p1.z + p2.z);
        if (d2 > worst) {
          worst = d2;
          atWorst = t;
        }
      }
      p2 = p1;
      p1 = p;
    }
    check(`${id} never jumps between consecutive 60 fps frames (${((worst / collR) * 100).toFixed(2)}% of its radius at t=${atWorst.toFixed(2)}, cap ${((jumpCap / collR) * 100).toFixed(2)}%)`,
      worst <= jumpCap, `${worst} of ${collR}`);
  }

  // ---- G5: the whole pass is still a pure function of t. Every number above is computed from the
  // raw tracks at absolute times and nothing is carried between frames, and this is the check that
  // says so: play the scene through, scrub back, and demand the same bits.
  const poseAt = (a2, m2) => ['str', 'gk', 'opp'].map((id) => {
    const n = m2.getObjectByName(id);
    return [n.position.x, n.position.y, n.position.z, n.rotation.x, n.rotation.y, n.rotation.z];
  }).flat().concat([api.parts.get('ball').node.position.x, api.parts.get('ball').node.position.y, api.parts.get('ball').node.position.z]);
  api.update(13.5, mine);
  const first = poseAt(api, sm);
  for (let t = 0; t <= DUR; t += 0.25) api.update(t, mine);
  api.update(13.5, mine);
  const again2 = poseAt(api, sm);
  const { mount: fm2, api: fa2 } = build(soccer);
  fa2.update(13.5, mine);
  const freshPose = ['str', 'gk', 'opp'].map((id) => {
    const n = fm2.getObjectByName(id);
    return [n.position.x, n.position.y, n.position.z, n.rotation.x, n.rotation.y, n.rotation.z];
  }).flat().concat([fa2.parts.get('ball').node.position.x, fa2.parts.get('ball').node.position.y, fa2.parts.get('ball').node.position.z]);
  let drift = 0;
  for (let i = 0; i < first.length; i++) drift = Math.max(drift, Math.abs(first[i] - again2[i]), Math.abs(first[i] - freshPose[i]));
  check(`scrubbing the scramble reproduces it bit for bit (max drift ${drift.toExponential(2)})`, drift === 0, `${drift}`);
  fa2.dispose();
  api.dispose();
}

{
  // The same vertical budget at the other end of the scale: the fixture's 594 mm rover, which is
  // where the absolute constants were tuned and where they were worst - 23.04 mm of bob, 3.88
  // percent of its own height, plus a 4.58 degree pitch under braking that no rigid rover does.
  const { mount: rm, api } = build(def.scene_spec);
  const b = bobFraction(api, rm, def.scene_spec.units[0].id, def.duration || 20, 1 / 60);
  check(`the metre-scale rover bobs at most 1.5 percent of its body height (${(b.frac * 100).toFixed(2)}%, ${(b.amp * 1000).toFixed(2)} mm on ${(b.height * 1000).toFixed(0)} mm)`,
    b.frac <= 0.015, `${b.frac}`);
  const n = rm.getObjectByName(def.scene_spec.units[0].id);
  let lean = 0;
  for (let t = 0; t <= (def.duration || 20); t += 1 / 60) {
    api.update(t, mine);
    lean = Math.max(lean, Math.abs(n.rotation.x), Math.abs(n.rotation.z));
  }
  check(`and it never leans past a degree doing it (${((lean * 180) / Math.PI).toFixed(2)} deg)`, lean <= Math.PI / 180, `${lean}`);
  api.dispose();
}

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
