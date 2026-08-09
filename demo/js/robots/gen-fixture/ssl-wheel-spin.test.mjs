// ssl-wheel-spin.test.mjs - the anatomy model's wheel contract, in plain Node.
//
//   node demo/js/robots/gen-fixture/ssl-wheel-spin.test.mjs
//
// No browser and no Playwright. `viewer.js` hands the display model a THREE.Group off the vendored
// three and `ssl/rtt-model.js` deliberately touches no DOM (its one `window` read is the
// reduced-motion probe, and it is wrapped), so the whole thing - the reader, the pivots, the omni
// inverse kinematics and the seek gates - is provable by `node`. The one thing that has to be faked
// is the fetch, because the module resolves its asset against `import.meta.url` and Node's fetch has
// no file: transport: the stub hands back bytes, which is all the reader ever wanted.
//
// What it proves:
//
//   1  THE REAL ASSET STILL LOADS. Every check added below is a check the shipped
//      `rtt-model.mesh` has to pass, so it is read first, in full, and asserted to build four wheel
//      pivots on the real axles. A guard that rejects the production asset would take the step
//      straight to the procedural hull and nothing else in this file would notice.
//
//   2  MALFORMED WHEEL METADATA IS REFUSED, BEFORE THE SCENE IS TOUCHED. Five headers that all
//      decode cleanly and all describe a drive this reader cannot spin: three specs for four wheel
//      groups (the incomplete-metadata case, which used to build one welded wheel and three turning
//      ones), one group named twice, a spec for a group `anatomy.omni` does not list, five specs,
//      and a fifth group listed under `anatomy.omni` with no spec. Each has to reject AND leave the
//      procedural robot exactly as it found it: every child still visible, no wireframe attached.
//      That is the whole argument for being strict - the fallback is a working step.
//
//   3  THE 53.5 TO 54.08 s LOOP SEAM IS NEVER INTEGRATED, AT 30 fps. The dribbler beat replays
//      0.58 s of log over the tour's 2.9 s hold and loops, so bot 8's pose jumps 0.157 m backwards
//      across the seam every 2.9 seconds. One 33 ms frame of that reads as 4.7 m/s - which the old
//      6 m/s gate accepted, and which is a visible flick on all four wheels once per loop. At 60 fps
//      the same seam reads as 9.4 m/s and was caught, which is exactly why it was only ever visible
//      at 30. So the seam is driven here at 30, 60 and 120 fps and the wheels must not move on the
//      wrap frame at all.
//
//   4  AND NORMAL MOTION SURVIVES THE GATES. Same driver, the omni beat, all three frame rates: the
//      wheels turn on essentially every frame, the peak rate matches the one the module's header
//      argues for (about 6.6 degrees a frame at 60 fps), and the frame straight after a wrap turns
//      again - which is what "resample, integrate nothing" has to mean. A gate tight enough to
//      refuse a seam and loose enough to pass 30 fps is the whole point, and both halves are only
//      one number apart, so both halves are measured.
//
//   5  ALL FOUR BEATS, not only the two the guard was reasoned about. The imu beat's seam is mostly a
//      2.25 rad yaw snap and the kicker beat's is 1.71 m of travel, so between them the three gates
//      are each the one doing the catching somewhere in this tour.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SSL = path.join(HERE, '..', 'ssl');

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
function between(actual, lo, hi, msg) {
  ok(actual >= lo && actual <= hi, `${msg}  (got ${actual}, want ${lo}..${hi})`);
}
function section(name) {
  console.log(`\n${name}`);
}

const THREE = await import('../../../vendor/three.module.js');
const { installAnatomyModel } = await import('../ssl/rtt-model.js');
const dec = await import('../ssl/decode.js');
const matchMod = await import('../ssl/match-data.js');

const MESH = path.join(SSL, 'rtt-model.mesh');
const raw = new Uint8Array(await readFile(MESH));

// ---------------------------------------------------------------- the asset, as bytes

