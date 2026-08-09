// drone-rotor-phase.test.mjs - the quad's prop-phase integrator, in plain Node.
//
//   node demo/js/robots/gen-fixture/drone-rotor-phase.test.mjs
//
// No browser and no Playwright. `viewer.js` hands buildScene a THREE.Group and `drone/scene.js`
// touches no DOM at all, so the aircraft can be built, flown and measured by `node` - which is the
// only kind of gate that runs on every machine, and the props are exactly the kind of thing a
// screenshot cannot check.
//
// WHAT THIS IS ABOUT. The prop phase is an INTEGRATOR: one accumulator per corner, advanced every
// frame by the logged rpm times the elapsed mission time. That makes it the one thing in this scene
// with memory, and the only thing that can be wrong about a frame that is otherwise correct. It used
// to advance by `Math.min(Math.abs(tSec - lastT), 0.1)`, and the `Math.abs` is the bug: every
// consumer of this scene runs the viewer inside a LOOP window (`core/flow.js` for a finding, the
// anatomy tour for a beat), so mission time wraps backwards every few seconds, and the absolute
// value turned each wrap into a forward step the size of the window. Four props, same direction, one
// lurch per loop, on a mission whose entire subject is that these four rpm traces are the truth.
//
// What it proves:
//
//   1  FORWARD PLAYBACK STILL INTEGRATES, at 30, 60 and 120 fps, and the phase after a second of
//      flight is the same however many frames that second was cut into. An integrator that only
//      matches at one frame rate is not reading the clock.
//
//   2  PROPORTIONAL TO THE TELEMETRY, which is the claim the anatomy card makes: the four corners
//      advance in the same ratio as the four rpm channels, over the same interval, and the failing
//      motor's prop slows with its own rpm rather than with a canned envelope.
//
//   3  A BACKWARD WRAP INTEGRATES ZERO. Driven around a real loop window the way the flow drives it,
//      the phase never moves backwards and never lurches: the wrap frame advances nothing at all,
//      and one full lap of the loop advances the props by exactly the phase of the frames inside it.
//
//   4  AND FORWARD MOTION RESUMES IMMEDIATELY AFTER, from the NEW time. This is what makes a
//      resample different from a stall: the frame after a wrap has to turn the props by its own
//      little step, and the frame after a seek has to pick up wherever the seek landed.
//
//   5  A FORWARD SEEK INTEGRATES ZERO TOO, and the threshold is where the derivation puts it: a
//      playback tick can advance mission time by at most 0.1 s of wall clock times the viewer's
//      fastest 2x, so 0.2 s still has to integrate and a 4 s jump to a finding must not.
//
//   6  THE WIREFRAME RATE SCALING SURVIVES ALL OF IT. While the anatomy step's drawing is standing in
//      (which this scene detects by reading the lower plate's visibility) the phase advances at
//      WIRE_BLADE_RATE of its solid rate - the slow, watchable prop the drawing needs - and the blur
//      discs recede. Same ratios, one factor.
//
//   7  AND THE VISIBILITY BEHAVIOUR IS UNCHANGED. The solid aircraft hides its blade meshes above
//      about 2.1 krpm and shows them below it; while the drawing is up the scene writes neither,
//      because the wireframe module owns those flags and restores them itself.

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
const { buildScene } = await import('../drone/scene.js');
const { buildData, T_FAIL } = await import('../drone/data.js');

// Seeded inside data.js when no stream is passed, so this payload is the same on every machine.
const DATA = buildData();

/**
 * One aircraft on its own mount, plus the handles this test measures through.
 *
 * `props` is not exported, so the phase is read where the visitor sees it: `blades.rotation.y` on
 * each of the four hubs. That is also the honest place to read it - it is the number that reaches the
 * screen, and the one the anatomy step's wireframe replicates.
 */
function stage() {
  const mount = new THREE.Group();
  const api = buildScene(THREE, mount);
  const craft = mount.getObjectByName('drone-craft');
  const plate = mount.getObjectByName('drone-lower-plate');
  if (!craft || !plate) throw new Error('the scene no longer names drone-craft and drone-lower-plate');
  // The four prop hubs, in build order, which is `/motors` order: the hubs are the only children of
  // the body carrying the anatomy-force stamp.
  const hubs = [];
  craft.traverse((o) => {
    if (o.userData && o.userData.anatomyForce) hubs.push(o);
  });
  if (hubs.length !== 4) throw new Error(`expected four prop hubs, found ${hubs.length}`);
  const phase = () => hubs.map((h) => h.rotation.y);
  const blades = () => hubs.map((h) => h.children.map((b) => b.visible));
  const discs = () =>
    craft.children[0].children.filter((c) => c.userData && c.userData.anatomySkip).map((d) => d.material.opacity);
  return { mount, api, craft, plate, hubs, phase, blades, discs };
}

