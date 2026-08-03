// app.js - boot, hash router, robot registry wiring, screen construction and the onEvidence
// orchestration that is the whole point of this demo.
//
// Routes: #/start (role fork) · #/missions (the seven-card picker) · #/connect/:id · #/demo/:id
//
// `#/` is not a screen. It is the DOOR, and where it opens depends on whether this visitor has
// already answered the one question the demo asks: a first-timer gets the role fork, someone who
// has forked is sent straight into the mission their role is guided to. The seven-card picker is
// still first-class, it is just no longer the landing: it lives at #/missions and every screen
// after the fork carries a link to it.
//
// ?robot=<id> on any load deep-links to that robot's BRIEF, not to its demo: the brief is where a
// visitor is told what the mission was and what finding the fault costs today, and a deep link that
// skipped it dropped people into a 3D scene with no idea what they were looking at. A second visit
// (sessionStorage, written by the brief itself) goes straight to the demo.

import { ROBOTS, getRobot, registerRobot, ROBOT_ICONS } from './robots/index.js';
import { GEN_ID_RE, loadGeneratedRobot } from './robots/generated.js';
import { mulberry32, seedFor } from './core/prng.js';
import { createTimeline } from './core/timeline.js';
import { createViewer } from './core/viewer.js';
import { createChart } from './core/chart.js';
import { createChat } from './core/chat.js';
import { createIngest } from './core/ingest.js';
import { createPickerPreviews } from './core/preview.js';
import { createContext, GENERIC_ICON, briefSeen } from './core/context.js';
import { createSignupPopup, createSignupTriggers } from './core/signup.js';
import { createStart } from './core/start.js';
import { getRoleId, hasRole, missionFor, DEFAULT_MISSION } from './core/role.js';
import { initAnalytics, track, capture } from './core/analytics.js';

const GITHUB_URL = 'https://github.com/alloyrobotics/alloy-logger-arduino';
const SETUP_URL =
  'https://www.usealloy.ai/setup-org?utm_source=alloylogger.com&utm_medium=referral&utm_campaign=alloylogger&utm_content=demo';

const screens = {
  start: document.getElementById('screen-start'),
  picker: document.getElementById('screen-picker'),
  connect: document.getElementById('screen-connect'),
  demo: document.getElementById('screen-demo'),
};

/**
 * buildData is called exactly once per robot, at first use. The result is attached to the def as
 * `.data`; viewer.js, chart.js and ingest.js all read robotDef.data.
 *
 * TRIPWIRE. A def may declare `loadSceneData()`: its channels are DERIVED from a payload that
 * loads lazily (the SSL match replay), so `buildData` before that payload exists is not a slow
 * path, it is a wrong one. Such a def must also declare `isSceneDataLoaded()`, and calling this
 * before that returns true is a routing bug in this file, never something to paper over: the
 * picker and the brief read `def.previewData` and never come here at all, and the demo route
 * awaits `loadSceneData()` first.
 */
function ensureData(def) {
  if (!def.data) {
    if (typeof def.loadSceneData === 'function' && !(def.isSceneDataLoaded && def.isSceneDataLoaded())) {
      throw new Error(
        `ensureData(${def.id}): this robot's channels are derived from its scene payload. ` +
          'await def.loadSceneData() before building its data.',
      );
    }
    def.data = def.buildData(mulberry32(seedFor(def.id)));
  }
  return def.data;
}

/**
 * What a 3D scene gets handed as its second `update()` argument.
 *
 * `def.data` is chart and chat telemetry. A def whose scene is driven by something else says so
 * with `getSceneData()`, and that def's scene payload is the only thing the picker and the brief
 * ever need from it, so neither screen builds its telemetry. Defs without a `getSceneData` take
 * the ensureData path exactly as before.
 *
 * @param {object} def
 * @returns {object} scene data for `sceneApi.update(t, data)`
 */
function sceneDataFor(def) {
  if (typeof def.getSceneData === 'function') return def.getSceneData() || {};
  return ensureData(def);
}

// ---------------------------------------------------------------------------- start
// The role fork. One question, one tap, and the only screen that decides which mission a visitor is
// guided into. Built by core/start.js; this file owns nothing but the mount and where a tap goes.

let startApi = null;

/** The robot a role is guided into, gated on the registry so a re-pointed role cannot 404. */
function missionForRole(role) {
  const id = missionFor(role);
  return getRobot(id) ? id : DEFAULT_MISSION;
}

function buildStart() {
  const mount = screens.start.querySelector('#start-mount');
  if (startApi) startApi.dispose();
  mount.innerHTML = '';
  startApi = createStart(mount, {
    // The frozen copy contract. start.js ships its own defaults; the sub-line is the one the spec
    // locks, so it is stated here rather than left to drift inside the module.
    copy: { sub: 'Pick your seat. The analyst speaks your language.' },
    // start.js persists the role and fires role_selected BEFORE this runs, so by the time the
    // brief builds, every event that follows is already segmented.
    onPick: (role) => {
      location.hash = `#/connect/${missionForRole(role)}`;
    },
    onExplore: () => {
      location.hash = '#/missions';
    },
  });
  // exposed for QA/integration assertions (page state, not pixels)
  window.__start = startApi;
}

function teardownStart() {
  if (!startApi) return;
  startApi.dispose();
  startApi = null;
  delete window.__start;
}

// ---------------------------------------------------------------------------- picker
let pickerBuilt = false;
/** [{ el: .rcard-art, def }] handed to the preview module every time the picker is entered. */
let pickerEntries = [];
let pickerPreviews = null;

