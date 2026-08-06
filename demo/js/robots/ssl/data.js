// ssl/data.js - RoboCup Small Size League match replay, 110 s window.
//
// WHAT IS REAL AND WHAT IS NOT. Read this before anything else in this directory; the long form,
// including the de-identification rules, is demo/DESIGN.md under "ssl (robot agent 5)".
//
// REAL, replayed sample for sample out of a professional SSL match log (2026 season): robot and
// ball tracks, the referee timeline, score, cards, kick attributions, the tracker's own visibility
// numbers. `/bot13/vision` and `/match` are those numbers directly. Team names, hull colours and
// the UI accent are FICTIONAL ("Polaris Robotics" yellow, "Ferrum SSL" blue); referee colours and
// robot ids are the real ones and are never altered.
//
// NOT REAL, and it cannot be: an SSL log carries vision, referee and tracker streams and nothing
// else, so no onboard packet or radio statistic has ever been in one. Every other channel is a
// SYNTHETIC COUNTERFACTUAL OVERLAY: names, units and ranges from the published TIGERs firmware
// so the shapes are right, faults invented here, unrelated to any real team's hardware. Their
// timing is anchored to real events (kicks, referee commands, ball contact) because a fault that
// ignored what the robots were doing would be useless to reason about; that is CORRELATION BY
// CONSTRUCTION, and no finding claims a synthesized fault caused anything in the real match.
//
// Cited sources for names/units/ranges (none of them is a source of DATA):
//   TIGERs firmware `src/shared/commands.h` - SystemMatchFeedback, the 29 B OTA uplink:
//     kickerLevel/kickerMax V, batteryLevel dV, batteryPercent (255 = 100 %), dribblerState,
//     flags (IR barrier, DRIB_TEMP ladder, ball state), ballPosAge ms, lastKickDuration.
//   TIGERs base station `BaseStationWifiStatsV2` - rxRssi (dBm x 0.1), rxPacketsLost, rxCrcErrors.
//   TIGERs 2024 ETDP - dribbler: BLDC, speed (1 kHz) / current (40 kHz) loops, ~25,000 rpm, 2-8 A
//     band. That current is LOOP telemetry, not an OTA field.
//   TIGERs v2020 kicker: 3600 uF at 240 V. Battery: 6S LiPo, 25.2 V full to ~19.8 V empty.
//   Sumatra `ERobotHealthState` {READY, DEGRADED, UNUSABLE} - the SHAPE the demo's own health
//     classification is modelled on. Not a wire field, and not output from anyone's software.
//
// Two fields the firmware does NOT have, named as estimates/derivations everywhere they appear:
//   dribTempEstC - no Celsius value is on the wire. This is a thermal-model ESTIMATE.
//   batteryV / batteryPercent - the wire carries deci-volts and a 0-255 byte. Both are DERIVED.
// `posDelay` is deliberately absent: it is a DOWNLINK command field (age of the last vision
// position) and not robot radio feedback, so it has no business in a radio story.
//
// SHARED NAMING. A robot key is `bot_<colourLetter><id>`: `bot_y7` is referee-yellow robot 7,
// `bot_b13` referee-blue robot 13. The letter is the REFEREE colour, never a display name.
// `finding.highlight` uses these keys, decode.js puts the same string on every decoded robot as
// `.key`, and scene.js names its robot groups with it.
//
// LOADING ORDER, the load-bearing rule. The channels below are DERIVED from the decoded match
// data, so `buildData()` cannot run until `loadSceneData()` has resolved, and it throws if you
// try. The picker and the brief never call it: they use `previewData`, a 5.9 s slice that ships
// in this module's own dependency graph.

import { mulberry32, fbm1D, clamp, smoothstep } from '../../core/prng.js';
import { decodeMatchData, sampleSeries, locate } from './decode.js';
import { livePlayIntervals, haltedIntervals, inIntervals } from './in-play.js';
import * as previewModule from './preview-data.js';

// ------------------------------------------------------------------ mission shape

/**
 * Replay length. The exported window is 109.987 s of log; the mission axis is rounded up to a
 * flat 110 s and the last 13 ms hold. Real-cadence channels (`/bot13/vision`, `/match`) end at
 * their own last native sample and are shorter than this on purpose.
 */
export const duration = 110.0;

/**
 * The dominant SYNTHESIZED telemetry cadence. This mission is genuinely mixed-rate, so a single
 * number is a summary and not a fact about every channel - `rates` below is the fact. The facts
 * builder consumes `rates`, not this.
 */
export const rate = 20;

/** Exported window length, seconds. Real data stops here; `duration` rounds up to 110. */
export const WINDOW_S = 109.9874;

/** Per-channel cadence in Hz. Two of these are the tracker's own native cadences, not a choice. */
export const rates = {
  '/bot8/kicker': 20,
  '/bot8/power': 20,
  '/bot7/radio': 10,
  '/bot3/dribbler': 20,
  '/bot13/vision': 13.3338,
  '/match': 80.0029,
};

/** Where each cadence comes from. Phase 4 turns this into per-stream facts-pack copy. */
export const rateNotes = {
  '/bot8/kicker': 'synthesized at 20 Hz',
  '/bot8/power': 'synthesized at 20 Hz',
  '/bot7/radio': 'synthesized at 10 Hz, the cadence a base station reports link statistics on',
  '/bot3/dribbler': 'synthesized at 20 Hz',
  '/bot13/vision':
    "real tracker data on its own native robot cadence, 13.334 Hz (the tracker's 80 Hz frames decimated by 6 in the export)",
  '/match': 'real tracker data on its own native ball cadence, 80.003 Hz',
};

// ------------------------------------------------------------------ provenance vocabulary

/**
 * Two-dimensional provenance on every field. `origin` says where the number came from, `transform`
 * says what was done to it. Both flow into the facts pack so the analyst can never present a
 * synthesized fault as log ground truth.
 *
 * origin:    REAL_TRACKER | REAL_GAME_CONTROLLER | REAL_VISION | SYNTHETIC
 * transform: WIRE | FIRMWARE_FLAG_DECODE | DERIVED_<X> | NONE
 */
const P = {
  /** Synthesized as if read straight off the wire field of that name. */
  synthWire: (note) => ({ origin: 'SYNTHETIC', transform: 'WIRE', note }),
  /** Synthesized, then converted out of its wire encoding. */
  synthDerived: (transform, note) => ({ origin: 'SYNTHETIC', transform, note }),
  real: (origin, transform, note) => ({ origin, transform, note }),
};

// ------------------------------------------------------------------ fault assignments
//
// Three Polaris (referee-yellow) robots carry a synthesized fault each, and one Ferrum
// (referee-blue) robot carries a REAL tracking story. Each bot was picked from the log, and the
// evidence is written out here so the choice is auditable rather than aesthetic.

/**
 * bot_y8 - kicker charge circuit.
 * Evidence: 2 of the 29 tracker kick attributions in the window belong to yellow 8 (t = 53.977 s
 * and t = 54.027 s, 2.00 -> 2.45 m/s), tying it for the most of any Polaris robot, and it is the
 * only Polaris kick inside the long 41.95-62.74 s live-play stretch. The game controller also
 * logged a real BOT_CRASH_DRAWN between yellow 8 and blue 2 at t = 53.867 s, 0.11 s before that
 * kick. Yellow 8 travels 55.6 m in the window at up to 3.46 m/s, the most dynamic Polaris field
 * robot, so its power draw is the most interesting of the fleet to put alongside a kicker.
 * Tie-break note: four Polaris robots (5, 6, 8, 10) each have exactly one attributed kick event
 * in the window, so "most kicks" alone does not decide it. Yellow 6 was rejected on purpose: it
 * is the keeper the game controller names as the kicking bot on the conceded goal, and hanging a
 * synthetic fault on that robot invites exactly the causal reading this dataset must not support.
 */
const KICKER_BOT = { key: 'bot_y8', color: 'yellow', id: 8, label: 'Polaris #8' };

