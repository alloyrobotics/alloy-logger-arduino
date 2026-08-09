// ssl/rtt-model.js - the anatomy step's transparent-wireframe robot, read out of RoboTeam Twente's
// published CAD.
//
// WHY THIS FILE EXISTS. Round 7 modelled the robot procedurally: a 180 mm hull with four omni wheels,
// a dribbler mouth and an IMU board on the top plate, built from league convention because a tracker
// log carries a pose, a radius and a height and never a wheel. That is still what nineteen robots on
// a pitch are drawn as, everywhere in this mission. But on ONE screen the visitor is asked to look at
// the machine itself, and on that screen a convention-shaped stand-in is the weakest thing on the
// page. So the anatomy step draws the real thing: RoboTeam Twente's own Full Assembly, MIT licensed,
// converted by `assets-src/rtt/` in this repository into `rtt-model.mesh`. The geometry is theirs;
// see RTT-MODEL-NOTICE.md, which ships beside the asset because MIT requires the notice to travel
// with the redistribution.
//
// WHY A WIREFRAME, which is the round 8 note and not a style choice. The four cards name a wheel, a
// board, a capacitor bank and a roller. Three of those four are INSIDE the machine: on a solid robot
// the card about a capacitor bank points at a curved band of bodywork, which is the failure round 7
// solved with an anchored halo and could not solve properly, because no camera can see inside a
// solid. A transparent wireframe can. The whole robot reads at once - the wheels, the solenoid, the
// dribbler shaft, the boards - and the part the live card names is the one thing drawn SOLID, so it
// pops out of the drawing rather than being pointed at from outside it. This is the grammar an
// exploded CAD view has always used, and it is why the camera can hold one wide shot for the whole
// tour.
//
// WHY IT STARTS SOLID, which is the round 9 note. A visitor who lands on this step and is shown a
// transparent drawing has nothing to have made transparent. The wireframe is a claim about a machine,
// and round 8 asked the visitor to take the machine on faith: the step opened on a ghost, and the
// first solid thing they ever saw of this robot was one lit part inside it. So the step now opens on
// the object. Phase A holds the CAD as a normal solid machine for 1500 ms - dark anodised hull, black
// omni rollers, bare machined steel in the kicker bay, a board on the top plate - which is also the
// frame where the CAD earns its download against the procedural hull it replaces. Phase B dissolves
// that skin over 900 ms while the two wireframe registers come up underneath it. Phase C is the
// drawing round 8 shipped, and only then does the live card's part light up, because a part cannot
// pop out of a drawing that is itself still arriving.
//
// HOW THE DISSOLVE IS DONE, and it is the one interesting mechanical choice here. Fading an opaque
// mesh by setting `transparent` on it is the obvious move and it is wrong for this model: the moment
// the hull is transparent it stops writing depth, its own back faces sort against its front faces,
// and a machine whose insides are the whole point turns inside out for half a second. So the solid
// register dissolves with `alphaHash` instead - hashed stochastic alpha, which discards fragments in
// the OPAQUE pass and therefore keeps depth writes exact all the way to zero. That buys two things at
// once: no sorting artifacts and no z-fighting, and the wireframe underneath is revealed THROUGH the
// holes as they open, so the x-ray emerges out of the machine instead of cutting to it. At opacity 0
// every fragment is discarded, so hiding the meshes on the settle frame is not a visible event.
// `alphaHash` landed in three r152 and this page vendors r169; it is feature-detected anyway, and the
// fallback is the honest transparent fade with depth writes off, artifacts and all.
//
// WHY THE WHEELS TURN, which is the round 10 note and the reason the asset's format moved. Round 9
// shipped a rigid machine: a robot crossing the carpet at 2.9 m/s under a card that says four wheels
// move it in any direction, with the wheels welded still. That is the one thing on this step a visitor
// can catch out, and it is the card's own claim. So the four wheels now turn, and NOTHING about the
// turn is authored: the model is parented inside the subject bot's group, `ssl/scene.js` writes that
// group's position and heading from the tracker on every frame of the beat's replay, and `step()`
// finite-differences that pose into a planar body velocity and a yaw rate. Those three numbers plus
// the wheel's own measured geometry are a closed-form answer to how fast each wheel is turning:
// standard omni inverse kinematics, `surface speed = velocity . rolling direction + drive radius *
// yaw rate`, spin rate = -surface speed / rolling radius. The axle, the rolling radius and the drive
// radius are MEASURED off Twente's CAD by `assets-src/rtt/pack.py` and shipped in the header, so the
// only numbers in the loop are the tracker's and the machine's. There is no keyframe, no canned
// rotation and no "looks about right" rate: park the timeline and the wheels stop dead, because the
// robot did.
//
// WHY THEY ARE SLOWED, AND BY EXACTLY HOW MUCH, because a scale factor on a readout has to be argued
// rather than dialled in. Each wheel in this asset is a ring of 25 rollers, so it repeats visually
// every 14.4 degrees. The tour replays the omni beat at 0.62x (1.80 s of log across a 2.9 s hold), so
// the fastest true rate on screen is 1.83 m/s over a 26.5 mm rolling radius: 69 rad/s, which is 66
// degrees per frame at 60 Hz, four and a half roller pitches. Sampled that far past its own Nyquist
// limit the ring does not read as fast, it reads as a slow crawl in a direction the arithmetic picks
// at random, which is a FABRICATED readout arrived at by accident. Half a roller pitch per frame is
// the limit that keeps the direction honest, so the spin carries one uniform 0.1: the peak lands at
// 6.6 degrees a frame at 60 Hz and 3.3 at 120, about one turn a second, unmistakably turning and
// unmistakably faster on the sprint than on the spin. Direction, the ratio between the four wheels
// and the ratio between one moment and the next are all exact; the common rate is slowed, which is
// the same licence the tour already takes when it replays this passage at 0.62x and the dribbler beat
// at 0.20x. It is one number in one place, and it is the only place this file scales anything.
//
// WHAT IS ACTUALLY SPINNING, measured rather than assumed, because a spun motor case would be a lie
// of a different kind. The `omni` group in this asset is 108 parts and every one of them rotates with
// its wheel: 100 roller bodies, four hub nuts, four shaft couplers. The wheel frames, the caps and
// the four motors all overran the pipeline's per-part triangle budget and are not in the asset at all
// (`assets-src/rtt/tessellate.py`, TRI_BUDGET), so there is no static bodywork inside a wheel group to
// be turned by mistake. What a visitor sees turning is the roller ring, which from this camera is
// what a wheel shows. The rollers do not spin about their OWN axes here: that is real motion this
// model does not have the sideways-slip data to derive, and inventing it is exactly what this file
// does not do.
//
// AND THEY KEEP TURNING UNDER `prefers-reduced-motion`, which looks like an exception and is the rule.
// What that setting skips here is the intro, an animation that carries no information. The wheels are
// a READOUT of the same tracker data the robot's own motion comes from, so switching them off would
// be like hiding the robot's heading: the visitor would be shown a machine sliding across a carpet on
// frozen wheels, which is a stronger motion illusion than the one they asked to avoid.
//
// WHOSE CLOCK. The viewer's, and only the viewer's: it calls `step(nowMs)` every rendered frame while
// this step is open, that first call is t0, and this module owns no rAF, no timer and no `Date.now`.
// One clock means the intro cannot drift against the tour's beats, the camera drift or the halo, and
// leaving the step mid-intro is just a dispose - there is nothing to cancel. The viewer also asks
// `settled()` before it shows its own halo, and a `setSubject` that arrives during the intro (the
// first beat is live well before the fade is done) is REMEMBERED and applied on the settle frame
// rather than lighting a part inside a robot that is still solid. The two timings are duplicated,
// deliberately, in the core module that gives the other three missions the same intro: importing them
// across the ssl/core boundary would put bytes for this step in front of the lazy boundary below.
//
// WHY IT IS LOADED LIKE THIS. Everything here is behind the lazy boundary: `experience.js` imports
// this module dynamically, and `experience.js` is itself only reached through `role-openers.js`'s
// dynamic import, so not one byte of it is in the eager graph `ssl-eager-size.test.mjs` holds under
// 60 KB - and the 867 KB asset is fetched only on the step that draws it. While that fetch is in
// flight, and on ANY failure - a 404, an offline visitor, a truncated file, a payload whose robot is
// not in the roster - this module returns null and the round 7 procedural hull is simply left alone.
// The step is fully functional without the asset; the asset only makes it better. Verified by parking
// the asset and reloading the step: the procedural robot, the tour, the leader lines and the anchored
// halo all still run, and the only trace is the 404 in the network log.
//
// ONE KNOWN WRINKLE ON THAT FALLBACK PATH, recorded rather than papered over. The attribution sentence
// in `script.js`'s `context.provenance` ("Robot model: RoboTeam Twente's published CAD, MIT licensed")
// is EAGER copy, so on the rare path where the asset does not load, a credit is shown for a model the
// visitor cannot see. It is a credit rather than a claim about the robot or the data, so it fails safe
// in the direction that matters: it over-attributes instead of under-attributing, which is the right
// side to err on for a licence notice. Making it conditional would mean re-rendering that strip from
// this module's resolution, which means a channel through `core/flow.js` and more eager bytes on a
// graph with 96 of them left. Worth doing when the budget next moves, not worth a flow rewrite now.

