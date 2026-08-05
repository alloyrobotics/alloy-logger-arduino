// role.js - the work-function fork, and the only place it is ever stored.
//
// The demo opens on `#/start` and asks ONE question: what do you do with robots? Not who are you.
// The answer changes the register of the analyst's answers (a hobbyist wants the thing they can
// change on their own bench, an engineer wants the micro detail, a lead wants the shape and the
// cost, marketing wants the sentence they can repeat to a customer), it picks the mission the
// visitor is guided into, it picks which incumbent tool the brief mocks up, and it rides the lead
// record so a signup arrives already segmented.
//
// Role ids are the CANONICAL names, the same four `worker/roles.js` whitelists, so the value in
// localStorage, the PostHog super-prop, the chat POST and the leads column are one vocabulary.
//
// ROLES v2 (2026-08-03). The fork used to be three cards and one of them, `operator`, was an
// identity ("I keep robots running") rather than a work function that changes what an answer should
// SAY. It is retired, and the fourth axis the interview actually found - do you build for yourself,
// professionally, run the team, or talk to the customer - is what the four cards are now. A visitor
// who forked before today has `operator` (or, from an even earlier client, `support`) in their
// localStorage: those DEGRADE to `engineer` on read rather than being dropped, because a stored
// role that resolves to nothing would silently un-segment a returning visitor. Nothing can mint
// either id again; the storage key is unchanged so nobody is logged out of their choice.
//
// Four consumers, one source of truth:
//   * start.js writes it (setRole) when a card is tapped
//   * analytics.js reads it as a PostHog super-prop, and re-registers on change
//   * the brief (its mock family and its register), the old-way panel, the chat POST and the
//     signup payload read it (getRole / effectiveRole)
//   * app.js reads `missionFor` to decide where `#/` sends a returning visitor
//
// Deliberately DEPENDENCY-FREE and DOM-free. It is imported by analytics.js, so importing
// analytics back would be a cycle, and it has to be safe to import from a worker-side test.
// Every storage touch is wrapped: Safari private mode throws on getItem, not just setItem.

/** localStorage key. Same `alloy_` prefix as the signup gate (`alloy_signup_seen`). */
export const ROLE_STORAGE_KEY = 'alloy_demo_role';

/**
 * The fork, as data. Everything a screen needs about a role lives here, so adding a fifth role
 * (or re-pointing engineer at another mission) is one edit in one file and no screen changes.
 *
 * @typedef {object} Role
 * @property {string} id            stable analytics value; never renamed once shipped
 * @property {string} label         the card's headline, first person, one tap
 * @property {string} blurb         the card's second line: who that actually is
 * @property {string} kicker        mono over-line on the card
 * @property {string} mission       robot id this role is guided into (spec: the recommended demo)
 * @property {string} register      persona key the worker prepends to the cached prefix
 * @property {string} answerStyle   human-readable register, for the persona block and for QA
 * @property {{tool:string, caption:string, port?:string}} oldWay  the serial-monitor wall's chrome
 *   and caption for this role (core/oldway.js, the NON-guided briefs). `port` names the artefact in
 *   the panel header; a role that omits it is looking at the capture itself, and the header falls
 *   through to the mission's own.
 * @property {{family:string, caption:string}} mock  the guided brief's centrepiece: which incumbent
 *   tool this role is actually handed, and the sentence under it. Separate from `oldWay` on
 *   purpose - oldway.js ships ONE chrome (a serial wall) and captions it, while the mocks ship four,
 *   so one caption cannot describe both frames. See core/mocks/base.js resolveCopy().
 * @property {string} glyph         24x24 line-art fragment, stroke inherits currentColor
 */

