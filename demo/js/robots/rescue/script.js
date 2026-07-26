// rescue/script.js - the RobotDefinition for the tracked rescue robot.
// Every number quoted in these answers is read off the arrays data.js actually generates; they were
// verified by running the generator under node, not estimated.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

export default {
  id: 'rescue',
  name: 'Tracked rescue robot',
  device: 'ESP32 · BNO055 · 2x track drive · 2x INA219',
  tagline: 'Rubble climb, 85 s mission',
  accent: '#f5a623',
  duration,
  rate,
  channels,
  buildData,
  findings,
  firstQuestion: 'Why did it stall on the rubble pile?',
  suggested: [
    'Show me exactly where it failed',
    'What is the root cause?',
    'Are the drive motors overheating?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'why-stall',
      matchers: ['stall', 'rubble', 'pile', 'stuck', 'stop', 'wrong', 'fail', 'happen', 'why'],
      answer: `It never lost drive. It lost grip at **48.4 s**, and the operator kept pushing.

| metric | value |
| --- | --- |
| commanded / actual | 0.35 / 0.01 m/s |
| slip | 0.98 |
| left current | 22.7 A (8.7 nominal) |
| slid back | 0.56 m, 15 deg off line |

Command flat while speed collapses is traction, not electronics: the left track spun in place at locked-rotor draw on the 28 deg face.

{{ev:stall}}`,
      evidence: ['stall'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'see', 'replay', 'watch', 'look'],
      answer: `Looping it at 0.4x, left track lit. Watch it keep spinning while the chassis stops dead, then the slide back down the face with a forward command still on.

{{ev:stall}}`,
      evidence: ['stall'],
    },
    {
      id: 'root-cause',
      matchers: ['root', 'cause', 'fix', 'prevent', 'avoid', 'gain', 'tune', 'design', 'deeper'],
      answer: `Geometry, not gains. The proof is the retry: same face, same command, flippers down, and slip went **0.98 → 0.15** with current peaking 15.3 A instead of 22.7.

Changes I would make:

1. **Drop the flippers on grade**, not after the stall: pitch crossed 10 deg 3.2 s before the track let go.
2. **Cap speed above 20 deg grade.**
3. **16 A ceiling per track**: the good climb never passed 15.3.

{{ev:retry}}`,
      evidence: ['retry', 'stall'],
    },
    {
      id: 'thermal',
      matchers: ['temp', 'heat', 'hot', 'thermal', 'motor', 'overheat', 'batt', 'volt', 'health'],
      answer: `The left drive ran hot and never came back down: the stall put **13.8 C into it in 4.6 s** with no airflow to shed it.

| channel | peak |
| --- | --- |
| temp_l | **77.2 C**, still 71.9 at end |
| temp_r | 66.3 C |

That 11 C gap is the story: the left drive did all the suffering. Pack sag to 22.4 V was load, not a cell fault.

{{ev:thermal}}`,
      evidence: ['thermal'],
    },
    {
      id: 'retry',
      matchers: ['flipper', 'second', 'attempt', 'again', 'retry', 'recover', 'crest', 'made it', 'worked'],
      answer: `Flippers down at 57 s, counter-steer to unwind the 15 deg, and the same face went from slip 0.98 to **0.15**. Crested at **64.6 s** with current never passing 15.3 A.

{{ev:retry}}`,
      evidence: ['retry'],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'firmware'],
      answer: `One call per drive cycle. \`log()\` is a non-blocking memcpy; the uploader runs on the other core.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("drive", "i_l", "A", 0, 30, "left drive current");
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/rescue");
}

void loop() {   // your existing 50 Hz drive cycle
  alloy.log("drive")
       .set("cmd_l", cmdL).set("vel_l", encL.mps())
       .set("i_l", inaL.getCurrent_mA() / 1000.0);
  alloy.log("imu").set("pitch", imu.pitch());
  delay(20);
}
\`\`\`

Every number on this page came from calls like those. Free tier covers a robot this size.`,
      evidence: [],
    },
  ],
  buildScene,
};
