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
 * The directed fly-through: four shots, one per card. Schema: `viewer.js`, "directed anatomy tour".
 *
 * WHY FOOTAGE AND NOT THE FROZEN POSE. Every one of these four cards is a claim about something the
 * recording DOES. Two joints pan and tilt the head; the IMU tells a fall from a walk by the
 * accelerations and angles it records; the leg servos drive the legs; the compute carries the log
 * while she works. A humanoid held at one instant under a slow orbit demonstrates none of them - it
 * is a statue with four labels on it. Each beat below names the seconds of Donna's own recording
 * where she is doing what the card says, and the camera is resolved against the rig every frame, so
 * the shot tracks the machine instead of the patch of turf she was standing on.
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
 *                            combined swing any 1.2 s of 184-190 carries (184.32 s is the maximum,
 *                            by 0.014 of a normalized point) and adjoining the beats that follow, so
 *                            the four run as one continuous 187.16-190.00 passage. Both joints move,
 *                            which is what "two joints pan and tilt the head" has to show.
 *   imu       188.00-189.00  accel magnitude 4.01 to 15.79 m/s^2, pitch 12.19 to 21.76 deg, roll
 *                            -1.37 to 18.87 deg, while her heading turns about 15 deg. Shot in the
 *                            WORLD frame, or the camera would turn with her and the attitude the
 *                            card is about would be the one thing not visible.
 *   servos    188.48-189.68  a full bilateral gait cycle: knees swing 0.375 and 0.364 rad, ankle
 *                            rolls 0.295 and 0.327 rad, and the servo diagnostics under it read
 *                            13.7 to 14.6 V of bus voltage at 51 C.
 *   compute   189.00-190.00  /compute is streaming through the whole beat, 56.0 to 60.5 percent CPU
 *                            and 18.49 to 18.53 percent memory, on a robot that is still walking.
 *
 * WHAT THESE SHOTS DO NOT CLAIM. The IMU card contrasts a fall with a walk; Donna never falls in
 * this mission (all three falls are Jack's) and every beat has to stay on the robot the cards are
 * about, so this beat shows the WALK half honestly and does not stage a fall. The compute card is
 * the harder one: no CPU readout, storage device or logger is modelled in this scene, so the shot is
 * her lower torso and the region the computer sits in on a machine that is working, and it says
 * nothing a mesh cannot support. The chart on the next step is where those samples are drawn.
 *
 * WHY THE BASIS IS NOT TWO CARDS. The viewer builds the robot frame from two anchors and drops the
 * vertical, and no PAIR of these four cards survives that: `compute` to `imu` is the spine, 0.02 to
 * 0.04 m of horizontal residue that swings through 280 degrees across this passage, and `compute` to
 * `servos` is a leg the gait swings through 60 degrees of it. `bodyForward` is `scene.js`'s fifth
 * anchor key, which is no card and can never be one: the torso link's own +x axis, 0.2 m out at the
 * compute anchor's height, which reads her recorded heading straight off the node the replay poses.
 *
 * SHOTS. Metres, resolved against the live rig every frame: `pos` is [along her heading, to her
 * right, up] from the point the camera looks at, `aim` nudges that point off the part's own anchor,
 * and the `End` pair is where each has arrived by the end of the beat. Every beat is a push-in, and
 * the stand-offs run 1.30 m down to 0.50 m on a machine 0.784 m tall - inside OrbitControls' 0.9 m
 * `minDistance`, which is why the tour writes the camera after `controls.update()` rather than
 * through it.
 *
 * WHY THE FOUR SHOTS ARE NOT ALL THE SAME SIZE. The connect panel is two very different frames. On a
 * 390 px phone the stage measures about 355 x 546 css px and the viewer widens its 42 deg base fov to
 * 71.3 deg vertical; on the desktop right column it is 1177 x 527, past the aspect where that
 * widening starts, so the fov stays at 42. The same camera therefore frames a subject about 1.84x
 * larger on the DESKTOP, and a stand-off tuned on the phone alone crops her head off on a laptop.
 *
 * Inside that, a beat is sized to WHAT ITS CARD NAMES, not to the robot. Two of these cards are about
 * the whole machine moving - the IMU beat is about a torso attitude that only exists as part of a
 * gait, and the servo beat is about legs - so those two stay near a metre, where all 0.784 m of her
 * is inside both panels (measured: her whole rig spans NDC -0.50 to 0.39 on the phone and -0.94 to
 * 0.74 on the desktop through the IMU beat). The other two are about a PART, and the first pass
 * framed them like the first two: it opened the head beat at 1.37 m, where the 0.152 m head assembly
 * is under 8% of the picture and the leader is a hairline into a silhouette. A card that names a part
 * the visitor cannot make out is a card about nothing. So the head beat runs 0.70 m down to 0.50 m
 * and the compute beat 0.80 m down to 0.58 m, measured on the running page over the whole move:
 *
 *   head     head assembly 19.9-24.6% of the phone frame's height, 37.1-46.0% of the desktop's, its
 *            crown at NDC 0.25-0.44 and 0.47-0.82, so it is inside both panels for every frame.
 *   compute  the lower torso is the centre of the frame and 26.5-32.1% of the phone stage's height
 *            between 0.78 and 0.63 m out, 52.5-62.4% of the desktop's between 0.77 and 0.62 m -
 *            measured as the merged ROOT/TORSO geometry's projected bounding box, four phases of the
 *            move on the running page, which carries to roughly 26 and 34 percent on the phone and 50
 *            and 66 percent on the desktop at the move's 0.80 and 0.58 m ends. The phone keeps her
 *            head and both feet in frame for the whole beat; the desktop's 42 deg lens closes past her
 *            crown, which is what a component read of one bay on a 0.784 m machine is.
 *
 * WHY NOTHING GOES UNDER 0.5 m. It used to be her name tag: the sprite rides 0.21 m over her head and
 * is 0.34 m wide in world units, so at 0.5 m it is wider than the phone frame. That is no longer the
 * binding constraint, because the tags now stand down for the whole step (see `applyExperience`, and
 * `holdNameTagsOnAnatomy` in scene.js for the mechanism) - at these stand-offs the sprite was measured
 * lying across 88% of the live "Head cameras" card with the card's own copy reading through the
 * glyphs, which is a label destroying the sentence it was supposed to be labelling. The reason that
 * survives is the machine: under about 0.4 m a humanoid in a 71 deg lens is a wall of white parts with
 * no robot in it.
 *
 * WHY EVERY SHOT IS PITCHED ABOUT 27 DEG DOWN. Same reason the ssl tour is: this scene has no sky.
 * Above the far boarding there is the background colour and nothing else, and a near-level camera on
 * a sub-metre stand-off spends the top third of a portrait panel on flat black. 27 deg puts the turf
 * behind her for the whole frame while keeping a humanoid's own verticality - past about 35 deg she
 * starts to read as a squat plan view of herself rather than as a machine standing up.
 *
 * Jack and Rory stay background. Measured as nearest rendered surface to the lens, the closest either
 * comes is Rory at 1.74 m on the head beat and 2.31 m on the compute beat (Jack 2.71 m there), against
 * 0.4 to 0.6 m for Donna's own body on those two: she is never less than 2.4x nearer the camera than
 * anyone else, and about 4.4x on the compute beat. Neither ever occludes her and neither can be
 * mistaken for the subject.
 */
const ANATOMY_TOUR = {
  hold: 2900,
  basis: { origin: 'compute', forward: 'bodyForward' },
  beats: [
    {
      // Front three-quarter off her right shoulder, opening head-and-shoulders and dollying into a
      // close read of the housing while the neck works underneath. Her HEADING is the reference,
      // not the head's, so the pan reads as the head turning against the body rather than as a
      // camera chasing it - which is the claim the card makes.
      //
      // WHY THIS IS THE ONE SHOT THAT DOES NOT OPEN ON THE WHOLE MACHINE. The first pass did, at
      // 1.37 m, and a card that names the head over a frame where the head is 8% of the picture is
      // a card about something the visitor cannot see. The subject of this beat is a 0.152 m
      // assembly on a 0.784 m robot, so the frame has to be sized to the PART: 0.70 m down to
      // 0.50 m holds the housing at 19.9-24.6% of the phone panel's height and 37.1-46.0% of the
      // desktop one's for every frame of the move. Identity does not go with the wide start: the
      // panel's own heading names all three robots, the shoulders and upper torso stay under the
      // housing for the whole beat, and the three beats that follow all open on the whole body, so
      // the tour still shows the machine. What does NOT carry it is her floating name tag, which at
      // this stand-off is wider than the panel and stood across the live card's copy; it is held back
      // for the step, and this beat is the one it was measured wrecking.
      part: 'head',
      window: [187.16, 188.36],
      pos: [0.56, 0.27, 0.32],
      posEnd: [0.4, 0.19, 0.23],
      // Opens 0.12 m low, so the shoulders under the neck say the head is ON a robot, and settles
      // onto the housing itself. Not lower: the desktop panel's 42 deg lens is the tight one here
      // and her crown already reaches NDC 0.82 of its upper half at the wider end of this move, so
      // another couple of centimetres of drop is what takes the top of her head off a laptop.
      aim: [0, 0, -0.12],
      aimEnd: [0, 0, -0.02],
    },
    {
      // Standing off her front quarter in WORLD axes and pushing in: she walks and turns inside a
      // frame that does not turn with her, which is the only way a torso attitude is visible at all.
      // Aimed 0.12 m below the IMU anchor so her feet stay in shot - the accelerations the card
      // names are made by the walk, and a torso with no legs under it is half the sentence.
      part: 'imu',
      window: [188, 189],
      frame: 'world',
      pos: [0.82, -0.82, 0.59],
      posEnd: [0.64, -0.64, 0.46],
      aim: [0, 0, -0.12],
    },
    {
      // Her front-left quarter, easing in over one gait cycle with the aim walking down from her
      // hips onto the leg anchor, so the legs own the bottom half of the frame and both feet stay
      // in it. Her LEFT because the anchor is the left leg's own hip-to-knee midpoint: from the
      // right it would be the far leg, labelled through the near one. Quartered rather than square
      // broadside because her recorded torso attitude leans 12 to 16 degrees back through this
      // passage, and a side-on lens at 1 m turns that honest lean into a robot apparently toppling.
      part: 'servos',
      window: [188.48, 189.68],
      pos: [0.57, -0.9, 0.55],
      posEnd: [0.44, -0.69, 0.42],
      aim: [0, 0, 0.14],
      aimEnd: [0, 0, 0.02],
    },
    {
      // In front of her and 11 degrees off her heading to her left, on the lower torso the computer
      // rides in, closing to a component read of it while the legs work underneath.
      //
      // WHY IT IS NOT SHOT FROM BEHIND ANY MORE. The first pass stood behind her right shoulder at
      // the same two stand-offs, and from back there the middle of the frame is her back plate: one
      // closed white surface with a shoulder over it and a hip under it. The leader arrived into
      // that, a hand's width above the knee, and read as a line pointing at her legs - so a card
      // saying the machine's computer rides in her LOWER TORSO was making a claim about a part the
      // picture did not contain. Frontal is the fix, and it is a property of this CAD rather than a
      // preference: the lower torso is the one region of the Wolfgang-OP whose front is legible, an
      // open cage with the electronics boxes visible inside it, and from 11 degrees off her heading
      // that cage is square to the lens with both legs cycling under it.
      //
      // The aim is the compute anchor with NO offset, which is what puts the bay itself at the
      // centre of the picture: measured on the running page, the anchor projects 0 px from the stage
      // centre at both panel sizes for every frame of the beat, and the leader terminates there.
      //
      // WHY THIS SHOT IS TIGHT AND NOT WIDE. This scene models no computer - the Bit-Bots CAD this
      // rig came from has none - so the only honest way to show a machine carrying its own logger
      // is to show the part of the machine it is carried IN, at a size where that part is the
      // subject. An earlier pass opened at 1.26 m, which put the torso at 24% of the phone panel and
      // the compute bay itself at about 6%, and a card claiming onboard logging over a frame of a
      // small distant robot walking is a claim the footage does not carry. 0.80 m down to 0.58 m
      // makes the torso about 26 to 34 percent of the phone panel's height and 50 to 66 percent of
      // the desktop one's (measured 26.5-32.1% and 52.5-62.4% across the middle of the move), and
      // the leader lands on the vented lower-torso box rather than on a silhouette. Not tighter: at
      // 0.46 m the phone frame is a wall of white parts with no robot in it, and this card is half
      // about the walking. Here the phone keeps her head and both feet in frame for the whole beat
      // while the bay owns the middle of it; the desktop's narrower lens closes past her crown, so
      // the end of the move is the bay, the hips and the legs cycling under them: a machine visibly
      // at work, carrying the thing that is writing the log.
      //
      // Still `frame: 'robot'`, so she holds still in the picture and the pitch sweeps behind her:
      // the alternative reads as a camera losing a robot rather than as a robot at work.
      part: 'compute',
      window: [189, 190],
      pos: [0.7, -0.14, 0.36],
      posEnd: [0.51, -0.1, 0.26],
      aim: [0, 0, 0],
    },
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
