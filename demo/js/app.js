// app.js - boot, hash router, robot registry wiring, screen construction and the onEvidence
// orchestration that is the whole point of this demo.
//
// Routes: #/start · #/missions · #/connect/:id[/robot|mission|failure] · #/demo/:id
//
// ROUND 3. The fourth connect step (`/choose`, the three debug-comparison cards) is gone: the
// failure step hands straight to the demo, and the old hash redirects there. The demo screen is
// chat and nothing else - an answer carries its own chart, causal line and live 3D replay inside
// the message (core/embeds.js), so the fixed viewer stage and telemetry pane, and the chat/proof/
// follow-up mode machine that arranged them, no longer exist.
//
// `#/` is not a screen. It is the DOOR, and it always opens on the four-card mission library.
// A first-time visitor picks a mission, chooses their seat, then enters that mission. A visitor
// whose role is already known skips the repeated seat question and enters the picked mission.
//
// ?robot=<id> on any load deep-links to that robot's BRIEF, not to its demo: the brief is where a
// visitor is told what the mission was and what finding the fault costs today, and a deep link that
// skipped it dropped people into a 3D scene with no idea what they were looking at. A second visit
// (sessionStorage, written by the brief itself) goes straight to the demo.

import { PICKER_ROBOTS, getRobot, registerRobot, ROBOT_ICONS } from './robots/index.js';
import { GEN_ID_RE, loadGeneratedRobot } from './robots/generated.js';
import { mulberry32, seedFor } from './core/prng.js';
import { createTimeline } from './core/timeline.js';
import { createViewer } from './core/viewer.js';
import { createChart } from './core/chart.js';
import { createChat } from './core/chat.js';
import { createEvidenceEmbeds } from './core/embeds.js';
import { createIngest } from './core/ingest.js';
import { createPickerPreviews } from './core/preview.js';
import { BRIEF_SEEN_PREFIX, createContext, GENERIC_ICON, briefSeen } from './core/context.js';
import { createSignupPopup, createSignupTriggers } from './core/signup.js';
import { createStart } from './core/start.js';
import { consumeFlowHandoff, createFlow, hasFlowExperience } from './core/flow.js';
import { adoptRole, getRoleId, hasRole, hasExperience } from './core/role.js';
import { initAnalytics, track, capture } from './core/analytics.js';

const GITHUB_URL = 'https://github.com/alloyrobotics/alloy-logger-arduino';
const SETUP_URL =
  'https://www.usealloy.ai/setup-org?utm_source=alloylogger.com&utm_medium=referral&utm_campaign=alloylogger&utm_content=demo';

