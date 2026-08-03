// role.js - the work-function fork, and the only place it is ever stored.
//
// The demo opens on `#/start` and asks ONE question: what do you do with robots? Not who are you.
// The answer changes the register of the analyst's answers (engineer wants the micro detail,
// support wants the fix, a lead wants the shape of the problem), it picks the mission the visitor
// is guided into, and it rides the lead record so a signup arrives already segmented.
//
// Three consumers, one source of truth:
//   * start.js writes it (setRole) when a card is tapped
//   * analytics.js reads it as a PostHog super-prop, and re-registers on change
//   * the brief, the old-way panel, the chat POST and the signup payload read it (getRole)
//
// Deliberately DEPENDENCY-FREE and DOM-free. It is imported by analytics.js, so importing
// analytics back would be a cycle, and it has to be safe to import from a worker-side test.
// Every storage touch is wrapped: Safari private mode throws on getItem, not just setItem.

/** localStorage key. Same `alloy_` prefix as the signup gate (`alloy_signup_seen`). */
export const ROLE_STORAGE_KEY = 'alloy_demo_role';

/**
 * The fork, as data. Everything a screen needs about a role lives here, so adding a fourth role
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
 * @property {{tool:string, caption:string}} oldWay  beat 2's chrome + caption for this role
 * @property {string} glyph         24x24 line-art fragment, stroke inherits currentColor
 */

/** @type {Role[]} Card order === this order. */
export const ROLES = [
  {
    id: 'engineer',
    label: 'I build and debug robots',
    blurb: 'Firmware, control loops, bring-up. You are the one who has to find it.',
    kicker: 'engineering',
    mission: 'sbr',
    register: 'engineer',
    answerStyle:
      'Deep micro detail. Name the signals, cite the exact samples, and reason from the control loop outward.',
    oldWay: {
      tool: 'Serial monitor',
      caption: 'This is the evening you would spend in the serial monitor.',
    },
    glyph: '<path d="M8 9l-4 3 4 3"/><path d="M16 9l4 3-4 3"/><path d="M13.5 6l-3 12"/>',
  },
  {
    id: 'support',
    label: 'I keep robots running',
    blurb: 'Support, CS, field ops. You get the robot after it has already broken.',
    kicker: 'support and field ops',
    mission: 'rescue',
    register: 'support',
    answerStyle:
      'Less technical, solution first. Say what happened in plain language and what to do about it next.',
    oldWay: {
      tool: 'The log the field team sends you',
      caption: 'This is what lands in your inbox after the robot has already been rebooted.',
    },
    glyph:
      '<path d="M12 3l7 3v5c0 4-3 6.7-7 8-4-1.3-7-4-7-8V6z"/><path d="M9.2 12l2 2 3.6-4"/>',
  },
  {
    id: 'lead',
    label: 'I run a robotics team',
    blurb: 'You need to know what happened, what it cost, and whether it happens again.',
    kicker: 'leadership',
    mission: 'ssl',
    register: 'lead',
    answerStyle:
      'Broad overview. Lead with impact and pattern across the fleet, keep the detail one layer down.',
    oldWay: {
      tool: 'The CSV your team exports',
      caption: 'This is what your team ships you when a robot fails.',
    },
    glyph: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M3 20h18"/>',
  },
];

/** @type {string[]} */
export const ROLE_IDS = ROLES.map((r) => r.id);

/** id -> Role */
const BY_ID = new Map(ROLES.map((r) => [r.id, r]));

/**
 * The register every screen falls back to when there is no role: a direct link, a `?robot=` deep
 * link, a visitor who took the "just exploring" escape. Engineer, per the spec: it is the only
 * register every mission has authored scripts for.
 */
export const DEFAULT_ROLE_ID = 'engineer';

/** The mission the picker escape hatch and an unknown role land on. */
export const DEFAULT_MISSION = 'sbr';

/** @param {*} v @returns {boolean} */
export function isRoleId(v) {
  return typeof v === 'string' && BY_ID.has(v);
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
  const id = role && typeof role === 'object' ? role.id : role;
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
  cached = isRoleId(raw) ? raw : null;
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
  if (!isRoleId(id)) return null;
  if (getRoleId() === id) return BY_ID.get(id);
  cached = id;
  const s = store();
  try {
    if (s) s.setItem(ROLE_STORAGE_KEY, id);
  } catch (_) {
    // quota, private mode, storage disabled: the module cache still carries it for this page
  }
  const rec = BY_ID.get(id);
  notify(rec);
  return rec;
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
    const next = isRoleId(e.newValue) ? e.newValue : null;
    if (next === (cached === undefined ? getRoleId() : cached)) return;
    cached = next;
    notify(next ? BY_ID.get(next) : null);
  });
}
