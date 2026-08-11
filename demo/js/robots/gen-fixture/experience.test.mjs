// experience.test.mjs - the four active mission experience blocks resolve against live defs and scenes.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../../vendor/three.module.js';
import { mulberry32, seedFor } from '../../core/prng.js';
import { ROBOTS_BY_ID } from '../index.js';
import { applyRoleOpeners as applySslSideModule } from '../ssl/role-openers.js';
import { applyExperience as applyDonnaExperience } from '../donna/experience.js';
import { FIELD, T_FAIL, LANE_Y } from '../drone/data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MISSIONS = ['arm6', 'drone', 'ssl', 'donna'];

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const section = (name) => console.log(`\n${name}`);
/** A measured quantity against the number the source comments quote, on the sample grid's own tolerance. */
function near(actual, expected, tol, msg) {
  ok(Math.abs(actual - expected) <= tol, `${msg}  (got ${actual}, want ${expected} +/- ${tol})`);
}

const ssl = ROBOTS_BY_ID.get('ssl');
const donna = ROBOTS_BY_ID.get('donna');
applySslSideModule(ssl);
applyDonnaExperience(donna);

function overlaps(a, b) {
  return Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
}

for (const mission of MISSIONS) {
  const def = ROBOTS_BY_ID.get(mission);
  const exp = def && def.experience;
  section(mission);

  ok(!!def, `${mission} resolves from ROBOTS_BY_ID`);
  ok(!!exp, `${mission} has an experience block`);
  if (!def || !exp) continue;

  const parts = exp.anatomy && exp.anatomy.parts;
  ok(Array.isArray(parts) && parts.length === 4, `${mission} has exactly four anatomy parts`);
  ok(new Set((parts || []).map((part) => part.id)).size === 4, `${mission} anatomy ids are unique`);
  ok(
    (parts || []).every((part) =>
      typeof part.id === 'string' && part.id.trim() &&
      typeof part.anchor === 'string' && part.anchor.trim() &&
      typeof part.label === 'string' && part.label.trim() &&
      typeof part.description === 'string' && part.description.trim()),
    `${mission} anatomy parts carry id, anchor, label and description`,
  );

  const mount = new THREE.Group();
  let scene = null;
  let anchors = null;
  let sceneError = null;
  try {
    scene = def.buildScene(THREE, mount);
    anchors = scene && typeof scene.anchors === 'function' ? scene.anchors() : null;
  } catch (err) {
    sceneError = err;
  }
  ok(!sceneError, `${mission} live buildScene() exposes its additive anchor API (${sceneError ? sceneError.message : 'ok'})`);
  ok(!!anchors && typeof anchors === 'object', `${mission} scene returns an anchor map`);
  for (const part of parts || []) {
    const resolve = anchors && anchors[part.anchor];
    ok(typeof resolve === 'function', `${mission}/${part.id} anchor "${part.anchor}" resolves`);
    if (typeof resolve !== 'function') continue;
    let point = null;
    let error = null;
    try {
      point = resolve();
    } catch (err) {
      error = err;
    }
    ok(!error, `${mission}/${part.id} anchor closure does not throw (${error ? error.message : 'ok'})`);
    ok(point && point.isVector3 === true, `${mission}/${part.id} resolves to a THREE.Vector3`);
    ok(
      point && [point.x, point.y, point.z].every(Number.isFinite),
      `${mission}/${part.id} resolves to finite world coordinates`,
    );
  }
  // A def MAY ship a directed fly-through for the anatomy step. `viewer.setAnatomy()` silently
  // falls back to the plain orbit when the spec cannot be resolved against the live rig, which is
  // the right runtime behaviour and a terrible thing to find out from a screenshot: this is the
  // build-time half of it. Content truth for the ssl beats - that the footage each card is held
  // over shows what the card claims - is checked against the decoded payload in ssl-data.test.mjs.
  const tour = def.anatomyTour;
  if (tour) {
    const ids = new Set((parts || []).map((part) => part.id));
    const anchorOf = (part) => (parts || []).find((p) => p.id === part);
    const resolves = (anchorId) => !!anchors && typeof anchors[anchorId] === 'function';
    ok(Array.isArray(tour.beats) && tour.beats.length === ids.size, `${mission} tour has one beat per anatomy card`);
    ok(
      resolves((tour.basis || {}).origin) && resolves((tour.basis || {}).forward),
      `${mission} tour basis anchors resolve against the live scene`,
    );
    ok(
      new Set((tour.beats || []).map((beat) => beat.part)).size === (tour.beats || []).length,
      `${mission} tour beats name distinct cards`,
    );
    // ROUND 7 GRAMMAR. The camera holds ONE wide framing for the whole tour and the part the live
    // card names is highlighted in the scene; the four per-beat close-ups are gone. Both halves are
    // gated here, because both are the kind of thing that fails silently on a screenshot: a tour
    // with no `wide` block is refused by `viewer.setAnatomy()` and falls back to the plain orbit, and
    // a part with neither mesh handles nor a glow radius is a card whose highlight is invisible.
    const wide = tour.wide || {};
    const wideAnchor = typeof wide.anchor === 'string' && wide.anchor ? wide.anchor : (tour.basis || {}).origin;
    ok(
      Array.isArray(wide.pos) && wide.pos.length === 3 && wide.pos.every(Number.isFinite),
      `${mission} tour ships one wide shot with a finite camera offset`,
    );
    ok(resolves(wideAnchor), `${mission} tour wide shot hangs off an anchor that resolves ("${wideAnchor}")`);
    ok(
      wide.frame === undefined || wide.frame === 'robot' || wide.frame === 'world',
      `${mission} tour wide shot names a known frame`,
    );
    for (const key of ['pos', 'posEnd', 'aim', 'aimEnd']) {
      if (wide[key] === undefined) continue;
      ok(
        Array.isArray(wide[key]) && wide[key].length === 3 && wide[key].every(Number.isFinite),
        `${mission} tour wide shot ${key} is three finite metres`,
      );
    }
    // The two ends of the drift are a DRIFT and not a dolly: a wide shot that halves its stand-off
    // over 15 seconds is four close-ups with extra steps. Both ends inside 25 per cent of each other.
    if (Array.isArray(wide.posEnd) && wide.posEnd.every(Number.isFinite)) {
      const len = (v) => Math.hypot(v[0], v[1], v[2]);
      const a = len(wide.pos);
      const b = len(wide.posEnd);
      ok(
        Math.abs(a - b) <= 0.25 * Math.max(a, b),
        `${mission} tour drift holds its stand-off (${a.toFixed(2)} m -> ${b.toFixed(2)} m)`,
      );
    }
    const meshes = scene && typeof scene.partMeshes === 'function' ? scene.partMeshes() || {} : {};
    for (const beat of tour.beats || []) {
      const part = anchorOf(beat.part);
      ok(!!part, `${mission} tour beat "${beat.part}" names a card on the overlay`);
      ok(!!part && resolves(part.anchor), `${mission} tour beat "${beat.part}" resolves its card's anchor`);
      ok(
        Array.isArray(beat.window) && beat.window[0] >= 0 && beat.window[1] > beat.window[0] &&
          beat.window[1] <= def.duration,
        `${mission} tour beat "${beat.part}" window is ordered inside 0..${def.duration}`,
      );
      ok(
        beat.pos === undefined && beat.posEnd === undefined && beat.aim === undefined &&
          beat.aimEnd === undefined && beat.frame === undefined,
        `${mission} tour beat "${beat.part}" carries no camera of its own`,
      );
      const handles = meshes[beat.part];
      const lit = Array.isArray(handles) ? handles.filter((m) => m && m.isMesh).length : handles && handles.isMesh ? 1 : 0;
      const radius = Number.isFinite(beat.glow) ? beat.glow : tour.glow;
      ok(
        lit > 0 || (Number.isFinite(radius) && radius > 0),
        `${mission} tour beat "${beat.part}" has something to light: ${lit} mesh(es) or a glow radius`,
      );
    }
  }

  if (scene && typeof scene.dispose === 'function') scene.dispose();

  const success = exp.success || {};
  const successWindow = success.window;
  ok(
    Array.isArray(successWindow) && successWindow.length === 2 &&
      Number.isFinite(successWindow[0]) && Number.isFinite(successWindow[1]) &&
      successWindow[0] >= 0 && successWindow[0] < successWindow[1] && successWindow[1] <= def.duration,
    `${mission} success window is ordered inside 0..${def.duration} (${JSON.stringify(successWindow)})`,
  );

  const failure = exp.failure || {};
  const finding = (def.findings || []).find((item) => item.id === failure.findingId);
  ok(!!finding, `${mission} failure findingId "${failure.findingId}" resolves`);
  if (!finding) continue;

  // THE SUCCESS STEP MUST NOT SPOIL THE FAULT, and round 6 changed what "the fault" means here.
  //
  // Until now this checked the success window against `finding.window`. That held while the two
  // were the same thing, and round 5 stopped them being the same thing: a finding's `window` is the
  // CHART span, written wide enough that the trace either side of the event means something (ssl's
  // kicker sawtooth needs 16.4 s of it, and arm6's overtemp declares the whole 80 s log), while
  // `loop` is the tight span the failure step actually replays. What a visitor must not meet early
  // is the fault MOMENT - the replayed loop and the instant the finding points at - not the context
  // the chart happens to plot around it. ssl's round-6 success window is the goal at 62.7 s, which
  // is inside `kicker-charge`'s 46.34-62.74 s chart span and eight seconds clear of its 53.48-54.63 s
  // loop: a shared span, not a shared cause, and the old assertion could not tell the two apart.
  //
  // So: no overlap with any REPLAY span, and no finding's instant inside the window. A finding with
  // no `loop` replays its window (`flow.js`), so that is its replay span - except when the window is
  // the whole log, which is a declaration that the channel is context for every second of the
  // mission and which no success window could avoid. There the instant is the only guard, and it is
  // the right one: it is the second the failure step seeks to.
  for (const item of def.findings || []) {
    const replay = Array.isArray(item.loop) ? item.loop : item.window;
    const wholeLog = Array.isArray(replay) && replay[0] <= 0 && replay[1] >= def.duration;
    const kind = Array.isArray(item.loop) ? 'loop' : 'window';
    if (Array.isArray(replay) && !wholeLog) {
      ok(
        !overlaps(successWindow, replay),
        `${mission} success window does not overlap ${item.id} ${kind} ${JSON.stringify(replay)}`,
      );
    }
    ok(
      !Number.isFinite(item.t) || item.t < successWindow[0] || item.t > successWindow[1],
      `${mission} success window does not contain ${item.id} t=${item.t}`,
    );
  }

  const plotted = failure.plottedFields || finding.focus || {};
  const channel = (def.channels || []).find((item) => item.path === plotted.channel);
  ok(!!channel, `${mission} plotted channel "${plotted.channel}" resolves`);
  const fieldMap = new Map(((channel && channel.fields) || []).map((field) => [field.key, field]));
  ok(Array.isArray(plotted.fields) && plotted.fields.length > 0, `${mission} selects at least one plotted field`);
  ok(
    (plotted.fields || []).every((field) => fieldMap.has(field)),
    `${mission} plotted fields are a subset of ${plotted.channel}`,
  );
  const labels = (plotted.fields || []).map((field) => (fieldMap.get(field) || {}).label || field);
  ok(labels.length === (plotted.fields || []).length, `${mission} has one direct label per plotted field`);
  ok(labels.every((label) => typeof label === 'string' && label.trim()), `${mission} direct labels are non-empty`);
  ok(new Set(labels).size === labels.length, `${mission} direct labels map one-to-one to plotted fields (${labels.join(', ')})`);
}

