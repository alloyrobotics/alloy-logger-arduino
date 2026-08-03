// roles.js - the visitor-role vocabulary, shared by the two routes that read one.
//
// Two unrelated surfaces take a role off the same picker in the demo: worker/chat.js uses it to
// pick the analyst's register, worker/signup-lead.js stores it beside the address. They must agree
// on the vocabulary or a role the popup happily persists is a role the analyst silently ignores,
// which is the kind of drift nobody notices until the export is being read months later. One
// module, one list, both import it.
//
// It imports nothing, so signup-lead.js keeps its plain-node testability: worker/roles.js can be
// pulled into the unit test without dragging the Anthropic SDK in behind chat.js.
//
// THE LIST IS A WHITELIST, NOT A SUGGESTION. `normalizeRole` is the only way either route turns a
// caller-supplied string into a role, and it can only ever return one of these three or null. That
// is what stops a posted `role` becoming free text in a system prompt (chat.js) or an unbounded
// string in the leads table (signup-lead.js).

/**
 * The three registers the demo's picker offers, in the order it offers them.
 *
 * - `engineer`: the default, and what the analyst has always been. Deep detail, exact values.
 * - `operator`: runs the robot, does not read the logs. Wants the consequence, not the channel.
 * - `lead`: owns the fleet and the schedule. Wants scale, risk and what to do next.
 */
export const VISITOR_ROLES = Object.freeze(['engineer', 'operator', 'lead']);

/** The default register. `engineer` is what every answer was before roles existed. */
export const DEFAULT_ROLE = 'engineer';

const ROLE_SET = new Set(VISITOR_ROLES);

/**
 * Ids the client may post that are not canonical names, and the canonical name each one means.
 *
 * `support` is the id `demo/js/core/role.js` gives the middle card ("I keep robots running:
 * support, CS, field ops"). This module calls that same person `operator`. One of the two names
 * has to be the one that reaches the leads table, or the export ends up holding both and neither
 * can be counted, so the canonical name wins and the client's id is translated on the way in.
 *
 * An alias is deliberately cheaper than a rename: renaming the card's id would break the stored
 * `alloy_demo_role` of every visitor who already picked one, and renaming the canonical value
 * would split the export across a migration. A line here costs nothing and is reversible.
 *
 * ALIASES ARE INPUT ONLY. Nothing downstream ever sees one: `normalizeRole` returns a canonical
 * name or null, so the register lookup, the stored column and the export all speak one vocabulary.
 */
const ROLE_ALIASES = Object.freeze({ support: 'operator' });

/**
 * Longest string we will even look at. The whitelist below would reject a long one anyway, but a
 * caller can post megabytes inside the body cap and there is no reason to carry it into a Set
 * lookup or a lowercase pass.
 */
const MAX_ROLE_CHARS = 32;

/**
 * One of VISITOR_ROLES, or null for anything else: absent, empty, misspelled, an object, an array,
 * `__proto__`, a paste. Callers decide what null means for them (chat.js runs the default register,
 * signup-lead.js stores NULL), and neither of them ever sees a string this function did not mint.
 *
 * Unknown values are DROPPED rather than refused. On the chat route a role is a presentation hint
 * attached to a question, and a stale cached client sending a retired role must still get its
 * answer; on the capture route the whole endpoint is built so that nothing about the submission is
 * observable from the response. In both cases a 400 would be the wrong trade.
 */
export function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_ROLE_CHARS) return null;
  const raw = value.trim().toLowerCase();
  // Object.hasOwn, not a plain index: a plain one would resolve "constructor" off Object.prototype
  // and hand back a function, which `ROLE_SET.has` would then reject but only by luck.
  const role = Object.hasOwn(ROLE_ALIASES, raw) ? ROLE_ALIASES[raw] : raw;
  return ROLE_SET.has(role) ? role : null;
}
