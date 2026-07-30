// battle/data.js - a scripted, rules-faithful SIMULATED round of the ICRA 2019 RoboMaster AI
// Challenge ruleset (Rules Manual V1.1, 2019-04-23), 180 s, 2v2, fully autonomous.
//
// WHAT IS REAL AND WHAT IS NOT. Read this before anything else in this directory.
//
// NOTHING here was recorded. No public log of an AI Challenge round exists, so there was nothing to
// replay and nothing to de-identify. Every sample in this mission was authored by an offline
// generator and a referee-arithmetic engine in the private clients/alloy scratch repo, from a
// frozen beat sheet, under one seeded PRNG and no wall clock. The teams are fictional. The
// competition, its geometry and its constants are named factually and cited to the manual by
// section; no manual text is reproduced, and no logos or artwork are used.
//
// That is why every field on every channel carries `origin: SYNTHETIC`. The transform says what
// produced it, which is the part that carries information here: a pose estimate, a planner output,
// a team-layer derivation the reference stack does not actually ship, or the referee engine.
//
// WHAT IS CITABLE. The channel names, the field names, the units and the cadences come from the
// public reference navigation stack for this competition and from the referee serial protocol
// appendix V1.1 (2019-03-08). The later appendix postdates the event and none of it is used. Two
// attributions matter and are honoured everywhere in this file:
//   - the reference stack ships NO fire control. `cmd_shoot` is advertised and called by nothing.
//     The autonomous fire decision here is a SYNTHETIC TEAM CONTROLLER, the layer real teams wrote
//     themselves, and it is never attributed to the reference stack.
//   - the UWB-to-estimator residual is a TEAM-LAYER derived quantity. The reference stack's UWB
//     subscriber is never wired, so nothing public fuses those two estimates.
//
// THE FAULT. One stale timestamp, five hops, each hop in its own channel:
//   vision loses the target and keeps republishing it fresh-stamped -> the chase goal freezes on
//   the held point -> the held point is outside the turret's chassis-relative window so the chassis
//   rotates to it -> the fire gate's freshness check passes on the publish-time stamp and a burst
//   goes into an obstacle -> barrel heat crosses the limit and the referee takes HP off the robot
//   that fired. Nothing shot at Blue 1. Blue 1 did all of it to itself, and the round turns on it.
//
// LOADING ORDER, the load-bearing rule. The channels below are DECODED from the round module, so
// `buildData()` cannot run until `loadSceneData()` has resolved, and it throws if you try. The
// picker and the brief never call it: they use `previewData`, a 6 s slice that ships in this
// module's own dependency graph.
//
// NUMBERS IN COPY. Every number in a finding narrative comes out of `claims.mjs`, never out of a
// keyboard. See that file's header for why.

import { decodeBattleData } from './decode.js';
import * as previewModule from './preview-data.js';
import { text as T } from './claims.mjs';

// ------------------------------------------------------------------ mission shape

/** The full round. t = 0 is round start; the referee stage clock reads 180 minus t. */
export const duration = 180.0;

/**
 * A summary cadence, not a fact about any one channel. This mission is genuinely mixed-rate and
 * `rates` below is the fact; the facts builder consumes `rates`, not this. 20 Hz is the pose
 * cadence the scene plays back on.
 */
export const rate = 20;

/**
 * Per-channel block cadence in Hz. The cadence contract: each channel has ONE time axis and ONE
 * block rate that all of its fields share. Sources that are natively slower are zero-order held
 * onto that grid; sources that are natively faster are downsampled onto it. Both are documented
 * per field in `fieldRateNotes`.
 */
export const rates = {
  '/blue1/vision': 25,
  '/blue1/localization': 10,
  '/blue1/planner': 10,
  '/blue1/chassis': 20,
  '/blue1/gimbal_launcher': 25,
  '/blue1/referee': 10,
};

/** Per-channel cadence prose. This is what the facts pack renders beside each channel. */
export const rateNotes = {
  '/blue1/vision':
    'block 25 Hz, which is also the native rate: the detector action-feedback loop republishes at a fixed 25 Hz',
  '/blue1/localization':
    'block 10 Hz; the pose estimator is update-gated and publishes at or above that, and the UWB residual is derived at the team layer',
  '/blue1/planner':
    'block 10 Hz, zero-order held from a 3 Hz global planner, so nothing on this channel can transition faster than 3 Hz',
  '/blue1/chassis':
    'block 20 Hz, downsampled from 40 Hz velocity commands, wheel odometry at roughly 50 Hz (INFERRED) and 50 Hz current telemetry',
  '/blue1/gimbal_launcher':
    'block 25 Hz, the rate gimbal setpoints are issued at; the fire gate is sampled continuously on the same grid',
  '/blue1/referee':
    'block 10 Hz, which IS the native settlement grid the heat and health arithmetic is defined on',
};

