// donna/data.js - Donna telemetry plus the aligned three-robot event contract.
//
// Donna remains the chart protagonist. Donna, Jack and Rory each contribute scene tracks and aligned
// event rows from their independently recorded onboard rosbag2 logs. The full payload loads lazily;
// the picker and brief use the decoded preview module.

import { decodeDonnaData } from './decode.js';
import * as previewModule from './preview-data.js';
import { text as T, value as V } from './claims.mjs';

// ------------------------------------------------------------------ mission shape

export const duration = V('durationS');
export const heroTime = V('heroTime');

export const rates = {
  '/imu': 20,
  '/motion': 10,
  '/servos': 2,
  '/game': 2,
  '/ball': 5,
  '/compute': 2,
};

export const rate = rates['/imu'];

export const rateNotes = {
  '/imu': 'block 20 Hz, nearest-sample resampled from Donna\'s recorded raw IMU stream',
  '/motion':
    'block 10 Hz; commands are zero-order held and motion odometry is nearest-sample downsampled',
  '/servos':
    'block 2 Hz; per-servo diagnostic aggregates are zero-order held onto the shared grid',
  '/game': 'block 2 Hz, zero-order held from Donna\'s recorded game-controller stream',
  '/ball':
    'block 5 Hz; filtered map-frame ball and Donna localization are validated, differenced and masked',
  '/compute': 'block 2 Hz, nearest-sample resampled from Donna\'s recorded workload stream',
};

export const fieldRateNotes = {
  '/imu.accelMagMps2': 'recorded IMU acceleration magnitude, nearest-sample at 20 Hz',
  '/imu.pitchDeg': 'recorded normalized IMU quaternion reduced to Euler pitch, nearest-sample at 20 Hz',
  '/imu.rollDeg': 'recorded normalized IMU quaternion reduced to Euler roll, nearest-sample at 20 Hz',
  '/motion.cmdVxMps': 'recorded forward command, zero-order held at 10 Hz',
  '/motion.odomVxMps': 'recorded forward motion odometry, nearest-sample at 10 Hz',
  '/motion.cmdYawRadps': 'recorded angular.z yaw command, zero-order held at 10 Hz',
  '/servos.maxTempC': 'maximum current DS Temperature status, zero-order held at 2 Hz',
  '/servos.minBusVoltageV': 'minimum positive current DS Input Voltage status, zero-order held at 2 Hz',
  '/game.secondsRemaining': 'Donna master gamestate seconds_remaining, zero-order held at 2 Hz',
  '/game.ownScore': 'Donna master gamestate own_score, zero-order held at 2 Hz',
  '/game.rivalScore': 'Donna master gamestate rival_score, zero-order held at 2 Hz',
  '/ball.ballDistM': 'Donna-relative distance from two validated map-frame estimates at 5 Hz',
  '/ball.ballBearingDeg': 'Donna-relative wrapped bearing from two validated map-frame estimates at 5 Hz',
  '/compute.cpuLoadPct': 'recorded overall CPU usage, nearest-sample at 2 Hz',
  '/compute.memUsedPct': 'recorded memory_used divided by memory_total, nearest-sample at 2 Hz',
};

const P = (transform, note) => ({ origin: 'REAL_MCAP', transform, note });

