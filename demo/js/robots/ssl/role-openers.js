// ssl/role-openers.js - the opener's role registers and the three-step mission experience,
// behind the lazy match-data boundary.
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
// Same table, same numbers and same instants as the engineer answer. The chat opener shaper keeps
// one causal paragraph and drops the repeated provenance paragraph because the standing chat line
// and inline finding note already disclose the synthetic data. The evidence token stays in every role.
//
// `experience.js` is imported statically from HERE rather than from `script.js` for the same
// reason this file is reached dynamically: the eager gate walks static imports from `script.js`
// only, so a static import on this side of the boundary is free, and the flow's step screens
// cannot read a line of it before the payload has landed anyway.

import { applyExperience } from './experience.js';

/**
 * The OPENER in the HOBBYIST register.
 *
 * Until roles v2 this was `OPENER_SUPPORT`, keyed on `support` and `operator`. Both ids are retired
 * and `role.js` degrades them to `engineer` BEFORE `chat.js`'s `answerFor()` reads this map, so
 * neither key could ever be selected again. The copy is bench-actionable rather than fleet-wide,
 * so it reads as the hobbyist register and is keyed there.
 */
const OPENER_HOBBYIST = `Bot 8 arms and fires, but the bank is nowhere near full when it goes.

| metric | value |
| --- | --- |
| kickerMax set point | 240 V, unchanged all window |
| early window | 236 V at 6.0 s |
| 7.6 s armed, then the kick at 53.977 s | 179 V, then 21 V |
| 1.1 s after the kickoff came into play at 107.84 s | 41 V |

Each kick dumps the capacitor bank and the modelled recovery stretches kick over kick, so a late kick leaves with a weak charge behind it. Check bot 8's charge before it is sent out for a set piece, and bench test the bank on any bot that arms below the 240 V set point.

Synthetic overlay on real match motion: the charge curve is modelled, and nothing the fleet actually did in this window follows from it.

{{ev:kicker-charge}}`;

/** The OPENER in the lead register. Same rules as OPENER_HOBBYIST. */
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
 *
 * Every other key must be a LIVE role id. A retired id (`operator`, `support`) is degraded upstream
 * and can never reach this lookup, so keying one is a dead string, not a fallback.
 */
export const OPENER_BY_ROLE = {
  hobbyist: OPENER_HOBBYIST,
  lead: OPENER_LEAD,
};

/**
 * Attach the role-specific opener and the flow experience behind the lazy match-data boundary.
 *
 * @param {object} def the ssl RobotDefinition
 */
export function applyRoleOpeners(def) {
  const opener = def.script.find((e) => e.id === 'kicker-charge');
  if (opener) opener.answerByRole = OPENER_BY_ROLE;
  applyExperience(def);
}
