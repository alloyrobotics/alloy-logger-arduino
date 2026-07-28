// app.js - boot, hash router, robot registry wiring, screen construction and the onEvidence
// orchestration that is the whole point of this demo.
//
// Routes: #/  (picker)  ·  #/connect/:id  ·  #/demo/:id
// ?robot=<id> on any load deep-links straight to #/demo/<id>.

import { ROBOTS, getRobot, registerRobot, ROBOT_ICONS } from './robots/index.js';
import { GEN_ID_RE, loadGeneratedRobot } from './robots/generated.js';
import { mulberry32, seedFor } from './core/prng.js';
import { createTimeline } from './core/timeline.js';
import { createViewer } from './core/viewer.js';
import { createChart } from './core/chart.js';
import { createChat } from './core/chat.js';
import { createIngest } from './core/ingest.js';
import { createPickerPreviews } from './core/preview.js';
import { createContext, GENERIC_ICON } from './core/context.js';
import { createSignupPopup, createSignupTriggers } from './core/signup.js';

const GITHUB_URL = 'https://github.com/alloyrobotics/alloy-logger-arduino';
const SETUP_URL =
  'https://www.usealloy.ai/setup-org?utm_source=alloylogger.com&utm_medium=referral&utm_campaign=alloylogger&utm_content=demo';

const screens = {
  picker: document.getElementById('screen-picker'),
  connect: document.getElementById('screen-connect'),
  demo: document.getElementById('screen-demo'),
};

/**
 * buildData is called exactly once per robot, at first use. The result is attached to the def as
 * `.data`; viewer.js, chart.js and ingest.js all read robotDef.data.
 */
function ensureData(def) {
  if (!def.data) def.data = def.buildData(mulberry32(seedFor(def.id)));
  return def.data;
}

// ---------------------------------------------------------------------------- picker
let pickerBuilt = false;
/** [{ el: .rcard-art, def }] handed to the preview module every time the picker is entered. */
let pickerEntries = [];
let pickerPreviews = null;

function buildPicker() {
  if (pickerBuilt) return;
  pickerBuilt = true;
  pickerEntries = [];
  const grid = screens.picker.querySelector('#robot-grid');
  grid.innerHTML = '';

  // NOTE: the cards are built from the DEFINITION only. Generating all four robots' telemetry
  // here (four full physics passes) blocked the picker's first paint for output nothing on this
  // screen reads; buildConnect and buildDemo already call ensureData for the one robot picked.
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
      </div>
      <span class="rcard-go mono">replay mission &rsaquo;</span>`;
    a.querySelector('.rcard-name').textContent = def.name;
    a.querySelector('.rcard-tag').textContent = def.tagline;
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
  ensureData(def);
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

function buildDemo(def) {
  teardownDemo();
  ensureData(def);

  const host = screens.demo;
  host.querySelector('#demo-name').textContent = def.name;
  host.querySelector('#demo-device').textContent = def.device;

  const viewerMount = host.querySelector('#viewer-mount');
  const chartMount = host.querySelector('#chart-mount');
  const chatMount = host.querySelector('#chat-mount');
  viewerMount.innerHTML = '';
  chartMount.innerHTML = '';
  chatMount.innerHTML = '';

  const timeline = createTimeline(def.duration);
  const viewer = createViewer(viewerMount, def, timeline);
  const chart = createChart(chartMount, def, timeline);

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
   */
  function onEvidence(finding) {
    if (!finding) return;
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

    // data-analytics-todo: capture('demo_evidence_fired', { robot: def.id, finding: finding.id })
  }

  const chat = createChat(chatMount, def, {
    onEvidence,
    onAsk: () => {
      clearEvidence();
    },
    // The answer is fully typed out, so a visitor who asked a question is free again: this is the
    // only chat signal the signup popup's quiet period listens to.
    onSettled: () => {
      if (signupTriggers) signupTriggers.chatSettled();
    },
  });

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

  // data-analytics-todo: capture('demo_opened', { robot: def.id })
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
 * @param {{ line:string, cap:string, action?:{label:string, href:string}, progress?:boolean }} o
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
  el.style.setProperty('--acc', '#2f78ff');
  el.innerHTML = `
    <div class="ctx-stage">
      <div class="ctx-fly">
        <svg class="ctx-ghost" viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GENERIC_ICON}</svg>
      </div>
    </div>
    <div class="ctx-copy">
      <p class="ctx-charge" data-stage="1" style="--d:0ms"></p>
      <p class="ctx-system" data-stage="2" style="--d:220ms"></p>
    </div>`;

  el.querySelector('.ctx-charge').textContent = o.line;
  el.querySelector('.ctx-system').textContent = o.cap;

  const copy = el.querySelector('.ctx-copy');
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
        action: { label: 'Pick a robot instead', href: '#/' },
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
        action: { label: 'Pick a robot instead', href: '#/' },
      });
      return;
    }

    registerRobot(def);
    route();
  });
}

// ---------------------------------------------------------------------------- router
let currentRoute = { name: 'picker', id: null };

function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'connect' && parts[1]) return { name: 'connect', id: parts[1] };
  if (parts[0] === 'demo' && parts[1]) return { name: 'demo', id: parts[1] };
  return { name: 'picker', id: null };
}

function show(name) {
  Object.entries(screens).forEach(([k, node]) => {
    node.hidden = k !== name;
  });
  document.body.dataset.screen = name;
}

function route() {
  const next = parseHash();
  const def = next.id ? getRobot(next.id) : null;

  if (next.name !== 'picker' && !def) {
    // A generated demo is not in the registry until its def.json has landed. Resolve it and
    // re-enter, rather than bouncing a perfectly good personal link to the picker.
    if (GEN_ID_RE.test(next.id)) {
      resolveGenerated(next);
      return;
    }
    location.hash = '#/';
    return;
  }

  // leaving a screen
  if (currentRoute.name === 'picker' && next.name !== 'picker') teardownPickerPreviews();
  if (currentRoute.name === 'demo' && !(next.name === 'demo' && next.id === currentRoute.id)) teardownDemo();
  // 'gen' is the transient generated-robot resolve state; it parks its own card in #ingest-mount,
  // so it leaves the connect screen the same way a running ingest does.
  if ((currentRoute.name === 'connect' || currentRoute.name === 'gen') && next.name !== 'connect') {
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

  if (next.name === 'picker') {
    buildPicker();
    show('picker');
    // after show(): the art panels need a real layout rect before the previews read them
    mountPickerPreviews();
    document.title = 'AlloyLogger live demo';
    return;
  }

  if (next.name === 'connect') {
    show('connect');
    buildConnect(def);
    document.title = `Connecting ${def.name} · AlloyLogger`;
    return;
  }

  // demo
  show('demo');
  if (!(prev.name === 'demo' && prev.id === next.id)) buildDemo(def);
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
  if (deep && (getRobot(deep) || GEN_ID_RE.test(deep)) && !location.hash.startsWith('#/demo/')) {
    // keep location.search: dropping it makes the target differ from the current URL by more than
    // the fragment, so the browser does a real navigation and boots the whole page a second time
    location.replace(location.pathname + location.search + `#/demo/${deep}`);
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

export { boot, route, buildDemo, ensureData };
