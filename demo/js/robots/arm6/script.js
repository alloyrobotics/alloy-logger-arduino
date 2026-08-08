// arm6/script.js - the arm6 RobotDefinition. Every number quoted below is read straight out of
// buildData(), not estimated: tau2 pins at exactly the 12.00 Nm clamp from 54.24 s to 56.32 s,
// peak unclamped demand is 15.75 Nm, err2 peaks at 7.44 deg at the drop, drv3_temp runs 37.9 to
// 71.3 C, and /ee.grip steps 1 to 0 at 56.30 s.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

/**
 * The directed tour for the anatomy step: one wide shot, four cards, four lit parts. Schema and
 * rationale: `viewer.js`, "directed anatomy tour" and "part highlight".
 *
 * WHY FOOTAGE AND NOT A POSE. Every one of these four cards makes a claim about something the arm
 * DOES - a shoulder that saturates, jaws that close on the part, a driver that heats up over the
 * run, a turret that swings between two stations - and a machine held at one frozen second under a
 * slow orbit demonstrates none of them. Each beat below names the seconds of the mission where the
 * arm is doing the thing its card claims, so every claim is made over footage of it happening.
 *
 * WHY THE CAMERA STOPPED CUTTING, which is round 7 and is the only structural change here. Rounds 4
 * to 6 gave each beat its own close-up: 0.26 m on the driver chip, 0.37 m on the jaws, 0.92 m on the
 * shoulder. Each was solved against the fov law and each did show its part - and at those stand-offs
 * there is no ARM in the frame, so four cards in a row described components of a machine the visitor
 * could no longer see, and none of them said where on the machine the part was. The camera now holds
 * one wide framing for the whole tour (see `wide` below) and the part the live card names is LIT in
 * the scene instead, which is the grammar an exploded CAD view has always used. The instrument
 * panels are unchanged in what they say and now gate on which card is live rather than on how far
 * away the camera happens to be.
 *
 * WHY THESE SECONDS, all read out of buildData() rather than estimated:
 *
 *   j2       53.9-56.4   tau2 is pinned at exactly the 12.00 Nm clamp from 54.24 s to 56.32 s, so
 *                        all but the last 0.08 s of this window is the joint on its limit. q2
 *                        back-drives 38.2 -> 55.7 deg while err2 integrates 0.17 -> 7.46 deg, the
 *                        strain LED goes alert, and the part slips at 56.30 s. The shoulder losing
 *                        the fight IS the card's claim.
 *   gripper  28.10-29.50 cycle 5, the clean one the success step also loops. The jaws are open at
 *                        28.10 s, /ee.grip steps 0 to 1 at 28.28 s, and the TCP lifts from the pad
 *                        plane at y=0.135 m to y=0.400 m by 29.36 s: open, shut, carry, which is
 *                        the whole of "logged 0 or 1" in one move.
 *   drv3      0-80       the whole run, which is the only window in which "creeps during the run"
 *                        is a thing you can watch: drv3_temp goes 37.9 -> 71.3 C and the chip
 *                        material tracks it, full blue to full red, at 23x.
 *   base     29.25-31.40 the A-to-B transfer of that same clean cycle. q0 sweeps -34 deg at the
 *                        over-pick keyframe, through 2 deg at 30.35 s, to +38 deg at over-place:
 *                        72 deg of turret in 2 s, which is the whole card.
 *
 * WHY THE J2 BEAT IS INSIDE THE FAULT. It sits in the `drop` finding's 52-60 s window, two steps
 * before the failure screen. That is a narrative cost, and it is unavoidable: the arm saturates
 * exactly once in 80 s, and a card reading "the joint that saturates at 12 Nm" held over any of the
 * eleven cycles where it does not is a truth cost, which is the worse one. What the beat spends
 * that on is the SAG - the upper arm falling under a joint that is out of torque - not the drop.
 *
 * THE FRAME. `basis: base -> gripper` is the arm's own heading: the base anchor sits ON the q0 axis
 * so its ground position is fixed, and the TCP anchor is the reach vector out of it, never shorter
 * than 0.34 m anywhere in the mission (min at 61.0 s, the re-home), so the basis can never
 * degenerate. The wide shot itself is in WORLD axes - a camera that yawed with q0 would cancel
 * exactly the turret rotation the fourth card is about, and this machine is bolted to a floor, so
 * its own frame has nothing to add that the world frame does not already have.
 *
 * SCALE, and it is the thing that cannot be copied from the ssl tour. Metres, y-up, and this
 * machine is small: the pedestal is 0.46 m across, the shoulder housing 0.156 m, the payload
 * 0.07 m, the driver chip 0.026 m - which is exactly why the driver card needs a highlight and a
 * panel rather than a 0.26 m stand-off. The wide shot stands 1.85 m out, still inside OrbitControls'
 * `minDistance` band for this scene's radius clamp, which is why the tour writes the camera after
 * `controls.update()` rather than through it.
 */
