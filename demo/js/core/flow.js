// flow.js - the four-step mission experience shared by the active mission definitions.

import { track } from './analytics.js';
import { getFlowCopy } from './flow-copy.js';
import { webglAvailable } from './stage3d.js';

const STEPS = Object.freeze(['robot', 'mission', 'failure', 'choose']);
const CTA = Object.freeze({
  robot: 'Next: the mission',
  mission: 'Next: what failed',
  failure: 'How long will this take?',
  choose: 'Ask Alloy',
});
const NEXT = Object.freeze({ robot: 'mission', mission: 'failure', failure: 'choose' });
const DISPLAY_NAMES = Object.freeze({
  arm6: '6-axis pick and place',
  drone: 'Survey quadcopter',
  ssl: 'SSL soccer fleet',
  donna: 'Donna, Jack & Rory',
});
const MISSION_HEADINGS = Object.freeze({
  arm6: 'How the transfer works',
  drone: 'How the survey works',
  ssl: 'How the game works',
  donna: 'How the match works',
});

const flowHandoffs = new Map();

/**
 * Read and clear the copy chosen on step 4. The handoff stays in memory only, so a direct demo URL
 * keeps the definition's normal opener while a completed flow uses its role-specific question.
 *
 * @param {string} missionId
 * @returns {{firstQuestion?:string,followUp?:string}|null}
 */
export function consumeFlowHandoff(missionId) {
  const handoff = flowHandoffs.get(missionId) || null;
  flowHandoffs.delete(missionId);
  return handoff;
}

export function experienceFor(def) {
  return def && def.experience ? def.experience : null;
}

export function hasFlowExperience(def) {
  return !!(def && (def.experience || def.hasExperience));
}

function resolveCopy(def, roleId) {
  return getFlowCopy(def.id, roleId);
}

function fallbackCopy(def) {
  const context = def.context || {};
  return {
    missionIntro:
      context.mission ||
      `Watch ${DISPLAY_NAMES[def.id] || def.name} complete a healthy passage before the failure appears.`,
    failureIntro:
      context.fault || 'The replay and telemetry now isolate the mission finding against the healthy passage.',
    debugCards: [
      { title: 'Telemetry alone', desc: 'Scroll, align, replay, repeat.', time: '~1 day' },
      { title: 'Code', desc: 'Write parsers and reconstruct the mission context.', time: 'Hours' },
      { title: 'Alloy', desc: 'Ask once, then jump straight to the proof.', time: '5 min' },
    ],
    firstQuestion: def.firstQuestion || 'What failed in this mission?',
    followUp: (def.suggested && def.suggested[0]) || 'Show me exactly where it failed.',
  };
}

function roleIdFor(role) {
  if (role && typeof role === 'object') return role.id || null;
  return typeof role === 'string' ? role : null;
}

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

function findingFor(def, experience) {
  const id = experience && experience.failure && experience.failure.findingId;
  return (def.findings || []).find((finding) => finding.id === id) ||
    (def.findings || []).find((finding) => finding.severity === 'alert') ||
    (def.findings || [])[0] || null;
}

function setCamera(viewer, camera) {
  if (viewer) viewer.applyCamera(camera || null);
}

function setOrbit(viewer, enabled) {
  if (viewer) viewer.setOrbit(!!enabled && !reducedMotion());
}

/**
 * @param {object} def
 * @param {object|string|null} role
 * @param {{root:HTMLElement,viewer:HTMLElement,chart:HTMLElement,fallback?:HTMLElement}} mounts
 * @param {{
 *   createTimeline:(duration:number)=>object,
 *   createViewer:(mount:HTMLElement,def:object,timeline:object)=>object,
 *   createChart:(mount:HTMLElement,def:object,timeline:object)=>object,
 *   navigate:(hash:string)=>void,
 *   icon?:string,
 * }} deps
 */