/**
 * bot_y7 - radio link.
 * Evidence: yellow 7 has four separate stretches of >= 0.9 s below 0.20 m/s while the ball is
 * IN PLAY (t = 33.07+1.05, 46.43+1.35, 56.92+1.28, 58.95+0.90 s) - more than any other Polaris
 * FIELD robot. The keeper, yellow 6, has five, and is excluded for the obvious reason: standing
 * still on the goal line is its job, so a keeper's stationary stretches carry no information about
 * a link. They are not referee stoppages: at t = 58.95 s every other Polaris field robot
 * is moving (yellow 3 at 1.25, yellow 4 at 1.69, yellow 5 at 0.88, yellow 8 at 2.77, yellow 10
 * at 1.50 m/s) while yellow 7 sits at 0.09 m/s. Yellow 7 is also the most active robot on the
 * team overall (57.6 m, live-play mean 1.03 m/s, peak 3.37 m/s), so the stalls stand out against
 * its own baseline rather than against the fleet's.
 * The tracker records that a robot stopped. It cannot record WHY, and this overlay does not claim
 * to know either - it places synthesized link degradation on stretches where the robot is
 * already stationary in the real data.
 */
const RADIO_BOT = { key: 'bot_y7', color: 'yellow', id: 7, label: 'Polaris #7' };

/**
 * bot_y3 - dribbler.
 * Evidence: yellow 3 has the most ball contact of any Polaris robot in the window - 2.55 s within
 * 0.20 m of the ball centre and three contact runs under 0.16 m (t = 26.47+0.38, 32.32+1.73 and
 * 48.75 s), including the single longest sustained contact by anyone on the team, closing to
 * 0.0885 m at t = 33.45 s. That contact ends in a real game-controller foul: ATTACKER_DOUBLE_
 * TOUCHED_BALL by yellow bot 3 at t = 34.122 s. Yellow 3 also owns the hardest Polaris kick in
 * the window (t = 48.852 s, 5.19 m/s). A dribbler story needs a robot that actually holds the
 * ball, and in this window that is yellow 3.
 */
const DRIBBLER_BOT = { key: 'bot_y3', color: 'yellow', id: 3, label: 'Polaris #3' };

/**
 * bot_b13 - REAL tracking data, no synthesis at all.
 * Ferrum #13's tracker confidence collapses twice (t = 23.740-24.227 s, min 0.407; t = 25.077-
 * 29.752 s, min 3/255) and the robot is then absent from every tracked frame to the end of the
 * window. The exporter classifies that absence as `unknown`, NOT a substitution: the only
 * BOT_SUBSTITUTION game event in the window is yellow's, at t = 7.886 s, and it belongs to
 * yellow 2. The independent VISION_2014 cross-check, published across #13's WHOLE tracked life,
 * shows a coverage HANDOFF and then a decay: camera 0 alone for 76 bins of 0.25 s (to 19.00 s,
 * 1392 detections), both cameras for 7 (to 20.75 s, 245), then camera 1 alone for 28 (250) falling
 * from 18-19 per bin to single readings before the bins stop. 1887 detections across 111 covered
 * bins.
 * Copy rule: a coverage handoff and a detection decay, beside a tracker confidence collapse. Never
 * "occlusion" - raw detection packets carry no cause field - and never "left the field", and never
 * "both cameras stay up throughout": the frame totals below are window aggregates, not per-bin
 * uptime. And NEVER "to zero" or "to nothing": nothing here MEASURED a zero. The covered bins end
 * at ones and twos and what follows is not a smaller count but a GAP, so the end of this series is
 * unknown. B13_TAIL_BINS below carries the chronology and ssl-data.test.mjs pins it. The
 * cross-check used to ship cropped to the dip, which begins after the first two stretches, and this
 * comment read "ONE camera only" off that crop - see DESIGN.md.
 */
const VISION_BOT = { key: 'bot_b13', color: 'blue', id: 13, label: 'Ferrum #13' };

// ------------------------------------------------------------------ channels

export const channels = [
  {
    path: '/bot8/kicker',
    label: 'Polaris #8 kicker',
    bot: KICKER_BOT.key,
    team: 'yellow',
    note: 'Synthetic counterfactual overlay. TIGERs v2020 kicker geometry: 3600 uF at 240 V.',
    fields: [
      {
        key: 'kickerLevel',
        label: 'kickerLevel',
        unit: 'V',
        provenance: P.synthWire('SystemMatchFeedback.kickerLevel, 1 V packet resolution'),
      },
      {
        key: 'kickerMax',
        label: 'kickerMax',
        unit: 'V',
        provenance: P.synthWire('SystemMatchFeedback.kickerMax, the configured charge set point'),
      },
    ],
  },
  {
    path: '/bot8/power',
    label: 'Polaris #8 power',
    bot: KICKER_BOT.key,
    team: 'yellow',
    note:
      'Synthetic counterfactual overlay. Two unit groups only: the wire encodings (deci-volts, ' +
      '0-255) are documented here rather than charted as extra axes.',
    fields: [
      {
        key: 'batteryV',
        label: 'batteryV',
        unit: 'V',
        provenance: P.synthDerived(
          'DERIVED_DECIVOLT',
          'SystemMatchFeedback.batteryLevel is deci-volts; this is that byte over 10. 6S LiPo, 25.2 V full to 19.8 V empty',
        ),
      },
      {
        key: 'batteryPercent',
        label: 'batteryPercent',
        unit: '%',
        provenance: P.synthDerived(
          'DERIVED_BYTE_SCALE',
          'SystemMatchFeedback.batteryPercent is a 0-255 byte where 255 = 100 %; this is that byte over 2.55, so it moves in 0.392 % steps',
        ),
      },
    ],
  },
  {
    path: '/bot7/radio',
    label: 'Polaris #7 radio link',
    bot: RADIO_BOT.key,
    team: 'yellow',
    note:
      'Synthetic counterfactual overlay of BASE-STATION link statistics, time-aligned to the ' +
      'onboard stream. Both sides of that merge are synthesized.',
    fields: [
      {
        key: 'rxRssi',
        label: 'rxRssi',
        unit: 'dBm',
        provenance: P.synthDerived(
          'DERIVED_DECIBEL_SCALE',
          'BaseStationWifiStatsV2.rxRssi is dBm x 0.1; this is that value over 10',
        ),
      },
      {
        key: 'rxPacketsLost',
        label: 'rxPacketsLost',
        unit: 'pkt/s',
        provenance: P.synthDerived(
          'DERIVED_COUNTER_DELTA',
          'BaseStationWifiStatsV2.rxPacketsLost is a monotone counter; this is its per-second increment, which is what you can actually plot',
        ),
      },
      {
        key: 'rxCrcErrors',
        label: 'rxCrcErrors',
        unit: 'pkt/s',
        provenance: P.synthDerived(
          'DERIVED_COUNTER_DELTA',
          'BaseStationWifiStatsV2.rxCrcErrors, per-second increment',
        ),
      },
    ],
  },
  {
    path: '/bot3/dribbler',
    label: 'Polaris #3 dribbler',
    bot: DRIBBLER_BOT.key,
    team: 'yellow',
    note:
      'Synthetic counterfactual overlay. Dribbler current is control-loop telemetry, not an OTA ' +
      'packet field; the temperature is a model estimate and no Celsius field exists on the wire.',
    fields: [
      {
        key: 'dribCurrent',
        label: 'dribCurrent',
        unit: 'A',
        provenance: P.synthDerived(
          'DERIVED_LOOP_TELEMETRY',
          'BLDC current loop at 40 kHz, decimated. Published working band is 2-8 A at ~25,000 rpm',
        ),
      },
      {
        key: 'dribTempEstC',
        label: 'dribTempEstC',
        unit: 'degC',
        provenance: P.synthDerived(
          'DERIVED_THERMAL_MODEL',
          'ESTIMATE. First-order winding model driven by the synthesized current. The firmware only exposes a 2-bit DRIB_TEMP ladder, never a temperature',
        ),
      },
    ],
  },
  {
    path: '/bot13/vision',
    label: 'Ferrum #13 tracking (opponent robot)',
    bot: VISION_BOT.key,
    team: 'blue',
    note:
      'REAL DATA, and the only channel here about a robot Polaris does not own. It comes from the ' +
      'shared league vision and tracker feeds, which see every robot on the field. BOTH fields ' +
      'here are masked, for the same reason and by two different masks. Where the robot is in no ' +
      'tracked frame at all `visibility` has NO READING, and where the cross-check holds no ' +
      'detection count for a bin `detections` has none either: the arrays carry a zero, but that ' +
      'zero is an absence marker (hence DERIVED_ABSENCE_ZERO_FILL, not a raw wire value), and it ' +
      'is masked everywhere it is read - the plot breaks, the crosshair says "absent", and the ' +
      'analyst\'s tables write absent rather than a number.',
    fields: [
      {
        key: 'visibility',
        label: 'visibility',
        unit: '',
        // The presence mask this field is read against. `present[i]` is 1 where the tracker had
        // #13 in a frame; where it is 0 the stored 0.0 is the export's absence marker and not a
        // confidence of zero. chart.js breaks the trace and reads out "absent" over those samples,
        // and build-facts.mjs serialises them as `absent` rather than as a number. `detections`
        // carries its own, different mask - see below.
        mask: 'present',
        maskNote: 'the robot is in no tracked frame there',
        provenance: P.real(
          'REAL_TRACKER',
          'DERIVED_ABSENCE_ZERO_FILL',
          'TrackedRobot.visibility, a FUSED-TRACKER CONFIDENCE value and not proof of camera occlusion. Transported as a byte, so it moves in 1/255 steps. WHERE THE ROBOT IS IN NO TRACKED FRAME THERE IS NO READING AND THIS CHANNEL CARRIES A ZERO: that zero is an absence marker written by the export, not a measured confidence. Statistics over this field are computed on the PRESENT samples only and the absent fraction is stated alongside them',
        ),
      },
      {
        key: 'detections',
        label: 'detections',
        unit: 'det/0.25s',
        // The cross-check's own COVERAGE mask, published per bin beside the counts:
        // `detectionsPresent[i]` is 1 where the export holds a count for that sample's 0.25 s bin.
        // Where it is 0 there is NO count, which is not a count of zero, and the stored 0 is an
        // absence marker exactly as on `visibility`.
        mask: 'detectionsPresent',
        maskNote: 'the cross-check holds no detection count for that bin',
        provenance: P.real(
          'REAL_VISION',
          'DERIVED_ABSENCE_ZERO_FILL',
          'VISION_2014 per-camera detection counts on the export\'s 0.25 s bins, step-held onto the tracker cadence, published across the robot\'s WHOLE tracked lifetime with a per-bin coverage mask. OUTSIDE THAT COVERAGE THERE IS NO COUNT AND THIS CHANNEL CARRIES A ZERO: an absence marker, not a measured zero. Statistics are computed on the covered samples only',
        ),
      },
    ],
  },
  {
    path: '/match',
    label: 'Match',
    team: null,
    note: 'REAL DATA. Ball state from the tracker, on the tracker\'s own cadence.',
    fields: [
      {
        key: 'ballSpeed',
        label: 'ballSpeed',
        unit: 'm/s',
        provenance: P.real(
          'REAL_TRACKER',
          'DERIVED_SPEED_MAGNITUDE',
          'magnitude of TrackedBall.vel. The 6.5 m/s rules cap applies to this quantity',
        ),
      },
      {
        key: 'ballHeight',
        label: 'ballHeight',
        unit: 'm',
        provenance: P.real('REAL_TRACKER', 'NONE', 'TrackedBall.pos.z; non-zero means a chip kick'),
      },
    ],
  },
];