const align4 = (n) => n + ((4 - (n % 4)) % 4);

/** The shipped header, parsed, plus every group's two blocks copied out. */
function unpack(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen)));
  const blocks = header.groups.map((g) => ({
    pos: bytes.slice(g.pos.byteOffset, g.pos.byteOffset + g.pos.byteLength),
    idx: bytes.slice(g.idx.byteOffset, g.idx.byteOffset + g.idx.byteLength),
  }));
  return { header, blocks };
}

/**
 * Write a header back out over the same blocks, offsets and all.
 *
 * The layout is `assets-src/rtt/pack.py`'s, including its fixed point: the header carries the byte
 * offsets and the header's own length decides where the blocks start, so serialize, lay out, and
 * re-serialize until the length stops moving. Doing it the writer's way rather than padding the JSON
 * is what makes these fixtures real assets - a reader that rejected them for the wrong reason (a bad
 * offset rather than a bad drive) would pass this test while proving nothing.
 */
function repack(header, blocks) {
  const enc = new TextEncoder();
  for (const g of header.groups) {
    g.pos.byteOffset = 0;
    g.idx.byteOffset = 0;
  }
  let head = enc.encode(JSON.stringify(header));
  let end = 0;
  for (let pass = 0; pass < 6; pass++) {
    let cursor = align4(8 + head.length);
    header.groups.forEach((g, i) => {
      g.pos.byteOffset = cursor;
      cursor = align4(cursor + blocks[i].pos.length);
      g.idx.byteOffset = cursor;
      cursor = align4(cursor + blocks[i].idx.length);
    });
    end = cursor;
    const cand = enc.encode(JSON.stringify(header));
    const settled = cand.length === head.length;
    head = cand;
    if (settled) break;
  }
  const out = new Uint8Array(end);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('RTT1'), 0);
  dv.setUint32(4, head.length, true);
  out.set(head, 8);
  header.groups.forEach((g, i) => {
    out.set(blocks[i].pos, g.pos.byteOffset);
    out.set(blocks[i].idx, g.idx.byteOffset);
  });
  return out;
}

const shipped = unpack(raw);
/** A deep copy of the shipped header, for a fixture to bend. */
const freshHeader = () => JSON.parse(JSON.stringify(shipped.header));

// ---------------------------------------------------------------- the scene, as the viewer builds it

const ANATOMY_BOT = 'bot_y8';

/**
 * The viewer's robot root with one procedural robot under it, which is the whole calling convention:
 * a named group with visible children, exactly what `ssl/scene.js` leaves for the model to hang on
 * and to hide. Three children rather than one so "restored verbatim" has something to be wrong about.
 */
function stage() {
  const mount = new THREE.Group();
  const bot = new THREE.Group();
  bot.name = ANATOMY_BOT;
  for (let i = 0; i < 3; i++) {
    const child = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.09));
    child.name = `hull-piece-${i}`;
    bot.add(child);
  }
  mount.add(bot);
  return { mount, bot };
}

/** Install over a stubbed fetch that serves `bytes`, and put the real fetch back either way. */
async function install(mount, bytes) {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  try {
    return await installAnatomyModel(THREE, mount, { bot: ANATOMY_BOT });
  } finally {
    globalThis.fetch = prev;
  }
}

// ---------------------------------------------------------------- 1. the shipped asset

