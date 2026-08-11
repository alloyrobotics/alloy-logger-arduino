// synthetic-replay-loop.test.mjs - the replay-loop contract for the three DETERMINISTIC missions.
//
//   node demo/js/robots/gen-fixture/synthetic-replay-loop.test.mjs
//
// This directory is in .assetsignore, so nothing here is ever served.
//
// WHY THIS FILE EXISTS. Round 5 split `finding.loop` off `finding.window`: `window` is what the
// CHART plots and shades, `loop` is the tight span the 3D replay actually plays on a lap. The rule
// is "roughly half a second before the measurable onset, the failure, shortly after the consequence
// has landed" - cut the cruising at the head and the tail, because a lap of nominal operation
// conveys nothing.
//
// ssl, battle and donna already had a data test to hang that assertion on, so their loop edges are
// checked in ssl-data.test.mjs, battle-data.test.mjs and donna-data.test.mjs against their decoded
// payloads. sbr, arm6 and rescue had none. They are the three SYNTHESIZED missions: every series is
// generated from one seeded stream, so an edge written into `data.js` can be re-derived here from
// the built arrays exactly, and this file is that derivation.
//
// What it proves, per mission:
//   1  the generic contract - ordered loop, inside its own chart window, tighter than it, and a lap
//      a visitor will actually sit through at the finding's declared speed
//   2  a finding whose window IS the whole log declares no loop, because that window is a statement
//      that the channel is context for every second and `embeds.js` deliberately ignores a loop on
//      one (see the `full` branch in core/embeds.js)
//   3  the measured onset each loop opens on, and the measured consequence it closes after, sample
//      for sample off the built series. Every number quoted in the comment beside a `loop` in
//      data.js is re-derived here, so prose and playback cannot drift apart.

import { mulberry32, seedFor } from '../../core/prng.js';

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function near(actual, expected, tol, msg) {
  ok(Math.abs(actual - expected) <= tol, `${msg}  (got ${actual}, want ${expected} +/- ${tol})`);
}
function section(name) {
  console.log(`\n${name}`);
}

/** The wall-clock lap a visitor waits: the loop's span over the finding's declared speed. */
const LAP_MAX_S = 5.0;

const MISSIONS = ['sbr', 'arm6', 'rescue'];
const MODULES = {};
const DATA = {};
for (const id of MISSIONS) {
  MODULES[id] = await import(`../${id}/data.js`);
  DATA[id] = MODULES[id].buildData(mulberry32(seedFor(id)));
}

/** Nearest sample index on a channel's own uniform grid. */
const idx = (id, path, s) => {
  const t = DATA[id][path].t;
  const i = Math.round((s - t[0]) / (t[1] - t[0]));
  return Math.max(0, Math.min(t.length - 1, i));
};
const at = (id, path, field, s) => DATA[id][path][field][idx(id, path, s)];
const r2 = (v) => Math.round(v * 100) / 100;
const findingOf = (id, fid) => MODULES[id].findings.find((f) => f.id === fid);

/** First sample time in [a, b] where `pred` holds, else null. */
function firstWhere(id, path, a, b, pred) {
  const block = DATA[id][path];
  for (let i = 0; i < block.t.length; i++) {
    if (block.t[i] < a - 1e-9 || block.t[i] > b + 1e-9) continue;
    if (pred(block, i)) return block.t[i];
  }
  return null;
}

/** Last sample time in [a, b] where `pred` holds, else null. */
function lastWhere(id, path, a, b, pred) {
  const block = DATA[id][path];
  let found = null;
  for (let i = 0; i < block.t.length; i++) {
    if (block.t[i] < a - 1e-9 || block.t[i] > b + 1e-9) continue;
    if (pred(block, i)) found = block.t[i];
  }
  return found;
}

/** Extreme of a field over [a, b]. */
function extreme(id, path, field, a, b, better) {
  const block = DATA[id][path];
  let bestT = null;
  let bestV = null;
  for (let i = 0; i < block.t.length; i++) {
    if (block.t[i] < a - 1e-9 || block.t[i] > b + 1e-9) continue;
    if (bestV === null || better(block[field][i], bestV)) {
      bestV = block[field][i];
      bestT = block.t[i];
    }
  }
  return { t: bestT, v: bestV };
}
const maxIn = (id, p, f, a, b) => extreme(id, p, f, a, b, (x, y) => x > y);
const minIn = (id, p, f, a, b) => extreme(id, p, f, a, b, (x, y) => x < y);

