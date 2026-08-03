// context.js - the connect screen's mission brief. Replaces the faux ingest terminal with the
// screen that actually does the selling: a product-shot hero of the machine beside a staged brief
// that says what the robot is, what the mission was, what broke, how much raw data that is, and
// what the analyst is about to be handed. It ends on one button.
//
// The hero is the robot's REAL buildScene() rig, posed at a healthy moment and orbited by the
// camera, on its own transparent WebGLRenderer inside `.ctx-fly`. The SVG ghost stays in the DOM as
// the instant placeholder, the no-WebGL fallback and the context-loss fallback: it only fades once
// this screen has actually painted a frame.
//
// The entrance is the other half of the trick. The picker hands over where the clicked card's art
// was on screen and where that card's camera had orbited to (app.js's heroHandoff), and this screen
// opens with the hero drawn at the card's on-screen size and position, then flies it into the panel.
// `.ctx-fly` is the ONLY thing that moves: the canvas is sized once, to the final hero rect, so the
// entrance is a pure transform and never a resize. `.ctx-stage` must never clip.
//
// Same factory contract as the module it replaces: (mount, def, opts) => { el, skip, dispose },
// with opts.onDone advancing the router. Nothing here owns a timer and nothing auto-advances: the
// screen waits for the user.
//
// THREE BEATS, in this order, and the order is the argument:
//   1. the problem   - what this machine is, what the mission was, what broke      (data-stage 1)
//   2. the old way   - the raw feed, scrolling past unreadably, and what it costs  (data-stage 2)
//   3. the ask       - the charge, then the robot's own first question as a pill   (data-stage 3/4)
// Beat 2 is the one that makes beat 3 land: an answer with a citation is only impressive next to
// the evening in a serial monitor it replaces. core/oldway.js owns that panel.
//
// ---------------------------------------------------------------------------------------------
// BRIEF v2, for the GUIDED missions only (role.js's `isGuidedMission`, which is exactly the set of
// missions the four role cards lead into). Round 1's brief said everything it knew: a system line, a
// provenance line, a mission paragraph, a fault paragraph, a wall, a volume line, a charge and a
// pill. Read end to end that is six paragraphs before the visitor has seen a single thing happen.
//
// So on a guided mission the brief keeps its job and loses its furniture:
//   * the CENTREPIECE is a full-bleed mock of the incumbent tool THIS ROLE is actually handed
//     (core/mocks/*), streaming the mission's own channels. It replaces the old-way wall, it is the
//     whole "raw tooling is not enough" beat, and it is the only thing on the screen doing anything.
//   * the 3D hero is demoted to a corner presence beside the copy. The card-to-hero fly-in is
//     UNCHANGED: the entrance is solved from the stage's own rect, so a small stage flies exactly
//     the same way a big one did, and the no-hand-off path (a direct URL, reduced motion) still
//     settles in place.
//   * the copy is ONE short system line, the honesty line where a mission has one, and the composer
//     pill. The mission and fault paragraphs, the volume line and the old-way wall are GONE from
//     here: contextualisation is beat 1 of the demo's own choreography now, said by the analyst.
//
// Everything else - rescue, donna, arm6, drone, and every generated demo - takes the identical code
// path it took yesterday, down to the markup order and the events fired.

import * as THREE from 'three';
import { ROBOT_ICONS } from '../robots/index.js';
import { createOldWay } from './oldway.js';
import { track, capture } from './analytics.js';
import { effectiveRole, isGuidedMission } from './role.js';
// The staging solve (WebGL probe, light rig, hero pose, orbit-safe fit) is shared with the picker
// cards' previews, so it lives in stage3d.js and both screens frame the same rigs the same way.
import {
  webglAvailable,
  addStageLights,
  fitOrbit,
  heroTime,
  PICKER_ORBIT_MS,
  easeOutCubic,
} from './stage3d.js';
import { clamp, lerp, smoothstep } from './prng.js';

const HERO_FOV = 34; // same as the picker cards, so a hand-off needs no tan() correction
const HERO_FILL = 0.68; // share of the panel height the machine occupies. Looser than a card's 0.78
const MAX_DPR = 2; // same ceiling as viewer.js, chart.js and preview.js
const HERO_ORBIT_MS = 30000; // one revolution once settled: half the picker's speed, on a big panel
const RATE_HERO = (Math.PI * 2) / HERO_ORBIT_MS; // rad per ms
const RAMP_MS = 2400; // card orbit speed -> hero orbit speed
const FLY_MS = 700; // the card-to-hero entrance
const SETTLE_AT = 380; // ms into the fly when the panel's backdrop starts fading in
const MAX_DT = 64; // clamp the integrator's step: a stalled tab must not fling the orbit
const ELEV_EPS = 0.02; // rad: below this the hand-off elevation is the hero's, so nothing to lerp

/** Fallback line art for a robot with no registry icon (generated robots, stubs). Same grammar as
 * ROBOT_ICONS: viewBox "0 0 96 64", strokes inherit currentColor, `.acc` strokes the accent.
 * Exported because app.js stands the same machine in the same panel while a generated def is still
 * being fetched, and a second copy of the path data would drift from this one. */
export const GENERIC_ICON = `<rect x="22" y="34" width="52" height="18" rx="3"/><circle cx="34" cy="52" r="5"/><circle cx="62" cy="52" r="5"/><path d="M27 52h42" class="acc"/><path d="M48 34V18"/><rect x="40" y="8" width="16" height="10" rx="2" class="acc"/><path d="M56 13h6" class="acc"/><path d="M8 59h80"/>`;

/**
 * sessionStorage key prefix for "this tab has already read this mission's brief".
 *
 * The brief is a first-visit screen, not a toll booth. It writes the flag itself, on mount, and
 * app.js's `?robot=` deep link reads it: a link out of a DM lands on the brief once, and every
 * later entry on the same tab goes straight to the demo. SESSION storage on purpose - a new tab is
 * a new visitor as far as this screen is concerned, and a returning one has forgotten the brief
 * anyway.
 */
export const BRIEF_SEEN_PREFIX = 'alloy_brief_seen_';