/** rpm on all four channels at t, sampled the way the scene samples it. */
const { sampleAt } = await import('../../core/prng.js');
const rpmAt = (t) => {
  const m = DATA['/motors'];
  return [
    sampleAt(m.t, m.rpm1, t),
    sampleAt(m.t, m.rpm2, t),
    sampleAt(m.t, m.rpm3, t),
    sampleAt(m.t, m.rpm4, t),
  ];
};

/**
 * Fly a stretch of the mission frame by frame, exactly as `core/timeline.js` would inside a loop
 * window: mission time advances by one frame at the transport speed and wraps from the top of the
 * window back to its bottom.
 *
 * @returns the phase before and after, the largest single-frame advance, and the per-frame log
 */
function fly(s, { from, to, fps, speed = 1, frames, wire = false }) {
  s.plate.visible = !wire;
  const dt = (1 / fps) * speed;
  const log = [];
  let t = from;
  s.api.update(t, DATA); // the first frame is a resample by design: it has no previous time
  let prev = s.phase();
  const start = prev.slice();
  let maxStep = 0;
  let wraps = 0;
  const n = frames != null ? frames : Math.round(((to - from) / dt) * 1);
  for (let f = 0; f < n; f++) {
    t += dt;
    let wrapped = false;
    if (to != null && t >= to) {
      t = from + ((t - from) % (to - from));
      wrapped = true;
      wraps++;
    }
    s.api.update(t, DATA);
    const now = s.phase();
    const step = now.map((p, i) => p - prev[i]);
    maxStep = Math.max(maxStep, ...step.map(Math.abs));
    log.push({ t, wrapped, step });
    prev = now;
  }
  return { start, end: prev, maxStep, wraps, log, t };
}

// ---------------------------------------------------------------- 1. forward playback

section('1  forward playback integrates, and does not depend on the frame rate');
{
  const T0 = 3.0; // inside the survey, all four motors nominal
  const results = [30, 60, 120].map((fps) => {
    const s = stage();
    const r = fly(s, { from: T0, to: null, fps, frames: fps }); // one second of flight
    s.api.dispose();
    return { fps, advance: r.end.map((p, i) => p - r.start[i]), maxStep: r.maxStep };
  });
  for (const r of results) {
    ok(
      r.advance.every((a) => Math.abs(a) > 0.5),
      `${r.fps} fps: one second of playback turns every prop  (${r.advance.map((a) => a.toFixed(3)).join(', ')})`,
    );
  }
  // Same second of mission time, three frame rates: the integral is the integral. The tolerance is
  // relative and small (0.1 %), because what is left is the sampling error of a Riemann sum over an
  // rpm trace that is itself changing, and that error is the only thing allowed to differ.
  for (let i = 0; i < 4; i++) {
    const ref = results[0].advance[i];
    near(results[1].advance[i], ref, Math.abs(ref) * 0.001, `prop ${i + 1}: 60 fps matches 30 fps`);
    near(results[2].advance[i], ref, Math.abs(ref) * 0.001, `prop ${i + 1}: 120 fps matches 30 fps`);
  }
}

// ---------------------------------------------------------------- 2. proportional to the telemetry

section('2  the phase is proportional to the logged rpm');
{
  const s = stage();
  // Straddling the failure, so motor 3 is well into its collapse and the other three are not.
  const from = T_FAIL + 2.0;
  const r = fly(s, { from, to: null, fps: 60, frames: 60 });
  const advance = r.end.map((p, i) => p - r.start[i]);
  // The MEAN rpm over exactly the frames that were integrated, not a midpoint sample: motor 3 is
  // collapsing across this second, so its midpoint value is several percent off its own average and
  // a proportionality claim tested against it would be testing the sampling, not the integrator.
  const mean = [0, 1, 2, 3].map((i) => {
    const all = r.log.map((e) => rpmAt(e.t)[i]);
    return all.reduce((a, b) => a + b, 0) / all.length;
  });
  const rpm = rpmAt(from + 0.5);
  // Direction is the hub's own handedness, so compare magnitudes against magnitudes.
  const ratio = advance.map((a, i) => Math.abs(a) / mean[i]);
  for (let i = 1; i < 4; i++) {
    near(ratio[i], ratio[0], ratio[0] * 0.06, `prop ${i + 1} advances in proportion to its own rpm`);
  }
  ok(rpm[2] < rpm[0] * 0.9, `motor 3 really is down at this instant  (${rpm[2].toFixed(0)} vs ${rpm[0].toFixed(0)} rpm)`);
  ok(
    Math.abs(advance[2]) < Math.abs(advance[0]) * 0.9,
    'and its prop turns slower than the healthy corners',
  );
  // Opposite corners counter-rotate, which is what a quad does and what `cw` is for.
  ok(
    Math.sign(advance[0]) !== Math.sign(advance[1]) || Math.sign(advance[1]) !== Math.sign(advance[2]),
    'the four props are not all turning the same way',
  );
  s.api.dispose();
}

