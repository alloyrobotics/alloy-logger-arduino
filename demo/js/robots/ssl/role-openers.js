// ssl/role-openers.js - the OPENER's role registers AND the guided flow's beat copy, behind the
// lazy match-data boundary.
//
// This file is reached by a DYNAMIC import from script.js and by nothing else, so it is not in the
// eager module graph (ssl-eager-size.test.mjs walks static imports only). That is deliberate: this
// is chat copy, chat is the demo screen, and the demo screen never mounts until the match module
// has landed. A visitor who opens the picker and never opens this mission pays nothing for it.
//
// The engineer register stays in script.js as the entry's own `answer`. It is not only chat copy:
// build-facts.mjs's analysesSection() reads `entry.answer` off the def to render the facts pack,
// and ssl-script.test.mjs holds every scripted answer to the house format, the non-causality rules
// and the honesty line without loading the payload.
//
// Same table, same numbers, same instants as the engineer answer. Two things do NOT vary by role:
// the honesty line, because this is a synthesized-fault entry and which role a visitor picked
// cannot decide whether they are told what is real, and the {{ev:kicker-charge}} token, so the
// opener's auto-beat fires for every role. Each variant is within 20% of the engineer answer.

/**
 * The OPENER in the operator register, hoisted so both ids that can name that register share ONE
 * string: `operator` is canonical on both sides, `support` is the retired card id kept as a key,
 * and picking only one would silently serve the engineer answer under the other.
 */
const OPENER_SUPPORT = `Bot 8 arms and fires, but the bank is nowhere near full when it goes.

| metric | value |
| --- | --- |
| kickerMax set point | 240 V, unchanged all window |
| early window | 236 V at 6.0 s |
| 7.6 s armed, then the kick at 53.977 s | 179 V, then 21 V |
| 1.1 s after the kickoff came into play at 107.84 s | 41 V |

Each kick dumps the capacitor bank and the modelled recovery stretches kick over kick, so a late kick leaves with a weak charge behind it. Check bot 8's charge before it is sent out for a set piece, and bench test the bank on any bot that arms below the 240 V set point.

Synthetic overlay on real match motion: the charge curve is modelled, and nothing the fleet actually did in this window follows from it.

{{ev:kicker-charge}}`;

/** The OPENER in the lead register. Same rules as OPENER_SUPPORT. */
const OPENER_LEAD = `Bot 8's kicker bank is a charge-time budget, not a broken part.

| metric | value |
| --- | --- |
| kickerMax set point | 240 V, unchanged all window |
| early window | 236 V at 6.0 s |
| 7.6 s armed, then the kick at 53.977 s | 179 V, then 21 V |
| 1.1 s after the kickoff came into play at 107.84 s | 41 V |

Each kick dumps the capacitor bank and the modelled recovery stretches kick over kick, so the last third of a window like this one is where the pattern gets expensive. The decision it points at is a per-bot charge floor checked before a set piece, and a bench test for any bot still under the 240 V set point when it arms.

Synthetic overlay on real match motion: the charge curve is modelled, and nothing the fleet actually did in this window follows from it.

{{ev:kicker-charge}}`;

/**
 * What script.js merges onto the `kicker-charge` entry as `answerByRole`. `engineer` is never a key
 * here: the entry's own `answer` IS the engineer register and stays the default, so an unknown role
 * and a visitor who never forked take the identical path through chat.js's `answerFor()`.
 */
export const OPENER_BY_ROLE = {
  support: OPENER_SUPPORT,
  operator: OPENER_SUPPORT,
  lead: OPENER_LEAD,
};

/**
 * THE GUIDED FLOW for this mission. `sbr/script.js` documents the beat shape in full and is the
 * one place it is written down; this is the same object, on the far side of a dynamic import
 * because none of it can be read before the demo screen exists.
 *
 * The register here is the LEAD one, because this is the mission that role is guided into (so is
 * the engineer, off the same beats and the same numbers, which is the whole argument for a register
 * rather than a second mission). Lead reads for the decision: what does the pattern cost, is it a
 * part or a process, what would you schedule differently. Engineer reads for the signal.
 *
 * Every action points at the `kicker-charge` finding, so the window (46.3 to 62.7 s), the instant,
 * the focus channel, the lit robot and the slow-motion flag all come off `data.js` and none of
 * them is restated here. The numbers in the copy are the same ones the opener above quotes.
 *
 * The synthetic-overlay disclosure rides EVERY beat that leans on the modelled charge curve, the
 * same rule the scripted answers hold to: which beat a visitor is on cannot decide whether they
 * are told what is real.
 */