/** @param {string} id robot id @returns {boolean} */
export function briefSeen(id) {
  if (!id) return false;
  try {
    return window.sessionStorage.getItem(BRIEF_SEEN_PREFIX + id) === '1';
  } catch (_) {
    // Safari private mode throws on ACCESS, not just on write. No flag means "show the brief",
    // which is the safe answer either way.
    return false;
  }
}

/** @param {string} id robot id */
function markBriefSeen(id) {
  if (!id) return;
  try {
    window.sessionStorage.setItem(BRIEF_SEEN_PREFIX + id, '1');
  } catch (_) {
    /* storage unreachable: the brief simply shows again, which is not a failure */
  }
}

/**
 * The mock families, behind a dynamic import each.
 *
 * A visitor is one role and therefore sees exactly one of these, so the other three have no
 * business in the boot graph: the brief is the screen whose whole job is to be instant. The wrapper
 * that holds the panel is sized in CSS, so the layout is final before the module lands and the
 * hero's entrance is never measured against a rect the mock is about to change.
 *
 * A rejection is swallowed to a warning, exactly as the lazy role-openers are: a side module that
 * will not load costs the brief its centrepiece, never the screen.
 */
const MOCK_LOADERS = {
  arduino: () => import('./mocks/arduino.js'),
  viz: () => import('./mocks/viz.js'),
  fleet: () => import('./mocks/fleet.js'),
  inbox: () => import('./mocks/inbox.js'),
};

/** The family a role with no `mock` block falls back to. Every shipped role has one. */
const DEFAULT_MOCK_FAMILY = 'arduino';

/** Per-stage reveal delay, ms. Read into `--d` on each staged child. */
const STAGE_DELAY = { 1: 260, 2: 520, 3: 780, 4: 1020 };
/** Added to every stage delay when a fly runs, so the copy lands as the machine settles. */
const FLY_STAGE_DELAY = 450;

const num = (v) => (Number.isFinite(v) ? v : 0);
const loc = (v) => num(v).toLocaleString('en-US');

/**
 * The first sentence of a paragraph, or the whole thing when it has no terminator.
 *
 * The guided brief gets ONE system line, and `context.system` is authored to brief an analyst: the
 * battle round's runs to four clauses about a rules manual. Its first sentence is the one that says
 * what the machine is, which is all this screen still claims to say.
 */
function firstSentence(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  const m = t.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : t).trim();
}

/** Capitalise, and terminate with a period unless it already ends in terminal punctuation. */
function sentence(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  const head = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : head + '.';
}

/**
 * Row counts read off the arrays the robot actually shipped, never asserted from `rate`.
 *
 * A def whose channels are derived from a LAZILY loaded scene payload counts nothing at all, and
 * the rule is unconditional rather than "count whatever happens to be in `def.data`". The brief is
 * the same screen wherever the visitor reaches it from, and `def.data` is a CACHE: it is empty on a
 * cold entry (app.js's ensureData refuses to build it here) and populated after a visit to the
 * demo, so counting it made the brief say "37,043 raw datapoints" or nothing at all depending on
 * navigation history. Such a def authors its `context` in full, so the authored copy is the whole
 * brief either way and nothing on screen goes missing.
 */
function statsOf(def) {
  const lazy = typeof def.loadSceneData === 'function';
  const data = lazy ? {} : def.data || {};
  const channels = Array.isArray(def.channels) ? def.channels : [];
  const paths = [];
  let samples = 0;
  let values = 0;
  channels.forEach((c) => {
    if (!c) return;
    if (c.path) paths.push(c.path);
    const ch = data[c.path];
    const rows = ch && ch.t && ch.t.length ? ch.t.length : 0;
    const fields = Array.isArray(c.fields) ? c.fields.length : 0;
    samples += rows;
    values += rows * fields;
  });
  return { count: channels.length, paths, samples, values };
}

/**
 * Everything the copy needs, with a fallback for every field. `def.context` is authored per robot
 * and wins wherever it exists; generated robots ship without one, and their findings may lack a
 * severity or a `t`, so nothing below assumes either.
 */
