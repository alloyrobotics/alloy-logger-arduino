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
      answer: `The gripper did not let go. J2 ran out of torque and the part slid out of the jaws.

| metric | cycle 9 | taught for |
| --- | --- | --- |
| payload | 1.20 kg | 0.25 kg |
| tau2 demand | 15.75 Nm | 12.00 Nm clamp |
| tau2 delivered | 12.00 Nm, pinned 2.10 s | 9.19 Nm typical peak |
| err2 following error | 7.44 deg | 1.04 deg worst nominal |

Cycle 9 picked a 1.20 kg blank on a program taught for 0.25 kg. tau2 reached its 12.00 Nm current clamp at 54.24 s and stayed flat on it for 2.10 s while the transfer swung out to 0.892 m of reach, so J2 back-drove and the tool ended up roughly 0.11 m below the commanded path. The jaw gap encoder reported the part gone at **56.30 s**, 2.10 s before the release the program actually commanded at 58.40 s, and /ee carries on for another 0.48 m of the place move with empty jaws.

{{ev:drop}}`,
      evidence: ['drop'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'where', 'see', 'watch', 'replay', 'exactly', 'look', 'again'],
      answer: `Looping 52 to 60 s at 0.4x, with J2 lit.

Watch tau2 flatten onto 12.00 Nm at 54.2 s, the arm sag as err2 builds from 0.27 to 7.44 deg, then the step down to 5.18 Nm the instant the blank leaves the jaws at 56.3 s. The arm never notices. It finishes the place move on an empty gripper.

{{ev:drop}}`,
      evidence: ['drop'],
    },
    {
      id: 'root-cause',
      matchers: ['root', 'cause', 'fix', 'prevent', 'avoid', 'torque', 'saturat', 'clamp', 'envelope', 'j2', 'shoulder', 'reach', 'heavier', 'heavy'],
      answer: `Payload times reach. J2's gravity moment is the part mass multiplied by its horizontal distance from the shoulder axis, and the transfer pose puts that distance at its maximum.

At full reach the arm's own links already ask about 5.4 Nm of J2. A 1.20 kg part adds 10.2 Nm on top, so demand peaks at 15.75 Nm against a 12.00 Nm clamp. That is a 31% overdraw the drive cannot supply, so it clips. Everything downstream follows from the clip: err2 integrates for the whole 2.10 s the joint is pinned, bus_v sags to 44.76 V while the drive holds current limit, and tau2 falls 12.00 to 5.18 Nm within 1.1 s of the part leaving. That last step is the proof. If the mechanism had failed, torque would not have dropped to exactly the unloaded gravity line.

The envelope for a 1.20 kg part breaks at **0.702 m** of reach. The program crossed it at 54.34 s. Three fixes, cheapest first:

- Cap the part at 0.60 kg at this reach. That is 12.00 Nm minus the arm's 5.4 Nm, with a 20% dynamic margin.
- Re-teach the transfer to carry the part tucked inside 0.70 m and only extend on the final descent onto pad B.
- Change hardware on J2 only. J1 peaked at 15.93 Nm of a 26.0 Nm envelope and J3 at 7.24 Nm of 10.0 Nm, so J2 is the single binding axis.

{{ev:follow-err}} {{ev:drop}}`,
      evidence: ['follow-err', 'drop'],
    },
    {
      id: 'thermal',
      matchers: ['temp', 'hot', 'heat', 'overheat', 'thermal', 'driver', 'drv3', 'cool', 'health', 'battery', 'bus', 'voltage'],
      answer: `drv3 is the driver for J2, and it climbed **37.9 to 71.3 C** across 80 s without ever levelling off.

| window | drv3_temp | slope |
| --- | --- | --- |
| 0 to 40 s | 37.9 to 53.3 C | 0.384 C/s |
| 40 to 80 s | 53.3 to 71.3 C | 0.452 C/s |
| 53.9 to 58.0 s | +5.4 C | the pinned window alone |

This is duty, not a cooling fault. Heating goes as torque squared and tau2 runs 5.65 Nm rms over the mission, so the second half of the run is hotter simply because the driver has not caught up with its own losses yet. The slope steepening after 40 s is the saturated window plus the heat it left behind. Nothing derated at 71.3 C, but the curve is still rising when the mission ends, so an 80 s log does not tell you where it settles. Log a longer run before you trust the steady state.

Bus voltage is fine and corroborates the story: 47.8 V idle, 47.1 V typical, one 3.1 V sag to 44.76 V at 56.0 s while J2 sat on the current limit.

{{ev:overtemp}}`,
      evidence: ['overtemp'],
    },
    {
      id: 'other-joints',
      matchers: ['other', 'joint', 'joints', 'j1', 'j3', 'elbow', 'wrist', 'damage', 'damaged', 'broken', 'hardware', 'margin', 'headroom', 'safe'],
      answer: `No. J2 was the only axis outside its envelope, and nothing shows mechanical damage.

| joint | peak | clamp | used |
| --- | --- | --- | --- |
| J1 torso | 15.93 Nm | 26.0 Nm | 61% |
| J2 shoulder | 12.00 Nm | 12.0 Nm | 100% |
| J3 elbow | 7.24 Nm | 10.0 Nm | 72% |

J1 carries a larger absolute moment than J2 because it sits further down the chain, but it is geared for it. J2 is the tight axis. err_max tracks err2 exactly through the whole event, which means no other joint contributed a single degree of the lag, and every axis returned to under 1.2 deg of following error once the load left. Cycles 10 to 12 ran at nominal payload with a 9.11 Nm tau2 peak, the same as cycles 1 to 8. The arm is fine. The program is not.`,
      evidence: [],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'firmware', 'instrument', 'stream'],
      answer: `Describe the fields once, then log a record per servo cycle. The uploader runs on core 0, so the 50 Hz servo loop on core 1 is never blocked.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  // optional semantics so Alloy AI labels the streams precisely
  alloy.describe("joints", "q2",        "deg", -120, 120, "shoulder lift angle");
  alloy.describe("joints", "tau2",      "Nm",   -12,  12, "shoulder torque, 12 Nm clamp");
  alloy.describe("ctl",    "err2",      "deg",    0,  15, "J2 following error");
  alloy.describe("ee",     "grip",      "bool",   0,   1, "part seated in the jaws");
  alloy.describe("sys",    "drv3_temp", "C",      0, 110, "J2 driver heatsink");

  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/arm6");

  xTaskCreatePinnedToCore(servoLoop, "servo", 8192, nullptr, configMAX_PRIORITIES - 2, nullptr, 1);
}

void loop() { delay(1000); }

// 50 Hz servo loop. log() is a non-blocking memcpy, so it never disturbs the cycle.
void servoLoop(void*) {
  const TickType_t period = pdMS_TO_TICKS(20);
  TickType_t next = xTaskGetTickCount();
  uint32_t tick = 0;

  for (;;) {
    stepTrajectory();

    alloy.log("joints")
         .set("q0", joint[0].pos).set("q1", joint[1].pos).set("q2", joint[2].pos)
         .set("q3", joint[3].pos).set("q4", joint[4].pos).set("q5", joint[5].pos)
         .set("tau1", joint[1].torque).set("tau2", joint[2].torque)
         .set("tau3", joint[3].torque);

    alloy.log("ee")
         .set("x", tcp.x).set("y", tcp.y).set("z", tcp.z)
         .set("grip", gripper.seated());

    alloy.log("ctl")
         .set("err2", joint[2].followError())
         .set("err_max", worstFollowError());

    if ((tick++ % 5) == 0) {                      // housekeeping at 10 Hz
      alloy.log("sys")
           .set("bus_v", readBusVolts())
           .set("drv3_temp", driver[2].tempC());
    }

    vTaskDelayUntil(&next, period);
  }
}
\`\`\`

The free tier covers a robot at this rate. Every field on this page came out of \`alloy.log()\` calls exactly like those, and \`alloy.end()\` at the end of the program finalized the mission into one .mcap. Without \`end()\` the run finalizes about 10 minutes after the last record, so a power cut still keeps the data.`,
      evidence: [],
    },
  ],
  buildScene,
};