// ---------------------------------------------------------------- 3 and 4. the backward wrap

section('3  a backward loop wrap integrates nothing, and 4 forward motion resumes from the new time');
{
  // A real one: the drone mission's success step loops the survey (see scene.js), so this is the
  // window shape every consumer of this scene actually produces, wrapping about 9 s backwards.
  const LOOP = [18.6, 27.7];
  for (const fps of [30, 60]) {
    for (const wire of [false, true]) {
      const s = stage();
      const label = `${fps} fps ${wire ? 'wireframe' : 'solid'}`;
      // Two and a bit laps, so more than one seam is crossed.
      const laps = Math.round(((LOOP[1] - LOOP[0]) / (1 / fps)) * 2.2);
      const r = fly(s, { from: LOOP[0], to: LOOP[1], fps, frames: laps, wire });
      ok(r.wraps >= 2, `${label}: the loop wrapped at least twice  (${r.wraps})`);
      const wrapFrames = r.log.filter((e) => e.wrapped);
      ok(
        wrapFrames.every((e) => e.step.every((d) => d === 0)),
        `${label}: no prop advances on a wrap frame`,
      );
      // Monotone per corner: a prop never reverses. Its direction is its own handedness (`cw`), so
      // the sign is taken from the run's first moving frame rather than assumed from the index.
      const inside = r.log.filter((e) => !e.wrapped);
      const sign = [0, 1, 2, 3].map((i) => Math.sign((inside.find((e) => e.step[i] !== 0) || { step: [] }).step[i] || 0));
      ok(
        sign.every((v) => v !== 0),
        `${label}: every prop is turning somewhere in the run`,
      );
      ok(
        inside.every((e) => e.step.every((d, i) => d === 0 || Math.sign(d) === sign[i])),
        `${label}: no prop ever reverses`,
      );
      // The largest honest frame is one frame of the fastest prop over this window, which is what the
      // integrator would produce at this frame rate: derived, so the bound is right at 30 fps and at
      // 60. Anything near a window's worth of phase is the bug - 9.1 s of loop at survey rpm is over
      // 900 rad of solid phase, and that is what `Math.abs` used to add on every wrap.
      const peak = Math.max(...r.log.flatMap((e) => rpmAt(e.t)));
      const bound = (peak / 60) * (1 / fps) * 2 * Math.PI * 0.16 * (wire ? 0.065 : 1) * 1.15;
      ok(r.maxStep < bound, `${label}: no frame lurches  (max ${r.maxStep.toFixed(4)} rad, bound ${bound.toFixed(4)})`);
      // Resampled, not stalled: the frame after each wrap has to turn again, and by a normal amount.
      const after = r.log.map((e, i) => (i > 0 && r.log[i - 1].wrapped ? e : null)).filter(Boolean);
      ok(after.length >= 2, `${label}: there are post-wrap frames to check  (${after.length})`);
      ok(
        after.every((e) => e.step.every((d) => Math.abs(d) > 0)),
        `${label}: the frame after a wrap integrates from the new time`,
      );
      ok(
        after.every((e) => e.step.every((d) => Math.abs(d) < bound)),
        `${label}: and by a single frame's worth`,
      );
      s.api.dispose();
    }
  }
}

// ---------------------------------------------------------------- 5. forward seeks