// ------------------------------------------------------------------ real anchors, from the log
// Every timestamp below is read out of the decoded match data at build time (see `anchorsFrom`).
// They are repeated here as named constants only so the findings can quote them without having
// run buildData first; `ssl-data.test.mjs` asserts each one against the decoded data.

/** yellow 8's attributed kick, `TrackedFrame.kicked_ball` (2 reports, 53.977 and 54.027 s). */
const T_KICK_Y8 = 53.977;
/** BOT_CRASH_DRAWN, yellow 8 vs blue 2. Real game-controller event. */
const T_CRASH_Y8 = 53.8672;
/** ATTACKER_DOUBLE_TOUCHED_BALL by yellow bot 3. Real game-controller event. */
const T_DOUBLE_TOUCH_Y3 = 34.1216;
/** yellow 3's longest ball contact: closest approach 0.0885 m. */
const T_Y3_CONTACT_IN = 32.3249;
const T_Y3_CONTACT_OUT = 33.975;
const T_Y3_CLOSEST = 33.4498;
/** Where the synthesized dribbler current peaks, inside that contact. */
const T_DRIB_PEAK_A = 32.9;
/** Where the modelled winding estimate trips DRIB_TEMP=OVERHEATED and the motor is cut. */
const T_DRIB_TRIP = 33.7;
/**
 * yellow 7's first stall with the ball IN PLAY: #7 was already stationary before the free kick
 * awarded at 28.551 s came into play, and the search only counts in-play stretches.
 */
const T_Y7_STALL_1 = 33.07495;
/** the sustained absence of Ferrum #13 begins after this, its last tracked sample. */
const T_B13_LAST_SEEN = 29.6999;
const T_B13_DIP2_START = 25.0769;
/** lowest tracker visibility sample on Ferrum #13: 3/255. */
const T_B13_VIS_MIN = 28.8;
const B13_VIS_MIN = 3 / 255;
/**
 * The VISION_2014 cross-check on Ferrum #13, over its WHOLE tracked life: camera 0 alone, a short
 * two-camera overlap, then camera 1 alone while the rate decays. Pinned here and re-derived from
 * the exported bins - and from the exporter's own pre-publication extract - in ssl-data.test.mjs,
 * so the prose cannot quote a number the payload has stopped holding.
 */
const B13_CAM0 = { bins: 76, detections: 1392, tEnd: 19.0 };
const B13_BOTH = { bins: 7, detections: 245 };
const B13_CAM1 = { bins: 28, detections: 250, tStart: 20.75 };
const B13_DET_TOTAL = 1887;
const B13_BINS_COVERED = 111;
/**
 * How the covered bins actually END, `[binIndex, detections]`, and the uncovered ones between them.
 * The difference between "the rate decays" and "the rate decayed to zero": ones and twos, then two
 * isolated readings with gaps either side, and the series stops. No zero in it. ssl-data.test.mjs
 * re-derives every pair from the payload.
 */
const B13_TAIL_BINS = [[105, 1], [106, 2], [107, 1], [108, 2], [110, 1], [127, 1]];
const B13_TAIL_GAPS = [109, [111, 126]];
/** Per-camera detection FRAMES over the whole window. An aggregate; never per-bin uptime. */
const B13_CAMERA_FRAMES = [8058, 8052];

/** The kickoff NORMAL_START. The COMMAND, not the moment the ball is in play - see below. */
const T_KICKOFF_START = 103.9964;
/** The kickoff's ball in play, 3.84 s after the command. This is where the charger re-arms. */
const T_KICKOFF_IN_PLAY = 107.83735;
/** The referee stops play here; it is the end of the long live stretch. */
const T_LIVE_END_3 = 62.74;
/**
 * The ball in play 4.39 s after the DIRECT_FREE_BLUE at 41.95 s. The kicker re-arms at THIS
 * moment and not at the command, which is the whole point of in-play.js.
 */
const T_LIVE_START_3 = 46.3376;

// ------------------------------------------------------------------ quoted values
// The sbr discipline: every number a finding, a script answer or the analyst quotes is a named
// constant here AND is pinned into the array at exactly that sample, so prose and plot agree
// byte for byte. The self-test asserts array[indexAt(t)] === constant for all of them.

/** kickerLevel at the top of the window, before the fault has developed far. */
const Q_KICKER_EARLY_V = 236;
/** kickerLevel immediately before yellow 8's real kick: the ceiling it managed in 7.6 s of charge. */
const Q_KICKER_PRE_KICK_V = 179;
/** kickerLevel immediately after that kick: the capacitor is dumped. */
const Q_KICKER_POST_KICK_V = 21;
/**
 * kickerLevel at the end of the window. The charger only re-arms when the kickoff comes into play
 * at 107.84 s, so this is 1.1 s of charging and not the 4.9 s the command time suggested.
 */
const Q_KICKER_LATE_V = 41;
/** kickerMax, constant all window. Nothing ever gets near it after ~35 s. */
const KICKER_MAX_V = 240;

/** rxRssi floor in the first burst, and the sample it sits on. */
const Q_RSSI_FLOOR_DBM = -88.1;
const T_RSSI_FLOOR = 33.4;
/** rxPacketsLost peak in the first burst. Pinned on the sample that already carries it. */
const Q_RX_LOST_PEAK = 164;
/** rxCrcErrors peak in the first burst. Pinned on the sample that already carries it. */
const Q_CRC_PEAK = 46;
/** rxRssi baseline immediately before the first burst, and the sample it sits on. */
const Q_RSSI_BASE_DBM = -59.4;
const T_RSSI_BASE = 32.5;