// ---------------------------------------------------------------- 1, 2. the generic contract

section('1, 2. the loop contract, every synthetic finding');
for (const id of MISSIONS) {
  const duration = MODULES[id].duration;
  for (const f of MODULES[id].findings) {
    const wholeLog = f.window[0] <= 0 && f.window[1] >= duration;
    if (wholeLog) {
      ok(!Array.isArray(f.loop), `${id}/${f.id}: a whole-log window declares no loop`);
      continue;
    }
    ok(Array.isArray(f.loop) && f.loop.length === 2, `${id}/${f.id}: declares a replay loop pair`);
    if (!Array.isArray(f.loop)) continue;
    ok(f.loop[0] < f.loop[1], `${id}/${f.id}: loop is ordered`);
    ok(f.loop[0] >= 0 && f.loop[1] <= duration, `${id}/${f.id}: loop is inside [0, ${duration}]`);
    ok(
      f.loop[0] >= f.window[0] && f.loop[1] <= f.window[1],
      `${id}/${f.id}: loop sits inside its chart window ${JSON.stringify(f.window)}`,
    );
    ok(
      f.loop[1] - f.loop[0] < f.window[1] - f.window[0],
      `${id}/${f.id}: the loop is tighter than the window it plots`,
    );
    const lap = (f.loop[1] - f.loop[0]) / (f.slowmo ? 0.4 : 1);
    ok(lap <= LAP_MAX_S, `${id}/${f.id}: one lap is ${lap.toFixed(2)} s of wall clock at ${f.slowmo ? 0.4 : 1}x`);
  }
}

// ---------------------------------------------------------------- 3. sbr

