// donna/data.js - telemetry and event contract for Donna's recorded RoboCup match log.
//
// Every sample in this mission comes from the public Bit-Bots Donna MCAP. Summary channels are
// derived or resampled from that recording, and each field carries the exact composite transform
// token frozen by the extractor. No browser-time simulation or random generation happens here.
//
// The full payload loads lazily. buildData() is a tripwire until loadSceneData() resolves. The picker
// and mission brief use the decoded 6 second preview slice instead.

import { decodeDonnaData } from './decode.js';
import * as previewModule from './preview-data.js';
import { text as T } from './claims.mjs';

// ------------------------------------------------------------------ mission shape

export const duration = 306.0;
export const rate = 20;

export const rates = {
  '/imu': 20,
  '/motion': 10,
  '/servos': 2,
  '/game': 2,
  '/ball': 5,
  '/compute': 2,
};

export const rateNotes = {
  '/imu':
    'block 20 Hz, nearest-sample resampled from the recorded IMU stream at 342.75 Hz native cadence',
  '/motion':
    'block 10 Hz; commands are zero-order held from an event-driven 28.49 Hz native cadence and 200 Hz odometry is nearest-sample downsampled',
  '/servos':
    'block 2 Hz; diagnostic updates arrive at about 107 Hz natively, then the per-servo aggregates are zero-order held onto the grid',
  '/game':
    'block 2 Hz, zero-order held from the recorded game-controller stream at 1.75 Hz native cadence',
  '/ball':
    'block 5 Hz, nearest-sample resampled from the 47.21 Hz filtered estimate with a 0.4 s validated presence mask, then differenced against the segmented localization pose at each tick to put both series in Donna\'s frame',
  '/compute':
    'block 2 Hz, nearest-sample resampled from the recorded system workload stream at 19.95 Hz native cadence',
};

const P = (transform, note) => ({ origin: 'REAL_MCAP', transform, note });