/** The first sentence of a paragraph, or the whole thing when it has no terminator. */
function firstSentence(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  const m = t.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : t).trim();
}

/**
 * The card's problem line: what went wrong in this mission, in one authored line.
 *
 * `context.cardProblem` is the line every def now ships, and it is preferred over anything derived
 * here. Deriving it from the brief prose did not work at any clamp: the briefs are written to brief
 * an ANALYST, so their first sentences run to 130-230 characters and the fault half, the half that
 * makes anyone click, was clipped off the bottom of all seven cards at both viewports. A card line
 * is its own piece of copy, so it is authored as one, fault first and short enough to land whole.
 *
 * The mission + fault fallback stays for a def that ships no `cardProblem` (a generated demo), and
 * terminates each half: two halves joined with a bare space read as one run-on sentence when the
 * first one was authored without a full stop.
 */
function problemLine(def) {
  const ctx = def.context || {};
  const card = typeof ctx.cardProblem === 'string' ? ctx.cardProblem.trim() : '';
  if (card) return card;
  const bits = [firstSentence(ctx.mission), firstSentence(ctx.fault)]
    .filter(Boolean)
    .map((s) => (/[.!?…]$/.test(s) ? s : s + '.'));
  return bits.join(' ');
}

function buildPicker() {
  if (pickerBuilt) return;
  pickerBuilt = true;
  pickerEntries = [];
  const grid = screens.picker.querySelector('#robot-grid');
  grid.innerHTML = '';

  // NOTE: the cards are built from the DEFINITION only. Generating every robot's telemetry here
  // (a full physics pass each) blocked the picker's first paint for output nothing on this screen
  // reads; buildConnect and buildDemo already call ensureData for the one robot picked.
  ROBOTS.forEach((def) => {
    const a = document.createElement('a');
    a.className = 'rcard';
    a.href = `#/connect/${def.id}`;
    a.style.setProperty('--acc', def.accent || '#2f78ff');
    a.setAttribute('data-robot', def.id);
    a.innerHTML = `
      <div class="rcard-art">
        <svg viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          ${ROBOT_ICONS[def.id] || ''}
        </svg>
      </div>
      <div class="rcard-body">
        <h3 class="rcard-name"></h3>
        <p class="rcard-tag"></p>
        <p class="rcard-prob"></p>
      </div>
      <span class="rcard-go mono">replay mission &rsaquo;</span>`;
    a.querySelector('.rcard-name').textContent = def.name;
    a.querySelector('.rcard-tag').textContent = def.tagline;
    // the card carries the PROBLEM, not just a label: a tagline says what the robot is, and this
    // says what happened to it, which is the only reason to open the mission
    const prob = problemLine(def);
    const probEl = a.querySelector('.rcard-prob');
    if (prob) probEl.textContent = prob;
    else probEl.remove();
    grid.appendChild(a);
    pickerEntries.push({ el: a.querySelector('.rcard-art'), def });
  });
}

/**
 * The live 3D card previews. Mounted on entering the picker, disposed on leaving it, so the demo
 * viewer never shares the page with a second WebGL context.
 */
function mountPickerPreviews() {
  if (pickerPreviews || !pickerEntries.length) return;
  pickerPreviews = createPickerPreviews(pickerEntries, screens.picker.querySelector('#robot-grid'));
  // exposed for QA/integration assertions (page state, not pixels)
  window.__picker = { previews: pickerPreviews, entries: pickerEntries };
}

function teardownPickerPreviews() {
  if (!pickerPreviews) return;
  pickerPreviews.dispose();
  pickerPreviews = null;
  delete window.__picker;
}

// ---------------------------------------------------------------------------- connect
let ingestApi = null;

function buildConnect(def) {
  const mount = screens.connect.querySelector('#ingest-mount');
  if (ingestApi) ingestApi.dispose();
  mount.innerHTML = '';
  // A def with a LAZY scene payload authors its whole brief itself, so the brief has nothing to
  // read out of the telemetry and the telemetry is never built here. The test is the CAPABILITY
  // (`loadSceneData`), not the payload: `previewData` is null whenever the preview slice failed to
  // decode, and reading that null as "legacy robot, build its telemetry" walked straight into
  // ensureData's tripwire and threw on a route with no error handling. A def that declares
  // `loadSceneData` never comes here, decoded or not; the brief falls back to its SVG hero.
  if (typeof def.loadSceneData !== 'function') ensureData(def);
  ingestApi = createContext(mount, def, {
    handoff: takeHeroHandoff(def.id),
    onDone: () => {
      if (currentRoute.name === 'connect' && currentRoute.id === def.id) {
        location.hash = `#/demo/${def.id}`;
      }
    },
  });
  // exposed for QA/integration assertions (page state, not pixels). A QA handle only: it is not
  // cleared on teardown, so a stale reference after leaving the screen is expected.
  window.__ctx = ingestApi;
}

// ------------------------------------------------------------------ picker -> hero hand-off
// Where the clicked card was, and where its live preview's camera had orbited to, sampled in the
// SAME frame as the click. The connect screen's hero opens from this so the machine appears to be
// picked up off the card rather than replaced by a new one.
//
// Rects are VIEWPORT coordinates on purpose: the picker is gone by the time the hero measures
// itself, and both rects are read against the viewport, so the picker's scroll offset is already
// baked into the one the user last actually saw.
let heroHandoff = null;

