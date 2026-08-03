// rescue/script.js - the RobotDefinition for the tracked rescue robot.
// Every number quoted in these answers is read off the arrays data.js actually generates; they were
// verified by running the generator under node, not estimated.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

/**
 * The OPENER in the HOBBYIST register.
 *
 * This was the operator register, keyed on `operator` and `support`. Roles v2 retired both ids and
 * role.js degrades them to `engineer` BEFORE chat.js's `answerFor()` reads this map, so neither key
 * could ever be selected again: it was a register nobody could reach. The copy is hands-on advice
 * for the person driving the machine, which is the hobbyist register under v2, so it is keyed there
 * rather than deleted. No role is guided into this mission - it is reached from the picker, from
 * any seat.
 *
 * Same table, same numbers, same instant as the engineer answer, same `{{ev:stall}}` token so the
 * opener's auto-beat fires, length within 20%.
 */
const OPENER_HOBBYIST = `The tracks never stopped turning. They stopped gripping at **48.4 s**.

| metric | value |
| --- | --- |
| commanded / actual | 0.35 / 0.01 m/s |
| slip | 0.98 |
| left current | 22.7 A (8.7 nominal) |
| slid back | 0.56 m, 15 deg off line |

Full stick into a spinning track only heats the motor and digs in. On a 28 deg face like that one, ease off and drop the flippers before it lets go.

{{ev:stall}}`;

/** The OPENER in the lead register. Same rules as OPENER_HOBBYIST. */
const OPENER_LEAD = `Not a broken robot. A traction limit the drill did not plan for, hit at **48.4 s**.

| metric | value |
| --- | --- |
| commanded / actual | 0.35 / 0.01 m/s |
| slip | 0.98 |
| left current | 22.7 A (8.7 nominal) |
| slid back | 0.56 m, 15 deg off line |

The left track spun in place at locked-rotor draw on the 28 deg face. Procedure and a current ceiling close this out: no hardware spend, and the same limit applies across the fleet.

{{ev:stall}}`;

export default {
  id: 'rescue',
  name: 'Tracked rescue robot',
  device: 'ESP32 · BNO055 · 2x track drive · 2x INA219',
  tagline: 'Stalls on the rubble, flippers save it',
  // Authored volume: 45,063 values across 4 channels, read off the built arrays under node
  // (/drive 4251 x 6, /imu 4251 x 2, /flipper 4251 x 2, /sys 851 x 3), not derived from rate x duration.
  context: { system: 'A tracked rescue platform: independent track drives with current sensing on both motors, IMU and flipper actuators, logged at 50 Hz.', mission: 'An 85-second traverse of a rubble pile: climb, cross, descend.', fault: 'The left track stops making ground on the steep face and the climb stalls. A second attempt crests it. Why the first try failed is in the drive channels.', faultT: 48.4, label: 'track stall', datapoints: 45063, channels: 4,
    // The picker card's line: authored short, fault first. See sbr/script.js.
    cardProblem: 'The left track stops making ground on the steep face and the climb stalls.' },
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
      // Role registers for the OPENER. `answer` above IS the engineer register and stays the
      // default, so `engineer` is never a key here. Every other key must be a LIVE role id: a
      // retired id is degraded to `engineer` upstream and can never reach this lookup.
      answerByRole: { hobbyist: OPENER_HOBBYIST, lead: OPENER_LEAD },
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
