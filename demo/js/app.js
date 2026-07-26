// app.js - boot, hash router, robot registry wiring, screen construction and the onEvidence
// orchestration that is the whole point of this demo.
//
// Routes: #/  (picker)  ·  #/connect/:id  ·  #/demo/:id
// ?robot=<id> on any load deep-links straight to #/demo/<id>.

import { ROBOTS, getRobot, ROBOT_ICONS } from './robots/index.js';
import { mulberry32 } from './core/prng.js';
import { createTimeline } from './core/timeline.js';
import { createViewer } from './core/viewer.js';
import { createChart } from './core/chart.js';
import { createChat } from './core/chat.js';
import { createIngest } from './core/ingest.js';
import { createPickerPreviews } from './core/preview.js';

const GITHUB_URL = 'https://github.com/alloyrobotics/alloy-logger-arduino';
const SETUP_URL =
  'https://www.usealloy.ai/setup-org?utm_source=alloylogger.com&utm_medium=referral&utm_campaign=alloylogger&utm_content=demo';

const screens = {
  picker: document.getElementById('screen-picker'),
  connect: document.getElementById('screen-connect'),
  demo: document.getElementById('screen-demo'),
};

/** Stable per-robot seed so two page loads produce identical data. */
function seedFor(id) {
  let h = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h ^ id.charCodeAt(i), 0x85ebca6b) >>> 0) + 1;
  return h >>> 0;
}

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
  ingestApi = createIngest(mount, def, {
    onDone: () => {
      if (currentRoute.name === 'connect' && currentRoute.id === def.id) {
        location.hash = `#/demo/${def.id}`;
      }
    },
  });
}

// ---------------------------------------------------------------------------- demo
let demo = null;

function teardownDemo() {
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
    onAsk: () => clearEvidence(),
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

  timeline.play();
  window.setTimeout(() => {
    // identity, not id: leaving and re-entering the same robot inside 420 ms would otherwise let
    // the stale timer drive the disposed chat instance
    if (demo && demo.chat === chat) chat.askFirstQuestion();
  }, 420);

  // data-analytics-todo: capture('demo_opened', { robot: def.id })
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
    location.hash = '#/';
    return;
  }

  // leaving a screen
  if (currentRoute.name === 'picker' && next.name !== 'picker') teardownPickerPreviews();
  if (currentRoute.name === 'demo' && !(next.name === 'demo' && next.id === currentRoute.id)) teardownDemo();
  if (currentRoute.name === 'connect' && next.name !== 'connect' && ingestApi) {
    ingestApi.dispose();
    ingestApi = null;
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
  // static CTA hrefs
  document.querySelectorAll('[data-cta="github"]').forEach((a) => {
    a.href = GITHUB_URL;
  });
  document.querySelectorAll('[data-cta="setup"]').forEach((a) => {
    a.href = SETUP_URL;
  });

  // ?robot=<id> deep link
  const q = new URLSearchParams(location.search);
  const deep = q.get('robot');
  if (deep && getRobot(deep) && !location.hash.startsWith('#/demo/')) {
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