/** dribCurrent peak, at yellow 3's closest approach to the ball. Published band is 2-8 A. */
const Q_DRIB_PEAK_A = 11.5;
/** dribCurrent with the dribbler spinning and no ball on it: healthy, inside the 2-8 A band. */
const Q_DRIB_FREESPIN_A = 3.2;
const T_DRIB_FREESPIN_QUOTE = 30.0;
/** dribTempEstC peak. */
const Q_DRIB_PEAK_C = 92.4;
/** dribTempEstC at the start of the window - a model carry-in, not a measurement. See below. */
const DRIB_TEMP_START_C = 79.5;

/**
 * The DRIB_TEMP flag ladder as it actually plays out, transition by transition. Written here so
 * the finding can carry it without having run `buildData`, and asserted against the built array
 * by `ssl-data.test.mjs`.
 */
const DRIB_LADDER_EVENTS = [
  { t: 32.8, flag: 'high', from: 'med', tempEstC: 82.5 },
  { t: 33.7, flag: 'OVERHEATED', from: 'high', tempEstC: 92.4 },
  { t: 33.85, flag: 'high', from: 'OVERHEATED', tempEstC: 91.9 },
  { t: 38.5, flag: 'med', from: 'high', tempEstC: 81.9 },
];

// ------------------------------------------------------------------ findings

/**
 * `healthState` is a DEMO-GENERATED application-layer classification over the synthesized
 * telemetry, modelled on how SSL teams classify robot health (Sumatra's ERobotHealthState
 * {READY, DEGRADED, UNUSABLE} is the shape it is modelled on). It is not a wire field and it is
 * not output from any real team's software: every value below was written here, alongside the
 * telemetry it grades. The opponent robot has none, because a team classifies its OWN robots.
 */
export const findings = [
  {
    id: 'kicker-charge',
    title: 'Kicker on #8 never reaches its 240 V set point',
    window: [T_LIVE_START_3, T_LIVE_END_3],
    // Tight 3D replay loop on the kick; `window` stays the CHART's. Rationale in experience.js.
    loop: [T_KICK_Y8 - 0.5, T_KICK_Y8 + 0.65],
    t: T_KICK_Y8,
    severity: 'alert',
    focus: { channel: '/bot8/kicker', fields: ['kickerLevel', 'kickerMax'] },
    highlight: KICKER_BOT.key,
    slowmo: true,
    healthState: 'DEGRADED',
    note:
      `Synthesized. The charger is modelled as armed while the ball is IN PLAY and bleeding while ` +
      `it is not, so every tooth in the sawtooth sits on a real referee command and the real ball ` +
      `movement that put its restart into play. Early in the window the capacitor holds ` +
      `${Q_KICKER_EARLY_V} V. Given ${(T_KICK_Y8 - T_LIVE_START_3).toFixed(1)} s of charging from ` +
      `the moment the 41.95 s free kick came into play at ${T_LIVE_START_3.toFixed(2)} s it has ` +
      `reached only ${Q_KICKER_PRE_KICK_V} V against a kickerMax of ${KICKER_MAX_V} V, drops to ` +
      `${Q_KICKER_POST_KICK_V} V on the robot's real attributed kick at ${T_KICK_Y8.toFixed(3)} s, ` +
      `and manages only ${Q_KICKER_LATE_V} V in the 1.1 s after the ` +
      `${T_KICKOFF_START.toFixed(2)} s kickoff command finally put the ball in play at ` +
      `${T_KICKOFF_IN_PLAY.toFixed(2)} s. The recharge time constant lengthens all window; the level ` +
      `it settles toward droops with it.`,
    honesty:
      `The kick at ${T_KICK_Y8.toFixed(3)} s is real tracker data, as is the BOT_CRASH_DRAWN the ` +
      `game controller logged 0.11 s earlier at ${T_CRASH_Y8.toFixed(3)} s. The capacitor ` +
      `behaviour around them is not, and neither real event tells you anything about a real ` +
      `charge circuit.`,
  },
  {
    id: 'radio-degraded',
    title: 'Radio link to #7 drops out four times',
    window: [30.0, 35.2],
    t: T_Y7_STALL_1,
    severity: 'warn',
    focus: { channel: '/bot7/radio', fields: ['rxRssi', 'rxPacketsLost', 'rxCrcErrors'] },
    highlight: RADIO_BOT.key,
    slowmo: false,
    healthState: 'DEGRADED',
    note:
      `Synthesized. Four bursts across the window, placed on the four stretches where the tracker ` +
      `shows Polaris #7 stationary while the ball is IN PLAY (${T_Y7_STALL_1.toFixed(2)}, 46.43, ` +
      `56.92 and 58.95 s). In the first, rxRssi sags from ${Q_RSSI_BASE_DBM} dBm at ` +
      `${T_RSSI_BASE.toFixed(1)} s to ${Q_RSSI_FLOOR_DBM} dBm at ${T_RSSI_FLOOR.toFixed(1)} s ` +
      `while rxPacketsLost peaks at ${Q_RX_LOST_PEAK} pkt/s and rxCrcErrors at ${Q_CRC_PEAK} ` +
      `pkt/s. No posDelay channel: that field is a downlink command field, not radio feedback.`,
    honesty:
      'The stalls are real - the tracker really does show #7 stationary while its team-mates ' +
      'move. Why it stopped is not in any log, and this overlay does not claim the link caused it.',
  },
  {
    id: 'dribbler-overheat',
    title: 'Dribbler on #3 goes over its band holding the ball',
    window: [26.0, 40.0],
    t: T_DRIB_TRIP,
    severity: 'warn',
    focus: { channel: '/bot3/dribbler', fields: ['dribCurrent', 'dribTempEstC'] },
    highlight: DRIBBLER_BOT.key,
    slowmo: false,
    healthState: 'UNUSABLE',
    note:
      `Synthesized. Polaris #3 holds the ball from ${T_Y3_CONTACT_IN.toFixed(2)} s to ` +
      `${T_Y3_CONTACT_OUT.toFixed(2)} s, its longest contact of the window, closing to 0.0885 m ` +
      `at ${T_Y3_CLOSEST.toFixed(2)} s, and the game controller then books it for ` +
      `ATTACKER_DOUBLE_TOUCHED_BALL at ${T_DOUBLE_TOUCH_Y3.toFixed(3)} s. Free-spinning the same ` +
      `motor is fine - ${Q_DRIB_FREESPIN_A} A, comfortably inside the published 2-8 A band. Put ` +
      `the ball on the roller and dribCurrent peaks at ${Q_DRIB_PEAK_A} A at ` +
      `${T_DRIB_PEAK_A.toFixed(2)} s, the winding estimate reaches ${Q_DRIB_PEAK_C} degC at ` +
      `${T_DRIB_TRIP.toFixed(2)} s, and that is the modelled DRIB_TEMP=OVERHEATED trip: the ` +
      `motor is cut and the current goes to zero mid-contact. The fault is the LOADED draw, not ` +
      `the spinning one.`,
    honesty:
      `The thermal estimate is seeded at ${DRIB_TEMP_START_C} degC at t = 0. The exported window ` +
      `sits deep in the second half and the model carries in the heat from everything before it. ` +
      `That seed is an assumption of the overlay, not a measurement, and no Celsius value has ` +
      `ever been on an SSL robot's wire.`,
    /**
     * DRIB_TEMP flag ladder transitions. Deliberately NOT a charted series: a 0-3 enum plots as
     * meaningless numbers and its mean is nonsense, so it lives here as an event table and in the
     * facts pack as prose. `buildData` recomputes exactly this list from the built array and the
     * self-test asserts the two agree, so the table cannot drift away from the plot.
     * The flag itself is a real firmware concept (two bits, low/med/high/OVERHEATED); the degC
     * thresholds behind these transitions are the thermal model's, not the firmware's.
     */
    events: DRIB_LADDER_EVENTS,
  },
  {
    id: 'vision-confidence',
    title: 'Tracker loses Ferrum #13 and never regains it',
    window: [22.5, 32.0],
    t: T_B13_DIP2_START,
    severity: 'info',
    focus: { channel: '/bot13/vision', fields: ['visibility', 'detections'] },
    highlight: VISION_BOT.key,
    slowmo: false,
    healthState: null,
    healthStateNote:
      'No health state. ERobotHealthState is a classification a team computes for ITS OWN robots ' +
      'from onboard telemetry, and #13 belongs to the other team.',
    note:
      `REAL DATA, no synthesis. Tracker confidence on Ferrum #13 dips to 0.407 at 23.74-24.23 s, ` +
      `collapses from ${T_B13_DIP2_START.toFixed(2)} s to a low of ${(B13_VIS_MIN).toFixed(3)} ` +
      `(3/255) at ${T_B13_VIS_MIN.toFixed(2)} s, and after its last tracked sample at ` +
      `${T_B13_LAST_SEEN.toFixed(2)} s the robot is in no tracked frame for the remaining 80.2 s. ` +
      `The independent per-camera evidence spans its whole tracked life and shows a HANDOFF, not ` +
      `a single camera: camera 0 alone for ${B13_CAM0.bins} bins of 0.25 s to ` +
      `${B13_CAM0.tEnd.toFixed(2)} s (${B13_CAM0.detections} detections), both cameras for ` +
      `${B13_BOTH.bins} (${B13_BOTH.detections}), then camera 1 alone from ` +
      `${B13_CAM1.tStart.toFixed(2)} s for ${B13_CAM1.bins} bins (${B13_CAM1.detections}) ` +
      `falling from 18 to 19 per bin to single readings before the bins stop. ${B13_DET_TOTAL} ` +
      `detections across ${B13_BINS_COVERED} covered bins.`,
    honesty:
      'A coverage handoff and a detection decay, beside a tracker confidence collapse. Raw ' +
      'detection packets carry no cause field, so occlusion is consistent with this and is not ' +
      `proven by it. The rate never reaches zero and nothing here measured one: the last covered ` +
      `bins read ${B13_TAIL_BINS.map(([, n]) => n).join(', ')} detections and the bins between ` +
      `them (${B13_TAIL_GAPS[0]}, ${B13_TAIL_GAPS[1][0]} to ${B13_TAIL_GAPS[1][1]}) carry none ` +
      `at all, which is unknown and never zero. The per-camera frame counts (${B13_CAMERA_FRAMES.join(' and ')}) are ` +
      'aggregates over the whole window, not a per-bin heartbeat, so they cannot say whether ' +
      'either camera was up at any particular instant. This is not a substitution either: the ' +
      'only BOT_SUBSTITUTION in the window is yellow 2\'s at 7.886 s, and the exporter classifies ' +
      '#13\'s absence as `unknown` for exactly that reason.',
  },
];

