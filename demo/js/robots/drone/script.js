// drone/script.js - the survey quadcopter RobotDefinition.
// Every number quoted in an answer below was read out of the generator in data.js, not estimated.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

// ---- directed anatomy tour (viewer.js `anatomyTour`) ----
//
// The contract is documented at demo/js/core/viewer.js. Four beats, one card live in each, the part
// that card names lit in the scene, and every beat held over the seconds of THIS mission that show
// what its card claims. ONE wide framing carries all four.
//
// WHY THESE SECONDS. 20.6 to 31.2 s is one continuous healthy passage: most of the second survey
// lane (20.6 to 27.7 s, x from 6.71 m to -9.98 m at a held 6.0 m) and the cross-lane turn that
// follows it (27.7 to 31.2 s, y from -3.49 m to -0.01 m). Nothing has gone wrong yet - the bearing
// wear starts at 32 s - so all four cards are held over the aircraft working. Contiguous on purpose:
// the beats are four passages of one flight rather than four seeks across it, and the manual
// handover, which widens the loop to the union of the windows, replays that same lane and turn
// rather than a stitched-together digest.
//
// WHY IT NO LONGER OPENS AT 18.6, WHICH IS WHERE THE LANE ITSELF OPENS. Round 12 (see the shot below)
// asks the camera to look back down the ground this aircraft has already surveyed, and at the top of
// a lane it has surveyed none OF THIS ONE: 23 tiles are laid by 18.6 s and every one of them belongs
// to the previous lane, 3.5 m across the field and behind the camera's shoulder from this bearing.
// Rendered at 18.6 s and looked at, the frame is bare grid with a machine in it - the exact failure
// this round exists to fix, on the first card a visitor sees. The aircraft needs about 2.4 m of trail
// on its OWN lane before the head of it clears the near zone under the frame's lower edge, which it
// has by 20.5 s; rendered at 20.6 s the trail is entering at the bottom of the picture, so that is
// where this opens and the four windows divide the 10.6 s that is left. They are 2.4 to 2.9 s against
// a 3.1 s hold, so the passages replay at 0.77x to 0.94x - a shade under real time, which is the
// price of the trail and is cheap.
//
// WHY THERE IS ONE SHOT AND NOT FOUR, which is round 7 and the only structural change here. The four
// per-beat shots this replaces closed to 0.42, 0.39, 0.28 and 0.62 scene units on their subjects, and
// the notes they carried were mostly about how badly that crops: at 0.28 units the frame is 0.24
// across against a 0.586 unit aircraft, so the card about the survey camera was held over a sphere
// filling the picture with no aircraft around it, and the battery beat had to be shot from astern
// because three parts of the airframe sit between the beam and the pack. Both problems are the same
// problem - a camera close enough to identify a 20 mm part cannot hold a 0.45 m machine - and neither
// is solvable by moving the camera. So the camera holds ONE wide framing that keeps the whole
// airframe in frame for the whole tour, and the part the live card names is LIT (scene.js's
// `partMeshes()`, viewer.js's part highlight). The battery is visible from the wide shot's own
// bearing, and the parts that are not - the flight controller on the far side of the canopy at the
// far end of the drift - carry the highlight's anchored halo, which is drawn without depth test
// precisely so a part tucked into an airframe can still be found.
//
// WHY THE MISSING BOARD IS NOW A BOARD. The `imu` card says "Flight controller - closes the attitude
// loop from roll, pitch and yaw", and its anchor used to be the carbon centre plate: the card named
// a part this aircraft did not have. scene.js now carries a 24 x 20 mm FC board with its processor
// and a status LED on the rear-left corner of the top deck, and the anchor is on the board. See the
// flight-controller block in scene.js for why the corner is the only place on the deck a board is
// both real and visible.
//
// ROUND 12: WHY THE SHOT MOVED, and it is the only structural change in this file. Everything above
// was true and the step still opened on what looked like a hovering statue. The reason is geometric
// rather than editorial: the wide shot is an offset resolved against the aircraft every frame, so
// the aircraft is motionless in frame BY CONSTRUCTION, and for the motion to reach a visitor
// something else in the picture has to be fixed in the world, close to the subject and irregular.
// Six metres up over a 20 x 14 m field there was nothing: the flown track and the lane dashes run
// ALONG the direction of travel so they slide along themselves, the field boundary is one thin line
// seven metres away, and the viewer's own blueprint grid is a regular lattice - the single worst
// thing to show a translation against. Rendered at four beat times and looked at, the four frames
// were interchangeable. That is what the SSL mission's step gets for free by having a carpet, field
// lines and other robots inside half a metre of its subject.
//
// Two changes fix it, and they are two halves of one idea. scene.js now draws the SURVEYED GROUND -
// the ground the aircraft's own drawn camera footprint has swept, filling in behind it tile by tile
// - which puts a world-fixed, growing, irregular thing directly under the machine. And this shot
// moves round to look back DOWN that trail: the camera stands ahead of the aircraft along its lane,
// so the trail runs from the bottom of the frame up past the airframe and its 1 m seams stream past
// at the aircraft's own ground speed. The tour lays 3 to 7 new tiles inside every beat (7, 7, 3 and
// 3, measured on the built payload), and the strip the PREVIOUS lane laid sits beyond this one, so
// the frame carries a second world-fixed rail at a different depth. The aircraft flies over ground
// it is visibly mapping, which is both the motion the step was missing and the thing the mission is
// actually about.
const ANATOMY_TOUR = {
  // 3100 ms, which is the family's 2900 plus the crossfade. `.v-anat.is-tour .v-anat-card` fades
  // over 0.4 s, so the first eighth of every beat is a card arriving; 3100 leaves 2.7 s of settled
  // reading on a card of one sentence. The old value here was 3067 and was solved to keep four
  // review captures 2900 ms apart from landing on camera cuts - there are no cuts any more, so that
  // arithmetic is gone with them. The four windows are 2.9 to 3.5 s of mission, so this hold replays
  // them at 0.94x to 1.13x.
  hold: 3100,
  // The pack and the nose lens: two anchors the overlay already resolves, whose difference in the
  // ground plane is exactly the direction the airframe is pointing (the pack sits 0.006 off the
  // centreline, the lens dead on it). NOT `imu` any more - that anchor moved onto the FC board in the
  // deck's rear-left corner, which is 21 degrees off the nose axis and would skew the whole frame.
  basis: { origin: 'battery', forward: 'camera' },
  // THE WIDE SHOT. Hung off the pack, which is the closest thing this aircraft has to a centre of
  // mass, aimed 0.01 units ahead of it and 0.03 under it: the hull centre, a touch low, which is what
  // lifts the airframe off the middle of the frame and gives its trail the lower third.
  //
  // HOW FAR OUT, arithmetically, in scene units and not field metres - scene.js compresses the field
  // by 0.30 units per metre and draws the ~0.45 m airframe oversize against it, so the motor diagonal
  // is 0.495 units and the prop discs take the aircraft to 0.586 units across. `viewer.js` holds a
  // 42 deg base vertical fov and widens it by sqrt(2.2 / aspect) as the panel narrows: the flow's
  // stage measures 1637 x 900 at a 1440 px desktop (aspect 1.82, so 45.7 deg) and about 355 x 546 on
  // a 390 px phone (aspect 0.65, so 70.4 deg). At the 1.15 unit stand-off the frame is 0.97 units
  // tall by 1.76 wide on the desktop and 1.62 by 1.05 on the phone, so the 0.586 unit aircraft is
  // 33 per cent of the desktop frame's width and 56 per cent of the phone's - the whole machine,
  // props included, inside both panels with room for the four corner cards. The old close beats
  // needed 0.68 units just to fit the airframe, so this is nowhere near the size anything crops at.
  //
  // WHERE IT STANDS, and this is the round 12 change. AHEAD OF THE AIRCRAFT ALONG ITS LANE, 163 deg
  // round from the nose at one end of the drift and 133 deg at the other, both on the aircraft's left.
  // The reason is the surveyed ground: the trail this aircraft is laying extends BEHIND it, and the
  // ground a camera hung this close can see at all begins about one stand-off PAST the subject (below
  // that the frame's lower edge has already cleared the ground - the aircraft is 1.925 units up and
  // the camera only 0.6 above it). So a camera standing behind the aircraft has the whole trail in
  // the blind near zone under the frame, which is exactly what the round 7 bearing did and why its
  // frames had bare ground in them. Standing ahead and looking back down the lane puts the trail
  // where the shot can see it: it runs from the bottom edge up to the leading tile under the
  // airframe, and it grows toward the camera for the whole tour. Rendered at both ends of the drift
  // and at all four beat times, coverage is in frame on every one.
  //
  // WHAT THAT BEARING COSTS, stated plainly: the nose gimbal and its survey lens are on the far side
  // of the canopy from here, where round 7's drift used to swing round to meet them. That is now the
  // wireframe's job rather than the camera's - from round 10 this step draws the airframe transparent
  // and the live card's part SOLID inside it, so the lens is drawn, lit and legible through the hull
  // on the beat that names it, and the anchored halo (drawn without depth test) says where. A bearing
  // that could see the lens could not see the trail, and the trail is what the whole step was missing.
  //
  // THE DRIFT eases 30 degrees of azimuth and 2 of elevation and back on a raised cosine over 16 s,
  // at a stand-off held between 1.150 and 1.168 units: 1.9 deg a second, a shot that breathes rather
  // than an orbit, and it never cuts. 16 s against a 12.4 s tour cycle so the two clocks do not lock
  // and no card is permanently the one shot from the far end of the arc. `frame: 'robot'` bolts the
  // arc to the airframe, which on this passage is a fixed arc in practice - the survey holds heading
  // to within 0.9 deg from 18.6 s to 31.2 s - and keeps the shot on the aircraft's left through the
  // cross-lane turn rather than walking round to the nose.
  //
  // ELEVATION 31 TO 33 DEG, up from round 7's 26 to 30, for two reasons that both point the same way.
  // The visible ground begins at `height / tan(elevation + half-fov)` from the camera, so every degree
  // of elevation pulls the trail's near end closer to the aircraft; at 26 deg the leading tiles sat
  // under the frame. And the phone panel's 35.2 deg half-fov means anything shallower than 35 puts
  // some flat background above the horizon, so the band is 9 per cent of the phone panel here against
  // 15 at 26 deg. The reason round 7 capped this at 30 no longer applies: the pack hangs under the
  // lower plate and the plate's overhang shades it from above, but the battery beat opens 3.1 s into
  // the tour and the drawing settles at 2.4 s, so that card is ALWAYS read against the transparent
  // airframe with the pack drawn solid inside it, never against the shaded solid.
  wide: {
    anchor: 'battery',
    frame: 'robot',
    pos: [-0.94, -0.28, 0.6],
    posEnd: [-0.66, -0.72, 0.64],
    aim: [0.01, 0, -0.03],
    drift: 16000,
  },
  // Each beat's `glow` is the radius of the marker drawn at its anchor, in scene units. Authored
  // rather than measured off `partMeshes()` because the parts differ by an order of magnitude - the
  // motor's boom bounds a 0.11 unit sphere and the FC board a 0.016 one - and a marker the size of a
  // 16 mm board is not findable on a 0.586 unit aircraft. These four are the size of the part as a
  // viewer sees it: a motor with its boom, the pack, the gimballed lens, the FC board.
  // Every number below is measured off the built arrays over the exact window it describes, and the
  // tile counts are `scene.js`'s own coverage rule run over the same payload (a 1 m tile lights when
  // the drawn camera footprint has crossed its centre). The four windows are contiguous, so the beats
  // are four passages of ONE flight rather than four seeks across it, and the manual handover - which
  // widens the loop to their union - replays that same lane and turn rather than a stitched digest.
  beats: [
    {
      // THE LANE RUNNING. 7.08 m of ground in 2.70 s at a peak 2.66 m/s, altitude held inside 6.001
      // to 6.013 m and roll inside 1.41 deg: the aircraft at survey speed doing nothing but flying.
      // Motor 3 holds 6054 to 6109 rpm at 59.7 to 60.0 percent throttle across it, which is the
      // card's claim running normally, and the other three sit inside the same 6016 to 6154 band -
      // four identical corners, which is the half of the claim the old 0.42 unit close-up could not
      // make. Seven new tiles land under the aircraft while the card is up, from 26 to 33.
      //
      // On the solid aircraft that rpm reads as a blur disc with the blades hidden under it, because
      // two bars turning 103 times a second cannot be drawn at 60 fps; from round 10 the anatomy
      // step's wireframe draws them anyway, turning at a slowed but proportional rate off the same
      // rpm, and the disc recedes to let the drawing be read.
      part: 'm3',
      window: [20.6, 23.3],
      glow: 0.085,
    },
    {
      // THE MIDDLE OF THE SAME LANE, the fastest and flattest passage in the tour: 6.85 m at a peak
      // 2.68 m/s, altitude inside 5.990 to 6.004 m and roll inside 0.51 deg, so the aircraft is doing
      // nothing but carrying itself and covering ground. That is exactly the state the pack card is
      // about - 15.698 to 15.801 V and 13.73 to 14.47 A, the steady draw the later 37 percent current
      // rise is measured against - and the charge gauge scene.js paints on the pack is lit from that
      // same logged voltage, so "voltage and current are logged at 25 Hz" is a thing the shot shows.
      // Seven more tiles land under it, 33 to 40.
      part: 'battery',
      window: [23.3, 25.9],
      glow: 0.06,
    },
    {
      // THE END OF THE LANE, and the beat the surveyed ground exists for. The aircraft runs the last
      // 2.75 m into the lane end and decelerates, the nose coming up to -10.02 deg of pitch, and by
      // the close of this window it has 43 tiles of mapped ground behind it - this lane running the
      // whole length of the frame with the drawn footprint rectangle at the head of it, and the
      // previous lane's strip beyond. Only three of those tiles are laid inside the window - this is
      // the beat where the PRODUCT is on screen rather than the beat where most of it is made - and
      // that is the point: a card that says this camera is what
      // the lawnmower pattern exists to serve is held over the finished pattern. The lens itself is
      // on the far side of the canopy from this bearing and is read through the drawing, which draws
      // it solid inside a transparent airframe.
      part: 'camera',
      window: [25.9, 28.3],
      glow: 0.04,
    },
    {
      // THE TURN ON TO THE NEXT LANE, 3.22 m across at a locked heading (yaw stays inside 0.51 deg
      // end to end), where roll runs -6.53 to 7.30 deg and pitch -5.07 to 0.36 deg. A bank is only
      // legible as one wingtip rising against the other, which is what a wide framing that holds the
      // whole airframe delivers - the one beat the old close shots had to stand outside their own
      // grammar to shoot. It is also the one beat where the aircraft moves ACROSS the trail rather
      // than along it: the finished lane runs the length of the frame and the machine steps off it,
      // which is the clearest single frame in the tour for reading where the aircraft has been.
      part: 'imu',
      window: [28.3, 31.2],
      glow: 0.04,
    },
  ],
};

