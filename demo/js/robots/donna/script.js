// donna/script.js - the donna RobotDefinition. This is the first mission on the page whose
// telemetry is a real robot's real recorded log, and the copy below is written to that fact.
//
// Every number quoted in this file is registered in claims.mjs and bound to a decoded sample or to
// a named row of the frozen 20 row event ledger, so prose and payload cannot drift apart. Numbers
// are rendered through T() rather than typed as literals wherever the ledger holds them.
//
// TWO claims are BANNED on every surface, and the negative assertions in donna-script.test.mjs
// exist to keep them out:
//   (a) that the AlloyLogger Arduino library captured or recorded this log, and
//   (b) that an AlloyLogger production pipeline ingested or produced this replay.
// The truthful role split, which appears in BOTH `context.provenance` (the only def text that
// reaches the analyst's facts pack) and `chatProvenance` (the client-rendered line above the
// composer): recorded on the robot by its own ROS 2 rosbag2 logger, converted offline into this
// demo's replay format, replayed here.
//
// Identifier tokens that carry digits and are NAMES rather than claims: the event name
// "RoboCup German Open 2025", the stack name "ROS 2", the channel paths and field keys, and the
// composite transform tokens ("DERIVED_MAGNITUDE+RESAMPLED_20HZ" and friends, each one readable
// off `channels[].fields[].provenance.transform`).

import {
  channels,
  duration,
  rate,
  rates,
  rateNotes,
  buildData,
  findings,
  loadSceneData,
  isSceneDataLoaded,
  getSceneData,
  previewData,
  eventLines,
  eventsSection,
} from './data.js';
import { text as T } from './claims.mjs';
import { buildScene } from './scene.js';

/**
 * The posed moment for the picker card and the brief hero. Unlike battle and ssl this def resolves
 * ONE instant for both payloads: the decoder keeps the recording's absolute timestamps in the
 * preview slice as well as the full module, and the frozen preview window [237.0, 243.0] contains
 * this instant, so the same number poses both screens.
 *
 * 240.3 s sits inside the WALKING stretch that runs from 224.3 to 279.8, with Donna upright and the
 * ball visible at 0.265 m relative to Donna, in the buildup to the added-time goal. It is a healthy product shot by
 * contract: a hero pose never shows the failure, and this mission's failures are the falls.
 */
const T_HERO_S = 240.3;

/**
 * Hugh's approved factual attribution, verbatim on every surface that carries it. Named here so
 * every consumer quotes the one string and the leak gate's approvals key off stable content.
 */
const ATTRIBUTION =
  "Recorded onboard by Donna, the Hamburg Bit-Bots' Wolfgang-OP humanoid, during a RoboCup German " +
  'Open 2025 match. The team publishes their game logs openly; this replay is derived from that ' +
  'recording with thanks.';

/** The hardware interface's own first limit string for the ankle, quoted rather than paraphrased. */
const ANKLE_LIMIT_MESSAGE =
  `Invalid position for LAnklePitch: ${T('clampLAnklePitchValue')} not in ` +
  `(${T('clampLAnklePitchLow')}, ${T('clampLAnklePitchHigh')})`;

