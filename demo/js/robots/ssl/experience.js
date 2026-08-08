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
 * up, +z is one side.
 *
 * EVERY NUMBER HERE IS NOW MEASURED OFF REAL HARDWARE, which is the round 8 change. Round 7 authored
 * these four points against the PROCEDURAL robot this scene draws from league convention - a 180 mm
 * cylinder 147 mm tall, wheels on +/-60 and +/-120 degree mounts - and noted that where the scene
 * modelled no part, the anchor was "the region of the hull the part is in". The anatomy step now
 * draws RoboTeam Twente's published CAD instead (`rtt-model.js`), so three of these four points can
 * stop being regions and start being parts, and the fourth has to say plainly that it is not one.
 * The values come from `assets-src/rtt/anchors.py`, which measures the shipped asset in this exact
 * frame; the bearings and radii it reports are the real machine's, and two of them disagree with the
 * convention this file used to assume.
 *
 *   omni      -135 deg, 78.7 mm out, 26.5 mm up: the centre of the rear wheel on the +z side. Round 7
 *             put this at 111 degrees and 12 mm up, between two wheels and near the carpet, because
 *             the procedural base mounts its rear wheels at 120 degrees. Twente's are at 135, and the
 *             wheel centre is 26.5 mm up on a 53 mm wheel.
 *   imu       the hull axis, 134.5 mm up: just clear of the top-plate control boards, whose own tops
 *             measure 133.9 mm. THIS IS THE ONE ANCHOR THAT IS STILL A REGION AND NOT A PART, and the
 *             reason is in RTT-MODEL-NOTICE.md: Twente's published assembly names no IMU anywhere in
 *             its 972 parts, so there is nothing here to point at and nothing may be invented. What
 *             the card's claim is actually about - orientation tracked while a controller closes the
 *             motion loop - happens on this board stack, so the marker sits over it. Kept on the axis
 *             at x = z = 0 deliberately: the tour's wide shot and its basis both hang off this anchor
 *             (see ANATOMY_TOUR), so moving it sideways would re-frame the whole step. Round 7 had it
 *             at 149 mm, which on the real 139 mm robot floats above the machine entirely.
 *   kicker    -16 mm back, 42 mm up, on the hull axis: the centre of the capacitor bank, which is the
 *             two 35 mm WCAP-AIG5 electrolytics measured at z -70 and +60 mm. The card names a bank and
 *             this IS the bank, which round 7 could only gesture at with a point inside the forward
 *             hull. THE MIDPOINT AND NOT ONE OF THE TWO, which is a correction made from the rendered
 *             frame: anchored on the -z capacitor, the halo sat out on one flank while the beat drew
 *             the solenoid and chipper solid in the middle of the machine, so one card marked two
 *             places. On the axis the marker sits over the bank and the mechanism it feeds together,
 *             and the beat's 35 mm halo still reaches toward both capacitors.
 *   dribbler  71.6 mm forward, 42.7 mm up: the centre of the dribbler bar. The procedural roller sits
 *             15 mm lower (DRIB_OFF_Y), well inside this beat's 35 mm halo, so the marker still lands
 *             on the roller on the fallback path where the CAD never loaded.
 */