/**
 * Per-FIELD native cadence, keyed `<channel>.<field>`. `rates`/`rateNotes` are keyed by channel
 * because that is the def contract and the chart draws one time axis per channel, but the native
 * sources behind a channel do not share one rate, and pretending they do would be a claim about
 * this data that is not true. Anything INFERRED is labelled INFERRED here and nowhere is it
 * presented as measured.
 */
export const fieldRateNotes = {
  '/blue1/vision.confidence': 'native 25 Hz, the detector feedback loop rate',
  '/blue1/vision.trackAgeS':
    'native 25 Hz. Capture-age ground truth computed by the logger from the last accepted detection stamp. The robot never reads this field, which is the entire point of the fault',
  '/blue1/localization.xM': 'native update-gated pose estimate, resampled onto the 10 Hz block grid',
  '/blue1/localization.yM': 'native update-gated pose estimate, resampled onto the 10 Hz block grid',
  '/blue1/localization.uwbResidualM':
    'TEAM LAYER. UWB position arrives as int16 centimetres on the CAN wire and the chassis driver divides by 100 to publish metres; the residual against the pose estimate is computed above that, because the reference stack never wires its UWB subscriber',
  '/blue1/localization.yawDeg':
    'native update-gated pose estimate. UWB yaw comes off a magnetometer and is documented as noisy under fast rotation',
  '/blue1/planner.goalDistM': 'native 3 Hz global planner, zero-order held onto the 10 Hz block grid',
  '/blue1/planner.pathLenM': 'native 3 Hz global planner, zero-order held onto the 10 Hz block grid',
  '/blue1/chassis.cmdSpeedMps': 'native 40 Hz local planner command, downsampled onto the 20 Hz block grid',
  '/blue1/chassis.measSpeedMps':
    'native wheel odometry at approximately 50 Hz. INFERRED: the firmware-side push rate is not documented anywhere public, so the number is an estimate and is never quoted as measured',
  '/blue1/chassis.chassisCurrentA': 'native 50 Hz chassis power telemetry, downsampled onto the 20 Hz block grid',
  '/blue1/gimbal_launcher.gimbalYawDeg': 'native 25 Hz, gimbal setpoints at the detector rate',
  '/blue1/gimbal_launcher.targetBearingDeg':
    'native 25 Hz. Map-frame bearing to the CURRENTLY HELD target position, so a frozen held position freezes this series with it',
  '/blue1/gimbal_launcher.fireGate':
    'native 25 Hz, sampled continuously as 0/1. Per-shot muzzle speeds are events and are not a series: isolated samples draw nothing on a chart',
  '/blue1/referee.remainHP': 'native 10 Hz robot status broadcast, the settlement grid itself',
  '/blue1/referee.shooterHeat0':
    'the heat feed is native 50 Hz, but it is exported at the 10 Hz settlement ticks where the arithmetic is defined, as the PRE-SETTLEMENT value, so the peak reached inside a tick is in the array',
};

// ------------------------------------------------------------------ provenance vocabulary

/**
 * Two-dimensional provenance on every field. `origin` is where the number came from and collapses
 * to SYNTHETIC across this whole mission, because no part of it was recorded. `transform` is what
 * produced it, and that is where the information is. Both flow into the facts pack so the analyst
 * says simulated and never says recorded.
 */
const P = (transform, note) => ({ origin: 'SYNTHETIC', transform, note });

// ------------------------------------------------------------------ channels
//
// All six are Blue 1's ONBOARD log. The referee bus never reports another robot's HP, heat, pose or
// ammunition to a robot, so none of that is here. Both teams' HP exists in the payload for the
// scene HUD only and is labelled organizer view there.
//
// Chart constraints these are cut to: one channel at a time, at most six series, and only two unit
// groups get a labelled axis. Every channel below has at most two units and the planner has one.

