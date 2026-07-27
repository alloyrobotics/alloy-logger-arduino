// arm6/script.js - the arm6 RobotDefinition. Every number quoted below is read straight out of
// buildData(), not estimated: tau2 pins at exactly the 12.00 Nm clamp from 54.24 s to 56.32 s,
// peak unclamped demand is 15.75 Nm, err2 peaks at 7.44 deg at the drop, drv3_temp runs 37.9 to
// 71.3 C, and /ee.grip steps 1 to 0 at 56.30 s.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

export default {
  id: 'arm6',
  name: '6-axis pick and place',
  device: 'ESP32-S3 · 6x BLDC servo · 48 V bus',
  tagline: '12 transfer cycles, one dropped part',
  context: { system: 'A 6-axis pick-and-place arm on a 48 V bus: six BLDC servos, with joint, end-effector and controller channels logged at 50 Hz.', mission: '12 transfer cycles between two stations, the same taught trajectory every time.', fault: 'On cycle 9 the part is on the deck and the arm completes the place move as if nothing happened.', faultT: 56.3, label: 'payload drop' },
  accent: '#D3EEB6',
  duration,
  rate,
  channels,
  buildData,
  findings,
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