/** @type {Role[]} Card order === this order. */
export const ROLES = [
  {
    id: 'hobbyist',
    label: 'I build my own robots',
    blurb: 'Hobby builds, printed parts, weekend bring-up. When it breaks, you are the whole team.',
    kicker: 'personal builds',
    mission: 'arm6',
    register: 'hobbyist',
    answerStyle:
      'Plain language, practical detail. Name the one signal that gave it away and end on something ' +
      'that can be changed on your own bench.',
    oldWay: {
      tool: 'Serial monitor',
      caption: 'This is the evening you would spend scrolling the serial monitor.',
      // No `port`: this role IS looking at the capture itself, so the header falls through to the
      // mission's own (`context.port`) and only then to the ESP32 default. See oldway.js.
    },
    mock: {
      family: 'serial',
      caption: 'This is the evening you would spend scrolling the serial monitor.',
    },
    // a wrench: the one tool every bench has, and the only glyph in the set that is an object
    glyph:
      '<path d="M14.8 4.2a4 4 0 0 0-5.2 5.2l-5.3 5.3a1.7 1.7 0 0 0 2.4 2.4l5.3-5.3a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.4-2.4z"/>',
  },
  {
    id: 'engineer',
    label: 'I engineer robots professionally',
    blurb: 'Firmware, control loops, bring-up. You are the one who has to find it.',
    kicker: 'engineering',
    // v2 re-points engineer at ssl: the professional's mission is the real match replay with a
    // fleet of them on the pitch, and sbr (one bench robot) is the hobbyist's.
    mission: 'ssl',
    register: 'engineer',
    answerStyle:
      'Deep micro detail. Name the signals, cite the exact samples, and reason from the control loop outward.',
    oldWay: {
      tool: 'Serial monitor',
      caption: 'This is the evening you would spend in the serial monitor.',
    },
    mock: {
      family: 'viz',
      caption: 'This is the tool you already have open when a robot comes back broken.',
    },
    glyph: '<path d="M8 9l-4 3 4 3"/><path d="M16 9l4 3-4 3"/><path d="M13.5 6l-3 12"/>',
  },
  {
    id: 'lead',
    label: 'I run a robotics team',
    // Every card is "<job functions>. <consequence>", so the card whose identity is least obvious
    // is not the one left naming no job. Matters most on mobile, where the `.st-kick` over-line
    // ("leadership") is hidden and the blurb is the only role noun on screen.
    blurb: 'Eng lead, head of robotics, founder. You need to know what it cost and whether it happens again.',
    kicker: 'leadership',
    mission: 'ssl',
    register: 'lead',
    answerStyle:
      'Broad overview. Lead with impact and pattern across the fleet, keep the detail one layer down.',
    oldWay: {
      tool: 'The CSV your team exports',
      caption: 'This is what your team ships you when a robot fails.',
      // A spreadsheet export, named as one: the caption and the header have to be describing the
      // same artefact.
      port: 'mission-export.csv · opened in a spreadsheet · no time axis',
    },
    mock: {
      family: 'fleet',
      caption: 'This is what your dashboard was showing while the mission was failing.',
    },
    glyph: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M3 20h18"/>',
  },
  {
    id: 'marketing',
    label: 'I work in marketing, support, or sales',
    blurb: 'Marketing, CS, sales, field ops. You have to explain the failure to someone who was not there.',
    kicker: 'go to market',
    mission: 'donna',
    register: 'marketing',
    answerStyle:
      'Non-technical. Lead with the outcome and the story, one number at most, and end on the ' +
      'sentence that can be repeated to a customer.',
    oldWay: {
      tool: 'The log the field team sends you',
      caption: 'This is what lands in your inbox after the robot has already been rebooted.',
      // A forwarded log file, named as one. The ESP32 default (`115200 baud`) described a serial
      // session this role never opened, under a caption saying the log arrived by email. The
      // inbox mock also reads the file name out of this line (mocks/inbox.js fileName()).
      port: 'field-dump.log · attached to the ticket · no index',
    },
    mock: {
      family: 'inbox',
      caption: 'This is what lands in your inbox when a robot fails and a customer is waiting.',
    },
    glyph:
      '<path d="M20 19.5V5.2L9 8.6H5.5A2.5 2.5 0 0 0 3 11.1v1.6a2.5 2.5 0 0 0 2.5 2.5H9z"/><path d="M7.5 15.2v3.6a1.6 1.6 0 0 0 3.2 0v-2.9"/>',
  },
];