export const channels = [
  {
    path: '/blue1/vision',
    label: 'Blue 1 target tracking',
    note:
      'Synthetic. The detector republishes its last good target on a missed detection, stamped at ' +
      'PUBLISH time rather than capture time, which is the documented behaviour of the reference ' +
      'stack and the gap this fault lives in. There is no track id, no sequence number and no ' +
      'track age anywhere in that path; teams that cared added those fields themselves.',
    fields: [
      {
        key: 'confidence',
        label: 'confidence',
        unit: '',
        provenance: P(
          'DERIVED_TRACK_LAYER',
          'detector confidence, 0 to 1. The reference stack publishes a boolean detected flag and no confidence at all, so this is the team-layer field a real stack of the era would have had to add',
        ),
      },
      {
        key: 'trackAgeS',
        label: 'trackAgeS',
        unit: 's',
        provenance: P(
          'DERIVED_TRACK_LAYER',
          'capture-age ground truth: seconds since the last ACCEPTED detection of the held target, computed by the logger. Zero whenever no track is held. The robot never reads it, and that is why the fault runs',
        ),
      },
    ],
  },
  {
    path: '/blue1/localization',
    label: 'Blue 1 localization',
    note:
      'Synthetic. Included as a control: nothing on this channel fails. It is here so the ' +
      'rotation in the fault window is visibly a chassis rotation and not a position estimate ' +
      'coming apart, and so the magnetometer yaw blip has somewhere honest to live.',
    fields: [
      {
        key: 'xM',
        label: 'xM',
        unit: 'm',
        provenance: P('DERIVED_POSE_ESTIMATE', 'chassis centre in the field frame, origin at the bottom-left inner corner, +x along the 8 m length'),
      },
      {
        key: 'yM',
        label: 'yM',
        unit: 'm',
        provenance: P('DERIVED_POSE_ESTIMATE', 'chassis centre in the field frame, +y along the 5 m width'),
      },
      {
        key: 'uwbResidualM',
        label: 'uwbResidualM',
        unit: 'm',
        provenance: P(
          'DERIVED_TEAM_LAYER',
          'distance between the UWB fix and the pose estimate. A TEAM-LAYER quantity: the public reference stack leaves its UWB subscriber unwired, so no published code computes this and it is labelled derived everywhere it appears',
        ),
      },
      {
        key: 'yawDeg',
        label: 'yawDeg',
        unit: 'deg',
        provenance: P('DERIVED_POSE_ESTIMATE', 'chassis heading in the map frame. The UWB yaw input is magnetometer-based and documented as noisy while turning'),
      },
    ],
  },
  {
    path: '/blue1/planner',
    label: 'Blue 1 planner',
    note:
      'Synthetic. One unit group, because both fields are metres. The global planner behind them ' +
      'replans at 3 Hz and both series are zero-order held onto the 10 Hz block grid.',
    fields: [
      {
        key: 'goalDistM',
        label: 'goalDistM',
        unit: 'm',
        provenance: P('DERIVED_PLANNER', 'straight-line distance from the chassis to the current chase goal. The chase goal is the held target position, so it freezes when the target does'),
      },
      {
        key: 'pathLenM',
        label: 'pathLenM',
        unit: 'm',
        provenance: P('DERIVED_PLANNER', 'arc length of the current global plan to that goal'),
      },
    ],
  },
  {
    path: '/blue1/chassis',
    label: 'Blue 1 chassis',
    note:
      'Synthetic. Three natively different cadences downsampled onto one 20 Hz block grid: ' +
      'velocity commands, wheel odometry and current telemetry. The odometry rate is INFERRED and ' +
      'is labelled as such rather than quoted as a measured fact.',
    fields: [
      {
        key: 'cmdSpeedMps',
        label: 'cmdSpeedMps',
        unit: 'm/s',
        provenance: P('DERIVED_LOCAL_PLANNER', 'magnitude of the commanded body velocity from the local planner'),
      },
      {
        key: 'measSpeedMps',
        label: 'measSpeedMps',
        unit: 'm/s',
        provenance: P('DERIVED_ODOMETRY', 'magnitude of the measured body velocity from wheel odometry. Wire units are millimetres per second; this is metres per second'),
      },
      {
        key: 'chassisCurrentA',
        label: 'chassisCurrentA',
        unit: 'A',
        provenance: P('DERIVED_POWER_TELEMETRY', 'chassis current. The wire field is milliamps; this is amps'),
      },
    ],
  },
  {
    path: '/blue1/gimbal_launcher',
    label: 'Blue 1 gimbal and launcher',
    note:
      'Synthetic, and the fire gate is the one field here that has no counterpart in any public ' +
      'reference stack: that stack ships no fire control at all. This is the team-level controller ' +
      'real competitors wrote, and the fault is in its freshness check, which reads a publish-time ' +
      'stamp that is refreshed on every republish.',
    fields: [
      {
        key: 'gimbalYawDeg',
        label: 'gimbalYawDeg',
        unit: 'deg',
        provenance: P('DERIVED_GIMBAL_CONTROLLER', 'absolute map-frame gimbal yaw, clamped to the chassis heading plus or minus the hardware limit'),
      },
      {
        key: 'targetBearingDeg',
        label: 'targetBearingDeg',
        unit: 'deg',
        provenance: P('DERIVED_TRACK_LAYER', 'map-frame bearing from Blue 1 to the currently HELD target position, held at its last value when no track is held so the series stays continuous'),
      },
      {
        key: 'fireGate',
        label: 'fireGate',
        unit: '',
        provenance: P('DERIVED_FIRE_CONTROLLER', 'the synthetic team fire controller\'s gate, sampled continuously as 0 or 1. Per-shot muzzle speeds are in the event ledger, not on a chart'),
      },
    ],
  },
  {
    path: '/blue1/referee',
    label: 'Blue 1 referee',
    note:
      'Synthetic, produced by the referee arithmetic engine: the authored-mechanics subset of the ' +
      'V1.1 state machine, not the whole thing. Heat, armour damage, the defense buff, the ' +
      'supplier, survivor bits and the win ladder are implemented; overspeed, module-offline, ' +
      'ejection and collision are not, and this round authors none of them. Own-robot state only.',
    fields: [
      {
        key: 'remainHP',
        label: 'remainHP',
        unit: 'HP',
        provenance: P('DERIVED_REFEREE_ENGINE', 'Blue 1\'s own remaining HP, after that tick\'s deduction'),
      },
      {
        key: 'shooterHeat0',
        label: 'shooterHeat0',
        unit: 'heat',
        provenance: P(
          'DERIVED_REFEREE_ENGINE',
          'barrel heat at each 10 Hz settlement tick, PRE-SETTLEMENT: every shot in the tick has been added and the tick\'s overheat deduction and cooling have not yet been applied, so the peak reached inside a tick is visible in the array',
        ),
      },
    ],
  },
];

