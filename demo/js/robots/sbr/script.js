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
  tagline: 'PID balancer, 73 s mission',
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
      answer: `Not a power fault and not a stall. The balance loop ran out of phase margin and the robot went over forwards at **51.7 s**.

| metric | at the fall | rest of the mission |
| --- | --- | --- |
| pitch, 51.46 to 51.80 s | -2.00 / +7.12 / -10.06 deg | 0.22 deg mean error |
| d term | 0.000 in all 3651 samples | should oppose \`rate\` |
| step_rate peak | +5366 then -4226 steps/s | 875 steps/s peak to 31 s |
| first slam to 20 deg tilt | 0.52 s | n/a |

Three corrections inside 400 ms, each weaker than the one before: output **+228**, then **-180**, then **+120**. That last one is the tell. The robot was 10.06 deg out of true when it started, five times the 2.00 deg that triggered the first, and the loop answered with barely half the command. \`p\` was already past the 255 rail on the way in, and with no derivative term the command was reversing a quarter cycle late every time.

Pitch crossed 20 deg at 52.00 s and hit 88 deg by 52.6 s. The step command then sat on the -6000 rail for 1.6 s while the robot lay on its face with both wheels still turning.

{{ev:fall}}`,
      evidence: ['fall'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'replay', 'watch', 'see it', 'look at', 'exactly'],
      answer: `Looping 50.5 to 58.5 s at 0.4x. Watch \`pitch\` ring wider each cycle, then the three slams at 51.48, 51.70 and 51.88 s, then \`output\` pinning to the rail while the wheels keep spinning against the floor.

It is stood back up twice: down again at 56.2 s, upright and holding by 58.2 s.

{{ev:fall}}`,
      evidence: ['fall'],
    },
    {
      id: 'root-cause',
      matchers: ['root cause', 'cause', 'fix', 'gain', 'tune', 'tuning', 'kd', 'derivative', 'pid', 'prevent', 'stop this', 'happen again'],
      answer: `\`d\` is **0.000 in every one of the 3651 samples**, so \`KD\` was never set. Without it the loop only reacts to error that has already happened, and a 1.9 Hz plant with that much lag is marginally stable at best.

You can watch it go: the ring amplitude climbs the whole mission.

| t | ring amplitude |
| --- | --- |
| 10 s | 0.25 deg |
| 30 s | 0.32 deg |
| 44 s | 0.41 deg |
| 48 s | 0.72 deg |
| 50 s | 1.60 deg |
| 51.5 s | 2.50 deg |

That is a divergent limit cycle, not noise. It is quiet for 44 s because \`p\` still has headroom; once the peaks pass ~2.7 deg the command clips at 255 and the loop loses the authority it needed to keep the ring bounded. From there it is two swings to the floor.

Three things fix it, in order:

1. **Set \`KD\`.** Start around \`KP/12\` against the \`rate\` channel you are already logging, and confirm the ring stops growing rather than just getting slower.
2. **Back \`KP\` off.** 96 pwm/deg saturates on a 2.7 deg error. Half of that plus real derivative damping gives the same stiffness without living on the rail.
3. **Add a tilt cutoff.** \`motor_active\` never went false: the firmware kept commanding 6000 steps/s for 3.9 s of this run, 5.3% of all samples, most of it while the robot was flat on its face. Kill the drivers past 35 deg.

The 801.9 ms I2C stall is real but it is not this. It is 20 s before the fall, and the robot recovered from it.

{{ev:divergence}}`,
      evidence: ['divergence', 'fall'],
    },
    {
      id: 'heap',
      matchers: ['heap', 'memory', 'leak', 'free', 'health', 'reboot', 'long run', 'longer'],
      answer: `Yes. Free heap goes **112,172 B at boot to 67,020 B at 73 s**, a straight-line **622 B/s**, with no recovery between the sawtooth allocations.

Extrapolate it and free heap crosses the ~25 kB floor the TLS stack needs at about **140 s** from boot. That is why a 73 s mission looks clean and a five minute one does not.

The floor is worse than the trend. At 64.3 s the heap touched **48,724 B**, roughly 24 kB below trend, about a second after RSSI cratered from -56 to **-79 dBm**. That is a TLS retry buffering a whole chunk. Your true low-water mark is a link-quality event, not the leak.

{{ev:heap-leak}}`,
      evidence: ['heap-leak'],
    },
    {
      id: 'i2c',
      matchers: ['i2c', 'bus', 'imu', 'stall', 'jitter', 'timing', 'loop rate', 'sensor', 'i2c_dt', 'blocking'],
      answer: `\`i2c_dt\` sits at **10.5 ms** nominal and blows the 20 ms budget **16 times** in 73 s. The worst is **801.9 ms at 31.36 s**.

That one moved the robot. With the loop starved the last step command held, pitch lurched to **+6.26 deg** at 31.50 s, the command railed at -6000 steps/s for 0.22 s, and it took 2.0 s to settle back into its ring. It survived because the ring amplitude was still only 0.32 deg at the time. The same disturbance at 51 s would not have been survivable.

Second worst is 214.6 ms at 44.66 s. The nearest outlier to the fall is 29.1 ms at 49.86 s, 1.8 s clear of it, so the bus is not what put the robot on the floor.

Fix is the usual one: get the IMU read off the control task, or move to 400 kHz and a non-blocking read, so a retry cannot eat 80 control cycles.

{{ev:i2c-stall}}`,
      evidence: ['i2c-stall'],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'instrument', 'set this up'],
      answer: `Describe the fields once, then log one record per control cycle. \`log()\` is a non-blocking memcpy and the uploader runs on the other core, so your balance loop keeps its timing.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("balance", "pitch",  "deg",   -90,  90,  "fused tilt angle");
  alloy.describe("balance", "output", "pwm",  -255, 255,  "PID motor command");
  alloy.describe("balance", "rate",   "deg/s", -500, 500, "gyro angular rate");
  alloy.describe("balance", "i2c_dt", "ms",      0, 1000, "IMU read interval");

  alloy.wifi(WIFI_SSID, WIFI_PASS);   // skip if your firmware already owns the radio
  alloy.scope();                      // stepper and I2C pins show up as an "io" channel
  alloy.begin(ALLOY_KEY, "robots/sbr");
}

// your existing balance loop, one call added
void controlLoop() {
  float error = setpoint - pitch;
  float p = KP * error, i = KI * integral, d = KD * rate;
  float output = constrain(p + i + d, -255, 255);

  alloy.log("balance")
       .set("pitch", pitch).set("setpoint", setpoint)
       .set("output", output)
       .set("p", p).set("i", i).set("d", d)
       .set("rate", rate)
       .set("step_rate", stepRate)
       .set("motor_active", fabs(output) > 3.0)
       .set("i2c_dt", imuDeltaMs);
}
\`\`\`

That is the whole integration. Every field on this page came out of \`alloy.log()\` calls exactly like those, and \`alloy.end()\` finalized the mission file so it was queryable the moment the run stopped. A robot this size fits inside the free tier.`,
      evidence: [],
    },
  ],
  buildScene,
};