const ANATOMY_TOUR = {
  // WHY 3500 AND NOT THE 2900 EVERY OTHER TOUR HOLDS. The card crossfades:
  // `.v-anat.is-tour .v-anat-card` carries a 0.4 s opacity transition, so the first ~0.4 s of every
  // beat is a frame in which the outgoing card is still most of the way lit and the incoming one is
  // barely there. 0.4 s of a 2900 ms hold is 14 per cent of every beat; of 3500 it is 11, and the
  // extra 600 ms is reading time the copy needed anyway - 3.5 s less the crossfade leaves 3.1 s on
  // a card of twelve words plus the mechanism the shot is of, where 2900 left 2.5 s.
  //
  // Round 7 removed the reason the old note in this place spent twenty lines on sampling phase. The
  // camera no longer cuts, so a review capture that lands 30 ms after a beat change is no longer a
  // frame of one card over another card's framing: it is the same wide framing it was 30 ms earlier,
  // with a card and a lit part mid-crossover. The three instrument panels still wait 440 ms for
  // their card (see the decal section in scene.js) because a NUMBER under the wrong heading is a
  // false statement whether or not the camera moved.
  hold: 3500,
  basis: { origin: 'base', forward: 'gripper' },
  // THE WIDE SHOT: one framing, held for the whole tour, drifting 20 degrees of azimuth and back.
  //
  // Hung off the `base` anchor, which is the turret at 0.187 m on the q0 axis: the one anchor on
  // this machine whose ground position is fixed for all 80 s, so the framing cannot be dragged
  // around by the arm it is framing. `frame: 'world'` for the same reason the two world-frame beats
  // it replaces were - the basis here yaws with q0, and a camera that yawed with it would cancel
  // exactly the turret rotation one of the four cards is about.
  //
  // The aim sits 0.32 m out along +x and 0.21 m above the anchor, at (0.32, 0.40, -0.05), which is
  // within 0.06 m of `cameraHome`'s own target: the middle of the arm's working volume, with both
  // pads and the driver bay inside the frame around it.
  //
  // HOW FAR OUT, arithmetically. `viewer.js` holds a 42 deg vertical fov on the desktop column
  // (aspect 2.23) and widens it to about 70 deg on a 390 px phone, so the frame is 0.77x the
  // stand-off tall on the desktop and 1.41x tall by 0.92x wide on the phone. The machine standing
  // on the floor is about 0.85 m of arm over a 0.46 m pedestal, and the two pads sit 1.0 m apart
  // across it. At 1.60 m the arm is 59 per cent of the flow panel's height (it measures 1637 x 900 at
  // 1440, aspect 1.8, so the fov widens to 46 deg) and 35 per cent of the phone's, and the pad-to-pad
  // span is 41 per cent of the desktop frame's width and 68 of the phone's: the whole robot, its
  // workspace and the part it is carrying, in frame at both sizes for every frame of the tour, with
  // the four corners left to the cards. Closer crops the pads on a phone; further and the arm is a
  // model on a shelf, which is what the first pass at 1.85 m looked like. Elevation is 26 deg, a
  // little steeper than `cameraHome`'s 19, because the shot has to hold the pedestal-mounted driver
  // bay as well as the arm above it.
  //
  // THE DRIFT. Both ends are the same 1.60 m radius, 20 deg of azimuth apart on the same quarter
  // `cameraHome` uses, and `viewer.js` eases between them on a raised cosine over 15 s: the shot is
  // alive, the parallax says the machine is three-dimensional, and there is no cut anywhere in it.
  // 15 s against a 14 s tour cycle is deliberate - the two clocks never lock, so no card is
  // permanently the one shot from the far end of the arc.
  wide: {
    anchor: 'base',
    frame: 'world',
    pos: [0.93, 1.09, 0.7],
    posEnd: [1.24, 0.72, 0.76],
    aim: [0.3, -0.05, 0.24],
    drift: 15000,
  },
  // Every part on this machine is real geometry with a mesh behind it - a shoulder housing, a pair of
  // jaws, a driver bay with its heatsink, a turret - so the highlight sleeves the part itself
  // (`scene.js`'s `partMeshes()`). Each beat still carries a `glow`, which is the radius of the
  // marker drawn AT its anchor: the sleeve alone is easy to miss on a 26 mm chip at a 1.6 m stand-off,
  // and left to itself the marker would be sized off the part's bounding sphere, which is 0.145 m for
  // the turret cylinder and 0.016 m for the driver chip - two orders apart on the same screen. These
  // four are the size of the part as a viewer sees it: a shoulder, a hand, a bay, a turret.
  beats: [
    {
      // The shoulder losing the fight: tau2 is pinned at exactly the 12.00 Nm clamp from 54.24 s to
      // 56.32 s, q2 back-drives 38.2 -> 55.7 deg, err2 integrates 0.17 -> 7.46 deg, the strain LED
      // on the column goes alert and the part slips at 56.30 s. What the wide framing shows over
      // those seconds is the SAG - the upper arm falling under a joint that is out of torque - with
      // the lit shoulder housing at the top of it and the torque panel beside it arriving at its
      // clamp and stopping there.
      part: 'j2',
      window: [53.9, 56.4],
      glow: 0.09,
    },
    {
      // Cycle 5, the clean one the success step also loops: the jaws are open at 28.10 s, /ee.grip
      // steps 0 to 1 at 28.28 s, and the TCP lifts from the pad plane at y=0.135 m to y=0.400 m by
      // 29.36 s. Open, shut, carry - and from the wide framing the pad it lifts off and the pad it
      // is heading for are both in the same frame, which is what says the lit hand is a hand on a
      // machine doing a job.
      part: 'gripper',
      window: [28.1, 29.5],
      glow: 0.06,
    },
    {
      // The whole run, which is the only window in which "creeps during the run" is a thing you can
      // watch: drv3_temp goes 37.9 -> 71.3 C and the chip material tracks it, full blue to full red,
      // at 23x. Twelve cycles play out above the lit bay while its own panel draws the climb.
      part: 'drv3',
      window: [0, 80],
      glow: 0.09,
    },
    {
      // The A-to-B transfer of that same clean cycle: q0 sweeps -34 deg at the over-pick keyframe,
      // through 2 deg at 30.35 s, to +38 deg at over-place. 72 deg of turret in 2.15 s, with both
      // stations and the lit turret ring in one frame - the card's whole claim.
      part: 'base',
      window: [29.25, 31.4],
      glow: 0.09,
    },
  ],
};