// ------------------------------------------------------------------ synthesis constants

// -- kicker (bot_y8) ------------------------------------------------
/** Charge time constant at t = 0, seconds. TIGERs v2020 kicker: 3600 uF at 240 V. */
const KICKER_TAU0_S = 1.55;
/** Fractional lengthening of that time constant per second of window. */
const KICKER_TAU_GROWTH = 0.0321;
/** The set point the capacitor can actually hold, drooping as the fault develops, V/s. */
const KICKER_DROOP_V_PER_S = 0.808;
/** Floor on that drooping set point, V. */
const KICKER_PLATEAU_FLOOR_V = 140;
/** Bleed time constant while the charger is disarmed, seconds. */
const KICKER_BLEED_TAU_S = 22.0;
/** Level at t = 0. The window opens mid-play with the charger armed. */
const KICKER_V0 = 228;
/** Fraction of stored charge left after a kick. */
const KICKER_DUMP_FRACTION = 0.082;

// -- power (bot_y8) -------------------------------------------------
/** 6S LiPo open-circuit curve, volts, at 0 % and 100 % state of charge. */
const BATT_V_EMPTY = 19.8;
const BATT_V_FULL = 25.2;
/** State of charge at the start of the window. The window is deep in the second half. */
const BATT_SOC0 = 0.684;
/** Pack capacity in ampere-seconds (2.6 Ah). */
const BATT_CAPACITY_AS = 9360;
/** Internal resistance, ohms. This is what turns an acceleration into a visible sag. */
const BATT_R_INT = 0.055;
/** Housekeeping current, amps. */
const BATT_I_IDLE = 0.9;
/** Drive current per m/s and per m/s^2. */
const BATT_I_PER_MPS = 1.6;
const BATT_I_PER_MPS2 = 0.75;
/** Extra draw while the kicker charger is running, amps. */
const BATT_I_CHARGER = 3.2;

// -- radio (bot_y7) -------------------------------------------------
/** Base station position, metres, in SSL field coordinates: on the carpet behind the touch line. */
const BASE_STATION_XY = [0, -5.2];
/** Free-space reference level at 1 m, dBm. */
const RSSI_REF_1M_DBM = -46.0;
/** Plausible range for a 2.4 GHz link across a 12 x 9 m field. */
const RSSI_MIN_DBM = -90;
const RSSI_MAX_DBM = -40;
/** Level the link is dragged down to at the core of a fault burst, dBm. */
const RSSI_BURST_FLOOR_DBM = -88.0;
/** Packets lost per second at the core of a burst, and CRC errors per second. */
const RADIO_BURST_LOST = 164;
const RADIO_BURST_CRC = 47;
/** Background loss floor, packets per second. */
const RADIO_BASE_LOST = 1.4;

// -- dribbler (bot_y3) ----------------------------------------------
/** Distance from robot centre to ball centre with the ball on the dribbler, metres. */
const DRIB_CONTACT_M = 0.16;
/** The dribbler spins up when the ball is this close and the game is live, metres. */
const DRIB_SPINUP_M = 2.5;
/** Free-spinning current at t = 0 and at the end of the window, amps: healthy, inside the band. */
const DRIB_NOLOAD_A0 = 3.0;
const DRIB_NOLOAD_A1 = 3.6;
/**
 * Extra current with the ball loaded onto the roller, amps. THIS is the fault: free-spinning the
 * motor is fine, and it is the loaded draw that leaves the published 2-8 A band.
 */
const DRIB_CONTACT_GAIN_A = 8.2;
/**
 * Two-node winding/housing thermal model. One node cannot do this job: a single time constant
 * fast enough to spike on a 1.7 s ball contact also dumps all its heat across a 20 s referee
 * stoppage, and one slow enough to hold heat across the stoppage cannot spike. A motor has both -
 * a light winding that heats in seconds into a heavy housing that cools in minutes.
 *   dTw/dt = K*I^2 - (Tw - Th)/TAU_WH
 *   dTh/dt = (Tw - Th)/TAU_HW - (Th - Tamb)/TAU_HA
 */
const DRIB_K_HEAT = 0.105;
const DRIB_TAU_WH_S = 6;
const DRIB_TAU_HW_S = 55;
const DRIB_TAU_HA_S = 400;
/** Ambient, degrees C. A hall in July. */
const DRIB_T_AMBIENT_C = 31;
/** Housing temperature at t = 0. Same carry-in caveat as the winding seed. */
const DRIB_HOUSING_START_C = 74.0;
/**
 * Thermal protection. The DRIB_TEMP ladder is not decoration: OVERHEATED is what the firmware
 * raises to cut the motor. Modelling that cutout is also what keeps the temperature peak on the
 * ball contact instead of drifting to wherever the longest live stretch happens to be.
 */
const DRIB_TRIP_C = 92;
const DRIB_RESET_C = 82;
/**
 * DRIB_TEMP flag ladder thresholds, degrees C. The FLAG is a real firmware concept (two bits,
 * low/med/high/OVERHEATED); these thresholds are the THERMAL MODEL's, not the firmware's, because
 * the firmware's are not published and no temperature is on the wire to compare them to.
 */
const DRIB_LADDER = [
  ['low', 55],
  ['med', 70],
  ['high', 82],
  ['OVERHEATED', 92],
];

// ------------------------------------------------------------------ small helpers

/** Uniform grid of n = round(duration * hz) + 1 samples over [0, duration]. */
function gridFor(hz) {
  const n = Math.round(duration * hz) + 1;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / hz;
  return t;
}

/**
 * Collapse re-reports of one physical event. `TrackedFrame.kicked_ball` is deduplicated on
 * `start_timestamp`, which still leaves one shot reported over several frames.
 */
const KICK_CLUSTER_S = 0.5;
function clusterTimes(times, gap = KICK_CLUSTER_S) {
  const out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > gap) out.push(t);
  return out;
}