// capture phase, so the record exists before the anchor's default navigation kicks off the route
screens.picker.addEventListener(
  'click',
  (e) => {
    const card = e.target && e.target.closest ? e.target.closest('a.rcard') : null;
    if (!card) return;
    const id = card.dataset.robot || (card.getAttribute('href') || '').split('/').filter(Boolean).pop();
    const art = card.querySelector('.rcard-art');
    if (!id || !art) return;
    const r = art.getBoundingClientRect();
    const svg = art.querySelector('svg');
    const g = svg ? svg.getBoundingClientRect() : null;
    heroHandoff = {
      id,
      at: performance.now(),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      ghost: g && g.height ? { w: g.width, h: g.height } : null,
      live: art.classList.contains('preview-live'),
      phase: (pickerPreviews && pickerPreviews.phaseFor ? pickerPreviews.phaseFor(id) : null) || null,
    };
  },
  true
);

/**
 * Consume the hand-off, once. A stale record (a back-button return, a hash typed by hand, a click
 * on one card followed by a navigation to another) must never drive the entrance, so it is cleared
 * on read and only returned for the matching robot within a few seconds of the click.
 */
function takeHeroHandoff(id) {
  const h = heroHandoff;
  heroHandoff = null;
  if (!h || h.id !== id) return null;
  if (performance.now() - h.at > 4000) return null;
  return h;
}

// ---------------------------------------------------------------------------- signup popup
// The dialog is built once at boot and reused across routes; the trigger machine that decides
// when it opens is installed per demo build and torn down with the demo (core/signup.js).

let signupPopup = null;
let signupTriggers = null;

// ---------------------------------------------------------------------------- demo
let demo = null;

function teardownDemo() {
  // Ahead of the `demo` guard: the triggers own window level listeners and a pending timer, and
  // leaving either behind would let a torn-down demo open a popup over the picker.
  if (signupTriggers) {
    signupTriggers.dispose();
    signupTriggers = null;
    delete window.__signup;
  }
  if (!demo) return;
  // #chart-toggle is a persistent node: its handler closes over this demo's chart/viewer/timeline,
  // so leaving it attached pins the whole torn-down three.js scene graph in memory.
  const toggle = screens.demo.querySelector('#chart-toggle');
  if (toggle) toggle.onclick = null;
  demo.chat.dispose();
  demo.chart.dispose();
  demo.viewer.dispose();
  demo.timeline.dispose();
  demo = null;
  delete window.__demo;
}

/**
 * Build the demo, or leave nothing behind.
 *
 * `demo` is only assigned once every component exists, which is right - a half-built demo must
 * never be reachable - but it made the FAILURE path a no-op: `renderSceneUnavailable()` calls
 * `teardownDemo()`, and `teardownDemo()` returns immediately while `demo` is still null. So a throw
 * in the chart or the chat, after the timeline and the viewer were already constructed, left a live
 * WebGL context, a canvas in the DOM, an animation frame and two timeline subscriptions with
 * nothing holding a reference to any of them. Retrying the mission built another set.
 *
 * So construction is transactional. The components are tracked LOCALLY as they are built, and a
 * throw disposes them newest first before it propagates. `buildDemoInner` is the function this one
 * used to be; the split exists to get a try block around a body whose closures reach thirty locals,
 * and to keep the assignment of `demo` where it belongs, at the very end of a successful build.
 */
function buildDemo(def) {
  teardownDemo();
  ensureData(def);
  const built = [];
  try {
    buildDemoInner(def, built);
  } catch (err) {
    // Same order and the same members teardownDemo() unwinds, minus the ones that were never
    // reached. The signup triggers first, and unconditionally: they are installed near the end of
    // the build, they own window level listeners and a pending quiet timer, and a build that threw
    // after installing them would otherwise leave a torn-down demo able to open the popup over
    // whatever screen the failure lands on. The toggle handler because it is a PERSISTENT node
    // closing over components about to die.
    if (signupTriggers) {
      signupTriggers.dispose();
      signupTriggers = null;
      delete window.__signup;
    }
    const toggle = screens.demo.querySelector('#chart-toggle');
    if (toggle) toggle.onclick = null;
    while (built.length) {
      const component = built.pop();
      try {
        component.dispose();
      } catch (disposeErr) {
        // The original failure is the one worth reporting; a teardown that also fails must not
        // replace it, or the card would explain the wrong problem.
        console.warn(`[demo] partial teardown: ${disposeErr && disposeErr.message}`);
      }
    }
    throw err;
  }
}