export function createFlow(def, role, mounts, deps) {
  const root = mounts.root;
  const screen = root.closest('#screen-flow');
  const viewerMount = mounts.viewer;
  const chartMount = mounts.chart;
  const roleId = roleIdFor(role);
  const timeline = deps.createTimeline(def.duration);
  let viewer = null;
  let followSuspended = false;
  let followAnchor = null;
  let chart = null;
  let step = null;
  let disposed = false;
  const copy = { ...fallbackCopy(def), ...(resolveCopy(def, roleId) || {}) };

  const title = root.querySelector('#flow-title');
  const intro = root.querySelector('#flow-intro');
  const anatomy = root.querySelector('#flow-anatomy');
  const context = root.querySelector('#flow-context');
  const debug = root.querySelector('#flow-debug');
  const provenance = root.querySelector('#flow-provenance');
  const cta = root.querySelector('#flow-cta');
  const play = root.querySelector('#flow-play');
  const fallback = mounts.fallback || root.querySelector('#flow-fallback');

  function disposeViewer() {
    if (viewer) viewer.dispose();
    viewer = null;
    viewerMount.innerHTML = '';
  }

  /**
   * The viewer follows `sceneApi.cameraFocus()`, and on a mission whose scene is a whole match that
   * point is the BALL. Two of the four steps want something else:
   *
   *   robot    nothing at all. The step holds one instant and labels it, and a live follow drags
   *            the shot off the subject the moment the camera ease lands.
   *   failure  the robot the finding is ABOUT. The kicker fault belongs to one machine; framing the
   *            ball leaves that machine a speck at the top edge whenever play is anywhere else,
   *            which is exactly what it was doing. An experience can name an anchor from the same
   *            additive `anchors()` map the anatomy overlay reads, and the follow tracks that point
   *            instead - so the pose written in `failure.camera` is an offset from the robot rather
   *            than from wherever the ball happens to be.
   *
   * Read at CALL time, not at build time: this mission's anchor factory arrives with its match
   * payload, after the first viewer has already been mounted.
   */
  function viewerDef() {
    if (typeof def.buildScene !== 'function') return def;
    return {
      ...def,
      buildScene(THREE, mount) {
        const sceneApi = def.buildScene(THREE, mount) || {};
        if (typeof sceneApi.cameraFocus !== 'function') return sceneApi;
        const cameraFocus = sceneApi.cameraFocus.bind(sceneApi);
        return {
          ...sceneApi,
          cameraFocus(...args) {
            if (followSuspended) return null;
            if (followAnchor && typeof sceneApi.anchors === 'function') {
              const map = sceneApi.anchors() || {};
              const get = map[followAnchor];
              const p = typeof get === 'function' ? get() : null;
              if (p && Number.isFinite(p.x)) return p;
            }
            return cameraFocus(...args);
          },
        };
      },
    };
  }

  function showViewerFallback() {
    root.classList.add('no-viewer');
    if (!fallback) return;
    fallback.hidden = false;
    const svg = fallback.querySelector('svg');
    if (svg && deps.icon) svg.innerHTML = deps.icon;
  }

  function ensureViewer(mode = 'full', anchor = null) {
    if (disposed) return null;
    followSuspended = mode === 'anatomy';
    followAnchor = followSuspended ? null : anchor;
    if (viewer) return viewer;
    if (!webglAvailable()) {
      showViewerFallback();
      return null;
    }
    try {
      viewer = deps.createViewer(viewerMount, viewerDef(), timeline);
      root.classList.remove('no-viewer');
      if (fallback) fallback.hidden = true;
    } catch (_) {
      showViewerFallback();
    }
    return viewer;
  }

  function ensureChart() {
    if (chart || disposed) return chart;
    chart = deps.createChart(chartMount, def, timeline);
    if (chart.el) chart.el.dataset.mode = 'flow-failure';
    return chart;
  }

  function renderAnatomy(parts) {
    anatomy.innerHTML = '';
    (parts || []).forEach((part, index) => {
      const card = document.createElement('article');
      card.className = `flow-part flow-part-${index + 1}`;
      const h = document.createElement('h2');
      const p = document.createElement('p');
      h.textContent = part.label;
      p.textContent = part.description;
      card.append(h, p);
      anatomy.appendChild(card);
    });
  }

  function renderContext(labels) {
    context.innerHTML = '';
    (labels || []).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'flow-context-row';
      const label = document.createElement('strong');
      label.textContent = typeof item === 'string' ? item : item.label;
      row.appendChild(label);
      if (item && typeof item === 'object' && item.note) {
        const note = document.createElement('span');
        note.textContent = item.note;
        row.appendChild(note);
      }
      context.appendChild(row);
    });
  }

  function renderProvenance(nextStep) {
    if (!provenance) return;
    const value = def.context && def.context.provenance;
    const visible =
      (nextStep === 'robot' || (nextStep === 'failure' && def.id !== 'ssl')) &&
      typeof value === 'string' &&
      !!value.trim();
    provenance.textContent = visible ? value : '';
    provenance.hidden = !visible;
    root.classList.toggle('has-provenance', visible);
  }

  function renderDebug(cards) {
    debug.innerHTML = '';
    (cards || []).slice(0, 3).forEach((item, index) => {
      const card = document.createElement('article');
      card.className = 'flow-debug-card' + (index === 2 ? ' is-choice' : '');
      const h = document.createElement('h2');
      const p = document.createElement('p');
      const time = document.createElement('strong');
      h.textContent = item.title;
      p.textContent = item.desc;
      time.textContent = item.time;
      card.append(h, p, time);
      debug.appendChild(card);
    });
  }

  function applyPlayback(nextStep, experience) {
    const v = ensureViewer(
      nextStep === 'robot' ? 'anatomy' : 'full',
      nextStep === 'failure' ? (experience.failure && experience.failure.followAnchor) || null : null,
    );
    if (v) v.hideBanner();
    if (nextStep !== 'failure' && chart) {
      chart.setDirectLabels(false);
      chart.setMinimalChrome(false);
      chart.resetZoom();
    }
    if (play) play.hidden = true;

    if (nextStep === 'robot') {
      const anatomyConfig = experience.anatomy || {};
      if (v) v.setHighlight(null);
      if (v) {
        root.classList.add('has-viewer-anatomy');
        anatomy.innerHTML = '';
        v.setAnatomy(anatomyConfig.parts || null);
      } else {
        root.classList.remove('has-viewer-anatomy');
        renderAnatomy(anatomyConfig.parts || []);
      }
      setCamera(v, anatomyConfig.camera);
      setOrbit(v, anatomyConfig.rotation === 'orbit');
      const heroT = anatomyConfig.heroT == null
        ? (typeof def.heroTime === 'function' ? def.heroTime() : def.duration * 0.3)
        : anatomyConfig.heroT;
      timeline.setLoop(null, { speed: 1 });
      timeline.seek(heroT);
      timeline.pause();
      return;
    }

    root.classList.remove('has-viewer-anatomy');
    setOrbit(v, false);
    if (v) v.setAnatomy(null);

    if (nextStep === 'mission') {
      const success = experience.success || {};
      if (v) v.setHighlight(null);
      setCamera(v, success.camera);
      const window = success.window || [0, Math.min(def.duration, 6)];
      timeline.setLoop(window, { speed: 1 });
      timeline.seek(window[0]);
      if (v && success.loopLabel) v.showContextBanner(success.loopLabel);
      if (reducedMotion()) {
        timeline.pause();
        if (play) play.hidden = false;
      } else {
        timeline.play();
      }
      return;
    }

    if (nextStep === 'failure') {
      const failure = experience.failure || {};
      const finding = findingFor(def, experience);
      if (!finding) return;
      setCamera(v, failure.camera);
      if (v) v.setHighlight(finding.highlight || null);
      const window = finding.window || [0, def.duration];
      timeline.setLoop(window, { speed: finding.slowmo ? 0.4 : 1 });
      timeline.seek(window[0]);
      if (reducedMotion()) timeline.pause();
      else timeline.play();
      const c = ensureChart();
      const plotted = failure.plottedFields || finding.focus || {};
      c.setDirectLabels(true);
      c.setMinimalChrome(true);
      c.focusWindow({
        window,
        channel: plotted.channel,
        fields: plotted.fields,
        tone: finding.severity === 'alert' ? 'alert' : 'neutral',
        shade: true,
      });
      c.redraw();
      return;
    }

    timeline.pause();
    if (v) v.setHighlight(null);
  }

  function render(nextStep, opts = {}) {
    if (disposed || !STEPS.includes(nextStep)) return;
    step = nextStep;
    const experience = experienceFor(def);
    root.dataset.step = nextStep;
    if (screen) {
      screen.dataset.flowMission = def.id;
      screen.dataset.flowStep = nextStep;
    }
    renderProvenance(nextStep);
    title.textContent =
      nextStep === 'robot'
        ? DISPLAY_NAMES[def.id] || def.name
        : nextStep === 'mission'
          ? MISSION_HEADINGS[def.id] || 'How the mission works'
          : nextStep === 'failure'
            ? 'Now find the failure'
            : 'How do you want to debug it?';

    if (!experience) {
      if (nextStep !== 'robot') throw new Error(`Flow experience for ${def.id} did not load.`);
      intro.hidden = true;
      renderAnatomy([]);
      renderContext([]);
      renderDebug([]);
      cta.querySelector('span').textContent = CTA.robot;
      const v = ensureViewer('anatomy');
      setOrbit(v, false);
      if (v) v.setHighlight(null);
      const heroT = typeof def.heroTime === 'function' ? def.heroTime() : def.duration * 0.3;
      timeline.setLoop(null, { speed: 1 });
      timeline.seek(heroT);
      timeline.pause();
      if (!opts.refresh) track.flowStepShown(def.id, { role: roleId, step: nextStep });
      return;
    }

    intro.textContent = nextStep === 'mission' ? copy.missionIntro : nextStep === 'failure' ? copy.failureIntro : '';
    intro.hidden = nextStep !== 'mission' && nextStep !== 'failure';
    renderAnatomy(nextStep === 'robot' ? experience.anatomy && experience.anatomy.parts : []);
    renderContext(
      nextStep === 'mission' && def.id !== 'ssl'
        ? experience.success && experience.success.contextualLabels
        : [],
    );
    renderDebug(nextStep === 'choose' ? copy.debugCards : []);
    cta.querySelector('span').textContent = CTA[nextStep];
    applyPlayback(nextStep, experience);

    if (!opts.refresh) {
      track.flowStepShown(def.id, { role: roleId, step: nextStep });
      if (nextStep === 'choose') track.debugChoiceShown(def.id, { role: roleId, step: nextStep });
    }
  }

  function onCta() {
    if (disposed || !step) return;
    track.flowStepCta(def.id, { role: roleId, step });
    const nextStep = NEXT[step];
    if (!nextStep) {
      flowHandoffs.set(def.id, {
        firstQuestion: copy.firstQuestion || def.firstQuestion,
        followUp: copy.followUp || '',
      });
    }
    deps.navigate(nextStep ? `#/connect/${def.id}/${nextStep}` : `#/demo/${def.id}`);
  }

  function onPlay() {
    if (disposed || step !== 'mission') return;
    timeline.play();
    play.hidden = true;
  }

  cta.addEventListener('click', onCta);
  if (play) play.addEventListener('click', onPlay);

  return {
    def,
    timeline,
    get viewer() {
      return viewer;
    },
    get chart() {
      return chart;
    },
    get step() {
      return step;
    },
    showStep: render,
    refresh() {
      if (step) render(step, { refresh: true });
    },
    refreshPayload() {
      if (disposed || !step) return;
      disposeViewer();
      if (chart) {
        chart.dispose();
        chart = null;
        chartMount.innerHTML = '';
      }
      render(step, { refresh: true });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cta.removeEventListener('click', onCta);
      if (play) play.removeEventListener('click', onPlay);
      if (chart) chart.dispose();
      disposeViewer();
      timeline.dispose();
      chartMount.innerHTML = '';
      anatomy.innerHTML = '';
      context.innerHTML = '';
      debug.innerHTML = '';
      if (provenance) {
        provenance.textContent = '';
        provenance.hidden = true;
      }
      root.classList.remove('has-viewer-anatomy', 'has-provenance', 'no-viewer');
      delete root.dataset.step;
      if (screen) {
        delete screen.dataset.flowMission;
        delete screen.dataset.flowStep;
      }
    },
  };
}
