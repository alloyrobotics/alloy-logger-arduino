// sbr/script.js - the sbr RobotDefinition. Every number quoted in an answer below is read back
// out of buildData(), not asserted from memory: the fall timings, the three output slams, the
// step ceiling percentage, the heap endpoints and the I2C outliers are all verifiable against
// the arrays this robot ships.

import { channels, duration, rate, buildData, findings } from './data.js';
import { buildScene } from './scene.js';

/**
 * The OPENER in the HOBBYIST register, which is the role this mission is guided into.
 *
 * Keyed on `hobbyist` and nothing else. Until roles v2 this const was `OPENER_SUPPORT`, keyed on
 * `support` and `operator`: both of those ids are retired, `role.js` degrades them to `engineer`
 * BEFORE `chat.js`'s `answerFor()` ever reads this map, so those keys could not be selected again
 * and every hobbyist was silently served the engineer table on the one answer they are guided to.
 * A register map may only ever be keyed on a live role id.
 *
 * Same table, same numbers, same instant as the engineer answer: a register is a way of reading one
 * measurement, not a second measurement. Same `{{ev:fall}}` token, so the opener's auto-beat fires
 * whatever the role. Length within 20% of the engineer answer, so the panel does not reflow.
 */
const OPENER_HOBBYIST = `Nothing broke and nothing stalled. The wobble grew until it went over at **51.7 s**.

| metric | value |
| --- | --- |
| pitch swing | -2.0 → +7.1 → -10.1 deg in 340 ms |
| d term | 0.000, all 3651 samples |
| step peak | +5366 / -4226 steps/s |
| down / up again | 52.0 s / 58.2 s |

Three corrections in 400 ms, each one weaker than the last. The d term is the one that fights a wobble and it sat at 0.000 the whole run, so set \`KD\` on the next flash, start it near \`KP/12\`, and run this same soak again.

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
  context: { system: 'An ESP32 closing a 50 Hz PID balance loop on a BNO055 IMU, driving two stepper motors.',
    // The honesty line. sbr is off the public picker since the UX wall port (hobbyist now routes
    // to arm6) but stays directly routable, and its legacy brief keeps exactly two things: the
    // system line and this. Without it the screen names real hardware, the
    // mock prints values in that hardware's own format, and nothing anywhere says the run is
    // generated - the analyst's facts pack included, since build-facts.mjs renders this same
    // sentence into it. A simulated bench robot has to say so in the same words on both sides.
    provenance: 'A simulated bench robot: the balance loop, the fall and every sample below are generated in your browser, not recorded off hardware.',
    mission: 'A 73-second soak test: hold upright on flat ground and stream every control cycle to the mesh.', fault: 'A pitch oscillation grows over about a second and the robot goes face-down, wheels still driving. Every cycle of the loop that lost it is in the log.', faultT: 51.7, label: 'fall', datapoints: 38703, channels: 2,
    // The picker card's line. Authored short and fault first: the card holds about 80 characters,
    // and cutting the brief prose down to its first sentences still clipped the fault off the
    // bottom of every card, which is the half that earns the click.
    cardProblem: 'A pitch wobble grows and it goes face-down at 51.7 s, wheels still driving.' },
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
  /**
   * THE GUIDED FLOW, as data. This is the shape all three guided missions ship (sbr inline, ssl in
   * `ssl/role-openers.js`, battle in `battle/guided.js`); the other four defs ship no `choreo` at
   * all and keep the current all-at-once layout, which is what makes this opt-in rather than a
   * rewrite of every mission.
   *
   * `beats` is ORDERED and runs 1, 2, 3. Each beat reveals one panel, the agent says one thing
   * about what just appeared, one action drives the timeline, one hint names what to try, and the
   * visitor's own tap on `cta` is the only thing that advances. Never auto-advance: the whole point
   * of the beat is that the visitor caused it.
   *
   *   id         stable analytics value for beat_shown / beat_cta_clicked. Never renamed.
   *   reveal     which panel this beat brings on screen: 'chat' | 'chart' | 'stage'.
   *   answer     BEAT 1 ONLY. The id of the scripted entry whose answer plays. It is a REFERENCE,
   *              not a copy: the opener below is the answer that was written, reviewed, and read
   *              back out of buildData(), and it is also what build-facts.mjs renders into the
   *              facts pack. Duplicating it here would give the page two openers that drift apart
   *              and the analyst a third. The question asked is `firstQuestion`, unchanged.
   *   say        the agent's own line for this beat, in the ENGINEER register, and always present.
   *   sayByRole  a PARTIAL map, keyed by role id, carrying only the registers that genuinely read
   *              differently. Any role not keyed here reads `say`, so an unknown role, a visitor
   *              who never forked and a role whose register adds nothing all take one path. Same
   *              facts either way: every number below is read off this def's own findings or its
   *              scripted answers, and no variant carries a number another variant contradicts. A
   *              register may drop a number the other one keeps (the hobbyist walk quotes the 3651
   *              samples once, in beat 1, where the engineer walk quotes them in beat 2) but it may
   *              never quote a different value for the same thing.
   *   actions    ordered `{ do, evidence }`. `evidence` names one of this def's own findings and
   *              the ENGINE reads the window, the instant, the focus channel, the highlighted part
   *              and the slow-motion flag off it. Nothing about the failure window is restated
   *              here, so this cannot drift away from `findings` the way a second copy would.
   *              `do: 'chart'` focuses the plot on that finding; `do: 'replay'` loops its window in
   *              the 3D scene with its part lit.
   *   hint       one interaction prompt, naming something the panel that just appeared can
   *              actually do. Not a slogan: every verb here is wired.
   *   cta        the label on the button that advances. The last beat's hands over to free
   *              exploration in the full layout, and the signup popup arms on the first user
   *              interaction after that.
   *
   * The register here is the HOBBYIST one, because this is the mission that role is guided into:
   * plain maker language, no jargon that is not on the plot in front of them. The engineer default
   * is the same walk in the same order with the same numbers, said tighter.
   */
  choreo: {
    beats: [
      {
        id: 'answer',
        reveal: 'chat',
        answer: 'why-fall',
        say: 'Seventy-three seconds of a balance loop, every control cycle logged. It held for 51 of them and then it did not. Start with the question you would actually ask.',
        sayByRole: {
          hobbyist:
            // "Your robot", on a run this def generates in the browser, was the one line on the
            // guided hobbyist path that turned a missing disclosure into a claim. `context
            // .provenance` now carries the disclosure and this says whose robot it is not.
            'This robot ran for 73 seconds and every pass of the balance loop went into the log, 3651 of them. It stayed up for 51 seconds. Ask it what happened.',
        },
        cta: 'Show me the moment it went',
      },
      {
        id: 'chart',
        reveal: 'chart',
        actions: [{ do: 'chart', evidence: 'fall' }],
        say: 'Pitch and output, zoomed to 50.5 to 58.5 s. The swing runs -2.0 to +7.1 to -10.1 deg in 340 ms and each correction comes back weaker than the last. The d term is 0.000 for all 3651 samples, so nothing in the loop is opposing the rate of change.',
        sayByRole: {
          hobbyist:
            'The plot is on the 8 seconds around the fall. Watch the wobble grow: -2.0 deg, then +7.1, then -10.1, all inside 340 ms, and every push back smaller than the last. The d term reads 0.000 the whole run. It was never switched on.',
        },
        hint: 'Click anywhere on the plot to send the replay to that instant, or pick another channel from the list to see what the rest of the board was doing.',
        cta: 'Put it on the replay',
      },
      {
        id: 'replay',
        reveal: 'stage',
        actions: [{ do: 'replay', evidence: 'fall' }],
        say: 'The same window at 0.4x, looping, body lit. Three slams at 51.5 to 51.9 s, down at 52.0 s, and the steppers are still commanding +5366 and -4226 steps/s with the robot on its face. Back upright at 58.2 s.',
        sayByRole: {
          hobbyist:
            'Here it is at 0.4x, looping, chassis lit. Three hard corrections between 51.5 and 51.9 s, on its face by 52.0 s, and the motors still driving at +5366 and -4226 steps/s while it lies there. Nothing broke. It just ran out of the thing that stops a wobble.',
        },
        hint: 'Drag the scene to orbit, scroll to zoom, and drag the scrubber to walk the fall frame by frame.',
        cta: 'Let me drive',
      },
    ],
  },
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
      // exactly as it did before roles existed. Every other key must be a LIVE role id: a retired
      // id is degraded to `engineer` in role.js before this map is read, so keying one here is a
      // dead string that reads as a register nobody can reach.
      answerByRole: { hobbyist: OPENER_HOBBYIST, lead: OPENER_LEAD },
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
