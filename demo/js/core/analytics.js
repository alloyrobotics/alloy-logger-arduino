// analytics.js - the demo's funnel instrumentation. One module, one token, twelve events.
//
// The question this exists to answer is a single number: how long from landing to the visitor
// clicking an evidence chip THEMSELVES (`evidence_user_clicked`). That is the aha. Everything else
// on the list is either the step before it (role fork, brief, old way, first answer, the scripted
// chip that fires itself) or the money after it (question asked, popup shown, lead submitted).
//
//   import { initAnalytics, track, EVENTS, capture } from './core/analytics.js';
//   initAnalytics();                          // boot, once
//   track.briefViewed('sbr');                 // per screen
//   track.evidenceUserClicked('sbr', 'fall'); // the aha; carries ms_since_land
//
// posthog-js is loaded at RUNTIME, from PostHog's own asset host, and nothing here waits on it:
// events captured before the library lands (or while it is failing to land) go into a bounded
// queue and are replayed with their original timestamps once it is up. A blocked script, an
// ad-blocker or an offline visitor therefore costs the demo nothing but the events themselves.
//
// Deliberately NOT autocapture: this demo is one page of canvases and chips, autocapture would
// bill for thousands of meaningless `$autocapture` rows and none of them would be the funnel.

import { getRoleId, onRoleChange } from './role.js';

/** Project token. Public by design: it is a write-only ingestion key. */
export const POSTHOG_TOKEN = 'phc_72r7yO5WojENwSJuSEzB1ZB02yP8egeQ4pTrCwaN6hf';
/** US cloud ingestion host. */
export const POSTHOG_HOST = 'https://us.i.posthog.com';
/** Static assets live on the sibling host; `api_host` is not where array.js is served from. */
export const POSTHOG_ASSETS_HOST = 'https://us-assets.i.posthog.com';
/** Where the "view in PostHog" links point. Not an ingestion endpoint. */
export const POSTHOG_UI_HOST = 'https://us.posthog.com';

/**
 * The funnel, in order. Frozen and exported so no call site can invent a near-miss name: one
 * `oldway_seen` and one `old_way_seen` in the same project is a broken funnel nobody notices for
 * a month.
 */
export const EVENTS = Object.freeze({
  ROLE_SELECTED: 'role_selected',
  BRIEF_VIEWED: 'brief_viewed',
  OLDWAY_SEEN: 'oldway_seen',
  FIRST_ANSWER_SETTLED: 'first_answer_settled',
  EVIDENCE_AUTO_PLAYED: 'evidence_auto_played',
  EVIDENCE_USER_CLICKED: 'evidence_user_clicked',
  QUESTION_ASKED: 'question_asked',
  POPUP_SHOWN: 'popup_shown',
  LEAD_SUBMITTED: 'lead_submitted',
  // round 2: the brief's incumbent-tool mock, and the guided walk that replaced the 420 ms opener
  MOCK_VIEWED: 'mock_viewed',
  BEAT_SHOWN: 'beat_shown',
  BEAT_CTA_CLICKED: 'beat_cta_clicked',
});

/** localStorage kill switch, for QA sessions that must not pollute the funnel. */
const OPTOUT_KEY = 'alloy_demo_analytics';
/** Bounded: a visitor who is never going to load the library must not grow an unbounded array. */
const MAX_QUEUE = 60;

/** Wall clock for the "how long did the aha take" measure. Module eval === page land. */
const LAND_AT = now();

let inited = false;
let enabled = false;
let ready = false; // the real library is up and init() has been called on it
let failed = false;
let debug = false;
let queue = [];
let ahaFired = false;
/** Super-props applied to every event. Kept here too, so a pre-ready event carries them. */
const superProps = {};

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** @returns {number} ms since the page was loaded. The numerator of time-to-aha. */
export function msSinceLand() {
  return Math.round(now() - LAND_AT);
}

/** @returns {string|null} raw query value, or null outside a browser */
function param(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch (_) {
    return null;
  }
}

/**
 * Whether this page should report at all.
 *
 * Off on localhost and on `file:` by default, because the funnel is a production measure and a
 * week of local development would otherwise sit in the middle of it. `?ph=on` forces it on (the
 * way to verify the wiring against a local build), `?ph=off` and the localStorage key force it
 * off. Do Not Track is handed to posthog-js itself (`respect_dnt`) rather than gated here, so the
 * library stays the one authority on consent.
 */