/** "RTT1", as the little-endian uint32 the first four bytes read back as. */
const MAGIC = 0x31545452;
/**
 * The header shape this reader understands, and it is checked exactly.
 *
 * Format 1 shipped the four wheels welded into ONE `omni` group, which round 10 cannot spin: one
 * rotation of that group swings the whole set around the hull axis. Format 2 ships a group per wheel
 * plus the axles, and it is a different shape rather than a superset - `groups[].anatomy` and the
 * `anatomy` map are how a card finds its parts now. So a mismatch here is not something to feel out
 * field by field: an old asset behind a new reader (or the reverse, off a cache) would draw a robot
 * with an inside-out drive, and the fallback this step has always had is better than that. Throwing
 * leaves the round 7 procedural hull, which is a working step.
 */
const FORMAT = 'rtt-wireframe/2';
/**
 * How many wheels this reader will spin, and it is a count rather than a minimum on purpose. An SSL
 * robot in this class has four omni wheels, the four cards on this step say so, and the inverse
 * kinematics below is written for a four-wheel base: three of them turning is not a degraded drawing
 * of this machine, it is a drawing of a different one. See the completeness check in `readAsset`.
 */
const WHEEL_COUNT = 4;

/**
 * How faint each layer is. Two registers, and the split is the point: the four ANATOMY parts are
 * the things the cards name, so they carry the drawing, and the chassis is the context they hang on.
 * A hull drawn at the same weight as the parts inside it is a box with a smudge in it.
 *
 * The fill does not write depth, so the model does not occlude itself and every layer shows through
 * every other layer - which is the whole reason a wireframe answers a card about a part inside a
 * hull. It does still depth TEST, so the pitch and the other eighteen robots occlude it correctly:
 * this is a transparent robot standing on a real field, not an overlay floating over one.
 */
const LOOK = {
  hull: { fill: 0.045, line: 0.3 },
  part: { fill: 0.075, line: 0.46 },
};
/**
 * How far every NON-live register drops while a card has a part live, as a factor on the settled
 * weights above. Round 9.2, and the note behind it is about hue and not about brightness. The live
 * part is instrument blue and the drawing around it is a cool blue-white, so the highlight and its
 * context are the same hue at nearly the same weight - and on this asset there is a LOT of context,
 * because real CAD at a 26 degree threshold is a dense drawing full of bright thin lines. A highlight
 * in the same hue as its context can only separate on VALUE, and the cheap half of a value gap is at
 * the bottom of it: so a beat dims the drawing rather than shouting over it, and the live part is the
 * brightest thing on screen because everything else stepped back. 0.45 puts the hull at 0.020 fill and
 * 0.135 line and the other three anatomy groups at 0.034 and 0.207: the whole machine still reads as a
 * machine, which is the entire reason it is drawn, but it now reads as the drawing the part sits in.
 *
 * A factor rather than a second table, because a factor composes. `paint()` owns these weights all the
 * way through the dissolve; this only ever multiplies the SETTLED ones, from the settle frame on. Same
 * name and same value in `core/anatomy-wireframe.js`.
 */