export const channels = [
  {
    path: '/imu',
    label: 'Torso IMU',
    note: 'Recorded onboard. Magnitude and Euler angles are derived from the raw IMU stream.',
    fields: [
      {
        key: 'accelMagMps2',
        label: 'accelMagMps2',
        unit: 'm/s^2',
        provenance: P(
          'DERIVED_MAGNITUDE+RESAMPLED_20HZ',
          'magnitude of the recorded linear-acceleration vector, nearest-sample resampled at 20 Hz',
        ),
      },
      {
        key: 'pitchDeg',
        label: 'pitchDeg',
        unit: 'deg',
        provenance: P(
          'DERIVED_ANGLES+RESAMPLED_20HZ',
          'Euler pitch derived from the normalized recorded IMU quaternion, resampled at 20 Hz',
        ),
      },
      {
        key: 'rollDeg',
        label: 'rollDeg',
        unit: 'deg',
        provenance: P(
          'DERIVED_ANGLES+RESAMPLED_20HZ',
          'Euler roll derived from the normalized recorded IMU quaternion, resampled at 20 Hz',
        ),
      },
    ],
  },
  {
    path: '/motion',
    label: 'Command and odometry',
    note: 'Recorded command and motion-odometry streams on one 10 Hz chart grid.',
    fields: [
      {
        key: 'cmdVxMps',
        label: 'cmdVxMps',
        unit: 'm/s',
        provenance: P('RESAMPLED_10HZ', 'recorded forward command, zero-order held onto the 10 Hz grid'),
      },
      {
        key: 'odomVxMps',
        label: 'odomVxMps',
        unit: 'm/s',
        provenance: P('RESAMPLED_10HZ', 'recorded forward odometry, nearest-sample downsampled onto the 10 Hz grid'),
      },
      {
        key: 'cmdYawRadps',
        label: 'cmdYawRadps',
        unit: 'rad/s',
        provenance: P('RESAMPLED_10HZ', 'recorded yaw command, zero-order held onto the 10 Hz grid'),
      },
    ],
  },
  {
    path: '/servos',
    label: 'Servo diagnostics',
    note: 'Recorded Dynamixel diagnostic statuses reduced to maximum temperature and minimum positive bus voltage.',
    fields: [
      {
        key: 'maxTempC',
        label: 'maxTempC',
        unit: 'degC',
        provenance: P(
          'DERIVED_DIAG_AGGREGATE+RESAMPLED_2HZ',
          'maximum current Temperature across recorded DS diagnostic statuses, zero-order held at 2 Hz',
        ),
      },
      {
        key: 'minBusVoltageV',
        label: 'minBusVoltageV',
        unit: 'V',
        provenance: P(
          'DERIVED_DIAG_AGGREGATE+RESAMPLED_2HZ',
          'minimum positive current Input Voltage across recorded DS diagnostic statuses, zero-order held at 2 Hz',
        ),
      },
    ],
  },
  {
    path: '/game',
    label: 'Game controller',
    note: 'Recorded onboard game-controller state, zero-order held onto the shared 2 Hz grid.',
    fields: [
      {
        key: 'secondsRemaining',
        label: 'secondsRemaining',
        unit: 's',
        provenance: P('RESAMPLED_2HZ', 'recorded seconds_remaining, zero-order held onto the 2 Hz grid'),
      },
      {
        key: 'ownScore',
        label: 'ownScore',
        unit: 'count',
        provenance: P('RESAMPLED_2HZ', 'recorded own_score, zero-order held onto the 2 Hz grid'),
      },
      {
        key: 'rivalScore',
        label: 'rivalScore',
        unit: 'count',
        provenance: P('RESAMPLED_2HZ', 'recorded rival_score, zero-order held onto the 2 Hz grid'),
      },
    ],
  },
  {
    path: '/ball',
    label: 'Filtered ball estimate',
    note:
      'Recorded filtered ball estimates in the map frame. The chart values are relative to Donna, ' +
      'and numeric zero is filler when ballSeen is clear.',
    fields: [
      {
        key: 'ballDistM',
        label: 'ballDistM',
        unit: 'm',
        mask: 'ballSeen',
        maskNote: 'the filtered estimate or segmented localization pose fails the frozen validity rules',
        provenance: P(
          'DERIVED_DISTANCE+RESAMPLED_5HZ',
          'relative to Donna, derived by differencing two map-frame estimates (filtered ball pose and localization pose), not a direct robot-frame measurement',
        ),
      },
      {
        key: 'ballBearingDeg',
        label: 'ballBearingDeg',
        unit: 'deg',
        mask: 'ballSeen',
        maskNote: 'the filtered estimate or segmented localization pose fails the frozen validity rules',
        provenance: P(
          'DERIVED_BEARING+RESAMPLED_5HZ',
          'relative to Donna, derived by differencing two map-frame estimates (filtered ball pose and localization pose), not a direct robot-frame measurement',
        ),
      },
    ],
  },
  {
    path: '/compute',
    label: 'Onboard compute',
    note: 'Recorded workload telemetry reduced to CPU load and used-memory percentage.',
    fields: [
      {
        key: 'cpuLoadPct',
        label: 'cpuLoadPct',
        unit: 'percent',
        provenance: P('RESAMPLED_2HZ', 'recorded overall CPU usage, nearest-sample resampled at 2 Hz'),
      },
      {
        key: 'memUsedPct',
        label: 'memUsedPct',
        unit: 'percent',
        provenance: P(
          'DERIVED_RATIO+RESAMPLED_2HZ',
          'recorded memory_used divided by memory_total, nearest-sample resampled at 2 Hz',
        ),
      },
    ],
  },
];

// ------------------------------------------------------------------ findings

const ankleMessage =
  `Invalid position for LAnklePitch: ${T('clampLAnklePitchValue')} not in ` +
  `(${T('clampLAnklePitchLow')}, ${T('clampLAnklePitchHigh')})`;
const rightElbowMessage =
  `Invalid position for RElbow: ${T('clampRElbowValue')} not in ` +
  `(${T('clampRElbowLow')}, ${T('clampRElbowHigh')})`;
const leftElbowMessage =
  `Invalid position for LElbow: ${T('clampLElbowValue')} not in ` +
  `(${T('clampLElbowLow')}, ${T('clampLElbowHigh')})`;