section('3. sbr - the balancer');
{
  const SETPOINT = 0.5;
  const T_P1 = 51.46; // last clean backward peak
  const T_P2 = 51.66; // the forward whip
  const T_DOWN_1 = 52.0; // pitch crosses TILT_FAULT
  const T_STALL = 31.36;

  // fall - the onset sits between the last clean peak and the whip; the consequence is the robot
  // flat on its face, and the loop closes before the operator stands it back up.
  {
    const f = findingOf('sbr', 'fall');
    near(f.loop[0], 51.0, 1e-9, 'fall loop opens at 51.0 s');
    near(f.loop[1], 53.0, 1e-9, 'fall loop closes at 53.0 s');
    near(at('sbr', '/balance', 'pitch', T_P1) - SETPOINT, -2.5, 0.01, 'the last clean peak is 2.50 deg off setpoint');
    near(at('sbr', '/balance', 'pitch', T_P2), 7.12, 0.01, 'and the next peak is already the +7.12 deg whip');
    ok(T_P1 - f.loop[0] >= 0.4 && T_P1 - f.loop[0] <= 1.0, 'the onset has ~0.5 s of healthy limit cycle in front of it');
    near(at('sbr', '/balance', 'pitch', T_DOWN_1), 20.0, 0.01, 'pitch crosses TILT_FAULT at 52.0 s, inside the loop');
    const face = firstWhere('sbr', '/balance', 51.0, 53.0, (b, i) => b.pitch[i] > 85);
    near(face, 52.34, 0.02, 'it is past 85 deg from 52.34 s');
    const peak = maxIn('sbr', '/balance', 'pitch', 51.0, 53.0);
    near(peak.v, 88.6, 0.05, 'peaking at 88.60 deg');
    near(peak.t, 52.42, 0.02, 'at 52.42 s');
    near(at('sbr', '/balance', 'pitch', f.loop[1]), 86.09, 0.05, 'and it is still 86.09 deg at the close');
    ok(f.loop[1] - face >= 0.6, 'so the lap carries 0.6 s of the settled fail state');
    ok(at('sbr', '/balance', 'pitch', 53.2) < 70, 'the stand-up starts after the close and is NOT replayed');
  }

  // divergence - the ring doubling is the finding, and the loop closes past the whip and the
  // backswing but short of the fall, which is the next finding's story.
  {
    const f = findingOf('sbr', 'divergence');
    near(f.loop[0], 49.9, 1e-9, 'divergence loop opens at 49.9 s');
    near(f.loop[1], 51.9, 1e-9, 'divergence loop closes at 51.9 s');
    const dev = (s) => Math.abs(at('sbr', '/balance', 'pitch', s) - SETPOINT);
    near(dev(50.14), 1.3, 0.02, 'peak deviation is 1.30 deg at 50.14 s');
    near(dev(50.4), 1.56, 0.02, '1.56 deg at 50.40 s, this finding s t');
    near(dev(50.94), 1.94, 0.02, '1.94 deg at 50.94 s');
    near(dev(51.2), 2.19, 0.02, '2.19 deg at 51.20 s');
    near(dev(T_P1), 2.5, 0.02, 'and 2.50 deg at 51.46 s - it doubles across the lap');
    near(f.loop[1] - T_P2, 0.24, 1e-9, 'the loop closes 0.24 s past the whip');
    const back = minIn('sbr', '/balance', 'pitch', T_P2, f.loop[1]);
    near(back.v, -10.06, 0.05, 'far enough to carry the -10.06 deg backswing');
    near(back.t, 51.8, 0.02, 'at 51.80 s');
    ok(f.loop[1] < T_DOWN_1, 'and it stops before TILT_FAULT, so it does not spoil the fall');
  }

  // i2c-stall - the one that survives. The consequence is the catch, not a failure.
  {
    const f = findingOf('sbr', 'i2c-stall');
    near(f.loop[0], 30.9, 1e-9, 'i2c loop opens at 30.9 s');
    near(f.loop[1], 33.0, 1e-9, 'i2c loop closes at 33.0 s');
    near(at('sbr', '/balance', 'i2c_dt', T_STALL), 801.9, 0.05, 'the 801.9 ms stall is at 31.36 s');
    ok(T_STALL - f.loop[0] >= 0.4 && T_STALL - f.loop[0] <= 1.0, 'with ~0.5 s of the healthy ring in front of it');
    const quiet = maxIn('sbr', '/balance', 'pitch', 28.0, T_STALL);
    const quietLow = minIn('sbr', '/balance', 'pitch', 28.0, T_STALL);
    ok(
      Math.max(Math.abs(quiet.v - SETPOINT), Math.abs(quietLow.v - SETPOINT)) < 0.35,
      'the ring holds inside +/-0.34 deg of setpoint for the 3.3 s before the stall',
    );
    near(at('sbr', '/balance', 'pitch', 31.5), 6.26, 0.02, 'the starved loop lurches to +6.26 deg at 31.50 s');
    near(at('sbr', '/balance', 'pitch', 32.12), -1.69, 0.02, 'overshoots back to -1.69 deg at 32.12 s');
    const backThrough = firstWhere('sbr', '/balance', 32.12, 33.0, (b, i) => b.pitch[i] > SETPOINT);
    near(backThrough, 32.84, 0.02, 'and is back through the 0.5 deg setpoint at 32.84 s, inside the loop');
  }
}

// ---------------------------------------------------------------- 3. arm6

