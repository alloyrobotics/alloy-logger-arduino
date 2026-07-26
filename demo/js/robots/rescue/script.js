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
      answer: `It never lost drive. It lost grip, and the operator kept pushing anyway.

| metric | at 48.4 s | budget |
| --- | --- | --- |
| cmd_l | 0.35 m/s | 0.35 m/s |
| vel_l | 0.01 m/s | 0.30 m/s |
| slip_l | 0.98 | < 0.25 |
| i_l | 22.7 A | 8.7 A |

The machine broke over onto a 28 deg rubble face at 44.0 s and climbed it cleanly for three seconds at 0.16 slip. At 47.4 s the left track let go: \`cmd_l\` stayed flat at 0.35 m/s while \`vel_l\` fell to 0.01 m/s inside a second, so this is traction, not a lost command. With nothing to push against, the left drive went to locked-rotor draw, 22.7 A against 8.7 A nominal on the same grade, and stayed above 18 A for 1.4 s.

The right track kept biting for another second. That slewed the machine 15.1 deg off line and slid it 0.56 m back down the face by 52.0 s.

{{ev:stall}}`,
      evidence: ['stall'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'see', 'replay', 'watch', 'look'],
      answer: `Looping 46.0 to 54.0 s at 0.4x, chart on \`cmd_l\`, \`vel_l\` and \`i_l\`.

Watch the left track keep turning while the chassis stops dead, then jam as the current peaks, then the whole machine slide back down the face with a forward command still on it.

{{ev:stall}}`,
      evidence: ['stall'],
    },
    {
      id: 'root-cause',
      matchers: ['root', 'cause', 'fix', 'prevent', 'avoid', 'gain', 'tune', 'design', 'deeper'],
      answer: `Geometry, not gains. The track could not hold enough contact patch on a 28 deg face, and nothing in the loop was watching for it.

Three channels have to agree before you can call that:

- \`/drive\` has \`cmd_l\` flat while \`vel_l\` collapses, which rules out a dropped command.
- \`/drive\` has \`i_l\` at 22.7 A with the track going nowhere, which is locked-rotor draw, not a dead motor.
- \`/imu\` has pitch pinned at 28.5 deg and roll dipping to -9.9 deg, so the left side sank into the rubble rather than hitting a wall.

The proof is the retry. Same face, same 0.35 m/s command, front flippers at -35 deg: slip 0.15, \`i_l\` peaked at 15.3 A, crested at 64.6 s. The only variable that changed was contact geometry.

{{ev:retry}}

Three changes I would make:

1. Drop the flippers on grade, not after the stall. \`/imu\` pitch crosses 10 deg at 44.2 s, a full 3.2 s before the left track lets go.
2. Cap commanded speed above 20 deg of grade. The climb that worked only averaged 0.31 m/s anyway.
3. Put a 16 A ceiling on each track drive. The successful climb peaked at 15.3 A, so the ceiling costs you nothing and takes 6.7 A off the stall.

{{ev:stall}}`,
      evidence: ['retry', 'stall'],
    },
    {
      id: 'thermal',
      matchers: ['temp', 'heat', 'hot', 'thermal', 'motor', 'overheat', 'batt', 'volt', 'health'],
      answer: `The left drive ran hot and never came back down.

| channel | start | peak | at 85 s |
| --- | --- | --- | --- |
| temp_l | 41.0 C | 77.2 C | 71.9 C |
| temp_r | 39.6 C | 66.3 C | 62.2 C |
| batt_v | 25.2 V | 22.4 V min | 23.8 V |

\`temp_l\` was already 41 C when the mission opened and only reached 44.9 C by the break-over, so the flat traverse was not the problem. The stall put 13.8 C into it in 4.6 s, and with the machine stationary there was no airflow to shed any of it. It peaks at 77.2 C at 66.1 s, right at the top of the successful climb, and is still 71.9 C when the log ends.

The right motor tops out 10.9 C lower on the same climb. That gap is the whole story in one number: the left drive did all the suffering.

Pack voltage sags to 22.4 V at 48.4 s under 33.6 A of combined draw, then recovers to 23.8 V. That is load, not a failing cell.

{{ev:thermal}}`,
      evidence: ['thermal'],
    },
    {
      id: 'retry',
      matchers: ['flipper', 'second', 'attempt', 'again', 'retry', 'recover', 'crest', 'made it', 'worked'],
      answer: `It got up on the second run, and the telemetry says exactly why.

The operator put the front flippers from 0 to -35 deg between 56.9 and 58.4 s, brought the rear pair to -15 deg at 61.2 s, then counter-steered with \`cmd_l\` 0.37 against \`cmd_r\` 0.33 to unwind the 15 deg the stall had cost.

Same face, same speed command, a completely different signature: slip_l averaged 0.15 instead of 0.98, \`i_l\` averaged 14.7 A and never passed 15.3 A, and it crested at 64.6 s with 2.1 m of plateau to spare.

{{ev:retry}}`,
      evidence: ['retry'],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'firmware'],
      answer: `Describe the fields once, then log a record per drive cycle. This is the sketch that produced the mission you are looking at.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  // optional semantics so Alloy AI labels the streams precisely
  alloy.describe("drive",   "cmd_l",  "m/s", -1.2, 1.2, "commanded left track speed");
  alloy.describe("drive",   "vel_l",  "m/s", -1.2, 1.2, "measured left track speed");
  alloy.describe("drive",   "i_l",    "A",      0,  30, "left drive bus current");
  alloy.describe("imu",     "pitch",  "deg",  -90,  90, "fused chassis pitch");
  alloy.describe("flipper", "front",  "deg",  -90,  90, "front flipper angle");
  alloy.describe("sys",     "temp_l", "C",      0, 120, "left motor case temp");

  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/rescue");
}

// 50 Hz drive cycle. log() is a non-blocking memcpy, the upload runs on the other core.
void loop() {
  alloy.log("drive")
       .set("cmd_l", cmdL).set("cmd_r", cmdR)
       .set("vel_l", encL.mps()).set("vel_r", encR.mps())
       .set("i_l", inaL.getCurrent_mA() / 1000.0)
       .set("i_r", inaR.getCurrent_mA() / 1000.0);

  alloy.log("imu").set("roll", imu.roll()).set("pitch", imu.pitch());
  alloy.log("flipper").set("front", frontDeg).set("rear", rearDeg);

  delay(20);   // your existing loop rate, not a sleep the logger needs
}
\`\`\`

The free tier covers a robot like this. Every field on this page came out of \`alloy.log()\` calls exactly like those, and \`alloy.end()\` finalized the mission file when the run stopped.`,
      evidence: [],
    },
  ],
  buildScene,
};