/** Nearest sample index in an ascending time array. Used to pin quoted values. */
function nearestIndex(times, s) {
  let lo = 0;
  let hi = times.length - 1;
  if (s <= times[0]) return 0;
  if (s >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= s) lo = mid;
    else hi = mid;
  }
  return s - times[lo] <= times[hi] - s ? lo : hi;
}

/** Smooth bump, 1 at the centre of [a, b] and 0 outside, with `edge` seconds of ramp. */
function bump(s, a, b, edge) {
  if (s <= a - edge || s >= b + edge) return 0;
  return smoothstep(clamp((s - (a - edge)) / edge, 0, 1)) * smoothstep(clamp((b + edge - s) / edge, 0, 1));
}

/** Sample a decoded robot's x/y at an arbitrary time under the interpolation contract. */
function robotXY(M, robot, s, out) {
  out[0] = sampleSeries(M.tRobot, robot.present, robot.x, robot.vx, s);
  out[1] = sampleSeries(M.tRobot, robot.present, robot.y, robot.vy, s);
  return out;
}

/** Sample the ball's x/y the same way. */
function ballXY(M, s, out) {
  out[0] = sampleSeries(M.tBall, M.ball.present, M.ball.x, M.ball.vx, s);
  out[1] = sampleSeries(M.tBall, M.ball.present, M.ball.y, M.ball.vy, s);
  return out;
}

/**
 * Linear read of a column that has no exported derivative of its own (a velocity's derivative
 * would be acceleration, which the tracker does not carry). Same never-cross-a-gap rule.
 */
function lerpSeries(times, present, values, s) {
  const { j, s: u, ok } = locate(times, present, s);
  if (!ok) return values[j];
  return values[j] + (values[j + 1] - values[j]) * u;
}

/** Speed of a decoded robot at an arbitrary time, m/s. No allocation. */
function robotSpeed(M, robot, s) {
  return Math.hypot(
    lerpSeries(M.tRobot, robot.present, robot.vx, s),
    lerpSeries(M.tRobot, robot.present, robot.vy, s),
  );
}

/** Find a decoded robot by referee colour and id. Throws rather than silently mis-plotting. */
function robotOf(M, spec) {
  const r = M.robots.find((x) => x.refereeColor === spec.color && x.id === spec.id);
  if (!r) throw new Error(`ssl/data.js: ${spec.label} (${spec.key}) is not in the decoded roster`);
  return r;
}

/**
 * Everything `buildData` needs from a decoded payload, checked ONCE at load time.
 *
 * Here and not in `buildData` because of WHERE the two run: `buildData` runs inside `route()`,
 * synchronously, after the load promise already resolved, so a throw from it was an unhandled
 * rejection and a half-built demo screen. `loadSceneData()` has a rejection path with the
 * unavailable card on it, and a payload that decodes cleanly but has no Polaris #8 to hang a
 * kicker on is exactly what that path is for.
 *
 * @param {object} M decoded MatchData
 * @throws {Error} with `retryable: true` - a re-import may produce a good payload
 */
export function validateSceneData(M) {
  const problems = [];
  if (!M || !Array.isArray(M.robots) || !M.robots.length) problems.push('no decoded robots');
  if (!M || !M.referee || !Array.isArray(M.referee.commands) || !M.referee.commands.length) {
    problems.push('no referee command track, which is what the in-play derivation runs on');
  }
  if (!M || !M.ball || !M.tBall || !M.tBall.length) problems.push('no decoded ball track');
  if (!M || !M.tRobot || !M.tRobot.length) problems.push('no decoded robot time axis');
  if (M && Array.isArray(M.robots)) {
    for (const spec of [KICKER_BOT, RADIO_BOT, DRIBBLER_BOT, VISION_BOT]) {
      const r = M.robots.find((x) => x.refereeColor === spec.color && x.id === spec.id);
      if (!r) problems.push(`${spec.label} (${spec.key}) is not in the decoded roster`);
    }
  }
  if (problems.length) {
    const e = new Error(`ssl/data.js: the decoded match payload is unusable - ${problems.join('; ')}`);
    e.retryable = true;
    throw e;
  }
  return M;
}

// ------------------------------------------------------------------ the builder

/**
 * Deterministic telemetry for the whole window.
 *
 * Pure: the only inputs are the seeded stream `prng` and the decoded match data. Math.random()
 * is never called, and two invocations with equal seeds produce byte-identical arrays.
 *
 * @param {() => number} prng seeded mulberry32 stream, supplied by app.js / build-facts
 * @returns {object} `{ "<channel path>": { t, "<field key>": Float64Array } }`
 */
