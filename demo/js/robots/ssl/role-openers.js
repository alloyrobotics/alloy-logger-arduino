// ssl/role-openers.js - the OPENER's role registers, behind the lazy match-data boundary.
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
