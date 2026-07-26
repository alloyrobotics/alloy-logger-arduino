// stub/script.js - composes the stub RobotDefinition. This is the shape every real robot
// directory follows: import ./data.js + ./scene.js, export default the full def.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

export default {
  id: 'stub',
  name: 'Test rover',
  device: 'ESP32 · 2x DC motor · INA219',
  tagline: 'Scaffold check, 20 s run',
  accent: '#2f78ff',
  duration,
  rate,
  channels,
  buildData,
  findings,
  firstQuestion: 'Why did the rover stop moving?',
  suggested: [
    'Show me exactly where it failed',
    'Is the driver overheating?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'why-stall',
      matchers: ['stop', 'stall', 'stuck', 'why', 'fail', 'wrong', 'moving'],
      answer: `The rover did not lose power. It drove into something at **10.0 s** and the motors kept pushing.

| metric | at 10.0 s | expected |
| --- | --- | --- |
| cmd | 0.62 m/s | 0.62 m/s |
| vel | 0.01 m/s | 0.62 m/s |
| current | 17.8 A | 3.4 A |
| slip ratio | 0.98 | < 0.15 |

Command stayed flat while measured velocity collapsed to zero, so this is a mechanical block, not a control fault. Current jumped five times nominal within 300 ms, which is locked-rotor draw. The controller held command for **2.6 s** before backing off, and that is what put the heat into the driver.

{{ev:stall}}`,
      evidence: ['stall'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'see', 'replay', 'watch'],
      answer: `Here is the window. Watch velocity flatline while the wheels keep turning, then the body shudder as current pins.

{{ev:stall}}`,
      evidence: ['stall'],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot'],
      answer: `Same as this mission. Describe the fields once, then log a record per control cycle.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("drive", "cmd",     "m/s", -1, 1, "commanded speed");
  alloy.describe("drive", "vel",     "m/s", -1, 1, "wheel odometry");
  alloy.describe("drive", "current", "A",    0, 25, "motor bus current");

  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/stub");
}

void loop() {
  alloy.log("drive")
       .set("cmd", cmd)
       .set("vel", readOdometry())
       .set("current", ina.getCurrent_mA() / 1000.0);
  delay(20);
}
\`\`\`

The free tier covers a robot like this. Every field on this page came out of \`alloy.log()\` calls exactly like those, and \`alloy.end()\` finalized the mission file.`,
      evidence: [],
    },
  ],
  buildScene,
};