section('5  a forward seek integrates nothing, a slow frame still does');
{
  const s = stage();
  const from = 12.0;
  const oneFrame = () => {
    const before = s.phase();
    return (t) => {
      s.api.update(t, DATA);
      return s.phase().map((p, i) => p - before[i]);
    };
  };
  s.plate.visible = true;
  s.api.update(from, DATA);

  // 0.2 s: the worst a real playback tick can be (timeline.js clamps its wall step to 0.1 s and the
  // fastest transport button is 2x), so this MUST integrate or the props stop on a slow phone.
  let step = oneFrame()(from + 0.2);
  ok(step.every((d) => Math.abs(d) > 0), `a 0.2 s playback tick still turns the props  (${step[0].toFixed(4)} rad)`);

  // 4 s: a chart click or a jump to a finding. Not motion, so not integrated.
  step = oneFrame()(from + 4.2);
  ok(step.every((d) => d === 0), 'a 4 s forward seek turns nothing');

  // And the frame after the seek is normal again, measured from where the seek landed.
  step = oneFrame()(from + 4.2 + 1 / 60);
  ok(step.every((d) => Math.abs(d) > 0), 'the frame after a seek integrates from the new time');
  const expect = rpmAt(from + 4.2).map((r) => Math.abs((r / 60) * (1 / 60) * 2 * Math.PI * 0.16));
  for (let i = 0; i < 4; i++) {
    near(Math.abs(step[i]), expect[i], expect[i] * 0.02, `prop ${i + 1}: post-seek frame is one frame of its own rpm`);
  }

  // A repeated frame (the same mission time twice) is not motion either.
  step = oneFrame()(from + 4.2 + 1 / 60);
  ok(step.every((d) => d === 0), 'a repeated frame turns nothing');
  s.api.dispose();
}

// ---------------------------------------------------------------- 6. the wireframe rate

section('6  the drawing gets the slow, watchable prop');
{
  const from = 3.0;
  const runs = [false, true].map((wire) => {
    const s = stage();
    const r = fly(s, { from, to: null, fps: 60, frames: 60, wire });
    const discs = s.discs();
    s.api.dispose();
    return { advance: r.end.map((p, i) => p - r.start[i]), discs };
  });
  const [solid, wire] = runs;
  for (let i = 0; i < 4; i++) {
    // WIRE_BLADE_RATE, read off the ratio rather than imported, because the point is that the phase
    // is scaled by ONE factor and every corner keeps its relative rate through it.
    near(
      Math.abs(wire.advance[i]) / Math.abs(solid.advance[i]),
      0.065,
      0.002,
      `prop ${i + 1}: the drawing turns it at WIRE_BLADE_RATE of the solid rate`,
    );
  }
  ok(
    wire.advance.every((a) => Math.abs(a) > 0),
    'and it is still turning, which is the whole reason the hub is permanent',
  );
  for (let i = 0; i < solid.discs.length; i++) {
    near(wire.discs[i] / solid.discs[i], 0.2, 0.001, `blur disc ${i + 1}: recedes to WIRE_DISC under the drawing`);
  }
}

// ---------------------------------------------------------------- 7. blade visibility

section('7  blade visibility is unchanged');
{
  const s = stage();
  s.plate.visible = true;
  // Survey rpm: about 6 krpm, far past the aliasing limit, so the solid aircraft shows blur instead.
  s.api.update(3.0, DATA);
  ok(rpmAt(3.0)[0] > 2600, 'the survey really is above the blur threshold');
  ok(
    s.blades().every((b) => b.every((v) => v === false)),
    'solid at survey rpm: the blade meshes are hidden and the disc carries the prop',
  );
  // Spool-up, before the props are anywhere near the limit.
  s.api.update(0.12, DATA);
  ok(rpmAt(0.12)[0] < 2100, 'and the spool-up really is below it');
  ok(
    s.blades().every((b) => b.every((v) => v === true)),
    'solid at spool-up: the blades are shown',
  );
  // Now the drawing takes over. The wireframe module hides the replicated meshes on its settle frame
  // and restores them itself, so the scene must not write these flags while the plate is hidden.
  const hidden = s.hubs.map((h) => h.children.map(() => false));
  s.hubs.forEach((h) => h.children.forEach((b) => (b.visible = false)));
  s.plate.visible = false;
  s.api.update(0.12, DATA); // an rpm that WOULD have shown them, if the scene were still writing
  ok(
    JSON.stringify(s.blades()) === JSON.stringify(hidden),
    'while the drawing is up the scene leaves the blade flags alone',
  );
  s.plate.visible = true;
  s.api.update(0.12, DATA);
  ok(
    s.blades().every((b) => b.every((v) => v === true)),
    'and takes them back over on the first solid frame',
  );
  s.api.dispose();
  eq(s.mount.children.length, 0, 'dispose detaches the aircraft');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
