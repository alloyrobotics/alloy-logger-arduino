// ssl/experience.js - the three-step flow's mission experience for this mission, and the anatomy
// overlay's anchor factory.
//
// WHY IT IS HERE AND NOT IN script.js. This mission is the one on the page with a lazy boundary,
// and `ssl-eager-size.test.mjs` holds everything statically reachable from `script.js` under a
// gzip ceiling that currently has double-digit bytes of headroom. The experience block is copy and
// the anchor table is numbers, and neither is read until the flow's step screens exist, which is
// after the match payload has landed. So both ride the side module that already loads with it:
// `role-openers.js` imports this file and `applyRoleOpeners()` calls `applyExperience()` on the def.
// `script.js` carries exactly two eager tokens for the whole feature - `hasExperience: true`, so
// the router can send this mission down the three-step flow before the payload exists, and a
// `buildScene` wrapper that reads `def.sceneAnchors` at call time rather than at build time.
//
// That wrapper is the part worth understanding. The flow's first step mounts a viewer BEFORE the
// match payload has landed (app.js only gates the later steps on it), so a scene built on the
// preview slice would be stuck with whatever `anchors` it was born with. Reading the factory off
// the def on every `anchors()` call means the viewer that mounted early still picks it up as soon
// as this module lands, instead of going without for the rest of the session.

import { findings } from './data.js';
import { ROBOT_H, DRIB_OFF_X, DRIB_OFF_Y } from './scene.js';

/** The finding the failure step isolates. It also decides which robot the anatomy step is about. */
const FAILURE_ID = 'kicker-charge';

/**
 * The anatomy subject, read off the finding rather than written down twice: the robot a visitor
 * meets on step 1 has to be the robot whose fault they are shown on step 3, and deriving it here
 * means the two cannot drift apart. `bot_y8` is in the preview slice's roster as well as the match
 * export's, so the overlay has a robot to attach to on either payload.
 */
const ANATOMY_BOT = (findings.find((f) => f.id === FAILURE_ID) || {}).highlight || 'bot_y8';

/**
 * Where each label attaches, as a point in the robot's OWN frame: +x is the dribbler face, +y is
 * up, +z is one side. The hull is a 180 mm cylinder 147 mm tall with a flat face 72.5 mm out, and
 * these are four real regions of it, not four invented meshes. No wheel, capacitor or IMU part is
 * modelled in this scene, and inventing one to point at would be a claim about hardware the log
 * does not carry.
 *
 *   omni      on the base ring, near side, 85 mm out: where the wheels meet the carpet.
 *   imu       the centre of the top plate, just clear of it.
 *   kicker    inside the forward hull, below the band split, behind the dribbler mouth.
 *   dribbler  the bar's own offset, the same DRIB_OFF point update() poses the instance at.
 */
const PART_OFFSETS = [
  ['omni', -0.03, 0.012, 0.08],
  ['imu', 0, ROBOT_H + 0.002, 0],
  ['kicker', 0.045, 0.055, 0],
  ['dribbler', DRIB_OFF_X, DRIB_OFF_Y, 0],
];

/**
 * The posed second for the anatomy step, chosen for CLEARANCE. Four labels on leader lines only
 * read if there is one robot under them, and for most of this window bot 8 is inside a cluster: a
 * hull-to-hull duel puts three other robots inside a 0.5 m frame and a viewer cannot tell which
 * one the IMU line points at. At 104.15 s the nearest other robot is 2.37 m away, which is the
 * widest gap bot 8 gets anywhere in the payload. Play is running (the kickoff went to NORMAL_START
 * at 103.996 s), and the second sits outside every finding window, so step 1 shows a working robot
 * rather than a fault.
 */
const ANATOMY_T = 104.15;

/**
 * The anatomy camera, in world metres. bot 8 sits at (-0.267, 2.465) in scene coordinates at
 * ANATOMY_T facing -6.162 rad, and this is 0.36 m out from it on the front quarter and 0.27 m up.
 * Close enough that a 180 mm robot reads as a machine rather than as a dot on a 12 x 9 m pitch, far
 * enough back that all four anchors project inside the middle 40% of the panel on both the desktop
 * and the phone framing, which is what leaves the corners free for the cards. The centre circle
 * sits behind the robot from here, so the shot still says "on a pitch".
 *
 * DEPENDENCY, and it is met. This pose holds only while the follow spring is off: `stepFollow()`
 * writes `controls.target` from `sceneApi.cameraFocus()` on every frame, and on this mission that
 * point is the BALL, not the robot, so a live follow would drag the shot off the subject as soon as
 * the camera ease landed. The other missions do not show it - their focus point IS their subject.
 * `flow.js` opens the robot step with `ensureViewer('anatomy')`, which nulls `cameraFocus` for the
 * whole step, so the follow never runs here; the tour above then owns the camera outright. Without
 * that suspension the only second on this payload where the robot and the ball focus coincide is
 * 7.35 s, target (-4.281, 0.06, -2.037): a four-robot scrum, and a much worse hero.
 */
