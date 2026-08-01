// donna/claims.mjs - claim ledger for the Donna mission.
//
// Every number rendered in finding or event prose is bound to a decoded channel sample or a named
// event row. There are no cited constants in Phase 2. The payload is the authority for every value.

export const CITED_CONSTANTS = {};

const event = (expected, text, unit, eventId, extra = {}) => ({
  expected,
  text,
  unit,
  channel: null,
  field: null,
  eventId,
  ...extra,
});

const structural = (expected, text, unit, structure, extra = {}) => ({
  expected,
  text,
  unit,
  channel: null,
  field: null,
  eventId: null,
  structure,
  ...extra,
});

const sample = (expected, text, unit, channel, field, t, extra = {}) => ({
  expected,
  text,
  unit,
  channel,
  field,
  t,
  eventId: null,
  ...extra,
});

export const DATA_CLAIMS = {
  // Finding 1, falls and recoveries.
  fallCount: event(6, '6', 'falls', 'events[fall]'),
  recoveryCount: event(6, '6', 'recoveries', 'events[fall]'),
  recoveryCeilingS: event(6.5, '6.5', 's', 'events[fall].recoverySec ceiling'),
  utteranceCount: event(6, '6', 'utterances', 'events[speak]'),
  distinctSpeakLineCount: event(4, '4', 'distinct lines', 'events[speak].detail distinct'),
  channelCount: structural(6, '6', 'channels', 'channels.length'),
  heroBallDistM: sample(0.265, '0.265', 'm', '/ball', 'ballDistM', 240.3, {
    derivation: 'Donna-relative from the filtered ball map pose and segmented localization pose',
  }),

  // Finding 2, battery sag.
  undervoltageCount: event(328, '328', 'statuses', 'servo-undervoltage'),
  minBusVoltageV: event(12.1, '12.1', 'V', 'servo-undervoltage'),

  // Finding 3, command clamps and the log's own limit strings.
  clampLAnklePitchCount: event(441, '441', 'warnings', 'servo-clamps'),
  clampRElbowCount: event(189, '189', 'warnings', 'servo-clamps'),
  clampLElbowCount: event(177, '177', 'warnings', 'servo-clamps'),
  clampLAnklePitchValue: event(-1.42043, '-1.42043', 'rad', 'servo-clamps.firstMessages.LAnklePitch'),
  clampLAnklePitchLow: event(-1.42, '-1.42', 'rad', 'servo-clamps.firstMessages.LAnklePitch'),
  clampLAnklePitchHigh: event(0.37, '0.37', 'rad', 'servo-clamps.firstMessages.LAnklePitch'),
  clampRElbowValue: event(-0.785398, '-0.785398', 'rad', 'servo-clamps.firstMessages.RElbow'),
  clampRElbowLow: event(-0.78, '-0.78', 'rad', 'servo-clamps.firstMessages.RElbow'),
  clampRElbowHigh: event(1.5708, '1.5708', 'rad', 'servo-clamps.firstMessages.RElbow'),
  clampLElbowValue: event(0.820305, '0.820305', 'rad', 'servo-clamps.firstMessages.LElbow'),
  clampLElbowLow: event(-1.5708, '-1.5708', 'rad', 'servo-clamps.firstMessages.LElbow'),
  clampLElbowHigh: event(0.78, '0.78', 'rad', 'servo-clamps.firstMessages.LElbow'),

  // Finding 4, score and whistle.
  scoreBeforeOwn: event(1, '1', 'goals', 'goal-2-0'),
  scoreFinalOwn: event(2, '2', 'goals', 'goal-2-0'),
  scoreRival: event(0, '0', 'goals', 'goal-2-0'),
  secondsRemainingAtGoal: event(-49, '-49', 's', 'goal-2-0'),
  finalWhistleT: event(286.596, '286.596', 's', 'final-whistle'),

  // Finding 5, live stream backpressure.
  streamDroppedCount: event(299, '299', 'messages', 'stream-backpressure'),

  // Event timestamps, including the READY/SET interval end.
  penaltyReentryT: event(31.207, '31.207', 's', 'penalty-reentry'),
  fall1T: event(94.848, '94.848', 's', 'fall-1'),
  fall2T: event(156.879, '156.879', 's', 'fall-2'),
  fall3T: event(166.609, '166.609', 's', 'fall-3'),
  fall4T: event(207.773, '207.773', 's', 'fall-4'),
  fall5T: event(217.362, '217.362', 's', 'fall-5'),
  fall6T: event(279.918, '279.918', 's', 'fall-6'),
  speak1T: event(99.964, '99.964', 's', 'speak-1'),
  speak2T: event(161.698, '161.698', 's', 'speak-2'),
  speak3T: event(171.531, '171.531', 's', 'speak-3'),
  speak4T: event(212.718, '212.718', 's', 'speak-4'),
  speak5T: event(222.282, '222.282', 's', 'speak-5'),
  speak6T: event(284.836, '284.836', 's', 'speak-6'),
  servoClampsT: event(94.905, '94.905', 's', 'servo-clamps'),
  servoUndervoltageT: event(223.628, '223.628', 's', 'servo-undervoltage'),
  localizationDropsT: event(55.07, '55.07', 's', 'localization-drops'),
  streamBackpressureT: event(0.456, '0.456', 's', 'stream-backpressure'),
  goalT: event(278.197, '278.197', 's', 'goal-2-0'),
  readySetStartT: event(285.571, '285.571', 's', 'ready-set-blip'),
  readySetEndT: event(286.191, '286.191', 's', 'ready-set-blip.endT'),

  // Event detail values.
  fall1RecoveryRoundedS: event(6.18, '6.18', 's', 'fall-1.recoverySec rounded'),
  fall2RecoveryRoundedS: event(6.17, '6.17', 's', 'fall-2.recoverySec rounded'),
  fall3RecoveryRoundedS: event(6.18, '6.18', 's', 'fall-3.recoverySec rounded'),
  fall4RecoveryRoundedS: event(6.16, '6.16', 's', 'fall-4.recoverySec rounded'),
  fall5RecoveryRoundedS: event(6.18, '6.18', 's', 'fall-5.recoverySec rounded'),
  fall6RecoveryRoundedS: event(6.16, '6.16', 's', 'fall-6.recoverySec rounded'),
  fall1PeakAccelMps2: event(186.75, '186.75', 'm/s^2', 'fall-1.peakAccelMps2'),
  fall2PeakAccelMps2: event(222.23, '222.23', 'm/s^2', 'fall-2.peakAccelMps2'),
  fall3PeakAccelMps2: event(222.08, '222.08', 'm/s^2', 'fall-3.peakAccelMps2'),
  fall4PeakAccelMps2: event(210.21, '210.21', 'm/s^2', 'fall-4.peakAccelMps2'),
  fall5PeakAccelMps2: event(232.4, '232.40', 'm/s^2', 'fall-5.peakAccelMps2'),
  fall6PeakAccelMps2: event(217.63, '217.63', 'm/s^2', 'fall-6.peakAccelMps2'),
  localizationDropCount: event(9, '9', 'warnings', 'localization-drops'),
};

/** Exact string rendered by copy. */
export function text(name) {
  const claim = DATA_CLAIMS[name] || CITED_CONSTANTS[name];
  if (!claim) throw new Error(`donna/claims: no ledger entry named "${name}"`);
  return claim.text;
}

/** Value asserted by a claim. */
export function value(name) {
  const claim = DATA_CLAIMS[name] || CITED_CONSTANTS[name];
  if (!claim) throw new Error(`donna/claims: no ledger entry named "${name}"`);
  return claim.expected ?? claim.value;
}

/** Numeric values permitted in rendered prose. */
export function allowedNumbers() {
  const out = new Set();
  for (const claim of Object.values(DATA_CLAIMS)) {
    if (typeof claim.expected === 'number') out.add(claim.expected);
  }
  return out;
}

/** Exact numeric strings permitted in rendered prose. */
export function allowedTexts() {
  return new Set(Object.values(DATA_CLAIMS).map((claim) => claim.text));
}