const CONTEXT_DIM = 0.55;
const LINE_COLOR = 0x9dc0e6; // the demo's line grammar: a cool near-white, not a saturated accent
const FILL_COLOR = 0x86aacd;
// The live part. Instrument blue, the same channel and the same colour the anatomy tour's halo uses
// (`viewer.js`, "part highlight"), because a visitor should read the halo and the solid part as one
// statement rather than as two things that happen to have lit up together. NOT the alert red every
// scene paints a FAULT highlight: nothing is wrong with this robot on this step.
const LIVE_EMISSIVE = 0x8ec6ff;
// One value step up from round 9's 0x1c2734, at the SAME hue (210 degrees) and the same saturation
// (0.31), which is the point: the part separates by being lighter than its context, not by a second
// colour walking into the picture. Still a dark body, because the emissive above it and the beat's
// additive halo both have to land on this surface without taking the machining off it.
const LIVE_BODY = 0x263548;
/**
 * The dihedral angle above which a facet boundary becomes a drawn line.
 *
 * 26 degrees, and it is a measured compromise rather than a default. The tessellation is deliberately
 * coarse (a 0.5 mm chord error, angular deflection 1 rad), so a cylinder in this asset is a six or
 * eight sided prism and its facet boundaries sit at 45 to 60 degrees. A threshold under about 20
 * degrees therefore draws every facet boundary on every curved surface and the model turns into a
 * grey mesh; a threshold over about 35 degrees drops the roller and shaft outlines that are the whole
 * reason a wheel reads as an omni wheel. At 26 the real edges of the machine - plate outlines, the
 * solenoid body, the dribbler bar, the wheel frames - are drawn, and the faceting of a smooth curve
 * mostly is not.
 */
const EDGE_ANGLE = 26;

/**
 * The intro, in milliseconds off the viewer's frame clock. 1500 ms of solid is long enough to read a
 * machine and short enough that nobody waiting for the first card notices they waited; 900 ms of
 * dissolve is long enough to see the skin go rather than blink.
 */
const SOLID_HOLD_MS = 1500;
const FADE_MS = 900;

/**
 * The drive readout's one scale factor, and the four guards around the finite difference that feeds
 * it. See "WHY THEY ARE SLOWED" in the header for how 0.1 is arrived at; it is the peak on-screen
 * rate held to half a roller pitch per frame at 60 Hz, and it is uniform across all four wheels and
 * both phases so every ratio in the readout survives it.
 *
 * The guards exist because the pose this differentiates is a REPLAY, and a replay does things a robot
 * cannot. The beat clock hands the timeline a new window every 2.9 s and the window loops inside that,
 * so the tracked pose teleports several times a tour; a backgrounded tab returns with one enormous
 * frame; and a robot the tracker has lost holds its last pose and then jumps to wherever it was found.
 * Every one of those is a seek and none of them is motion, so the rule is to resample and integrate
 * nothing: a wheel that misses a frame is invisible, and a wheel that spins up a quarter turn on a
 * loop wrap is the kind of thing a visitor sees once and never trusts again.
 *
 * WHY THE GATES ARE MEASURED OFF THIS TOUR AND NOT OFF THE MISSION, which is the round 10.1 fix and
 * the reason there are four numbers here instead of two. The first version sized the speed gate for a
 * robot at full match pace (6 m/s against a 2.9 m/s payload) and the frame gate for a stalled tab
 * (200 ms). Both are far too loose for what this handle actually differentiates, because the ONLY
 * pose it ever sees is one of `ANATOMY_TOUR`'s four beats, each replayed slower than real time: the
 * fastest on-screen speed anywhere in the tour is the omni beat's 1.83 m/s, which this handle's own
 * frame-to-frame difference off the scene's hermite sees as up to 1.94 m/s, and the fastest yaw rate
 * is the imu beat's 2.35 rad/s. A beat is a loop, so a wrap arrives every 2.9 seconds. The dribbler
 * beat is the one that catches a loose gate out. Its window is 0.58 s replayed over the 2.9 s hold,
 * so bot 8 moves 0.157 m across the seam, and one 33 ms frame of that reads as 4.7 m/s: under the old
 * 6 m/s gate, integrated as motion, a visible flick on all four wheels once every 2.9 seconds at
 * 30 fps. At 60 fps the same seam reads as 9.4 m/s and was caught, which is exactly why it survived.
 *
 * So the gates are sized against the tour, with margin measured rather than guessed:
 *
 *   SPIN_MAX_SPEED  3 m/s, 1.5x the 1.94 m/s peak the tour actually shows.
 *   SPIN_MAX_DT_MS  50 ms, which passes 30, 60 and 120 fps (33.3 ms and below) and refuses the
 *                   stalled-tab frame that used to be clamped rather than dropped.
 *   SPIN_MAX_STEP_M and SPIN_MAX_STEP_RAD, the two that make the seam claim hold at EVERY accepted
 *                   frame gap rather than only at the ones that happen to divide out above 3 m/s.
 *                   A rate gate is a statement about a quotient, so a slow frame can always dilute a
 *                   jump under it; these two are statements about the numerator. The tour's biggest
 *                   real step between two drawn frames is 0.065 m and 0.078 rad (the omni and imu
 *                   peaks at 30 fps, the slowest rate the frame gate passes), and its four seams jump
 *                   0.157 m (dribbler), 0.910 m and 2.248 rad (imu), 1.712 m and 4.131 m. 0.12 m and
 *                   0.15 rad sit at about 1.9x the real step and below every seam, so no seam in this
 *                   tour can be integrated at any frame rate, and no honest frame is refused.
 *
 * Dropping a frame costs nothing and is the whole design: the pose is resampled on every call whether
 * the gates pass or not, so a refused frame leaves the wheels where they are and the next one carries
 * on from the new pose. The gates only ever decide whether a difference is INTEGRATED.
 */
const SPIN_SCALE = 0.1;
const SPIN_MIN_DT_MS = 2; // two frames inside 2 ms is a duplicated callback, not a motion sample
const SPIN_MAX_DT_MS = 50;
const SPIN_MAX_SPEED = 3; // m/s
const SPIN_MAX_YAW = 25; // rad/s
const SPIN_MAX_STEP_M = 0.12; // metres between two drawn frames
const SPIN_MAX_STEP_RAD = 0.15; // radians between two drawn frames
const TAU = Math.PI * 2;