export function buildData(prng) {
  const M = matchData;
  if (!M) {
    throw new Error(
      'ssl/data.js: buildData() was called before loadSceneData() resolved. The SSL channels are ' +
        'derived from the match module, which loads lazily - await def.loadSceneData() first.',
    );
  }
  const rnd = prng || mulberry32(0x55c1);

  // ONE definition of "the ball is in play", shared with scene.js and the self-tests: a restart
  // command does not arm anything, the ball moving 0.05 m from the restart point (or the restart's
  // own ceiling) does. See in-play.js.
  const live = livePlayIntervals(M.referee, M.ball, M.tBall, WINDOW_S);
  const halted = haltedIntervals(M.referee, WINDOW_S);
  const kickerBot = robotOf(M, KICKER_BOT);
  const radioBot = robotOf(M, RADIO_BOT);
  const dribBot = robotOf(M, DRIBBLER_BOT);
  const visionBot = robotOf(M, VISION_BOT);
  const pA = [0, 0];
  const pB = [0, 0];

  // -------------------------------------------------------------- /bot8/kicker + /bot8/power
  const tK = gridFor(rates['/bot8/kicker']);
  const nK = tK.length;
  const dtK = 1 / rates['/bot8/kicker'];

  const kickerLevel = new Float64Array(nK);
  const kickerMax = new Float64Array(nK);
  const batteryV = new Float64Array(nK);
  const batteryPercent = new Float64Array(nK);

  // yellow 8's own kick instants, from the real attribution table. A kick dumps the capacitor.
  // `kicked_ball` is deduplicated on start_timestamp, not on physical kick: one shot can be
  // re-reported over several frames. Cluster within KICK_CLUSTER_S so the capacitor is dumped
  // once per kick and not once per packet.
  const kickTimes = clusterTimes(
    M.kicks
      .filter((k) => k.robot.color === KICKER_BOT.color && k.robot.id === KICKER_BOT.id)
      .map((k) => k.t),
  );

  const chargeNoise = fbm1D(mulberry32(0x1a3f), 3, 0.5);
  let v = KICKER_V0;
  let soc = BATT_SOC0;
  let nextKick = 0;
  let prevSpeed = robotSpeed(M, kickerBot, 0);

  for (let i = 0; i < nK; i++) {
    const s = tK[i];
    const armed = inIntervals(live, s);

    // capacitor
    if (armed) {
      const plateau = Math.max(KICKER_PLATEAU_FLOOR_V, KICKER_MAX_V - KICKER_DROOP_V_PER_S * s);
      const tau = KICKER_TAU0_S * (1 + KICKER_TAU_GROWTH * s);
      v += ((plateau - v) / tau) * dtK;
    } else {
      v -= (v / KICKER_BLEED_TAU_S) * dtK;
    }
    while (nextKick < kickTimes.length && kickTimes[nextKick] <= s) {
      v *= KICKER_DUMP_FRACTION;
      nextKick++;
    }
    // The wire field is whole volts; the ripple is the boost converter's duty cycling.
    const ripple = armed ? (chargeNoise(s * 1.7) - 0.5) * 1.6 : 0;
    kickerLevel[i] = Math.max(0, Math.round(v + ripple));
    kickerMax[i] = KICKER_MAX_V;

    // pack. Load follows the robot's REAL motion, so every sag sits on a real acceleration.
    const speed = robotSpeed(M, kickerBot, Math.min(s, WINDOW_S));
    const accel = Math.abs(speed - prevSpeed) / dtK;
    prevSpeed = speed;
    const iDraw =
      BATT_I_IDLE +
      BATT_I_PER_MPS * speed +
      BATT_I_PER_MPS2 * Math.min(accel, 8) +
      (armed && v < KICKER_MAX_V - 1 ? BATT_I_CHARGER : 0);
    soc = Math.max(0, soc - (iDraw * dtK) / BATT_CAPACITY_AS);
    const ocv = BATT_V_EMPTY + (BATT_V_FULL - BATT_V_EMPTY) * soc;
    // deci-volt wire resolution
    batteryV[i] = Math.round((ocv - iDraw * BATT_R_INT) * 10) / 10;
    // 0-255 byte where 255 = 100 %, so 0.392 % steps
    batteryPercent[i] = Math.round((Math.round(soc * 255) / 2.55) * 1000) / 1000;
  }

  // pin the quoted kicker samples
  kickerLevel[nearestIndex(tK, 6.0)] = Q_KICKER_EARLY_V;
  kickerLevel[nearestIndex(tK, T_KICK_Y8 - 0.05)] = Q_KICKER_PRE_KICK_V;
  kickerLevel[nearestIndex(tK, T_KICK_Y8 + 0.15)] = Q_KICKER_POST_KICK_V;
  kickerLevel[nearestIndex(tK, 108.9)] = Q_KICKER_LATE_V;

  // -------------------------------------------------------------- /bot7/radio
  const tR = gridFor(rates['/bot7/radio']);
  const nR = tR.length;
  const rxRssi = new Float64Array(nR);
  const rxPacketsLost = new Float64Array(nR);
  const rxCrcErrors = new Float64Array(nR);

  // The four real live-play stalls (33.07, 46.43, 56.92 and 58.95 s). Recomputed from the decoded
  // motion so this list can never drift away from the data it claims to sit on - which is how the
  // comment came to say five while the derivation, the finding note and the pinned analyst answer
  // all said four.
  const stalls = liveStalls(M, radioBot, live);
  const rssiWander = fbm1D(mulberry32(0x77e2), 3, 0.55);
  const lossNoise = fbm1D(mulberry32(0x2f10), 2, 0.5);

  for (let i = 0; i < nR; i++) {
    const s = tR[i];
    robotXY(M, radioBot, Math.min(s, WINDOW_S), pA);
    const d = Math.max(1, Math.hypot(pA[0] - BASE_STATION_XY[0], pA[1] - BASE_STATION_XY[1]));
    const pathLoss = 20 * Math.log10(d);

    let burst = 0;
    for (const [a, b] of stalls) burst = Math.max(burst, bump(s, a + 0.15, b - 0.15, 0.45));

    const clean = RSSI_REF_1M_DBM - pathLoss + (rssiWander(s * 0.35) - 0.5) * 3.0;
    // Mix toward the fade floor rather than subtracting from the clean level, so a deep burst
    // lands on a stated floor instead of running off the bottom of the plausible range.
    const faded = RSSI_BURST_FLOOR_DBM + (rssiWander(s * 1.9) - 0.5) * 1.1;
    rxRssi[i] = clamp(
      Math.round((clean * (1 - burst) + faded * burst) * 10) / 10,
      RSSI_MIN_DBM,
      RSSI_MAX_DBM,
    );

    const jitter = 0.55 + 0.9 * lossNoise(s * 2.3);
    const shape = burst * burst;
    rxPacketsLost[i] = Math.round(RADIO_BASE_LOST * jitter * (1 - shape) + RADIO_BURST_LOST * shape);
    rxCrcErrors[i] = Math.round(
      0.4 * jitter * (1 - shape) + RADIO_BURST_CRC * shape * (0.86 + 0.14 * rnd()),
    );
  }

  // The quoted extremes of the FIRST burst, each pinned onto the sample that already carries it.
  // A fixed offset from the stall start pinned the floor onto a sample the burst had decayed off,
  // which is how a quoted "floor" ended up 23 dB below its neighbours.
  const burst0 = stalls.length ? stalls[0] : [T_Y7_STALL_1, T_Y7_STALL_1 + 1];
  let iRssiMin = -1;
  let iLostMax = -1;
  let iCrcMax = -1;
  for (let i = 0; i < nR; i++) {
    if (tR[i] < burst0[0] - 0.5 || tR[i] > burst0[1] + 0.5) continue;
    if (iRssiMin < 0 || rxRssi[i] < rxRssi[iRssiMin]) iRssiMin = i;
    if (iLostMax < 0 || rxPacketsLost[i] > rxPacketsLost[iLostMax]) iLostMax = i;
    if (iCrcMax < 0 || rxCrcErrors[i] > rxCrcErrors[iCrcMax]) iCrcMax = i;
  }
  if (iRssiMin >= 0) rxRssi[iRssiMin] = Q_RSSI_FLOOR_DBM;
  if (iLostMax >= 0) rxPacketsLost[iLostMax] = Q_RX_LOST_PEAK;
  if (iCrcMax >= 0) rxCrcErrors[iCrcMax] = Q_CRC_PEAK;
  rxRssi[nearestIndex(tR, T_RSSI_BASE)] = Q_RSSI_BASE_DBM;

  // -------------------------------------------------------------- /bot3/dribbler
  const tD = gridFor(rates['/bot3/dribbler']);
  const nD = tD.length;
  const dtD = 1 / rates['/bot3/dribbler'];
  const dribCurrent = new Float64Array(nD);
  const dribTempEstC = new Float64Array(nD);
  const dribNoise = fbm1D(mulberry32(0x51bd), 3, 0.5);

  let tw = DRIB_TEMP_START_C;
  let th = DRIB_HOUSING_START_C;
  let cutout = false;

  for (let i = 0; i < nD; i++) {
    const s = tD[i];
    const sc = Math.min(s, WINDOW_S);
    robotXY(M, dribBot, sc, pA);
    ballXY(M, sc, pB);
    const d = Math.hypot(pA[0] - pB[0], pA[1] - pB[1]);
    // Ball proximity and the robots not being halted - deliberately NOT the in-play derivation
    // the kicker and the stall search use. A dribbler runs whenever its robot is working the ball,
    // which here includes carrying it to a placement point: gating on in-play contradicted the
    // scene's own placement corridor, drawn because the placing robot dribbles the ball there.
    const spinning = !inIntervals(halted, s) && d < DRIB_SPINUP_M && !cutout;

    let amps = 0;
    if (spinning) {
      const noLoad = DRIB_NOLOAD_A0 + (DRIB_NOLOAD_A1 - DRIB_NOLOAD_A0) * (s / duration);
      const load = DRIB_CONTACT_GAIN_A * smoothstep(clamp((DRIB_CONTACT_M - d) / 0.055, 0, 1));
      amps = noLoad + load + (dribNoise(s * 3.1) - 0.5) * 0.5;
    }
    dribCurrent[i] = Math.round(Math.max(0, amps) * 100) / 100;

    const flux = (tw - th) / DRIB_TAU_WH_S;
    tw += (DRIB_K_HEAT * amps * amps - flux) * dtD;
    th += ((tw - th) / DRIB_TAU_HW_S - (th - DRIB_T_AMBIENT_C) / DRIB_TAU_HA_S) * dtD;
    dribTempEstC[i] = Math.round(tw * 10) / 10;

    if (!cutout && dribTempEstC[i] >= DRIB_TRIP_C) cutout = true;
    else if (cutout && dribTempEstC[i] <= DRIB_RESET_C) cutout = false;
  }

  // Pin the quoted extremes onto the samples that already carry them, so the prose is exact.
  let iPeakI = 0;
  for (let i = 1; i < nD; i++) if (dribCurrent[i] > dribCurrent[iPeakI]) iPeakI = i;
  dribCurrent[iPeakI] = Q_DRIB_PEAK_A;
  let iPeakT = 0;
  for (let i = 1; i < nD; i++) if (dribTempEstC[i] > dribTempEstC[iPeakT]) iPeakT = i;
  dribTempEstC[iPeakT] = Q_DRIB_PEAK_C;
  dribCurrent[nearestIndex(tD, T_DRIB_FREESPIN_QUOTE)] = Q_DRIB_FREESPIN_A;

  // The DRIB_TEMP flag ladder is NOT a series here: a 0-3 enum plots as meaningless numbers and
  // its mean is nonsense, so it lives on the finding as an event table. `ladderEventsFor` derives
  // that table from exactly this array, and the self-test asserts the two agree - which is how the
  // table stays honest without `buildData` reaching out and mutating an export.

  // -------------------------------------------------------------- /bot13/vision  (REAL)
  const tV = Float64Array.from(M.tRobot);
  const nV = tV.length;
  const visibility = new Float64Array(nV);
  const detections = new Float64Array(nV);
  // Which samples carry a real reading. The zeros `visibility` is filled with are an ABSENCE
  // MARKER, not a measured confidence, so anything computing a statistic has to tell them apart.
  // A reserved block key, never a field: chart.js and chat read `ch.fields` only.
  const present = new Uint8Array(nV);
  // The cross-check's coverage mask, on the same footing. It gets a mask of its OWN rather than
  // riding on `present`: the two disagree, and they should. #13's bins run out at 27.25 s while the
  // tracker still has it to 29.70 s, and one bin inside that stretch carries no count at all.
  const detectionsPresent = new Uint8Array(nV);
  const bins = binLookup(M, VISION_BOT);
  const binSeconds = (M.visionCrossCheck && M.visionCrossCheck.binSeconds) || 0.25;
  for (let i = 0; i < nV; i++) {
    present[i] = visionBot.present[i] ? 1 : 0;
    // 0 is not a low confidence reading: it means the robot was in no tracked frame at all.
    visibility[i] = present[i] ? visionBot.vis[i] : 0;
    const b = Math.floor(tV[i] / binSeconds);
    const n = bins.get(b);
    detectionsPresent[i] = n === undefined ? 0 : 1;
    // Same contract as `visibility`: the filler is a zero and the mask is what says so.
    detections[i] = n === undefined ? 0 : n;
  }

  // -------------------------------------------------------------- /match  (REAL)
  const tB = Float64Array.from(M.tBall);
  const nB = tB.length;
  const ballSpeed = new Float64Array(nB);
  const ballHeight = new Float64Array(nB);
  for (let i = 0; i < nB; i++) {
    ballSpeed[i] = M.ball.present[i]
      ? Math.hypot(M.ball.vx[i], M.ball.vy[i], M.ball.vz[i])
      : 0;
    ballHeight[i] = M.ball.present[i] ? M.ball.z[i] : 0;
  }

  return {
    '/bot8/kicker': { t: tK, kickerLevel, kickerMax },
    '/bot8/power': { t: tK, batteryV, batteryPercent },
    '/bot7/radio': { t: tR, rxRssi, rxPacketsLost, rxCrcErrors },
    '/bot3/dribbler': { t: tD, dribCurrent, dribTempEstC },
    '/bot13/vision': { t: tV, visibility, detections, present, detectionsPresent },
    '/match': { t: tB, ballSpeed, ballHeight },
  };
}

