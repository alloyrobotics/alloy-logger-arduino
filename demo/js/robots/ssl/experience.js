// ssl/experience.js - the four-step flow's mission experience for this mission, and the anatomy
// overlay's anchor factory.
//
// WHY IT IS HERE AND NOT IN script.js. This mission is the one on the page with a lazy boundary,
// and `ssl-eager-size.test.mjs` holds everything statically reachable from `script.js` under a
// gzip ceiling that currently has double-digit bytes of headroom. The experience block is copy and
// the anchor table is numbers, and neither is read until the flow's step screens exist, which is
// after the match payload has landed. So both ride the side module that already loads with it:
// `role-openers.js` imports this file and `applyGuided()` calls `applyExperience()` on the def.
// `script.js` carries exactly two eager tokens for the whole feature - `hasExperience: true`, so
// the router can send this mission down the four-step flow before the payload exists, and a
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
 * DEPENDENCY. This pose holds only while the viewer's follow spring is off. `stepFollow()` writes
 * `controls.target` from `sceneApi.cameraFocus()` on every frame, and on this mission that point is
 * the BALL, not the robot, so a live follow drags the anatomy shot off the subject as soon as the
 * camera ease lands. The other missions do not show it: their focus point IS their subject. The
 * viewer needs to suspend the follow while an anatomy overlay is live, which is also the correct
 * behaviour on its own terms, since that step keeps the timeline paused and there is nothing to
 * follow. If it cannot, the only pose on this payload where the robot and the ball focus coincide
 * is 7.35 s, target (-4.281, 0.06, -2.037): a four-robot scrum, and a much worse hero.
 */
const ANATOMY_CAMERA = {
  position: { x: 0.017, y: 0.27, z: 2.687 },
  target: { x: -0.267, y: 0.075, z: 2.465 },
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
 * FAILURE. The existing `kicker-charge` finding owns the window, the instant, the lit robot and the
 * slow-motion flag; only the plotted pair is restated here, and it is the finding's own focus.
 * Camera is left null on both the success and failure steps so the scene's follow shot keeps the
 * ball framed, which is the framing this mission was tuned for.
 */
export const EXPERIENCE = {
  anatomy: {
    camera: ANATOMY_CAMERA,
    rotation: 'orbit',
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
    camera: null,
    loopLabel: 'success loop',
    contextualLabels: [
      { label: '8 vs 11', note: 'What each team had on the field through this passage.' },
      { label: 'Score' },
      { label: 'Block' },
    ],
  },
  failure: {
    findingId: FAILURE_ID,
    camera: null,
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
 * Merge the experience onto the def. Called by `role-openers.js`'s `applyGuided()`, which the def's
 * `loadSceneData()` runs once the match payload is in hand.
 *
 * @param {object} def the ssl RobotDefinition
 */
export function applyExperience(def) {
  def.experience = EXPERIENCE;
  def.sceneAnchors = sceneAnchors;
}