/**
 * Phase A's palette, one entry per ANATOMY PART, which since format 2 is not one entry per group:
 * the four wheel groups are four pieces of `omni` and are painted from its one entry, because four
 * wheels the same size on the same machine in four different colours would be a diagram of nothing.
 *
 * A neutral ENGINEERING palette rather than the team colours the scene paints on its nineteen
 * robots, for the same reason the printed top plate is hidden here: on this one step the robot's
 * identity is carried by four labelled leader lines, so a hull painted in a division's blue is
 * decoration competing with the cards. What the palette does have to do is separate the four things
 * the cards name from the chassis they hang on, before a single word of a card has been read. Dark
 * anodised aluminium for the hull, black polyurethane for the wheel group (the rollers are most of
 * what a wheel shows from this camera), bare machined steel for the kicker bay because it is the one
 * thing a visitor should be able to find INSIDE the machine while it is still solid, a warm silicone
 * roller so the dribbler does not read as a fifth wheel, and board green on the top plate. Values are
 * in the same roughness/metalness range as `scene.js`'s robot factory, because both are lit by the
 * one rig in `core/stage3d.js`.
 */
const SOLID = {
  hull: { color: 0x343b43, rough: 0.46, metal: 0.5 },
  omni: { color: 0x16181c, rough: 0.82, metal: 0.1 },
  kicker: { color: 0xb9c0c8, rough: 0.32, metal: 0.72 },
  dribbler: { color: 0x4a3a2c, rough: 0.9, metal: 0.06 },
  imu: { color: 0x1f4a3f, rough: 0.6, metal: 0.15 },
};

/** Smoothstep, so the dissolve leaves and arrives without a corner on it. */
const ease = (u) => u * u * (3 - 2 * u);

/**
 * A visitor who has asked for less motion gets round 8's step: the wireframe, immediately, with the
 * live part lit as soon as a beat says so. The intro is the thing that is skipped, not the content -
 * nothing in it carries information a card does not also say.
 */