const screens = {
  start: document.getElementById('screen-start'),
  picker: document.getElementById('screen-picker'),
  connect: document.getElementById('screen-connect'),
  flow: document.getElementById('screen-flow'),
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
// The role fork. The mission has already been picked, so this screen only chooses the register used
// by the rest of that mission. A direct #/start link still works and returns to the library.

let startApi = null;

/** Experience capability, including the temporary arm6 sequencing fallback in flow.js. */
function flowEnabled(def) {
  return hasExperience(def) || hasFlowExperience(def);
}

function connectTarget(def) {
  return flowEnabled(def) ? `#/connect/${def.id}/robot` : `#/connect/${def.id}`;
}

function buildStart(pendingMissionId = null) {
  const mount = screens.start.querySelector('#start-mount');
  if (startApi) startApi.dispose();
  mount.innerHTML = '';
  const pending = pendingMissionId ? getRobot(pendingMissionId) : null;
  startApi = createStart(mount, {
    mission: pending && pending.id,
    copy: pending
      ? { sub: `Choose your seat to personalize the ${PICKER_TITLES[pending.id] || pending.name} mission.` }
      : null,
    // start.js persists the role and fires role_selected before this runs.
    onPick: () => {
      location.hash = pending ? connectTarget(pending) : '#/missions';
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

const PICKER_TITLES = Object.freeze({
  arm6: '6-axis pick and place',
  drone: 'Survey quadcopter',
  ssl: 'SSL soccer fleet',
  donna: 'Donna, Jack & Rory',
});
const PICKER_TAGLINES = Object.freeze({
  arm6: 'A repeatable pick-and-place transfer loop',
  drone: 'An autonomous survey route replay',
});
let pickerSelection = null;

function buildPicker() {
  if (pickerBuilt) return;
  pickerBuilt = true;
  pickerEntries = [];
  const grid = screens.picker.querySelector('#robot-grid');
  const open = screens.picker.querySelector('#picker-open');
  grid.innerHTML = '';

  pickerSelection = PICKER_ROBOTS[0].id;

  function renderSelection() {
    grid.querySelectorAll('.rcard').forEach((card) => {
      const selected = card.dataset.robot === pickerSelection;
      card.classList.toggle('is-selected', selected);
      card.setAttribute('aria-checked', String(selected));
    });
    const def = getRobot(pickerSelection);
    open.querySelector('span').textContent = `Open ${PICKER_TITLES[pickerSelection] || (def && def.name) || 'mission'}`;
  }

  PICKER_ROBOTS.forEach((def) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rcard';
    button.style.setProperty('--acc', def.accent || '#2f78ff');
    button.setAttribute('data-robot', def.id);
    button.setAttribute('role', 'radio');
    button.innerHTML = `
      <div class="rcard-art">
        <svg viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          ${ROBOT_ICONS[def.id] || ''}
        </svg>
      </div>
      <div class="rcard-body">
        <h3 class="rcard-name"></h3>
        <p class="rcard-tag"></p>
      </div>`;
    button.querySelector('.rcard-name').textContent = PICKER_TITLES[def.id] || def.name;
    button.querySelector('.rcard-tag').textContent = PICKER_TAGLINES[def.id] || def.tagline;
    button.addEventListener('click', () => {
      pickerSelection = def.id;
      renderSelection();
    });
    grid.appendChild(button);
    pickerEntries.push({ el: button.querySelector('.rcard-art'), def });
  });

  open.addEventListener('click', () => {
    const def = getRobot(pickerSelection);
    const card = grid.querySelector(`.rcard[data-robot="${pickerSelection}"]`);
    const art = card && card.querySelector('.rcard-art');
    if (!def || !art) return;
    const roleKnown = hasRole();
    if (roleKnown) {
      const r = art.getBoundingClientRect();
      const svg = art.querySelector('svg');
      const g = svg ? svg.getBoundingClientRect() : null;
      heroHandoff = {
        id: def.id,
        at: performance.now(),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        ghost: g && g.height ? { w: g.width, h: g.height } : null,
        live: art.classList.contains('preview-live'),
        phase: (pickerPreviews && pickerPreviews.phaseFor ? pickerPreviews.phaseFor(def.id) : null) || null,
      };
    } else {
      heroHandoff = null;
    }
    location.hash = roleKnown ? connectTarget(def) : `#/start/${def.id}`;
  });

  renderSelection();
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

// ---------------------------------------------------------------------------- flow
let flowApi = null;

function markFlowSeen(id) {
  if (!id) return;
  try {
    window.sessionStorage.setItem(BRIEF_SEEN_PREFIX + id, '1');
  } catch (_) {
    // Storage can be unavailable. Repeating the flow on the next doorway visit is the safe fallback.
  }
}

function teardownFlow() {
  if (!flowApi) return;
  flowApi.dispose();
  flowApi = null;
  delete window.__flow;
}

function buildFlow(def, step) {
  // The robot step can mount from previewData while a lazy replay is still loading. Every later
  // step reaches this function only after the route gate has loaded the payload, so its chart data
  // can be built safely before the shared flow instance is reused.
  if (step !== 'robot' || typeof def.loadSceneData !== 'function') ensureData(def);
  if (!flowApi || flowApi.def.id !== def.id) {
    teardownFlow();
    const host = screens.flow;
    host.style.setProperty('--acc', def.accent || '#2f78ff');
    host.querySelector('#flow-name').textContent = PICKER_TITLES[def.id] || def.name;
    flowApi = createFlow(
      def,
      getRoleId(),
      {
        root: host.querySelector('#flow-mount'),
        viewer: host.querySelector('#flow-viewer-mount'),
        chart: host.querySelector('#flow-chart-mount'),
        fallback: host.querySelector('#flow-fallback'),
      },
      {
        createTimeline,
        createViewer,
        createChart,
        navigate: (hash) => {
          location.hash = hash;
        },
        icon: ROBOT_ICONS[def.id] || '',
      },
    );
    window.__flow = flowApi;
  }
  screens.flow.querySelector('#flow-progress').textContent = `${['robot', 'mission', 'failure'].indexOf(step) + 1} / 3`;
  flowApi.showStep(step);
}

function primeRobotFlow(def, next) {
  if (typeof def.loadSceneData !== 'function') return;
  if ((def.isSceneDataLoaded && def.isSceneDataLoaded()) && def.experience) return;
  const gen = navGen;
  scenePending.add(def.id);
  Promise.resolve(def.loadSceneData()).then(
    () => {
      scenePending.delete(def.id);
      sceneSettled.add(def.id);
      if (gen !== navGen) return;
      const current = parseHash();
      if (current.name === 'flow' && current.id === def.id && current.step === 'robot' && flowApi) {
        try {
          ensureData(def);
          flowApi.refreshPayload();
        } catch (err) {
          renderSceneUnavailable(def, err);
        }
      }
    },
    (err) => {
      scenePending.delete(def.id);
      sceneSettled.add(def.id);
      if (gen !== navGen) return;
      const current = parseHash();
      if (current.name === 'flow' && current.id === def.id && current.step === 'robot') renderSceneUnavailable(def, err);
    },
  );
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
  // EMBEDS FIRST, and this order is the whole teardown. The blocks own the one WebGL context, a
  // chart per block and the activation observers, and every one of those elements lives inside a
  // chat row: disposing the chat first would detach the rows out from under a renderer that is
  // still holding a canvas in one of them, and the context would ride the detached tree until the
  // collector got to it. The clock goes last, because both of the others are subscribed to it.
  demo.embeds.dispose();
  demo.chat.dispose();
  demo.timeline.dispose();
  demo = null;
  delete screens.demo.dataset.mode;
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
    // whatever screen the failure lands on.
    if (signupTriggers) {
      signupTriggers.dispose();
      signupTriggers = null;
      delete window.__signup;
    }
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

/**
 * The round-1 opener beat: after 420 ms, ask the scripted first question on the visitor's behalf.
 *
 * Lifted out of buildDemoInner so the delay and identity guard stay isolated from construction.
 * Every mission uses this one opener path.
 *
 * @param {object} chat the chat instance this timer is allowed to drive
 * @param {string|null} [question] role-specific opener handed off by the completed flow
 * @param {string|null} [fallbackQuestion] definition opener when the role copy does not resolve
 */
function openerBeat(chat, question = null, fallbackQuestion = null) {
  window.setTimeout(() => {
    // identity, not id: leaving and re-entering the same robot inside 420 ms would otherwise let
    // the stale timer drive the disposed chat instance
    if (!demo || demo.chat !== chat) return;
    if (question) {
      const resolved = chat.matchEntry(question) ? question : fallbackQuestion;
      if (resolved) chat.ask(resolved, { live: false, opener: true });
      else chat.askFirstQuestion();
    } else chat.askFirstQuestion();
  }, 420);
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

  /**
   * `data-mode` used to be a three-state layout machine (chat -> proof -> follow-up) that moved a
   * fixed 3D stage and a telemetry pane in and out of a grid. Round 3 deleted all three panes and
   * the machine with them: the evidence lives inside the answer that cites it, so there is nothing
   * left to arrange. The attribute survives as ONE constant value because chat.js hangs the wall's
   * answer typography off it; nothing branches on it any more.
   */
  const modeEnabled = flowEnabled(def);
  const flowHandoff = modeEnabled ? consumeFlowHandoff(def.id) : null;
  host.dataset.mode = 'chat';

  host.querySelector('#demo-name').textContent = def.name;
  host.querySelector('#demo-device').textContent = def.device;

  // The PARK for the one shared WebGL context, not a panel. It keeps the id `#viewer-mount`
  // deliberately: it is still the single place a demo-screen renderer is ever mounted, and the
  // leak and teardown probes that count canvases under that id are asking exactly the right
  // question about the new architecture too.
  const park = host.querySelector('#viewer-mount');
  const chatMount = host.querySelector('#chat-mount');
  park.innerHTML = '';
  chatMount.innerHTML = '';

  const timeline = own(createTimeline(def.duration));

  /**
   * Built after the chat panel, because the transcript's scroll container is the thing activation
   * is measured against, and `chat.el` is where that container lives. Declared here so the two
   * hooks below can close over it.
   */
  let embeds = null;
  let chat = null;
  let firstAnswerSettled = false;

  /**
   * THE money interaction, relocated.
   *
   * It used to be a fixed sequence over three panels that lived somewhere else on the screen: flash
   * the scrubber marker, loop the window, re-aim the chart, pulse the part, raise a banner. Every
   * one of those still happens - they are what `embeds.play()` does when a block takes the shared
   * context - except that they happen INSIDE the message that cited the finding, and the scroll
   * that brings the reader to it is part of the same act.
   *
   * @param {object} finding
   * @param {{source?: 'user'|'auto'}} [opts] WHO fired it. The demo plays the scripted first
   *   answer's evidence for the visitor exactly once (`source: 'auto'`); everything else is a real
   *   click, and only a real click is the aha this funnel measures. The default stays 'user' for
   *   the same reason it always did: over-counting one block per demo is the safe direction.
   */
  function onEvidence(finding, opts) {
    if (!finding || !embeds) return;
    if (!embeds.play(finding, opts || {})) return;
    const source = opts && opts.source;
    if (source === 'auto') track.evidenceAutoPlayed(def.id, finding.id);
    else track.evidenceUserClicked(def.id, finding.id);
  }

  chat = own(
    createChat(chatMount, def, {
      onEvidence,
      /**
       * Every evidence-bearing answer gets its evidence, in the answer. Scripted openers, scripted
       * suggestions and live streamed answers all arrive here, because all three settle through the
       * same typewriter and the same hydrate pass; the host does not need to know which was which.
       */
      onEvidenceBlock: (row, findings) => {
        if (!embeds) return false;
        return embeds.attach(row, findings).length > 0;
      },
      onSettled: () => {
        if (signupTriggers) signupTriggers.chatSettled();
        if (firstAnswerSettled) return;
        firstAnswerSettled = true;
        // The completed flow's role-specific follow-up, offered as the composer's placeholder. A
        // follow-up is an ordinary message now: there is no mode for it to switch the screen into.
        if (flowHandoff && flowHandoff.followUp) {
          const input = chat.el.querySelector('.chat-input');
          if (input) input.placeholder = flowHandoff.followUp;
        }
      },
    }),
  );

  embeds = own(
    createEvidenceEmbeds({
      def,
      timeline,
      park,
      scroller: chat.el.querySelector('.chat-log'),
      icon: ROBOT_ICONS[def.id] || GENERIC_ICON,
    }),
  );

  demo = {
    def,
    timeline,
    chat,
    embeds,
    onEvidence,
    /** QA/integration: the live block's replay and chart, wherever in the transcript they are. */
    get viewer() {
      return embeds.viewer;
    },
    get chart() {
      return embeds.chart;
    },
    get evidence() {
      return embeds.activeFinding;
    },
  };
  // exposed for QA/integration assertions (page state, not pixels)
  window.__demo = demo;

  // Installed here, after the chat node exists, because the machine arms off THAT surface now: the
  // composer, the suggestion chips, and the charts and replays that arrive inside answers. Every
  // one of those is created after this point, so the machine delegates rather than snapshotting.
  // Generated demos get it too: that visitor is the warmest lead on the page.
  if (signupPopup) {
    signupTriggers = createSignupTriggers({
      host,
      popup: signupPopup,
      isDemoRoute: () => currentRoute.name === 'demo',
      isStreaming: () => chat.streaming,
      experience: modeEnabled,
    });
    window.__signup = signupTriggers;
  }

  timeline.play();

  openerBeat(chat, flowHandoff && flowHandoff.firstQuestion, def.firstQuestion || null);

  capture('demo_opened', { robot: def.id, guided: false, mode: modeEnabled ? 'chat' : 'legacy' });
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
  if (currentRoute.name === 'flow') teardownFlow();
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
 * Robot ids whose `loadSceneData()` promise has SETTLED at least once in this session, resolved or
 * rejected.
 *
 * A lazy mission's experience and role opener ride the same promise as its scene payload, but
 * `isSceneDataLoaded()` can flip true one HTTP round trip before that side module lands. This set
 * keeps route entry waiting on the composed promise, then lets the existing missing-experience
 * fallback decide whether the three-step flow is still available.
 */
const sceneSettled = new Set();

/**
 * A lazy definition may advertise the three-step flow before its small experience side module lands.
 * If the composed load settles without attaching that block, the static flag is no longer truthful:
 * clear it and replace the step/demo hash with the tested legacy brief. The generation and current
 * hash checks keep an old continuation from pulling a newer navigation back to this mission.
 */
function fallbackMissingLazyExperience(def, generation = navGen) {
  if (
    generation !== navGen ||
    parseHash().id !== def.id ||
    typeof def.loadSceneData !== 'function' ||
    !def.hasExperience ||
    def.experience ||
    !sceneSettled.has(def.id)
  ) {
    return false;
  }
  def.hasExperience = false;
  teardownFlow();
  location.replace(location.pathname + location.search + `#/connect/${def.id}`);
  return true;
}

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
    teardownFlow();
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
  if (currentRoute.name === 'flow') teardownFlow();
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
      // Before stale(): the promise settled whether or not this pass still owns the screen, and the
      // route gate reads this to decide whether waiting again could ever produce different beats.
      sceneSettled.add(next.id);
      if (stale()) return;
      if (fallbackMissingLazyExperience(def, gen)) return;
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
      sceneSettled.add(next.id);
      if (stale()) return;
      unavailable(err);
    },
  );
}

// ---------------------------------------------------------------------------- router
let currentRoute = { name: 'start', id: null };
let rolePresetAtBoot = false;
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
 * 'home' is the fifth and it is not a screen: `#/` and unknown hashes resolve to the mission
 * library. A start route may carry the mission selected one screen earlier as `#/start/:id`.
 */
function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'connect' && parts[1] && ['robot', 'mission', 'failure'].includes(parts[2])) {
    return { name: 'flow', id: parts[1], step: parts[2] };
  }
  // The retired fourth step. Kept as a NAMED route rather than falling through to the picker
  // bounce, because it is a hash real sessions have in their history and a bookmark someone may
  // have kept: it belongs in the demo, which is the screen it used to be one tap away from.
  if (parts[0] === 'connect' && parts[1] && parts[2] === 'choose') {
    return { name: 'choose-gone', id: parts[1] };
  }
  if (parts[0] === 'connect' && parts[1]) return { name: 'connect', id: parts[1] };
  if (parts[0] === 'demo' && parts[1]) return { name: 'demo', id: parts[1] };
  if (parts[0] === 'missions') return { name: 'picker', id: null };
  if (parts[0] === 'start') return { name: 'start', id: parts[1] || null };
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

  // `#/` and unknown hashes are the door, not a screen. REPLACE, never assign: keeping a dead door
  // behind the redirect makes Back bounce forward again. Every visitor starts from the same mission
  // library, regardless of whether a role has already been adopted.
  if (next.name === 'home') {
    location.replace(location.pathname + location.search + '#/missions');
    return;
  }

  // The retired fourth step, redirected rather than 404ed. REPLACE, not assign, and before the
  // registry is consulted: pushing would leave the dead hash in history for the Back button to
  // bounce off, and a generated id that is not registered yet resolves on the next pass exactly as
  // a `#/demo/g-...` hash typed by hand does.
  if (next.name === 'choose-gone') {
    location.replace(location.pathname + location.search + `#/demo/${next.id}`);
    return;
  }

  const def = next.id ? getRobot(next.id) : null;

  // Review and embed URLs may arrive with both a preset role and a pending mission. The plain
  // #/start review frame remains the fork, but the new pending route does not ask the adopted role
  // a second time.
  if (next.name === 'start' && next.id && rolePresetAtBoot && hasRole() && def) {
    location.replace(location.pathname + location.search + connectTarget(def));
    return;
  }

  if (next.name === 'start' && next.id && !def) {
    location.replace(location.pathname + location.search + '#/missions');
    return;
  }

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

  if ((next.name === 'flow' || next.name === 'demo') && fallbackMissingLazyExperience(def)) return;

  if (next.name === 'connect' && flowEnabled(def)) {
    location.replace(location.pathname + location.search + `#/connect/${def.id}/robot`);
    return;
  }
  if (next.name === 'flow' && !flowEnabled(def)) {
    location.replace(location.pathname + location.search + `#/connect/${def.id}`);
    return;
  }

  // leaving a screen
  if (currentRoute.name === 'start' && next.name !== 'start') teardownStart();
  if (currentRoute.name === 'picker' && next.name !== 'picker') teardownPickerPreviews();
  if (currentRoute.name === 'flow' && !(next.name === 'flow' && next.id === currentRoute.id)) teardownFlow();
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
    buildStart(next.id);
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

  if (next.name === 'flow') {
    const needsPayload =
      typeof def.loadSceneData === 'function' &&
      (!(def.isSceneDataLoaded && def.isSceneDataLoaded()) ||
        (def.hasExperience && !def.experience && !sceneSettled.has(def.id)));
    if (needsPayload) {
      resolveSceneData(next, def);
      return;
    }
    markFlowSeen(def.id);
    show('flow');
    try {
      buildFlow(def, next.step);
    } catch (err) {
      renderSceneUnavailable(def, err);
      return;
    }
    if (next.step === 'robot') primeRobotFlow(def, next);
    document.title = `${PICKER_TITLES[def.id] || def.name} · ${next.step} · AlloyLogger`;
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
  //
  // The second clause waits for the experience side module after the scene decoder has resolved.
  // See `sceneSettled`, which keeps that a single wait rather than a loop.
  if (
    typeof def.loadSceneData === 'function' &&
    (!(def.isSceneDataLoaded && def.isSceneDataLoaded()) ||
      (hasExperience(def) && !def.experience && !sceneSettled.has(def.id)))
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
  const q = new URLSearchParams(location.search);

  // An embedding page can preset the visitor's seat without pretending they tapped the fork.
  // Adoption runs before analytics reads the stored role and before the doorway router decides
  // where #/ opens. The query string stays in place, exactly like the ?robot= deep link below.
  const deepRole = q.get('role');
  if (deepRole != null) rolePresetAtBoot = !!adoptRole(deepRole);

  // CTA hrefs. A ?src=<channel> tag on the demo URL (dm, dm_fu, bio) is forwarded into the
  // setup-org CTAs as utm_content "<channel>-demo", same idea as the landing page's passthrough,
  // so PostHog keeps channel attribution when the DM or bio points here instead of the landing.
  // Clamped to the server's 64-char tag limit: an oversized crafted ?src= must never bloat the
  // signup-lead body toward its 8KB cap and sink an otherwise valid submission.
  const srcTag = (q.get('src') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
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
    const deepDef = getRobot(deep);
    const target = briefSeen(deep) ? `#/demo/${deep}` : deepDef && flowEnabled(deepDef) ? `#/connect/${deep}/robot` : `#/connect/${deep}`;
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