export const channels = [
  {
    path: '/imu',
    label: 'Donna torso IMU',
    note: 'Recorded onboard Donna. Magnitude and Euler angles are derived from the raw IMU stream.',
    fields: [
      {
        key: 'accelMagMps2',
        label: 'accelMagMps2',
        unit: 'm/s^2',
        provenance: P('DERIVED_MAGNITUDE+RESAMPLED_NEAREST_20HZ', fieldRateNotes['/imu.accelMagMps2']),
      },
      {
        key: 'pitchDeg',
        label: 'pitchDeg',
        unit: 'deg',
        provenance: P('DERIVED_ANGLES+RESAMPLED_NEAREST_20HZ', fieldRateNotes['/imu.pitchDeg']),
      },
      {
        key: 'rollDeg',
        label: 'rollDeg',
        unit: 'deg',
        provenance: P('DERIVED_ANGLES+RESAMPLED_NEAREST_20HZ', fieldRateNotes['/imu.rollDeg']),
      },
    ],
  },
  {
    path: '/motion',
    label: 'Donna command and odometry',
    note: 'Recorded Donna command and motion-odometry streams on one chart grid.',
    fields: [
      {
        key: 'cmdVxMps',
        label: 'cmdVxMps',
        unit: 'm/s',
        provenance: P('CMD_ZOH_10HZ', fieldRateNotes['/motion.cmdVxMps']),
      },
      {
        key: 'odomVxMps',
        label: 'odomVxMps',
        unit: 'm/s',
        provenance: P('ODOM_NEAREST_10HZ', fieldRateNotes['/motion.odomVxMps']),
      },
      {
        key: 'cmdYawRadps',
        label: 'cmdYawRadps',
        unit: 'rad/s',
        provenance: P('CMD_ANGULAR_Z_ZOH_10HZ', fieldRateNotes['/motion.cmdYawRadps']),
      },
    ],
  },
  {
    path: '/servos',
    label: 'Donna servo diagnostics',
    note: 'Recorded Donna Dynamixel statuses reduced to temperature and positive bus-voltage extrema.',
    fields: [
      {
        key: 'maxTempC',
        label: 'maxTempC',
        unit: 'degC',
        provenance: P(
          'DERIVED_DIAGNOSTIC_AGGREGATE+ZOH_2HZ',
          fieldRateNotes['/servos.maxTempC'],
        ),
      },
      {
        key: 'minBusVoltageV',
        label: 'minBusVoltageV',
        unit: 'V',
        provenance: P(
          'DERIVED_DIAGNOSTIC_AGGREGATE+ZOH_2HZ',
          fieldRateNotes['/servos.minBusVoltageV'],
        ),
      },
    ],
  },
  {
    path: '/game',
    label: 'Donna game controller',
    note: 'Donna-clock game state shared by the replay, including STATE_NORMAL added time.',
    fields: [
      {
        key: 'secondsRemaining',
        label: 'secondsRemaining',
        unit: 's',
        provenance: P('DONNA_MASTER_GAMESTATE+ZOH_2HZ', fieldRateNotes['/game.secondsRemaining']),
      },
      {
        key: 'ownScore',
        label: 'ownScore',
        unit: 'count',
        provenance: P('DONNA_MASTER_GAMESTATE+ZOH_2HZ', fieldRateNotes['/game.ownScore']),
      },
      {
        key: 'rivalScore',
        label: 'rivalScore',
        unit: 'count',
        provenance: P('DONNA_MASTER_GAMESTATE+ZOH_2HZ', fieldRateNotes['/game.rivalScore']),
      },
    ],
  },
  {
    path: '/ball',
    label: 'Donna filtered ball estimate',
    note:
      'Recorded filtered ball estimates in the map frame. Chart values are relative to Donna, and ' +
      'numeric zero is filler while ballSeen is clear.',
    fields: [
      {
        key: 'ballDistM',
        label: 'ballDistM',
        unit: 'm',
        mask: 'ballSeen',
        maskNote: 'the ball estimate or Donna localization fails the frozen validity rules',
        provenance: P(
          'MAP_FRAME_DIFFERENCE_TO_DONNA+VALIDATED_MASK_5HZ',
          fieldRateNotes['/ball.ballDistM'],
        ),
      },
      {
        key: 'ballBearingDeg',
        label: 'ballBearingDeg',
        unit: 'deg',
        mask: 'ballSeen',
        maskNote: 'the ball estimate or Donna localization fails the frozen validity rules',
        provenance: P(
          'MAP_FRAME_DIFFERENCE_TO_DONNA+WRAPPED_BEARING+VALIDATED_MASK_5HZ',
          fieldRateNotes['/ball.ballBearingDeg'],
        ),
      },
    ],
  },
  {
    path: '/compute',
    label: 'Donna onboard compute',
    note: 'Recorded Donna workload telemetry reduced to CPU load and used-memory percentage.',
    fields: [
      {
        key: 'cpuLoadPct',
        label: 'cpuLoadPct',
        unit: 'percent',
        provenance: P('RESAMPLED_NEAREST_2HZ', fieldRateNotes['/compute.cpuLoadPct']),
      },
      {
        key: 'memUsedPct',
        label: 'memUsedPct',
        unit: 'percent',
        provenance: P('DERIVED_RATIO+RESAMPLED_NEAREST_2HZ', fieldRateNotes['/compute.memUsedPct']),
      },
    ],
  },
];