function prefersReducedMotion() {
  try {
    return !!(
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/** Three finite numbers, which is what a point or a direction out of the header has to be. */
const isVec3 = (a) => Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n));

/**
 * Read the asset. See `assets-src/rtt/pack.py` for the writer; the format is four bytes of magic, a
 * uint32 JSON header length, the header, then one int16 position block and one uint16 index block per
 * group, each 4-byte aligned.
 *
 * STRICT ON PURPOSE, and every throw here is a good outcome. This reader has a fallback that costs a
 * visitor nothing (the procedural hull, a working step), so the useful failure mode is REFUSING a
 * payload it does not fully understand rather than drawing four fifths of it: a group that no card
 * claims is invisible bytes, and a wheel whose axle is a typo is a robot with a drive that turns the
 * wrong way, which is worse than a robot drawn from league convention. Structure is checked here so
 * the build code below can read the header without a guard on every line.
 *
 * @returns {{
 *   header: object,
 *   groups: Array<{id: string, part: string, position: Float32Array, index: Uint16Array}>,
 *   wheels: Array<{group: string, axis: number[], centre: number[], radius: number, mount: number}>,
 * }}
 */
function readAsset(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('not an RTT1 asset');
  const headLen = dv.getUint32(4, true);
  if (headLen <= 0 || 8 + headLen > buf.byteLength) throw new Error('bad header length');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
  if (!header || header.format !== FORMAT) {
    const err = new Error(`asset is not ${FORMAT}`);
    // The one failure a retry can fix rather than a fallback: see the fetch below.
    err.stale = true;
    throw err;
  }
  const anatomy = header.anatomy;
  if (!anatomy || typeof anatomy !== 'object') throw new Error('asset carries no anatomy map');
  const groups = (Array.isArray(header.groups) ? header.groups : []).map((g) => {
    const part = g.anatomy;
    const members = part ? anatomy[part] : null;
    // Both directions of the mapping, because either half being wrong is a group that draws and
    // never lights, or a card that lights nothing.
    if (!Array.isArray(members) || members.indexOf(g.id) < 0) {
      throw new Error(`group ${g.id}: not listed under an anatomy part`);
    }
    const q = new Int16Array(buf, g.pos.byteOffset, g.verts * 3);
    const position = new Float32Array(q.length);
    const [ox, oy, oz] = g.offset;
    const [sx, sy, sz] = g.scale;
    for (let i = 0; i < q.length; i += 3) {
      position[i] = ox + q[i] * sx;
      position[i + 1] = oy + q[i + 1] * sy;
      position[i + 2] = oz + q[i + 2] * sz;
    }
    return { id: g.id, part, position, index: new Uint16Array(buf, g.idx.byteOffset, g.tris * 3) };
  });
  if (!groups.length) throw new Error('asset carries no groups');
  const wheels = (Array.isArray(header.wheels) ? header.wheels : []).map((w) => {
    if (!groups.some((g) => g.id === w.group)) throw new Error(`wheel ${w.group}: no such group`);
    if (!isVec3(w.axis) || !isVec3(w.centre)) throw new Error(`wheel ${w.group}: bad axle`);
    // A unit axis is the one thing `setFromAxisAngle` will not check for the caller, and a nearly
    // unit one is a quietly wrong rotation. 1e-3 is loose against the eight decimals pack.py writes
    // and tight against anything that is not a direction.
    if (Math.abs(Math.hypot(w.axis[0], w.axis[1], w.axis[2]) - 1) > 1e-3) {
      throw new Error(`wheel ${w.group}: axle axis is not a unit vector`);
    }
    if (!(w.radius > 0.001) || !Number.isFinite(w.mountRadius)) {
      throw new Error(`wheel ${w.group}: bad radii`);
    }
    return { group: w.group, axis: w.axis, centre: w.centre, radius: w.radius, mount: w.mountRadius };
  });
  /**
   * The drive has to be COMPLETE, and this is the check that says so. Every line below is about one
   * failure: a header whose two halves disagree about which groups are wheels.
   *
   * Format 2 exists to carry a group per wheel, and this robot has four. A payload with three wheel
   * specs and four groups under `anatomy.omni` passed every check above - each spec resolved, each
   * axle was a unit vector, each radius was positive - and then built a robot with THREE turning
   * wheels and one welded solid, because a group with no spec gets no pivot and hangs off the root
   * unspun. That is the exact failure this whole file was written to avoid: a card that says four
   * wheels move it in any direction, over a machine where one of them is not moving. It is also the
   * worst possible failure mode, because it looks almost right, and a visitor who spots the still
   * wheel has caught the readout lying rather than the asset being old.
   *
   * So: exactly four specs, no group named twice (two specs on one group would build two pivots and
   * the second would win, silently dropping a wheel), and the spec set EQUAL to the anatomy part's
   * member set in both directions. Equality rather than containment because each direction fails
   * differently: a spec for a group the part does not list is a wheel the `omni` card never lights,
   * and a listed group with no spec is the welded wheel above.
   *
   * Checked here, in the reader, which is what makes it safe: `readAsset` runs before one pivot is
   * built, before one material is allocated and above all before the procedural robot's children are
   * hidden, so a throw here leaves the round 7 hull exactly where it was - a working step drawn from
   * league convention, which is a far better outcome than four fifths of a real drive.
   */
  if (wheels.length !== WHEEL_COUNT) {
    throw new Error(`asset carries ${wheels.length} wheel specs, not ${WHEEL_COUNT}`);
  }
  const spun = new Set(wheels.map((w) => w.group));
  if (spun.size !== wheels.length) throw new Error('asset names a wheel group twice');
  const listed = Array.isArray(anatomy.omni) ? new Set(anatomy.omni) : null;
  if (!listed || listed.size !== spun.size) {
    throw new Error('asset wheel specs and anatomy.omni disagree on how many wheels there are');
  }
  for (const id of spun) {
    if (!listed.has(id)) throw new Error(`wheel ${id}: not listed under anatomy.omni`);
  }
  return { header, groups, wheels };
}

/**
 * Fetch, build, and hang the wireframe on the robot the anatomy overlay is about.
 *
 * The model is parented INTO that robot's own group, which is what makes this cheap: the group is
 * already posed, turned and hidden every frame by `scene.js`'s `update()` against the tracker, so the
 * wireframe drives itself, the four anatomy anchors keep resolving to the same points in the same
 * frame, and the leader lines and the tour's wide framing carry on working untouched. Nothing here
 * owns a clock: the only per-frame work is `step()`, and the viewer drives that off its own.
 *
 * @param {object} THREE the three.js module the viewer built the scene with
 * @param {import('three').Group} mount the viewer's robot root
 * @param {{bot: string}} opts `bot` is the name of the subject robot's group, e.g. `bot_y8`
 * @returns {Promise<{
 *   setSubject: (id: string|null) => void,
 *   step: (nowMs: number) => void,
 *   settled: () => boolean,
 *   dispose: () => void,
 * }|null>}
 */
export async function installAnatomyModel(THREE, mount, opts) {
  const bot = mount && opts && opts.bot ? mount.getObjectByName(opts.bot) : null;
  // No robot to hang it on: the scene has not been built yet, or this payload's roster does not
  // carry the subject. Either way the procedural hull is what the visitor keeps.
  if (!bot) return null;

  /**
   * `force-cache` because this is an immutable 867 KB blob at a stable URL and a visitor who comes
   * back to this step should not pay for it twice.
   *
   * AND EXACTLY ONE RETRY, which is the round 10 tax on bumping the format under an unversioned
   * filename. `force-cache` serves a stored response without asking whether it is still current, so
   * the visitor who saw round 9 has the FORMAT 1 asset on disk and this reader refuses it - correctly,
   * and into the procedural fallback, which is the one visitor for whom the fallback is the wrong
   * answer: the file on the CDN is fine, it is only their copy that is old. So a version mismatch, and
   * nothing else, is retried once with the cache bypassed. Every other failure (a 404, a truncation, a
   * header that is not this shape) is a real failure and falls straight through, because retrying it
   * would be a second megabyte spent proving the same thing.
   */
  const url = new URL('./rtt-model.mesh', import.meta.url);
  const load = async (cache) => {
    const res = await fetch(url, { cache });
    if (!res.ok) throw new Error(`rtt-model.mesh: HTTP ${res.status}`);
    return readAsset(await res.arrayBuffer());
  };
  let asset;
  try {
    asset = await load('force-cache');
  } catch (err) {
    if (!err || !err.stale) throw err;
    asset = await load('reload');
  }
  const { header, groups, wheels } = asset;

  const owned = []; // every GPU object this handle created, for dispose()
  const keep = (o) => {
    owned.push(o);
    return o;
  };

  // Does this visitor get the round 9 intro at all, and can the solid register dissolve properly?
  // The probe is one material that is built, asked one question and disposed before it can ever be
  // put in front of a compiler, which is cheaper than reading a three revision string that a future
  // vendored build is free to reformat.
  const intro = !prefersReducedMotion();
  let hashedFade = false;
  if (intro) {
    const probe = new THREE.MeshStandardMaterial();
    hashedFade = 'alphaHash' in probe;
    probe.dispose();
  }

  // Every wireframe weight the intro has to bring up, as [material, its settled opacity]. The live
  // materials are deliberately not in here: they are not part of the cross-fade, they land whole on
  // the settle frame.
  const fades = [];
  const mkFill = (weight) => {
    const m = new THREE.MeshBasicMaterial({
      color: FILL_COLOR,
      transparent: true,
      opacity: intro ? 0 : weight,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    fades.push([m, weight]);
    return keep(m);
  };
  const mkLine = (weight) => {
    const m = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      transparent: true,
      opacity: intro ? 0 : weight,
      depthWrite: false,
    });
    fades.push([m, weight]);
    return keep(m);
  };
  // Four materials, shared by every group, because a group is only ever in one of two states and at
  // most one group is live at a time.
  const mat = {
    hullFill: mkFill(LOOK.hull.fill),
    hullLine: mkLine(LOOK.hull.line),
    partFill: mkFill(LOOK.part.fill),
    partLine: mkLine(LOOK.part.line),
    liveFill: keep(
      new THREE.MeshStandardMaterial({
        color: LIVE_BODY,
        emissive: LIVE_EMISSIVE,
        // 0.36. Round 9 pulled this to 0.3 in step with the halo's locator weights in viewer.js and
        // the part went too quiet to find, so round 9.2 gives a fifth of it back - a nudge, not a
        // reversal, because the legibility this round buys comes mostly from CONTEXT_DIM taking the
        // drawing down and not from the part getting louder. The ceiling is unchanged: the beat's halo
        // is additive and lands on this same part, so the two sum, and too high blows the middle of the
        // live part out to white and the machining on it - the dribbler's mouth, the wheel frames -
        // stops reading at exactly the moment a card asks a visitor to look at it. 0.55 was the first
        // render and 0.42 was round 8, and both did precisely that.
        emissiveIntensity: 0.36,
        roughness: 0.44,
        metalness: 0.25,
      }),
    ),
    liveLine: keep(
      new THREE.LineBasicMaterial({ color: 0xe4f0ff, transparent: true, opacity: 0.95, depthWrite: false }),
    ),
  };

  const root = new THREE.Group();
  root.name = 'rtt-wireframe';
  // Anatomy part id -> the pieces that make it up, which since format 2 is FOUR pieces for `omni` and
  // one for everything else. Keyed by the part rather than by the group, because the part is what a
  // card, a highlight and `setSubject` all name, and the split into wheels is a display detail below
  // this line: `applySubject` lights a part by walking its pieces, so lighting `omni` lights all four
  // wheels on one frame exactly as it lit one welded group in format 1.
  const built = new Map(); // partId -> { pieces: Array<{fill, edge}>, faint }
  const solid = []; // Phase A's meshes, one per group; empty when the intro is skipped

  /**
   * A pivot per wheel, sitting on that wheel's axle, and it is the whole mechanism of the spin: every
   * piece of a wheel hangs under its pivot, offset by minus the axle point, so ONE quaternion on the
   * pivot turns the roller ring about the real axle and nothing else moves. The offset is written on
   * the children rather than baked into the vertex data, so the positions stay the ones the asset
   * shipped and the four anatomy anchors keep resolving against the same frame.
   *
   * Both registers hang here, which is what makes the wheels turn in the solid intro as well as in the
   * settled drawing: the Phase A mesh, the wireframe fill and its edges are all children of the pivot,
   * so the dissolve cross-fades a turning wheel into a turning wheel.
   */
  const seats = new Map(); // group id -> { pivot, ox, oy, oz }
  const spins = []; // per-wheel kinematic state, read only by spin()
  for (const w of wheels) {
    const pivot = new THREE.Group();
    pivot.name = `rtt-${w.group}`;
    pivot.position.set(w.centre[0], w.centre[1], w.centre[2]);
    root.add(pivot);
    seats.set(w.group, { pivot, ox: -w.centre[0], oy: -w.centre[1], oz: -w.centre[2] });
    spins.push({
      pivot,
      // The axle, as three.js wants it for `setFromAxisAngle` and as two scalars for the arithmetic,
      // so the hot loop touches no vector objects at all.
      axis: new THREE.Vector3(w.axis[0], w.axis[1], w.axis[2]),
      ax: w.axis[0],
      az: w.axis[2],
      mount: w.mount, // the drive radius a yaw rate multiplies
      invR: 1 / w.radius, // surface speed over this is the spin rate
      angle: 0,
    });
  }

  for (const g of groups) {
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    geo.computeVertexNormals(); // the live part is lit by the scene's rig, so it needs normals
    const faint = g.part === 'hull';
    const seat = seats.get(g.id) || null;
    const parent = seat ? seat.pivot : root;
    const fill = new THREE.Mesh(geo, faint ? mat.hullFill : mat.partFill);
    fill.castShadow = false;
    fill.receiveShadow = false;
    fill.renderOrder = 3;
    // The pitch is 12 m wide and this robot is 180 mm: a group whose bounding sphere is off screen
    // for a frame is not worth a culling test that can pop a layer out of a drawing.
    fill.frustumCulled = false;
    const edge = new THREE.LineSegments(
      keep(new THREE.EdgesGeometry(geo, EDGE_ANGLE)),
      faint ? mat.hullLine : mat.partLine,
    );
    edge.renderOrder = 4;
    edge.frustumCulled = false;
    if (seat) {
      fill.position.set(seat.ox, seat.oy, seat.oz);
      edge.position.set(seat.ox, seat.oy, seat.oz);
    }
    parent.add(fill, edge);
    const part = built.get(g.part);
    if (part) part.pieces.push({ fill, edge });
    else built.set(g.part, { pieces: [{ fill, edge }], faint });

    if (intro) {
      // The same geometry once more, drawn as a real surface. A second mesh rather than a material
      // swap on `fill`, because a cross-fade needs both registers on screen in the same frame, and
      // because it keeps Phase C's drawing identical to round 8's: at settle these meshes go
      // invisible and nothing they touched is left behind.
      //
      // Default FrontSide, which is a checked assumption rather than a hopeful one: every group in
      // the asset has a POSITIVE signed volume and (bar six directed edges on the hull, out of
      // sixty-four thousand) pairs its edges, so these are closed shells wound outwards and the
      // outside of the machine is what an opaque front-face pass draws. Normals are the smoothed
      // ones `computeVertexNormals` already put on the geometry for the live part, so Phase A and
      // Phase C shade the same surface the same way instead of two subtly different ones.
      const spec = SOLID[g.part] || SOLID.hull;
      const smat = keep(
        new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: spec.rough,
          metalness: spec.metal,
          // Opaque-pass dissolve. `transparent` stays false the whole way down: with alphaHash the
          // fade is a discard, so this mesh keeps writing depth and keeps occluding the wireframe
          // inside it until its own holes open. See the header note.
          alphaHash: hashedFade,
          opacity: 1,
        }),
      );
      const smesh = new THREE.Mesh(geo, smat);
      smesh.castShadow = false;
      smesh.receiveShadow = false;
      smesh.renderOrder = 2; // under both wireframe registers, so the fade has a defined order
      smesh.frustumCulled = false;
      if (seat) smesh.position.set(seat.ox, seat.oy, seat.oz);
      parent.add(smesh);
      solid.push({ mesh: smesh, mat: smat });
    }
  }

  // The procedural robot steps aside for as long as this model is up - from the FIRST frame, round 9
  // included, because the thing that replaces it is now a solid machine off real CAD rather than a
  // drawing, so there is no moment where hiding it costs the visitor a robot. All of it, including the
  // printed top plate, because this camera looks 30 degrees DOWN and an opaque plate over the top of
  // the machine hides the boards, the solenoid and the wheel bay, which is everything the four cards
  // are about. The robot's identity is carried by the four labelled leader lines on this step, not by
  // its vision pattern. Visibility is restored verbatim on dispose(), so every other surface in this
  // mission - the picker, the mission goal loop, the failure step, the chat replays - is untouched.
  const hidden = bot.children.filter((c) => c.visible);
  hidden.forEach((c) => {
    c.visible = false;
  });
  bot.add(root);

  let live = null; // the group currently drawn solid and lit, or null
  let wanted = null; // the latest part the viewer has asked for, whether or not it is drawn yet
  let isSettled = !intro; // reduced motion: the wireframe is already the drawing, from frame one
  let t0 = null;
  let fading = false;

  /** Move the cross-fade to `u`: 0 is the solid machine, 1 is round 8's wireframe. */
  function paint(u) {
    const e = ease(u);
    for (let i = 0; i < fades.length; i++) fades[i][0].opacity = fades[i][1] * e;
    for (let i = 0; i < solid.length; i++) solid[i].mat.opacity = 1 - e;
  }

  /**
   * Phase C, in one frame. `paint(1)` has already taken the solid register to zero alpha - with
   * alphaHash that discards every fragment, so the meshes going invisible on the same frame is
   * bookkeeping rather than a visible event - and the part the viewer asked for during the intro
   * lights up here, which is the whole reason the wait was worth anything.
   */
  function settle() {
    if (isSettled) return;
    isSettled = true;
    paint(1);
    for (let i = 0; i < solid.length; i++) solid[i].mesh.visible = false;
    applySubject();
  }

  // The last pose this handle differentiated, and whether there is one. Scalars rather than a vector
  // because the whole point of the loop below is that it allocates nothing.
  let havePose = false;
  let poseMs = 0;
  let poseX = 0;
  let poseZ = 0;
  let poseYaw = 0;

  /**
   * Turn the four wheels by however far the robot moved since the last frame.
   *
   * WHERE THE MOTION COMES FROM. `ssl/scene.js` writes the subject robot's group as
   * `position.set(x, 0, -y)` and `rotation.y = yaw`, hermite-interpolated from the tracker's own
   * samples, on every frame it is visible (see its `update()`). This model is a child of that group,
   * so differencing those three numbers across two `step()` calls is differencing the tracker: no new
   * channel out of the scene, no second sampling of the log, and no way for the wheels to disagree
   * with the hull they are bolted to. It reads the LOCAL pose rather than `matrixWorld` because the
   * world matrix is refreshed inside `renderer.render()`, one call later than this, and a lagging
   * world matrix would make every velocity a frame stale for no gain.
   *
   * THE ARITHMETIC, and every line of it is standard omni drive. `rotation.y = yaw` maps the robot's
   * own +x to world (cos yaw, -sin yaw) and its +z to (sin yaw, cos yaw), so the world velocity
   * projects onto those two to give the body-frame planar velocity. For a wheel whose axle points
   * radially outward along `a`, the direction it ROLLS is up x a = (a.z, 0, -a.x), and the contact
   * point of a body turning at `w` about its own axis adds `w * mountRadius` along exactly that
   * direction. So the surface speed is `v . rollDir + w * mountRadius`, and rolling without slip puts
   * the spin rate at MINUS that over the rolling radius: the contact patch has to stand still against
   * the carpet, which means the top of the wheel goes the way the robot goes.
   *
   * WHY THE SIGN IS WORTH A SENTENCE. The four axles all point outward (pack.py guarantees it), so on
   * a forward run the wheels on one side of the hull turn one way about their own axis and the wheels
   * on the other side turn the other way, which is correct and looks wrong written down. On a spin in
   * place all four take the same sign. Both fall out of the formula rather than being special-cased,
   * which is why there is no per-wheel table here.
   *
   * COST. Four wheels, two trig calls, one quaternion each, no allocation: `setFromAxisAngle` writes
   * into the quaternion the pivot already owns, and the axis vectors were built once at install.
   */
  function spin(now) {
    if (!spins.length) return;
    // Tracking loss, or a robot the payload has not shown yet: `scene.js` hides the whole group and
    // stops writing its pose, so there is no motion to read. Hold the wheels where they are and
    // forget the sample, or the frame it comes back on would integrate the whole gap.
    if (!bot.visible) {
      havePose = false;
      return;
    }
    const x = bot.position.x;
    const z = bot.position.z;
    const yaw = bot.rotation.y;
    const dtMs = now - poseMs;
    if (!havePose || dtMs < SPIN_MIN_DT_MS || dtMs > SPIN_MAX_DT_MS) {
      havePose = true;
      poseMs = now;
      poseX = x;
      poseZ = z;
      poseYaw = yaw;
      return;
    }
    const dt = dtMs / 1000;
    // The step itself, before it is divided by anything. Both gates below are on these two numbers
    // rather than on the rates they become, because a rate can be diluted by a slow frame and a step
    // cannot: this is what makes "a loop seam is never integrated" true at 30 fps as well as at 120.
    const stepX = x - poseX;
    const stepZ = z - poseZ;
    // World-frame planar velocity. The world here is the robot group's parent, which is the scene root
    // this mission builds at identity, so these are metres a second on the carpet.
    const vwx = stepX / dt;
    const vwz = stepZ / dt;
    let dyaw = yaw - poseYaw;
    // This payload exports yaw CONTINUOUS and unwrapped (`ssl/decode.js`, and `scene.js` leans on the
    // same contract for its hermite), so the wrap below only ever fires on a seek, where the gates
    // throw the frame away anyway. It is here so a future payload with wrapped yaw cannot spin the
    // wheels a hundred turns on one frame.
    if (dyaw > Math.PI) dyaw -= TAU;
    else if (dyaw < -Math.PI) dyaw += TAU;
    const w = dyaw / dt;
    poseMs = now;
    poseX = x;
    poseZ = z;
    poseYaw = yaw;
    // A loop wrap, a beat change or a robot found again after a gap: a pose jump, not motion. The
    // pose above has already been stored, so every one of these returns is a RESAMPLE - the wheels
    // hold, and the next frame differentiates against where the robot actually is now.
    if (stepX * stepX + stepZ * stepZ > SPIN_MAX_STEP_M * SPIN_MAX_STEP_M) return;
    if (dyaw > SPIN_MAX_STEP_RAD || dyaw < -SPIN_MAX_STEP_RAD) return;
    if (vwx * vwx + vwz * vwz > SPIN_MAX_SPEED * SPIN_MAX_SPEED) return;
    if (w > SPIN_MAX_YAW || w < -SPIN_MAX_YAW) return;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const vx = vwx * c - vwz * s; // along the dribbler face
    const vz = vwx * s + vwz * c; // across it
    for (let i = 0; i < spins.length; i++) {
      const wh = spins[i];
      const surface = vx * wh.az - vz * wh.ax + w * wh.mount;
      // Modulo a full turn, so a visitor who leaves this step open all afternoon does not end up
      // rotating by a number too big to hold a fraction of a degree in.
      wh.angle = (wh.angle - surface * wh.invR * SPIN_SCALE * dt) % TAU;
      wh.pivot.quaternion.setFromAxisAngle(wh.axis, wh.angle);
    }
  }

  /**
   * The intro's only clock, called by the viewer every rendered frame while this step is open. The
   * first call is t0: not install time, because an 867 KB asset can land a long way into the step and
   * a visitor should get their 1500 ms of solid robot from the frame they first SEE it.
   *
   * The wheels turn from the SAME call, ahead of the intro and outside its early return, because they
   * are a readout of the robot's motion and not part of the transition: they turn under the solid
   * skin, they turn through the dissolve, they turn in the settled drawing, and they turn for a
   * visitor who asked for reduced motion and never sees an intro at all.
   */
  function step(now) {
    if (!Number.isFinite(now)) return;
    spin(now);
    if (isSettled) return;
    if (t0 === null) t0 = now;
    const t = now - t0;
    if (t < SOLID_HOLD_MS) return; // Phase A holds; there is nothing per frame to do in it
    const u = (t - SOLID_HOLD_MS) / FADE_MS;
    if (u >= 1) {
      settle();
      return;
    }
    if (!fading) {
      fading = true;
      // The fallback path only. Flipped once, at the top of the fade rather than at build time,
      // because a depth-writing opaque hull is exactly what Phase A wants.
      if (!hashedFade) {
        for (let i = 0; i < solid.length; i++) {
          solid[i].mat.transparent = true;
          solid[i].mat.depthWrite = false;
          solid[i].mat.needsUpdate = true;
        }
      }
    }
    paint(u);
  }

  function settled() {
    return isSettled;
  }

  /**
   * Draw one group solid, or none. Called by the viewer on the frame a tour beat changes, off the
   * same `setSubject` channel the highlight uses, so the card, the leader line, the halo and this
   * all change together on one frame.
   *
   * During the intro the part is REMEMBERED and not drawn: the first beat is usually live before the
   * dissolve is over, and a part lit inside a machine that is still solid is a bright patch of
   * bodywork, which is precisely the round 7 failure the wireframe exists to fix.
   */
  function setSubject(id) {
    const next = built.has(id) ? id : null;
    if (next === wanted) return;
    wanted = next;
    if (!isSettled) return;
    applySubject();
  }

  /**
   * The round 8 treatment plus round 9.2's context recede, applied whenever the drawing is allowed to
   * change - which is only ever from the settle frame on: `settle()` calls this after it has flipped
   * `isSettled` and run `paint(1)`, and `setSubject()` returns early until then. That ordering is what
   * keeps the dim out of the dissolve, where `paint()` alone owns these opacities.
   */
  function applySubject() {
    if (wanted === live) return;
    const prev = built.get(live);
    if (prev) {
      for (let i = 0; i < prev.pieces.length; i++) {
        const p = prev.pieces[i];
        p.fill.material = prev.faint ? mat.hullFill : mat.partFill;
        p.edge.material = prev.faint ? mat.hullLine : mat.partLine;
        p.fill.renderOrder = 3;
      }
    }
    live = wanted;
    const next = built.get(live);
    if (next) {
      // Opaque and depth-writing, unlike everything else here: the live part occludes the wireframe
      // in front of it, which is what makes it read as a solid object inside a drawing rather than as
      // one more transparent layer that happens to be brighter. All four wheels together for the
      // `omni` card: a beat that lit one of them would be a card about four wheels pointing at one.
      for (let i = 0; i < next.pieces.length; i++) {
        const p = next.pieces[i];
        p.fill.material = mat.liveFill;
        p.edge.material = mat.liveLine;
        p.fill.renderOrder = 5;
      }
    }
    // And the context steps back for it. The four faint materials are SHARED by every group that is
    // not live, so one pass over `fades` recedes the entire drawing in O(1) and cannot touch the part:
    // the live group was just swapped onto `liveFill`/`liveLine`, which are deliberately not in
    // `fades`. A null from the tour restores the settled weights on the same frame.
    const w = live ? CONTEXT_DIM : 1;
    for (let i = 0; i < fades.length; i++) fades[i][0].opacity = fades[i][1] * w;
  }

  /**
   * Leaving the step, at any point in the intro. Nothing here is conditional on how far the fade got,
   * which is the property that makes a mid-intro exit safe: the whole model is one detachable group,
   * the solid register's materials are in `owned` like everything else, and the only state outside
   * this module is the procedural robot's visibility, restored verbatim. There is no timer to cancel
   * because there was never a timer.
   *
   * The wheel pivots need no line of their own: they are plain Groups this handle created under `root`,
   * they hold no GPU resource, and removing `root` from the robot detaches them with everything under
   * them. What they DO hold is the last spin state, so the lists are cleared here for the same reason
   * `built` is - a disposed handle that still answers questions is how a stale model gets stepped.
   */
  function dispose() {
    if (root.parent) root.parent.remove(root);
    hidden.forEach((c) => {
      c.visible = true;
    });
    owned.forEach((o) => o && typeof o.dispose === 'function' && o.dispose());
    owned.length = 0;
    built.clear();
    solid.length = 0;
    spins.length = 0;
    seats.clear();
    havePose = false;
  }

  return { setSubject, step, settled, dispose, header };
}