function shouldEnable() {
  if (typeof window === 'undefined' || !window.document) return false;
  const q = param('ph');
  if (q === 'on' || q === '1') return true;
  if (q === 'off' || q === '0') return false;
  try {
    if (window.localStorage && window.localStorage.getItem(OPTOUT_KEY) === 'off') return false;
  } catch (_) {
    /* storage unreachable: not a reason to stop reporting */
  }
  const host = window.location.hostname || '';
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;
  if (host.endsWith('.local')) return false;
  if (window.location.protocol === 'file:') return false;
  return true;
}

/** The live posthog handle, or null when the library is not up. */
function client() {
  const ph = typeof window !== 'undefined' ? window.posthog : null;
  return ph && typeof ph.capture === 'function' ? ph : null;
}

/**
 * Load posthog-js and initialise it.
 *
 * The official inline snippet is deliberately NOT used. It installs a stub whose internals
 * (`_i`, `__SV`, the method list) array.js then takes over, and reproducing that contract by hand
 * is a silent-failure risk for no gain: this module already owns a queue, so it can load the real
 * library directly and flush into it. A page that DOES ship the snippet in its head is still
 * handled: an existing handle is adopted instead of loading a second copy.
 */
function loadPostHog() {
  const existing = client();
  if (existing) {
    initClient(existing);
    return;
  }
  const d = window.document;
  const s = d.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = POSTHOG_ASSETS_HOST + '/static/array.js';
  s.onload = () => {
    const ph = client();
    if (!ph || typeof ph.init !== 'function') {
      // the file loaded but did not give us a library: treat it exactly like a blocked request
      fail('posthog loaded without an init()');
      return;
    }
    initClient(ph);
  };
  s.onerror = () => fail('posthog script blocked or unreachable');
  (d.head || d.body || d.documentElement).appendChild(s);
}

function fail(why) {
  failed = true;
  ready = false;
  queue = [];
  if (debug) console.warn('[analytics] disabled:', why);
}

function initClient(ph) {
  // A page that already initialised posthog in its head (the official snippet) hands us a live
  // library: re-initialising it logs a warning and changes nothing, so adopt it and flush instead.
  if (ph.__loaded === true) {
    ready = true;
    flush();
    return;
  }
  try {
    ph.init(POSTHOG_TOKEN, {
      api_host: POSTHOG_HOST,
      ui_host: POSTHOG_UI_HOST,
      // hand-wired funnel only: autocapture on a page of canvases, chips and a scrubber is noise
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      // the demo is one hash-routed page; screens are captured as events, not as pageviews
      capture_performance: false,
      disable_session_recording: true,
      respect_dnt: true,
      person_profiles: 'identified_only',
      persistence: 'localStorage+cookie',
      loaded: () => {
        ready = true;
        flush();
      },
    });
    // `loaded` is the reliable signal, but a library that has already been initialised by the page
    // will not call it again. Flushing here too is safe: flush() is idempotent per event.
    if (typeof ph.__loaded === 'boolean' ? ph.__loaded : true) {
      ready = true;
      flush();
    }
  } catch (err) {
    fail('posthog init threw: ' + (err && err.message));
  }
}

/** Replay everything captured before the library was up, with the timestamps it happened at. */
function flush() {
  const ph = client();
  if (!ph || !queue.length) return;
  const pending = queue;
  queue = [];
  pending.forEach((item) => {
    try {
      ph.capture(item.event, item.props, { timestamp: item.at });
    } catch (err) {
      if (debug) console.warn('[analytics] flush failed for', item.event, err);
    }
  });
}

/**
 * Boot. Safe to call more than once; the second call is a no-op.
 *
 * @param {{ enabled?:boolean, debug?:boolean, props?:object }} [opts]
 *   `enabled` overrides the host heuristic outright (QA harnesses, a staging build that should
 *   report). `props` are registered as super-props before the first event leaves.
 * @returns {{ enabled:boolean, capture:typeof capture, register:typeof register }}
 */