export const findings = [
  {
    id: 'falls-recoveries',
    title: `${T('fallCount')} falls, ${T('recoveryCount')} recoveries`,
    window: [92.0, 103.0],
    t: 94.848,
    severity: 'alert',
    focus: { channel: '/imu', fields: ['accelMagMps2', 'pitchDeg', 'rollDeg'] },
    highlight: 'body',
    slowmo: true,
    note:
      `Every FALLING onset is followed by recovery within ${T('recoveryCeilingS')} s. The first ` +
      'five recoveries run from GETTING_UP to WALKING. The last runs from GETTING_UP to the first ' +
      'CONTROLLABLE state because the final whistle arrives before WALKING.',
  },
  {
    id: 'battery-sag',
    title: `Battery rail reaches ${T('minBusVoltageV')} V`,
    window: [218.0, 228.0],
    t: 223.628,
    severity: 'warn',
    focus: { channel: '/servos', fields: ['minBusVoltageV', 'maxTempC'] },
    highlight: 'body',
    slowmo: false,
    note:
      `${T('undervoltageCount')} recorded "Power getting low" statuses cluster around a ` +
      `${T('minBusVoltageV')} V minimum. The timing correlates with the late falls, but this log ` +
      'does not establish battery sag as their root cause.',
  },
  {
    id: 'servo-command-clamps',
    title: 'Servo commands hit the hardware interface limits',
    window: [92.0, 101.0],
    t: 94.905,
    severity: 'warn',
    focus: { channel: '/servos', fields: ['maxTempC', 'minBusVoltageV'] },
    highlight: 'body',
    slowmo: false,
    note:
      `${T('clampLAnklePitchCount')} LAnklePitch clamps, ${T('clampRElbowCount')} RElbow clamps ` +
      `and ${T('clampLElbowCount')} LElbow clamps. The log's own first limit strings are ` +
      `"${ankleMessage}", "${rightElbowMessage}" and "${leftElbowMessage}".`,
  },
  {
    id: 'added-time-finish',
    title: `Added-time goal and whistle finish ${T('scoreFinalOwn')}-${T('scoreRival')}`,
    window: [276.0, 289.0],
    t: 278.197,
    severity: 'info',
    focus: { channel: '/game', fields: ['secondsRemaining', 'ownScore', 'rivalScore'] },
    highlight: 'body',
    slowmo: false,
    note:
      `Donna's side moves from ${T('scoreBeforeOwn')}-${T('scoreRival')} to ` +
      `${T('scoreFinalOwn')}-${T('scoreRival')} with ${T('secondsRemainingAtGoal')} s on the ` +
      `recorded clock. FINISHED follows at ${T('finalWhistleT')} s.`,
  },
  {
    id: 'stream-backpressure',
    title: `${T('streamDroppedCount')} messages dropped from the live stream`,
    window: [0.0, 8.0],
    t: 0.456,
    severity: 'warn',
    focus: { channel: '/compute', fields: ['cpuLoadPct', 'memUsedPct'] },
    highlight: 'body',
    slowmo: false,
    note:
      `udp_bridge_sender reports ${T('streamDroppedCount')} queue-full drops for /rosout from the ` +
      'live stream. The MCAP recording retained the messages, so the replay and event inventory are complete.',
  },
];

// The default six-channel build-facts budget is 53 points. It is exported explicitly so the later
// RobotDefinition can carry the value without silently changing the default.
export const factsSeriesPoints = 53;

export const eventsSection = {
  title: 'Match and onboard events',
  preamble: "These are the robot's own recorded match and diagnostic events.",
};

// ------------------------------------------------------------------ scene-data contract

let donnaPromise = null;
let donnaData = null;

const SUMMARY_TRACK_FOR = {
  '/imu': 'summaryImu',
  '/motion': 'summaryMotion',
  '/servos': 'summaryServos',
  '/game': 'summaryGame',
  '/ball': 'summaryBall',
  '/compute': 'summaryCompute',
};

