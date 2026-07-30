// battle/claims.mjs - THE CLAIM LEDGER for the `battle` mission.
//
// Why this file exists. "The number 548 appears somewhere in some array" can never validate a
// sentence. Every number this mission puts in front of a reader is registered here, in one of two
// kinds that are validated in two completely different ways:
//
//   CITED_CONSTANTS  values that come out of the rules manual. They are checked against the frozen
//                    rules echo in the payload and against nothing else. Telemetry cannot confirm
//                    or refute a rule, and a constant that happened to match a sample would be a
//                    coincidence, not a validation.
//   DATA_CLAIMS      values that come out of THIS round. Each one is bound to a channel, a field
//                    and a timestamp, or to a named event list, so a copy check resolves it
//                    against the exact exported sample instead of pattern-matching a digit string.
//
// `demo/js/robots/battle/data.js` renders every finding narrative from these entries, so the prose
// and the ledger cannot drift apart, and `battle-data.test.mjs` scans the rendered narratives for
// numeric tokens and fails on any number that is not in this file. Between the two, a number in
// the copy is either in the payload or it is a build failure.
//
// Rendering: `text` is the exact string the copy prints, `expected` is the value the test compares
// against the payload. They are separate on purpose: "0.960" and 0.96 are the same number and only
// one of them is the sentence.

/** Time comparisons are on a 10 Hz to 25 Hz grid; this is half a millisecond of slack. */
export const TIME_TOL_S = 5e-4;
/** Float32 round-tripping of a quantized sample. */
export const VALUE_TOL = 5e-4;

// ------------------------------------------------------------------ cited constants
//
// Rules Manual V1.1 (2019-04-23). V1.0's heat numbers are all doubled and must never be mixed in.

export const CITED_CONSTANTS = {
  initialHP: { value: 2000, text: '2000', unit: 'HP', source: 'S2.2.1' },
  roundDurationS: { value: 180, text: '180', unit: 's', source: 'S3.1' },
  heatLimit: { value: 180, text: '180', unit: 'heat', source: 'S2.3.1.1' },
  heatOverDeductionMultiplier: { value: 4, text: '4', unit: 'HP per heat per tick', source: 'S2.3.1.1' },
  settlementRateHz: { value: 10, text: '10', unit: 'Hz', source: 'S2.3.1.1' },
  coolingPerSecond: { value: 60, text: '60', unit: 'heat/s', source: 'S2.3.1.1' },
  coolingPerTick: {
    value: 6.0,
    text: '6.0',
    unit: 'heat/tick',
    source: 'S2.3.1.1 (60 heat/s settled on the 10 Hz grid)',
  },
  coolingPerSecondBelow400HP: { value: 120, text: '120', unit: 'heat/s', source: 'S2.3.1.1' },
  lowHpCoolingThresholdHP: { value: 400, text: '400', unit: 'HP', source: 'S2.3.1.1' },
  armorDamageHP: { value: 50, text: '50', unit: 'HP', source: 'S2.3.1.2' },
  buffedArmorDamageHP: { value: 25, text: '25', unit: 'HP', source: 'S4.4' },
  muzzleLimitMps: { value: 25, text: '25', unit: 'm/s', source: 'S2.3.1.1' },
  impactFloorMps: { value: 12, text: '12', unit: 'm/s', source: 'S2.3.1.1' },
  armorDetectionMaxHz: { value: 20, text: '20', unit: 'Hz', source: 'S2.3.1.2' },
  burstCadenceMaxPerS: { value: 10, text: '10', unit: 'rounds/s', source: 'AI Robot User Manual V1.1' },
  defenseDwellS: { value: 5, text: '5', unit: 's', source: 'S4.4' },
  defenseBuffS: { value: 30, text: '30', unit: 's', source: 'S4.4' },
  activationsPerWindow: { value: 2, text: '2', unit: 'activations', source: 'S4.4' },
  supplyRounds: { value: 50, text: '50', unit: 'rounds', source: 'S4.3.2' },
  instructionsPerTeamPerMinute: { value: 2, text: '2', unit: 'instructions', source: 'S4.3.2' },
  preloadRounds: { value: 40, text: '40', unit: 'rounds', source: 'S2.2.1 / S3.5.1' },
  gimbalYawRelDegLimit: { value: 90, text: '90', unit: 'deg', source: 'AI Robot User Manual V1.1' },
  projectileMassG: { value: 2.9, text: '2.9', unit: 'g', source: 'S4.9' },
  projectileDiameterMm: { value: 16.9, text: '16.9', unit: 'mm', source: 'S4.9' },
};