const ANATOMY_CAMERA = {
  position: { x: 0.017, y: 0.27, z: 2.687 },
  target: { x: -0.267, y: 0.075, z: 2.465 },
};

/**
 * The directed fly-through: four shots, one per card. Schema: `viewer.js`, "directed anatomy tour".
 *
 * WHY FOOTAGE AND NOT A POSE. Three of these four cards make a claim about MOTION - an omni drive
 * moves in any direction without turning to face it, the IMU holds orientation while the controller
 * closes the loop, the dribbler keeps the ball under control while the robot drives - and a robot
 * standing still under a slow orbit demonstrates none of them. Each beat below names the seconds of
 * the real tracker log where bot 8 is doing the thing its card claims, so every claim is made over
 * footage of the machine making it.
 *
 * WHY THESE SECONDS, from the decoded tracker (metres, m/s, rad/s; every number here is measured
 * off the payload, not authored):
 *
 *   omni      2.62-4.42  a 3.6 m diagonal run, 0.93 -> 2.94 m/s, and the heading holds at 0.77 rad
 *                        from the first sample to the last. Translating hard while not turning at
 *                        all is the omni claim, and this is the only stretch in the log that is
 *                        both fast and yaw-free for a full 1.8 s.
 *   imu       0.70-1.62  the hard spin: yaw rate reaches -6.5 rad/s, about one revolution a second,
 *                        while the robot creeps at 0.1-0.9 m/s. Shot in the WORLD frame, or a
 *                        camera bolted to the hull would turn with it and the spin would vanish.
 *   kicker    4.42-5.92  the deceleration out of that run, 2.44 -> 1.04 m/s, shot square on the
 *                        forward hull, which is where the bank sits. The card states a hardware
 *                        fact rather than an event, so the beat is a hull detail on a moving robot
 *                        and claims no kick.
 *   dribbler  53.50-54.45  the ball closes from 0.40 m to 0.08 m of the hull centre while sitting
 *                        within 20 deg of the dribbler's own bearing - the ball in the mouth - and
 *                        leaves on bot 8's real attributed kick at 53.977 s.
 *
 * WHY THE DRIBBLER BEAT IS SOMEWHERE ELSE ENTIRELY, and why it is inside a finding window when the
 * other three are not. Bot 8 and the ball are within 0.32 m of each other, with the ball inside
 * 40 deg of the mouth, for exactly two stretches in 110 s: this one, and 6.9-7.5 s, where the ball
 * is not being carried at all - it is blue 10's shot rebounding off the hull - and where four other
 * robots sit inside 0.9 m, so a close shot is a wall of hulls with no ball in it. The rest of the
 * log has this robot a metre or more off the ball. A card that says a roller keeps the ball under
 * control, over 2.9 s of a robot nowhere near the ball, is the failure the first version of this
 * tour shipped, and no camera fixes it.
 *
 * The cost is that these seconds sit inside `kicker-charge`'s 46.34-62.74 s window. That window is
 * a SYNTHESIZED capacitor-voltage overlay: nothing in the replayed motion here is a fault, the kick
 * at 53.977 s is real tracker data the finding's own honesty note calls out as real, and this card
 * is about the roller, not the charge circuit. Showing footage the failure step later re-reads is a
 * narrative cost. Showing a dribbler card over a robot with no ball is a truth cost, and that is
 * the one worth avoiding.
 *
 * ROUND 5 MADE THAT RE-READ LITERAL, and it is worth writing down. The failure step no longer loops
 * the whole 16.4 s window: it loops `kicker-charge.loop`, 53.48-54.63 s, which is these seconds
 * plus half a second either side. So step 1 shows this kick from 0.5 m off the roller and step 3
 * shows the same kick from 0.92 m off the hull with the capacitor trace under it. The truth
 * position is unchanged - one is a card about a roller, the other is a synthesized charge overlay,
 * and neither claims the kick was faulty - but the visitor now sees one kick twice on purpose,
 * which is a better reason to be here than the coincidence this paragraph used to describe.
 *
 * SHOTS. Offsets in metres, resolved against the live rig every frame: `pos` is [towards the
 * dribbler face, to the robot's right, up] from the point the camera looks at, `aim` nudges that
 * point off the part's own anchor, and the `End` pair is where each is by the end of the beat - the
 * difference between them is the camera move. Stand-offs run 0.82 m down to 0.38 m on a machine
 * 180 mm across, which is inside OrbitControls' own `minDistance` and is why the tour writes the
 * camera after `controls.update()` rather than through it.
 *
 * WHY EVERY SHOT LOOKS DOWN AT LEAST 30 DEG. This scene has no sky: above the far boarding there is
 * the background colour and nothing else. A camera 0.2 m off the carpet on a 0.8 m stand-off is
 * pitched about 16 deg down, and on a portrait phone panel with a ~68 deg vertical fov that puts
 * the horizon a third of the way down - so a third of the panel is flat black, and the pitch the
 * robot is supposed to be driving across gets what is left. Every beat is pitched to 30 deg, which
 * lands the horizon just under the top edge and spends the whole panel on carpet and machine. The
 * stand-off DISTANCES are unchanged: each pos was rotated about its aim point, not moved away from
 * it, so the robot is the same size in frame as it was at the angle that had it floating on black.
 */
