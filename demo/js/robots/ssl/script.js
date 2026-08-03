// ssl/script.js - the ssl RobotDefinition. Every number quoted below is a named constant in
// data.js that is ALSO pinned into the built array at that exact sample, or a real event read out
// of the decoded match export (the referee timeline, the kick attributions, the tracker's own
// visibility). ssl-data.test.mjs asserts both halves, so prose and plot cannot drift apart.
//
// Read data.js's header before editing any of this copy: the motion is real match data and the
// onboard telemetry is a synthetic counterfactual overlay, and every answer that leans on a
// synthesized channel says so in its own body. The analyst endpoint gets the same disclosure
// through the facts pack, and the brief screen through `context.provenance`.

import {
  channels,
  duration,
  rate,
  rates,
  rateNotes,
  buildData,
  findings,
  loadSceneData as loadMatchData,
  isSceneDataLoaded,
  getSceneData,
  previewData,
} from './data.js';
import { buildScene } from './scene.js';

/**
 * The posed moment for the picker card and the brief hero: 2.3 s before the window's one confirmed
 * goal crosses the line, both fleets converging on the ball, which is the only frame in 110 s that
 * reads as a match rather than as nineteen dots on a carpet.
 *
 * It is quoted TWICE because the two staged screens run against two different payloads with two
 * different clocks. The full match export puts that instant at 60.44 s. The preview slice is cut
 * out of the same window at 57.675 s and re-based to zero, so the same instant is 2.765 s in ITS
 * clock, and posing the preview at 60.44 s would just clamp to the end of the slice.
 */
const T_HERO_MATCH_S = 60.44;
const T_HERO_PREVIEW_S = 2.765;

/**
 * The OPENER's role registers AND the guided flow's beat copy, merged onto the def when the match
 * payload lands. Both live behind a dynamic import because only the demo screen reads either one;
 * `role-openers.js` says why, and why `answer` does not go with them. The merge itself lives over
 * there too, so this side stays one call: a module that will not load leaves `answerByRole` and
 * `choreo` unset, every role reads the engineer answer in the full layout, and the rejection must
 * not reach the loading card.
 */
let rolePromise = null;
function loadRoleOpeners() {
  if (!rolePromise) {
    rolePromise = import('./role-openers.js').then(
      (mod) => {
        if (mod && mod.applyGuided) mod.applyGuided(def);
      },
      (err) => {
        console.warn('[ssl] role openers unavailable; every role reads the engineer answer', err);
      },
    );
  }
  return rolePromise;
}