section('3. arm6 - the pick and place');
{
  const DROP_T = MODULES.arm6.DROP_T;

  // drop - the failure step's finding, also pinned end to end by flow-walk.test.mjs.
  {
    const f = findingOf('arm6', 'drop');
    near(DROP_T - f.loop[0], 0.5, 1e-9, 'the drop loop opens 0.5 s before the release');
    near(f.loop[1] - DROP_T, 1.0, 1e-9, 'and closes 1.0 s after it, which is the fall plus the bounce');
    near(at('arm6', '/joints', 'tau2', f.loop[0]), 12.0, 0.02, 'tau2 is already flat on its 12 Nm clamp at the open');
    ok(at('arm6', '/joints', 'tau2', f.loop[1]) < 8, 'and has collapsed by the close');
  }

  // follow-err - the onset is err2 leaving the nominal high the rest of the run never exceeds.
  {
    const f = findingOf('arm6', 'follow-err');
    near(f.loop[0], 54.4, 1e-9, 'follow-err loop opens at 54.4 s');
    near(f.loop[1], 56.8, 1e-9, 'follow-err loop closes at 56.8 s');
    const clamp = firstWhere('arm6', '/joints', 50, 58, (b, i) => b.tau2[i] >= 11.995);
    near(clamp, 53.68, 0.02, 'tau2 first touches the 12.00 Nm clamp at 53.68 s');
    const lastDip = lastWhere('arm6', '/joints', 53, DROP_T, (b, i) => b.tau2[i] < 11.995);
    near(lastDip + 0.02, 54.24, 0.02, 'and is pinned on it continuously from 54.24 s, before the loop opens');
    const nominal = maxIn('arm6', '/ctl', 'err2', 0, f.loop[0]);
    near(nominal.v, 1.04, 0.02, 'err2 nominal high over the whole healthy run is 1.04 deg');
    near(nominal.t, 40.92, 0.02, 'set at 40.92 s, nowhere near this failure');
    const onset = firstWhere('arm6', '/ctl', f.loop[0], f.loop[1], (b, i) => b.err2[i] > nominal.v);
    near(onset, 54.9, 0.02, 'and err2 first exceeds it at 54.90 s');
    ok(onset - f.loop[0] >= 0.4 && onset - f.loop[0] <= 1.0, 'so the onset has ~0.5 s of nominal following in front of it');
    near(at('arm6', '/ctl', 'err2', 55.3), 2.33, 0.02, 'then 2.33 deg at 55.30 s');
    near(at('arm6', '/ctl', 'err2', 55.8), 4.56, 0.02, '4.56 deg at 55.80 s');
    const runaway = maxIn('arm6', '/ctl', 'err2', f.loop[0], f.loop[1]);
    near(runaway.v, 7.5, 0.02, 'and 7.50 deg at the peak');
    near(runaway.t, 56.32, 0.02, 'at 56.32 s, the sample the part leaves the jaws');
    near(at('arm6', '/ctl', 'err2', f.loop[1]), 0.33, 0.02, 'err2 has collapsed to 0.33 deg by the close');
    near(maxIn('arm6', '/ctl', 'err_max', f.loop[0], f.loop[1]).v, 7.5, 0.02, 'err_max peaks with it at 7.50');
    near(at('arm6', '/ctl', 'err_max', f.loop[1]), 0.58, 0.02, 'and has decayed to 0.58 by the close - it is a peak-hold, not a latch');
    ok(f.loop[1] - runaway.t >= 0.4, 'so the lap carries ~0.5 s of the settled state');
  }
}

// ---------------------------------------------------------------- 3. rescue

