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
// caller-supplied string into a role, and it can only ever return one of these four or null. That
// is what stops a posted `role` becoming free text in a system prompt (chat.js) or an unbounded
// string in the leads table (signup-lead.js).

/**
 * The four registers the demo's picker offers, in the order it offers them.
 *
 * ROLES v2 (2026-08-03) splits the vocabulary by WORK FUNCTION rather than by seniority, because
 * that is the axis the answer's altitude actually turns on:
 *
 * - `hobbyist`: builds their own robots. Technical and curious, no team behind them.
 * - `engineer`: does this professionally, and the default. Deep detail, exact values.
 * - `lead`: owns the fleet and the schedule. Wants scale, risk and what to do next.
 * - `marketing`: marketing or CS. Not an engineer, has to explain the robot to somebody else.
 *
 * v1's `operator` ("keeps robots running: support, CS, field ops") turned out to be two different
 * people wearing one id, and it is retired: see ROLE_ALIASES.
 */
export const VISITOR_ROLES = Object.freeze(['hobbyist', 'engineer', 'lead', 'marketing']);

/** The default register. `engineer` is what every answer was before roles existed. */
export const DEFAULT_ROLE = 'engineer';

const ROLE_SET = new Set(VISITOR_ROLES);

/**
 * Ids the client may post that are not canonical names, and the canonical name each one means.
 *
 * Both entries are v1's retired middle card. `operator` was the canonical name this module used
 * until ROLES v2 and is therefore the value already sitting in the leads table and in every
 * visitor's `alloy_demo_role`; `support` is the id `demo/js/core/role.js` gave that same card. v2
 * has no single successor for either, so both DEGRADE to `engineer`: it is the register every
 * mission has authored scripts for, and the one the whole route falls back to anyway.
 *
 * Degrading beats dropping. A visitor who picked that card weeks ago still has it in localStorage,
 * and their next question posts it; dropping it would be correct but would hand them the default
 * register through a null, which is the same answer with a lost analytics row attached. Degrading
 * beats a rename for the same reason it did in v1: renaming would either break every stored value
 * or split the export across a migration, and a line here costs nothing and is reversible.
 *
 * ALIASES ARE INPUT ONLY. Nothing downstream ever sees one: `normalizeRole` returns a canonical
 * name or null, so the register lookup, the stored column and the export all speak one vocabulary.
 * Rows captured before 2026-08-03 still hold the literal `operator`, and those are history, not a
 * value this function can mint any more.
 */
const ROLE_ALIASES = Object.freeze({ operator: 'engineer', support: 'engineer' });

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