// ------------------------------------------------------------------ findings
//
// Six: the four hops of the chain, plus two secondary beats from the frozen beat sheet. Every
// number below is rendered from claims.mjs and is bound there to a channel, a field and a
// timestamp, or to a named event list. Nothing here is typed by hand.

export const findings = [
  {
    id: 'stale-track',
    title: `Target track goes stale at ${T('lastAcceptedCaptureS')} s and keeps being consumed`,
    window: [69.0, 76.0],
    t: 72.0,
    severity: 'warn',
    focus: { channel: '/blue1/vision', fields: ['confidence', 'trackAgeS'] },
    highlight: 'blue1',
    slowmo: true,
    note:
      `Blue 1 is holding Red 2 cleanly: confidence peaks at ${T('confidencePeakPreLoss')} at ` +
      `${T('confidencePeakPreLossS')} s. The last accepted detection lands at ` +
      `${T('lastAcceptedCaptureS')} s, and on the very next sample of the ${T('visionRateHz')} Hz ` +
      `grid, ${T('firstOccludedSampleS')} s, confidence collapses to ` +
      `${T('confidenceAtFirstOccluded')} and stays there. trackAgeS ramps straight off that stamp ` +
      `and reaches ${T('trackAgePeakS')} s at ${T('trackAgePeakTS')} s before the team layer's ` +
      `${T('staleTimeoutS')} s timeout finally drops the track at ${T('fireGateCloseS')} s. ` +
      `Nothing downstream stops consuming the target in between.`,
    honesty:
      'Synthetic, but the mechanism is the documented behaviour of the public reference stack: on ' +
      'a missed detection it republishes the last good pose with the detected flag still true, ' +
      'stamped at publish time, so a downstream age check reads a fresh stamp on a stale pose. ' +
      'trackAgeS is what the LOGGER can compute, not a field the robot had.',
  },
  {
    id: 'frozen-goal',
    title: `Chase goal freezes at ${T('goalFrozenM')} m`,
    window: [71.0, 76.0],
    t: 72.3,
    severity: 'warn',
    focus: { channel: '/blue1/planner', fields: ['goalDistM', 'pathLenM'] },
    highlight: 'blue1',
    slowmo: false,
    note:
      `The chase goal is the held target position, so it freezes with it. goalDistM and pathLenM ` +
      `both sit on ${T('goalFrozenM')} m from ${T('goalFrozenStartS')} s to ` +
      `${T('goalFrozenEndS')} s, ${T('goalFrozenSampleCount')} consecutive samples of a ` +
      `${T('plannerRateHz')} Hz block grid whose native source replans at ` +
      `${T('plannerNativeZohHz')} Hz. Nothing is wrong with the planner. It is solving correctly ` +
      `against a goal that stopped being updated, which is what a frozen upstream message looks ` +
      `like exactly one hop downstream.`,
    honesty:
      'Synthetic. A flat line is the weakest possible evidence on its own, which is why it is ' +
      'worth having the hop before it and the hop after it on their own channels with their own ' +
      'clocks: the freeze is only meaningful because it starts on the stale stamp.',
  },
  {
    id: 'blind-burst',
    title: `Chassis rotates to a held bearing and fires ${T('burstShotCount')} rounds into an obstacle`,
    window: [72.0, 75.5],
    t: 72.6,
    severity: 'alert',
    focus: { channel: '/blue1/gimbal_launcher', fields: ['gimbalYawDeg', 'targetBearingDeg', 'fireGate'] },
    highlight: 'blue1',
    slowmo: true,
    note:
      `targetBearingDeg is the bearing to the HELD position, so it is frozen at ` +
      `${T('heldBearingDeg')} deg throughout. At ${T('fireGateOpenS')} s the gimbal is saturated ` +
      `at ${T('gimbalSaturatedDeg')} deg, hard against its ${T('gimbalYawRelDegLimit')} deg ` +
      `chassis-relative limit, because the chassis is heading ` +
      `${T('chassisYawAtGateOpenDeg')} deg: the held point is not reachable by the turret alone. ` +
      `So the chassis turns. yawDeg slews to ${T('chassisYawAtBurstEndDeg')} deg by ` +
      `${T('goalFrozenEndS')} s while measSpeedMps never exceeds ` +
      `${T('measSpeedCeilingDuringRotationMps')} m/s, which is a rotation in place and not a ` +
      `chase, and chassisCurrentA peaks at ${T('chassisCurrentPeakA')} A at ` +
      `${T('chassisCurrentPeakTS')} s. The gimbal lands on the held bearing at ` +
      `${T('gimbalConvergedS')} s and the fire gate is already open: ${T('burstShotCount')} ` +
      `rounds at ${T('burstCadenceHz')} per second and ${T('burstMuzzleMps')} m/s, from ` +
      `${T('burstFirstShotS')} s to ${T('burstLastShotS')} s, every one of them into obstacle O` +
      `${T('incidentObstacleIndex')}.`,
    honesty:
      'Synthetic, and the fire decision is attributed to a team-level controller because the ' +
      'public reference stack has none: its shoot command is advertised and called by nothing. ' +
      'The gate is passing its own freshness check honestly. It is checking the wrong stamp.',
  },
  {
    id: 'overheat-self-damage',
    title: `Barrel heat crosses ${T('heatLimit')} and Blue 1 takes ${T('overheatLossHP')} HP off itself`,
    window: [72.0, 79.0],
    t: 74.5,
    severity: 'alert',
    focus: { channel: '/blue1/referee', fields: ['shooterHeat0', 'remainHP'] },
    highlight: 'blue1',
    slowmo: true,
    note:
      `Barrel heat rises by the measured muzzle speed of every shot, so ${T('burstShotCount')} ` +
      `rounds at ${T('burstMuzzleMps')} m/s add ${T('burstHeatAdded')} heat against a limit of ` +
      `${T('heatLimit')} while cooling only sheds ${T('coolingPerSecond')} per second. ` +
      `shooterHeat0 is exported as the pre-settlement value at each ${T('settlementRateHz')} Hz ` +
      `tick, so the peak the round actually reaches is in the array: ${T('peakShooterHeat0')} at ` +
      `${T('peakShooterHeat0TS')} s. Over the limit the referee deducts ` +
      `${T('heatOverDeductionMultiplier')} HP per unit of excess per tick. Eight ticks deduct, ` +
      `${T('firstDeductionTickS')} s through ${T('lastDeductionTickS')} s, for ` +
      `${T('overheatLossHP')} HP, and remainHP staircases from ${T('initialHP')} to ` +
      `${T('hpAfterFirstDeduction')} to ${T('hpAfterIncident')}. The tail is the part worth ` +
      `watching: the fire gate closes at ${T('fireGateCloseS')} s and the deductions keep running ` +
      `to ${T('lastDeductionTickS')} s, because heat only sheds ${T('coolingPerTick')} per tick ` +
      `and that is how long it takes to fall back through ${T('heatLimit')}. Blue 1 has taken no ` +
      `enemy fire at all at this point.`,
    honesty:
      'Synthetic, and the arithmetic is re-derived independently from the shot and hit ledgers in ' +
      'the test suite using only the manual equations, then diffed sample for sample against the ' +
      'exported arrays. The engine implements the authored mechanics and says so: overspeed, ' +
      'module-offline, ejection and collision are not implemented and this round authors none.',
  },
  {
    id: 'buff-halved-damage',
    title: `Defense buff halves armour damage to ${T('buffedArmorDamageHP')} HP, and none of it is on this robot`,
    window: [35.0, 65.0],
    t: 40.1,
    severity: 'info',
    focus: { channel: '/blue1/referee', fields: ['remainHP'] },
    highlight: 'blue2',
    slowmo: false,
    note:
      `Blue 2 screens through the whole of Blue's defense buff, ${T('blueBuffStartS')} s to ` +
      `${T('blueBuffEndS')} s, and four armour hits inside that window register ` +
      `${T('buffedArmorDamageHP')} HP each instead of ${T('armorDamageHP')}, which is the halving ` +
      `the rules define for the zone's owning team. None of that is visible on a Blue 1 channel. ` +
      `remainHP holds flat at ${T('blue1HPThroughBuffWindow')} HP across the entire window, ` +
      `because Blue 1 is not hit once before ${T('firstEnemyHitOnBlue1S')} s and because the ` +
      `referee bus never reports another robot's health to this robot. The halved hits are in the ` +
      `round event ledger, which is an organizer view.`,
    honesty:
      'Synthetic. The flat line is the honest picture of what Blue 1 itself logged, and it is here ' +
      'deliberately: a robot cannot see its team-mate being shot, and a demo that quietly showed ' +
      'you enemy state on an onboard channel would be teaching the wrong thing about this bus.',
  },
  {
    id: 'uwb-yaw-residual',
    title: `UWB yaw residual blips to ${T('uwbResidualPeakM')} m under fast rotation, and it is not a fault`,
    window: [43.0, 49.0],
    t: 46.0,
    severity: 'info',
    focus: { channel: '/blue1/localization', fields: ['uwbResidualM', 'yawDeg'] },
    highlight: 'blue1',
    slowmo: false,
    note:
      `Fast reorientation in the mid-round firefight pushes the residual between the UWB fix and ` +
      `the pose estimate from a ${T('uwbResidualBaselineM')} m baseline to ` +
      `${T('uwbResidualPeakM')} m at ${T('uwbResidualPeakTS')} s, and it settles back under ` +
      `${T('uwbResidualSettleM')} m within about half a second. This is not a fault. UWB yaw comes ` +
      `off a magnetometer and is documented as noisy while the chassis is turning hard.`,
    honesty:
      'Synthetic, and the residual itself is a TEAM-LAYER derivation: the public reference stack ' +
      'never wires its UWB subscriber, so nothing published fuses these two estimates and no real ' +
      'log of that era would have carried this field. It is included because it is exactly the ' +
      'kind of blip that gets misread as a localization failure when the log cannot rule it out.',
  },
];

