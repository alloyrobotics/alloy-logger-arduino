// donna/experience.js - the four-step connect-flow experience for the Donna, Jack and Rory
// mission, behind the lazy recorded-payload boundary.
//
// This file is reached by a DYNAMIC import from script.js and by nothing else, so it is not in the
// eager module graph (donna-eager-size.test.mjs walks static imports only). That is deliberate and
// it is the same argument role-openers.js makes on the ssl mission: none of this can be read before
// a viewer, a timeline and a chart exist, and those only exist once the recorded payload has
// landed. A visitor who opens the picker and never opens this mission pays nothing for it. The
// static `hasExperience: true` flag on the def is what routing reads before the payload lands.
//
// Nothing here restates a number the ledger owns. The hero instant comes off `claims.mjs`, the
// failure window, camera, highlight and slow motion come off the finding in `data.js`, and the four
// anchors are resolved by `scene.js`'s `anchors()` against the posed rig. What IS authored here is
// the success window and the four anatomy parts, and both are held to the same rule as every other
// visitor-facing surface in this mission: only what the recordings support.

import { value as V } from './claims.mjs';

/**
 * The healthy passage, authored and verified against the decoded payload.
 *
 * Across 184.0 to 190.0 s: all three robots hold a live recorded pose (Donna live from 124.1 s,
 * Jack from 150.31 s, Rory from 28.27 s), none is penalized on its own HUD track, the master game
 * state reads PLAYING throughout, Donna's control state is a held WALKING and her ball estimate is
 * valid on every tick in the window. The frozen hero instant sits inside it, and the last fall in
 * the mission (Jack's third, 145.878 s, recovered 150.147 s) is well behind it, so this window and
 * the failure window below cannot overlap.
 *
 * It is also exactly the preview slice's own window, which is the same healthy passage the picker
 * card stages, so the robot and mission steps have real geometry and a real pose to show while the
 * full recorded payload is still streaming.
 */
const SUCCESS_WINDOW = [184.0, 190.0];

/**
 * The four labelled parts of Donna's body.
 *
 * Each `anchor` resolves through `scene.js`'s `anchors()` to a world point on a node the replay
 * already poses, so a label tracks its part while the camera orbits and while she walks. The copy
 * names only what the recordings and the CAD actually carry: two head joints and the camera bodies
 * on the head, the torso IMU behind the /imu channel, the Dynamixel servo diagnostics behind
 * /servos, and the onboard computer behind /compute. No part number and no sensor that this
 * mission cannot show is claimed.
 */
const PARTS = [
  {
    id: 'head',
    anchor: 'head',
    label: 'Head cameras',
    description: 'Two joints pan and tilt the head that carries her cameras.',
  },
  {
    id: 'imu',
    anchor: 'imu',
    label: 'Torso IMU',
    description: 'Records the accelerations and angles that tell a fall from a walk.',
  },
  {
    id: 'servos',
    anchor: 'servos',
    label: 'Leg servos',
    description: 'Dynamixel servos drive the legs; their diagnostics log temperature and bus voltage.',
  },
  {
    id: 'compute',
    anchor: 'compute',
    label: 'Onboard compute',
    description: 'Each robot logs its own mission on the computer it carries.',
  },
];