/**
 * Wire ids and callsign numerals. Not rules constants and not measurements: identifiers. They are
 * in the ledger because "Blue 1" and "red 3/4, blue 13/14" put digits in the copy and a numeric
 * scan cannot tell an identifier from a claim on its own.
 */
export const ROSTER_NUMERALS = {
  callsignOne: { value: 1, text: '1', unit: 'callsign', source: 'fictional callsign' },
  callsignTwo: { value: 2, text: '2', unit: 'callsign', source: 'fictional callsign' },
  red1WireId: { value: 3, text: '3', unit: 'wire id', source: 'protocol V1.1 (red 3/4)' },
  red2WireId: { value: 4, text: '4', unit: 'wire id', source: 'protocol V1.1 (red 3/4)' },
  blue1WireId: { value: 13, text: '13', unit: 'wire id', source: 'protocol V1.1 (blue 13/14)' },
  blue2WireId: { value: 14, text: '14', unit: 'wire id', source: 'protocol V1.1 (blue 13/14)' },
  incidentObstacleIndex: { value: 7, text: '7', unit: 'obstacle id', source: 'geometry manifest, O7' },
};

// ------------------------------------------------------------------ data-derived claims
//
// tOrEventId: a number is a replay timestamp on the bound channel; a string names the event list
// (and, in brackets, the subset) the claim is resolved against.

