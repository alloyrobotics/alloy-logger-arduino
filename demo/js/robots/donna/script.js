// donna/script.js - the Donna, Jack and Rory RobotDefinition.
//
// Donna remains the chart protagonist. The scene and aligned event ledger add Jack and Rory from
// their independently recorded onboard logs. Every visitor-facing number below is registered in
// claims.mjs and bound to a decoded sample or one frozen event-ledger row.
//
// TWO claims are banned on every surface:
//   (a) that the AlloyLogger Arduino library captured or recorded these logs, and
//   (b) that an AlloyLogger production pipeline ingested or produced this replay.
// The truthful role split appears verbatim in context.provenance and chatProvenance.

import {
  channels,
  duration,
  rate,
  rates,
  rateNotes,
  buildData,
  findings,
  factsSeriesPoints,
  loadSceneData as loadMissionData,
  isSceneDataLoaded,
  getSceneData,
  previewData,
  eventLines,
  eventsSection,
} from './data.js';
import { text as T, value as V } from './claims.mjs';
import { buildScene } from './scene.js';

/** Healthy three-robot product shot, frozen by the Phase 1 verifier. */
const T_HERO_S = V('heroTime');

/** Hugh's approved factual attribution, verbatim. */
const ATTRIBUTION =
  'Three Wolfgang-OP humanoids of the Hamburg Bit-Bots (Universitat Hamburg), recorded at ' +
  'RoboCup German Open 2025.';

/** Frozen recording-path wording, verbatim on both provenance surfaces. */
const ROLE_SPLIT =
  'recorded independently on each robot by its onboard rosbag2 logger; converted offline for this demo; replayed here.';

/**
 * The four-step connect-flow experience, merged onto the def when the recorded payload lands.
 *
 * It lives behind a dynamic import for the reason `experience.js` gives in full: script.js is eager
 * on every visitor who opens the picker and none of the flow's copy, windows or anchors can be read
 * before the payload exists. This side stays one call, and a module that will not load leaves
 * `experience` unset so the mission falls back to the legacy brief instead of stranding the route.
 * `hasExperience` below is the static flag routing reads before any of this has run.
 */
let experiencePromise = null;
function loadExperience() {
  if (!experiencePromise) {
    experiencePromise = import('./experience.js').then(
      (mod) => {
        if (mod && mod.applyExperience) mod.applyExperience(def);
      },
      (err) => {
        console.warn('[donna] mission experience unavailable; the legacy brief is used', err);
      },
    );
  }
  return experiencePromise;
}