function briefOf(def) {
  const ctx = def.context || {};
  const st = statsOf(def);
  const duration = num(def.duration);
  const rate = Number.isFinite(def.rate) ? Math.round(def.rate) : null;

  const findings = Array.isArray(def.findings) ? def.findings : [];
  const alert = findings.find((f) => f && f.severity === 'alert') || findings[0] || null;

  let faultT = ctx.faultT;
  if (faultT == null) {
    if (alert && Number.isFinite(alert.t)) faultT = alert.t;
    else if (alert && Array.isArray(alert.window) && Number.isFinite(alert.window[0])) faultT = alert.window[0];
    else faultT = null;
  }
  if (!Number.isFinite(faultT)) faultT = null;

  // Derived fallbacks never render a zero: "0 channels" / "0 samples" undersells the product, so a
  // clause with nothing to count is dropped rather than printed (same rule the stats strip follows).
  let system = ctx.system;
  if (!system) {
    const head = def.device ? sentence(def.device) + ' ' : '';
    if (st.count > 0) {
      const shown = st.paths.slice(0, 3).join(', ');
      const tail = st.paths.length ? ` (${shown}${st.paths.length > 3 ? ', …' : ''})` : '';
      const logged = rate != null ? `logged at ${rate} Hz` : 'logged';
      system = `${head}${st.count} ${st.count === 1 ? 'channel' : 'channels'} ${logged}${tail}.`;
    } else {
      system = head.trim();
    }
  }

  let mission = ctx.mission;
  if (!mission) {
    const tag = def.tagline ? sentence(def.tagline) + ' ' : '';
    const bits = [];
    if (duration > 0) bits.push(`${duration.toFixed(1)} s of mission`);
    if (st.samples > 0) bits.push(`${loc(st.samples)} samples on the wire`);
    mission = `${tag}${bits.length ? sentence(bits.join(', ')) : ''}`.trim();
  }

  let fault = ctx.fault;
  if (!fault) {
    // same guard as the label fallback below: a finding with no title is no better than no finding
    fault =
      alert && alert.title
        ? sentence(alert.title) + (faultT != null ? ` First visible at T+${faultT.toFixed(1)} s.` : '')
        : 'Something in this mission went wrong. The logs are all you get.';
  }

  const label = ctx.label || (alert && alert.title ? alert.title : 'anomaly');

  // THE VOLUME LINE IS AUTHORED, NOT COUNTED. `statsOf` walks whatever arrays happen to be attached
  // to the def right now, and for the three missions whose channels come from a lazy scene payload
  // that is deliberately nothing at all on this screen: the brief printed no volume line for them
  // on a cold entry and a full one after a visit to the demo, purely as a function of navigation
  // history. Every def now carries the real count in `context.datapoints` / `context.channels`
  // (computed offline against the same generators), so the number is the same sentence wherever the
  // visitor reaches this screen from. The counted values remain the fallback for a GENERATED demo,
  // which has no authored context and whose telemetry is always built before this screen opens.
  const datapoints =
    Number.isFinite(ctx.datapoints) && ctx.datapoints > 0 ? Math.round(ctx.datapoints) : st.values;
  const channelCount =
    Number.isFinite(ctx.channels) && ctx.channels > 0 ? Math.round(ctx.channels) : st.count;

  return {
    dev: def.deviceId || def.id || 'device',
    name: def.name || 'Robot',
    system,
    // OPTIONAL and never derived: where a mission's data comes from, and which parts of it are
    // synthesized. Only a def that has something to disclose ships it, and it is rendered
    // verbatim under the system line. No fallback: an invented provenance line is worse than none.
    provenance: typeof ctx.provenance === 'string' ? ctx.provenance.trim() : '',
    mission,
    fault,
    faultT,
    label,
    duration,
    rate,
    question: def.firstQuestion || '',
    ...st,
    // after the spread: these two are the authored counts and must win over statsOf's `values`/
    // `count`, which are still what the system and mission fallbacks above read
    datapoints,
    channelCount,
  };
}

/**
 * Sanitise app.js's hand-off record. Anything missing or nonsensical degrades to the no-hand-off
 * path (a plain settle), because a wrong rect is worse than no entrance at all.
 *
 * @param {object|null} h
 * @returns {{rect:{x:number,y:number,w:number,h:number}, ghost:{w:number,h:number}|null,
 *   live:boolean, phase:{az:number,elev:number,dist:number}|null}|null}
 */