/**
 * The anatomy shot.
 *
 * The anatomy step labels four parts of ONE robot, so the shot has to be framed on that robot.
 * This scene's `cameraHome` cannot do it: it is a follow OFFSET framed for three bodies that stand
 * up to 5.1 m apart, and on the anatomy step - where flow.js suspends the follow - it degrades to
 * an absolute wide of the whole pitch with Donna a small distant figure. This pose replaces it.
 *
 * `target` is the centre of Donna's own posed body box at the frozen hero instant: measured in the
 * built scene at heroT she stands from y = -0.003 to y = 0.781 on a vertical axis through
 * (-0.419, 1.327), so she is 0.784 m tall and this target sits at her mid-height. It is her centre
 * and NOT the three-robot centroid, which is the whole point: `controls.autoRotate` revolves the
 * camera about the target, so targeting her is what makes the slow anatomy orbit turn around HER
 * rather than sweep past her.
 *
 * `position` stands 2.45 m out at 18 degrees of elevation, on the bearing Donna herself is facing
 * (her recorded yaw of -1.0044 rad maps to a -32.6 degree bearing in the scene's frame), so the
 * step opens on a near-frontal read of the machine: head, torso and both legs all legible, which is
 * exactly what the four labels name. Under reduced motion the orbit is refused and this pose is the
 * whole shot, so the authored bearing is chosen to be the best single frame and not just a start.
 *
 * Measured on the running page, then walked over a full 360 degree revolution at 72 steps:
 * - She is 0.784 m of machine rendering 209 px on the 527 px wide-panel stage, so 39.7% of stage
 *   height at 1440x900, and 21.3% at 390x844. Taken between the two labelled ends instead - the
 *   head anchor down to her feet - it is 33.6% and 18.0%. Both are invariant across the revolution,
 *   because an orbit concentric with the subject cannot change how big the subject is. The build
 *   contract asks for a subject filling roughly a third of the frame, which the wide panel clears;
 *   the wider fov the viewer dials in for a narrow aspect is what costs the phone the rest.
 * - Her head top clears the upper cards by 53 px and her feet clear the lower ones by 64 px on the
 *   wide panel, 91 px and 84 px on the phone, so head and feet are both in frame with headroom.
 * - All four leader-line anchors stay on-frustum for the whole revolution at both sizes, worst case
 *   0.700 of the way in from the nearest NDC edge, and none ever passes under its own card.
 * Jack and Rory read as background. That is honest - they were on the pitch - and the nearest
 * either ever comes to standing between the camera and Donna is 544 px of screen separation on the
 * wide panel, more than twice her own rendered height, so neither ever occludes her.
 */
const ANATOMY_CAMERA = {
  position: { x: 1.5439, y: 1.1463, z: 0.0714 },
  target: { x: -0.4191, y: 0.3892, z: 1.3268 },
};

/**
 * The experience block itself.
 *
 * `camera` is null on the success and failure steps ON PURPOSE. Both play the replay rather than
 * freezing it, so both want the scene's own follow: `cameraHome` is a follow OFFSET and the spring
 * rides it with whichever robots are live. The anatomy step is the one step that freezes a single
 * instant and names one robot's parts, so it is the one step that authors an absolute pose.
 */
export const EXPERIENCE = {
  anatomy: {
    camera: ANATOMY_CAMERA,
    rotation: 'orbit',
    heroT: V('heroTime'),
    parts: PARTS,
  },
  success: {
    window: SUCCESS_WINDOW,
    camera: null,
    loopLabel: 'success loop',
    // Three terse chips, matching the wall's row of mission-truth labels. Each one is checked
    // against the decoded window above: three live poses, a valid ball estimate on every tick, and
    // nobody down or penalized while the match state reads PLAYING.
    contextualLabels: [
      { label: 'Three robots', note: 'Donna, Jack and Rory' },
      { label: 'Donna walking', note: 'Ball estimate valid' },
      { label: 'No falls', note: 'All three stay upright' },
    ],
  },
  failure: {
    // Jack's third fall and the recovery he speaks through. The window, the instant, the lit robot
    // and the slow-motion flag all live on the finding in data.js and are not restated here.
    findingId: 'jack-falls-foul-line',
    camera: null,
    plottedFields: { channel: '/imu', fields: ['accelMagMps2', 'pitchDeg', 'rollDeg'] },
  },
};

/**
 * Merge the block onto the def. It lives HERE rather than in script.js because script.js is eager
 * on every visitor who opens the picker and this file is not. A module that will not load leaves
 * `experience` unset, and the flow falls back to the legacy brief for this mission rather than
 * failing the route.
 *
 * @param {object} def the Donna RobotDefinition
 */
export function applyExperience(def) {
  def.experience = EXPERIENCE;
}