section('1  the shipped asset builds four wheels');
{
  const { mount, bot } = stage();
  const handle = await install(mount, raw);
  ok(!!handle, 'the real rtt-model.mesh installs');
  const root = bot.getObjectByName('rtt-wireframe');
  ok(!!root, 'the wireframe is parented into the subject robot');
  const wheels = shipped.header.wheels;
  eq(wheels.length, 4, 'the shipped asset carries four wheel specs');
  eq(shipped.header.anatomy.omni.length, 4, 'and anatomy.omni lists four groups');
  for (const w of wheels) {
    const pivot = root && root.getObjectByName(`rtt-${w.group}`);
    ok(!!pivot, `${w.group} has a pivot`);
    if (!pivot) continue;
    ok(
      Math.hypot(pivot.position.x - w.centre[0], pivot.position.y - w.centre[1], pivot.position.z - w.centre[2]) < 1e-9,
      `${w.group}'s pivot sits on the axle point the header measured`,
    );
    ok(pivot.children.length > 0, `${w.group}'s pieces hang under its pivot`);
  }
  eq(
    bot.children.filter((c) => c.name.startsWith('hull-piece') && c.visible).length,
    0,
    'the procedural robot steps aside while the model is up',
  );
  handle.dispose();
  eq(
    bot.children.filter((c) => c.name.startsWith('hull-piece') && c.visible).length,
    3,
    'and every child is restored verbatim on dispose',
  );
  eq(bot.getObjectByName('rtt-wireframe'), undefined, 'the wireframe is detached on dispose');
}

// ---------------------------------------------------------------- 2. malformed wheel metadata

section('2  malformed wheel metadata is refused before the scene is touched');
{
  const W = () => freshHeader().wheels;
  const cases = [
    [
      'three specs for four omni groups',
      (h) => {
        h.wheels = W().slice(0, 3);
      },
    ],
    [
      'one group named twice',
      (h) => {
        const w = W();
        h.wheels = [w[0], w[1], w[2], JSON.parse(JSON.stringify(w[0]))];
      },
    ],
    [
      'a spec for a group anatomy.omni does not list',
      (h) => {
        const w = W();
        w[3].group = 'kicker';
        h.wheels = w;
      },
    ],
    [
      'five specs',
      (h) => {
        const w = W();
        const extra = JSON.parse(JSON.stringify(w[3]));
        extra.group = 'kicker';
        h.wheels = [...w, extra];
      },
    ],
    [
      'a fifth group listed under anatomy.omni with no spec',
      (h) => {
        h.anatomy.omni = [...h.anatomy.omni, 'kicker'];
      },
    ],
  ];

  for (const [name, bend] of cases) {
    const header = freshHeader();
    bend(header);
    const bytes = repack(header, shipped.blocks);
    const { mount, bot } = stage();
    let threw = null;
    let handle;
    try {
      handle = await install(mount, bytes);
    } catch (err) {
      threw = err;
    }
    ok(!!threw, `${name}: rejected`);
    ok(!handle, `${name}: no handle`);
    ok(threw && !threw.stale, `${name}: not retried as a stale cache`);
    eq(bot.getObjectByName('rtt-wireframe'), undefined, `${name}: nothing attached to the robot`);
    eq(
      bot.children.filter((c) => c.visible).length,
      3,
      `${name}: the procedural hull is still visible, so the step still works`,
    );
  }

  // And the reverse: bending nothing has to still install, or the five cases above prove only that
  // `repack` produces a file this reader hates.
  const control = repack(freshHeader(), shipped.blocks);
  const { mount, bot } = stage();
  const handle = await install(mount, control);
  ok(!!handle, 'control: a repacked but unmodified header installs');
  ok(!!bot.getObjectByName('rtt-wireframe'), 'control: and attaches');
  if (handle) handle.dispose();
}

// ---------------------------------------------------------------- 3 and 4. the replay driver

/**
 * bot 8's pose, sampled the way `ssl/scene.js` samples it: the payload's own hermite through
 * `decode.js`, on the robot grid, with yaw read continuous and unwrapped by contract. The scene
 * writes `position.set(x, 0, -y)` and `rotation.y = yaw`, so that is what this writes.
 */
const M = dec.decodeMatchData(matchMod);
const SUBJECT = M.robots.find((r) => r.key === ANATOMY_BOT);
if (!SUBJECT) throw new Error('bot_y8 is not in this payload');
const poseAt = (t) => ({
  x: dec.sampleSeries(M.tRobot, SUBJECT.present, SUBJECT.x, SUBJECT.vx, t),
  y: dec.sampleSeries(M.tRobot, SUBJECT.present, SUBJECT.y, SUBJECT.vy, t),
  yaw: dec.sampleSeries(M.tRobot, SUBJECT.present, SUBJECT.yaw, SUBJECT.w, t),
});