export function initAnalytics(opts = {}) {
  if (inited) return api();
  inited = true;
  debug = !!opts.debug || param('ph_debug') === '1';
  enabled = typeof opts.enabled === 'boolean' ? opts.enabled : shouldEnable();

  // The role rides EVERY event, including the ones fired before the fork (a `?robot=` deep link
  // has no role at all), so segmenting the funnel never needs a join back to a lead record.
  const roleId = getRoleId();
  if (roleId) superProps.role = roleId;
  if (opts.props && typeof opts.props === 'object') Object.assign(superProps, opts.props);
  onRoleChange((role) => setRoleProp(role ? role.id : null));

  if (!enabled) {
    if (debug) console.info('[analytics] reporting off for this host');
    return api();
  }
  loadPostHog();
  return api();
}

function api() {
  return { enabled, capture, register };
}

/** @returns {boolean} whether events are being reported at all */
export function isEnabled() {
  return enabled && !failed;
}

/** @returns {boolean} whether the library is up and events are leaving immediately */
export function isReady() {
  return ready && !failed;
}

/** The raw posthog handle for anything this module does not wrap (feature flags, surveys). */
export function posthogClient() {
  return isReady() ? client() : null;
}

/**
 * Add super-props to every subsequent event, including queued ones.
 * @param {object} props
 */
export function register(props) {
  if (!props || typeof props !== 'object') return;
  Object.assign(superProps, props);
  const ph = client();
  if (ph && typeof ph.register === 'function') {
    try {
      ph.register(props);
    } catch (_) {
      /* a library mid-teardown is not worth a thrown call site */
    }
  }
}

/**
 * The role super-prop. Called for you by `initAnalytics` and by role.js's change notification, so
 * a start-screen tap segments every event that follows it without any screen doing the wiring.
 *
 * @param {string|null} roleId
 */
export function setRoleProp(roleId) {
  if (roleId) register({ role: roleId });
  else {
    delete superProps.role;
    const ph = client();
    if (ph && typeof ph.unregister === 'function') {
      try {
        ph.unregister('role');
      } catch (_) {
        /* already gone */
      }
    }
  }
}

/**
 * Capture one event. Never throws, never blocks, and is safe before `initAnalytics` (the module
 * boots itself with defaults rather than dropping the event, because the first thing a visitor
 * does can easily beat an explicit init).
 *
 * @param {string} event one of EVENTS, or an ad-hoc name
 * @param {object} [props]
 */
export function capture(event, props = {}) {
  if (!event) return;
  if (!inited) initAnalytics();
  if (!enabled || failed) return;
  const payload = { ...superProps, ...props, ms_since_land: msSinceLand() };
  const ph = ready ? client() : null;
  if (ph) {
    try {
      ph.capture(event, payload);
    } catch (err) {
      if (debug) console.warn('[analytics] capture failed for', event, err);
    }
    return;
  }
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ event, props: payload, at: new Date() });
}

/**
 * The lead. Identifying by email is what turns an anonymous funnel into a person, and it is the
 * only place this demo ever creates a person profile.
 *
 * @param {string} email
 * @param {object} [props] set on the person, e.g. { role, robot, src }
 */
export function identifyLead(email, props = {}) {
  if (!inited) initAnalytics();
  if (!enabled || failed || !email) return;
  const ph = client();
  if (!ph || typeof ph.identify !== 'function') return;
  try {
    ph.identify(email, { email, ...superProps, ...props });
  } catch (err) {
    if (debug) console.warn('[analytics] identify failed', err);
  }
}

/**
 * The funnel calls, with their property contracts baked in. Call sites should use these rather
 * than `capture(EVENTS.X, …)` so a property is named the same way at every call site.
 */
