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
// WHY THESE SECONDS. 18.6 to 31.2 s is one continuous healthy passage: the second survey lane flown
// edge to edge (18.6 to 27.7 s, x from 10.05 m to -9.98 m at a held 6.0 m) and the cross-lane turn
// that follows it (27.7 to 31.2 s, y from -3.49 m to -0.01 m). Nothing has gone wrong yet - the
// bearing wear starts at 32 s - so all four cards are held over the aircraft working. Contiguous on
// purpose: the beats are four passages of one flight rather than four seeks across it, and the
// manual handover, which widens the loop to the union of the windows, replays that same lane and
// turn rather than a stitched-together digest.
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
  // mass, aimed 0.02 units above and 0.01 ahead of it: the hull centre.
  //
  // HOW FAR OUT, arithmetically, in scene units and not field metres - scene.js compresses the field
  // by 0.30 units per metre and draws the ~0.45 m airframe oversize against it, so the motor diagonal
  // is 0.495 units and the prop discs take the aircraft to 0.586 units across. `viewer.js` holds a
  // 42 deg base vertical fov and widens it as the panel narrows: the flow's stage measures 1637 x 900
  // at a 1440 px desktop (aspect 1.8, so 46 deg) and about 355 x 546 on a 390 px phone (70 deg). The
  // frame is therefore 1.53x the stand-off wide on the desktop and 0.92x on the phone. At 1.08 units
  // the 0.586 unit aircraft is 36 per cent of the desktop frame's width and 59 per cent of the
  // phone's - the whole machine, props included, inside both panels with room for the corner cards.
  // The old close beats needed 0.68 units just to fit the airframe, so this sits comfortably outside
  // the size at which anything is cropped.
  //
  // WHERE IT STANDS. Between the rear-left quarter and the front-left quarter, and the SPAN is the
  // point. `cameraHome` stands rear-left, and the two parts on the rear-left corner - motor 3 and
  // round 7's FC board on the deck - read best from there; the nose gimbal and its survey lens are on
  // the opposite corner and are behind the canopy from that bearing. One fixed bearing therefore has
  // to lose one of them, so the drift crosses between the two instead: 60 degrees of azimuth, from
  // 45 deg behind the beam to 15 deg ahead of it, and back. `frame: 'robot'` bolts that arc to the
  // airframe - the survey holds heading to within a degree for this whole passage, so it is a fixed
  // arc in practice, and it stays on the aircraft's left through the cross-lane turn rather than
  // walking round to the nose.
  //
  // THE DRIFT eases those 60 degrees and 4 degrees of elevation and back on a raised cosine over 16 s,
  // at a constant 1.08 unit radius: 3.7 deg a second, which is a shot that breathes rather than an
  // orbit, and it never cuts. 16 s against a 12.4 s tour cycle so the two clocks do not lock and no
  // card is permanently the one shot from the far end of the arc.
  //
  // ELEVATION 26 TO 30 DEG, and the top of that range is what the first pass got wrong. At 20 deg the
  // horizon sits a quarter of the way down a desktop panel and that quarter is the flat background
  // above the boarding - measured on the live page. At 26 deg the top of the frame is 3 deg above
  // horizontal, so the band is a sliver and the rest is field and machine. It is not steeper than
  // that because the pack hangs UNDER the lower plate: the plate's overhang shades the pack's upper
  // 19 mm at 22 deg and progressively more above it, and the pack is one of the four cards.
  wide: {
    anchor: 'battery',
    frame: 'robot',
    pos: [-0.69, -0.69, 0.47],
    posEnd: [0.24, -0.9, 0.54],
    aim: [0.01, 0, 0.02],
    drift: 16000,
  },
  // Each beat's `glow` is the radius of the marker drawn at its anchor, in scene units. Authored
  // rather than measured off `partMeshes()` because the parts differ by an order of magnitude - the
  // motor's boom bounds a 0.11 unit sphere and the FC board a 0.016 one - and a marker the size of a
  // 16 mm board is not findable on a 0.586 unit aircraft. These four are the size of the part as a
  // viewer sees it: a motor with its boom, the pack, the gimballed lens, the FC board.
  beats: [
    {
      // Motor 3 holds 6049 to 6180 rpm at 59.8 to 60.6 percent throttle over these 2.9 s, which is
      // the card's claim running normally: scene.js hides the blades and runs the blur disc at its
      // full value above 2600 rpm, so what is on screen is rpm that high. The lit arm, bell, cap and
      // accent ring are one of four identical corners, which is the other half of the claim and the
      // half the old 0.42 unit close-up could not make.
      part: 'm3',
      window: [18.6, 21.5],
      glow: 0.085,
    },
    {
      // The middle of the same lane, where the aircraft is doing nothing but carrying itself at 6 m:
      // 15.753 to 15.857 V and 13.65 to 14.50 A, the steady draw the later 37 percent current rise is
      // measured against. The charge gauge scene.js paints on the pack is lit from that logged
      // voltage, so "voltage and current are logged at 25 Hz" is a thing the shot shows.
      part: 'battery',
      window: [21.5, 24.4],
      glow: 0.06,
    },
    {
      // The last 3.3 s of the lane, where scene.js has the ground footprint rectangle, the flown
      // track and the lane dashes all drawn: the passage in which the lens and the thing the lens
      // exists to serve are both on screen.
      part: 'camera',
      window: [24.4, 27.7],
      glow: 0.04,
    },
    {
      // The turn on to the next lane, 3.48 m across at a locked heading, where roll runs -7.27 to
      // 7.27 deg and pitch -5.23 to 0.27 deg. A bank is only legible as one wingtip rising against
      // the other, which is exactly what a wide framing that holds the whole airframe delivers - the
      // one beat the old close shots had to stand outside their own grammar to shoot.
      part: 'imu',
      window: [27.7, 31.2],
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
      // heroT and this camera are solved together, so moving one means re-solving the other. At
      // 30 s the craft sits at world (-2.99, 1.925, 0.293); this shot stands 1.05 units out on the
      // front-left quarter, 20 degrees up. Measured against the viewer's own fov curve, the
      // airframe covers 33% of the width and 34% of the height on a wide desktop panel and stays
      // inside the frame down to a portrait phone panel, which leaves the four corner label slots
      // clear. Front-left keeps the nose lens unobstructed and motor 3 on the near side, and the
      // elevation is high enough to read the X frame. A search over the surrounding poses gained
      // under 7% of anchor separation, so the framing is a considered choice, not an arbitrary one.
      heroT: 30,
      camera: { position: { x: -2.549, y: 2.282, z: -0.589 }, target: { x: -2.99, y: 1.925, z: 0.293 } },
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