function buildDemoInner(def, built) {
  /**
   * Register a component the moment it exists, so the catch above can find it.
   *
   * NOT named `track`: this module imports the analytics `track` object, and a local of that name
   * shadowed it for the whole function body. Every funnel call inside here (the auto-played chip,
   * the aha itself) then read a property off this closure, threw a TypeError, and was swallowed by
   * chat.js's evidence try/catch, so the flow looked green while the one metric this demo exists
   * to measure never left the page.
   */
  const own = (component) => {
    built.push(component);
    return component;
  };

  const host = screens.demo;
  host.querySelector('#demo-name').textContent = def.name;
  host.querySelector('#demo-device').textContent = def.device;

  const viewerMount = host.querySelector('#viewer-mount');
  const chartMount = host.querySelector('#chart-mount');
  const chatMount = host.querySelector('#chat-mount');
  viewerMount.innerHTML = '';
  chartMount.innerHTML = '';
  chatMount.innerHTML = '';

  const timeline = own(createTimeline(def.duration));
  const viewer = own(createViewer(viewerMount, def, timeline));
  const chart = own(createChart(chartMount, def, timeline));

  let evidenceActive = null;
  let evidenceFull = false; // the active finding spans the whole mission, so it is not looping

  /** Clear loop + highlight + zoom, back to the full mission. */
  function clearEvidence() {
    if (!evidenceActive) return;
    evidenceActive = null;
    evidenceFull = false;
    timeline.setLoop(null, { speed: 1 });
    viewer.setHighlight(null);
    viewer.hideBanner();
    chart.resetZoom();
    host.classList.remove('evidence-on');
  }

  /**
   * THE money interaction. Order is fixed by the build contract:
   *   1. scrubber marker flash, loop the finding window, seek to its start, play
   *   2. chart switches channel/fields and animates its x-domain onto the window
   *   3. the failing part pulses in the 3D scene
   *   4. dismissible evidence banner over the viewer
   *
   * @param {object} finding
   * @param {{source?: 'user'|'auto'}} [opts] WHO fired it. The demo plays the scripted first
   *   answer's chip for the visitor exactly once (`source: 'auto'`); everything else is a real
   *   click, and only a real click is the aha this whole funnel measures. The default is 'user'
   *   deliberately: a caller that forgets to declare itself over-counts one chip per demo, where
   *   the opposite default would silently record the aha as never happening at all.
   */
  function onEvidence(finding, opts) {
    if (!finding) return;
    const auto = !!(opts && opts.source === 'auto');
    evidenceActive = finding;
    host.classList.add('evidence-on');

    // 1. A slow-burn finding's window IS the mission: looping it is just normal playback with a
    // loop bar the width of the whole scrubber, so those replay from a run-up to the cited instant
    // instead. Bounded findings loop their window exactly as the contract specifies.
    const w = finding.window || [0, def.duration];
    const fullMission = w[1] - w[0] >= def.duration * 0.95;
    evidenceFull = fullMission;
    viewer.flashMarker(finding.id);
    if (fullMission) {
      timeline.setLoop(null, { speed: 1 });
      timeline.seek(Math.max(0, (finding.t != null ? finding.t : w[0]) - 8));
    } else {
      timeline.setLoop(w, { speed: finding.slowmo ? 0.4 : 1 });
      timeline.seek(w[0]);
    }
    timeline.play();

    // 2 - on mobile the chart lives behind a collapsed panel, so open it or the zoom is invisible
    if (window.matchMedia('(max-width: 899px)').matches) setChartOpen(true);
    chart.focus(finding);

    // 3
    viewer.setHighlight(finding.highlight || null);

    // 4
    viewer.showBanner(finding, clearEvidence);

    if (auto) track.evidenceAutoPlayed(def.id, finding.id);
    else track.evidenceUserClicked(def.id, finding.id);
  }

  const chat = own(createChat(chatMount, def, {
    onEvidence,
    onAsk: () => {
      clearEvidence();
    },
    // The answer is fully typed out, so a visitor who asked a question is free again: this is the
    // only chat signal the signup popup's quiet period listens to.
    onSettled: () => {
      if (signupTriggers) signupTriggers.chatSettled();
    },
  }));

  // Scrubbing (marker click, drag, chart click) outside a running evidence loop drops the loop in
  // timeline.seek. That is the user leaving the evidence, so the banner, highlight and chart zoom
  // have to leave with it instead of lingering over a mission that is no longer looping.
  timeline.onChange((s) => {
    if (evidenceActive && !evidenceFull && !s.loopWindow) clearEvidence();
  });

  // mobile: chart panel collapses
  const chartPanel = host.querySelector('#chart-panel');
  const chartToggle = host.querySelector('#chart-toggle');
  function setChartOpen(open) {
    chartPanel.classList.toggle('open', open);
    host.classList.toggle('chart-open', open);
    chartToggle.setAttribute('aria-expanded', String(open));
    chart.redraw();
  }
  chartToggle.onclick = () => setChartOpen(!chartPanel.classList.contains('open'));
  setChartOpen(false);

  demo = { def, timeline, viewer, chart, chat, onEvidence, clearEvidence, setChartOpen };
  // exposed for QA/integration assertions (page state, not pixels)
  window.__demo = demo;

  // Installed here, after the viewer/chart/chat nodes exist, because the machine arms off THEIR
  // surfaces (the render canvas, the scrubber, the chart, the chips, the composer) and off nothing
  // programmatic. Generated demos get it too: that visitor is the warmest lead on the page.
  if (signupPopup) {
    signupTriggers = createSignupTriggers({
      host,
      popup: signupPopup,
      isDemoRoute: () => currentRoute.name === 'demo',
      isStreaming: () => chat.streaming,
    });
    window.__signup = signupTriggers;
  }

  timeline.play();
  window.setTimeout(() => {
    // identity, not id: leaving and re-entering the same robot inside 420 ms would otherwise let
    // the stale timer drive the disposed chat instance
    if (demo && demo.chat === chat) chat.askFirstQuestion();
  }, 420);

  capture('demo_opened', { robot: def.id });
}

// ------------------------------------------------------------------- generated robots
// A `g-<slug>` id is not compiled in: it is one def.json fetched at route time. The fetch has to
// happen between the hash changing and the screen building, so it gets its own tiny state machine
// that parks on the connect screen and re-enters the router once the def is registered.

/** Slug currently being fetched, so a repeat hashchange does not start a second request. */
let genPending = null;