const TOUR_HOLD_S = 2.9; // viewer.js TOUR_HOLD_MS
const TAU = Math.PI * 2;

/**
 * How far a pivot is turned about its OWN axle, in radians.
 *
 * `setFromAxisAngle` writes `xyz = axis * sin(a/2)`, `w = cos(a/2)`, so this inverts it exactly. Read
 * this way rather than through `Quaternion.angleTo`, which has a noise floor here: `angleTo` is
 * `2 * acos(|dot|)` and the module's quaternions are unit to about 1e-8, so the angle between a
 * quaternion and ITSELF comes back as about 1.4e-4 rad. That is the same order as one 120 fps frame
 * of the dribbler beat, which would make "the wheels did not move" unassertable.
 */
function wheelAngle(pivot, axis) {
  const q = pivot.quaternion;
  return 2 * Math.atan2(q.x * axis[0] + q.y * axis[1] + q.z * axis[2], q.w);
}

/** Shortest arc from `a` to `b`, because the module holds its angle modulo a full turn. */
function arc(a, b) {
  let d = b - a;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * One beat of the anatomy tour, replayed frame by frame with the wheels measured.
 *
 * Two clocks, exactly as the real thing: the wall clock advances one frame per step and is what
 * `step()` differentiates against, and mission time advances by the beat's derived replay speed and
 * wraps inside the beat's window the way `core/timeline.js` wraps a loop. Per-frame wheel movement is
 * read as the angle between successive pivot quaternions, which is the number a visitor sees.
 */
async function runBeat(window, fps, seconds) {
  const [lo, hi] = window;
  const { mount, bot } = stage();
  const handle = await install(mount, raw);
  const root = bot.getObjectByName('rtt-wireframe');
  const axes = shipped.header.wheels.map((w) => w.axis);
  const pivots = shipped.header.wheels.map((w) => root.getObjectByName(`rtt-${w.group}`));
  const prev = pivots.map((p, i) => wheelAngle(p, axes[i]));
  const speed = (hi - lo) / TOUR_HOLD_S;
  const dtWall = 1000 / fps;
  const frames = Math.round(seconds * fps);
  let t = lo;
  let wall = 1234; // an arbitrary rAF origin, because nothing here may depend on it being zero
  const out = { wrapMax: 0, wrapFrames: 0, moveMax: 0, moved: 0, afterWrapMin: Infinity, frames: 0, jump: 0 };
  for (let f = 0; f < frames; f++) {
    const before = t;
    t += (dtWall / 1000) * speed;
    let wrapped = false;
    if (t >= hi) {
      t = lo + ((t - lo) % (hi - lo));
      wrapped = true;
      const a = poseAt(before);
      const b = poseAt(t);
      out.jump = Math.max(out.jump, Math.hypot(b.x - a.x, b.y - a.y));
    }
    const p = poseAt(t);
    bot.position.set(p.x, 0, -p.y);
    bot.rotation.y = p.yaw;
    wall += dtWall;
    handle.step(wall);
    let delta = 0;
    for (let i = 0; i < pivots.length; i++) {
      const now = wheelAngle(pivots[i], axes[i]);
      delta = Math.max(delta, Math.abs(arc(prev[i], now)));
      prev[i] = now;
    }
    // The first frame has no previous pose to differentiate, so it is a resample by design.
    if (f === 0) continue;
    out.frames++;
    if (wrapped) {
      out.wrapFrames++;
      out.wrapMax = Math.max(out.wrapMax, delta);
      out.afterWrap = true;
    } else {
      out.moveMax = Math.max(out.moveMax, delta);
      if (delta > 0) out.moved++;
      if (out.afterWrap) {
        out.afterWrapMin = Math.min(out.afterWrapMin, delta);
        out.afterWrap = false;
      }
    }
  }
  handle.dispose();
  return out;
}

const OMNI = [2.62, 4.42];
const DRIBBLER = [53.5, 54.08];

section('3  the dribbler beat seam is never integrated');
for (const fps of [30, 60, 120]) {
  // Three holds, so at least two seams are crossed at every frame rate.
  const r = await runBeat(DRIBBLER, fps, TOUR_HOLD_S * 3);
  ok(r.wrapFrames >= 2, `${fps} fps: the beat wrapped at least twice  (${r.wrapFrames})`);
  eq(r.wrapMax, 0, `${fps} fps: no wheel moves on a wrap frame`);
  ok(
    r.jump > 0.15,
    `${fps} fps: the seam really is a teleport the gate has to catch  (${r.jump.toFixed(4)} m, gate 0.12 m)`,
  );
  // What the gate is worth: 0.157 m over one frame at this rate, spun through the omni kinematics,
  // is the flick that used to ship. Anything remotely near it here is a regression.
  ok(r.moveMax < 0.05, `${fps} fps: every integrated frame is a small turn  (max ${r.moveMax.toFixed(5)} rad)`);
  ok(r.moved > r.frames * 0.9, `${fps} fps: and the wheels are turning  (${r.moved}/${r.frames} frames)`);
  ok(
    r.afterWrapMin > 0,
    `${fps} fps: the frame after a wrap resamples and turns again  (${r.afterWrapMin.toExponential(2)} rad)`,
  );
}

section('4  the omni beat runs normally at every frame rate');
for (const fps of [30, 60, 120]) {
  const r = await runBeat(OMNI, fps, TOUR_HOLD_S * 2);
  ok(r.wrapFrames >= 1, `${fps} fps: the beat wrapped  (${r.wrapFrames})`);
  eq(r.wrapMax, 0, `${fps} fps: no wheel moves on a wrap frame`);
  ok(r.moved === r.frames - r.wrapFrames, `${fps} fps: every non-wrap frame integrated  (${r.moved}/${r.frames - r.wrapFrames})`);
  ok(
    r.afterWrapMin > 0,
    `${fps} fps: the frame after a wrap resamples and turns again  (${r.afterWrapMin.toFixed(5)} rad)`,
  );
  // The module's header argues the peak on-screen rate down to half a roller pitch per frame at
  // 60 Hz: 1.83 m/s over a 26.5 mm rolling radius, scaled by 0.1, is 6.9 rad/s, which is 0.115 rad
  // a frame at 60 fps and halves and doubles with the frame rate. This is the one assertion that
  // would catch SPIN_SCALE being changed without the argument being changed with it.
  const want = 6.9 / fps;
  between(r.moveMax, want * 0.75, want * 1.25, `${fps} fps: peak wheel rate matches the argued 6.9 rad/s`);
}

section('5  and every beat of the tour behaves, not just the two that were reasoned about');
{
  // The other two seams are caught by different halves of the guard, which is the point of checking
  // them: the imu beat's wrap is a 2.25 rad yaw snap (0.91 m of travel with it) and the kicker beat's
  // is 1.71 m. Both are at 30 fps, the rate the dribbler seam needed to be visible at.
  for (const [name, window] of [
    ['imu', [0.7, 1.62]],
    ['kicker', [4.42, 5.92]],
  ]) {
    const r = await runBeat(window, 30, TOUR_HOLD_S * 2);
    ok(r.wrapFrames >= 1, `${name}: the beat wrapped  (${r.wrapFrames})`);
    eq(r.wrapMax, 0, `${name}: no wheel moves on a wrap frame`);
    ok(r.moved > r.frames * 0.9, `${name}: the wheels are turning  (${r.moved}/${r.frames} frames)`);
    ok(r.moveMax < 0.2, `${name}: no integrated frame is a jump  (max ${r.moveMax.toFixed(5)} rad)`);
    ok(r.afterWrapMin > 0, `${name}: the frame after a wrap resamples and turns again`);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
