// sbr/script.js - the sbr RobotDefinition. Every number quoted in an answer below is read back
// out of buildData(), not asserted from memory: the fall timings, the three output slams, the
// step ceiling percentage, the heap endpoints and the I2C outliers are all verifiable against
// the arrays this robot ships.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

export default {
  id: 'sbr',
  name: 'Self-balancing robot',
  device: 'ESP32 · BNO055 IMU · 2x stepper',
  tagline: 'Balances for 51 s, then falls',
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
