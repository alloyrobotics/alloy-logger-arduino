// drone/script.js - the survey quadcopter RobotDefinition.
// Every number quoted in an answer below was read out of the generator in data.js, not estimated.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

export default {
  id: 'drone',
  name: 'Survey quadcopter',
  device: 'ESP32 · 4x ESC telemetry · GPS + baro',
  tagline: 'One motor dies mid-survey',
  // Authored volume: 67,516 values across 4 channels, read off the built arrays under node
  // (/att 4501 x 3, /pos 4501 x 3, /motors 4501 x 8, /bat 2251 x 2), not derived from rate x duration.
  context: { system: 'A survey quadcopter streaming per-motor ESC telemetry plus GPS, barometer and attitude at 50 Hz.', mission: 'A 90-second lawnmower pattern at 6 m altitude, fixed waypoints, no operator input.', fault: '2 m of altitude gone mid-leg and 16 degrees off heading. The controller never gets either back, and the mission ends in a failsafe descent. The flight plan never changed.', faultT: 61.2, label: 'altitude dip', datapoints: 67516, channels: 4,
    // The picker card's line: authored short, fault first. See sbr/script.js.
    cardProblem: 'Loses 2 m of altitude and 16 degrees of heading mid-leg.' },
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
      answer: `Motor 3's bearing let go. The controller covered for it from 38 s and ran out of throttle at **61.2 s**.

| metric | value |
| --- | --- |
| pwm3 | 100% railed (others ~60%) |
| rpm3 | 5,270 → 2,630 |
| altitude | dipped 6.0 → 3.9 m |
| yaw | -18 deg off the lane |

Nothing hit the ground: 92% of the survey was already flown.

{{ev:dip}}`,
      evidence: ['dip'],
    },
    {
      id: 'show-me',
      matchers: ['show', 'show me', 'where', 'see', 'replay', 'watch', 'exactly', 'moment', 'look'],
      answer: `Looping it at 0.4x, motor 3 lit. Watch its disc slow while the other three spin up, then the 2.1 m drop and the 18 deg heading swing.

{{ev:dip}}`,
      evidence: ['dip'],
    },
    {
      id: 'root-cause',
      matchers: ['cause', 'root', 'motor', 'motor 3', 'bearing', 'fix', 'rpm', 'pwm', 'throttle', 'diverg', 'm3', 'prop', 'esc'],
      answer: `Same rpm, more throttle. That gap is the whole diagnosis.

| t | pwm3 vs others |
| --- | --- |
| 38 s | 62.5% vs 60.1% |
| 55 s | 90.2% vs 59.9% |
| 61 s | **100% vs 63.5%** |

Altitude and attitude looked clean the whole time; the wear was hidden in throttle. Fix: new bell bearings, plus an alert when any motor sits 8 points above the fleet median for 5 s. Here that fires at **48.8 s**, 12 seconds before it lost a metre.

{{ev:motor-wear}}`,
      evidence: ['motor-wear', 'dip'],
    },
    {
      id: 'battery',
      matchers: ['battery', 'bat', 'pack', 'volt', 'power', 'sag', 'cell', 'charge', 'health', 'current', 'amp'],
      answer: `The pack is healthy; it is reporting the motor. Mean current rose **37%** at 40 s on the same lanes at the same speed, because a binding bearing is a heater. Lowest cell was 3.25 V under load. Alone, \`/bat\` looks like a tired pack; crossed with \`/motors\` it is one motor eating the difference.

{{ev:battery}}`,
      evidence: ['battery'],
    },
    {
      id: 'landing',
      matchers: ['land', 'crash', 'safe', 'failsafe', 'descend', 'descent', 'damage', 'survive', 'recover', 'end'],
      answer: `No, a controlled failsafe descent: down at 70.0 s, touched at **77.7 s**, peak 0.86 m/s. It drifted 3.4 m downrange and kept a -9.7 deg heading error, which is what losing a whole motor's yaw authority looks like.`,
      evidence: [],
    },
    {
      id: 'how-log',
      matchers: ['log', 'arduino', 'sketch', 'code', 'library', 'esp32', 'own robot', 'my robot', 'instrument', 'stream'],
      answer: `One call per control cycle. \`log()\` is a non-blocking memcpy; the uploader runs on the other core.

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.describe("motors", "pwm3", "%", 0, 100, "motor 3 mixer output");
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/drone");
}

void logCycle() {   // right after your mixer, 50 Hz
  alloy.log("att").set("roll", ahrs.roll).set("yaw", ahrs.yaw);
  alloy.log("motors")
       .set("rpm3", esc[2].rpm).set("pwm3", mix[2]);
  alloy.log("bat").set("v", pack.volts).set("a", pack.amps);
}

void onDisarm() { alloy.end(); }
\`\`\`

Every number on this page came from calls like those. Free tier covers a vehicle this size.`,
      evidence: [],
    },
  ],
  buildScene,
};