/**
 * The loading and dead-link states, rendered in the mission brief's own frame: the same hero panel
 * and the same staged copy column the brief itself is about to occupy, with the generic line art
 * standing in for a machine there is no def for yet. Built by hand rather than through
 * createContext because at this point there is nothing to brief and no buildScene to stage.
 *
 * `.ctx-charge` and `.ctx-system` are used purely as the brief's two type sizes, bright line first.
 *
 * @param {{ line:string, cap:string, action?:{label:string, href:string}, progress?:boolean,
 *   icon?:string, accent?:string, detail?:string }} o `icon`/`accent` are for the states where the robot IS known
 *   (a canned def waiting on its scene payload); without them the card stands in the generic
 *   machine, which is all a not-yet-fetched generated demo has.
 */
function renderGenCard(o) {
  const section = screens.connect;
  const mount = section.querySelector('#ingest-mount');
  mount.innerHTML = '';
  // the brief is a full-width two-column layout; without this the connect body centres a small card
  section.classList.add('ctx-mode');

  const el = document.createElement('div');
  el.className = 'ctx';
  // there is no def to take an accent off yet, and the panel's backdrop is a color-mix() on --acc:
  // leaving it unset makes that whole background shorthand invalid and the product shot loses its
  // texture entirely. The house blue is the same default the picker cards fall back to.
  el.style.setProperty('--acc', o.accent || '#2f78ff');
  el.innerHTML = `
    <div class="ctx-stage">
      <div class="ctx-fly">
        <svg class="ctx-ghost" viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${o.icon || GENERIC_ICON}</svg>
      </div>
    </div>
    <div class="ctx-copy">
      <p class="ctx-charge" data-stage="1" style="--d:0ms"></p>
      <p class="ctx-system" data-stage="2" style="--d:220ms"></p>
    </div>`;

  el.querySelector('.ctx-charge').textContent = o.line;
  el.querySelector('.ctx-system').textContent = o.cap;

  const copy = el.querySelector('.ctx-copy');
  if (o.detail) {
    // the raw failure, on the card itself: the visitor's screenshot then carries the diagnosis,
    // instead of a console line nobody opened devtools to read
    const det = document.createElement('p');
    det.className = 'ctx-detail';
    det.dataset.stage = '3';
    det.style.setProperty('--d', '440ms');
    det.textContent = o.detail;
    copy.appendChild(det);
  }
  if (o.progress) {
    // indeterminate on purpose: a percentage would be a lie, the fetch is one request
    const bar = document.createElement('div');
    bar.className = 'ctx-wait';
    bar.style.setProperty('--d', '440ms');
    bar.dataset.stage = '3';
    bar.appendChild(document.createElement('span'));
    copy.appendChild(bar);
  }
  if (o.action) {
    // the same slot, and the same button, the brief's own CTA occupies
    const act = document.createElement('a');
    act.className = 'btn ctx-go';
    act.href = o.action.href;
    act.dataset.stage = '3';
    act.style.setProperty('--d', '440ms');
    act.textContent = o.action.label;
    copy.appendChild(act);
  }

  mount.appendChild(el);
}

/**
 * Fetch, gate and register a generated robot, then hand the route back to route(). Failure stops
 * on an explanatory card rather than bouncing to the picker: a visitor who followed a personal
 * link deserves to be told the link is dead, not silently dropped somewhere else.
 *
 * @param {{name:string, id:string}} next the route that asked for this robot
 */
function resolveGenerated(next) {
  if (genPending === next.id) return;
  genPending = next.id;

  // leave whatever screen we were on, same teardown order route() uses
  if (currentRoute.name === 'picker') teardownPickerPreviews();
  if (currentRoute.name === 'demo') teardownDemo();
  if (ingestApi) {
    ingestApi.dispose();
    ingestApi = null;
  }

  // A sentinel, not the target route: the target has not been built yet, and route() must treat
  // the next pass as a fresh entry into whichever screen the hash names.
  currentRoute = { name: 'gen', id: next.id };
  show('connect');
  document.title = 'Loading demo · AlloyLogger';
  renderGenCard({
    line: 'Loading this mission.',
    cap: 'Pulling the robot, its telemetry and the brief the analyst is about to be handed.',
    progress: true,
  });

  loadGeneratedRobot(next.id).then((def) => {
    genPending = null;
    // navigated away mid-fetch: the def is stale, drop it and leave the current screen alone
    if (parseHash().id !== next.id) return;

    if (!def) {
      currentRoute = { name: 'gen', id: null };
      document.title = 'Demo unavailable · AlloyLogger';
      renderGenCard({
        line: 'This demo link is not available.',
        cap: 'It may have expired. Generated demos are one-off links and they do not last forever.',
        action: { label: 'Pick a robot instead', href: '#/missions' },
      });
      return;
    }

    // The scene half of a generated def is compiled inside loadGeneratedRobot, in a try/catch that
    // turns a bad scene_spec into this same card. The DATA half is lazy (`buildData` is a closure
    // the def hands back), so it would otherwise throw later, out of ensureData, with the demo
    // screen already up and no handler above it. Build it here, in the same shape as the scene
    // wrap, so a data_spec the interpreter cannot evaluate fails as "not available" too.
    try {
      ensureData(def);
    } catch (err) {
      console.warn(`[generated] ${next.id}: data_spec would not build (${err && err.message})`);
      currentRoute = { name: 'gen', id: null };
      document.title = 'Demo unavailable · AlloyLogger';
      renderGenCard({
        line: 'This demo link is not available.',
        cap: 'It may have expired. Generated demos are one-off links and they do not last forever.',
        action: { label: 'Pick a robot instead', href: '#/missions' },
      });
      return;
    }

    registerRobot(def);
    route();
  });
}

// ------------------------------------------------------------------- lazy scene payloads
// A def may keep its 3D payload out of the boot graph and behind `loadSceneData()` (the SSL match
// replay is ~700 KB, and four visitors in five never open it). The picker and the brief run off
// `def.previewData`, so the wait happens exactly once, on the way into the demo screen.