// ------------------------------------------------------------------ scene-data contract

/** @type {Promise<object>|null} cached, idempotent. */
let matchPromise = null;
/** @type {object|null} decoded BattleData, once loaded. */
let matchData = null;

/**
 * Everything the rest of this module needs from a decoded payload, checked ONCE at load time.
 *
 * Here and not in `buildData` because of WHERE the two run: `buildData` runs synchronously after
 * the load promise resolved, so a throw from it is an unhandled rejection and a half-built screen.
 * `loadSceneData()` has a rejection path with the unavailable card on it, and a payload that
 * decodes cleanly but is missing a channel this mission is about is exactly what that path is for.
 *
 * @param {object} M decoded BattleData
 * @throws {Error} with `retryable: true`
 */
export function validateSceneData(M) {
  const problems = [];
  if (!M || typeof M !== 'object') problems.push('nothing decoded');
  if (M && M.variant !== 'match') problems.push(`variant is "${M.variant}", not the full match`);
  if (M && (!M.poses || !M.poses.t || !M.poses.t.length)) problems.push('no pose track');
  if (M && (!M.hp || !M.hp.t || !M.hp.t.length)) problems.push('no organizer HP timeline');
  if (M && (!M.events || !Array.isArray(M.events.shots))) problems.push('no event ledger');
  if (M && !M.incident) problems.push('no incident contract');
  if (M && M.channels) {
    for (const ch of channels) {
      const block = M.channels[ch.path];
      if (!block) {
        problems.push(`channel ${ch.path} is not in the payload`);
        continue;
      }
      for (const f of ch.fields) {
        if (!block.fields[f.key]) problems.push(`${ch.path}.${f.key} is not in the payload`);
      }
    }
  } else if (M) {
    problems.push('no channels');
  }
  if (problems.length) {
    const e = new Error(`battle/data.js: the decoded round payload is unusable - ${problems.join('; ')}`);
    e.retryable = true;
    throw e;
  }
  return M;
}