export const track = {
  /** @param {string|{id:string,mission?:string}} role @param {object} [extra] */
  roleSelected(role, extra = {}) {
    const id = role && typeof role === 'object' ? role.id : role;
    const mission = role && typeof role === 'object' ? role.mission : undefined;
    capture(EVENTS.ROLE_SELECTED, { role: id, mission, ...extra });
  },

  /** @param {string} robot @param {object} [extra] */
  briefViewed(robot, extra = {}) {
    capture(EVENTS.BRIEF_VIEWED, { robot, ...extra });
  },

  /** Beat 2 actually started streaming on screen. @param {string} robot @param {object} [extra] */
  oldwaySeen(robot, extra = {}) {
    capture(EVENTS.OLDWAY_SEEN, { robot, ...extra });
  },

  /** The scripted first answer finished typing. @param {string} robot @param {object} [extra] */
  firstAnswerSettled(robot, extra = {}) {
    capture(EVENTS.FIRST_ANSWER_SETTLED, { robot, ...extra });
  },

  /** The one chip the demo fires for the visitor. @param {string} robot @param {string} finding */
  evidenceAutoPlayed(robot, finding, extra = {}) {
    capture(EVENTS.EVIDENCE_AUTO_PLAYED, { robot, finding, ...extra });
  },

  /**
   * THE aha. Carries the time-to-aha measure on the first one of the session, so the funnel can
   * be read without a session-level join.
   *
   * @param {string} robot @param {string} finding @param {object} [extra]
   */
  evidenceUserClicked(robot, finding, extra = {}) {
    const first = !ahaFired;
    ahaFired = true;
    capture(EVENTS.EVIDENCE_USER_CLICKED, {
      robot,
      finding,
      first_aha: first,
      ...(first ? { ms_to_aha: msSinceLand() } : {}),
      ...extra,
    });
  },

  /**
   * The brief's incumbent-tool mock actually started streaming on screen, which is the round-2
   * successor to `oldway_seen` on the three guided missions. Same shape, different centrepiece:
   * `mock` is the family (arduino|viz|fleet|inbox), so the drop-off can be read per chrome.
   *
   * @param {string} robot @param {{mock?:string, synthesized?:boolean, sampled?:boolean}} [extra]
   */
  mockViewed(robot, extra = {}) {
    capture(EVENTS.MOCK_VIEWED, { robot, ...extra });
  },

  /**
   * A choreography beat came on screen. `beat` is the def's own stable beat id (answer|chart|
   * replay) and never a position, so re-ordering the walk does not rewrite history. The role rides
   * every event as a super-prop already; it is repeated here so the beat funnel reads on its own.
   *
   * @param {string} robot @param {{beat:string, role?:string|null, step?:number}} extra
   */
  beatShown(robot, extra = {}) {
    capture(EVENTS.BEAT_SHOWN, { robot, ...extra });
  },

  /**
   * The visitor tapped the beat's CTA. This is the engagement measure the guided flow lives or
   * dies on: `beat_shown` minus `beat_cta_clicked` per beat is exactly where the walk loses people.
   *
   * @param {string} robot @param {{beat:string, role?:string|null, step?:number}} extra
   */
  beatCtaClicked(robot, extra = {}) {
    capture(EVENTS.BEAT_CTA_CLICKED, { robot, ...extra });
  },

  /** @param {string} robot @param {{source?:string, length?:number}} [extra] source: chip|composer */
  questionAsked(robot, extra = {}) {
    capture(EVENTS.QUESTION_ASKED, { robot, ...extra });
  },

  /** @param {string} robot @param {string} [trigger] which arming signal earned the impression */
  popupShown(robot, trigger, extra = {}) {
    capture(EVENTS.POPUP_SHOWN, { robot, trigger, ...extra });
  },

  /**
   * @param {string} robot @param {{email?:string, src?:string, dwell_ms?:number}} [extra]
   *   the email is used to identify the person and is NOT sent as an event property.
   */
  leadSubmitted(robot, extra = {}) {
    const { email, ...rest } = extra || {};
    if (email) identifyLead(email, { robot, ...rest });
    capture(EVENTS.LEAD_SUBMITTED, { robot, ...rest });
  },
};

/** Stop reporting from this browser for good. The QA escape hatch, and the honest opt-out. */
export function optOut() {
  enabled = false;
  queue = [];
  try {
    if (window.localStorage) window.localStorage.setItem(OPTOUT_KEY, 'off');
  } catch (_) {
    /* nothing to persist to; the flag above still holds for this page */
  }
  const ph = client();
  if (ph && typeof ph.opt_out_capturing === 'function') {
    try {
      ph.opt_out_capturing();
    } catch (_) {
      /* library not up */
    }
  }
}
