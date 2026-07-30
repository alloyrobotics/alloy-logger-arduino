// battle/script.js - the battle RobotDefinition. Every number quoted below is registered in
// claims.mjs, either as a cited rules-manual constant or as a data claim bound to an exact
// exported sample or event; battle-data.test.mjs scans this copy and fails on any number that is
// in neither set, so prose and payload cannot drift apart.
//
// This mission is FULLY SYNTHETIC and says so on every surface: a scripted, rules-faithful
// simulated round of the ICRA 2019 RoboMaster AI Challenge ruleset (DJI Rules Manual V1.1),
// fictional teams, no real match data anywhere. The honesty line lives in context.provenance,
// chatProvenance, the facts-pack preamble, and the scripted answers below.

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
} from './data.js';
import { buildScene } from './scene.js';

/**
 * The posed moment for the picker card and the brief hero, resolved against the payload in hand
 * (same two-clock problem as the other lazy mission: the preview slice is 37.0 to 43.0 s of the
 * round re-based to zero). Both instants sit in the Beat 5 buff firefight, well BEFORE the 72 s
 * failure, per the stage3d rule that a hero pose never shows the wreck.
 */
const T_HERO_MATCH_S = 45.0;
const T_HERO_PREVIEW_S = 3.5;

export default {
  id: 'battle',
  name: '2v2 Arena Battle',
  device: 'RoboMaster AI Challenge ruleset (ICRA 2019) · simulated round',
  tagline: 'One stale target message. 548 HP of self-inflicted damage.',
  context: {
    system:
      'Two fully autonomous robots per team on an 8 x 5 m arena, three-minute round. A rules-faithful simulation of the ICRA 2019 RoboMaster AI Challenge ruleset (DJI Rules Manual V1.1): 2000 HP per robot, 50 HP per 17 mm hit, barrel heat limit 180, defense zones that halve damage, projectile suppliers. Fictional teams: Halcyon Labs (blue) vs Redline Dynamics (red).',
    mission:
      "You are Halcyon Labs' data engineer. Blue 1 carried an AlloyLogger board streaming six subsystems live during the round: vision, localization, planner, chassis, gimbal and launcher, and the referee feed. Halcyon lost. The log says why.",
    fault:
      'At 72 seconds Blue 1 was tracking Red 2 when it slipped behind an obstacle. The target message went stale, but the fire controller kept consuming the old bearing. The robot rotated, fired a 14-shot burst into the obstacle, crossed the 180 barrel heat limit, and deducted 548 of its own HP.',
    faultT: 72.0,
    label: 'stale target, blind burst',
    provenance:
      'A scripted, rules-faithful simulated round. No real match data; every stream is synthetic, generated against the published rules manual. Channel names and units follow the open-source robot software teams actually ran.',
  },
  accent: '#e0564f',
  duration,
  rate,
  // Mixed-rate mission: `rate` is a summary, `rates` + `rateNotes` are the fact, and the facts
  // builder emits a cadence line per channel from them rather than one global Hz.
  rates,
  rateNotes,
  channels,
  buildData,
  findings,
  // Facts-pack budget knob (plan-fixed cut order): pin the whole-mission table at the 40-point
  // floor; six channels would otherwise get 53 and the pack is the largest on the page.
  factsSeriesPoints: 40,
  // The round replay loads lazily: data.js ships channel metadata and a 6 s preview slice, and the
  // full-round module arrives only on the demo route. app.js awaits this before ensureData.
  previewData,
  loadSceneData,
  isSceneDataLoaded,
  getSceneData,
  // Typed round events for the facts pack (supplier bookings, zone triggers, the eight overheat
  // ticks, survivors, result). Callable only after loadSceneData resolves; build-facts awaits that.
  eventLines,
  heroTime() {
    const d = getSceneData();
    return d && d.variant === 'match' ? T_HERO_MATCH_S : T_HERO_PREVIEW_S;
  },
  /**
   * A deterministic, client-rendered disclosure pinned above the composer for the session; DOM the
   * page writes itself, on screen before the first question.
   */
  chatProvenance:
    'Simulated round. All telemetry in this mission is synthetic, generated from a scripted 2v2 battle that follows the ICRA 2019 RoboMaster AI Challenge rules manual. Nothing here was recorded from a real match.',
  firstQuestion: 'Why did Blue 1 lose 548 HP with no enemy in sight?',
  suggested: [
    'What went stale at 72 seconds?',
    'How does barrel heat turn into HP loss?',
    'Who won the round, and why?',
  ],
  script: [
    {
      id: 'chain-overview',
      matchers: ['548', 'no enemy', 'hp drop', 'own hp', 'why did blue 1', 'self'],
      answer: `Blue 1 shot an obstacle for nearly two seconds and paid for it in its own HP.

| t | hop |
| --- | --- |
| 72.0 s | track lost |
| 72.3 s | chase goal frozen |
| 72.6 s | blind burst begins |
| 74.2 to 75.0 s | 548 HP deducted |

The target message went stale at 72.0 but kept arriving with fresh timestamps, so the fire controller's age check never tripped: the chassis rotated to the held bearing and fired 14 shots at 23.0 m/s into the obstacle. The stale track finally timed out after 2.55 s, at 74.55. By then barrel heat had crossed 180, peaked at 214, and the referee had billed the 548 across eight ticks.

Simulated round: the whole chain is authored, and it is the product pitch, one bad timestamp visible in six channels at once.

{{ev:stale-track}}

{{ev:overheat-self-damage}}`,
      evidence: ['stale-track', 'overheat-self-damage'],
    },
    {
      id: 'stale-track',
      matchers: ['stale', '72 seconds', 'what happened at 72', 'track', 'vision'],
      answer: `The tracker republished a dead target as live for 2.55 seconds.

| metric | value |
| --- | --- |
| last real detection | 72.0 s, Red 2 slips behind the obstacle |
| confidence | collapses at 72.0 s |
| trackAgeS | ramps from 0 at exactly 72.0 s |
| stale timeout | 2.55 s, track dropped at 74.55 s |

The detector stopped seeing Red 2, but the track layer kept publishing the last good position with detected set to true, stamped at publish time rather than capture time. trackAgeS in the log is the capture age the robot never checked: it ramps while confidence is on the floor.

{{ev:stale-track}}`,
      evidence: ['stale-track'],
    },
    {
      id: 'blind-burst',
      matchers: ['fire controller', 'keep shooting', 'shoot', 'gimbal', 'rotate', 'burst'],
      answer: `The fire gate checked message freshness, and every stale message was fresh.

The fire controller gated on the timestamp of the incoming target message. Because the track layer stamps at publish time, a seconds-old position still looked milliseconds old. The reference stack this pipeline is modeled on ships no track ID, no sequence number, and no track age, so there was nothing else to gate on.

The planner had already frozen its chase goal at the same dead position, so nothing upstream disagreed with the gate. The held point sat outside the gimbal's plus or minus 90 degree window, so the chassis rotated to face it and the 14-shot burst went into the obstacle.

{{ev:frozen-goal}}

{{ev:blind-burst}}`,
      evidence: ['frozen-goal', 'blind-burst'],
    },
    {
      id: 'heat-rule',
      matchers: ['barrel heat', 'heat', '180', 'overheat', 'cooling'],
      answer: `Heat is muzzle speed added per shot; over 180 the referee bills you every 100 ms.

| rule (Rules Manual V1.1) | this round |
| --- | --- |
| each shot adds its muzzle speed to heat | 14 shots at 23.0 m/s |
| cooling 60 per second, settled at 10 Hz | heat first passed 180 on shot 12 at 74.171 s |
| over 180: (heat minus 180) x 4 HP per tick | eight ticks, 74.2 to 75.0 s, total 548 HP |

Peak heat was 214. Note the tail: firing stopped at 74.55 but the deductions ran to 75.0, because heat cools only 6 per tick.

{{ev:overheat-self-damage}}`,
      evidence: ['overheat-self-damage'],
    },
    {
      id: 'round-result',
      matchers: ['won', 'winner', 'result', 'who lost', 'decided'],
      answer: `Redline Dynamics won on damage, and Blue 1's own burst was the margin.

| team | damage credited |
| --- | --- |
| Redline Dynamics (red) | 1448 = 900 dealt + 548 of Blue 1's self-inflicted loss |
| Halcyon Labs (blue) | 1150 dealt |

The rules credit self-inflicted deductions to the opponent. Every robot survived, so the round went to the higher total at the clock. Take away the overheat and Halcyon wins 1150 to 900. One stale timestamp decided the round.

{{ev:overheat-self-damage}}`,
      evidence: ['overheat-self-damage'],
    },
    {
      id: 'provenance',
      matchers: ['real', 'recorded', 'simulated', 'actual match', 'synthetic'],
      answer: `Simulated, and labeled that way everywhere.

This is a scripted, rules-faithful simulated round of the ICRA 2019 RoboMaster AI Challenge ruleset. No stream here was recorded from a real match: motion, shots, and referee data are all generated against the published manual, and the fault at 72 seconds is authored.

The channel names and units follow the open-source software real teams ran, so the failure mode is faithful even though the round is fiction.`,
      evidence: [],
    },
  ],
  buildScene,
};