// ------------------------------------------------------------------ the drone anatomy tour, pinned
//
// The loop above gates the tour's SHAPE for every mission that ships one - the wide block resolves,
// the beats name distinct cards, no beat carries a camera. What it cannot gate is whether the
// footage each card is held over shows what that card claims, which is the thing the step exists
// for and the thing that fails silently on a screenshot. The ssl mission has that check in
// `ssl-data.test.mjs` (section 13, "anatomy tour beats"); this is the drone's, and it lives here
// because this mission's payload is generated by `buildData` rather than decoded, so there is no
// separate data test to hang it on.
//
// Two things beyond the ssl set are pinned, because two things beyond the ssl set are what round 12
// changed. The step has to be DYNAMIC - the aircraft flies its logged mission through the beats, and
// a shot resolved against the rig every frame means the only way that reaches a viewer is world-fixed
// geometry moving under it - so the surveyed ground is asserted through the LIVE scene's own colour
// attribute rather than through a replica of its rule. And it has to be dynamic on every lane, not
// on the two whose spacing happens to line up with the tile grid: the rule shipped as "the footprint
// crossed the tile's centre", which lit 53 of 280 tiles and left three of five lanes - including the
// one the aircraft is on when the bearing binds - with no mapped ground under them at all.
section('drone anatomy tour');
{
  const def = ROBOTS_BY_ID.get('drone');
  const tour = def.anatomyTour;
  const D = def.buildData(mulberry32(seedFor('drone')));
  const P = D['/pos'];
  const A = D['/att'];
  const M = D['/motors'];
  const B = D['/bat'];
  const RATE = def.rate;
  const at = (s) => Math.round(s * RATE);
  const batAt = (s) => Math.round(s * 25);
  /** [min, max] of `arr` over the window, on the array's own sample grid. */
  const band = (arr, t0, t1, idx = at) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = idx(t0); i <= idx(t1); i++) {
      lo = Math.min(lo, arr[i]);
      hi = Math.max(hi, arr[i]);
    }
    return [lo, hi];
  };
  const beatOf = (id) => (tour.beats || []).find((b) => b.part === id);
  const wins = (tour.beats || []).map((b) => b.window);
  const T0 = Math.min(...wins.map((w) => w[0]));
  const T1 = Math.max(...wins.map((w) => w[1]));

  // ---- grammar the generic loop does not reach ----
  ok(tour.wide.frame === 'robot', 'the wide shot is bolted to the hull, so the survey sweeps past a held aircraft');
  ok(
    wins.every((w, i) => i === 0 || w[0] === wins[i - 1][1]),
    `the four beat windows are contiguous: one passage of the flight, not four seeks (${JSON.stringify(wins)})`,
  );
  // 32 s is where `health3()` starts taking motor 3's bearing apart. Every card is held over the
  // aircraft WORKING, which is what makes the failure step's replay mean something.
  ok(T1 <= 32, `the whole tour closes before the bearing wear starts at 32 s (ends ${T1} s)`);
  ok(typeof def.anatomyModel === 'function', 'the step ships a display model, so the airframe dissolves into its drawing');
  ok(def.experience.anatomy.rotation === 'tour', 'the def declares its own rotation word, so `flow.js` leaves the orbit off');
  const heroT = def.experience.anatomy.heroT;
  ok(
    heroT >= T0 && heroT <= T1,
    `the reduced-motion frame is an instant of the same passage (heroT ${heroT} in ${T0}..${T1})`,
  );

  // ---- the display model is not in the eager graph ----
  // `drone/script.js` is eager on every visitor who opens the picker, so the wireframe module has to
  // arrive through the `anatomyModel` dynamic import and nowhere else. Static imports only, which is
  // the property: turn that `import()` into a static one and this fails.
  {
    const SPECIFIERS =
      /(?:^|\n)\s*(?:import|export)\s(?:[^'"()]|\n)*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    const entry = path.join(HERE, '..', 'drone', 'script.js');
    const seen = new Set();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(SPECIFIERS)) {
        const spec = m[1] || m[2];
        if (!spec || !spec.startsWith('.')) continue;
        stack.push(path.resolve(path.dirname(file), spec));
      }
    }
    const wire = path.join(HERE, '..', '..', 'core', 'anatomy-wireframe.js');
    ok(seen.has(entry), 'the drone eager graph walk found its entry module');
    ok(!seen.has(wire), `core/anatomy-wireframe.js stays out of the drone eager graph (${seen.size} modules)`);
  }

  // ---- content truth, measured off the built payload ----
  for (const beat of tour.beats || []) {
    const [t0, t1] = beat.window;
    const alt = band(P.alt, t0, t1);
    ok(
      alt[0] > 5.9 && alt[1] < 6.1,
      `${beat.part} beat holds the 6 m survey altitude (${alt[0].toFixed(3)}..${alt[1].toFixed(3)} m)`,
    );
    const dist = Math.hypot(P.x[at(t1)] - P.x[at(t0)], P.y[at(t1)] - P.y[at(t0)]);
    ok(dist > 2.5, `${beat.part} beat is flown, not hovered: ${dist.toFixed(2)} m of ground across it`);
    let vmax = 0;
    for (let i = at(t0); i <= at(t1); i++) {
      const j = Math.min(i + 5, P.x.length - 1);
      const k = Math.max(i - 5, 0);
      vmax = Math.max(vmax, Math.hypot((P.x[j] - P.x[k]) / 0.2, (P.y[j] - P.y[k]) / 0.2));
    }
    ok(vmax > 1.4, `${beat.part} beat reaches survey speed (${vmax.toFixed(2)} m/s)`);
  }
  // m3: "one of four brushless motors; each reports rpm and throttle" - the claim is FOUR identical
  // corners, which is the half a close-up on one of them could never make.
  {
    const w = beatOf('m3').window;
    const rpms = [M.rpm1, M.rpm2, M.rpm3, M.rpm4].map((a) => band(a, w[0], w[1]));
    const lo = Math.min(...rpms.map((r) => r[0]));
    const hi = Math.max(...rpms.map((r) => r[1]));
    ok(hi - lo < 220, `m3 beat holds all four motors inside one band (${lo.toFixed(0)}..${hi.toFixed(0)} rpm)`);
    const pwms = [M.pwm1, M.pwm2, M.pwm4, M.pwm3].map((a) => band(a, w[0], w[1]));
    ok(
      pwms.every((p) => p[0] > 59 && p[1] < 61),
      `m3 beat holds all four throttles near 60 percent (${pwms.map((p) => p[0].toFixed(1) + '-' + p[1].toFixed(1)).join(', ')})`,
    );
  }
  // battery: "the 4S pack; voltage and current are logged at 25 Hz" - so the beat has to be over a
  // pack that is actually being read, and over the steady draw the later rise is measured against.
  {
    const w = beatOf('battery').window;
    const v = band(B.v, w[0], w[1], batAt);
    const a = band(B.a, w[0], w[1], batAt);
    ok(batAt(w[1]) - batAt(w[0]) >= 60, `battery beat carries ${batAt(w[1]) - batAt(w[0])} /bat samples at 25 Hz`);
    ok(v[0] > 15.5 && v[1] < 16.0, `battery beat is over the pack's steady middle (${v[0].toFixed(3)}..${v[1].toFixed(3)} V)`);
    ok(a[0] > 13 && a[1] < 15, `battery beat is over the steady draw (${a[0].toFixed(2)}..${a[1].toFixed(2)} A)`);
    ok(B.v[batAt(w[1])] < B.v[batAt(w[0])], 'battery beat has the pack visibly running down across it');
  }
  // camera: "the mapping camera the lawnmower pattern exists to serve" - held over the END of the
  // lane, so the pattern the card is about is finished and on screen behind the aircraft.
  {
    const w = beatOf('camera').window;
    ok(
      Math.abs(P.x[at(w[1])]) > 9.8,
      `camera beat closes on the lane end (x = ${P.x[at(w[1])].toFixed(2)} m of a +/-10 m field)`,
    );
  }
  // imu: "closes the attitude loop from roll, pitch and yaw" - a bank held at a locked heading, which
  // is the one thing on this overlay a wide framing of the whole airframe can actually show.
  {
    const w = beatOf('imu').window;
    const roll = band(A.roll, w[0], w[1]);
    const yaw = band(A.yaw, w[0], w[1]);
    ok(roll[1] - roll[0] > 12, `imu beat banks the airframe (${roll[0].toFixed(2)}..${roll[1].toFixed(2)} deg of roll)`);
    ok(yaw[1] - yaw[0] < 1.0, `imu beat holds its heading while it does it (${(yaw[1] - yaw[0]).toFixed(2)} deg of yaw)`);
  }

  // ---- the surveyed ground, read off the LIVE scene ----
  const mount = new THREE.Group();
  const api = def.buildScene(THREE, mount);
  let cov = null;
  const QUADS = Math.round(FIELD.x) * Math.round(FIELD.y);
  mount.traverse((o) => {
    const c = o.isMesh && o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('color');
    if (c && c.count === QUADS * 4) cov = o.geometry;
  });
  ok(!!cov, `the scene draws a ${QUADS}-tile coverage layer the tour can show motion against`);
  if (cov) {
    const colour = cov.getAttribute('color');
    const posAttr = cov.getAttribute('position');
    /** Field y of tile `q`, back out of the world position the scene wrote (`wz(y) = -0.30 y`). */
    const tileY = (q) => -(posAttr.getZ(q * 4) + posAttr.getZ(q * 4 + 2)) / 2 / 0.3;
    const litAt = (t) => {
      api.update(t, D);
      let n = 0;
      for (let q = 0; q < QUADS; q++) {
        const i = q * 4;
        if (colour.getX(i) + colour.getY(i) + colour.getZ(i) > 1e-4) n++;
      }
      return n;
    };
    // Nothing ahead of the playhead: the survey has not started at 6 s, so there is nothing to draw.
    ok(litAt(6) <= 2, `no ground is mapped before the survey starts (${litAt(6)} tiles at 6 s)`);
    // And it GROWS inside every beat, which is the motion the tour has no other source for.
    for (const beat of tour.beats || []) {
      const a = litAt(beat.window[0]);
      const b = litAt(beat.window[1]);
      ok(b > a, `${beat.part} beat lays new mapped ground under the aircraft (${a} -> ${b} tiles)`);
    }
    const total = litAt(def.duration);
    ok(total >= 100, `the flown survey maps most of its field (${total} of ${QUADS} tiles)`);
    // EVERY LANE, which is the assertion the shipped centre-of-tile rule failed: it lit 53 tiles and
    // left the lanes at y = -7, 0 and +7 - the last of them the lane the aircraft is on when the
    // bearing binds - with nothing under them.
    api.update(def.duration, D);
    for (const laneY of LANE_Y) {
      let n = 0;
      for (let q = 0; q < QUADS; q++) {
        const i = q * 4;
        if (Math.abs(tileY(q) - laneY) > 1.0) continue;
        if (colour.getX(i) + colour.getY(i) + colour.getZ(i) > 1e-4) n++;
      }
      // The last lane is cut short by the failure at T_FAIL, so it maps less than a full 20 m run.
      const floor = laneY === LANE_Y[LANE_Y.length - 1] ? 10 : 18;
      ok(n >= floor, `the lane at y = ${laneY} m leaves a mapped strip under it (${n} tiles, floor ${floor})`);
    }
    ok(T_FAIL > T1, `the tour is over ${(T_FAIL - T1).toFixed(1)} s before the bearing binds`);
  }
  if (typeof api.dispose === 'function') api.dispose();

  // ---- the replay loops, re-derived ----
  //
  // Same contract `synthetic-replay-loop.test.mjs` holds sbr, arm6 and rescue to - a lap opens about
  // half a second before the measurable onset and closes shortly after the consequence lands - and
  // the drone's three findings are checked here rather than there because this mission's tour work
  // owns them this round. Every number quoted beside a `loop` in `drone/data.js` is re-derived off
  // the built arrays below, so the prose and the playback cannot drift apart.
  const LAP_MAX_S = 5.0;
  const finding = (id) => (def.findings || []).find((f) => f.id === id);
  for (const f of def.findings || []) {
    if (!Array.isArray(f.loop)) continue;
    ok(f.loop[1] > f.loop[0], `${f.id} loop is ordered (${f.loop.join('..')})`);
    ok(
      f.loop[1] - f.loop[0] < f.window[1] - f.window[0],
      `${f.id} loop is tighter than its chart window (${(f.loop[1] - f.loop[0]).toFixed(2)} s of ${(f.window[1] - f.window[0]).toFixed(2)} s)`,
    );
    const lap = (f.loop[1] - f.loop[0]) / (f.slowmo ? 0.4 : 1);
    ok(lap <= LAP_MAX_S, `${f.id} lap is a wait a visitor sits through (${lap.toFixed(2)} s at ${f.slowmo ? '0.4x' : '1x'})`);
  }
  // dip: the bearing binds at T_FAIL. 0.5 s of level cruise in front of it and nothing but the
  // consequence behind - the trough, then a fail state still 1.8 m down when the lap wraps.
  {
    const l = finding('dip').loop;
    near(T_FAIL - l[0], 0.5, 0.01, 'dip opens half a second before the bind');
    ok(P.alt[at(l[0])] > 5.99, `dip opens on level cruise (${P.alt[at(l[0])].toFixed(3)} m)`);
    let trough = Infinity;
    for (let i = at(l[0]); i <= at(l[1]); i++) trough = Math.min(trough, P.alt[i]);
    ok(trough < 4.0, `dip contains the trough (${trough.toFixed(3)} m)`);
    ok(6 - P.alt[at(l[1])] > 1.7, `dip closes on the settled fail state, still ${(6 - P.alt[at(l[1])]).toFixed(2)} m down`);
    ok(Math.abs(A.yaw[at(l[1])]) > 15, `dip closes with the heading error standing (${A.yaw[at(l[1])].toFixed(2)} deg)`);
  }
  // motor-wear: the onset is the drive running out of range, and the consequence is on the other
  // side of the same channel - rpm3 falling away with the throttle pinned while the healthy three
  // climb. Neither is visible in a lap of the 24 s chart window, which is what this loop replaces.
  {
    const l = finding('motor-wear').loop;
    const med = (i) => [M.pwm1[i], M.pwm2[i], M.pwm4[i]].sort((a, b) => a - b)[1];
    const mean = (arr, s) => {
      let t = 0;
      let n = 0;
      for (let i = Math.max(0, at(s) - 12); i <= at(s) + 12; i++, n++) t += arr[i];
      return t / n;
    };
    let pinned = null;
    for (let i = at(l[0]); i <= at(l[1]); i++) {
      if (M.pwm3[i] < 99.99) pinned = null;
      else if (pinned === null) pinned = i / RATE;
    }
    ok(pinned !== null, 'motor-wear loop contains the sample pwm3 pins at 100 percent');
    near(pinned, 57.48, 0.02, 'motor-wear opens on the run-up to the throttle ceiling');
    ok(pinned - l[0] >= 0.45 && pinned - l[0] <= 1.0, `motor-wear opens ${(pinned - l[0]).toFixed(2)} s before that ceiling`);
    ok(M.pwm3[at(l[0])] < 99, `motor-wear opens with headroom left (pwm3 ${M.pwm3[at(l[0])].toFixed(2)} percent)`);
    ok(
      M.pwm3[at(l[0])] - med(at(l[0])) > 30,
      `motor-wear opens on a throttle already ${(M.pwm3[at(l[0])] - med(at(l[0]))).toFixed(1)} points over the fleet: no cruising in the head`,
    );
    ok(
      mean(M.rpm3, l[1]) < mean(M.rpm3, pinned) - 400,
      `motor-wear closes after rpm3 has fallen away (${mean(M.rpm3, pinned).toFixed(0)} -> ${mean(M.rpm3, l[1]).toFixed(0)} rpm)`,
    );
    ok(
      mean(M.rpm1, l[1]) > mean(M.rpm1, l[0]),
      `motor-wear closes with the healthy three taking up the deficit (rpm1 ${mean(M.rpm1, l[0]).toFixed(0)} -> ${mean(M.rpm1, l[1]).toFixed(0)})`,
    );
    // and the finding's own claim: the fault is in the throttle and NOWHERE else yet.
    const alt = band(P.alt, l[0], l[1]);
    const yaw = band(A.yaw, l[0], l[1]);
    ok(alt[0] > 5.95 && alt[1] < 6.05, `motor-wear keeps the airframe level (${alt[0].toFixed(3)}..${alt[1].toFixed(3)} m)`);
    ok(yaw[1] - yaw[0] < 1.0, `motor-wear keeps the heading (${(yaw[1] - yaw[0]).toFixed(2)} deg of yaw)`);
    ok(l[1] < T_FAIL, `motor-wear closes ${(T_FAIL - l[1]).toFixed(1)} s before the bind, so it does not spoil the fault`);
  }
  // battery: window IS the log, so `core/embeds.js` never reads a loop on it and none is written.
  {
    const f = finding('battery');
    ok(f.window[0] <= 0 && f.window[1] >= def.duration, 'battery declares the whole log as its chart window');
    ok(
      !Array.isArray(f.loop),
      'battery ships no loop: a whole-log window takes the `full` branch in core/embeds.js and a loop there would be dead code',
    );
    // And there is no edge to have written one around: the sag is a bend over twenty seconds.
    const dV = (s) => (B.v[batAt(s + 2)] - B.v[batAt(s - 2)]) / 4;
    let base = 0;
    let n = 0;
    for (let s = 10; s <= 30; s += 0.2, n++) base += dV(s);
    base /= n;
    let twice = null;
    for (let s = 30; s <= 70 && twice === null; s += 0.04) if (dV(s) < base * 2) twice = s;
    ok(
      twice !== null && twice - f.t > 6,
      `battery has no onset to open on: dV/dt only doubles its ${base.toFixed(4)} V/s baseline at ${twice === null ? 'never' : twice.toFixed(2) + ' s'}, ${twice === null ? '' : (twice - f.t).toFixed(1) + ' s past the finding\'s instant'}`,
    );
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
