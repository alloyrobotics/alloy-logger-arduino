// sbr/script.js - the sbr RobotDefinition. Every number quoted in an answer below is read back
// out of buildData(), not asserted from memory: the fall timings, the three output slams, the
// step ceiling percentage, the heap endpoints and the I2C outliers are all verifiable against
// the arrays this robot ships.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

/**
 * The OPENER in the support register, hoisted so the two ids that name that register can share ONE
 * string. `demo/js/core/role.js` calls it `support` and `worker/roles.js` calls it `operator`;
 * until those two vocabularies are reconciled, a def that picked one of them would silently serve
 * the engineer answer to every visitor who arrived under the other. The alias below is this const,
 * never a second copy of the copy, so the two keys cannot drift apart.
 *
 * Same table, same numbers, same instant as the engineer answer: a register is a way of reading one
 * measurement, not a second measurement. Same `{{ev:fall}}` token, so the opener's auto-beat fires
 * whatever the role. Length within 20% of the engineer answer, so the panel does not reflow.
 */
const OPENER_SUPPORT = `Nothing broke and nothing stalled. The wobble grew until it went over at **51.7 s**.

| metric | value |
| --- | --- |
| pitch swing | -2.0 → +7.1 → -10.1 deg in 340 ms |
| d term | 0.000, all 3651 samples |
| step peak | +5366 / -4226 steps/s |
| down / up again | 52.0 s / 58.2 s |

Three corrections in 400 ms, each weaker than the last. Nothing you did on the day changed that; the loop was set up to lose it.

{{ev:fall}}`;

/** The OPENER in the lead register. Same rules as OPENER_SUPPORT. */
const OPENER_LEAD = `A tuning gap, not a hardware fault. It ran out of damping and went over at **51.7 s**.

| metric | value |
| --- | --- |
| pitch swing | -2.0 → +7.1 → -10.1 deg in 340 ms |
| d term | 0.000, all 3651 samples |
| step peak | +5366 / -4226 steps/s |
| down / up again | 52.0 s / 58.2 s |

Three corrections in 400 ms, each weaker than the last. The fix is a gain, not a part: no rework, no BOM change, and it carries to every robot on this firmware.

{{ev:fall}}`;

export default {
  id: 'sbr',
  name: 'Self-balancing robot',
  device: 'ESP32 · BNO055 IMU · 2x stepper',
  tagline: 'Balances for 51 s, then falls',
  // `datapoints` and `channels` are the mission's VOLUME, authored here rather than counted at
  // render time. They are the row-times-field total and the channel count that buildData() actually
  // ships, read off the built arrays under node (2 channels, 3651 x 10 on /balance and 731 x 3 on
  // /sys) rather than derived from `rate` x `duration`. Every def carries the pair, so the brief
  // states the same volume whether or not this robot's telemetry has been built yet.
  context: { system: 'An ESP32 closing a 50 Hz PID balance loop on a BNO055 IMU, driving two stepper motors.', mission: 'A 73-second soak test: hold upright on flat ground and stream every control cycle to the mesh.', fault: 'A pitch oscillation grows over about a second and the robot goes face-down, wheels still driving. Every cycle of the loop that lost it is in the log.', faultT: 51.7, label: 'fall', datapoints: 38703, channels: 2 },
  accent: '#2f78ff',
  duration,
  rate,
  channels,
  buildData,
  findings,
  firstQuestion: 'Why does my robot keep falling over?',
  suggested: [
    'Show me exactly where it failed',
    'What is the actual root cause?',
    'Is it leaking memory?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'why-fall',
      matchers: ['fall', 'fell', 'falling', 'fallen', 'tip', 'tipped', 'topple', 'balance', 'crash', 'went wrong', 'over?'],
      answer: `Not power, not a stall. It ran out of damping and went over at **51.7 s**.

| metric | value |
| --- | --- |
| pitch swing | -2.0 → +7.1 → -10.1 deg in 340 ms |
| d term | 0.000, all 3651 samples |
| step peak | +5366 / -4226 steps/s |
| down / up again | 52.0 s / 58.2 s |

Three corrections in 400 ms, each weaker than the last: with no derivative term every command lands a quarter cycle late.

{{ev:fall}}`,
      // Role registers for the OPENER. `answer` above IS the engineer register and stays the
      // default, so `engineer` is never a key here and a def that ships no `answerByRole` behaves
      // exactly as it did before roles existed. `support` and `operator` are the SAME const, see
      // OPENER_SUPPORT: two live vocabularies name that register, and one shared string means the
      // answer cannot depend on which of them the caller happens to use.
      answerByRole: { support: OPENER_SUPPORT, operator: OPENER_SUPPORT, lead: OPENER_LEAD },
      evidence: ['fall'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'replay', 'watch', 'see it', 'look at', 'exactly'],
      answer: `Looping it at 0.4x. Watch the wobble grow, three slams at 51.5-51.9 s, then it is on its face with both wheels still spinning.

{{ev:fall}}`,
      evidence: ['fall'],
    },
    {
      id: 'root-cause',
      matchers: ['root cause', 'cause', 'fix', 'gain', 'tune', 'tuning', 'kd', 'derivative', 'pid', 'prevent', 'stop this', 'happen again'],
      answer: `\`KD\` was never set: \`d\` is **0.000 in all 3651 samples**. The wobble grows all mission, 0.25 deg at 10 s to 2.5 deg at 51.5 s, then \`p\` clips at 255 and it is two swings to the floor.

Fix, in order:

1. **Set \`KD\`**, start near \`KP/12\` against \`rate\`.
2. **Halve \`KP\`**: 96 pwm/deg saturates on a 2.7 deg error.
3. **Kill the drivers past 35 deg tilt**: they ran 6000 steps/s for 3.9 s face-down.

{{ev:divergence}}`,
      evidence: ['divergence', 'fall'],
    },
    {
      id: 'heap',
      matchers: ['heap', 'memory', 'leak', 'free', 'health', 'reboot', 'long run', 'longer'],
      answer: `Yes: **622 B/s**, dead straight, 112,172 B at boot to 67,020 B at 73 s. At that rate it hits the ~25 kB TLS floor around **140 s**, so a 73 s run looks clean and a 5 minute one reboots.

{{ev:heap-leak}}`,
      evidence: ['heap-leak'],
    },
    {
      id: 'i2c',
      matchers: ['i2c', 'bus', 'imu', 'stall', 'jitter', 'timing', 'loop rate', 'sensor', 'i2c_dt', 'blocking'],
      answer: `The bus blows its 20 ms budget **16 times**, worst **801.9 ms at 31.4 s**: pitch lurched to +6.26 deg and took 2 s to settle. It is 20 s clear of the fall though, so it is not the killer.

Fix: take the IMU read off the control task, or 400 kHz + non-blocking read.

{{ev:i2c-stall}}`,
      evidence: ['i2c-stall'],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'instrument', 'set this up'],
      answer: `One call per control cycle. \`log()\` is a non-blocking memcpy; the uploader lives on the other core.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("balance", "pitch", "deg", -90, 90, "fused tilt");
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/sbr");
}

void controlLoop() {
  // ...your existing PID...
  alloy.log("balance")
       .set("pitch", pitch).set("output", output)
       .set("p", p).set("i", i).set("d", d)
       .set("rate", rate).set("i2c_dt", imuDeltaMs);
}
\`\`\`

Every number on this page came from calls like those. Free tier covers a robot this size.`,
      evidence: [],
    },
  ],
  buildScene,
};