/**
 * Load and decode the full round module. Repeated calls return the SAME promise.
 *
 * Retry semantics are split because the two failures are not the same failure:
 *   - a DECODER failure clears the cache, so calling again retries;
 *   - a module IMPORT/EVALUATION failure does NOT, because the ES module map caches a failed
 *     evaluation by specifier for the life of the document. That one needs a reload, and the
 *     rejection carries `retryable: false` so the unavailable-card copy can say so.
 *
 * @returns {Promise<object>} decoded BattleData
 */
export function loadSceneData() {
  if (matchPromise) return matchPromise;
  const p = import('./battle-data.js')
    .then(
      (mod) => {
        matchData = validateSceneData(decodeBattleData(mod));
        return matchData;
      },
      (err) => {
        const e = new Error('The round module could not be loaded. Reload the page to try again.');
        e.retryable = false;
        e.cause = err;
        throw e;
      },
    )
    .catch((err) => {
      if (err && err.retryable === false) throw err;
      if (matchPromise === p) matchPromise = null;
      const e = new Error(
        err && /unusable/.test(err.message || '')
          ? 'The round decoded but is missing the channels this mission is about.'
          : 'The round data could not be decoded.',
      );
      e.retryable = true;
      e.cause = err;
      throw e;
    });
  matchPromise = p;
  return p;
}