export default {
  id: 'donna',
  name: 'Donna, RoboCup humanoid',
  device: 'Wolfgang-OP humanoid · Hamburg Bit-Bots · onboard ROS 2 rosbag2 recording',
  tagline: 'A real recorded match. Six falls, six recoveries.',
  context: {
    system:
      'Donna is a Wolfgang-OP humanoid built and run by the Hamburg Bit-Bots at Universität ' +
      'Hamburg. Her onboard ROS 2 stack records what it publishes: torso IMU, walk commands ' +
      'against motion odometry, Dynamixel servo diagnostics, game-controller state, filtered ball ' +
      'estimates and system workload.',
    mission:
      'The second half of a refereed RoboCup German Open 2025 Humanoid League KidSize match. ' +
      `Donna starts penalized, re-enters play at ${T('penaltyReentryT')} s, falls and gets up ` +
      'again through the rest of the half, and her side finishes ahead after an added-time goal.',
    fault:
      `Donna goes down ${T('fallCount')} times in this half and gets up every time. The recording ` +
      'carries the whole arc each time: the acceleration spike on the torso IMU, the FALLING ' +
      'state, the getting-up animation, and often one of her own voice lines once she is upright.',
    faultT: 94.848,
    label: 'six falls, six recoveries',
    provenance:
      `${ATTRIBUTION} The role split is exact and it is the point: the robot's own ROS 2 rosbag2 ` +
      "logger recorded this mission at the match, an offline extractor converted that recording " +
      'into this demo\'s replay format, and this page replays it. The AlloyLogger Arduino library ' +
      'did not capture this log, and no AlloyLogger production pipeline ingested or produced this ' +
      'replay. Every summary series here is derived or resampled from the recording and carries ' +
      'the composite transform token that names each step applied to it: ' +
      'DERIVED_MAGNITUDE+RESAMPLED_20HZ and DERIVED_ANGLES+RESAMPLED_20HZ on the IMU, ' +
      'RESAMPLED_10HZ on command and odometry, DERIVED_DIAG_AGGREGATE+RESAMPLED_2HZ on the servo ' +
      'diagnostics, RESAMPLED_2HZ on game-controller state, DERIVED_DISTANCE+RESAMPLED_5HZ and ' +
      'DERIVED_BEARING+RESAMPLED_5HZ on the filtered ball estimate, and RESAMPLED_2HZ with ' +
      'DERIVED_RATIO+RESAMPLED_2HZ on onboard compute. A derived value is never presented as raw ' +
      'wire data.',
  },
  accent: '#2f78ff',
  duration,
  rate,
  // Genuinely mixed-cadence recording: `rate` is the summary DESIGN.md requires, `rates` and
  // `rateNotes` are the fact, and the facts builder emits a cadence line per channel from them.
  rates,
  rateNotes,
  channels,
  buildData,
  findings,
  // Facts-pack budget knob, and it is load-bearing here. Six channels give the builder's default
  // of 53 points per series, which measures the Donna pack at 31,751 chars and busts the frozen
  // 31,500-char ceiling. The frozen cut order is series points first (toward the 40 floor), then
  // analyses count, and NEVER the disclosure, provenance, attribution or event rows, so the table
  // is what gives: 48 points measures 31,003 chars and leaves real headroom for copy review.
  // data.js still exports the unpinned 53 as the six-channel default it is.
  factsSeriesPoints: 48,
  // The recorded replay loads lazily: data.js ships channel metadata and a decoded 6 s preview
  // slice, and the full recorded module arrives only on the demo route. app.js awaits this before
  // ensureData, and `previewData` is what tells the picker and the brief there is a scene here
  // without building this mission's telemetry.
  previewData,
  loadSceneData,
  isSceneDataLoaded,
  getSceneData,
  // Def-owned loading-card copy. "Recorded" is the true word on this mission and it is spent here.
  loadingCopy: {
    line: 'Loading the recorded mission.',
    cap:
      'Recorded onboard at a real RoboCup match. Six telemetry channels and the full-body replay, ' +
      'decoded in your browser.',
  },
  // Typed rows for the facts pack: penalty re-entry, the six fall arcs, the six recorded voice
  // lines, the warning summaries, the goal, the READY/SET blip and the whistle. Callable only
  // after loadSceneData resolves; build-facts awaits that.
  eventLines,
  // The ledger mixes referee-visible match state with the robot's own diagnostics, so the default
  // "Round events / Referee-visible events" heading would be false here. data.js owns the strings.
  eventsSection,
  heroTime() {
    return T_HERO_S;
  },
  /**
   * A deterministic, client-rendered disclosure pinned above the composer for the session. It is
   * DOM the page writes itself from this def, never a model answer, and it carries the same role
   * split as `context.provenance` so the visitor and the analyst read the same truth.
   */
  chatProvenance:
    'Real recorded mission: captured onboard by the robot\'s ROS 2 logger at RoboCup German Open ' +
    '2025, converted offline for this demo, and replayed here. Not captured by the AlloyLogger ' +
    'library.',
  firstQuestion: 'How many times did Donna fall in this match, and did she get up?',
  suggested: [
    'Show me the first fall.',
    'Did the battery cause the falls?',
    'How hot did the servos get?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'falls-and-recoveries',
      matchers: ['fall', 'fell', 'how many', 'get up', 'got up', 'recover', 'down', 'six'],
      answer: `${T('fallCount')} times, and she got up after every one.

| fall onset | recovery |
| --- | --- |
| ${T('fall1T')} s | ${T('fall1RecoveryRoundedS')} s |
| ${T('fall2T')} s | ${T('fall2RecoveryRoundedS')} s |
| ${T('fall3T')} s | ${T('fall3RecoveryRoundedS')} s |
| ${T('fall4T')} s | ${T('fall4RecoveryRoundedS')} s |
| ${T('fall5T')} s | ${T('fall5RecoveryRoundedS')} s |
| ${T('fall6T')} s | ${T('fall6RecoveryRoundedS')} s |

Every row is a recorded state transition, not an inference. The humanoid control module publishes FALLING, then GETTING_UP, then walking again, and recovery is measured from GETTING_UP to the first WALKING state. All ${T('recoveryCount')} land inside ${T('recoveryCeilingS')} s. The last fall differs in definition only: the final whistle arrives before Donna walks again, so its recovery runs from GETTING_UP to the first CONTROLLABLE state instead.

The torso IMU agrees with the state machine. Peak acceleration magnitude across the six impacts runs from ${T('fall1PeakAccelMps2')} to ${T('fall5PeakAccelMps2')} m/s^2, and each spike sits on the onset in the row beside it.

{{ev:falls-recoveries}}`,
      evidence: ['falls-recoveries'],
    },
    {
      id: 'show-the-fall',
      // "first fall" alone is unreachable: it ties the earlier entry's "fall" at one point and
      // source order hands the tie to falls-and-recoveries. The longer phrase carries "show" with
      // it, so the visitor's actual question scores two here and routes where it reads.
      matchers: ['show', 'where', 'see', 'replay', 'watch', 'show me the first fall', 'point me'],
      answer: `Here it is. The chip loops the first fall and plays it back slowed down.

The acceleration spike, the pitch and roll excursion and the state change all land together at ${T('fall1T')} s, and the highlight follows Donna's body through the getting-up animation that starts a moment later.

{{ev:falls-recoveries}}`,
      evidence: ['falls-recoveries'],
    },
    {
      id: 'battery-sag',
      matchers: ['battery', 'sag', 'volt', 'power', 'cause', 'root cause', 'why', 'fix', 'pack'],
      answer: `The rail does sag, and the sag lines up with the later falls. It does not explain them.

| observation | value |
| --- | --- |
| "Power getting low" statuses | ${T('undervoltageCount')} |
| lowest positive bus voltage | ${T('minBusVoltageV')} V |
| when that minimum lands | ${T('servoUndervoltageT')} s |

Those statuses come from the servos themselves, and they cluster in the later part of the recording rather than spreading evenly across it. The falls at ${T('fall4T')} s, ${T('fall5T')} s and ${T('fall6T')} s sit in the same stretch. That is a correlation inside one match log, and one log cannot separate a weakening pack from the load of a robot that has already been down several times, from contact with the opposing team, or from all three together. This log does not establish battery sag as the cause of anything.

What would settle it is more logging rather than more reasoning: pack voltage and per-servo bus voltage on the same clock as the gait state, across several matches, so the ordering of sag and fall is visible in each one.

{{ev:battery-sag}}`,
      evidence: ['battery-sag'],
    },
    {
      id: 'servo-health',
      matchers: ['hot', 'servo', 'temp', 'heat', 'health', 'undervoltage', 'clamp', 'limit', 'dynamixel', 'motor'],
      answer: `Slow burn rather than a spike. The servo picture drifts across the whole half and never jumps.

Maximum servo temperature climbs steadily through the recording, which is what a Dynamixel chain looks like under continuous gait load rather than a fault signature. Underneath it the undervoltage statuses accumulate, ${T('undervoltageCount')} of them, with the lowest positive bus voltage at ${T('minBusVoltageV')} V at ${T('servoUndervoltageT')} s.

The command side leaves its own trail. The hardware interface clamped ${T('clampLAnklePitchCount')} LAnklePitch commands, ${T('clampRElbowCount')} RElbow commands and ${T('clampLElbowCount')} LElbow commands against its configured limits, and it quotes those limits itself:

\`${ANKLE_LIMIT_MESSAGE}\`

Those are the interface's own limit strings, not the model's, and they read as a controller asking for slightly more travel than the joint config allows. Worth watching across matches, not worth a teardown.

{{ev:servo-command-clamps}}

{{ev:battery-sag}}`,
      evidence: ['servo-command-clamps', 'battery-sag'],
    },
    {
      id: 'how-log',
      matchers: [
        'log',
        'arduino',
        'sketch',
        'code',
        'library',
        'esp32',
        'own robot',
        'my robot',
        'firmware',
        'instrument',
        'alloylogger',
        'record',
        'capture',
      ],
      answer: `Honest answer first: nothing on this page came out of an \`alloy.log()\` call.

Donna's own ROS 2 rosbag2 logger recorded this mission onboard at the match. An offline extractor converted that recording into the replay format this demo uses, and this page replays it. The AlloyLogger Arduino library did not capture it, and no AlloyLogger production pipeline ingested or produced it.

What the library is for is getting comparable fields off your own robot, which would look like this:

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/your-humanoid");
}

void gaitLoop() {            // your existing control loop, at whatever rate it already runs
  alloy.log("imu")
       .set("accelMag", imu.accelMagnitude())
       .set("pitchDeg", imu.pitchDeg())
       .set("rollDeg", imu.rollDeg());
  alloy.log("servos")
       .set("maxTempC", servos.maxTemperature())
       .set("minBusV", servos.minBusVoltage());
  alloy.log("gait")
       .set("cmdVx", cmd.vx)
       .set("odomVx", odom.vx)
       .set("state", gait.stateName());
}
\`\`\`

One habit from this recording is worth copying whatever you log with. Donna's own udp_bridge_sender filled its outbound queue and dropped ${T('streamDroppedCount')} messages from the live stream, while the onboard recording kept all of them. Record locally first and treat the live stream as best effort.

{{ev:stream-backpressure}}`,
      evidence: ['stream-backpressure'],
    },
    {
      id: 'speak-lines',
      // The natural phrasing names the falls, so "say" on its own only ties the earlier fall entry
      // and loses the tie to source order. The full phrase scores alongside "say" and wins.
      matchers: ['say', 'said', 'speak', 'voice', 'talk', 'toy', 'shout', 'complain', 'what did donna say'],
      answer: `Donna talks.

The recorded \`/speak\` topic carries six utterances in this half, four distinct lines, and they land next to the falls.

| t | line |
| --- | --- |
| ${T('speak1T')} s | "I am not a toy." |
| ${T('speak2T')} s | "I am not a toy." |
| ${T('speak3T')} s | "Look at this! This is not how you play soccer." |
| ${T('speak4T')} s | "Do you think this is funny?" |
| ${T('speak5T')} s | "I am not feeling well." |
| ${T('speak6T')} s | "Look at this! This is not how you play soccer." |

They are ledger rows quoted verbatim from the recording, not narration written for this demo. The last one is the best timed of the set: her side scores at ${T('goalT')} s with the recorded clock already past zero at ${T('secondsRemainingAtGoal')} s, Donna goes down again at ${T('fall6T')} s, the complaint arrives at ${T('speak6T')} s, and the final whistle follows at ${T('finalWhistleT')} s with the match won ${T('scoreFinalOwn')}-${T('scoreRival')}.

{{ev:added-time-finish}}`,
      evidence: ['added-time-finish'],
    },
  ],
  buildScene,
};