const ANATOMY_TOUR = {
  hold: 2900,
  // Two anchors that are already on the overlay: the top-plate centre and the dribbler bar. Their
  // difference in the ground plane IS the direction the robot is facing, so the shots need no
  // scene API the labels do not already use.
  basis: { origin: 'imu', forward: 'dribbler' },
  beats: [
    {
      // Broadside, half a metre off the base ring, drifting forward along the hull as the run
      // builds: the carpet and the field lines stream across the frame and the robot holds still
      // in it, which is what a crab-walk looks like from a chase camera.
      part: 'omni',
      window: [2.62, 4.42],
      pos: [-0.25, 0.56, 0.35],
      posEnd: [0.19, 0.5, 0.31],
      aim: [0.02, 0, 0.05],
    },
    {
      // Above the top plate, pushing in while the machine spins under it. World frame: the point
      // of the beat is that the robot turns and the camera does not.
      part: 'imu',
      window: [0.7, 1.62],
      frame: 'world',
      pos: [-0.36, 0.3, 0.36],
      posEnd: [-0.24, 0.2, 0.26],
    },
    {
      // Square on the forward face, dollying in from two-thirds of a metre to a hull detail.
      part: 'kicker',
      window: [4.42, 5.92],
      pos: [0.52, 0.22, 0.32],
      posEnd: [0.31, 0.1, 0.19],
      aim: [0, 0, 0.012],
    },
    {
      // Broadside, aimed ahead of the mouth so the carpet the ball is crossing is in shot,
      // then settling back onto the hull as the ball arrives. Square-on rather than off the front
      // quarter: the ball approaches along the robot's own heading, so a camera in front of the
      // mouth has the ball flying at the lens and the gap between ball and roller - the thing the
      // card is about - collapses to nothing. Broadside keeps that gap across the frame. The side
      // is the robot's LEFT because the nearest other robot spends this beat between 0.19 and
      // 0.45 m off its RIGHT, and would otherwise be the biggest object in the shot.
      part: 'dribbler',
      // Ends ON the kick, not a third of a second after it. The ball is at the mouth from 53.5 s
      // and leaves on bot 8's attributed kick at 53.977 s, so the old 54.45 s tail spent the last
      // third of the card's hold on a robot with no ball anywhere in frame - the exact reading the
      // beat was moved here to avoid, arriving at the end instead of the beginning. 54.08 s keeps
      // 0.1 s of the ball travelling away, which is what makes the roller's release legible, and
      // stops before the ball is out of shot. Shorter beat, same hold: the passage simply plays
      // slower, which at a 0.5 m stand-off it can afford to.
      window: [53.5, 54.08],
      pos: [0.09, -0.7, 0.41],
      posEnd: [0.045, -0.5, 0.29],
      aim: [0.08, 0, 0.03],
      aimEnd: [-0.03, 0, 0.03],
    },
  ],
};

