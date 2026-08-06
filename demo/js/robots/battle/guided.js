// battle/guided.js - the opener's marketing register for the arena round, behind the lazy
// round-data boundary. The filename is retained so existing cached module URLs keep resolving.

/**
 * The opener in the marketing register. Battle is hidden from the public picker but remains
 * directly routable, so the register still serves visitors who arrive with that role selected.
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

export const OPENER_BY_ROLE = {
  marketing: OPENER_MARKETING,
};

/** Attach the marketing opener without adding retired guide beats. */
export function applyRoleOpeners(def) {
  const opener = def.script.find((e) => e.id === 'chain-overview');
  if (opener) opener.answerByRole = OPENER_BY_ROLE;
}