export const CHOREO = {
  beats: [
    {
      id: 'answer',
      reveal: 'chat',
      answer: 'kicker-charge',
      say: '110 seconds of a Division A match, six channels, 37,043 readings. The motion is real match tracking; three of the onboard faults are synthetic overlays. Ask the log about the one on bot 8.',
      sayByRole: {
        lead: '110 seconds of one match, six channels, 37,043 readings. The motion is real match tracking; three of the onboard faults are synthetic overlays. One question decides whether bot 8 is a broken part or a budget nobody set.',
      },
      cta: "Show me bot 8's charge",
    },
    {
      id: 'chart',
      reveal: 'chart',
      actions: [{ do: 'chart', evidence: 'kicker-charge' }],
      say: 'kickerLevel against kickerMax, zoomed to 46.3 to 62.7 s. The 240 V set point holds flat across the whole window. The bank reads 236 V at 6.0 s early on, 179 V after 7.6 s armed, 21 V on the kick at 53.977 s, and outside this zoom it manages 41 V in the 1.1 s after the kickoff came into play at 107.84 s. The set point never moved. The recovery did. Synthetic overlay on real match motion: the charge curve is modelled.',
      sayByRole: {
        lead: 'The plot is on bot 8, 46.3 to 62.7 s. The 240 V set point never moves all window, so nothing was reconfigured mid-match. What moves is recovery: 236 V at 6.0 s, 179 V after 7.6 s armed, 21 V straight after the kick at 53.977 s, and 41 V in the 1.1 s after the kickoff came into play at 107.84 s. That is a charge-time budget, and a budget is something you can schedule a set piece around. Synthetic overlay on real match motion: the charge curve is modelled.',
      },
      hint: 'Click anywhere on the plot to send the replay to that instant, or pick another channel from the list to see what the rest of the fleet was doing in the same second.',
      cta: 'Put bot 8 back on the pitch',
    },
    {
      id: 'replay',
      reveal: 'stage',
      actions: [{ do: 'replay', evidence: 'kicker-charge' }],
      say: 'The same window at 0.4x, looping, bot 8 lit. The robot arrives, sits armed for 7.6 s, kicks at 53.977 s and leaves with 21 V behind it. The kick and everything the fleet does around it are real tracker data; the bank behind them is modelled, and nothing the fleet actually did follows from it.',
      sayByRole: {
        lead: 'The same window at 0.4x, looping, with bot 8 lit. Watch the cost in match terms: the robot arrives, holds armed for 7.6 s, kicks at 53.977 s and leaves at 21 V, which is the state it takes into the next phase of play. The motion is the real match; the charge curve over it is modelled, so read it as the shape of the problem, not as a verdict on a part.',
      },
      hint: 'Drag the scene to orbit, scroll to zoom, and drag the scrubber to walk the window frame by frame.',
      cta: 'Let me drive',
    },
  ],
};

/**
 * Merge both halves onto the def. It lives HERE rather than in `script.js` because script.js is
 * eager on every visitor who opens the picker and this file is not: moving the two lines across
 * the boundary is the cheapest byte in the mission. See `ssl-eager-size.test.mjs`.
 *
 * `engineer` is never a key in either map: the entry's own `answer` and the beat's own `say` ARE
 * the engineer register and stay the default, so an unknown role and a visitor who never forked
 * take the identical path through `chat.js`'s `answerFor()`.
 *
 * @param {object} def the ssl RobotDefinition
 */
export function applyGuided(def) {
  const opener = def.script.find((e) => e.id === 'kicker-charge');
  if (opener) opener.answerByRole = OPENER_BY_ROLE;
  def.choreo = CHOREO;
}