const PART_OFFSETS = [
  ['omni', -0.0556, 0.0265, 0.0557],
  ['imu', 0, 0.1345, 0],
  ['kicker', -0.016, 0.042, 0],
  ['dribbler', 0.0716, 0.0427, 0],
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
 * The directed tour: one wide shot, four cards, four lit parts. Schema: `viewer.js`, "directed
 * anatomy tour" and "part highlight".
 *
 * WHY FOOTAGE AND NOT A POSE. Three of these four cards make a claim about MOTION - an omni drive
 * moves in any direction without turning to face it, the IMU holds orientation while the controller
 * closes the loop, the dribbler keeps the ball under control while the robot drives - and a robot
 * standing still under a slow orbit demonstrates none of them. Each beat below names the seconds of
 * the real tracker log where bot 8 is doing the thing its card claims, so every claim is made over
 * footage of the machine making it.
 *
 * WHY THERE IS ONE SHOT AND NOT FOUR, which is round 7 and the only structural change here. The four
 * per-beat shots this replaces ran 0.82 m down to 0.38 m on a machine 180 mm across, and three of the
 * four ended as hull details: a card about a capacitor bank over a curved band of hull, a card about
 * a roller over a bar and a ball, with no robot around either. On this mission that is the worst
 * version of the problem, because the parts these cards name are NOT distinct meshes - they are four
 * regions of a 180 mm hull - so a close shot of a region is a close shot of a plain surface. The
 * camera now holds one wide framing that keeps the whole robot, its wheels and the carpet it is
 * driving on in frame for the whole tour, and the part the live card names is marked in the scene by
 * the highlight's anchored halo (`viewer.js`, "part highlight"), which is drawn without depth test
 * exactly so a part INSIDE a hull can still be pointed at honestly.
 *
 * WHY THESE SECONDS, from the decoded tracker (metres, m/s, rad/s; every number here is measured
 * off the payload, not authored):
 *
 *   omni      2.62-4.42  a 3.6 m diagonal run, 0.93 -> 2.94 m/s, and the heading holds at 0.77 rad
 *                        from the first sample to the last. Translating hard while not turning at
 *                        all is the omni claim, and this is the only stretch in the log that is
 *                        both fast and yaw-free for a full 1.8 s.
 *   imu       0.70-1.62  the hard spin: yaw rate reaches -6.5 rad/s, about one revolution a second,
 *                        while the robot creeps at 0.1-0.9 m/s. The wide shot is in WORLD axes, so
 *                        the hull turns inside a frame that does not turn with it - which is the
 *                        only way a spin is visible at all, and the reason the framing is not bolted
 *                        to the hull.
 *   kicker    4.42-5.92  the deceleration out of that run, 2.44 -> 1.04 m/s. The card states a
 *                        hardware fact rather than an event, so the beat is a working robot with the
 *                        bank marked inside its forward hull, and it claims no kick.
 *   dribbler  53.50-54.08  the ball closes from 0.40 m to 0.08 m of the hull centre while sitting
 *                        within 20 deg of the dribbler's own bearing - the ball in the mouth - and
 *                        leaves on bot 8's real attributed kick at 53.977 s. The window ends 0.1 s
 *                        after the kick, which is what makes the release legible without spending
 *                        the tail on a robot with no ball in frame.
 *
 * WHY THE DRIBBLER BEAT IS SOMEWHERE ELSE ENTIRELY, and why it is inside a finding window when the
 * other three are not. Bot 8 and the ball are within 0.32 m of each other, with the ball inside
 * 40 deg of the mouth, for exactly two stretches in 110 s: this one, and 6.9-7.5 s, where the ball
 * is not being carried at all - it is blue 10's shot rebounding off the hull - and where four other
 * robots sit inside 0.9 m. The rest of the log has this robot a metre or more off the ball. A card
 * that says a roller keeps the ball under control, over 2.9 s of a robot nowhere near the ball, is
 * the failure the first version of this tour shipped, and no camera fixes it.
 *
 * The cost is that these seconds sit inside `kicker-charge`'s 46.34-62.74 s window. That window is
 * a SYNTHESIZED capacitor-voltage overlay: nothing in the replayed motion here is a fault, the kick
 * at 53.977 s is real tracker data the finding's own honesty note calls out as real, and this card
 * is about the roller, not the charge circuit. Showing footage the failure step later re-reads is a
 * narrative cost. Showing a dribbler card over a robot with no ball is a truth cost, and that is
 * the one worth avoiding. The failure step loops `kicker-charge.loop`, 53.48-54.63 s, which is these
 * seconds plus half a second either side, so the visitor meets one kick twice on purpose: once as a
 * card about a roller, once under a synthesized charge trace, and neither says the kick was faulty.
 *
 * THE WIDE SHOT. Offsets in metres, resolved against the live rig every frame; in WORLD axes, so
 * `pos` is [along the pitch's +x, toward -y, up] from the point the camera looks at. Hung off the
 * `imu` anchor - the centre of the top plate, which is the hull's own vertical axis - and aimed
 * 0.05 m under it, at the middle of a 147 mm hull.
 *
 * HOW FAR OUT, arithmetically. `viewer.js` holds a 42 deg vertical fov on the desktop column and
 * widens it to about 65-70 deg on a phone, so the frame is 0.77x the stand-off tall on the desktop
 * and about 1.4x tall by 0.9x wide on a phone. At 0.48 m the 180 mm hull is 42 per cent of the
 * desktop panel's height and 43 per cent of the phone panel's width, with the wheels, the carpet
 * and a field line or two around it - a machine on a pitch rather than a cropped surface, and still
 * far enough back that the four corner cards have their corners. That distance is inside
 * OrbitControls' `minDistance`, which is why the tour writes the camera after `controls.update()`
 * rather than through it.
 *
 * WHERE IT STANDS, and why it is a world bearing rather than a hull-relative one. Bot 8's recorded
 * heading over these four passages runs 44 deg, 136 -> 10 deg (the spin), 56 -> 71 deg and 17 -> 21
 * deg, so there is no single hull-relative bearing to stand on: the spin beat would drag the camera
 * round the pitch at a revolution a second. A world bearing of 55 deg easing to 25 deg (measured from
 * the pitch's +x axis, toward +y) sits ahead and to the left of the robot on three of the four
 * passages - including the dribbler beat, where the ball arrives along +x and the nearest other
 * robot spends the window 0.19 to 0.45 m off bot 8's RIGHT, which is the side this bearing is not on.
 *
 * THE DRIFT eases those 30 degrees of azimuth and 4 of elevation and back on a raised cosine over
 * 13 s, at a constant 0.48 m radius, against an 11.6 s tour cycle so the two clocks never lock. It
 * is what gives a 180 mm cylinder parallax, and it never cuts.
 *
 * WHY IT LOOKS DOWN 30 TO 34 DEG. This scene has no sky: above the far boarding there is the
 * background colour and nothing else. A camera 0.2 m off the carpet at half a metre out is pitched
 * about 16 deg down, and on a portrait phone panel that puts the horizon a third of the way down the
 * frame - a third of the panel is flat black. At 30 to 34 deg the horizon sits just under the top
 * edge and the whole panel is carpet and machine.
 *
 * THE HALO RADII. The highlight's shell layer sleeves a part's own meshes when the scene offers them
 * through `sceneApi.partMeshes()`, and this scene offers none: nineteen robots share two geometries,
 * so there is no per-part mesh handle to hand over, and the highlight falls back to an anchored
 * marker. That is still true in round 8 and it is deliberate. The CAD model the anatomy step loads
 * arrives ASYNCHRONOUSLY, some way into a tour the viewer has already memoised its mesh map for, so
 * bolting the shell onto it would be a race with two outcomes and no way to tell which one a visitor
 * got. The wireframe answers the same question better anyway: the part the live card names is drawn
 * SOLID inside a transparent machine (`rtt-model.js`), which is a stronger statement than a glow, and
 * the halo stays as the marker that says look here.
 *
 * The radii are therefore still authored rather than measured off geometry - but they are now authored
 * against parts that have been measured. Each is about the size of the real thing on Twente's robot:
 * a 53 mm wheel, the top-plate board stack, a 35 mm bank capacitor (round 7 guessed 45 mm at this
 * beat, before there was a part to measure), a 14 by 72 mm roller.
 */
const ANATOMY_TOUR = {
  hold: 2900,
  // Two anchors that are already on the overlay: the top-plate centre and the dribbler bar. Their
  // difference in the ground plane IS the direction the robot is facing. The wide shot is in world
  // axes and does not use it, but the viewer validates the basis before it will run a tour, and a
  // hull-relative frame stays one line away if a later round wants one.
  basis: { origin: 'imu', forward: 'dribbler' },
  glow: 0.04,
  wide: {
    anchor: 'imu',
    frame: 'world',
    pos: [0.23, -0.33, 0.27],
    posEnd: [0.38, -0.18, 0.24],
    aim: [0, 0, -0.05],
    drift: 13000,
  },
  beats: [
    { part: 'omni', window: [2.62, 4.42], glow: 0.045 },
    { part: 'imu', window: [0.7, 1.62], glow: 0.035 },
    { part: 'kicker', window: [4.42, 5.92], glow: 0.035 },
    { part: 'dribbler', window: [53.5, 54.08], glow: 0.035 },
  ],
};

/**
 * The two follow-shot framings.
 *
 * Both steps used to leave `camera` null, which handed the shot to `cameraHome` - an offset 5.34 m
 * long, framed to keep a whole 12 x 9 m pitch legible. On a 390 px phone that reads as a plan view
 * of a carpet with specks on it, and on the failure step, where the panel is half height because
 * the chart has the other half, it left two wedges of empty dark where the pitch had run out. So
 * both steps carry an explicit offset:
 *
 *   mission  2.40 m at 60 deg, bearing 40 deg off the long axis on the +y touchline side, tracking
 *            the ball. Framed for the GOAL MOUTH, which is what round 6 asked this step to show.
 *   failure  0.92 m at 42 deg, same azimuth as `cameraHome` (18 deg off the long axis), tracking
 *            BOT 8 (see `followAnchor` below), on a panel that gives up some of its height to the
 *            chart.
 *
 * THE MISSION NUMBERS CHANGED IN ROUND 6 AND THE OLD RATIONALE NO LONGER APPLIES. Round 5 framed
 * this step at 0.80 m for two hulls and a ball, on the argument that a 180 mm robot has to be more
 * than 30 px. Round 6 moved the window onto the goal (see SUCCESS WINDOW below), and a goal mouth is
 * 1.8 m wide (`geometry.goalWidth`; 0.18 m deep, walls 0.155 m tall). A shot that covers 0.8 m of
 * ground cannot hold it, so the choice is not "close or wide", it is "show the mouth or show the
 * hulls", and the step's job now names the mouth.
 *
 * HOW WIDE, arithmetically, measured against the live panels rather than assumed. `viewer.js` holds
 * a 42 deg base fov and widens it by sqrt(2.2 / aspect) as the panel narrows. The mission stage is
 * 678 x 599 px on a 1440 px desktop (aspect 1.13 -> 56.3 deg vertical) and 352 x 441 px on a 390 px
 * phone (aspect 0.80 -> 65.0 deg), so the ground each covers ACROSS the frame is 1.21 x and 1.02 x
 * the camera distance. At 2.40 m that is 2.90 m of pitch over 678 px and 2.44 m over 352 px: the
 * 1.8 m mouth fits both with room either side. Simulated frame by frame against the live follow
 * spring, both goalposts hold inside the frame for EVERY frame of the success loop on the desktop
 * panel and for all but its last on the phone, where the far post slips past the edge at 63.58 s
 * with the ball already 1.5 m from the goal centre. The cost is the robot: 180 mm is 42 px on
 * desktop and 26 px on the phone, against round 5's 87 px. That is the trade, taken deliberately - a legible
 * hull with no goal in the frame does not show a goal being scored.
 *
 * WHY 60 DEG, AND WHAT THE BLACK BAND IS. Behind the goal there is 0.6 m of run-off
 * (`boundaryWidthGoalLine`), a 100 mm perimeter wall, and then the background colour: no sky, no
 * crowd, nothing. From 2.4 m out, aimed at a ball that is ON the goal line, that wall is inside the
 * frame no matter how the camera is pitched - clearing it would need better than 78 deg, which is a
 * plan view. 60 deg is where the band above the boarding settles at 13-25% of the panel (worst
 * whenever the ball is hard against the goal line, which this lap reaches twice - at the open, 0.04 m
 * outside it, and across the 62.94-63.13 s crossing), while the rest of the frame stays on
 * carpet and machine. Flatter grows the band; steeper flattens the mouth into a top-down rectangle.
 *
 * WHY 40 DEG AND NOT `cameraHome`'S 18. The approach runs from y +1.83 down to the mouth at y +0.4,
 * so the camera has to sit up-field on the +y side for the mouth to stay AHEAD of the ball while the
 * ball travels. At the old azimuth the FAR POST projects at -1.20 of half-width on the phone at the
 * moment of the shot - off the edge, with the goal centre back at -0.64 and half the mouth simply
 * not on the panel - and the whole mouth is in frame for only 49% of the lap. At 40 deg that post
 * sits at -0.77 at the same instant and the mouth holds for the whole lap, which is what makes the
 * crossing read as a crossing rather than as a cut to a ball that is suddenly in a net.
 *
 * ONE KNOWN OCCLUSION, kept because it is the event. Polaris 6 is 0.14 m off the ball as it crosses
 * - that proximity IS the last touch that makes this an own goal - so for about a tenth of a second
 * the keeper's hull covers the ball from this bearing. No azimuth removes it: the two are 6 deg
 * apart as seen from any camera that also holds the mouth. The ball reappears inside the goal from
 * 63.0 s and stays visible through the rebound.
 *
 * The follow translates camera and target together, so what is written here is the OFFSET the shot
 * keeps for the whole step; the absolute pair is that offset applied to the tracked point at the
 * instant each window opens, which is what stops the first follow frame from jumping.
 */
// Absolute pair for the focus point where the window opens at 61.78 s: the smoothed ball track is
// at scene (-5.958, -0.218), 0.04 m outside its own goal line. From the first follow frame on, only
// the offset matters.
const MISSION_CAMERA = {
  position: { x: -5.038, y: 2.138, z: -0.989 },
  target: { x: -5.958, y: 0.06, z: -0.218 },
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
 * SUCCESS WINDOW. 61.78 to 63.60 s, 1.82 s at 1x: the one goal in this payload. Round 5 looped
 * 0.5-7.5 s, a clean stretch of passing chosen because no finding touched it; round 6's note on this
 * screen was "show it scoring a goal", and a passage picked for containing nothing is the opposite
 * of that. Every number below is measured off the decoded tracker and the exported referee track.
 *
 * WHAT THE LOOP SHOWS. The ball rebounds out of the goal at 61.76 s, runs up to Ferrum 12, and
 * Ferrum 12 kicks it back at 62.6897 s from (-5.223, 1.831) at 6.07 m/s. The tracked ball clears the
 * goal line at about 62.94 s, reaches 0.167 m behind it at 63.013 s, comes off the back wall, is
 * back over the line at 63.13 s and is 1.5 m from the goal centre by the time the lap ends, rolling
 * away down the pitch under the referee's HALT. The referee's own record puts the crossing at
 * 62.739 s (`referee.goals[0].tBallCrossing`, which is also where the third live-play interval ends)
 * and the score awarded at 77.183 s, 14.4 s of review later; the tracked ball and the game
 * controller disagree by about two tenths, and both are in the window.
 *
 * IT IS AN OWN GOAL AND THE COPY MAY NEVER SAY OTHERWISE. The tracker attributes the shot to Ferrum
 * 12. The game controller attributes the LAST TOUCH - the thing that decides the rule - to Polaris
 * 6, our keeper, who is 0.14 m off the ball as it crosses. Polaris is the tracked fleet, so this is
 * a goal CONCEDED. Robots converging, a ball crossing the line, a goal being scored in this passage:
 * all true and all sayable. "Our robots scored" is false here and is banned on every surface that
 * describes this step, in all four roles.
 *
 * NONE OF THE FLEET FAULTS TIE TO THIS GOAL. `kicker-charge`'s CHART window is 46.34-62.74 s, so it
 * contains this passage and this success window necessarily overlaps it - a shared span, not a
 * shared cause, which is exactly what the finding's own honesty note and the `goal-review` answer in
 * `script.js` say. The fault MOMENT is untouched and stays exclusive to the failure step:
 * `kicker-charge.loop` 53.477-54.627 s around t 53.977, eight seconds before this window opens.
 * `experience.test.mjs` enforces that separation on the loop and the instant rather than on the
 * chart span, for the same reason.
 *
 * WHY IT OPENS AT 61.78 AND NOT ON FERRUM 4'S TOUCHES AT 61.14 AND 61.20. Those touches are good
 * build-up right up until you watch where the ball goes: the tracker has it behind x = -6 from
 * 61.52 to 61.75 s, dead centre of the mouth, before it comes off the back wall. Nothing in the log
 * calls that a goal and the game controller records one crossing, not two, but a loop that opened at
 * 61.05 s would put a ball in the net twice inside one lap on a step whose copy says there was one
 * goal. 61.78 s is the first sample with the ball back on the field side of the line.
 *
 * WHY IT CLOSES AT 63.60, WHICH IS THE NEAR SIDE OF A GAP AND NOT THE FAR SIDE. The follow spring in
 * `stepFollow()` snaps instead of chasing when the point it is handed jumps further than
 * `followTuning.snap` (3.0 m, summed over the axes), and a loop wrap is exactly such a jump - except
 * that the comparison is against the LAGGING follow point, not against the focus track. On this
 * passage the spring runs about a metre behind the ball, so a short tail leaves a short wrap jump,
 * and there are TWO clean tails with a bad band between them:
 *
 *   63.60 s   wrap 0.82 m. No snap fires, but the spring absorbs it inside half a second and the
 *             ball never leaves the panel - worst projection 0.74 of half-width on the phone,
 *             simulated at 30, 45, 60, 90, 120 and 240 fps.
 *   63.85 to 64.25 s   wrap 1.4-2.9 m. Too big for the spring to hide, too small to snap, so the
 *             opening tenths of every lap have the ball off the panel. Do not end here.
 *   64.55 s   wrap 3.81 m, which snaps clean. This is where round 6's first pass at the retime put
 *             the tail, having found the snap threshold and stopped looking.
 *
 * The far tail is the one this file nearly took, and measuring the framing rather than eyeballing
 * it is what argued it down. The ball runs 4.1 m in that window, and past 63.68 s the goal is out of
 * frame entirely on both panels: a third of the lap is a ball rolling across empty carpet with no
 * goal in it, on the one step whose note was "show it scoring a goal". At 63.60 s the whole mouth is
 * in frame for the whole lap. The tail is not filler either: it is the ball coming out of the net
 * and running 1.5 m off the goal centre, which is what makes the frames before it read as a ball
 * that went in.
 *
 * CONTEXTUAL LABELS. Mission truth, and role-invariant. The roster is the one the log carries:
 * eight robots on one side, eleven on the other, which is what the game controller's
 * maxAllowedBots says and what the tracker shows for every sample of the passage. Score and block
 * are the two things the robots in this passage are trying to do, which is as true of a conceded
 * goal as of any other minute; neither label says who managed it.
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
    window: [61.78, 63.6],
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
  /**
   * The anatomy step's display model: RoboTeam Twente's CAD, as a transparent wireframe with the live
   * card's part drawn solid. Read by `viewer.setAnatomy()` through the `anatomyModel` channel
   * documented in viewer.js, and by nothing else - so the picker, the mission goal loop, the failure
   * step and the chat replays all keep the procedural hull, which is what nineteen robots on a pitch
   * have to be drawn as.
   *
   * A DYNAMIC IMPORT INSIDE A LAZY MODULE, for two separate reasons. The eager budget is the first:
   * `ssl-eager-size.test.mjs` walks static imports from `script.js` and holds them under 60 KB with
   * about two hundred bytes spare, and while this file is already behind that boundary, the reader and
   * its 865 KB asset have no business being fetched by a visitor who opens the picker and leaves. The
   * second is the honest one: the fetch can fail, and a failure here has to cost nothing. This
   * promise rejecting - a 404, an offline visitor, a truncated asset, a payload whose roster has no
   * bot 8 - leaves the step exactly as round 7 shipped it, with the procedural robot posed under four
   * labels and a working tour. The viewer swallows the rejection for precisely that reason.
   */
  def.anatomyModel = (THREE, mount) =>
    import('./rtt-model.js').then((m) => m.installAnatomyModel(THREE, mount, { bot: ANATOMY_BOT }));
  // Read by `viewer.setAnatomy()`, off the def rather than out of the parts array, because it is
  // one spec for the whole step rather than four per-card ones and the flow hands the viewer only
  // the parts. Lands with this module, so a viewer mounted before the payload simply has no tour.
  def.anatomyTour = ANATOMY_TOUR;
}