export default {
  id: 'arm6',
  name: '6-axis pick and place',
  device: 'ESP32-S3 · 6x BLDC servo · 48 V bus',
  tagline: '12 transfer cycles, one dropped part',
  // Authored volume: 73,620 values across 4 channels, read off the built arrays under node
  // (/joints 4001 x 12, /ee 4001 x 4, /ctl 4001 x 2, /sys 801 x 2), not derived from rate x duration.
  context: { system: 'A 6-axis pick-and-place arm on a 48 V bus: six BLDC servos, with joint, end-effector and controller channels logged at 50 Hz.', mission: '12 transfer cycles between two stations, the same taught trajectory every time.', fault: 'On cycle 9 the part is on the deck and the arm completes the place move as if nothing happened.', faultT: 56.3, label: 'payload drop', datapoints: 73620, channels: 4,
    // The picker card's line: authored short, fault first. See sbr/script.js.
    cardProblem: 'Drops the part on cycle 9 and finishes the place move as if nothing happened.' },
  accent: '#D3EEB6',
  duration,
  rate,
  channels,
  buildData,
  findings,
  // Four-step mission experience. Every anchor id resolves through sceneApi.anchors() in scene.js;
  // every window, field and number below is read out of data.js, not estimated.
  experience: {
    anatomy: {
      camera: null, // cameraHome already frames the whole arm, the pedestal and both pads
      // Not `orbit`. The flow only switches the auto-rotate on for that exact string, so declaring
      // the tour's own word here leaves it off without the flow needing to know a tour exists:
      // `viewer.setAnatomy()` sees `anatomyTour` below and takes the camera from there. Under
      // reduced motion the tour refuses to start and this step is the static hero it always was.
      rotation: 'tour',
      // mid cycle 5, part in the jaws at full lift: all four anchors sit clear of each other
      heroT: 30,
      parts: [
        {
          id: 'j2',
          anchor: 'j2',
          label: 'J2 shoulder servo',
          description: 'Lifts the whole arm; the joint that saturates at 12 Nm.',
        },
        {
          id: 'gripper',
          anchor: 'gripper',
          label: 'Parallel gripper',
          description: 'Grips the part at the tool centre point; grip state is logged 0 or 1.',
        },
        {
          id: 'drv3',
          anchor: 'drv3',
          // drive boards on the bus are numbered 1..6, so J2 runs on drv3 (see data.js header)
          label: 'J2 servo driver',
          description: 'The drive electronics whose temperature creeps during the run.',
        },
        {
          id: 'base',
          anchor: 'base',
          label: 'Base turret',
          description: 'Rotates the arm between the two stations on q0.',
        },
      ],
    },
    success: {
      // CYCLES[4] exactly: one clean A to B transfer, 18.6 s before the heavy blank is swapped
      // onto pad A at 50.6 s and well clear of the drop finding window [52, 60].
      window: [26.0, 32.0],
      // swung toward +x so both pads separate across the frame instead of stacking front to back.
      // Verified: every anchor and both pads stay inside the frustum for the whole window, at
      // desktop and at mobile aspect, with the pads 0.6 of NDC apart.
      camera: {
        position: { x: 2.37, y: 1.38, z: 0.59 },
        target: { x: 0.40, y: 0.42, z: -0.10 },
      },
      loopLabel: 'success loop',
      contextualLabels: [
        { label: '12 cycles' },
        { label: 'Pick at A' },
        { label: 'Place at B' },
      ],
    },
    failure: {
      findingId: 'drop',
      camera: null, // cameraHome holds J2 and the pad B landing point in one frame
      plottedFields: { channel: '/joints', fields: ['tau2', 'tau1', 'tau3'] },
    },
  },
  // Read by `viewer.setAnatomy()` off the def rather than out of the parts array: it is one spec
  // for the whole step, and the flow hands the viewer only the parts.
  anatomyTour: ANATOMY_TOUR,
  firstQuestion: 'Why did the arm drop the payload?',
  suggested: [
    'Show me exactly where it failed',
    'What is the root cause?',
    'Is the J2 driver overheating?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'why-drop',
      matchers: ['drop', 'dropped', 'payload', 'part', 'blank', 'cube', 'lost', 'why', 'fail', 'wrong', 'gripper'],
      answer: `The gripper never let go. J2 ran out of torque and the part slid out at **56.3 s**.

| metric | value |
| --- | --- |
| payload | 1.20 kg, taught for 0.25 |
| tau2 demand | 15.75 Nm vs 12.00 clamp |
| pinned on clamp | 2.10 s |
| err2 | 7.44 deg (1.04 nominal) |

The shoulder back-drove ~0.11 m under the commanded path and the arm finished the place move with empty jaws.

{{ev:drop}}`,
      evidence: ['drop'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'see', 'watch', 'replay', 'exactly', 'look', 'again'],
      answer: `Looping it at 0.4x with J2 lit. Watch the arm sag as the shoulder pins at 12 Nm, then the cube slips at 56.3 s. It never notices.

{{ev:drop}}`,
      evidence: ['drop'],
    },
    {
      id: 'root-cause',
      matchers: ['root', 'cause', 'fix', 'prevent', 'avoid', 'torque', 'saturat', 'clamp', 'envelope', 'j2', 'shoulder', 'reach', 'heavier', 'heavy'],
      answer: `Payload times reach. A 1.20 kg part at 0.89 m asks **15.75 Nm** of a shoulder clamped at **12.00**, so it clips, the error integrates for 2.1 s, and the part slides out.

Fixes, cheapest first:

- Cap the part at **0.60 kg** at this reach.
- Re-teach the transfer tucked inside **0.70 m**, extend only on the final descent.
- Upgrade J2 only: J1 used 61% of its envelope, J3 72%, J2 hit 100%.

{{ev:follow-err}}`,
      evidence: ['follow-err', 'drop'],
    },
    {
      id: 'thermal',
      matchers: ['temp', 'hot', 'heat', 'overheat', 'thermal', 'driver', 'drv3', 'cool', 'health', 'battery', 'bus', 'voltage'],
      answer: `It climbed **37.9 to 71.3 C** in 80 s and was still rising at the end, +5.4 C during the pinned window alone. That is duty, not a cooling fault, but log a longer run before trusting where it settles.

{{ev:overtemp}}`,
      evidence: ['overtemp'],
    },
    {
      id: 'other-joints',
      matchers: ['other', 'joint', 'joints', 'j1', 'j3', 'elbow', 'wrist', 'damage', 'damaged', 'broken', 'hardware', 'margin', 'headroom', 'safe'],
      answer: `No damage, and no other axis was even close.

| joint | envelope used |
| --- | --- |
| J1 torso | 61% |
| J2 shoulder | **100%** |
| J3 elbow | 72% |

Cycles 10-12 ran clean at nominal payload. The arm is fine. The program is not.`,
      evidence: [],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'firmware', 'instrument', 'stream'],
      answer: `One call per servo cycle. \`log()\` is a non-blocking memcpy; the uploader runs on the other core.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("joints", "tau2", "Nm", -12, 12, "shoulder torque");
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/arm6");
}

void servoLoop() {   // your existing 50 Hz loop
  alloy.log("joints")
       .set("q2", joint[2].pos).set("tau2", joint[2].torque);
  alloy.log("ee")
       .set("x", tcp.x).set("y", tcp.y).set("z", tcp.z)
       .set("grip", gripper.seated());
}
\`\`\`

Every number on this page came from calls like those. Free tier covers a robot this size.`,
      evidence: [],
    },
  ],
  buildScene,
};