export const DATA_CLAIMS = {
  // ---- cadence. Verifiable exactly from each channel's own time axis.
  visionRateHz: { expected: 25, text: '25', unit: 'Hz', channel: '/blue1/vision', field: null, tOrEventId: 'channel.rateHz' },
  localizationRateHz: { expected: 10, text: '10', unit: 'Hz', channel: '/blue1/localization', field: null, tOrEventId: 'channel.rateHz' },
  plannerRateHz: { expected: 10, text: '10', unit: 'Hz', channel: '/blue1/planner', field: null, tOrEventId: 'channel.rateHz' },
  plannerNativeZohHz: { expected: 3, text: '3', unit: 'Hz', channel: '/blue1/planner', field: 'goalDistM', tOrEventId: 'channel.field.nativeZohHz' },
  chassisRateHz: { expected: 20, text: '20', unit: 'Hz', channel: '/blue1/chassis', field: null, tOrEventId: 'channel.rateHz' },
  gimbalRateHz: { expected: 25, text: '25', unit: 'Hz', channel: '/blue1/gimbal_launcher', field: null, tOrEventId: 'channel.rateHz' },
  refereeRateHz: { expected: 10, text: '10', unit: 'Hz', channel: '/blue1/referee', field: null, tOrEventId: 'channel.rateHz' },

  // ---- F1, the stale track
  confidencePeakPreLossS: { expected: 70.28, text: '70.28', unit: 's', channel: '/blue1/vision', field: 'confidence', tOrEventId: 'argmax over [69.0, 72.0]' },
  confidencePeakPreLoss: { expected: 0.96, text: '0.960', unit: '', channel: '/blue1/vision', field: 'confidence', tOrEventId: 70.28 },
  lastAcceptedCaptureS: { expected: 72.0, text: '72.00', unit: 's', channel: '/blue1/vision', field: 'trackAgeS', tOrEventId: 72.0, note: 'trackAgeS is zero on this sample and ramps from it' },
  confidenceAtLastCapture: { expected: 0.587, text: '0.587', unit: '', channel: '/blue1/vision', field: 'confidence', tOrEventId: 72.0 },
  firstOccludedSampleS: { expected: 72.04, text: '72.04', unit: 's', channel: '/blue1/vision', field: 'confidence', tOrEventId: 72.04 },
  confidenceAtFirstOccluded: { expected: 0.041, text: '0.041', unit: '', channel: '/blue1/vision', field: 'confidence', tOrEventId: 72.04 },
  trackAgePeakS: { expected: 2.52, text: '2.520', unit: 's', channel: '/blue1/vision', field: 'trackAgeS', tOrEventId: 74.52 },
  trackAgePeakTS: { expected: 74.52, text: '74.52', unit: 's', channel: '/blue1/vision', field: 'trackAgeS', tOrEventId: 'argmax over [72.0, 76.0]' },
  staleTimeoutS: { expected: 2.55, text: '2.55', unit: 's', channel: '/blue1/vision', field: 'trackAgeS', tOrEventId: 'incident.staleTimeoutS' },

  // ---- F2, the frozen chase goal
  goalFrozenM: { expected: 0.551, text: '0.551', unit: 'm', channel: '/blue1/planner', field: 'goalDistM', tOrEventId: 72.3 },
  goalFrozenStartS: { expected: 72.0, text: '72.00', unit: 's', channel: '/blue1/planner', field: 'goalDistM', tOrEventId: 72.0 },
  goalFrozenEndS: { expected: 74.6, text: '74.60', unit: 's', channel: '/blue1/planner', field: 'goalDistM', tOrEventId: 74.6 },
  goalFrozenSampleCount: { expected: 27, text: '27', unit: 'samples', channel: '/blue1/planner', field: 'goalDistM', tOrEventId: 'run length over [72.0, 74.6]' },

  // ---- F3, the blind rotation and burst
  heldBearingDeg: { expected: 13.54, text: '13.54', unit: 'deg', channel: '/blue1/gimbal_launcher', field: 'targetBearingDeg', tOrEventId: 73.0 },
  gimbalSaturatedDeg: { expected: 40.0, text: '40.00', unit: 'deg', channel: '/blue1/gimbal_launcher', field: 'gimbalYawDeg', tOrEventId: 72.6 },
  gimbalConvergedS: { expected: 72.96, text: '72.96', unit: 's', channel: '/blue1/gimbal_launcher', field: 'gimbalYawDeg', tOrEventId: 'first sample equal to the held bearing after 72.6' },
  chassisYawAtGateOpenDeg: { expected: 129.97, text: '129.97', unit: 'deg', channel: '/blue1/localization', field: 'yawDeg', tOrEventId: 72.6 },
  chassisYawAtBurstEndDeg: { expected: 7.65, text: '7.65', unit: 'deg', channel: '/blue1/localization', field: 'yawDeg', tOrEventId: 74.6 },
  measSpeedCeilingDuringRotationMps: { expected: 0.02, text: '0.020', unit: 'm/s', channel: '/blue1/chassis', field: 'measSpeedMps', tOrEventId: 'max over [72.6, 74.6]' },
  chassisCurrentPeakA: { expected: 4.286, text: '4.286', unit: 'A', channel: '/blue1/chassis', field: 'chassisCurrentA', tOrEventId: 73.75 },
  chassisCurrentPeakTS: { expected: 73.75, text: '73.75', unit: 's', channel: '/blue1/chassis', field: 'chassisCurrentA', tOrEventId: 'argmax over [72.6, 74.6]' },
  fireGateOpenS: { expected: 72.6, text: '72.60', unit: 's', channel: '/blue1/gimbal_launcher', field: 'fireGate', tOrEventId: 'first high sample of the burst run' },
  fireGateCloseS: { expected: 74.55, text: '74.55', unit: 's', channel: '/blue1/gimbal_launcher', field: 'fireGate', tOrEventId: 'incident.fireGateCloseS' },
  burstShotCount: { expected: 14, text: '14', unit: 'shots', channel: null, field: null, tOrEventId: 'events.shots[BURST]' },
  burstCadenceHz: { expected: 7.0, text: '7.0', unit: 'rounds/s', channel: null, field: null, tOrEventId: 'events.shots[BURST] spacing' },
  burstMuzzleMps: { expected: 23.0, text: '23.0', unit: 'm/s', channel: null, field: null, tOrEventId: 'events.shots[BURST].muzzleMps' },
  burstFirstShotS: { expected: 72.6, text: '72.60', unit: 's', channel: null, field: null, tOrEventId: 'events.shots[BURST][0].t' },
  burstLastShotS: { expected: 74.457, text: '74.457', unit: 's', channel: null, field: null, tOrEventId: 'events.shots[BURST][13].t' },

  // ---- F4, the overheat and the self-inflicted deduction
  burstHeatAdded: { expected: 322, text: '322', unit: 'heat', channel: null, field: null, tOrEventId: 'sum of events.shots[BURST].muzzleMps' },
  crossingShotIndex: { expected: 12, text: '12', unit: 'shot', channel: null, field: null, tOrEventId: 'events.shots[BURST], first whose next tick reads over the limit' },
  crossingShotS: { expected: 74.171, text: '74.171', unit: 's', channel: null, field: null, tOrEventId: 'events.shots[BURST][11].t' },
  crossingHeat: { expected: 186.0, text: '186.0', unit: 'heat', channel: '/blue1/referee', field: 'shooterHeat0', tOrEventId: 74.2 },
  peakShooterHeat0: { expected: 214.0, text: '214.0', unit: 'heat', channel: '/blue1/referee', field: 'shooterHeat0', tOrEventId: 74.5 },
  peakShooterHeat0TS: { expected: 74.5, text: '74.50', unit: 's', channel: '/blue1/referee', field: 'shooterHeat0', tOrEventId: 'argmax over the whole round' },
  deductionTickCount: { expected: 8, text: '8', unit: 'ticks', channel: null, field: null, tOrEventId: 'events.damage[EXCEED_HEAT]' },
  firstDeductionTickS: { expected: 74.2, text: '74.20', unit: 's', channel: '/blue1/referee', field: 'remainHP', tOrEventId: 74.2 },
  lastDeductionTickS: { expected: 75.0, text: '75.00', unit: 's', channel: '/blue1/referee', field: 'remainHP', tOrEventId: 75.0 },
  hpAfterFirstDeduction: { expected: 1976, text: '1976', unit: 'HP', channel: '/blue1/referee', field: 'remainHP', tOrEventId: 74.2 },
  overheatLossHP: { expected: 548, text: '548', unit: 'HP', channel: null, field: null, tOrEventId: 'sum of events.damage[EXCEED_HEAT].amount' },
  hpAfterIncident: { expected: 1452, text: '1452', unit: 'HP', channel: '/blue1/referee', field: 'remainHP', tOrEventId: 75.0 },
  heatBackToZeroS: { expected: 78.1, text: '78.10', unit: 's', channel: '/blue1/referee', field: 'shooterHeat0', tOrEventId: 'first zero sample after 75.0' },

  // ---- F5, the defense buff and what a robot's own log cannot see
  blueBuffStartS: { expected: 35.0, text: '35.00', unit: 's', channel: null, field: null, tOrEventId: 'events.buffs[blue].tStartS' },
  blueBuffEndS: { expected: 65.0, text: '65.00', unit: 's', channel: null, field: null, tOrEventId: 'events.buffs[blue].tEndS' },
  buffedHitsOnBlue2: { expected: 4, text: '4', unit: 'hits', channel: null, field: null, tOrEventId: 'events.hits[target 14, amount 25]' },
  firstEnemyHitOnBlue1S: { expected: 120.44, text: '120.44', unit: 's', channel: null, field: null, tOrEventId: 'events.hits[target 13][0].t' },
  blue1HPThroughBuffWindow: { expected: 2000, text: '2000', unit: 'HP', channel: '/blue1/referee', field: 'remainHP', tOrEventId: 'constant over [35.0, 65.0]' },

  // ---- F6, the magnetometer yaw residual
  uwbResidualBaselineM: { expected: 0.042, text: '0.042', unit: 'm', channel: '/blue1/localization', field: 'uwbResidualM', tOrEventId: 'mean over [5.0, 35.0]' },
  uwbResidualPeakM: { expected: 0.357, text: '0.357', unit: 'm', channel: '/blue1/localization', field: 'uwbResidualM', tOrEventId: 46.0 },
  uwbResidualPeakTS: { expected: 46.0, text: '46.00', unit: 's', channel: '/blue1/localization', field: 'uwbResidualM', tOrEventId: 'argmax over [43.0, 49.0]' },
  uwbResidualSettleM: { expected: 0.05, text: '0.05', unit: 'm', channel: '/blue1/localization', field: 'uwbResidualM', tOrEventId: 'ceiling over [46.5, 47.5]' },

  // ---- round outcome
  armorLossBlue1: { expected: 350, text: '350', unit: 'HP', channel: null, field: null, tOrEventId: 'sum of events.hits[target 13].amount' },
  deductionRed: { expected: 1448, text: '1448', unit: 'HP', channel: null, field: null, tOrEventId: 'events.result.deduction.red' },
  deductionBlue: { expected: 1150, text: '1150', unit: 'HP', channel: null, field: null, tOrEventId: 'events.result.deduction.blue' },
  finalHPRed1: { expected: 1400, text: '1400', unit: 'HP', channel: null, field: null, tOrEventId: 'events.result.finalHP' },
  finalHPRed2: { expected: 1450, text: '1450', unit: 'HP', channel: null, field: null, tOrEventId: 'events.result.finalHP' },
  finalHPBlue1: { expected: 1102, text: '1102', unit: 'HP', channel: '/blue1/referee', field: 'remainHP', tOrEventId: 180.0 },
  finalHPBlue2: { expected: 1450, text: '1450', unit: 'HP', channel: null, field: null, tOrEventId: 'events.result.finalHP' },
  resultWinner: { expected: 'RED_WIN', text: 'RED_WIN', unit: 'result', channel: null, field: null, tOrEventId: 'events.result.winner' },
  counterfactualWinner: { expected: 'BLUE_WIN', text: 'BLUE_WIN', unit: 'result', channel: null, field: null, tOrEventId: 'events.damage minus EXCEED_HEAT, re-run through the win ladder' },
  counterfactualDeductionRed: { expected: 900, text: '900', unit: 'HP', channel: null, field: null, tOrEventId: 'events.damage minus EXCEED_HEAT' },
};