export default {
  id: 'drone',
  name: 'Survey quadcopter',
  device: 'ESP32 · 4x ESC telemetry · GPS + baro',
  tagline: 'One motor dies mid-survey',
  // Authored volume: 67,516 values across 4 channels, read off the built arrays under node
  // (/att 4501 x 3, /pos 4501 x 3, /motors 4501 x 8, /bat 2251 x 2), not derived from rate x duration.
  context: { system: 'A survey quadcopter streaming per-motor ESC telemetry plus GPS, barometer and attitude at 50 Hz.', mission: 'A 90-second lawnmower pattern at 6 m altitude, fixed waypoints, no operator input.', fault: '2 m of altitude gone mid-leg and 16 degrees off heading. The controller never gets either back, and the mission ends in a failsafe descent. The flight plan never changed.', faultT: 61.2, label: 'altitude dip', datapoints: 67516, channels: 4,
    // The picker card's line: authored short, fault first. See sbr/script.js.
    cardProblem: 'Loses 2 m of altitude and 16 degrees of heading mid-leg.' },
  accent: '#4dd0e1',
  duration,
  rate,
  channels,
  buildData,
  findings,
  // ---- guided flow experience (UX wall port) ----
  // Optional, canned defs only: never part of GENSPEC v1 and never read by the facts builder.
  // Every number quoted below was read off the built arrays under node over the exact window it
  // describes. The anatomy anchors resolve through scene.js's anchors(), so the labels stay on the
  // parts while the aircraft flies.
  experience: {
    anatomy: {
      // THE REDUCED-MOTION FRAME, and it is the only thing these two values are for. A visitor who
      // has asked for less motion gets the tour refused outright (`viewer.js` never schedules
      // `startTour` under `prefersReducedMotion`), so the step is this one instant, this one pose,
      // and all four cards on the overlay at once with their leader lines drawn. It therefore has a
      // different job from the tour's wide shot and is solved separately: the tour needs one card
      // legible at a time and looks nearly straight down the aircraft's own axis, which packs the
      // four anchors together; a still frame needs all four SEPARATED.
      //
      // heroT and this camera are solved together, so moving one means re-solving the other.
      //
      // ROUND 12 RE-SOLVED BOTH, because the round 7 pair was measured against a scene that had no
      // surveyed ground in it. Rendered with the ground the mission actually covers, that pose looked
      // out over the field's +x edge: 0 mapped tiles in frame on the desktop stage and 3 on the phone,
      // so the one frame some visitors ever see of this step was the only one with nothing in it. The
      // pair below comes from a search over 12,168 poses (azimuth every 5 deg, elevation 16 to 40,
      // stand-off 1.00 to 1.65) scored on the live rig at each candidate instant, keeping only poses
      // where all four anchors sit inside 56% of half-frame on BOTH the 1637 x 900 desktop stage and
      // the 355 x 546 phone, with no two anchors closer than 0.10 of NDC, and ranking what is left by
      // how many lit tiles are in frame on the WORSE of the two panels.
      //
      // 1,869 of the 12,168 pass. The best any of them does on tiles is 23, and this pose takes 21 -
      // and it is chosen off the second number, because within two tiles of that maximum it has the
      // widest anchor separation of anything on the board: 0.111 against 0.101 for the 23-tile pose.
      // 29.0 s, mid cross-lane turn, 1.05 units out on a 155 deg world bearing at 40 deg of elevation.
      // 21 tiles on the phone and 36 on the desktop stage - the lane just flown and the one before it,
      // two strips running the length of the picture at different depths, with the aircraft banked off
      // the end of the near one - against 0 and 3 for the old pose, for a worst-pair separation of
      // 0.111 against the old 0.114. That is a 3% loss on the number that decides whether four leader
      // lines are readable, and the difference between a frame that shows a survey and a frame that
      // shows an empty grid.
      heroT: 29,
      camera: { position: { x: -3.726, y: 2.545, z: 1.072 }, target: { x: -2.997, y: 1.87, z: 0.732 } },
      // Not `orbit`. The flow switches the auto-rotate on for that exact string only, so a def that
      // ships a tour declares its own word and the orbit stays off; `viewer.setAnatomy()` reads
      // `def.anatomyTour` and takes the shots from there, falling back to the orbit by itself if
      // the scene cannot answer them.
      rotation: 'tour',
      parts: [
        { id: 'm3', anchor: 'm3', label: 'Motor 3', description: 'One of four brushless motors; each reports rpm and throttle.' },
        { id: 'battery', anchor: 'battery', label: 'Battery', description: 'The 4S pack; voltage and current are logged at 25 Hz.' },
        { id: 'camera', anchor: 'camera', label: 'Survey camera', description: 'The mapping camera the lawnmower pattern exists to serve.' },
        { id: 'imu', anchor: 'imu', label: 'Flight controller', description: 'Closes the attitude loop from roll, pitch and yaw.' },
      ],
    },
    success: {
      // One survey lane flown edge to edge: the second pass runs 18.6 s to 27.7 s (6.0 s of climb
      // and hold, a 9.1 s lane, a 3.5 s turn, then this lane), x from 10.05 m to -9.98 m across a
      // 20 m field. Nothing is wrong yet: the bearing wear starts at 32 s and the dip at 61.2 s.
      // Measured over the window: alt 5.980 to 6.013 m, all four throttles 59.4 to 60.9 percent
      // (0.92 points apart at worst), yaw -0.80 to 0.91 deg. The three labels below quote those.
      window: [18.6, 27.7],
      camera: null, // the existing cameraFocus follow already rides with the aircraft
      loopLabel: 'One full survey lane',
      // ROUND 11. The context beat shows the real world: a survey-class quadcopter actually flying,
      // not this synthesized flight. The note says which of the two it is. Everything else in this
      // block stays as the fallback the step runs if the media does not arrive (`core/flow.js`).
      footage: {
        src: new URL('../../../media/flow-drone.mp4', import.meta.url).href,
        poster: new URL('../../../media/flow-drone-poster.jpg', import.meta.url).href,
        note: 'A survey-class quadcopter in flight. Not the logged flight.',
      },
      // Terse label, one sentence of evidence, in the register the wall's success rail uses. The
      // three are deliberately the three quantities the failure step then breaks: altitude dips,
      // throttle rails on motor 3, heading swings 18 degrees.
      contextualLabels: [
        { label: 'Holding 6 m', note: 'Altitude stays inside a few centimetres of the survey setpoint.' },
        { label: 'Four motors even', note: 'Throttle sits near 60 percent on all four, inside one point of each other.' },
        { label: 'On heading', note: 'Yaw stays inside one degree across the pass.' },
      ],
    },
    failure: {
      findingId: 'dip', // findings[0]: alert, chart window [58, 66], replay loop [60.7, 62.9], highlight m3
      camera: null, // the finding's own highlight plus the follow shot; no separate framing
      plottedFields: { channel: '/pos', fields: ['alt'] }, // mirrors findings.dip.focus
    },
  },
  // Read by `viewer.setAnatomy()` off the def rather than out of the parts array: it is one spec
  // for the whole step, and the flow hands the viewer only the parts.
  anatomyTour: ANATOMY_TOUR,
  // The anatomy step's display model (`viewer.js`, "anatomy display model"): this same aircraft, opened
  // as the solid machine every other step draws and then dissolved into a transparent feature-edge
  // drawing with the live card's part solid inside it. Three of these four cards name something the
  // hull hides from the tour's own bearing - the pack under the lower plate, the FC board in the deck's
  // rear-left corner, the gimbal behind the canopy - which is the case the drawing exists for.
  //
  // ONE DYNAMIC IMPORT, so a step's worth of code is fetched by the visitors who reach the step and by
  // nobody else, and so `core/anatomy-wireframe.js` stays out of every mission's eager graph. Allowed
  // to fail: a rejection or a null leaves the step exactly as round 8 shipped it, solid aircraft,
  // working tour, anchored halo. `drone-craft` is the named subtree that IS the aircraft - the field
  // dress, the flown track and the ground footprint are not drawn.
  anatomyModel: (THREE, mount) =>
    import('../../core/anatomy-wireframe.js').then((m) =>
      m.installWireframe(THREE, mount, { robot: 'drone-craft' }),
    ),
  firstQuestion: 'What went wrong on the survey flight?',
  suggested: [
    'Show me exactly where it failed',
    'What caused the motor to fail?',
    'Is the battery a factor?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'why-failed',
      matchers: ['wrong', 'went', 'survey', 'flight', 'happen', 'why', 'fail', 'problem', 'issue', 'mission'],
      answer: `Motor 3's bearing let go. The controller covered for it from 38 s and ran out of throttle at **61.2 s**.

| metric | value |
| --- | --- |
| pwm3 | 100% railed (others ~60%) |
| rpm3 | 5,270 → 2,630 |
| altitude | dipped 6.0 → 3.9 m |
| yaw | -18 deg off the lane |

Nothing hit the ground: 92% of the survey was already flown.

{{ev:dip}}`,
      chatCausal: "Motor 3's rpm halved while pwm3 railed, so the aircraft lost 2.1 m and yawed 18 deg before the failsafe descent.",
      evidence: ['dip'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'show me', 'where', 'see', 'replay', 'watch', 'exactly', 'moment', 'look'],
      answer: `Looping the two seconds around the break, motor 3 lit. Watch its disc slow while the other three spin up, then the 2.1 m drop and the 18 deg heading swing.

{{ev:dip}}`,
      evidence: ['dip'],
    },
    {
      id: 'root-cause',
      matchers: ['cause', 'root', 'motor', 'motor 3', 'bearing', 'fix', 'rpm', 'pwm', 'throttle', 'diverg', 'm3', 'prop', 'esc'],
      answer: `Same rpm, more throttle. That gap is the whole diagnosis.

| t | pwm3 vs others |
| --- | --- |
| 38 s | 62.5% vs 60.1% |
| 55 s | 90.2% vs 59.9% |
| 61 s | **100% vs 63.5%** |

Altitude and attitude looked clean the whole time; the wear was hidden in throttle. Fix: new bell bearings, plus an alert when any motor sits 8 points above the fleet median for 5 s. Here that fires at **48.8 s**, 12 seconds before it lost a metre.

{{ev:motor-wear}}`,
      evidence: ['motor-wear', 'dip'],
    },
    {
      id: 'battery',
      matchers: ['battery', 'bat', 'pack', 'volt', 'power', 'sag', 'cell', 'charge', 'health', 'current', 'amp'],
      answer: `The pack is healthy; it is reporting the motor. Mean current rose **37%** at 40 s on the same lanes at the same speed, because a binding bearing is a heater. Lowest cell was 3.25 V under load. Alone, \`/bat\` looks like a tired pack; crossed with \`/motors\` it is one motor eating the difference.

{{ev:battery}}`,
      evidence: ['battery'],
    },
    {
      id: 'landing',
      matchers: ['land', 'crash', 'safe', 'failsafe', 'descend', 'descent', 'damage', 'survive', 'recover', 'end'],
      answer: `No, a controlled failsafe descent: down at 70.0 s, touched at **77.7 s**, peak 0.86 m/s. It drifted 3.4 m downrange and kept a -9.7 deg heading error, which is what losing a whole motor's yaw authority looks like.`,
      evidence: [],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'instrument', 'stream'],
      answer: `One call per control cycle. \`log()\` is a non-blocking memcpy; the uploader runs on the other core.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("motors", "pwm3", "%", 0, 100, "motor 3 mixer output");
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/drone");
}

void logCycle() {   // right after your mixer, 50 Hz
  alloy.log("att").set("roll", ahrs.roll).set("yaw", ahrs.yaw);
  alloy.log("motors")
       .set("rpm3", esc[2].rpm).set("pwm3", mix[2]);
  alloy.log("bat").set("v", pack.volts).set("a", pack.amps);
}

void onDisarm() { alloy.end(); }
\`\`\`

Every number on this page came from calls like those. Free tier covers a vehicle this size.`,
      evidence: [],
    },
  ],
  buildScene,
};