function normaliseHandoff(h) {
  if (!h || !h.rect) return null;
  const r = h.rect;
  if (!(r.w > 8) || !(r.h > 8) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  const p = h.phase;
  const phase =
    p && Number.isFinite(p.az) && Number.isFinite(p.dist) && p.dist > 1e-4
      ? { az: p.az, elev: Number.isFinite(p.elev) ? p.elev : null, dist: p.dist }
      : null;
  const ghost = h.ghost && h.ghost.h > 4 ? { w: h.ghost.w, h: h.ghost.h } : null;
  return { rect: r, ghost, live: !!h.live, phase };
}

/**
 * @param {HTMLElement} mount container (#ingest-mount)
 * @param {object} robotDef with `.data` attached
 * @param {{ onDone?: ()=>void, handoff?: object|null }} opts `handoff` is app.js's record of the
 *   picker card that was clicked: its on-screen rect, whether its preview was live, and where that
 *   preview's camera had orbited to. Absent on a direct URL load.
 * @returns {{ el:HTMLElement, skip:()=>void, dispose:()=>void }}
 */
export function createContext(mount, robotDef, opts = {}) {
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : () => {};
  const def = robotDef || {};
  const b = briefOf(def);
  // The guided missions are exactly the missions the role cards lead into, so this is one question
  // asked of role.js rather than a second list of robot ids that could drift from the first.
  const guided = isGuidedMission(def.id);
  const role = effectiveRole();
  const mockFamily =
    (guided && role.mock && MOCK_LOADERS[role.mock.family] ? role.mock.family : null) ||
    (guided ? DEFAULT_MOCK_FAMILY : null);
  const handoff = normaliseHandoff(opts.handoff);
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A fly starts UNDRESSED (no backdrop, no border, no skip pill) and the dressing fades in as the
  // machine lands. That state must be the panel's INITIAL style, baked into the markup: adding
  // `entering` after mount races the browser's style flushes, and the .32s opacity transitions then
  // play 1 -> 0 as a visible flash-and-fade on the first frames of the entrance.
  const mayEnter = !!(handoff && !reduceMotion);

  const el = document.createElement('div');
  el.className = guided ? 'ctx is-guided' : 'ctx';
  el.style.setProperty('--acc', def.accent || '#2f78ff');

  // Nothing is ever rendered as a zero: a robot that shipped no rows gets no volume line at all,
  // because "0 datapoints" undersells the product instead of selling it. On a guided brief all
  // three are off outright: those paragraphs are beat 1 of the demo now, in the analyst's voice.
  const hasVolume = !guided && b.datapoints > 0 && b.channelCount > 0;
  const hasMission = !guided && !!b.mission;
  const hasFault = !guided && !!b.fault;

  // The hero panel. Identical markup in both briefs, so the entrance solves against the same three
  // nodes; only its box changes, and its box is CSS. The skip pill is the one difference: a guided
  // brief is two lines and a pill, so a control whose whole job is "there is more of this below"
  // would be furniture arguing with the declutter.
  const stageHtml = `
    <div class="ctx-stage${mayEnter ? ' entering' : ''}">
      <div class="ctx-fly">
        <svg class="ctx-ghost" style="opacity:0" viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          ${ROBOT_ICONS[def.id] || GENERIC_ICON}
        </svg>
      </div>
      ${guided ? '' : '<button class="ctx-skip mono" type="button">skip to the demo &rsaquo;</button>'}
    </div>`;

  // The pill IS the CTA wherever the def ships a first question; a plain button otherwise. Its
  // stage number differs between the two briefs only because the guided one has fewer stages.
  const ctaHtml = (stage) =>
    b.question
      ? `<button class="ctx-ask" type="button" data-stage="${stage}">
        <span class="ctx-ask-q"></span>
        <span class="ctx-ask-send" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 12.6V3.6M4.3 7.2 8 3.4l3.7 3.8"/>
          </svg>
        </span>
      </button>`
      : `<button class="btn ctx-go" type="button" data-stage="${stage}">Hand it the logs <span aria-hidden="true">&rarr;</span></button>`;

  el.innerHTML = guided
    ? `
    <div class="ctx-mockwrap" data-stage="1">
      <div class="ctx-mock"></div>
    </div>
    <div class="ctx-foot">
      ${stageHtml}
      <div class="ctx-copy">
        <p class="ctx-system" data-stage="2"></p>
        ${b.provenance ? '<p class="ctx-prov" data-stage="2"></p>' : ''}
        ${ctaHtml(3)}
        <a class="ctx-more mono" data-stage="3" href="#/missions">Other missions <span aria-hidden="true">&rsaquo;</span></a>
      </div>
    </div>`
    : `
    ${stageHtml}
    <div class="ctx-copy">
      <p class="ctx-system" data-stage="1"></p>
      ${b.provenance ? '<p class="ctx-prov" data-stage="1"></p>' : ''}
      ${hasMission ? '<p class="ctx-mission" data-stage="1"></p>' : ''}
      ${hasFault ? '<p class="ctx-fault" data-stage="1"></p>' : ''}
      <div class="ctx-oldway" data-stage="2"></div>
      ${hasVolume ? '<p class="ctx-volume" data-stage="2"></p>' : ''}
      <p class="ctx-charge" data-stage="3">The analyst gets this mission's telemetry and a question. Watch it walk the evidence to the root cause, citing the exact samples that prove it.</p>
      ${ctaHtml(4)}
      <a class="ctx-more mono" data-stage="4" href="#/missions">Other missions <span aria-hidden="true">&rsaquo;</span></a>
    </div>`;

  const q = (sel) => el.querySelector(sel);
  // One short line on a guided brief: what this machine is, and nothing else. The rest of
  // `context.system` is a paragraph written to brief an analyst, and the analyst gets it in beat 1.
  q('.ctx-system').textContent = guided ? firstSentence(b.system) : b.system;
  // The honesty line is NOT decluttered away. It is the sentence that says which parts of this
  // mission are real and which are synthesized overlays, and a screen streaming a mission's own
  // values with that line removed is making a claim it did not mean to make.
  if (b.provenance) q('.ctx-prov').textContent = b.provenance;
  // Verbatim, both of them. `context.mission` and `context.fault` have been authored on every def
  // since the briefs were written and were never once rendered: the screen had the two sentences
  // that say what this robot was doing and what went wrong, and showed neither.
  if (hasMission) q('.ctx-mission').textContent = b.mission;
  if (hasFault) q('.ctx-fault').textContent = b.fault;
  if (hasVolume) {
    q('.ctx-volume').textContent =
      `${loc(b.datapoints)} raw datapoints across ${loc(b.channelCount)} channels. The answer is ` +
      'in there, but it only shows up when you read the channels against each other.';
  }
  if (b.question) {
    q('.ctx-ask-q').textContent = `“${b.question}”`;
    // the send disc has no visible label, so the button carries the whole intent for a screen reader
    q('.ctx-ask').setAttribute('aria-label', `Ask the analyst: ${b.question}`);
  }
  // The send disc is filled with the robot's accent; its arrow must read on top of it. Light
  // accents (arm6's pale green) need dark ink, dark accents need white.
  {
    const acc = (def.accent || '#2f78ff').replace('#', '');
    const n = acc.length === 3 ? acc.split('').map((c) => c + c).join('') : acc;
    const [rr, gg, bb] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) || 0);
    const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    el.style.setProperty('--acc-ink', lum > 168 ? '#10131a' : '#ffffff');
  }

  mount.appendChild(el);

  // Entering from a scrolled picker leaves the document where the picker left it, which both offsets
  // every rect the entrance measures and can open this screen mid-page. Top, before any measurement.
  try {
    window.scrollTo(0, 0);
  } catch (_) {
    /* no scrolling context (jsdom, embedded) */
  }

  // The screen owns a layout mode: the connect body centres a small card by default, and this
  // screen is a full-width two-column brief instead.
  const section = mount.closest('section');
  if (section) section.classList.add('ctx-mode');

  // ---- beat 2. Mounted after the panel is in the document, because the wall starts itself when
  // it is actually on screen (an IntersectionObserver inside the module) and a detached node never
  // intersects anything. It is handed the telemetry only if the telemetry already exists: three
  // missions derive their channels from a payload this screen must not pull in, and those three
  // author a slice of their own values (`context.oldwaySample`) for the module to print instead.
  let oldway = null;
  /** The guided brief's centrepiece. Null until its family module lands, and on a non-guided brief. */
  let mock = null;
  if (!guided) {
    try {
      oldway = createOldWay(q('.ctx-oldway'), def, {
        data: def.data || null,
        onSeen: (info) => {
          // `sampled` rides along so the funnel can tell the authored-slice wall from the built one;
          // `synthesized` stays the flag that means the numbers on screen are stand-ins.
          track.oldwaySeen(def.id, {
            synthesized: !!(info && info.synthesized),
            sampled: !!(info && info.sampled),
          });
        },
      });
    } catch (err) {
      // A missing wall costs the brief one beat. A throw here would cost it the whole screen, and
      // the screen is what sells the product.
      console.warn('[ctx] old-way panel failed for', def.id, err);
      oldway = null;
    }
    // A def with no channels at all (a stub, a half-built generated demo) has nothing to scroll, and
    // an empty terminal frame under a caption about how unreadable it is makes the opposite argument.
    if (!oldway || !oldway.lines || !oldway.lines.length) {
      if (oldway) oldway.dispose();
      oldway = null;
      const slot = q('.ctx-oldway');
      if (slot) slot.remove();
    }
  }

  // This tab has now been told what this mission is, so a later `?robot=` or link back into it
  // goes straight to the demo instead of making the same argument twice.
  markBriefSeen(def.id);
  track.briefViewed(
    def.id,
    guided
      ? { guided: true, mock: mockFamily, role: role.id }
      : { synthetic_wall: !!(oldway && oldway.synthesized) },
  );

  const copy = q('.ctx-copy');
  // the question card is the CTA when the def ships a first question; a plain button otherwise
  const goBtn = q('.ctx-ask') || q('.ctx-go');
  // null on a guided brief, which ships no skip pill
  const skipBtn = q('.ctx-skip');

  let done = false;
  let disposed = false;
  let revealed = false;

  // ---- the guided brief's centrepiece -------------------------------------------------------
  // Loaded after the panel is in the document, for the same reason the old-way wall is: the mock
  // starts itself when it is actually on screen (an IntersectionObserver inside mocks/base.js) and a
  // detached node never intersects anything. Telemetry is passed only if it already exists; the
  // three lazy-payload missions author `context.oldwaySample` and the mock prints that instead. The
  // TRIPWIRE is the same one the wall has: this screen never pulls a robot's scene payload.
  if (guided && mockFamily) {
    MOCK_LOADERS[mockFamily]().then(
      (mod) => {
        if (disposed) return;
        const slot = q('.ctx-mock');
        const create = mod && typeof mod.default === 'function' ? mod.default : null;
        try {
          if (!slot || !create) throw new Error(`mocks/${mockFamily}.js has no default export`);
          mock = create(slot, def, {
            role,
            data: def.data || null,
            // The role owns the caption because it is a sentence about the visitor's working life;
            // the FAMILY owns the tool label, and the module already defaults to its own.
            caption: (role.mock && role.mock.caption) || '',
            onSeen: (info) => {
              // Fired when the panel has actually started streaming on screen, which is the only
              // honest moment to count it as viewed. `synthesized` is the flag that means the
              // numbers are stand-ins in this mission's own format.
              capture('mock_viewed', {
                robot: def.id,
                mock: (info && info.family) || mockFamily,
                role: (info && info.role) || role.id,
                synthesized: !!(info && info.synthesized),
                sampled: !!(info && info.sampled),
              });
            },
          });
        } catch (err) {
          console.warn('[ctx] mock panel failed for', def.id, err);
          mock = null;
        }
        // Same rule as the wall: a def with nothing to print gets no empty frame, because an empty
        // tool under a screen arguing that the tool is overwhelming makes the opposite point.
        if (mock && (!mock.lines || !mock.lines.length)) {
          mock.dispose();
          mock = null;
        }
        if (!mock) {
          const wrap = el.querySelector('.ctx-mockwrap');
          if (wrap) wrap.remove();
        }
      },
      (err) => {
        // Swallowed to a warning, exactly like the lazy role openers: a side module that will not
        // load costs the brief its centrepiece, never the screen.
        console.warn('[ctx] mock family unavailable:', mockFamily, err);
        const wrap = el.querySelector('.ctx-mockwrap');
        if (wrap) wrap.remove();
      },
    );
  }

  // app.js's route() sets its own connect-screen title AFTER buildConnect returns, so writing it
  // here synchronously would just be overwritten. A microtask lands once route() has finished its
  // synchronous work. dispose() deliberately does NOT restore it: every route sets its own title.
  queueMicrotask(() => {
    if (!disposed) document.title = `${b.name} · mission brief · AlloyLogger`;
  });

  /** Land every stage immediately, WITHOUT navigating. The impatient-reader affordance. */
  function revealAll() {
    if (revealed) return;
    revealed = true;
    el.classList.add('revealed');
  }

  /** Hand off to the demo. Exactly once, ever. */
  function advance() {
    if (done || disposed) return;
    done = true;
    onDone();
  }

  function onCopyClick(e) {
    // the CTA and the missions link are inside .ctx-copy: let them navigate instead of only
    // revealing the copy they are about to leave
    if (e.target && e.target.closest && e.target.closest('.ctx-ask, .ctx-go, .ctx-more')) return;
    revealAll();
  }

  /**
   * The stagger lives in CSS; JS only hands each stage its delay. Called once the entrance mode is
   * known, because a fly pushes the whole brief back so the copy lands as the machine settles.
   *
   * @param {number} offset ms added to every stage
   */
  function setStageDelays(offset) {
    el.querySelectorAll('[data-stage]').forEach((node) => {
      const d = STAGE_DELAY[node.dataset.stage];
      node.style.setProperty('--d', (d == null ? 0 : d) + offset + 'ms');
    });
  }

  // The pointer path only: click-to-reveal is a shortcut, and the CTA (a real button, in tab order)
  // is the keyboard path, so the panel itself is not a focus stop.
  copy.addEventListener('click', onCopyClick);
  goBtn.addEventListener('click', advance);
  if (skipBtn) skipBtn.addEventListener('click', advance);

  // ============================================================== the live 3D hero + its entrance
  const stage = q('.ctx-stage');
  const flyEl = q('.ctx-fly');
  const ghostEl = q('.ctx-ghost');

  let renderer = null;
  let canvas = null;
  let scene = null;
  let group = null;
  let api = null;
  let camera = null;
  let fit = null; // { target, dist, elev, az0 } from the orbit-safe solve
  let ro = null;
  let raf = 0;
  let last = 0;
  let orbitStart = 0;
  let needsRender = true; // the reduced-motion path renders only when something actually changed
  let contextLost = false;
  let painted = false;
  let sizedW = 0;
  let sizedH = 0;
  let sizedAspect = 0;
  let pendingRefit = false;
  // orbit integrator: az is advanced by the frame's own dt, never derived from wall-clock elapsed,
  // so a hidden tab or a slow first frame cannot teleport the camera
  let az = 0;
  let rate0 = 0;
  // entrance
  let entranceMode = 'none'; // 'exact' | 'ghost' | 'none'
  let entranceScale = 1; // the fly's starting scale, kept for QA assertions
  let flying = false;
  let flyRaf = 0;
  let flyP = 1; // eased progress, 1 = at rest
  let elevFrom = null; // the hand-off's elevation, when it differs enough to be worth lerping

  function dropSceneGraph() {
    try {
      if (api && typeof api.dispose === 'function') api.dispose();
    } catch (_) {
      /* a rig that failed mid-build has nothing to release */
    }
    if (scene) {
      try {
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => m && m.dispose && m.dispose());
          }
        });
      } catch (_) {
        /* partially built graph */
      }
    }
    scene = null;
    group = null;
    api = null;
  }

  function onContextLost(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    contextLost = true;
    // hand the panel back to the SVG ghost, the same fallback the no-WebGL path uses, instead of
    // leaving an empty product shot. The mount pinned the ghost at inline opacity 0; hand control
    // back to the class rules so it crossfades in now and back out after a restore.
    if (ghostEl) ghostEl.style.opacity = '';
    stage.classList.remove('live');
  }

  function onContextRestored() {
    contextLost = false;
    sizedW = 0;
    sizedH = 0;
    needsRender = true;
    last = 0;
  }

  function onVisibility() {
    last = 0;
    needsRender = true;
  }

  /**
   * Re-solve the framing for a new panel aspect. fitOrbit MUTATES the rig (scenery is hidden by
   * flipping `visible`), and it is idempotent because both its passes skip anything already
   * invisible: a second call sees the same visible subject and only re-solves target/dist/elev.
   * az is deliberately NOT re-seeded from az0, or a resize mid-orbit would snap the camera.
   */
  function refit(aspect) {
    if (!group) return;
    const a = aspect > 0 ? aspect : 1;
    // Same per-def framing overrides the picker cards use (`def.preview`), so a robot is culled
    // and centred identically in both stages and the card-to-hero hand-off stays a pure scale.
    // A def without the block gets fitOrbit's own defaults, which is what every def without a
    // `previewData` payload has always been framed with.
    const ov = def.preview || {};
    const next = fitOrbit({
      mount: group,
      api,
      fov: HERO_FOV,
      fill: HERO_FILL,
      aspect: a,
      ...(Number.isFinite(ov.distScale) ? { distScale: ov.distScale } : {}),
      ...(Number.isFinite(ov.envCull) ? { envCull: ov.envCull } : {}),
      ...(Number.isFinite(ov.envRadius) ? { envRadius: ov.envRadius } : {}),
      ...(ov.focus ? { focus: ov.focus } : {}),
    });
    sizedAspect = a;
    if (!fit) fit = next;
    else {
      fit.target.copy(next.target);
      fit.dist = next.dist;
      fit.elev = next.elev;
    }
    needsRender = true;
  }

  /**
   * Size the drawing buffer to the panel. Guarded on the INTEGER size the canvas was last sized to
   * (preview.js's discipline): setSize reallocates and clears, so a half-pixel rounding difference
   * must not re-trigger it every frame.
   */
  function sizeStage() {
    if (!renderer || !camera) return;
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === sizedW && h === sizedH) return;
    sizedW = w;
    sizedH = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    needsRender = true;
    if (!fit) {
      refit(aspect);
      return;
    }
    if (Math.abs(aspect - sizedAspect) < 1e-3) return;
    // a refit moves target/dist, which would jolt a hero mid-flight: hold it until the fly lands
    if (flying) pendingRefit = true;
    else refit(aspect);
  }

  /** Spherical placement around the fit target. The orbit only ever changes az. */
  function placeCamera() {
    const elev =
      elevFrom != null && flyP < 1 ? lerp(elevFrom, fit.elev, flyP) : fit.elev;
    const ce = Math.cos(elev);
    camera.position.set(
      fit.target.x + fit.dist * ce * Math.cos(az),
      fit.target.y + fit.dist * Math.sin(elev),
      fit.target.z + fit.dist * ce * Math.sin(az)
    );
    camera.lookAt(fit.target);
  }

  function draw() {
    sizeStage();
    if (!fit) return;
    placeCamera();
    renderer.render(scene, camera);
    painted = true;
    // The frame is on screen, so the ghost can go: it crossfades out from under the 3D. Checked
    // every frame rather than only once, because a context loss puts the ghost BACK and the first
    // frame after a restore has to take it away again.
    if (!stage.classList.contains('live')) stage.classList.add('live');
  }

  function frame(now) {
    if (disposed) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
    if (!renderer || contextLost || document.hidden || !fit) {
      last = 0;
      return;
    }
    const dt = last ? Math.min(now - last, MAX_DT) : 0;
    last = now;
    if (reduceMotion) {
      if (!needsRender) return;
      needsRender = false;
      draw();
      return;
    }
    if (!orbitStart) orbitStart = now;
    // ramp the RATE, not the angle: the camera leaves the card at the card's own angular speed and
    // eases into the hero's, so there is no velocity step at the hand-off
    const w = rate0 + (RATE_HERO - rate0) * smoothstep((now - orbitStart) / RAMP_MS);
    az += w * dt;
    needsRender = false;
    draw();
  }

  /**
   * Build the hero rig, then its renderer. In that order, deliberately: a robot whose buildScene
   * throws must not leave a live WebGL context behind, because this page runs under a one-context
   * rule (the picker's previews are disposed before this screen builds, and this is disposed before
   * the demo viewer opens its own).
   *
   * @returns {boolean} whether there is a live 3D hero
   */
  function buildHero() {
    if (!webglAvailable() || typeof def.buildScene !== 'function') return false;
    // Same rule as the picker: a scene driven by its own payload cannot be posed without one, and
    // a decode failure leaves `getSceneData()` empty. Fall through to the SVG hero rather than
    // mounting a rig with nothing in it.
    if (typeof def.getSceneData === 'function' && !def.getSceneData()) return false;
    try {
      scene = new THREE.Scene();
      scene.background = null; // transparent: the panel's own backdrop shows through
      addStageLights(scene);
      group = new THREE.Group();
      group.name = `hero-${def.id}`;
      scene.add(group);
      api = def.buildScene(THREE, group) || {};
      // Same rule as the picker: a scene driven by its own payload gets that, everything else gets
      // the telemetry. `def.data` is deliberately not built for a def with a lazy scene payload.
      if (typeof api.update === 'function') {
        api.update(
          heroTime(def),
          (typeof def.getSceneData === 'function' ? def.getSceneData() : null) || def.data || {},
        );
      }
      if (typeof api.setHighlight === 'function') api.setHighlight(null);
    } catch (err) {
      console.warn('[ctx] hero scene build failed for', def.id, err);
      dropSceneGraph();
      return false;
    }
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      console.warn('[ctx] hero renderer unavailable', err);
      renderer = null;
    }
    if (!renderer) {
      dropSceneGraph();
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = false;
    canvas = renderer.domElement;
    canvas.className = 'ctx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    // inside .ctx-fly, next to the ghost: the entrance moves canvas and ghost as one thing
    flyEl.appendChild(canvas);
    camera = new THREE.PerspectiveCamera(HERO_FOV, 1, 0.05, 400);
    sizeStage(); // sizes the buffer AND runs the first fit
    // An unusable solve is worse than no 3D: a NaN target or a zero distance puts the camera inside
    // the machine or nowhere at all. Bail to the ghost, which is a correct picture of the robot.
    if (
      !fit ||
      !Number.isFinite(fit.dist) ||
      fit.dist <= 0 ||
      !Number.isFinite(fit.target.x) ||
      !Number.isFinite(fit.target.y) ||
      !Number.isFinite(fit.target.z)
    ) {
      dropHero();
      return false;
    }
    return true;
  }

  /**
   * The card-to-hero entrance.
   *
   * The canvas is already sized to the FINAL hero rect, so the entrance is a transform on
   * `.ctx-fly` and nothing else. Scale is solved from the two shots, not guessed: on-screen subject
   * height is proportional to panelHeight / cameraDistance, and both shots use the same 34 degree
   * FOV, so matching the card means
   *   s * H.height / fit.dist === C.h / phase.dist   ->   s = (C.h / H.height) * (fit.dist / phase.dist)
   * which collapses to the pure rect ratio C.h / H.height when the two distances agree.
   */
  function startEntrance() {
    // The overflow locks go on BEFORE the panel is measured. The fly's transform would otherwise
    // create scrollable overflow, and adding the locks afterwards removes a scrollbar the rect was
    // already measured against, so every offset in the entrance would be a scrollbar-width stale.
    // With the scroll-to-top at mount, this measurement always happens at scrollY 0.
    const mayFly = !!(handoff && !reduceMotion);
    if (mayFly) {
      if (section) section.classList.add('ctx-flying');
      document.body.classList.add('ctx-flying');
    }
    const unlock = () => {
      if (section) section.classList.remove('ctx-flying');
      if (document.body) document.body.classList.remove('ctx-flying');
    };

    const H = stage.getBoundingClientRect();
    if (!(H.width > 8) || !(H.height > 8)) {
      if (mayFly) unlock();
      stage.classList.remove('entering'); // no fly is coming: dress the panel
      return;
    }

    let mode = 'none';
    let s = 1;
    if (handoff && !reduceMotion) {
      const C = handoff.rect;
      if (fit && handoff.live && handoff.phase) {
        mode = 'exact';
        s = (C.h / H.height) * (fit.dist / handoff.phase.dist);
        if (handoff.phase.elev != null && Math.abs(handoff.phase.elev - fit.elev) > ELEV_EPS) {
          elevFrom = handoff.phase.elev;
        }
      } else {
        // the card was still showing its line art (or this screen has no 3D at all): match the two
        // ghosts instead of the two cameras
        mode = 'ghost';
        const gr = ghostEl ? ghostEl.getBoundingClientRect() : null;
        s =
          handoff.ghost && gr && gr.height > 4
            ? handoff.ghost.h / gr.height
            : C.h / H.height;
      }
      if (!Number.isFinite(s) || s <= 0) {
        mode = 'none';
        s = 1;
      }
      // The upper bound is the direction the hand-off runs in, and BRIEF v2 reversed it. The full
      // brief's hero is far bigger than a picker card, so the machine only ever flew IN and a ceiling
      // of 1 was free. The guided brief's hero is a 132px corner, which is SMALLER than the card that
      // was clicked, so the honest solve is greater than one and clamping it to 1 replaced the
      // entrance with a pop: the robot shrank instantly, then slid. It is still bounded, because a
      // nonsense solve must not fling the machine across the page; 3 covers every card at both
      // viewports with room to spare. Left at 1 for the full brief, where it never binds anyway.
      s = clamp(s, 0.03, guided ? 3 : 1);
    }
    entranceMode = mode;
    entranceScale = s;

    if (mode === 'none') {
      flyP = 1;
      elevFrom = null;
      rate0 = 0;
      if (mayFly) unlock(); // nothing is going to fly out of the panel: give the scrollbar back
      // no card to fly from: a short scale-and-fade settle instead, and the panel dresses now
      // (fading in if `entering` was baked into the markup for a fly that then bailed)
      stage.classList.remove('entering');
      if (!reduceMotion) flyEl.classList.add('ctx-settle');
      return;
    }

    const C = handoff.rect;
    const dx = C.x + C.w / 2 - (H.left + H.width / 2);
    const dy = C.y + C.h / 2 - (H.top + H.height / 2);
    // a live card was orbiting: leave at ITS angular rate and at ITS angle. Never advance az by the
    // wall-clock gap since the click, which would spin the robot during the screen change.
    rate0 = mode === 'exact' ? (Math.PI * 2) / PICKER_ORBIT_MS : 0;
    if (mode === 'exact' && handoff.phase) az = handoff.phase.az;

    flying = true;
    flyP = 0;
    flyEl.style.willChange = 'transform';
    flyEl.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    // the panel's backdrop and border belong to the panel, not to the flying machine: they fade in
    // as it lands (the overflow locks are already on, from before the measurement above)
    stage.classList.add('entering');

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    flyRaf = requestAnimationFrame(function tick(now) {
      flyRaf = 0;
      if (disposed || !flying) return;
      const raw = clamp((now - t0) / FLY_MS, 0, 1);
      flyP = easeOutCubic(raw);
      if (raw >= 1) {
        endFly();
        return;
      }
      if (raw * FLY_MS >= SETTLE_AT) stage.classList.remove('entering');
      const k = 1 - flyP;
      flyEl.style.transform = `translate(${dx * k}px, ${dy * k}px) scale(${s + (1 - s) * flyP})`;
      needsRender = true;
      flyRaf = requestAnimationFrame(tick);
    });
  }

  /** Land the entrance. Idempotent, and also the teardown path. */
  function endFly() {
    if (flyRaf) cancelAnimationFrame(flyRaf);
    flyRaf = 0;
    flying = false;
    flyP = 1;
    elevFrom = null;
    if (flyEl && flyEl.style) {
      flyEl.style.transform = 'none';
      flyEl.style.willChange = '';
    }
    if (stage) stage.classList.remove('entering');
    if (section) section.classList.remove('ctx-flying');
    if (document.body) document.body.classList.remove('ctx-flying');
    const refitNow = pendingRefit && !disposed;
    pendingRefit = false;
    if (refitNow) refit(sizedH ? sizedW / sizedH : 1);
    needsRender = true;
  }

  function dropHero() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (canvas) {
      try {
        canvas.removeEventListener('webglcontextlost', onContextLost);
        canvas.removeEventListener('webglcontextrestored', onContextRestored);
      } catch (_) {
        /* node already gone */
      }
    }
    dropSceneGraph();
    if (renderer) {
      try {
        renderer.dispose();
        // same discipline as viewer.js and preview.js: dispose() frees GPU objects but leaves the
        // context alive until the detached canvas is collected, and Chrome kills the OLDEST live
        // context once enough accumulate. Release it explicitly.
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      } catch (_) {
        /* already gone */
      }
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    renderer = null;
    canvas = null;
    camera = null;
    fit = null;
  }

  const hasHero = buildHero();
  if (hasHero) {
    az = fit.az0;
    // Paint once, synchronously, before this task ends: the hero must be on screen in the same frame
    // the screen appears, or the entrance starts on an empty panel.
    startEntrance();
    let firstFrame = false;
    try {
      draw();
      firstFrame = true;
    } catch (err) {
      console.warn('[ctx] hero first frame failed', err);
    }
    if (ghostEl && !firstFrame) {
      // Nothing painted: the ghost IS the hero. Clearing the markup's inline opacity:0 hands it to
      // the class rules, which fade it in.
      stage.classList.remove('live');
      ghostEl.style.opacity = '';
    }
    // firstFrame: the ghost keeps the inline opacity:0 it was BORN with. Baked into the markup, not
    // written here, because a style write after the mount's forced layouts only sets a transition
    // ENDPOINT: the browser has already snapshotted 0.85 as the before-change style, and the "pin"
    // renders as a 400 ms line-art fade smeared over the live 3D. As an initial style it cannot
    // animate. onContextLost() clears it so the loss/restore crossfades play via .ctx-stage.live.
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        needsRender = true;
        sizeStage();
      });
      ro.observe(stage);
    } else {
      window.addEventListener('resize', onVisibility);
    }
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(frame);
  } else {
    // no 3D: the ghost is the hero, and it still flies in from the card. Hand it back to the class
    // rules (the markup birthed it at inline opacity 0 in case a hero painted).
    if (ghostEl) ghostEl.style.opacity = '';
    startEntrance();
  }

  // Delays last: a fly owns the first ~450 ms of the screen, so the brief starts landing as the
  // machine settles instead of racing it. No fly (direct load, reduced motion) keeps the base map.
  setStageDelays(entranceMode === 'exact' || entranceMode === 'ghost' ? FLY_STAGE_DELAY : 0);

  return {
    el,

    /** Page state for QA/integration assertions (never pixels). Null when there is no 3D hero. */
    hero() {
      if (!fit) return { mode: entranceMode, live: false, painted, flying };
      return {
        mode: entranceMode,
        scale: entranceScale,
        live: true,
        painted,
        flying,
        contextLost,
        az,
        elev: fit.elev,
        dist: fit.dist,
        size: [sizedW, sizedH],
      };
    },

    /** Beat 2's panel, for QA/integration assertions. Null when it could not be built. */
    oldWay: () => oldway,

    /** Whether this brief is the guided, decluttered one. Page state for QA, never a pixel. */
    guided: () => guided,

    /**
     * The guided brief's incumbent-tool mock, for QA/integration assertions. Null on a non-guided
     * brief, and null on a guided one until its family module has landed.
     */
    mock: () => mock,

    /** The family this brief mounted (or would have). Null on a non-guided brief. */
    mockFamily: () => mockFamily,

    /** Programmatic hand-off: land the copy, then advance. */
    skip() {
      revealAll();
      advance();
    },

    /**
     * Idempotent, and safe when the mount has already been emptied out from under us (app.js
     * clears #ingest-mount right after disposing): every teardown step is guarded and nothing
     * here re-reads the DOM tree.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      done = true;
      endFly(); // also clears the ctx-flying overflow locks off the screen and the body
      if (ro) {
        try {
          ro.disconnect();
        } catch (_) {
          /* observer already dead */
        }
        ro = null;
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onVisibility);
      try {
        copy.removeEventListener('click', onCopyClick);
        goBtn.removeEventListener('click', advance);
        if (skipBtn) skipBtn.removeEventListener('click', advance);
      } catch (_) {
        /* nodes already gone: listeners went with them */
      }
      if (oldway) {
        try {
          oldway.dispose(); // clears its ticker and its IntersectionObserver
        } catch (_) {
          /* panel already gone with the tree */
        }
        oldway = null;
      }
      if (mock) {
        try {
          mock.dispose(); // clears its ticker and its IntersectionObserver
        } catch (_) {
          /* panel already gone with the tree */
        }
        mock = null;
      }
      dropHero(); // cancels the render loop, releases the rig and the context
      if (section) section.classList.remove('ctx-mode');
      if (el && typeof el.remove === 'function') el.remove();
    },
  };
}