// ------------------------------------------------------------------ findings

export const findings = [
  {
    id: 'one-match-three-logs',
    title: `${T('oneMatchWord')} match, ${T('threeLogsWord')} onboard logs`,
    window: [V('windowOpenT'), V('jackSpeak1T')],
    t: V('windowOpenT'),
    severity: 'warn',
    focus: { channel: '/compute', fields: ['cpuLoadPct', 'memUsedPct'] },
    highlight: 'team',
    slowmo: false,
    note:
      `All ${T('threeLogsWord')} robots recorded independently onboard. In this window, the separate ` +
      `live-stream application queue filled ${T('donnaQueueFull')} times on Donna, ` +
      `${T('jackQueueFull')} on Jack and ${T('roryQueueFull')} on Rory. These are application-queue ` +
      'warnings, not gaps in the rosbag2 recordings replayed here.',
  },
  {
    id: 'jack-falls-foul-line',
    title: `Jack's ${T('jackFallCountWord')} falls and the foul line`,
    window: [V('jackFall3T'), V('jackRecovery3T')],
    // The 3D replay loop, tight around the third fall. Both edges are ledger values with half a
    // second either side, so the loop quotes the same recorded events the window does: 0.5 s of
    // Jack walking, the fall onset at jackFall3T, the ~1.0 s of going down, and 0.5 s of him on the
    // carpet before the getting-up state at jackGettingUp3T carries him out of it. 2.0 s of data.
    //
    // It opens 0.5 s BEFORE the window, because the window's left edge IS the fall onset and the
    // healthy half-second Hugh asked for sits behind it. 0.5 s is inside the 0.64 s pad the chart
    // puts around this shaded window, so the playhead sweeps for the whole lap.
    //
    // `t` (jackSpeak3T, 148.064 s) sits OUTSIDE this loop, and that is correct: the instant is the
    // narrative anchor for the foul line, the loop is the failure. Nothing in the scene renders the
    // speech - it is quoted in the note and the facts pack - so the loop loses nothing by ending
    // before it. A `loop` is not required to contain `t`.
    loop: [V('jackFall3T') - 0.5, V('jackGettingUp3T') + 0.5],
    t: V('jackSpeak3T'),
    severity: 'alert',
    focus: { channel: '/imu', fields: ['accelMagMps2', 'pitchDeg', 'rollDeg'] },
    highlight: 'jack',
    // NOT slow motion any more. The fall takes a full second of real time and is a humanoid going
    // from walking to flat: it reads at 1x, and 0.4x on this loop is 5 s a lap.
    slowmo: false,
    note:
      `Window fall counts are Donna ${T('donnaFallCount')}, Jack ${T('jackFallCount')} and Rory ` +
      `${T('roryFallCount')}. During the last recovery Jack says, "This was definitely a foul."`,
  },
  {
    id: 'penalty-traffic',
    title: 'Penalty traffic',
    window: [V('donnaPenaltyStartT'), V('donnaPenaltyEndT')],
    t: V('donnaPenaltyStartT'),
    severity: 'info',
    focus: { channel: '/game', fields: ['secondsRemaining', 'ownScore', 'rivalScore'] },
    highlight: 'donna',
    slowmo: false,
    note:
      `Donna serves ${T('donnaPenaltyDurationS')} s off-field with her localization honestly dark. ` +
      `Rory re-enters at ${T('roryReentryT')} s, and live pose resumes at ` +
      `${T('roryLivePoseT')} s. The replay hides unobserved pose instead of inventing it.`,
  },
  {
    id: 'added-time-finish',
    title: `Added-time finish: ${T('scoreAtSecondGoalOwn')}-${T('scoreRival')}`,
    window: [V('goal6T'), V('finishedT')],
    t: V('goal6T'),
    severity: 'info',
    focus: { channel: '/game', fields: ['secondsRemaining', 'ownScore', 'rivalScore'] },
    highlight: 'team',
    slowmo: false,
    note:
      `The score moves to ${T('scoreAtFirstGoalOwn')}-${T('scoreRival')} with ` +
      `${T('firstGoalClockS')} s on the clock, then to ${T('scoreAtSecondGoalOwn')}-` +
      `${T('scoreRival')} at ${T('secondGoalClockS')} s. FINISHED arrives at ` +
      `${T('whistleClockS')} s on the same STATE_NORMAL clock.`,
  },
];