/**
 * Robot ids with a load in flight. Diagnostic only, and exposed for QA: the LOAD is deduplicated
 * inside the def (`loadSceneData()` is a cached idempotent promise), never here. Suppressing the
 * ROUTE ENTRY on this set is what used to strand a visitor - see below.
 */
const scenePending = new Set();

/**
 * The ONE place a scene-backed mission's failure is rendered, whether the payload rejected, the
 * route it unblocked threw, or a later entry into the same mission threw again. Nothing on this
 * path may be left half-built: `currentRoute` goes back to the 'load' sentinel so the next pass
 * treats the demo as a fresh entry rather than as a screen it is already on.
 *
 * Module scope, not a closure inside `resolveSceneData`, because the failure has TWO entry points.
 * The first visit fails inside the load continuation; every visit after that finds the payload
 * cached as loaded, skips `resolveSceneData` entirely and builds straight out of `route()`. A card
 * that only existed inside the continuation left the second visit throwing out of the hashchange
 * handler with the demo screen already shown.
 *
 * @param {object} def the robot whose mission could not be built
 * @param {Error} err
 */
function renderSceneUnavailable(def, err) {
  console.warn(`[scene] ${def.id}: ${err && err.message}`);
  // A demo that threw mid-build is half-wired, so its own teardown can throw too. Failing to tear
  // down must not stop the card from rendering: the card is what the visitor sees.
  try {
    teardownDemo();
  } catch (teardownErr) {
    console.warn(`[scene] ${def.id}: teardown after failure: ${teardownErr && teardownErr.message}`);
    demo = null;
  }
  show('connect');
  currentRoute = { name: 'load', id: null };
  document.title = 'Mission unavailable · AlloyLogger';
  renderGenCard({
    icon: ROBOT_ICONS[def.id],
    accent: def.accent,
    line: 'This mission could not be loaded.',
    // The two failures are not the same failure: a decode or a build can be retried in place, a
    // module that failed to evaluate is cached as failed by specifier for the life of the document.
    cap:
      err && err.retryable === false
        ? 'The replay module did not load. Reload the page to try again.'
        : 'The replay did not decode. Pick the mission again to retry, or choose another robot.',
    // the deepest cause is the one that names the real failure; the wrappers above it are the
    // sentences already on the card
    detail: (() => {
      let deepest = '';
      for (let e = err; e; e = e.cause) if (e.message) deepest = e.message;
      return deepest;
    })(),
    action: { label: 'Back to the robots', href: '#/missions' },
  });
}

/**
 * Park the loading card, await the payload, then hand the route back to route().
 *
 * EVERY entry into this route gets its own continuation, even while an earlier load of the same
 * robot is still in flight. That is the whole correctness argument. The load itself is already
 * deduplicated by `def.loadSceneData()`, which returns one cached promise, so a second entry costs
 * a `.then` and nothing else; but a second entry that returned early instead would leave the route
 * with no continuation at all, while the first continuation, tied to a generation that is now two
 * navigations old, correctly refuses to touch the screen. The hash then says `#/demo/ssl` forever
 * over whatever screen happened to be showing. The sequences that reach it are ordinary:
 * demo -> back to picker -> the same demo again, and demo -> connect/<same id> -> demo.
 *
 * Staleness is checked on the generation captured at ENTRY. A newer pass owns the screen and this
 * one must not touch it. If the generation still holds, the payload landed with this entry still
 * current, and the route is re-entered against the CURRENT hash rather than against the one that
 * started the load: within one generation the hash can only have moved to another screen of the
 * same robot, and re-entering renders it instead of leaving it half-built.
 *
 * @param {{name:string, id:string}} next the route that asked for this robot
 * @param {object} def
 */
function resolveSceneData(next, def) {
  scenePending.add(next.id);
  const gen = navGen;

  // leave whatever screen we were on, same teardown order route() uses
  if (currentRoute.name === 'picker') teardownPickerPreviews();
  if (currentRoute.name === 'demo') teardownDemo();
  if (ingestApi) {
    ingestApi.dispose();
    ingestApi = null;
  }

  // A sentinel, not the target route: the demo has not been built yet, and route() must treat the
  // next pass as a fresh entry into it. 'load' parks its card in #ingest-mount, so it leaves the
  // connect screen the same way a running brief does.
  currentRoute = { name: 'load', id: next.id };
  show('connect');
  document.title = `Loading ${def.name} · AlloyLogger`;
  // The card copy belongs to the def: one lazy mission is a real match replay and another is a
  // synthetic round, and a shared sentence was quietly claiming every lazy payload had a ball.
  const loading = def.loadingCopy || {
    line: 'Loading the mission replay.',
    cap: 'The 3D replay, the charts and the analyst open when it lands.',
  };
  renderGenCard({
    line: loading.line,
    cap: loading.cap,
    progress: true,
    icon: ROBOT_ICONS[def.id],
    accent: def.accent,
  });

  /**
   * True when a LATER routing pass has taken the screen, or when the hash has moved off this
   * robot entirely (that move has its own pass; this one must not pre-empt it).
   */
  const stale = () => gen !== navGen || parseHash().id !== next.id;

  const unavailable = (err) => renderSceneUnavailable(def, err);

  def.loadSceneData().then(
    () => {
      scenePending.delete(next.id);
      if (stale()) return;
      // Re-enter for whatever the hash asks for NOW, which is this robot on this screen or on its
      // brief. route() rebuilds from the hash, so either lands fully rendered.
      //
      // route() is SYNCHRONOUS and it builds the demo: chart, viewer, chat, all derived from the
      // payload that just landed. A throw in there used to escape into this `.then` as an
      // unhandled rejection, leaving the visitor on an exposed demo screen with no card and no
      // message. The load succeeding is not the same thing as the mission working, so the
      // continuation gets the same failure path the load itself has.
      //
      // The ERROR branch does NOT re-check stale(). It cannot: route() bumps navGen as its first
      // act, so by the time anything inside it throws, the generation captured at entry is stale
      // BY CONSTRUCTION and a `if (stale()) throw err` rethrows every single mid-build failure as
      // the unhandled rejection this was written to stop. The generation check belongs to the
      // ROUTING decision above - "may this continuation touch the screen at all" - and it has
      // already said yes. Once route() has been entered, this pass owns the screen and owns
      // whatever it broke, so the card is unconditional.
      try {
        route();
      } catch (err) {
        unavailable(err);
      }
    },
    (err) => {
      scenePending.delete(next.id);
      if (stale()) return;
      unavailable(err);
    },
  );
}

