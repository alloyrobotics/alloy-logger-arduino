// battle/guided.js - the guided flow's beat copy AND the opener's marketing register for the arena
// round, behind the lazy round-data boundary.
//
// This file is reached by a DYNAMIC import from script.js and by nothing else, so it is not in the
// eager module graph (battle-eager-size.test.mjs walks static imports only). That is deliberate and
// it is the same argument role-openers.js makes on the SSL side: this is demo-screen copy, the demo
// screen never mounts until the round payload has landed, and a visitor who opens the picker and
// never opens this mission should pay nothing for it. The eager half of this mission has 400-odd
// bytes of margin, which is not a budget for three beats of prose.
//
// Nothing here is a second copy of anything. Beat 1 REFERENCES the scripted opener by id rather
// than restating it: that answer is what build-facts.mjs renders into the analyst's facts pack and
// what battle-script.test.mjs holds to the house format, the claim ledger and the causality rules,
// and a duplicate would give the page two openers that drift apart. Every action references one of
// this def's own findings, so the failure windows, the lit robot and the slow-motion flags come off
// data.js and are not restated either.
//
// Every number below is quoted from a scripted answer or a finding on this def, which is what keeps
// it inside claims.mjs without a second ledger: 548 HP, the 2000 HP a robot starts with, 14 shots,
// 23.0 m/s, the 180 heat limit, the 214 peak, the eight ticks from 74.2 to 75.0 s, and the 2.55 s
// timeout dropping the track at 74.55 s.

/**
 * The OPENER in the MARKETING register, the role round 2 guided into this mission. Since the UX
 * wall port, marketing routes to donna and battle is off the public picker; this module still
 * serves the mission's direct routes unchanged.
 *
 * Round 2 routed marketing here and authored a marketing narration for every beat, but left the
 * opener with no register at all: the beat said "no field names, tell the story" and the answer
 * streamed directly under it was the engineer hop table. This is that answer in the register the
 * card promised, on the same evidence, with the same result.
 *
 * Both `{{ev:}}` tokens are kept, so the citation chips and the beat's evidence reference are the
 * same whichever register plays, and the simulated-round disclosure is kept verbatim: which seat a
 * visitor picked cannot decide whether they are told the round is authored.
 */
const OPENER_MARKETING = `Blue 1 shot at something that was not there any more, and the referee billed it for the damage.

| when | what happened |
| --- | --- |
| 72.0 s | it loses sight of its opponent |
| 72.3 s | it keeps chasing the last place it saw it |
| 72.6 s | it opens fire on the obstacle in between |
| 74.2 to 75.0 s | the referee deducts 548 health points |

Nothing broke and nobody shot back. The picture the robot was acting on went stale but kept arriving looking new, so every check it ran said the target was still there. It fired into a wall until its own barrel overheated, and the penalty for that is what cost the round: 548 of the 2000 health points it started with, self-inflicted.

Simulated round: the whole chain is authored, and it is the product pitch, one bad timestamp visible in six channels at once.

{{ev:stale-track}}

{{ev:overheat-self-damage}}`;

/**
 * What `applyGuided` merges onto the `chain-overview` entry. `engineer` is never a key: the entry's
 * own `answer` IS the engineer register and stays the default. Every other key must be a LIVE role
 * id, because role.js degrades a retired one to `engineer` before chat.js's `answerFor()` reads
 * this map and a dead key is a register nobody can reach.
 */
export const OPENER_BY_ROLE = {
  marketing: OPENER_MARKETING,
};

/**
 * THE GUIDED FLOW for this mission. `sbr/script.js` documents the beat shape in full and is the one
 * place it is written down.
 *
 * The register here is the MARKETING one, because this is the mission that role is guided into: a
 * non-technical visitor who has never opened a log. That register gets the STORY - what the robot
 * believed, what it did about it, what it cost - and never a field name. The engineer default is
 * the same three beats, the same order and the same numbers, said in signals.
 *
 * The simulated-round disclosure is not repeated on every beat the way the SSL overlay disclosure
 * is: this mission is synthetic end to end, `chatProvenance` is pinned above the composer for the
 * whole session before beat 1 renders, and the opener beat 1 plays says so in its own body.
 */