section('3. rescue - the tracked climb');
{
  // stall - the onset is the current crossing and the command-speed gap opening on the same two
  // samples; the consequence is the robot sliding back down with a forward command still on.
  {
    const f = findingOf('rescue', 'stall');
    near(f.loop[0], 47.0, 1e-9, 'stall loop opens at 47.0 s');
    near(f.loop[1], 49.0, 1e-9, 'stall loop closes at 49.0 s');
    const cruiseHi = maxIn('rescue', '/drive', 'i_l', f.loop[0], 47.52).v;
    const cruiseLo = minIn('rescue', '/drive', 'i_l', f.loop[0], 47.52).v;
    near(cruiseLo, 8.71, 0.05, 'the healthy climb draws 8.7 A at the open');
    ok(cruiseHi < 10, `and stays under 10 A right up to the crossing (${r2(cruiseHi)} A)`);
    near(at('rescue', '/drive', 'cmd_l', f.loop[0]), 0.35, 0.01, 'with cmd_l held at 0.35 m/s');
    const cross = firstWhere('rescue', '/drive', 44, 52, (b, i) => b.i_l[i] >= 10);
    near(cross, 47.54, 0.02, 'i_l crosses 10 A at 47.54 s');
    const gap = firstWhere('rescue', '/drive', 44, 52, (b, i) => b.cmd_l[i] - b.vel_l[i] > 0.08);
    near(gap, 47.56, 0.02, 'and the command-speed gap opens past 0.08 m/s at 47.56 s');
    ok(cross - f.loop[0] >= 0.4 && cross - f.loop[0] <= 1.0, 'so the onset has 0.54 s of the healthy climb in front of it');
    const peak = maxIn('rescue', '/drive', 'i_l', f.loop[0], f.loop[1]);
    near(peak.v, 22.8, 0.05, 'i_l peaks at 22.80 A');
    near(peak.t, 48.36, 0.02, 'at 48.36 s');
    ok(Math.abs(at('rescue', '/drive', 'vel_l', peak.t)) < 0.05, 'with the track stopped dead');
    const slide = firstWhere('rescue', '/drive', 48, 52, (b, i) => b.vel_l[i] < 0);
    near(slide, 48.5, 0.02, 'vel_l goes negative at 48.50 s');
    ok(f.loop[1] - slide >= 0.45, 'so the lap carries 0.50 s of the slide back down');
    ok(at('rescue', '/drive', 'cmd_l', f.loop[1]) > 0.3, 'with a forward command still on at the close');
    const givesUp = firstWhere('rescue', '/drive', 49, 54, (b, i) => b.cmd_l[i] < 0.01);
    ok(givesUp > f.loop[1], `the operator giving up at ${r2(givesUp)} s stays CHART context`);
  }

  // retry - the success beat. Everything before the crest is a constant-speed climb that looks
  // identical to the failed one, so the loop opens on the break over the top and not before it.
  {
    const f = findingOf('rescue', 'retry');
    near(f.loop[0], 62.25, 1e-9, 'retry loop opens at 62.25 s');
    near(f.loop[1], 65.6, 1e-9, 'retry loop closes at 65.6 s');
    const flipperDown = firstWhere('rescue', '/flipper', 56, 62, (b, i) => b.front[i] <= -34);
    near(flipperDown, 58.28, 0.02, 'the front flipper is down past -34 deg from 58.28 s');
    const resume = firstWhere('rescue', '/drive', 56, 62, (b, i) => b.cmd_l[i] > 0.01);
    near(resume, 58.7, 0.02, 'and cmd_l resumes at 58.70 s');
    let track = 0;
    for (let s = 58.72; s <= 62.5; s += 0.02) {
      track = Math.max(track, Math.abs(at('rescue', '/drive', 'cmd_l', s) - at('rescue', '/drive', 'vel_l', s)));
    }
    ok(track < 0.08, `vel_l tracks cmd_l to within ${r2(track)} m/s across that climb - nothing to see`);
    ok(maxIn('rescue', '/drive', 'i_l', 58.72, 62.5).v <= 15.31, 'and current never passes the 15.3 A the chat answer quotes');
    const facePeak = maxIn('rescue', '/imu', 'pitch', 56, 66);
    near(facePeak.v, 31.18, 0.05, 'body pitch rings to 31.18 deg against the face');
    near(facePeak.t, 61.3, 0.02, 'at 61.30 s');
    const lastOnFace = lastWhere('rescue', '/imu', 60, 66, (b, i) => b.pitch[i] >= 28);
    near(lastOnFace, 62.74, 0.02, 'takes its LAST sample above 28 deg at 62.74 s');
    ok(
      lastOnFace - f.loop[0] >= 0.45 && lastOnFace - f.loop[0] <= 1.0,
      `so the break over the top has ${r2(lastOnFace - f.loop[0])} s of the climb in front of it`,
    );
    near(at('rescue', '/imu', 'pitch', 63.96), 13.85, 0.05, 'then 13.85 deg at 63.96 s');
    const crest = firstWhere('rescue', '/imu', 63, 66, (b, i) => b.pitch[i] < 5);
    near(crest, 64.64, 0.02, 'and under 5 deg at 64.64 s, the 64.6 s crest the chat answer quotes');
    ok(crest > f.loop[0] && crest < f.loop[1], 'which is inside the lap');
    ok(at('rescue', '/imu', 'pitch', f.loop[1]) < 1, 'the close is level');
    near(at('rescue', '/drive', 'i_l', f.loop[1]), 7.0, 0.05, 'with i_l off the climb load at 7.00 A');
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