/** @type {string[]} */
export const ROLE_IDS = ROLES.map((r) => r.id);

/** id -> Role */
const BY_ID = new Map(ROLES.map((r) => [r.id, r]));

/**
 * Retired ids, and what a visitor holding one is read as now.
 *
 * `operator` is v1's middle card under the name worker/roles.js and the leads table used;
 * `support` is the name the v1 CARD used before that rename, and a client cached from that window
 * can still be writing it. Both were the "you get the robot after it broke" seat, and the register
 * closest to it under v2 is the default one, so both degrade to `engineer` rather than resolving to
 * nothing. INPUT ONLY: `normalizeRoleId` never returns a legacy id, so nothing downstream (the
 * super-prop, the chat POST, the lead record) can be minted with one again. Rows already written
 * with `operator` stay as they are - they are history, and rewriting a visitor's storage on read
 * would make the funnel unable to tell a degraded visitor from a fresh engineer.
 *
 * @type {Readonly<Record<string,string>>}
 */
export const LEGACY_ROLE_IDS = Object.freeze({ operator: 'engineer', support: 'engineer' });

/**
 * The register every screen falls back to when there is no role: a direct link, a `?robot=` deep
 * link, a visitor who took the "just exploring" escape. Engineer, per the spec: it is the only
 * register every mission has authored scripts for.
 */
export const DEFAULT_ROLE_ID = 'engineer';

/** The mission the picker escape hatch and an unknown role land on. */
export const DEFAULT_MISSION = 'arm6';

/**
 * Whether a definition participates in the four-step experience. The capability lives on the
 * definition, not in the role table, so direct mission links and future role routing cannot drift.
 * Lazy missions expose `hasExperience` before their full experience block lands.
 *
 * @param {object|null} def
 * @returns {boolean}
 */
export function hasExperience(def) {
  return !!(def && (def.experience || def.hasExperience));
}

/**
 * Legacy exports retained for older brief and guide callers. The old guide is no longer selected by
 * role routing; experience definitions use `hasExperience(def)` instead.
 */
export const GUIDED_MISSIONS = Object.freeze([]);

export function isGuidedMission() {
  return false;
}

/** @param {*} v @returns {boolean} true only for a CANONICAL id; a retired id is not a role */
export function isRoleId(v) {
  return typeof v === 'string' && BY_ID.has(v);
}

/**
 * Any id this demo has ever stored, resolved to a role that exists today. The one funnel every
 * inbound role id goes through: storage, `setRole`, and a change made in another tab.
 *
 * @param {*} v
 * @returns {string|null} a canonical id, or null
 */
export function normalizeRoleId(v) {
  if (typeof v !== 'string') return null;
  if (BY_ID.has(v)) return v;
  // `Object.hasOwn`-style guard: `LEGACY_ROLE_IDS['constructor']` must not resolve to a role
  return Object.prototype.hasOwnProperty.call(LEGACY_ROLE_IDS, v) ? LEGACY_ROLE_IDS[v] : null;
}

/** @param {string} id @returns {Role|null} */
export function roleById(id) {
  return BY_ID.get(id) || null;
}

/**
 * Robot id this role is guided into. An unknown or missing role gets the default mission rather
 * than nothing: the router must always have somewhere to send a visitor.
 *
 * @param {string|Role|null} role id or record
 * @returns {string} robot id
 */
export function missionFor(role) {
  const id = role && typeof role === 'object' ? role.id : normalizeRoleId(role);
  const rec = BY_ID.get(id);
  return rec ? rec.mission : DEFAULT_MISSION;
}

// ---------------------------------------------------------------------------- persistence

/** @returns {Storage|null} */
function store() {
  try {
    return window.localStorage;
  } catch (_) {
    // Safari private mode and a blocked third-party context both throw on ACCESS, not on write
    return null;
  }
}

let cached; // undefined = not read yet, null = read and absent

