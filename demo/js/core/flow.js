// flow.js - the three-step mission experience shared by the active mission definitions.
//
// ROUND 3 removed the fourth step. `#/connect/:id/choose` asked "how do you want to debug it?" and
// answered it with three comparison cards, one screen before a demo whose entire job is to answer
// the same question by doing it. The failure step now hands straight to `#/demo/:id`, and app.js
// redirects any surviving link to the old hash there too.

import { track } from './analytics.js';
import { getFlowCopy } from './flow-copy.js';
import { webglAvailable } from './stage3d.js';

const STEPS = Object.freeze(['robot', 'mission', 'failure']);
const CTA = Object.freeze({
  robot: 'Next: the mission',
  mission: 'Next: what failed',
  failure: 'Ask Alloy',
});
const NEXT = Object.freeze({ robot: 'mission', mission: 'failure' });
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
 * Read and clear the copy chosen by the completed flow. The handoff stays in memory only, so a
 * direct demo URL keeps the definition's normal opener while a completed flow uses its role-specific question.
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
      // ROUND 11 stopped this sentence promising a replay. It used to open "Watch <robot> complete a
      // healthy passage", and the mission step is no longer always a replay of one: a def that
      // declares `experience.success.footage` answers this step with real footage of that class of
      // machine instead. What the step is about - the work, and the failure waiting after it - is
      // true either way, so the copy says that and not which of the two is on screen.
      `How ${DISPLAY_NAMES[def.id] || def.name} does its work, before the failure appears.`,
    failureIntro:
      context.fault || 'The replay and telemetry now isolate the mission finding against the healthy passage.',
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
  const provenance = root.querySelector('#flow-provenance');
  const cta = root.querySelector('#flow-cta');
  const play = root.querySelector('#flow-play');
  const fallback = mounts.fallback || root.querySelector('#flow-fallback');
  // The panel the replay is drawn in, which is also where the footage layer mounts. NOT the viewer
  // mount: `disposeViewer()` empties that element, and `refreshPayload()` calls it on every step.
  const viewerFrame =
    (viewerMount.closest && viewerMount.closest('.flow-viewer-frame')) || viewerMount.parentElement;
  /** The play button's authored label, restored whenever the step is the sim again. */
  const playLabel = play ? play.textContent : '';
  let footageWrap = null;
  let footageVideo = null;
  let footageLive = false;
  /** Set once, for the session: this flow tried the footage, the media refused, run the sim. */
  let footageGaveUp = false;

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

  /**
   * ROUND 11. THE MISSION STEP IS THE CONTEXT BEAT, AND CONTEXT IS THE REAL WORLD.
   *
   * "How the game works", "How the survey works": this is the one step whose whole job is to say
   * what kind of machine this is and what the work looks like, and a synthesized replay is the
   * weakest available answer to that question. It asks a visitor to take the sim's word for a world
   * they have never seen. So a def may declare `experience.success.footage` and the step plays REAL
   * footage of that CLASS of robot doing that kind of work instead. The sim keeps the two steps
   * where it is the evidence rather than the illustration: the anatomy step, where it IS the
   * machine, and the failure step, where it is the finding.
   *
   * WHAT THE FOOTAGE IS NOT is as load-bearing as what it is. It is not the logged mission, it
   * cannot be, and the note chip says so on the video itself - see the honesty rules in
   * `demo/UX-PORT-PLAN.md`. That is also why the contextual labels stand down for the duration: they
   * quote numbers measured off THIS log, and beside real footage of another machine they would read
   * as a description of what is on screen.
   *
   * FOOTAGE IS OPTIONAL, AND ITS ABSENCE IS THE OLD BEHAVIOUR EXACTLY. Every def without the key -
   * battle, sbr, rescue, the stub, every generated g-* def - runs the success loop as it always has,
   * and every read of it below is guarded.
   *
   * AND IT FAILS OPEN. A blocked request, a 404, a codec a browser will not take: the video's own
   * `error` event, or a play() rejection with a media error behind it, retires the footage for the
   * session and re-renders this step as the sim - success loop, authored camera, contextual labels.
   * The worst case is the experience that shipped before this round, never a black panel.
   *
   * @param {object|null} experience
   * @returns {{src:string,poster:string,note?:string}|null}
   */
  function footageFor(experience) {
    if (footageGaveUp) return null;
    const footage = experience && experience.success && experience.success.footage;
    if (!footage || !footage.src || !footage.poster) return null;
    return footage;
  }

  /**
   * Build the layer the first time a footage step renders, and never in the boot path: a def that
   * declares footage and a visitor who never reaches its mission step cost one property read.
   */
  function buildFootage(footage) {
    if (footageVideo) return footageVideo;
    if (!viewerFrame) return null;
    const wrap = document.createElement('figure');
    wrap.className = 'flow-footage';
    wrap.id = 'flow-footage';
    const video = document.createElement('video');
    video.className = 'flow-footage-video';
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    // The attribute as well as the property: iOS reads the attribute, and without it this goes
    // fullscreen on tap on the one class of device the panel is narrowest on.
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.preload = 'metadata';
    video.tabIndex = -1;
    // Decoration, not content: the note beside it carries the meaning, and the step's own heading
    // and intro carry the claim. A screen reader gets those rather than an unlabelled video.
    video.setAttribute('aria-hidden', 'true');
    video.poster = footage.poster;
    video.addEventListener('error', onFootageError);
    const note = document.createElement('figcaption');
    note.className = 'flow-footage-note';
    wrap.append(video, note);
    // Before the play button, which keeps its own z-index above the layer.
    viewerFrame.insertBefore(wrap, play && play.parentNode === viewerFrame ? play : null);
    footageWrap = wrap;
    footageVideo = video;
    return video;
  }

  function startFootage(footage) {
    const video = buildFootage(footage);
    if (!video) return false;
    footageWrap.querySelector('.flow-footage-note').textContent = footage.note || '';
    footageWrap.hidden = false;
    footageLive = true;
    root.classList.add('has-footage');
    // The src is set AFTER the poster and the class, so the first thing painted is the poster in the
    // layout the video will land in, and re-entering the step does not refetch what is already here.
    const src = String(footage.src);
    if (video.dataset.src !== src) {
      video.dataset.src = src;
      video.src = src;
    }
    if (reducedMotion()) {
      // The visitor asked for no motion. The poster IS the step for them, and the existing play
      // button - the one that used to start the success loop - starts the video instead.
      try {
        video.pause();
      } catch (_) {
        // A media element that will not pause is a media element that never started.
      }
      if (play) play.hidden = false;
      return true;
    }
    playFootage();
    return true;
  }

  function playFootage() {
    if (!footageVideo) return;
    let started = null;
    try {
      started = footageVideo.play();
    } catch (_) {
      onFootageError();
      return;
    }
    if (!started || typeof started.catch !== 'function') return;
    started.catch(() => {
      if (disposed || !footageVideo) return;
      // TWO DIFFERENT FAILURES WEAR THE SAME REJECTION. A media error means there is no video and
      // the step has to fall back to the sim. An autoplay refusal means the video is fine and the
      // browser wants a gesture, and the poster plus the step's own play button is the honest
      // resting state for that - falling back to the sim there would throw away a working panel.
      if (footageVideo.error) onFootageError();
      else if (play && footageLive && step === 'mission') play.hidden = false;
    });
  }

  /**
   * FAIL OPEN. Retire the footage for this flow instance and re-render the step the visitor is on,
   * which puts the mission step back exactly as it shipped before this round.
   */
  function onFootageError() {
    if (footageGaveUp) return;
    footageGaveUp = true;
    hideFootage();
    if (!disposed && step === 'mission') render('mission', { refresh: true });
  }

  /**
   * @param {boolean} [remove] tear the element down as well, which only teardown wants: keeping it
   *   across steps is what makes returning to the mission step a resume rather than a refetch.
   */
  function hideFootage(remove = false) {
    footageLive = false;
    root.classList.remove('has-footage');
    if (footageVideo) {
      try {
        footageVideo.pause();
      } catch (_) {
        // Nothing to pause is the outcome this wants anyway.
      }
    }
    if (footageWrap) footageWrap.hidden = true;
    if (!remove) return;
    if (footageVideo) {
      footageVideo.removeEventListener('error', onFootageError);
      // Drop the source before the element goes, so a half-finished fetch is abandoned rather than
      // left to complete against a node nobody holds.
      footageVideo.removeAttribute('src');
      try {
        footageVideo.load();
      } catch (_) {
        // Same as above: a media element that cannot reload has nothing in flight.
      }
    }
    if (footageWrap && footageWrap.parentNode) footageWrap.parentNode.removeChild(footageWrap);
    footageWrap = null;
    footageVideo = null;
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

  function applyPlayback(nextStep, experience, footage) {
    if (footage) {
      // FOOTAGE OWNS THIS STEP, and no viewer is built for it. A hidden WebGL context is a cost with
      // nothing on the other side of it, and a visitor who lands straight on `#/connect/<id>/mission`
      // should not pay for one; a viewer that already exists (they came from the anatomy step) is
      // left mounted and idle behind the layer, so the failure step still reuses the one context
      // this screen is allowed.
      if (viewer) {
        viewer.hideBanner();
        viewer.setAnatomy(null);
        viewer.setHighlight(null);
        setOrbit(viewer, false);
      }
      root.classList.remove('has-viewer-anatomy');
      if (chart) {
        chart.setDirectLabels(false);
        chart.setMinimalChrome(false);
        chart.resetZoom();
      }
      if (play) {
        play.hidden = true;
        play.textContent = 'Play the footage';
      }
      // The timeline is PAUSED rather than looped: the mission clock drives the sim, the sim is not
      // on screen, and a loop nobody can see is a frame budget spent on nothing.
      timeline.setLoop(null, { speed: 1 });
      timeline.pause();
      startFootage(footage);
      return;
    }
    if (play) play.textContent = playLabel;
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
      // NO context banner. `success.loopLabel` used to be painted over the top-left of the replay
      // as a standing chip ("success loop"), which round 3 called out: the step's own heading and
      // intro already say what the loop is, so the chip was a label on a label, sitting on the one
      // part of the panel the robot is framed in. The experiences keep declaring the label - it is
      // the step's authored name for the passage - and nothing renders it over the 3D any more.
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
      // ROUND 5 SPLIT THE REPLAY LOOP OFF THE CHART WINDOW.
      //
      // Both used to be `finding.window`, and that window is written for the CHART: it has to hold
      // enough of the trace either side of the event that the step in it means something (ssl's
      // kicker sawtooth needs 16 s before the reader can see it never reaches 240 V). Looping the
      // same span put 8 to 20 wall-clock seconds of mostly-nothing between one sight of the failure
      // and the next - at 0.4x, ssl's window ran 41 s a lap - and the note on the round was that
      // every mission's replay was "way too long".
      //
      // So a finding may now declare `loop`: the tight replay span, roughly half a second of
      // healthy motion, the failure, half a second of the settled fail state. `window` still
      // decides what the chart plots and shades, so the trace keeps its context while the 3D
      // replays only the moment. A finding with no `loop` loops its window exactly as before.
      //
      // The loop is allowed to open slightly BEFORE the chart window (donna's fall onset IS the
      // window's left edge, and the healthy half-second sits behind it). That is safe up to the
      // 15% pad `chart.applyFocusWindow` puts around the shaded region: inside the padded domain
      // the playhead is still drawn, so it sweeps rather than parking off the edge.
      const loop = finding.loop || window;
      timeline.setLoop(loop, { speed: finding.slowmo ? 0.4 : 1 });
      timeline.seek(loop[0]);
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
          : 'Now find the failure';

    if (!experience) {
      if (nextStep !== 'robot') throw new Error(`Flow experience for ${def.id} did not load.`);
      hideFootage();
      intro.hidden = true;
      renderAnatomy([]);
      renderContext([]);
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
    // Resolved once per render and handed to `applyPlayback`, because the same answer decides two
    // things: whether the panel plays footage, and whether the contextual labels may be shown beside
    // it. They must not disagree.
    const footage = nextStep === 'mission' ? footageFor(experience) : null;
    if (!footage) hideFootage();
    renderContext(
      nextStep === 'mission' && def.id !== 'ssl' && !footage
        ? experience.success && experience.success.contextualLabels
        : [],
    );
    cta.querySelector('span').textContent = CTA[nextStep];
    applyPlayback(nextStep, experience, footage);

    if (!opts.refresh) track.flowStepShown(def.id, { role: roleId, step: nextStep });
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

  /**
   * The mission step's one affordance, and it is STEP-AWARE rather than timeline-aware: on a footage
   * step it starts the video, on a sim step it starts the success loop. Both are "play what this step
   * is about", which is what a visitor under reduced motion pressed it for.
   */
  function onPlay() {
    if (disposed || step !== 'mission') return;
    if (footageLive && footageVideo) {
      playFootage();
      play.hidden = true;
      return;
    }
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
    /** The live footage element, or null when this step is the sim. Read by the browser walk. */
    get footage() {
      return footageLive ? footageVideo : null;
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
      if (play) {
        play.removeEventListener('click', onPlay);
        play.textContent = playLabel;
      }
      // Element and listener both, because the leak probe counts a listener on any connected node.
      hideFootage(true);
      if (chart) chart.dispose();
      disposeViewer();
      timeline.dispose();
      chartMount.innerHTML = '';
      anatomy.innerHTML = '';
      context.innerHTML = '';
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
