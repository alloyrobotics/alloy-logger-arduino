// arm6/script.js - the arm6 RobotDefinition. Every number quoted below is read straight out of
// buildData(), not estimated: tau2 pins at exactly the 12.00 Nm clamp from 54.24 s to 56.32 s,
// peak unclamped demand is 15.75 Nm, err2 peaks at 7.44 deg at the drop, drv3_temp runs 37.9 to
// 71.3 C, and /ee.grip steps 1 to 0 at 56.30 s.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

/**
 * The directed fly-through for the anatomy step: four shots, one per card. Schema and rationale:
 * `viewer.js`, "directed anatomy tour".
 *
 * WHY FOOTAGE AND NOT A POSE. Every one of these four cards makes a claim about something the arm
 * DOES - a shoulder that saturates, jaws that close on the part, a driver that heats up over the
 * run, a turret that swings between two stations - and a machine held at one frozen second under a
 * slow orbit demonstrates none of them. Each beat below names the seconds of the mission where the
 * arm is doing the thing its card claims, so every claim is made over footage of it happening.
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
 *                        material tracks it, full blue to full red, across a locked-off shot.
 *   base     29.25-31.40 the A-to-B transfer of that same clean cycle. q0 sweeps -34 deg at the
 *                        over-pick keyframe, through 2 deg at 30.35 s, to +38 deg at over-place:
 *                        72 deg of turret in 2 s, which is the whole card.
 *
 * WHY THE J2 BEAT IS INSIDE THE FAULT. It sits in the `drop` finding's 52-60 s window, two steps
 * before the failure screen. That is a narrative cost, and it is unavoidable: the arm saturates
 * exactly once in 80 s, and a card reading "the joint that saturates at 12 Nm" held over any of the
 * eleven cycles where it does not is a truth cost, which is the worse one. What the shot spends
 * that on is the SAG - the upper arm falling under a joint that is out of torque - not the drop.
 * The window closes 0.1 s after the slip and the gripper is at the frame's right edge by then, so
 * the part leaving the jaws is not what this beat is about and not what it shows.
 *
 * THE FRAME. `basis: base -> gripper` is the arm's own heading: the base anchor sits ON the q0 axis
 * so its ground position is fixed, and the TCP anchor is the reach vector out of it, never shorter
 * than 0.34 m anywhere in the mission (min at 61.0 s, the re-home), so the basis can never
 * degenerate. `fwd` is therefore the direction the arm is reaching and `side` is broadside to it,
 * both yawing with q0. A beat in that frame keeps the arm's sagittal plane square to the lens while
 * the turret turns underneath - which is what makes a shoulder sagging in pitch legible. The two
 * beats about things bolted to the FLOOR (the driver bay) or about the turn ITSELF (the turret) are
 * shot in the world frame, because a camera that yaws with q0 cancels exactly the motion they are
 * about.
 *
 * SCALE, and it is the thing that cannot be copied from the ssl tour. Metres, y-up, and this
 * machine is small: the pedestal is 0.46 m across, the shoulder housing 0.156 m, the payload
 * 0.07 m, the driver chip 0.026 m. Stand-offs run 0.26 m on the chip up to 1.37 m on the turret,
 * every one of them inside OrbitControls' `minDistance`, which is why the tour writes the camera
 * after `controls.update()` rather than through it.
 *
 * WHY EVERY SHOT LOOKS DOWN AT LEAST 30 DEG. Same reason as ssl and a different subject: this scene
 * has no sky either, and the arm works on a floor. A camera near the height of its subject spends
 * the top third of a portrait panel on the black above the horizon and the bottom third on empty
 * floor. Each beat is pitched steeply enough that the horizon sits off the top edge, so the panel
 * is machine and workspace all the way up. The stand-offs are unchanged by that: each `pos` was
 * rotated about its aim point, not moved away from it.
 *
 * Framing was checked by projecting every joint, pad and payload point of each beat through the
 * viewer's own fov law at both the phone aspect (~0.62, fov widens to 72 deg) and the desktop
 * column (~1.45, 51 deg). Nothing a card is about leaves the frame at either.
 */
