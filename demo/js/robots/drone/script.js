// drone/script.js - the survey quadcopter RobotDefinition.
// Every number quoted in an answer below was read out of the generator in data.js, not estimated.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

export default {
  id: 'drone',
  name: 'Survey quadcopter',
  device: 'ESP32 · 4x ESC telemetry · GPS + baro',
  tagline: 'Lawnmower survey, 90 s mission',
  accent: '#4dd0e1',
  duration,
  rate,
  channels,
  buildData,
  findings,
  firstQuestion: 'What went wrong on the survey flight?',
  suggested: [
    'Show me exactly where it failed',
    'What caused the motor to fail?',
    'Is the battery a factor?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'why-failed',
      matchers: ['wrong', 'went', 'survey', 'flight', 'happen', 'why', 'fail', 'problem', 'issue', 'mission'],
      answer: `Motor 3's bearing let go. The flight controller had been covering for it since 38 s and ran out of throttle to cover with at **61.2 s**.

| metric | at the break | expected |
| --- | --- | --- |
| pwm3 | 100 %, railed since 57.5 s | 60 % |
| rpm3 | 5,270 falling to 2,630 | 6,100 |
| alt | 3.90 m at 62.3 s | 6.00 m |
| yaw | -18.0 deg at 61.8 s | 0 +/- 1 deg |

pwm3 climbed for twenty seconds just to hold the same rpm as the other three, and hit the 100 % ceiling at 57.5 s. After that the bearing took whatever it wanted: rpm3 fell 14 % over the next 3.7 s, then collapsed to 19 % of rated thrust when the race bound at 61.2 s. Motors 1, 2 and 4 were up from 63.5 % to 85.7 % throttle inside 1.7 s, but holding roll and pitch with one corner gone costs collective, and the aircraft was already 2.1 m lower by 62.3 s.

Nothing hit the ground. It flew 92 % of the survey before this happened.

{{ev:dip}}`,
      evidence: ['dip'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'show me', 'where', 'see', 'replay', 'watch', 'exactly', 'moment', 'look'],
      answer: `Looping 58 to 66 s at 0.4x, motor 3 highlighted.

Watch its blur disc thin out while the other three spin up hard, then the 2.1 m drop and the heading swinging 18 deg off the lane. The flown track behind the aircraft turns red at 61.2 s.

{{ev:dip}}`,
      evidence: ['dip'],
    },
    {
      id: 'root-cause',
      matchers: ['cause', 'root', 'motor', 'motor 3', 'bearing', 'fix', 'rpm', 'pwm', 'throttle', 'diverg', 'm3', 'prop', 'esc'],
      answer: `Same rpm, more throttle. That gap is the entire diagnosis.

| t | pwm3 | pwm 1/2/4 | rpm3 vs 1/2/4 |
| --- | --- | --- | --- |
| 38 s | 62.5 % | 60.1 % | 6,105 vs 6,110 |
| 45 s | 70.0 % | 60.6 % | 6,161 vs 6,162 |
| 55 s | 90.2 % | 59.9 % | 6,099 vs 6,098 |
| 61 s | 100 % | 63.5 % | 5,270 vs 6,447 |

Right up to 57.5 s motor 3 was turning exactly the same rpm as its neighbours, so \`/pos\` and \`/att\` looked clean and no altitude or attitude alarm could have fired. The whole cost was hidden in throttle: 30 extra points of pwm to spin the same prop at the same speed. That is mechanical drag inside the motor, not an ESC calibration problem and not a prop problem, because a fouled prop would have shown up in rpm immediately.

The rumble backs it up. rpm3 peak-to-peak went from 55 rpm at 35 s to 1,101 rpm at 58 s, at a steady 4.2 Hz, and the same 4.2 Hz bleeds into \`/att\` roll on the straight lanes (0.97 deg peak-to-peak at 33 to 38 s, 3.78 deg at 57 to 60 s).

**Fix.** Replace the motor 3 bell bearings before the next flight and check the other three for the same wear pattern. Then put a rule on the throttle spread: alert when any motor's pwm sits more than 8 points above the fleet median for 5 s. On this flight that confirms at **48.8 s**, twelve seconds of warning before the aircraft lost a single metre.

{{ev:motor-wear}}`,
      evidence: ['motor-wear', 'dip'],
    },
    {
      id: 'battery',
      matchers: ['battery', 'bat', 'pack', 'volt', 'power', 'sag', 'cell', 'charge', 'health', 'current', 'amp'],
      answer: `The pack is healthy. It is reporting the motor.

| window | mean current | pack slope |
| --- | --- | --- |
| 10 to 38 s | 14.3 A | 30 mV/s |
| 42 to 60 s | 19.6 A | 49 mV/s |
| 70 to 77 s, descending | 25.4 A | still elevated |

16.80 V at arm, 13.90 V at shutdown, 410 mAh out for a 78 s flight. The curve bends at 40 s and it bends because a binding bearing is a heater: mean current rose 37 % while the aircraft flew the same lanes at the same speed. Deepest point was **13.01 V at 78.2 s**, under load, which is 3.25 V a cell. Nothing there is a cell fault.

If you only had \`/bat\`, this flight would look like a tired pack. Cross it with \`/motors\` and it is one motor eating the difference.

{{ev:battery}}`,
      evidence: ['battery'],
    },
    {
      id: 'landing',
      matchers: ['land', 'crash', 'safe', 'failsafe', 'descend', 'descent', 'damage', 'survive', 'recover', 'end'],
      answer: `No. That was a controlled failsafe descent, not a crash.

At 63.8 s the controller stopped fighting for 6 m and held what it had, 4.57 m. It sat there for six seconds, started down at 70.0 s and touched at **77.7 s**. Peak descent rate was 0.86 m/s, well inside a normal landing.

Two things it did not get back: it drifted 3.4 m downrange on the way down, because failsafe holds attitude and not position, so it landed about 0.5 m outside the survey box. And the heading error never recovered, sitting at -9.7 deg at touchdown, which is what you expect when the yaw authority you lost is a whole motor.

92 % of the pattern was already flown when the bearing went: 104.8 m of a 114 m track, lane 4 of 5.`,
      evidence: [],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'instrument', 'stream'],
      answer: `Same as this flight. Describe the fields once, then log a record per control cycle.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  // semantics once, so Alloy AI knows what each stream is and what normal looks like
  alloy.describe("att",    "roll", "deg",  -90,    90, "fused roll");
  alloy.describe("att",    "yaw",  "deg", -180,   180, "heading");
  alloy.describe("pos",    "alt",  "m",      0,    60, "altitude above launch");
  alloy.describe("motors", "rpm3", "rpm",    0, 12000, "motor 3, ESC telemetry");
  alloy.describe("motors", "pwm3", "%",      0,   100, "motor 3, mixer output");
  alloy.describe("bat",    "v",    "V",     12,    17, "4S pack voltage");

  alloy.wifi(WIFI_SSID, WIFI_PASS);   // omit if the link is already up
  alloy.scope();                      // ESC and I2C pins appear automatically in "io"
  alloy.begin(ALLOY_KEY, "robots/drone");
}

// 50 Hz, called from the flight controller loop right after the mixer
void logCycle() {
  alloy.log("att")
       .set("roll", ahrs.roll).set("pitch", ahrs.pitch).set("yaw", ahrs.yaw);

  alloy.log("pos")
       .set("x", nav.x).set("y", nav.y).set("alt", nav.alt);

  alloy.log("motors")
       .set("rpm1", esc[0].rpm).set("rpm2", esc[1].rpm)
       .set("rpm3", esc[2].rpm).set("rpm4", esc[3].rpm)
       .set("pwm1", mix[0]).set("pwm2", mix[1])
       .set("pwm3", mix[2]).set("pwm4", mix[3]);

  alloy.log("bat").set("v", pack.volts).set("a", pack.amps);
}

void onDisarm() {
  alloy.end();   // finalizes the mission file immediately
}
\`\`\`

\`log()\` is a non-blocking memcpy, so it is safe inside a 50 Hz loop, and the uploader runs on the other core. The free tier covers a vehicle like this one. Every number on this page came out of calls exactly like those: 4,501 rows on each 50 Hz channel, 2,251 rows of ESC telemetry, and \`alloy.end()\` finalized \`drone-01.mcap\` on disarm.

The point of \`describe()\` is what you just read above. Without units and ranges, pwm3 climbing to 100 is a number. With them, it is a motor running out of headroom.`,
      evidence: [],
    },
  ],
  buildScene,
};