/** True once the full round is decoded and `buildData` may run. */
export function isSceneDataLoaded() {
  return matchData !== null;
}

/**
 * The decoded round if it is loaded, otherwise the preview slice. Both come out of the same
 * decoder with the same shape, so a consumer never branches on which one it got.
 */
export function getSceneData() {
  return matchData || previewData;
}

/**
 * A 6 s slice at 4 Hz, decoded here at module scope on purpose: it is sub-millisecond, and the
 * try/catch means a bad preview blob degrades the picker card instead of killing the whole robot.
 * @type {object|null}
 */
export let previewData = null;
try {
  previewData = decodeBattleData(previewModule);
} catch (err) {
  previewData = null;
}

/** Test hook: forget the loaded round so the tripwire can be exercised. */
export function __resetSceneDataForTests() {
  matchPromise = null;
  matchData = null;
}

// ------------------------------------------------------------------ the builder

/** Float32 payload column to the Float64 the chart and the facts builder consume. */
function widen(src) {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

/**
 * Chart telemetry for the whole round.
 *
 * Pure and deterministic: the only input is the decoded payload. There is no in-browser
 * simulation here on purpose. A 3 minute 2v2 with ballistics and piecewise heat arithmetic has to
 * be reviewable frame by frame and replay-provable, so it is authored offline by a generator whose
 * output a verifier re-derives; this function only reshapes the decoded arrays onto the def
 * contract. `prng` is accepted because the contract passes one and is deliberately unused:
 * nothing here is randomised at render time.
 *
 * @param {() => number} prng seeded stream, supplied by app.js / build-facts. Unused.
 * @returns {object} `{ "<channel path>": { t, "<field key>": Float64Array } }`
 */
export function buildData(prng) {
  const M = matchData;
  if (!M) {
    const e = new Error(
      'battle/data.js: buildData() was called before loadSceneData() resolved. The battle channels ' +
        'are decoded from the round module, which loads lazily - await def.loadSceneData() first.',
    );
    e.code = 'BATTLE_BUILD_BEFORE_LOAD';
    throw e;
  }
  const out = {};
  for (const ch of channels) {
    const block = M.channels[ch.path];
    const built = { t: widen(block.t) };
    for (const f of ch.fields) built[f.key] = widen(block.fields[f.key]);
    out[ch.path] = built;
  }
  return out;
}

// ------------------------------------------------------------------ the round event ledger
//
// Categorical data does not belong on a chart. An enum plotted as a number is meaningless and its
// mean is worse, so armour directions, buff transitions, supplier steps, survivor bits and the
// result live in a typed event table inside the payload, and this is the narrow, fixed-format view
// of it that the facts pack renders as its own section.

/** Round a replay time the way every line in this table prints it. */
const ts = (t) => Number(t.toFixed(3));

/**
 * The load-bearing events of the round, as typed rows.
 *
 * A FUNCTION, not a constant, and callable only after `loadSceneData()` resolves: the ledger is in
 * the lazily loaded module. The facts builder already awaits the load before it calls `buildData`
 * and calls this at the same point; a def without this hook emits no section at all.
 *
 * Fixed format, capped well under thirty rows, sorted by time. What is in it: both supplier
 * bookings and both issues, every defense-zone transition and both refresh marks, all eight
 * overheat deduction ticks, the first and last round of the burst, the closing survivor bitmask
 * and the result.
 *
 * @returns {Array<{t:number, source:string, kind:string, detail:string}>}
 */
export function eventLines() {
  const M = matchData;
  if (!M) {
    const e = new Error(
      'battle/data.js: eventLines() was called before loadSceneData() resolved. The event ledger ' +
        'ships inside the round module - await def.loadSceneData() first.',
    );
    e.code = 'BATTLE_EVENTS_BEFORE_LOAD';
    throw e;
  }
  const E = M.events;
  const rows = [];

  // supplier: the booking and the issue. The two intermediate SUPPLYING steps are dropped; the
  // booking is what the team asked for and the close is when the rounds are actually credited.
  for (const s of E.supplier) {
    if (s.step === 'PREPARING') {
      rows.push({
        t: ts(s.t),
        source: 'field_supplier_status',
        kind: 'PREPARING',
        detail: `${s.team} books ${s.supplyNum} rounds at ${s.zone}, instruction ${s.instructionInMinute} of this minute`,
      });
    } else if (s.step === 'CLOSE') {
      rows.push({
        t: ts(s.t),
        source: 'field_supplier_status',
        kind: 'CLOSE',
        detail: `${s.supplyNum} rounds issued to robot ${s.robotId}`,
      });
    }
  }

  // defense zones: dwell start, activation, expiry, and the activation-budget refresh marks
  for (const z of E.zones) {
    rows.push({
      t: ts(z.t),
      source: 'field_bonus_status',
      kind: z.state,
      detail:
        z.state === 'REFRESH'
          ? `activation budgets reset for window ${z.refreshWindow}`
          : `${z.zone} (${z.owner}), activations used ${z.activationsUsedInWindow}`,
    });
  }

  // the burst: first and last round only. All fourteen are in the payload's shot ledger.
  const burst = E.shots.filter((s) => s.kind === 'BURST');
  if (burst.length) {
    const first = burst[0];
    const last = burst[burst.length - 1];
    rows.push({
      t: ts(first.t),
      source: 'robot_shoot',
      kind: 'BURST_FIRST',
      detail: `robot ${first.robotId} opens fire at ${first.muzzleMps} m/s into obstacle ${first.struckObstacle}`,
    });
    rows.push({
      t: ts(last.t),
      source: 'robot_shoot',
      kind: 'BURST_LAST',
      detail: `round ${burst.length} of ${burst.length}, still into obstacle ${last.struckObstacle}`,
    });
  }

  // every overheat deduction tick, one row each
  for (const d of E.damage) {
    if (d.damageType !== 'EXCEED_HEAT') continue;
    rows.push({
      t: ts(d.t),
      source: 'robot_damage',
      kind: 'EXCEED_HEAT',
      detail: `robot ${d.targetId} deducted ${d.amount} HP, no damage source`,
    });
  }

  // the closing survivor bitmask and the result
  const survivor = E.survivors[E.survivors.length - 1];
  if (survivor) {
    rows.push({
      t: ts(survivor.t),
      source: 'game_survivor',
      kind: 'SURVIVORS',
      detail: Object.keys(survivor.bits)
        .map((k) => `${k}=${survivor.bits[k] ? 1 : 0}`)
        .join(' '),
    });
  }
  const r = E.result;
  rows.push({
    t: ts(r.t),
    source: 'game_result',
    kind: r.gameProgress,
    detail: `${r.winner} on deduction, red ${r.deduction.red} to blue ${r.deduction.blue}`,
  });

  rows.sort((a, b) => a.t - b.t);
  return rows;
}