/** Which rung of the DRIB_TEMP ladder a temperature sits on. */
function ladderIndex(c) {
  let r = 0;
  for (let k = 0; k < DRIB_LADDER.length; k++) if (c >= DRIB_LADDER[k][1]) r = k;
  return r;
}

/**
 * DRIB_TEMP ladder transitions for a built `dribTempEstC` series. One definition, used by
 * `buildData`, by the self-test that pins DRIB_LADDER_EVENTS, and by the facts builder.
 * @param {Float64Array} times
 * @param {Float64Array} tempEstC
 */
export function ladderEventsFor(times, tempEstC) {
  const out = [];
  let rung = ladderIndex(tempEstC[0]);
  for (let i = 1; i < tempEstC.length; i++) {
    const r = ladderIndex(tempEstC[i]);
    if (r === rung) continue;
    out.push({
      t: Math.round(times[i] * 100) / 100,
      flag: DRIB_LADDER[r][0],
      from: DRIB_LADDER[rung][0],
      tempEstC: tempEstC[i],
    });
    rung = r;
  }
  return out;
}

/**
 * Stretches of >= MIN seconds where a robot is below SLOW m/s while the ball is live. Recomputed
 * from the decoded tracks every build so the synthesized bursts can never drift off the real
 * stalls they are placed on.
 */
export function liveStalls(M, robot, live, slow = 0.20, minS = 0.9) {
  const out = [];
  let start = -1;
  const n = M.tRobot.length;
  for (let i = 0; i <= n; i++) {
    const on =
      i < n &&
      robot.present[i] &&
      inIntervals(live, M.tRobot[i]) &&
      Math.hypot(robot.vx[i], robot.vy[i]) < slow;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      // Length is measured over the samples the stretch OCCUPIES, i.e. up to the first sample
      // that is no longer stalled - not to the last stalled sample, which is one interval short.
      const tEnd = M.tRobot[Math.min(i, n - 1)];
      if (tEnd - M.tRobot[start] >= minS) out.push([M.tRobot[start], tEnd]);
      start = -1;
    }
  }
  return out;
}

/**
 * `binIndex -> detection count` for one robot's VISION_2014 cross-check bins. A bin NOT in this map
 * is one the export holds no count for, so `undefined` is the whole signal and the caller tests for
 * it rather than defaulting to 0. The export ships a `coverage` mask for exactly this distinction;
 * `bins` is that mask in set form, and verify_export asserts the two agree bin for bin.
 */
function binLookup(M, spec) {
  const map = new Map();
  const vc = M.visionCrossCheck;
  const name = `${spec.color}${spec.id}`;
  const entry = vc && vc.robots && vc.robots[name];
  if (!entry) return map;
  for (const [binIndex, nDetections] of entry.bins) map.set(binIndex, nDetections);
  return map;
}

// ------------------------------------------------------------------ scene-data contract
//
// `def.data` is chart and chat telemetry and nothing else. The 3D scene needs the decoded match
// data, which is a different object with a different lifetime, so it travels through
// `getSceneData()` - the viewer, the picker and the brief all pass its result into
// `sceneApi.update(t, sceneData)`.

/** @type {Promise<object>|null} cached, idempotent. */
let matchPromise = null;
/** @type {object|null} decoded MatchData, once loaded. */
let matchData = null;

/**
 * Load and decode the full match module. Repeated calls return the SAME promise.
 *
 * Retry semantics are split because the two failures are not the same failure:
 *   - a DECODER failure clears the cache, so calling again retries;
 *   - a module IMPORT/EVALUATION failure does NOT, because the ES module map caches a failed
 *     evaluation by specifier for the life of the document. That one needs a reload, and the
 *     rejection carries `retryable: false` so the unavailable-card copy can say so.
 *
 * @returns {Promise<object>} decoded MatchData
 */
export function loadSceneData() {
  if (matchPromise) return matchPromise;
  const p = import('./match-data.js')
    .then(
      (mod) => {
        // Decode AND validate here: a payload with nothing this mission is about in it must fail
        // on THIS promise, where an unavailable card is waiting, not inside route()'s synchronous
        // buildDemo() where a throw has nowhere to go.
        matchData = validateSceneData(decodeMatchData(mod));
        return matchData;
      },
      (err) => {
        const e = new Error('The match replay module could not be loaded. Reload the page to try again.');
        e.retryable = false;
        e.cause = err;
        throw e;
      },
    )
    .catch((err) => {
      if (err && err.retryable === false) throw err;
      if (matchPromise === p) matchPromise = null;
      // Both retryable, both on the same card, but not the same sentence in the console.
      const e = new Error(
        err && /unusable/.test(err.message || '')
          ? 'The match replay decoded but is missing the robots this mission is about.'
          : 'The match replay could not be decoded.',
      );
      e.retryable = true;
      e.cause = err;
      throw e;
    });
  matchPromise = p;
  return p;
}

/** True once the full match data is decoded and `buildData` may run. */
export function isSceneDataLoaded() {
  return matchData !== null;
}

/**
 * The decoded match data if it is loaded, otherwise the preview slice. Both have the same shape,
 * so a consumer never branches on which one it got - it reads `grid`, `robots`, `ball`, `focus`
 * and the interpolation contract exactly the same way either way.
 */
export function getSceneData() {
  return matchData || previewData;
}

/**
 * A 5.9 s slice at 4 Hz robots / 8 Hz ball, positions and yaw only, ~2.9 KB of payload. It exists
 * so the picker's live preview and the brief's hero can turn without pulling the 700 KB match
 * module, and it is decoded here at module scope on purpose: it is sub-millisecond, and the
 * try/catch means a bad preview blob degrades the preview instead of killing the whole robot.
 * @type {object|null}
 */
export let previewData = null;
try {
  previewData = decodeMatchData(previewModule);
} catch (err) {
  previewData = null;
}

/** Test hook: forget the loaded match data so the tripwire can be exercised. */
export function __resetSceneDataForTests() {
  matchPromise = null;
  matchData = null;
}