// ------------------------------------------------------------------ accessors

/** The string a claim prints. Throws on an unregistered name so a typo cannot become copy. */
export function text(name) {
  const c = DATA_CLAIMS[name] || CITED_CONSTANTS[name] || ROSTER_NUMERALS[name];
  if (!c) throw new Error(`battle/claims: no ledger entry named "${name}"`);
  return c.text;
}

/** The value a claim asserts. */
export function value(name) {
  const c = DATA_CLAIMS[name];
  if (c) return c.expected;
  const k = CITED_CONSTANTS[name] || ROSTER_NUMERALS[name];
  if (!k) throw new Error(`battle/claims: no ledger entry named "${name}"`);
  return k.value;
}

/**
 * Every number the ledger permits in copy, as a Set of JS numbers. The narrative scan in
 * battle-data.test.mjs parses each numeric token out of the rendered prose and requires it to be
 * in here, so a hand-typed number that nothing in the payload backs is a test failure.
 */
export function allowedNumbers() {
  const out = new Set();
  for (const table of [CITED_CONSTANTS, ROSTER_NUMERALS]) {
    for (const k of Object.keys(table)) out.add(table[k].value);
  }
  for (const k of Object.keys(DATA_CLAIMS)) {
    const v = DATA_CLAIMS[k].expected;
    if (typeof v === 'number') out.add(v);
  }
  return out;
}

/** The same set as the exact strings the copy prints, for a token-for-token comparison. */
export function allowedTexts() {
  const out = new Set();
  for (const table of [CITED_CONSTANTS, ROSTER_NUMERALS, DATA_CLAIMS]) {
    for (const k of Object.keys(table)) out.add(table[k].text);
  }
  return out;
}