const def = {
  id: 'ssl',
  name: 'SSL soccer fleet',
  device: 'Div A match fleet · shared-vision tracker · base-station telemetry',
  tagline: 'A real match replay, three planted faults, one real tracking loss',
  context: {
    system:
      'Polaris Robotics SSL fleet: omni-drive cylinders (180 mm), 240 V kicker caps, 25k rpm dribblers, telemetry captured over the base-station link.',
    mission:
      '110 seconds of a professional Division A match: a goal conceded under pressure, three ball placements, one robot pulled from the field.',
    fault:
      'Late in the window the kicker bank stops reaching full charge and one bot drifts out of the play.',
    // The picker card's line: authored short and fault first, because the card clamps. See sbr.
    cardProblem: 'Late in the window the kicker bank stops reaching full charge.',
    // The old-way header. Not the ESP32 default: an invented USB port under a provenance line
    // about real match tracking would claim a capture path. See core/oldway.js portLine().
    port: 'base-station telemetry link · 20 Hz',
    faultT: 53.977,
    label: 'kicker bank sag',
    provenance:
      "Match motion and referee timeline come from real SSL tracking data (a professional match, 2026 season, teams renamed). Three onboard faults are synthesized training overlays, not claims about any real team's hardware; the bot 13 tracking loss is the log's own data.",
    // Mission VOLUME, authored because this def's channels come from a lazily loaded payload and
    // the brief can reach a visitor with nothing built. 37,043 is the row-times-field total over
    // the six channels, read out of buildData() under node (/bot8/kicker 2201 x 2, /bot8/power
    // 2201 x 2, /bot7/radio 1101 x 3, /bot3/dribbler 2201 x 2, /bot13/vision 1467 x 2, /match
    // 8800 x 2), and seed-independent: row counts come from the export's timestamps, not the PRNG.
    datapoints: 37043,
    channels: 6,
    // THE OLD WAY, on this mission's own data: 40 consecutive lines of the six channels as text,
    // time-ordered across channels the way a tail interleaves them. Every value was read out of
    // buildData() under node at that timestamp and printed, not written by hand. Contiguous,
    // 53.863 to 54.100 s, which is 0.237 s of a 110 s mission, and it contains the fault the brief
    // is about: /bot8/kicker reads 179.0 at 53.950 and 15.00 at 54.000. That is the argument for
    // the screen this feeds. `null` is an ABSENT reading, not a zero: /bot13/vision is masked
    // absent from 29.70 s and the lines say so instead of filling in a number nobody measured.
    oldwaySample: [
      '53.863 /match ballSpeed=0.809 ballHeight=0.000',
      '53.875 /match ballSpeed=0.805 ballHeight=0.000',
      '53.887 /match ballSpeed=0.796 ballHeight=0.000',
      '53.900 /match ballSpeed=0.796 ballHeight=0.000',
      '53.900 /bot8/kicker kickerLevel=179.0 kickerMax=240.0',
      '53.900 /bot8/power batteryV=23.10 batteryPercent=66.28',
      '53.900 /bot7/radio rxRssi=-63.90 rxPacketsLost=1.00 rxCrcErrors=0.000',
      '53.900 /bot3/dribbler dribCurrent=3.30 dribTempEstC=80.50',
      '53.913 /match ballSpeed=0.785 ballHeight=0.000',
      '53.925 /bot13/vision visibility=null detections=null',
      '53.925 /match ballSpeed=0.780 ballHeight=0.000',
      '53.938 /match ballSpeed=0.770 ballHeight=0.000',
      '53.950 /match ballSpeed=0.770 ballHeight=0.000',
      '53.950 /bot8/kicker kickerLevel=179.0 kickerMax=240.0',
      '53.950 /bot8/power batteryV=23.10 batteryPercent=66.28',
      '53.950 /bot3/dribbler dribCurrent=3.29 dribTempEstC=80.50',
      '53.963 /match ballSpeed=0.742 ballHeight=0.000',
      '53.975 /match ballSpeed=1.92 ballHeight=0.000',
      '53.988 /match ballSpeed=2.17 ballHeight=0.000',
      '54.000 /bot13/vision visibility=null detections=null',
      '54.000 /match ballSpeed=2.19 ballHeight=0.000',
      '54.000 /bot8/kicker kickerLevel=15.00 kickerMax=240.0',
      '54.000 /bot8/power batteryV=23.00 batteryPercent=66.28',
      '54.000 /bot7/radio rxRssi=-63.90 rxPacketsLost=1.00 rxCrcErrors=0.000',
      '54.000 /bot3/dribbler dribCurrent=3.29 dribTempEstC=80.50',
      '54.013 /match ballSpeed=2.20 ballHeight=0.000',
      '54.025 /match ballSpeed=2.22 ballHeight=0.000',
      '54.038 /match ballSpeed=2.21 ballHeight=0.000',
      '54.050 /match ballSpeed=2.21 ballHeight=0.000',
      '54.050 /bot8/kicker kickerLevel=17.00 kickerMax=240.0',
      '54.050 /bot8/power batteryV=23.10 batteryPercent=66.28',
      '54.050 /bot3/dribbler dribCurrent=3.29 dribTempEstC=80.50',
      '54.063 /match ballSpeed=2.18 ballHeight=0.000',
      '54.075 /bot13/vision visibility=null detections=null',
      '54.075 /match ballSpeed=2.40 ballHeight=0.051',
      '54.088 /match ballSpeed=2.41 ballHeight=0.079',
      '54.100 /match ballSpeed=2.42 ballHeight=0.071',
      '54.100 /bot8/kicker kickerLevel=19.00 kickerMax=240.0',
      '54.100 /bot8/power batteryV=23.00 batteryPercent=66.28',
      '54.100 /bot7/radio rxRssi=-63.80 rxPacketsLost=1.00 rxCrcErrors=0.000',
    ],
  },
  accent: '#35c46a',
  duration,
  rate,
  // This mission is genuinely mixed-rate: `rate` is a summary, `rates` + `rateNotes` are the fact,
  // and the facts builder emits a cadence line per channel from them rather than one global Hz.
  rates,
  rateNotes,
  channels,
  buildData,
  findings,
  // The match replay loads lazily: `data.js` ships channel metadata and a 5.9 s preview slice, and
  // the ~700 KB match module arrives only on the demo route. app.js awaits this before ensureData.
  // `previewData` is what tells the picker and the brief there is a scene here without one:
  // neither screen builds this robot's telemetry, because its channels are derived from the module
  // it is deliberately not loading.
  previewData,
  // The match module AND the role registers, in one promise, so the demo route's single await
  // still covers everything that screen reads. Both halves stay deduplicated by their own caches.
  loadSceneData: () => loadMatchData().then((d) => loadRoleOpeners().then(() => d)),
  isSceneDataLoaded,
  getSceneData,
  // The lazy-route loading card renders this def-owned copy (app.js falls back to a generic line
  // for defs without it). These are the sentences the card showed since this mission shipped;
  // ssl-nav-race.test.mjs asserts the first one.
  loadingCopy: {
    line: 'Loading the match replay.',
    cap: 'Every tracked robot, the ball and the referee timeline, decoded in your browser.',
  },
  /**
   * Framing overrides for the two staged shots (picker card, brief hero). The shared solve culls
   * "scenery" relative to this scene's own cameraHome distance, and its defaults are tuned for a
   * machine on a table: on a 12 x 9 m pitch they keep the carpet and lose the robots. These pull
   * the cull in tight around the hero moment's ball so the shot is a cluster of robots, which is
   * what a 171 px card can actually show. Every other def ships no block and is unaffected.
   */
  preview: { envCull: 0.3, envRadius: 0.3, distScale: 0.7 },
  /**
   * Which second to pose at, resolved against the payload actually in hand. stage3d's table cannot
   * do this: seconds mean different things in the preview slice and in the full match export, and
   * both screens that pose a robot can meet either one (the picker after a visit to this demo has
   * the full export loaded).
   */
  heroTime() {
    const d = getSceneData();
    return d && d.variant === 'match' ? T_HERO_MATCH_S : T_HERO_PREVIEW_S;
  },
  /**
   * A deterministic, client-rendered line pinned above the composer for the session. Every other
   * provenance surface is scripted or streamed, and a streamed disclosure is only as good as the
   * model's compliance; this one is DOM the page writes itself, on screen before the first
   * question. `chat.js` renders it for any def that ships one; the other four ship none.
   */
  chatProvenance: 'Real match motion. Three faults are synthetic overlays; the bot 13 tracking loss is real.',
  // Deliberately NOT "why did bot 8 stop taking shots": the kicker overlay is synthesized and the
  // shot selection is real, so that phrasing had the analyst assert a causal link no log can
  // carry. This asks about the synthesized channel on its own terms.
  firstQuestion: "What is wrong with bot 8's kicker?",
  // Chip 1 is the sync-combo chip on every mission, because the coach line teaches exactly that.
  // Same entry this chip always resolved to (`vision-confidence`), asked as a show-me, and it is
  // the one fault here that is the log's own data.
  suggested: [
    "Show me where the tracker lost the opponent's bot 13",
    "Is bot 7's radio link healthy?",
    'Why did bot 3 lose the ball?',
    'Walk me through the goal we conceded',
  ],
  script: [
    {
      id: 'kicker-charge',
      matchers: ['kick', 'shot', 'shoot', 'kicker', 'bot 8', 'charge'],
      answer: `Bot 8's kicker bank never recovers to full charge.

| metric | value |
| --- | --- |
| kickerMax set point | 240 V, unchanged all window |
| early window | 236 V at 6.0 s |
| 7.6 s armed, then the kick at 53.977 s | 179 V, then 21 V |
| 1.1 s after the kickoff came into play at 107.84 s | 41 V |

Each kick dumps the capacitor bank and the modelled recovery stretches kick over kick; by the last third it cannot reach a competitive charge.

Synthetic overlay on real match motion: the charge curve is modelled, and nothing the fleet actually did in this window follows from it.

{{ev:kicker-charge}}`,
      // `answer` IS the engineer register and stays the default. The other registers arrive as
      // `answerByRole` from loadRoleOpeners() when the match payload lands.
      evidence: ['kicker-charge'],
    },
    {
      id: 'radio-degraded',
      matchers: ['radio', 'rssi', 'packet', 'freeze', 'stall', 'bot 7', 'link'],
      answer: `Bot 7's link statistics sag across four real stalls.

| metric | value |
| --- | --- |
| rxRssi baseline | -59.4 dBm at 32.5 s |
| rxRssi in the first burst | -88.1 dBm |
| rxPacketsLost peak | 164 pkt/s |
| live-play stalls | 4, first at 33.07 s |

The loss bursts were placed on top of four real stalls; the tracker shows the fleet moving at speed around each one.

Synthetic overlay on real match motion: the stalls are in the tracker, the link statistics are not, and neither explains the other.

{{ev:radio-degraded}}`,
      evidence: ['radio-degraded'],
    },
    {
      id: 'dribbler-overheat',
      matchers: [
        'dribbler',
        'overheat',
        'temperature',
        'ball control',
        'lose the ball',
        'bot 3',
        'double touch',
      ],
      answer: `Bot 3's dribbler overheats holding the ball.

| metric | value |
| --- | --- |
| free-spinning draw | 3.2 A at 30.0 s, inside the 2 to 8 A band |
| loaded peak | 11.5 A at 32.90 s |
| dribTempEstC peak | 92.4 degC at 33.70 s |
| longest carry | 32.32 to 33.98 s, closest 0.0885 m |

The loaded current leaves the 2 to 8 A band on its longest carry and the modelled protection cutout fires.

The modelled cutout coincides with the real ball loss and the double-touch call that followed; the log alone cannot say why the ball got away.

Synthetic overlay on real match motion: the carry and the game controller's ATTACKER_DOUBLE_TOUCHED_BALL call on Polaris #3 at 34.122 s are in the log, the current and the cutout are not.

{{ev:dribbler-overheat}}`,
      evidence: ['dribbler-overheat'],
    },
    {
      id: 'vision-confidence',
      // "last interval", not the more natural synonym: ssl-leak-check's F2 rule bans that word
      // anywhere under this directory, because it would name the STAGE of the real match. The rule
      // is unconditional and has no approval hatch, on purpose, so the copy moves instead.
      matchers: ['bot 13', 'vision', 'tracking', 'disappear', 'camera', 'opponent', 'ghost'],
      answer: `The venue's shared vision lost Ferrum's bot 13.

| metric | value |
| --- | --- |
| lowest tracker confidence | 3/255 at 28.80 s |
| coverage | camera 0, then a handoff to camera 1 |
| last interval | camera 1 only, 250 detections, falling to single readings |
| last tracked sample | 29.70 s, then absent for 80.2 s |

Coverage hands off from camera 0 to camera 1, the detection rate falls from 18 to 19 per bin to single readings, and tracking is lost. League infrastructure, not a fleet fault.

{{ev:vision-confidence}}`,
      evidence: ['vision-confidence'],
    },
    {
      id: 'goal-review',
      // Two ATTRIBUTIONS, labelled, because they disagree and only one is a measurement: the
      // tracker names the last robot to impart velocity (#12 at 62.6897 s), the game controller
      // names the last touch for the RULE and says our keeper, which is what makes it an own goal.
      // This used to quote #12's 59.702 s kick, two touches earlier, as the shot that scored.
      // "last touch", not the synonym: F2 bans that word under this directory. See the vision entry.
      matchers: ['goal', 'conceded', 'own goal', 'score', 'what happened'],
      answer: `The goal at 62.7 s is an own goal off our keeper.

| moment | value |
| --- | --- |
| Ferrum #12 kicks | 59.70 s, 4.25 m/s |
| Ferrum #4 touches | 61.14 s, then 61.20 s |
| Ferrum #12's shot, tracker attribution | 62.69 s, 6.07 m/s |
| ball crosses the line | 62.74 s, HALT |
| game controller's last touch | Polaris #6, our keeper |
| awarded after review | 77.18 s, Ferrum lead 3 to 0 |

Ferrum bot 12 kicks at 59.70 s. Bot 4 touches at 61.14 s and 61.20 s. Bot 12's shot at 62.69 s leaves at 6.07 m/s (tracker attribution). The game controller attributes the last touch to our keeper, bot 6, and the ball crosses at 62.74 s. The score is awarded at 77.18 s after review.

The referee held it for 14.4 s as a POSSIBLE_GOAL, then confirmed it and set up the Polaris kickoff at 101.97 s.

None of the fleet faults can be tied to this goal; they only share the window.`,
      evidence: [],
    },
  ],
  buildScene,
};

export default def;