export const CHOREO = {
  beats: [
    {
      id: 'answer',
      reveal: 'chat',
      answer: 'chain-overview',
      // "Halcyon lost" was the old first line. Halcyon Labs is named in `context.mission` and in the
      // third sentence of `context.system`, and the guided brief renders neither (the mission
      // paragraph is off, and the system line is cut to its first sentence), so the proper noun had
      // no antecedent anywhere on the guided path.
      say: "A simulated 2v2 round, 180 seconds, six channels off one robot. Blue 1's team lost it. At 72 seconds Blue 1 took 548 HP off itself with nothing shooting at it. Ask the log why.",
      sayByRole: {
        marketing:
          'Two robots a side, three minutes, nobody driving them, all of it simulated. Blue 1 was logging everything it did. It lost 548 of its 2000 health points without a single enemy shot landing on it, and its team lost the round for it. Ask the log.',
      },
      cta: 'Show me what broke',
    },
    {
      id: 'chart',
      reveal: 'chart',
      actions: [{ do: 'chart', evidence: 'stale-track' }],
      say: 'Vision confidence and trackAgeS, zoomed to 69.0 to 76.0 s. Confidence collapses at 72.0 s and stays on the floor. trackAgeS ramps off that same stamp for 2.55 s until the track is dropped at 74.55 s. The track layer kept republishing the dead target stamped at publish time, so the age check downstream read a fresh number on a stale position.',
      sayByRole: {
        marketing:
          "This is the robot's eyesight, drawn from 69 to 76 seconds. At 72 seconds its opponent slips behind an obstacle: the confidence line falls off a cliff and never comes back. The second line is the age of the picture the robot is still acting on, and it climbs for 2.55 seconds before anything notices. It was looking at a photograph and thought it was a window.",
      },
      // No `hintByRole` exists, so this one line is read by the marketing visitor the beats above
      // are written for: "channel", "the planner, the chassis and the referee feed" put three
      // subsystem nouns in the one register whose whole brief is not to use them.
      hint: 'Click anywhere on the plot to jump the replay to that moment, or pick another line from the list to see what the rest of the robot was doing in the same second.',
      cta: 'Show me what it did next',
    },
    {
      id: 'replay',
      reveal: 'stage',
      actions: [{ do: 'replay', evidence: 'blind-burst' }],
      say: "72.0 to 75.5 s at 0.4x, looping, Blue 1 lit. The held bearing sat outside the gimbal's own yaw window, so the chassis rotated to face it and put 14 shots at 23.0 m/s into the obstacle. Barrel heat crossed the 180 limit, peaked at 214, and the referee billed 548 HP across eight ticks from 74.2 to 75.0 s.",
      sayByRole: {
        marketing:
          'Watch Blue 1 from 72 to 75.5 seconds, slowed and looping. It turns its whole body to aim at something that stopped being there three seconds ago, fires 14 rounds into a wall, cooks its own barrel past the limit, and the referee fines it 548 health points. No enemy was involved.',
      },
      hint: 'Drag the scene to orbit, scroll to zoom, and drag the scrubber to walk the burst shot by shot.',
      cta: 'Let me drive',
    },
  ],
};

/**
 * Merge the beats AND the opener's marketing register onto the def. Both live HERE rather than in
 * script.js for the same reason: script.js is eager on every visitor who opens the picker and this
 * file is not, and the eager half of this mission has tens of bytes of margin, not hundreds.
 *
 * `engineer` is never a key in `sayByRole` or in `OPENER_BY_ROLE`: the beat's own `say` and the
 * entry's own `answer` ARE the engineer register and stay the default, so an unknown role and a
 * visitor who never forked take the identical path.
 *
 * @param {object} def the battle RobotDefinition
 */
export function applyGuided(def) {
  const opener = def.script.find((e) => e.id === 'chain-overview');
  if (opener) opener.answerByRole = OPENER_BY_ROLE;
  def.choreo = CHOREO;
}