/**
 * The two follow-shot framings.
 *
 * Both steps used to leave `camera` null, which handed the shot to `cameraHome` - an offset 5.34 m
 * long, framed to keep a whole 12 x 9 m pitch legible. On a 390 px phone that reads as a plan view
 * of a carpet with specks on it, and on the failure step, where the panel is half height because
 * the chart has the other half, it left two wedges of empty dark where the pitch had run out. Both
 * are the SAME azimuth as `cameraHome` (18 deg off the long axis), so the shot the mission was
 * tuned for is the shot that arrives, just closer and steeper:
 *
 *   mission  0.80 m at 64 deg, tracking the ball. Two or three robots and the ball across the
 *            panel, against seven and a lot of carpet before.
 *   failure  0.92 m at 42 deg, tracking BOT 8 (see `followAnchor` below), on a panel that gives
 *            up some of its height to the chart.
 *
 * HOW CLOSE, arithmetically, because "closer" on its own is how the first pass at this ended up
 * still reading as a plan view. `viewer.js` widens its 42 deg base fov as the panel narrows, and on
 * a 390 px phone the mission panel lands near 68 deg vertical, so the ground it covers ACROSS the
 * frame is about 0.96 x the camera distance. At 2.35 m that is 2.25 m of pitch over 372 px and a
 * 180 mm robot is 30 px: a speck, which is the finding. The first pass at this took it to 1.25 m,
 * 1.20 m of pitch and a 56 px robot, and on a 390 px phone that was still a passage of play with
 * most of a panel of empty carpet under it. 0.80 m covers 0.77 m across the frame, which is two
 * hulls and the ball between them, and puts the same robot at 87 px. The failure panel is squarer,
 * so its across-frame coverage is about 1.16 x distance: 0.92 m covers 1.07 m and puts its robot at
 * 62 px against 50 before. Both numbers are chosen for the phone, which is the narrow case; on
 * desktop the fov narrows back towards 42 deg and the same distance reads wider, which is the right
 * way round.
 *
 * WHY THE ELEVATIONS DIFFER, and why the mission step is steeper than `cameraHome`. On a portrait
 * panel a camera tilted down puts everything nearer than its target in the bottom half of the
 * frame, and at 58 deg from 3 m that was half a panel of empty carpet under the play. Steepening it
 * compresses that near band - the ground in front of the target and the ground behind it end up at
 * similar range - so the same robots occupy more of the same panel. The failure step goes the other
 * way, to 42 deg, because it is framing ONE machine rather than a passage of play: flatter puts the
 * hull's own side in shot instead of its top plate, and its panel is short enough that the near
 * band never gets a chance to open up.
 *
 * The follow translates camera and target together, so what is written here is the OFFSET the shot
 * keeps for the whole step; the absolute pair is that offset applied to the tracked point at the
 * instant each window opens, which is what stops the first follow frame from jumping.
 */
const MISSION_CAMERA = {
  position: { x: -1.228, y: 0.779, z: 1.742 },
  target: { x: -1.562, y: 0.06, z: 1.634 },
};

// Absolute pair for bot 8 where it stands when the finding's window opens at 46.34 s: scene
// (-5.325, -2.059), top plate 0.149 m up. From the first follow frame on, only the offset matters.
const FAILURE_CAMERA = {
  position: { x: -4.675, y: 0.765, z: -1.848 },
  target: { x: -5.325, y: 0.149, z: -2.059 },
};

/**
 * The mission experience. Schema: demo/UX-PORT-PLAN.md section 3.
 *
 * SUCCESS WINDOW. 0.5 to 7.5 s, inside the first live-play interval of the window (the free kick
 * held from before t = 0 comes into play immediately and the referee stops the game at 7.857 s).
 * Every robot both teams have on the field is tracked for all of it, and it ends 15 s before the
 * earliest finding starts at 22.5 s, so nothing on this step is a fault. This is the passage the
 * step LOOPS, which is a different job from the anatomy pose above: a loop wants play, a hero pose
 * wants one robot on its own, and no second in this payload is both.
 *
 * CONTEXTUAL LABELS. Mission truth, and role-invariant. The roster is the one the log carries:
 * eight robots on one side, eleven on the other, which is what the game controller's
 * maxAllowedBots says and what the tracker shows for every sample of the passage. Score and block
 * are what the robots in it are doing.
 *
 * FAILURE. The existing `kicker-charge` finding owns the chart window, the replay loop, the instant,
 * the lit robot and the slow-motion flag; only the plotted pair is restated here, and it is the
 * finding's own focus.
 * Both steps carry an explicit camera (see MISSION_CAMERA / FAILURE_CAMERA above): the scene's own
 * `cameraHome` frames a whole 12 x 9 m pitch, which on a phone panel is a plan view of carpet.
 */
