// donna/claims.mjs - claim ledger for the three-robot Donna mission.
//
// Rules or external constants belong in CITED_CONSTANTS. This mission's rendered numbers all come
// from the decoded module, so DATA_CLAIMS binds each one to a channel timestamp or an aligned event.

export const CITED_CONSTANTS = {};

const event = (expected, text, unit, eventId, field, extra = {}) => ({
  expected,
  text,
  unit,
  channel: null,
  field,
  t: null,
  eventId,
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
  // Mission shape and number-word bindings.
  durationS: sample(250, '250', 's', '/game', 'windowEnd', 250),
  heroTime: sample(187.6, '187.6', 's', '/ball', 'ballSeen timestamp', 187.6),
  oneMatchWord: event(1, 'One', 'match', 'window-open', 'eventCount'),
  threeLogsWord: event(3, 'three', 'onboard logs', 'window-open', 'recordedRobotCount'),

  // F1, separate recording and live-stream application queues.
  donnaQueueFull: event(239, '239', 'application-queue warnings', 'donna-queue-full', 'count'),
  jackQueueFull: event(229, '229', 'application-queue warnings', 'jack-queue-full', 'count'),
  roryQueueFull: event(0, '0', 'application-queue warnings', 'rory-queue-full', 'count'),

  // F2, window fall counts and Jack's final line.
  donnaFallCount: event(0, '0', 'falls', 'donna-fall-count', 'count'),
  jackFallCount: event(3, '3', 'falls', 'jack-fall-count', 'count'),
  jackFallCountWord: event(3, 'three', 'falls', 'jack-fall-count', 'count'),
  roryFallCount: event(0, '0', 'falls', 'rory-fall-count', 'count'),

  // F3, penalty traffic and honest pose availability.
  donnaPenaltyDurationS: event(
    37.071,
    '37.071',
    's',
    'donna-penalty-end',
    't minus donna-penalty-start.t',
  ),
  roryReentryT: event(28.072, '28.072', 's', 'rory-re-entry', 't'),
  roryLivePoseT: event(28.269, '28.269', 's', 'rory-re-entry', 'firstPoseT'),

  // F4, the two closing goals and added-time whistle.
  scoreAtFirstGoalOwn: event(5, '5', 'goals', 'goal-5-0', 'ownScore'),
  scoreAtSecondGoalOwn: event(6, '6', 'goals', 'goal-6-0', 'ownScore'),
  scoreRival: event(0, '0', 'goals', 'goal-6-0', 'rivalScore'),
  firstGoalClockS: event(162, '162', 's', 'goal-5-0', 'secondsRemaining'),
  secondGoalClockS: event(-31, '-31', 's', 'goal-6-0', 'secondsRemaining'),
  whistleClockS: event(-33, '-33', 's', 'finished', 'secondsRemaining'),

  // Aligned event timestamps used by findings, event tables and later script work.
  windowOpenT: event(0, '0', 's', 'window-open', 't'),
  jackFall1T: event(6.345, '6.345', 's', 'jack-fall-1', 't'),
  jackGettingUp1T: event(7.159, '7.159', 's', 'jack-fall-1', 'gettingUpT'),
  jackRecovery1T: event(10.402, '10.402', 's', 'jack-fall-1', 'recoveredT'),
  jackSpeak1T: event(8.311, '8.311', 's', 'jack-speak-1', 't'),
  goal5T: event(36.268, '36.268', 's', 'goal-5-0', 't'),
  jackFall2T: event(36.939, '36.939', 's', 'jack-fall-2', 't'),
  jackGettingUp2T: event(37.7, '37.7', 's', 'jack-fall-2', 'gettingUpT'),
  jackRecovery2T: event(42.425, '42.425', 's', 'jack-fall-2', 'recoveredT'),
  jackSpeak2T: event(38.856, '38.856', 's', 'jack-speak-2', 't'),
  donnaPenaltyStartT: event(86.852, '86.852', 's', 'donna-penalty-start', 't'),
  donnaPenaltyEndT: event(123.923, '123.923', 's', 'donna-penalty-end', 't'),
  jackFall3T: event(145.878, '145.878', 's', 'jack-fall-3', 't'),
  jackGettingUp3T: event(146.898, '146.898', 's', 'jack-fall-3', 'gettingUpT'),
  jackRecovery3T: event(150.147, '150.147', 's', 'jack-fall-3', 'recoveredT'),
  jackSpeak3T: event(148.064, '148.064', 's', 'jack-speak-3', 't'),
  goal6T: event(229.598, '229.598', 's', 'goal-6-0', 't'),
  finishedT: event(232.058, '232.058', 's', 'finished', 't'),
  donnaLowPowerCount: event(236, '236', 'diagnostic statuses', 'donna-low-power', 'count'),
};

export function text(name) {
  const claim = DATA_CLAIMS[name] || CITED_CONSTANTS[name];
  if (!claim) throw new Error(`donna/claims: no ledger entry named "${name}"`);
  return claim.text;
}

export function value(name) {
  const claim = DATA_CLAIMS[name] || CITED_CONSTANTS[name];
  if (!claim) throw new Error(`donna/claims: no ledger entry named "${name}"`);
  return claim.expected ?? claim.value;
}

export function allowedNumbers() {
  const out = new Set();
  for (const claim of Object.values(DATA_CLAIMS)) {
    if (typeof claim.expected === 'number') out.add(claim.expected);
  }
  for (const claim of Object.values(CITED_CONSTANTS)) {
    if (typeof claim.value === 'number') out.add(claim.value);
  }
  return out;
}

export function allowedTexts() {
  return new Set(
    [...Object.values(DATA_CLAIMS), ...Object.values(CITED_CONSTANTS)].map((claim) => claim.text),
  );
}

export function allowedNumberWords() {
  return new Set(
    [...Object.values(DATA_CLAIMS), ...Object.values(CITED_CONSTANTS)]
      .map((claim) => claim.text)
      .filter((text) => /^[A-Za-z]+$/.test(text)),
  );
}