const ANATOMY_TOUR = {
  // WHY 3500 AND NOT THE 2900 EVERY OTHER TOUR HOLDS, and what it does NOT buy. The camera cuts on
  // the frame the beat index changes; the CARD crossfades, because `.v-anat.is-tour .v-anat-card`
  // carries a 0.4 s opacity transition. So the first ~0.4 s after every cut is a frame in which the
  // outgoing card is still most of the way lit over the incoming shot and the incoming card is
  // barely there. 0.4 s of a 2900 ms hold is 14 per cent of every beat; of 3500 it is 11, and the
  // extra 600 ms is reading time the copy needed anyway - 3.5 s less the crossfade leaves 3.1 s on
  // a card of twelve words plus the mechanism the shot is of, where 2900 left 2.5 s.
  //
  // What the longer hold does NOT buy is immunity from a fixed review grid, and the version of this
  // note that shipped last claimed it did: it argued that samples 2.9 s apart walk backward through
  // a 3.5 s beat by 0.6 s each time and so land mid-beat four times running. They do walk backward,
  // but from wherever the boot happens to put the first one, and nothing here controls that.
  // Measured over a 30 s recording of the live page, the tour opens its first beat 377 ms after
  // navigation and cuts every 3500 ms after it, to within 10 ms, four beats round and repeating:
  //
  //   0.38 J2   3.88 gripper   7.38 drv3   10.88 base   14.38 J2   17.88 gripper   21.38 drv3
  //   24.88 base   28.37 J2 ...            (seconds from navigation)
  //
  // A 2900 ms grid opening at 14.5 s therefore sits 0.13 s into J2, then 0.03 s into the gripper
  // beat - inside the crossfade, and that single frame is the one a review read as the J2 card over
  // the gripper's footage - then 2.93 s into that SAME gripper beat, then 2.33 s into drv3, and
  // never lands in the turret beat at all. Both complaints such a sweep produces, a card over the
  // next card's shot and a card that appears to have no beat of its own, are that phase and not
  // this schedule. Sample each beat at its own middle instead: 14.5 s + 3.5n lands 2.1 s into all
  // four in turn, clear of the cut behind and the cut ahead.
  //
  // The residue no hold can fix is the crossfade itself, and it is half a defect rather than one.
  // A FRAMING that has moved on ahead of its label is how a cut has always read, and the ssl tour
  // carries the same 0.4 s of it; re-ordering the beats cannot remove it here, because the gripper
  // beat's 0.47 m opening frame holds nothing but the hand, so whichever card precedes it is over a
  // shot without its own subject, and no cyclic order of these four keeps every outgoing part in
  // frame. A NUMBER is the other half and is not grammar: the instrument panels gate on the CAMERA,
  // which has already cut, so the incoming beat's readout used to light under the outgoing beat's
  // heading - "logged 0 or 1" beside the jaws under the J2 card, "TAU2 12.00 SATURATED" under the
  // Base turret card. That is fixed where it belongs, on the decals in scene.js, which now wait
  // 440 ms for the card to catch up before they light. The camera still cuts.
  hold: 3500,
  basis: { origin: 'base', forward: 'gripper' },
  beats: [
    {
      // Broadside to the sagittal plane at 0.92 m and 30 deg up, easing back to 0.98 m as the
      // aim slides a hand's width out along the arm. The J2 anchor barely translates - the
      // shoulder sits within 0.03 m of the q0 axis all mission - so the shot is near-locked and
      // the arm rotates through it: the upper arm and the elbow fall 17 deg of q2 across the beat
      // while the strain LED on the column below the joint blinks alert.
      part: 'j2',
      window: [53.9, 56.4],
      frame: 'robot',
      pos: [-0.15, 0.78, 0.46],
      posEnd: [-0.16, 0.83, 0.49],
      aim: [0.18, 0, 0.12],
      aimEnd: [0.24, 0, 0.06],
    },
    {
      // Rides the TCP: the aim point IS the logged /ee point, so the jaws hold still in frame and
      // pad A drops out of the bottom of it as the part comes up. Square across the jaw axis rather
      // than down it: q5 counter-rotates the base yaw to -5 deg of world here, so a camera anywhere
      // near the arm's own reach line would have one finger hiding the other. This azimuth also
      // puts the pedestal behind the lens instead of behind the jaws, where its casting swallowed
      // the near finger.
      //
      // 0.47 m easing to 0.37 m, which is the same azimuth and elevation the shot was approved on
      // with the stand-off scaled out 15 per cent. At 0.40 m the forearm and wrist housing crossed
      // the top third of a portrait frame as one unreadable black mass and the shot read as pushed
      // INTO the machine rather than held on the jaws; 15 per cent back puts the whole hand, the
      // part and the pad it is lifting off inside the frame, and leaves the frame's left half empty
      // for the grip readout. The 12 mm of jaw travel is not what carries the card any more - the
      // panel's 0-to-1 step is, because the claim on the card is the logged BIT and not the stroke.
      part: 'gripper',
      window: [28.1, 29.5],
      frame: 'robot',
      pos: [0.184, 0.345, 0.253],
      posEnd: [0.150, 0.276, 0.196],
      aim: [0.01, 0, 0],
    },
    {
      // A 0.30 m detail shot of the driver bay, creeping in to 0.26 m. The angle is not a taste
      // call: the chip is a 26 mm square wedged in a 30 mm slot between the bay's outer face and
      // the plinth, and the only sightline that clears both runs out on the front quarter at
      // 42 deg up. Any flatter and the plinth is in front of it; square-on from +x and the plinth
      // is in front of it. World frame, or the shot would swing 72 deg every cycle around a part
      // bolted to the pedestal that never moves. Twelve cycles play out behind it at 27x, which is
      // what a run-long thermal creep looks like when it is made watchable.
      part: 'drv3',
      window: [0, 80],
      frame: 'world',
      pos: [0.155, 0.155, 0.20],
      posEnd: [0.135, 0.135, 0.173],
      aim: [0.05, 0.05, -0.045],
    },
    {
      // Down the +x axis the sweep is almost entirely lateral - the TCP crosses 0.9 m of z against
      // 0.2 m of x - so this is the one azimuth on which 72 deg of q0 reads as 72 deg. Raised to
      // 45 deg so the arm passes over the turret like a hand over a dial rather than swinging at
      // the lens, and held at 1.28 m easing to 1.37 m, which is the distance at which BOTH pads and
      // the gripper stay inside the frame for the whole sweep: the two stations the card names are
      // in shot the entire time the arm travels between them.
      part: 'base',
      window: [29.25, 31.4],
      frame: 'world',
      pos: [0.90, 0.08, 0.90],
      posEnd: [0.97, 0.08, 0.97],
      aim: [0.32, -0.12, 0.26],
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