/**
 * The stored role id, or null. Read through a module-level cache so the hot paths (every event
 * capture, every chat POST) do not hit localStorage, and so a role set in this page session still
 * reads back when storage is unavailable entirely.
 *
 * Always CANONICAL: a visitor still holding a retired id (`operator`, `support`) reads back as the
 * role it degrades to, so no screen and no payload downstream ever has to know v1 existed.
 *
 * @returns {string|null}
 */
export function getRoleId() {
  if (cached !== undefined) return cached;
  const s = store();
  let raw = null;
  try {
    raw = s ? s.getItem(ROLE_STORAGE_KEY) : null;
  } catch (_) {
    raw = null;
  }
  cached = normalizeRoleId(raw);
  return cached;
}

/** @returns {Role|null} the stored role's record */
export function getRole() {
  const id = getRoleId();
  return id ? BY_ID.get(id) : null;
}

/**
 * The role record every screen should actually render off: the stored one, or the default. Use
 * this for COPY (the old-way caption, the analyst register) and `getRole()` for the question
 * "has this visitor chosen yet".
 *
 * @returns {Role}
 */
export function effectiveRole() {
  return getRole() || BY_ID.get(DEFAULT_ROLE_ID);
}

/** @returns {boolean} whether the visitor has been through the fork */
export function hasRole() {
  return getRoleId() != null;
}

// Subscribers are notified for a set, a clear, AND a change made in another tab.
const subs = new Set();

function notify(role) {
  subs.forEach((fn) => {
    try {
      fn(role);
    } catch (err) {
      // one bad subscriber must not stop the others, and must never break a card tap
      console.warn('[role] subscriber threw', err);
    }
  });
}

/**
 * Store the role. Idempotent: setting the role already stored writes nothing and notifies nobody,
 * so a re-render of the start screen cannot fire a second `role_selected`.
 *
 * @param {string} id
 * @returns {Role|null} the stored record, or null if the id is not a role
 */
export function setRole(id) {
  // A retired id may still arrive from an older cached client; it is stored CANONICALLY, so a
  // write is the one moment a legacy value does leave the storage.
  const next = normalizeRoleId(id);
  if (!next) return null;
  if (getRoleId() === next) return BY_ID.get(next);
  cached = next;
  const s = store();
  try {
    if (s) s.setItem(ROLE_STORAGE_KEY, next);
  } catch (_) {
    // quota, private mode, storage disabled: the module cache still carries it for this page
  }
  const rec = BY_ID.get(next);
  notify(rec);
  return rec;
}

/**
 * Adopt an inbound role without counting it as a human fork choice. `setRole` persists the
 * canonical id and notifies the analytics subscriber, while `role_selected` remains owned solely
 * by start.js's explicit Continue tap.
 *
 * @param {string} raw
 * @returns {Role|null} the adopted record, or null when the value is not a known role
 */
export function adoptRole(raw) {
  const id = normalizeRoleId(raw);
  return id ? setRole(id) : null;
}

/** Forget the role (the "start over" path). */
export function clearRole() {
  if (getRoleId() == null) return;
  cached = null;
  const s = store();
  try {
    if (s) s.removeItem(ROLE_STORAGE_KEY);
  } catch (_) {
    /* nothing to remove from a storage we cannot reach */
  }
  notify(null);
}

/**
 * @param {(role: Role|null) => void} fn called on every change, with the new record or null
 * @returns {() => void} unsubscribe
 */
export function onRoleChange(fn) {
  if (typeof fn !== 'function') return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * What the lead record and the chat POST carry. Always an object, so a caller can spread it
 * unconditionally; `role` is null for a visitor who never forked.
 *
 * @returns {{role: string|null, role_mission: string|null}}
 */
export function rolePayload() {
  const id = getRoleId();
  return { role: id, role_mission: id ? missionFor(id) : null };
}

// Another tab forking (or clearing) must not leave this one captioned for the wrong register.
// Guarded: `window` exists in every browser path this ships to, but not in the node test harness.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (!e || e.key !== ROLE_STORAGE_KEY) return;
    const next = normalizeRoleId(e.newValue);
    if (next === (cached === undefined ? getRoleId() : cached)) return;
    cached = next;
    notify(next ? BY_ID.get(next) : null);
  });
}