/** Validate the full decoded payload once, on the load promise's rejection path. */
export function validateSceneData(M) {
  const problems = [];
  if (!M || typeof M !== 'object') problems.push('nothing decoded');
  if (M && M.variant !== 'full') problems.push(`variant is "${M.variant}", not full`);
  if (M && (!Array.isArray(M.events) || M.events.length !== 20)) problems.push('event ledger is not 20 rows');
  if (M && M.tracks) {
    for (const ch of channels) {
      const trackName = SUMMARY_TRACK_FOR[ch.path];
      const track = M.tracks[trackName];
      if (!track) {
        problems.push(`track ${trackName} is missing`);
        continue;
      }
      for (const field of ch.fields) {
        if (!track[field.key]) problems.push(`${trackName}.${field.key} is missing`);
      }
      if (ch.path === '/ball' && !track.ballSeen) problems.push('summaryBall.ballSeen is missing');
    }
    for (const trackName of ['joints', 'torsoQuaternion', 'pose', 'ballField']) {
      if (!M.tracks[trackName]) problems.push(`scene track ${trackName} is missing`);
    }
  } else if (M) {
    problems.push('no tracks object');
  }
  if (problems.length) {
    const err = new Error(`donna/data.js: the decoded mission payload is unusable - ${problems.join('; ')}`);
    err.retryable = true;
    throw err;
  }
  return M;
}

/** Load and decode the full mission module. Repeated calls return the same promise. */
export function loadSceneData() {
  if (donnaPromise) return donnaPromise;
  const p = import('./donna-data.js')
    .then(
      (mod) => {
        donnaData = validateSceneData(decodeDonnaData(mod));
        return donnaData;
      },
      (err) => {
        const wrapped = new Error('The Donna mission module could not be loaded. Reload the page to try again.');
        wrapped.retryable = false;
        wrapped.cause = err;
        throw wrapped;
      },
    )
    .catch((err) => {
      if (err && err.retryable === false) throw err;
      if (donnaPromise === p) donnaPromise = null;
      const wrapped = new Error(
        err && /unusable/.test(err.message || '')
          ? 'The Donna mission decoded but is missing required tracks.'
          : 'The Donna mission data could not be decoded.',
      );
      wrapped.retryable = true;
      wrapped.cause = err;
      throw wrapped;
    });
  donnaPromise = p;
  return p;
}

export function isSceneDataLoaded() {
  return donnaData !== null;
}

export function getSceneData() {
  return donnaData || previewData;
}

export let previewData = null;
try {
  previewData = decodeDonnaData(previewModule);
} catch (err) {
  previewData = null;
}

/** Test hook for the pre-load tripwires. */
export function __resetSceneDataForTests() {
  donnaPromise = null;
  donnaData = null;
}

// ------------------------------------------------------------------ telemetry builder

function uniformTimeAxis(timing, count) {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = (timing.startMs + i * timing.stepMs) / 1000;
  return out;
}

function copyValues(src) {
  const out = new Float64Array(src.length);
  out.set(src);
  return out;
}

/** Reshape decoded summary tracks onto the RobotDefinition chart contract. */
export function buildData(prng) {
  const M = donnaData;
  if (!M) {
    const err = new Error(
      'donna/data.js: buildData() was called before loadSceneData() resolved. Await ' +
        'def.loadSceneData() before building Donna telemetry.',
    );
    err.code = 'DONNA_BUILD_BEFORE_LOAD';
    throw err;
  }
  const out = {};
  for (const ch of channels) {
    const trackName = SUMMARY_TRACK_FOR[ch.path];
    const spec = M.meta.tracks[trackName];
    const track = M.tracks[trackName];
    const built = { t: uniformTimeAxis(spec.timing, spec.count) };
    for (const field of ch.fields) built[field.key] = copyValues(track[field.key]);
    if (ch.path === '/ball') built.ballSeen = copyValues(track.ballSeen);
    out[ch.path] = built;
  }
  return out;
}

// ------------------------------------------------------------------ recorded event ledger

const sourceFor = (event) => {
  if (event.kind === 'fall') return '/robot_state';
  if (event.kind === 'speak') return '/speak';
  if (event.id === 'servo-undervoltage') return '/diagnostics';
  if (event.kind === 'game' || event.kind === 'penalty') return '/gamestate';
  return '/rosout';
};

/** Return one fixed-format row for each of the frozen 20 recorded events, in ledger order. */
export function eventLines() {
  const M = donnaData;
  if (!M) {
    const err = new Error(
      'donna/data.js: eventLines() was called before loadSceneData() resolved. Await ' +
        'def.loadSceneData() before reading Donna events.',
    );
    err.code = 'DONNA_EVENTS_BEFORE_LOAD';
    throw err;
  }
  return M.events.map((event) => ({
    t: event.t,
    source: sourceFor(event),
    kind: event.kind,
    detail: event.detail,
  }));
}
