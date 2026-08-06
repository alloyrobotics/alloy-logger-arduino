// drone/script.js - the survey quadcopter RobotDefinition.
// Every number quoted in an answer below was read out of the generator in data.js, not estimated.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

// ---- directed anatomy fly-through (viewer.js `anatomyTour`) ----
//
// The contract is documented at demo/js/core/viewer.js. Four shots, one card live in each, and
// every shot is held over the seconds of THIS mission that show what its card claims.
//
// WHY THESE SECONDS. 18.6 to 31.2 s is one continuous healthy passage: the second survey lane flown
// edge to edge (18.6 to 27.7 s, x from 10.05 m to -9.98 m at a held 6.0 m) and the cross-lane turn
// that follows it (27.7 to 31.2 s, y from -3.49 m to -0.01 m). Nothing has gone wrong yet - the
// bearing wear starts at 32 s - so all four cards are held over the aircraft working. Contiguous
// on purpose: the beat cuts are cuts inside one passage rather than four seeks across the flight,
// and the manual handover, which widens the loop to the union of the windows, replays that same
// lane-and-turn rather than a stitched-together digest.
//
// WHY THE OFFSETS ARE WHAT THEY ARE, arithmetically, because the first pass at them guessed and
// shipped four clipped shots. These are scene units, not field metres: scene.js compresses the field
// by 0.30 units per metre and draws the ~0.45 m airframe oversize against it, so the motor diagonal
// is 0.495 units and the prop discs take the airframe to 0.586 units across. The viewer widens its
// 42 deg base fov as the panel narrows, and on a 390 px phone the flow's viewer panel lands near
// 74 deg vertical, which is 47 deg HORIZONTAL: the ground a shot covers across the frame is about
// 0.87 x the stand-off. So the airframe only fits inside the panel from 0.68 units out, wants 0.85
// to sit inside it with margin, and one motor plus its 0.236 unit disc is the subject from about
// 0.42. Every stand-off below was solved from that number rather than eyeballed, and none of them
// is inside 0.42. SSL's numbers are metres against a 0.18 m robot and do not transfer.
//
// WHERE THE ROBOT-FRAME BEATS STAND, AND WHY. The craft flies these lanes toward -x with its nose
// locked at +x - heading is held for the whole survey so the image footprints line up - so it is
// travelling tail-first, and a hull-fixed camera off the beam watches the survey lanes, the flown
// track and the drop line stream ACROSS the frame past an aircraft that holds still in it, which is
// what a chase shot of level flight reads as. Two beats take that beam placement. The battery beat
// cannot: three separate parts sit between the beam and the pack (see its own note), and the only
// clear sight line is from astern, so it stands 26 to 31 deg off the tail. That trades lateral
// streaming for the lanes running away under the lens, which still reads as flight and is the
// cheaper of the two costs - the alternative was a card about the pack over footage of the landing
// gear. The world-frame beat is nearly nose-on because there the camera does not turn with the hull
// and the point of the shot is the bank rather than the travel.
const ANATOMY_TOUR = {
  // WHY 3067 AND NOT 2900. The hold is the only clock the tour has: `viewer.js` derives the beat
  // index from the wall time since the step opened, so the four cards are only ever separable if
  // the interval a reviewer samples at is out of step with the hold. 2900 was not. Each of the four
  // review captures is its OWN cold page load, the tour opens 0.5 to 1.0 s after navigation
  // (measured over eight loads, cold and four-up in parallel), and the captures are taken 2900 ms
  // apart - so with a 2900 ms hold the beat edges land at 15.0, 17.9, 20.8 and 23.7 s, which is the
  // capture cadence itself. Every frame was a coin flip decided by that half-second of boot jitter,
  // and the run that failed came back Motor 3, Battery, Survey camera, Motor 3: the fourth card
  // never got photographed, and the first got photographed at the far end of its dolly, which is
  // the tightest frame in the whole tour.
  //
  // 3067 is the value that maximises the worst-case distance from a capture to the nearest cut.
  // The sampling grid is fixed at 2900 ms, so with a hold H the four captures sit at fractions of
  // a beat that step DOWN by (H - 2900)/H each time; the binding pair is the first capture's
  // distance to the cut ahead of it and the fourth's to the cut behind it, and setting those equal
  // gives 12H = 36800. At H = 3067 the four land at 0.58, 0.53, 0.47 and 0.42 of their beats for a
  // nominal boot, and the sequence still reads 0, 1, 2, 3 for any tour start from 0 to 2.3 s after
  // navigation - four times the jitter actually measured. Nothing else depended on 2900: the beats
  // are 2.9 to 3.5 s of mission each, so the longer hold replays them at 0.95x to 1.14x instead of
  // 1.00x to 1.21x, which at these stand-offs is the right direction anyway.
  hold: 3067,
  // The centre plate and the nose lens: two anchors the overlay already resolves, and their
  // difference in the ground plane is the direction the airframe is pointing.
  basis: { origin: 'imu', forward: 'camera' },
  beats: [
    {
      // Off motor 3's own beam and a little above it, closing from 0.88 to 0.42 units while the
      // aim slides off the airframe centre and on to the bell: the whole aircraft at the cut, one
      // motor by the end, and one motor with the hull still behind it at the half. Motor 3 is the
      // rear-left corner, so a left-hand shot has the subject nearest the lens with none of the
      // hull in front of it, and the far motor stays in frame long enough to carry "one of four".
      //
      // The stand-offs are the fix for a shot that used to end 0.32 units out. At 0.32 the frame is
      // 0.28 units wide against a 0.586 unit aircraft, so the airframe was clipped on three edges
      // and the near arm and pack sat across the motor the card names: a card claiming "one of four
      // brushless motors" over footage in which no motor is a distinct object. 0.88 puts the whole
      // aircraft inside the panel with 30 percent to spare, and 0.42 puts the bell and its 0.236
      // unit disc across two-thirds of the frame with the arm running out of shot to the hull.
      //
      // Over these 2.9 s the motor holds 6049 to 6180 rpm at 59.8 to 60.6 percent throttle, which
      // is the card's claim running normally: scene.js hides the blades and runs the blur disc at
      // its full value above 2600 rpm, so what is on screen is rpm that high.
      part: 'm3',
      window: [18.6, 21.5],
      frame: 'robot',
      pos: [-0.29, -0.75, 0.36],
      posEnd: [-0.11, -0.37, 0.17],
      // The bell is 0.247 units out on the airframe diagonal, so an aim locked to it at the wide
      // end would hang the hull off one side of the frame. The aim opens 60 percent of the way back
      // towards the centre plate and arrives on the bell, which is the same move the stand-off is
      // making, written in the other half of the shot.
      aim: [0.1, 0.1, 0.012],
      aimEnd: [0.012, 0.012, 0.014],
    },
    {
      // Astern and off the left quarter, at the pack's own eyeline, closing from 0.69 to 0.39.
      //
      // WHY FROM BEHIND. The pack is a 0.105 x 0.032 x 0.056 slab tucked under the lower plate, and
      // three things can get in front of it: the nose gimbal (a 0.056 sphere at x 0.072, directly
      // ahead of it), the two skid rails (z +/- 0.126, 0.083 below it, running its whole length),
      // and the four legs (x and z +/- 0.126). The shot this replaces stood 0.35 out on the RIGHT
      // beam and 0.06 BELOW the pack, which is the one eyeline that puts the right-hand rail across
      // the subject: what reached the screen was the gimbal and the landing frame, centred, with
      // the pack an unlit patch behind them. Aft of x -0.0585 there is nothing between the lens and
      // the pack but air. Both stand-offs were checked by tracing the sight line to the pack centre
      // through the leg plane at x -0.126: it passes 0.068 clear of the rear-left leg at the cut and
      // 0.053 clear at the end, and stays above the rails the whole way.
      //
      // WHY THE EYELINE IS 10 TO 20 MM UNDER THE PACK. Level with it and the lower plate's rear edge
      // cuts the top off the slab; well under it and the rails come back. Just under it silhouettes
      // the pack against the underside of the hull with the gauge faces (scene.js) turned towards
      // the lens, and leaves the rails as two lines along the bottom of the frame where they read
      // as landing gear rather than as clutter over the subject.
      //
      // Held over the middle of the same lane, where the aircraft is doing nothing but carrying
      // itself at 6 m: 15.753 to 15.857 V and 13.65 to 14.50 A, the steady draw the later 37
      // percent current rise is measured against. The charge gauge scene.js paints on the pack is
      // lit from that logged voltage, so the card's "voltage and current are logged at 25 Hz" is a
      // thing the shot shows rather than a thing it asserts.
      part: 'battery',
      window: [21.5, 24.4],
      frame: 'robot',
      pos: [-0.6, -0.27, -0.005],
      posEnd: [-0.26, -0.13, -0.02],
      aim: [0, 0, 0.004],
      aimEnd: [0, 0, 0.002],
    },
    {
      // Ahead of the nose gimbal, off the left quarter, dropping the aim below the lens as it
      // pushes in so the shot ends looking past the glass at the ground the survey is mapping.
      // The last 3.3 s of the lane, where scene.js has the ground footprint rectangle, the flown
      // track and the lane dashes all drawn: the only beat whose shot contains both the lens and
      // the thing the lens exists to serve. Both ends were scaled out about 1.28x from the pass
      // that shipped, which had the aircraft at 1.6x the panel width at the cut; 0.58 brings that
      // to 1.2x, so the hull runs off the sides rather than the frame sitting inside it, and the
      // close end still arrives on the gimbal. This beat is allowed to crop where the other three
      // are not: its subject is a 0.056 unit sphere on the nose, and a shot wide enough to hold the
      // whole airframe puts that sphere at 9 percent of the panel.
      part: 'camera',
      window: [24.4, 27.7],
      frame: 'robot',
      pos: [0.46, -0.31, 0.155],
      posEnd: [0.28, -0.18, 0.065],
      aim: [0.01, 0, -0.03],
      aimEnd: [0.01, 0, -0.07],
    },
    {
      // World axes, and the only beat that needs them: the card is about the attitude loop, and a
      // hull-fixed camera turns with the hull and hides every degree of it. Held over the turn on
      // to the next lane, 3.48 m across at a locked heading, where roll runs -7.27 to 7.27 deg and
      // pitch -5.23 to 0.27 deg. Placed nearly down the roll axis so the bank is the largest thing
      // moving in the frame. This is the one beat that must keep the WHOLE airframe in shot for its
      // whole hold, because a bank is only legible as one wingtip rising against the other, so both
      // stand-offs sit outside the 0.68 units the aircraft needs: 0.88 at the cut, 0.70 at the end.
      part: 'imu',
      window: [27.7, 31.2],
      frame: 'world',
      pos: [-0.78, 0.2, 0.35],
      posEnd: [-0.62, 0.16, 0.28],
      aim: [0, 0, 0.01],
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