export const EXPERIENCE = {
  anatomy: {
    camera: ANATOMY_CAMERA,
    // Not `orbit`. The flow only ever switches the auto-rotate on for that exact string, so a tour
    // mission declares its own word and the orbit stays off without the flow needing to know a
    // tour exists: `viewer.setAnatomy()` sees `def.anatomyTour` and takes the shot from there.
    rotation: 'tour',
    heroT: ANATOMY_T,
    parts: [
      {
        id: 'omni',
        anchor: 'omni',
        label: 'Omni drive',
        description: 'Four wheels move in any direction without turning first.',
      },
      {
        id: 'imu',
        anchor: 'imu',
        label: 'IMU',
        description: 'Tracks orientation while the controller closes the motion loop.',
      },
      {
        id: 'kicker',
        anchor: 'kicker',
        label: 'Kicker bank',
        description: 'A 240 V capacitor bank stores the energy for each shot.',
      },
      {
        id: 'dribbler',
        anchor: 'dribbler',
        label: 'Dribbler',
        description: 'A 25k rpm roller keeps the ball under control.',
      },
    ],
  },
  success: {
    window: [0.5, 7.5],
    camera: MISSION_CAMERA,
    loopLabel: 'success loop',
    contextualLabels: [
      { label: '8 vs 11', note: 'What each team had on the field through this passage.' },
      { label: 'Score' },
      { label: 'Block' },
    ],
  },
  failure: {
    findingId: FAILURE_ID,
    camera: FAILURE_CAMERA,
    // Track the robot the finding is about rather than the ball. `imu` is the top-plate anchor the
    // anatomy overlay already resolves, and it is on bot 8 - the same robot `highlight` lights - so
    // naming it here cannot drift away from the finding's subject.
    followAnchor: 'imu',
    plottedFields: { channel: '/bot8/kicker', fields: ['kickerLevel', 'kickerMax'] },
  },
};

/**
 * World anchor points for the anatomy overlay, one closure per part id.
 *
 * Each closure reads the group that `update()` posed most recently, so a label stays on the hull
 * while the robot drives and while the camera orbits it. Through a presence gap the group keeps
 * its last tracked pose and so does the point, which is the honest answer: the tracker stopped
 * seeing the robot, it did not teleport. Before the scene has been built there is no robot to read
 * and the point sits at the origin rather than throwing.
 *
 * The robot is found by name off the mount the viewer handed `buildScene`, which is the same lookup
 * on the preview slice and on the match export, and it is memoised because this runs per anchor per
 * frame. The map itself is memoised per mount for the same reason: a caller that asks every frame
 * gets one stable set of closures rather than four fresh vectors a frame.
 *
 * @param {object} THREE the three.js module the viewer built the scene with
 * @param {import('three').Group} mount the viewer's robot root
 * @returns {Record<string, () => import('three').Vector3>}
 */
const anchorMaps = new WeakMap();

export function sceneAnchors(THREE, mount) {
  const cached = anchorMaps.get(mount);
  if (cached) return cached;
  let bot = null;
  const out = {};
  PART_OFFSETS.forEach(([id, lx, ly, lz]) => {
    const v = new THREE.Vector3();
    out[id] = () => {
      if (!bot || !bot.parent) bot = mount.getObjectByName(ANATOMY_BOT) || null;
      if (bot) {
        bot.updateWorldMatrix(true, false);
        v.set(lx, ly, lz).applyMatrix4(bot.matrixWorld);
      }
      return v;
    };
  });
  anchorMaps.set(mount, out);
  return out;
}

/**
 * Merge the experience onto the def. Called by `role-openers.js`'s `applyRoleOpeners()`, which the def's
 * `loadSceneData()` runs once the match payload is in hand.
 *
 * @param {object} def the ssl RobotDefinition
 */
export function applyExperience(def) {
  def.experience = EXPERIENCE;
  def.sceneAnchors = sceneAnchors;
  // Read by `viewer.setAnatomy()`, off the def rather than out of the parts array, because it is
  // one spec for the whole step rather than four per-card ones and the flow hands the viewer only
  // the parts. Lands with this module, so a viewer mounted before the payload simply has no tour.
  def.anatomyTour = ANATOMY_TOUR;
}