const def = {
  id: 'donna',
  name: 'Donna, Jack & Rory',
  device: 'Three Wolfgang-OP humanoids · Hamburg Bit-Bots · onboard ROS 2 rosbag2 recordings',
  tagline: 'One match. Three onboard logs. Jack falls 3 times.',
  context: {
    system:
      'Donna, Jack and Rory are Wolfgang-OP humanoids built and run by the Hamburg Bit-Bots. ' +
      'Each robot recorded its own ROS 2 streams onboard. Donna supplies the telemetry charts; all ' +
      'three robots supply the aligned body replay and event ledger.',
    mission:
      'The closing stretch of a RoboCup German Open 2025 Humanoid League KidSize match. Rory ' +
      `re-enters at ${T('roryReentryT')} s, the score moves to ${T('scoreAtFirstGoalOwn')}-` +
      `${T('scoreRival')}, Donna serves a penalty off-field, and the side closes a ` +
      `${T('scoreAtSecondGoalOwn')}-${T('scoreRival')} win in added time.`,
    fault:
      `Jack falls ${T('jackFallCount')} times and recovers to WALKING after every fall while Donna ` +
      `and Rory record ${T('donnaFallCount')} and ${T('roryFallCount')} falls. The replay holds ` +
      "Jack's last observed field pose during each localization outage while his recorded joints, " +
      'torso attitude and control state continue.',
    faultT: V('jackFall1T'),
    label: `Jack falls ${T('jackFallCount')} times; Donna and Rory stay up`,
    provenance:
      `${ATTRIBUTION} The role split is exact: ${ROLE_SPLIT} The AlloyLogger Arduino library did ` +
      'not capture these logs, and no AlloyLogger production pipeline ingested or produced this ' +
      'replay. Donna alone supplies the six chart groups. Every chart series is derived or resampled ' +
      'from her recording and carries the transform token that names the operation: ' +
      'DERIVED_MAGNITUDE+RESAMPLED_NEAREST_20HZ and DERIVED_ANGLES+RESAMPLED_NEAREST_20HZ on the ' +
      'IMU; CMD_ZOH_10HZ, ODOM_NEAREST_10HZ and CMD_ANGULAR_Z_ZOH_10HZ on motion; ' +
      'DERIVED_DIAGNOSTIC_AGGREGATE+ZOH_2HZ on servo diagnostics; ' +
      'DONNA_MASTER_GAMESTATE+ZOH_2HZ on game state; ' +
      'MAP_FRAME_DIFFERENCE_TO_DONNA+VALIDATED_MASK_5HZ and ' +
      'MAP_FRAME_DIFFERENCE_TO_DONNA+WRAPPED_BEARING+VALIDATED_MASK_5HZ on the filtered ball; ' +
      'RESAMPLED_NEAREST_2HZ and DERIVED_RATIO+RESAMPLED_NEAREST_2HZ on onboard compute. A derived ' +
      'value is never presented as raw wire data.',
    /**
     * Row-times-field total across Donna's six summary series:
     * /imu 5001 x 3, /motion 2501 x 3, /servos 501 x 2, /game 501 x 3,
     * /ball 1251 x 2, /compute 501 x 2.
     */
    datapoints: 28515,
    channels: 6,
    cardProblem: `Jack falls ${T('jackFallCount')} times; Donna and Rory stay up.`,
    port: 'ros2 bag record · three robots · mixed-rate Donna charts',
    /**
     * Forty consecutive lines from Donna's own decoded summary arrays around the first goal. The
     * game grid changes from 4-0 to 5-0 while the IMU, motion, ball, diagnostics and compute rows
     * continue at their recorded-derived cadences. These are not raw ROS wire messages.
     */
    oldwaySample: [
      '35.800 /imu accelMagMps2=7.18 pitchDeg=17.14 rollDeg=1.21',
      '35.800 /motion cmdVxMps=0.068 odomVxMps=0.068 cmdYawRadps=0.256',
      '35.800 /ball ballDistM=0.71 ballBearingDeg=25.62',
      '35.850 /imu accelMagMps2=15.93 pitchDeg=15.84 rollDeg=3.51',
      '35.900 /imu accelMagMps2=9.35 pitchDeg=14.74 rollDeg=4.35',
      '35.900 /motion cmdVxMps=0.061 odomVxMps=0.061 cmdYawRadps=0.042',
      '35.950 /imu accelMagMps2=4.26 pitchDeg=16.07 rollDeg=4.24',
      '36.000 /imu accelMagMps2=14.83 pitchDeg=15.23 rollDeg=6.46',
      '36.000 /motion cmdVxMps=0.059 odomVxMps=0.059 cmdYawRadps=-0.039',
      '36.000 /servos maxTempC=48 minBusVoltageV=14.40',
      '36.000 /game secondsRemaining=163 ownScore=4 rivalScore=0',
      '36.000 /ball ballDistM=0.65 ballBearingDeg=24.92',
      '36.000 /compute cpuLoadPct=58.00 memUsedPct=18.38',
      '36.050 /imu accelMagMps2=10.45 pitchDeg=12.45 rollDeg=7.40',
      '36.100 /imu accelMagMps2=10.38 pitchDeg=12.22 rollDeg=7.84',
      '36.100 /motion cmdVxMps=0.058 odomVxMps=0.058 cmdYawRadps=-0.073',
      '36.150 /imu accelMagMps2=9.35 pitchDeg=11.72 rollDeg=7.67',
      '36.200 /imu accelMagMps2=10.33 pitchDeg=11.80 rollDeg=7.37',
      '36.200 /motion cmdVxMps=0.062 odomVxMps=0.062 cmdYawRadps=-0.089',
      '36.200 /ball ballDistM=0.62 ballBearingDeg=21.96',
      '36.250 /imu accelMagMps2=11.14 pitchDeg=11.96 rollDeg=6.75',
      '36.300 /imu accelMagMps2=10.46 pitchDeg=12.83 rollDeg=5.14',
      '36.300 /motion cmdVxMps=0.064 odomVxMps=0.064 cmdYawRadps=-0.097',
      '36.350 /imu accelMagMps2=13.76 pitchDeg=13.13 rollDeg=3.67',
      '36.400 /imu accelMagMps2=5.80 pitchDeg=13.35 rollDeg=3.45',
      '36.400 /motion cmdVxMps=0.000 odomVxMps=0.000 cmdYawRadps=0.000',
      '36.400 /ball ballDistM=0.59 ballBearingDeg=18.84',
      '36.450 /imu accelMagMps2=11.53 pitchDeg=14.25 rollDeg=1.70',
      '36.500 /imu accelMagMps2=9.96 pitchDeg=14.78 rollDeg=0.88',
      '36.500 /motion cmdVxMps=0.000 odomVxMps=0.000 cmdYawRadps=0.000',
      '36.500 /servos maxTempC=48 minBusVoltageV=14.60',
      '36.500 /game secondsRemaining=162 ownScore=5 rivalScore=0',
      '36.500 /compute cpuLoadPct=56.25 memUsedPct=18.42',
      '36.550 /imu accelMagMps2=12.47 pitchDeg=14.95 rollDeg=1.09',
      '36.600 /imu accelMagMps2=10.53 pitchDeg=14.88 rollDeg=1.43',
      '36.600 /motion cmdVxMps=0.000 odomVxMps=0.000 cmdYawRadps=0.000',
      '36.600 /ball ballDistM=0.57 ballBearingDeg=18.15',
      '36.650 /imu accelMagMps2=9.37 pitchDeg=15.72 rollDeg=1.41',
      '36.700 /imu accelMagMps2=9.58 pitchDeg=16.05 rollDeg=1.80',
      '36.700 /motion cmdVxMps=0.000 odomVxMps=0.000 cmdYawRadps=0.000',
    ],
  },
  accent: '#2f78ff',
  duration,
  rate,
  rates,
  rateNotes,
  channels,
  buildData,
  findings,
  factsSeriesPoints,
  previewData,
  loadSceneData: () => loadMissionData().then((d) => loadExperience().then(() => d)),
  isSceneDataLoaded,
  getSceneData,
  // Routing reads this before the payload lands; `experience` itself arrives with it.
  hasExperience: true,
  // Picker framing: cameraHome is 7.42 m (three-robot frame), so the stage3d default
  // scenery thresholds misclassify the pitch as subject and distance-cull the two
  // teammates. These values keep all three bodies + ball and cull field furniture.
  preview: { envCull: 0.6, envRadius: 0.5, distScale: 0.55 },
  loadingCopy: {
    line: 'Loading the recorded mission.',
    cap:
      "Recorded independently onboard Donna, Jack and Rory. Donna's telemetry charts and the " +
      'three-body replay are decoded in your browser.',
  },
  eventLines,
  eventsSection,
  heroTime() {
    return T_HERO_S;
  },
  chatProvenance:
    `Real recorded mission: ${ROLE_SPLIT} The AlloyLogger Arduino library did not capture these ` +
    'logs, and no AlloyLogger production pipeline ingested or produced this replay.',
  firstQuestion: 'How many times did Jack fall, and did Donna or Rory fall too?',
  suggested: [
    'Show me the last Jack fall.',
    'What happened during the penalties?',
    'Which robot produced the charts?',
    'How do I log this from my own robot?',
  ],
  script: [
    {
      id: 'jack-falls',
      matchers: [
        'jack fall',
        'fell',
        'how many',
        'donna or rory',
        'stay up',
        'recover',
        'foul',
        'three falls',
      ],
      answer: `Jack fell ${T('jackFallCount')} times; Donna and Rory did not fall.

| evidence | recorded value |
| --- | --- |
| Jack fall onsets | ${T('jackFall1T')} s, ${T('jackFall2T')} s, ${T('jackFall3T')} s |
| Jack returns to WALKING | ${T('jackRecovery1T')} s, ${T('jackRecovery2T')} s, ${T('jackRecovery3T')} s |
| window fall counts | Donna ${T('donnaFallCount')}, Jack ${T('jackFallCount')}, Rory ${T('roryFallCount')} |

All three counts are window-scoped rows in the aligned event ledger. Jack's field-pose stream drops during each fall, so the replay holds his last observed root position while his recorded joints, torso attitude and control state keep driving the fall and recovery. During the last recovery, his onboard speech topic records: "This was definitely a foul."

{{ev:jack-falls-foul-line}}`,
      evidence: ['jack-falls-foul-line'],
    },
    {
      id: 'show-jack-fall',
      matchers: ['show', 'where', 'see', 'replay', 'watch', 'show me the last jack fall', 'point me'],
      answer: `The replay is on Jack's last fall.

It starts at ${T('jackFall3T')} s, his getting-up state starts at ${T('jackGettingUp3T')} s, and he returns to WALKING at ${T('jackRecovery3T')} s. The root-pose hold is disclosed: localization is absent during the fall, so the scene does not invent field motion.

{{ev:jack-falls-foul-line}}`,
      evidence: ['jack-falls-foul-line'],
    },
    {
      id: 'three-logs-and-charts',
      matchers: [
        'three logs',
        'onboard logs',
        'which robot',
        'produced the charts',
        'chart source',
        'queue',
        'stream',
        'dropped',
        'recorded independently',
      ],
      answer: `The charts are Donna's; the replay combines three onboard logs.

| source | window evidence |
| --- | --- |
| Donna charts | IMU, motion, servos, game state, ball and compute |
| scene and ledger | Donna, Jack and Rory, aligned to Donna's clock |
| live-stream queue-full warnings | Donna ${T('donnaQueueFull')}, Jack ${T('jackQueueFull')}, Rory ${T('roryQueueFull')} |

Each robot recorded independently onboard. The queue counts describe each robot's live-stream application queue, not gaps in the rosbag2 recordings replayed here. Rory's ${T('roryQueueFull')} is an observed zero for this window, not missing data.

{{ev:one-match-three-logs}}`,
      evidence: ['one-match-three-logs'],
    },
    {
      id: 'penalty-traffic',
      matchers: [
        'penalty',
        'penalties',
        'what happened during the penalties',
        'penalized',
        'off field',
        'off-field',
        'rory re-enter',
        'no fix',
        'hidden',
      ],
      answer: `The replay hides unobserved pose instead of filling the gaps.

| event | Donna-clock time |
| --- | --- |
| Rory penalty clears | ${T('roryReentryT')} s |
| Rory first live pose | ${T('roryLivePoseT')} s |
| Donna penalty starts | ${T('donnaPenaltyStartT')} s |
| Donna penalty ends | ${T('donnaPenaltyEndT')} s |

Donna serves ${T('donnaPenaltyDurationS')} s off-field and her localization is dark for that interval, so her body is hidden. Rory begins without a map fix and appears only when a live pose exists. Neither gap is interpolated into motion nobody observed.

{{ev:penalty-traffic}}`,
      evidence: ['penalty-traffic'],
    },
    {
      id: 'added-time-finish',
      matchers: ['goal', 'score', 'added time', 'clock', 'finished', 'whistle', 'won', 'finish'],
      answer: `Two goals close a ${T('scoreAtSecondGoalOwn')}-${T('scoreRival')} win.

| event | recorded clock |
| --- | --- |
| score reaches ${T('scoreAtFirstGoalOwn')}-${T('scoreRival')} | ${T('firstGoalClockS')} s |
| score reaches ${T('scoreAtSecondGoalOwn')}-${T('scoreRival')} | ${T('secondGoalClockS')} s |
| FINISHED | ${T('whistleClockS')} s |

The negative values are added time inside STATE_NORMAL, not a reset or a different period. The second goal lands before FINISHED, and all three independently recorded game-state streams agree after the frozen clock alignment.

{{ev:added-time-finish}}`,
      evidence: ['added-time-finish'],
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
      answer: `Honest answer first: these logs did not come from an \`alloy.log()\` call.

Donna, Jack and Rory each recorded onboard with rosbag2. The recordings were converted offline into this demo's replay format. The AlloyLogger Arduino library did not capture them, and no AlloyLogger production pipeline ingested or produced this replay.

To stream comparable fields from your own ESP32 robot, the call site would look like this:

\`\`\`cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.wifi(WIFI_SSID, WIFI_PASS);
  alloy.begin(ALLOY_KEY, "robots/your-humanoid");
}

void gaitLoop() {
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

Record locally first and treat a live stream as best effort. This window contains ${T('donnaQueueFull')} queue-full warnings on Donna and ${T('jackQueueFull')} on Jack while the onboard recordings remain the replay source.

{{ev:one-match-three-logs}}`,
      evidence: ['one-match-three-logs'],
    },
  ],
  buildScene,
};

export default def;