// ---------------------------------------------------------------------------- router
let currentRoute = { name: 'start', id: null };
/**
 * Monotonic, bumped once per routing pass. Anything awaited across a route change compares the
 * generation it captured against this before it touches the screen.
 */
let navGen = 0;
/**
 * Whether the routing pass currently running is the page's FIRST one. `currentRoute` cannot answer
 * this: it is seeded with a screen name, so a cold load onto that screen is indistinguishable from
 * navigating back to it. Only the start screen reads it, and only to decide whether taking focus
 * would be following the visitor or interrupting them.
 */
let routedOnce = false;

/**
 * Five names, four of which are screens.
 *
 * 'home' is the fifth and it is not a screen: `#/` resolves to the role fork or straight into the
 * guided mission depending on what this visitor has already told us, and that decision is route()'s
 * because it needs the registry. Parsing it as either one here would bake a stored role into a pure
 * function of the URL.
 */
function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'connect' && parts[1]) return { name: 'connect', id: parts[1] };
  if (parts[0] === 'demo' && parts[1]) return { name: 'demo', id: parts[1] };
  if (parts[0] === 'missions') return { name: 'picker', id: null };
  if (parts[0] === 'start') return { name: 'start', id: null };
  return { name: 'home', id: null };
}

function show(name) {
  Object.entries(screens).forEach(([k, node]) => {
    node.hidden = k !== name;
  });
  document.body.dataset.screen = name;
}

function route() {
  navGen++;
  const coldLoad = !routedOnce;
  routedOnce = true;
  const next = parseHash();

  // `#/` is the door, not a screen. A visitor who has already forked is sent into their guided
  // mission's brief; everyone else meets the fork. Decided BEFORE any teardown and before
  // currentRoute moves, so the redirect's own pass does the leaving properly against the screen
  // that is actually up.
  if (next.name === 'home') {
    if (hasRole()) {
      // REPLACE, never assign. `location.hash = ...` pushes, so the entry the visitor came in on
      // (`#/`) stays behind the redirect: pressing Back returns to the door, which redirects
      // forward again, and the demo becomes a tab you cannot leave with the back button. Replacing
      // swaps the door for the mission in place, and the entry BEFORE the demo stays reachable.
      // The path and query are kept so this stays a fragment change and never re-boots the page,
      // which is the same reason boot()'s deep link uses replace().
      location.replace(location.pathname + location.search + `#/connect/${missionForRole(getRoleId())}`);
      return;
    }
    next.name = 'start';
  }

  const def = next.id ? getRobot(next.id) : null;

  if (next.name !== 'picker' && next.name !== 'start' && !def) {
    // A generated demo is not in the registry until its def.json has landed. Resolve it and
    // re-enter, rather than bouncing a perfectly good personal link to the picker.
    if (GEN_ID_RE.test(next.id)) {
      resolveGenerated(next);
      return;
    }
    // the picker, not the door: a hash naming a robot that does not exist is a broken link, and
    // bouncing it to `#/` would hand a forked visitor their usual mission as if nothing was wrong.
    // Replaced rather than pushed, so the dead hash does not sit in history waiting for a Back
    // press to bounce the visitor forward again.
    location.replace(location.pathname + location.search + '#/missions');
    return;
  }

  // leaving a screen
  if (currentRoute.name === 'start' && next.name !== 'start') teardownStart();
  if (currentRoute.name === 'picker' && next.name !== 'picker') teardownPickerPreviews();
  if (currentRoute.name === 'demo' && !(next.name === 'demo' && next.id === currentRoute.id)) teardownDemo();
  // 'gen' and 'load' are the transient resolve states (a generated robot's def.json, a lazy scene
  // payload); both park their own card in #ingest-mount, so they leave the connect screen the
  // same way a running ingest does.
  if (
    (currentRoute.name === 'connect' || currentRoute.name === 'gen' || currentRoute.name === 'load') &&
    next.name !== 'connect'
  ) {
    if (ingestApi) {
      ingestApi.dispose();
      ingestApi = null;
    }
    screens.connect.querySelector('#ingest-mount').innerHTML = '';
    // createContext's dispose() takes this off for the normal path; the 'gen' cards have no api to
    // dispose, so the brief's layout mode would otherwise stay latched onto the screen.
    screens.connect.classList.remove('ctx-mode');
  }

  const prev = currentRoute;
  currentRoute = next;

  if (next.name === 'start') {
    show('start');
    // after show(): the panel is measured by nothing, but a screen built into a hidden section
    // cannot take focus, and the fork is the one screen a keyboard visitor lands on cold
    buildStart();
    // Focus the fork only when the visitor NAVIGATED here (the picker's "Pick your seat" link, a
    // Back press). Not on a cold load: stealing focus there would scroll a fresh landing down to
    // the cards and paint a focus ring on a visitor who arrived with a mouse.
    if (!coldLoad && startApi) startApi.focus();
    document.title = 'AlloyLogger live demo';
    return;
  }

  if (next.name === 'picker') {
    buildPicker();
    show('picker');
    // after show(): the art panels need a real layout rect before the previews read them
    mountPickerPreviews();
    document.title = 'Every mission · AlloyLogger live demo';
    return;
  }

  if (next.name === 'connect') {
    show('connect');
    buildConnect(def);
    document.title = `Connecting ${def.name} · AlloyLogger`;
    return;
  }

  // demo. A def whose scene payload is lazy cannot mount its viewer, chart or chat until that
  // payload is in: its channels are derived from it. Wait on the loading card first, then this
  // same function runs again with everything present.
  if (
    typeof def.loadSceneData === 'function' &&
    !(def.isSceneDataLoaded && def.isSceneDataLoaded())
  ) {
    resolveSceneData(next, def);
    return;
  }
  // show() FIRST, unchanged: the viewer and the chart size themselves off a real layout rect, and
  // a canvas built against a hidden screen comes up 0 x 0.
  show('demo');
  // The payload is in (or there was never one to wait for), so this is the SYNCHRONOUS build. A
  // scene-backed mission that throws here has already been through resolveSceneData once and will
  // never go through it again - the payload is cached as loaded - so this call site needs the same
  // card the load continuation has, or the second visit to a mission that cannot build throws out
  // of the hashchange handler onto an already-shown demo screen. renderSceneUnavailable() shows
  // the connect screen, so the exposed demo does not survive the failure.
  if (!(prev.name === 'demo' && prev.id === next.id)) {
    if (typeof def.loadSceneData === 'function') {
      try {
        buildDemo(def);
      } catch (err) {
        renderSceneUnavailable(def, err);
        return;
      }
    } else {
      buildDemo(def);
    }
  }
  document.title = `${def.name} · AlloyLogger live demo`;
}

