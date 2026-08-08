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
// failure chart window, the tight replay loop, camera, highlight and slow motion come off the
// finding in `data.js` (whose loop edges are themselves ledger values +/- half a second), and the four
// anchors are resolved by `scene.js`'s `anchors()` against the posed rig. What IS authored here is
// the success window and the four anatomy parts, and both are held to the same rule as every other
// visitor-facing surface in this mission: only what the recordings support.

import { value as V } from './claims.mjs';
import { holdNameTagsOnAnatomy } from './scene.js';

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
    // Names WHERE, because the shot this card is held over is a close read of the lower torso and
    // the copy has to be about the thing in frame. The claim itself is unchanged and is the
    // mission's own: each of the three robots recorded its log on the machine it was riding.
    description: 'The computer that recorded this log rides in her lower torso, and it keeps writing while she walks.',
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
 *   head anchor down to her feet - it is 35.6% and 19.1%. Both are invariant across the revolution,
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
 * The directed tour: one wide shot, four cards, four lit parts. Schema: `viewer.js`, "directed
 * anatomy tour" and "part highlight".
 *
 * WHY FOOTAGE AND NOT THE FROZEN POSE. Every one of these four cards is a claim about something the
 * recording DOES. Two joints pan and tilt the head; the IMU tells a fall from a walk by the
 * accelerations and angles it records; the leg servos drive the legs; the compute carries the log
 * while she works. A humanoid held at one instant under a slow orbit demonstrates none of them - it
 * is a statue with four labels on it. Each beat below names the seconds of Donna's own recording
 * where she is doing what the card says, and the camera is resolved against the rig every frame, so
 * the shot tracks the machine instead of the patch of turf she was standing on.
 *
 * WHY THERE IS ONE SHOT NOW AND NOT FOUR, which is round 7 and the only structural change here. The
 * four per-beat shots this replaces closed to 0.50, 0.46, 0.42 and 0.58 m on a 0.784 m robot, and
 * the two that were about a PART had to be tighter still to make that part legible - the head beat
 * ran 0.70 down to 0.50 m specifically so a 0.152 m housing was more than 8 per cent of the picture.
 * That is the trap: at 0.50 m on a humanoid the desktop lens has closed past her crown, so the card
 * that names her head is over a frame with no robot in it, and a visitor arriving mid-beat cannot
 * place the part on a machine they cannot see. The camera now holds ONE wide framing that keeps all
 * of her in frame for the whole tour and the part the live card names is LIT instead
 * (`scene.js`'s `partMeshes()`). Two of the four cards needed geometry before that could be true:
 * see below.
 *
 * WHY TWO OF THE PARTS ARE NEW GEOMETRY. The Bit-Bots CAD this rig came from models no IMU and no
 * onboard computer, so `imu` and `compute` were cards pointing at bare torso shell - which the old
 * compute beat's note admitted in as many words, and answered by shooting the REGION the computer
 * sits in from 0.58 m. A highlight cannot be honest about a part that is not there, so `scene.js`
 * now carries two boxes on the torso link at those two anchors: a 36 x 26 mm IMU on the chest frame
 * and a 54 x 38 mm computer in the open lower cage, both mounted on measured CAD surfaces. They are
 * representational and they claim nothing beyond their own presence, which is the same standard the
 * rest of this mission's surfaces are held to.
 *
 * WHY THESE SECONDS. All four sit inside 187.16-190.00, and that is not laziness about the passage:
 * it is the constraint. This tour must be about DONNA, and Donna's live segments are 0.04-86.85 and
 * 124.10-250.00 with a HIDDEN penalty outage between them where the anchors hold a stale pose and
 * would replay as a frozen robot. The step's own hero instant is 187.6 s, the success window is
 * 184-190, and the eager preview slice covers exactly 184-190 - so seconds outside it would open on
 * a body the preview payload cannot pose while the full recording streams. Inside that window every
 * beat is checked against the decoded payload (metres, radians, m/s^2, degrees, volts, percent;
 * measured, not authored):
 *
 *   head      187.16-188.36  HeadPan sweeps -1.471 to 1.206 rad and HeadTilt -1.057 to -0.198 rad:
 *                            2.68 rad of pan and 0.86 rad of tilt in 1.2 s, within 1% of the widest
 *                            combined swing any 1.2 s of 184-190 carries. Both joints move, which is
 *                            what "two joints pan and tilt the head" has to show - and from the wide
 *                            framing the head turning against a held body is the whole point.
 *   imu       188.00-189.00  accel magnitude 4.01 to 15.79 m/s^2, pitch 12.19 to 21.76 deg, roll
 *                            -1.37 to 18.87 deg, while her heading turns about 15 deg. The walk is
 *                            what makes those numbers, and the wide shot has the legs in it.
 *   servos    188.48-189.68  a full bilateral gait cycle: knees swing 0.375 and 0.364 rad, ankle
 *                            rolls 0.295 and 0.327 rad, and the servo diagnostics under it read
 *                            13.7 to 14.6 V of bus voltage at 51 C.
 *   compute   189.00-190.00  /compute is streaming through the whole beat, 56.0 to 60.5 percent CPU
 *                            and 18.49 to 18.53 percent memory, on a robot that is still walking.
 *
 * WHAT THESE SHOTS DO NOT CLAIM. The IMU card contrasts a fall with a walk; Donna never falls in
 * this mission (all three falls are Jack's) and every beat has to stay on the robot the cards are
 * about, so this beat shows the WALK half honestly and does not stage a fall. The chart on the next
 * step is where the samples themselves are drawn.
 *
 * WHY THE BASIS IS NOT TWO CARDS. The viewer builds the robot frame from two anchors and drops the
 * vertical, and no PAIR of these four cards survives that: `compute` to `imu` is the spine, 0.02 to
 * 0.04 m of horizontal residue whose bearing swings through 280 degrees across this passage, and
 * `compute` to `servos` is a leg the gait swings through 60 degrees of it. `bodyForward` is
 * `scene.js`'s fifth anchor key, which is no card and can never be one: the torso link's own +x axis,
 * 0.2 m out at the compute anchor's height, which reads her recorded heading straight off the node
 * the replay poses.
 *
 * THE WIDE SHOT, in metres, resolved against the live rig every frame: `pos` is [along her heading,
 * to her right, up] from the point the camera looks at, and the `End` pair is the far end of a drift
 * `viewer.js` eases between on a raised cosine. Hung off her `compute` anchor - her lower torso, on
 * her own vertical axis - and aimed 0.06 m under it, which puts the centre of the picture at her
 * mid-height: measured in the built scene at the hero instant she stands from y = -0.000 to y = 0.773
 * on a vertical axis through (-0.419, 1.327), and the aim lands at y = 0.386.
 *
 * HOW FAR OUT, arithmetically, because this is the number the old four shots kept getting wrong in
 * both directions. The connect panel is two very different frames: on a 390 px phone the stage
 * measures about 355 x 546 css px and the viewer widens its 42 deg base fov to 71.3 deg vertical; on
 * the desktop right column it is 1177 x 527, past the aspect where that widening starts, so the fov
 * stays at 42. The frame is therefore 0.77x the stand-off tall on the desktop and 1.41x tall by
 * 0.92x wide on the phone. At 1.50 m her 0.784 m is 67 per cent of the desktop panel's height and 36
 * per cent of the phone's, with her feet and her crown inside both for every frame of the drift, and
 * the four corner cards keep their corners. Closer and the desktop lens closes past her head, which
 * is exactly what killed the close beats; further and she is a figure on a pitch again.
 *
 * WHERE IT STANDS. Her front three-quarter, 11 degrees off her heading to her left at one end of the
 * drift and 30 at the other, `frame: 'robot'` so the bearing is bolted to HER heading rather than to
 * the world: she turns about 15 degrees across this passage, and the two parts round 7 added are both
 * on her chest, so a shot that walks round to her side over the tour would end on the cards it exists
 * to serve. 19 degrees of azimuth and 3 of elevation, over 15 s against a 11.6 s tour cycle so the
 * two clocks never lock, and no cut anywhere in it.
 *
 * WHY IT IS PITCHED 27 DEG DOWN. This scene has no sky: above the far boarding there is the
 * background colour and nothing else, and a near-level camera spends the top of a portrait panel on
 * flat black. 27 deg puts the turf behind her for the whole frame while keeping a humanoid's own
 * verticality - past about 35 deg she starts to read as a squat plan view of herself.
 *
 * Jack and Rory stay background. The nearest either comes to the lens is Rory at about 2.3 m against
 * 1.5 m for Donna, so she is the subject by a clear margin and neither ever occludes her. Her name
 * tag stays stood down for the step (`holdNameTagsOnAnatomy`): at 1.50 m the 0.34 m sprite is a
 * quarter of the phone panel's width sitting over the top cards, and identity is what the panel
 * heading is for.
 */
const ANATOMY_TOUR = {
  hold: 2900,
  basis: { origin: 'compute', forward: 'bodyForward' },
  wide: {
    anchor: 'compute',
    frame: 'robot',
    pos: [1.31, -0.26, 0.68],
    posEnd: [1.19, -0.69, 0.61],
    aim: [0, 0, -0.06],
    drift: 15000,
  },
  // The `glow` values are the highlight MARKER's radius in metres, one per part, and they are
  // authored here rather than measured off geometry for two reasons. Donna's head and legs are merged
  // CAD buckets, so their bounding spheres are the whole head-and-bracket assembly and the whole
  // thigh-plus-shank chain - a marker that size is a blob over her top half rather than a point on a
  // part. And her meshes only exist once a body has been posed, so a number here is the only thing a
  // build-time gate can check. Each is about the real part: a 90 mm head assembly, a 36 mm IMU box, a
  // leg segment pair, a 54 mm computer. The shells on the meshes themselves do the rest of the work.
  beats: [
    { part: 'head', window: [187.16, 188.36], glow: 0.075 },
    { part: 'imu', window: [188, 189], glow: 0.038 },
    { part: 'servos', window: [188.48, 189.68], glow: 0.1 },
    { part: 'compute', window: [189, 190], glow: 0.05 },
  ],
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
    // Not `orbit`. `flow.js` switches the auto-rotate on for that exact string and nothing else, so
    // declaring the tour's own word turns the revolution off without the flow needing to know a
    // tour exists: `viewer.setAnatomy()` reads `def.anatomyTour` and takes the shot from there.
    // ANATOMY_CAMERA and heroT above are NOT dead: a visitor who asked for reduced motion gets the
    // tour refused outright, and that pose with all four labels on it is the whole step for them.
    rotation: 'tour',
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
    // Jack's third fall and the recovery he speaks through. The chart window, the tight replay loop,
    // the instant, the lit robot and the slow-motion flag all live on the finding in data.js and are
    // not restated here.
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
  // The tour is what makes the in-scene name tags unusable, so the tour is what stands them down.
  // At these stand-offs "Donna" is wider than the phone panel: measured before this call existed,
  // the sprite covered 88% of the live "Head cameras" card with the card's copy reading through the
  // glyphs, and 16% of the "Torso IMU" card, and Rory's tag reached the IMU card too. The mechanism
  // is scene.js's, because scene.js owns the sprites; the DECISION is here, because it is a fact
  // about this step and not about the geometry, and a session where this module never loads keeps
  // the legacy brief's labels exactly as they shipped. Identity survives it: the panel heading names
  // all three robots and the live card names the part of the one the shot is on.
  holdNameTagsOnAnatomy(true);
  // Read by `viewer.setAnatomy()` off the def rather than out of the parts array, because it is one
  // spec for the whole step rather than four per-card ones and the flow hands the viewer only the
  // parts. It lands with THIS module, which is the property that matters: a tour placed eagerly
  // would be handed to a viewer holding the preview slice, whose only Donna sample is the 187.6 s
  // hero frame, and every beat would replay as a frozen robot. Arriving late costs nothing, because
  // `app.js` calls `flowApi.refreshPayload()` when this module and the recording land and that
  // disposes the preview viewer and mounts a new one against the def as it is by then. The viewer
  // reads `anatomyTour` once, when it is constructed, so the tour that runs is the one built on the
  // full 250 s recording - and a session where this module never loads simply has no tour.
  def.anatomyTour = ANATOMY_TOUR;
}
