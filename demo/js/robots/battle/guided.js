// battle/guided.js - the guided flow's beat copy for the arena round, behind the lazy round-data
// boundary.
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
// it inside claims.mjs without a second ledger: 548 HP, 14 shots, 23.0 m/s, the 180 heat limit, the
// 214 peak, the eight ticks from 74.2 to 75.0 s, the 2.55 s timeout dropping the track at 74.55 s,
// and the 1448 to 1150 result.

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
      say: 'A simulated 2v2 round, 180 seconds, six channels off one robot. Halcyon lost. At 72 seconds Blue 1 took 548 HP off itself with nothing shooting at it. Ask the log why.',
      sayByRole: {
        marketing:
          'Two robots a side, three minutes, nobody driving them. One of them, Blue 1, was logging everything it did. It lost 548 of its 2000 health points without a single enemy shot landing on it, and its own team lost the round because of it. The whole story is in the log. Ask it.',
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
      hint: 'Click anywhere on the plot to send the replay to that instant, or pick another channel from the list to watch the same second on the planner, the chassis and the referee feed.',
      cta: 'Show me what it did next',
    },
    {
      id: 'replay',
      reveal: 'stage',
      actions: [{ do: 'replay', evidence: 'blind-burst' }],
      say: "72.0 to 75.5 s at 0.4x, looping, Blue 1 lit. The held bearing sat outside the gimbal's own yaw window, so the chassis rotated to face it and put 14 shots at 23.0 m/s into the obstacle. Barrel heat crossed the 180 limit, peaked at 214, and the referee billed 548 HP across eight ticks from 74.2 to 75.0 s.",
      sayByRole: {
        marketing:
          'Watch Blue 1 from 72 to 75.5 seconds, slowed down and looping. It turns its whole body to aim at something that stopped being there three seconds ago, fires 14 rounds into a wall, cooks its own barrel past the limit, and the referee fines it 548 health points for it. No enemy was involved at any point. The round finished 1448 to 1150 the other way, and 548 of that margin is what you just watched.',
      },
      hint: 'Drag the scene to orbit, scroll to zoom, and drag the scrubber to walk the burst shot by shot.',
      cta: 'Let me drive',
    },
  ],
};

/**
 * Merge the beats onto the def. The merge lives HERE rather than in script.js for the same reason
 * the copy does: script.js is eager on every visitor who opens the picker and this file is not.
 *
 * `engineer` is never a key in `sayByRole`: the beat's own `say` IS the engineer register and stays
 * the default, so an unknown role and a visitor who never forked take the identical path.
 *
 * @param {object} def the battle RobotDefinition
 */
export function applyGuided(def) {
  def.choreo = CHOREO;
}