// ---------------------------------------------------------------------------- boot
function boot() {
  // CTA hrefs. A ?src=<channel> tag on the demo URL (dm, dm_fu, bio) is forwarded into the
  // setup-org CTAs as utm_content "<channel>-demo", same idea as the landing page's passthrough,
  // so PostHog keeps channel attribution when the DM or bio points here instead of the landing.
  // Clamped to the server's 64-char tag limit: an oversized crafted ?src= must never bloat the
  // signup-lead body toward its 8KB cap and sink an otherwise valid submission.
  const srcTag = (new URLSearchParams(location.search).get('src') || '')
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 64);
  const contentTag = srcTag ? `${srcTag}-demo` : 'demo';

  // Before anything else that can fire an event. The role is picked up from storage inside
  // initAnalytics and registered as a super-prop, so a returning visitor's very first event is
  // already segmented; `src` rides every event for the same reason the CTAs carry it.
  initAnalytics(srcTag ? { props: { src: srcTag } } : {});

  const setupHref = SETUP_URL.replace(/utm_content=demo\b/, `utm_content=${contentTag}`);
  document.querySelectorAll('[data-cta="github"]').forEach((a) => {
    a.href = GITHUB_URL;
  });
  document.querySelectorAll('[data-cta="setup"]').forEach((a) => {
    a.href = setupHref;
  });

  // Built once and reused across routes; buildDemo installs the trigger machine that opens it.
  // The popup captures the email itself rather than linking out, so what it needs from here is
  // attribution, not an href: `getRobot` is read at submit time (the visitor may have walked
  // several demos before answering) and `src` is the raw channel tag off the URL, so a lead can be
  // traced back to the DM or bio link that sent it without a utm round trip.
  signupPopup = createSignupPopup(document.body, {
    getRobot: () => (demo && demo.def ? demo.def.id : null),
    src: srcTag || null,
  });

  // ?robot=<id> deep link
  const q = new URLSearchParams(location.search);
  const deep = q.get('robot');
  // A generated id is not in the registry yet, so it is gated on its shape instead: route() then
  // resolves it exactly as it does for a #/demo/g-... hash.
  if (
    deep &&
    (getRobot(deep) || GEN_ID_RE.test(deep)) &&
    !location.hash.startsWith('#/demo/') &&
    !location.hash.startsWith('#/connect/')
  ) {
    // The BRIEF, not the demo. A link out of a DM lands someone in front of a 3D scene knowing
    // nothing about the mission it is replaying, and the brief is the screen that fixes that: what
    // the robot was doing, what broke, and what finding it costs today. Someone who has already
    // read this mission's brief in this tab (the brief writes the flag itself) is not made to read
    // it twice.
    const target = briefSeen(deep) ? `#/demo/${deep}` : `#/connect/${deep}`;
    // keep location.search: dropping it makes the target differ from the current URL by more than
    // the fragment, so the browser does a real navigation and boots the whole page a second time
    location.replace(location.pathname + location.search + target);
  }

  window.addEventListener('hashchange', route);
  route();

  // global space = play/pause while on the demo screen
  window.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || currentRoute.name !== 'demo' || !demo) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    e.preventDefault();
    demo.timeline.toggle();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { boot, route, buildDemo, ensureData, sceneDataFor };