export const factsSeriesPoints = 53;

export const eventsSection = {
  title: 'Aligned match and onboard events',
  preamble:
    'These are Donna-clock events and window summaries from Donna, Jack and Rory, recorded independently onboard.',
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

export function validateSceneData(M) {
  const problems = [];
  if (!M || typeof M !== 'object') problems.push('nothing decoded');
  if (M && M.variant !== 'full') problems.push(`variant is "${M.variant}", not full`);
  if (M && (!Array.isArray(M.events) || M.events.length !== 20)) problems.push('event ledger is not 20 rows');
  if (M && M.tracks) {
    for (const channel of channels) {
      const trackName = SUMMARY_TRACK_FOR[channel.path];
      const track = M.tracks[trackName];
      if (!track) {
        problems.push(`track ${trackName} is missing`);
        continue;
      }
      for (const field of channel.fields) {
        if (!track[field.key]) problems.push(`${trackName}.${field.key} is missing`);
      }
      if (channel.path === '/ball' && !track.ballSeen) problems.push('summaryBall.ballSeen is missing');
    }
    for (const robot of ['donna', 'jack', 'rory']) {
      for (const suffix of ['Joints', 'TorsoQuaternion', 'RobotState', 'Presence', 'Hud']) {
        if (!M.tracks[`${robot}${suffix}`]) problems.push(`scene track ${robot}${suffix} is missing`);
      }
      if (!Object.keys(M.tracks).some((name) => new RegExp(`^${robot}Pose\\d+$`).test(name))) {
        problems.push(`scene pose segments for ${robot} are missing`);
      }
    }
    if (!M.tracks.donnaBallField) problems.push('scene track donnaBallField is missing');
  } else if (M) {
    problems.push('no tracks object');
  }
  if (M && (!M.presence || !M.presence.donna || !M.presence.jack || !M.presence.rory)) {
    problems.push('decoded presence segments are missing');
  }
  if (
    M &&
    (!M.mesh ||
      Object.keys(M.mesh.parts || {}).length !== 52 ||
      !Array.isArray(M.mesh.instances) ||
      M.mesh.instances.length !== 133)
  ) {
    problems.push('decoded Wolfgang mesh or instance manifest is missing');
  }
  if (problems.length) {
    const err = new Error(`donna/data.js: the decoded mission payload is unusable - ${problems.join('; ')}`);
    err.retryable = true;
    throw err;
  }
  return M;
}

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
  for (const channel of channels) {
    const trackName = SUMMARY_TRACK_FOR[channel.path];
    const spec = M.meta.tracks[trackName];
    const track = M.tracks[trackName];
    const built = { t: uniformTimeAxis(spec.timing, spec.count) };
    for (const field of channel.fields) built[field.key] = copyValues(track[field.key]);
    if (channel.path === '/ball') built.ballSeen = copyValues(track.ballSeen);
    out[channel.path] = built;
  }
  return out;
}

// ------------------------------------------------------------------ aligned event ledger

function sourceFor(event) {
  if (event.kind === 'fall') return `/${event.robot}/robot_state`;
  if (event.kind === 'speak') return `/${event.robot}/speak`;
  if (event.kind === 'penalty') return `/${event.robot}/gamestate`;
  if (event.kind === 'game') return '/match/gamestate';
  if (event.id.endsWith('-fall-count')) return `/${event.robot}/robot_state`;
  if (event.id.endsWith('-queue-full')) return `/${event.robot}/rosout`;
  if (event.id === 'donna-low-power') return '/donna/diagnostics';
  return '/match/clock';
}

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
