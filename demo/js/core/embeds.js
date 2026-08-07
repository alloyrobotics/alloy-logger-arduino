// embeds.js - the inline evidence block, and the single-context virtualization that makes a chat
// transcript full of 3D replays affordable.
//
// ---------------------------------------------------------------------------- what this replaces
// Until round 3 an answer CITED its evidence and something else showed it: a chip in the bubble
// seeked a fixed 46 dvh viewer stage and a chart pane that lived outside the conversation. The
// visitor had to notice the chip, press it, and then look somewhere else. Everything that made the
// demo worth opening happened off to the side of the thing they were reading.
//
// Now the evidence IS the answer. An evidence-bearing message carries, inside its own bubble:
//
//   1. an annotated chart of the channels the finding is about, zoomed onto its window, seekable
//   2. one short paragraph saying what the trace means (the causal line)
//   3. the 3D replay of those same seconds, live, in the message
//
// ---------------------------------------------------------------------------- the WebGL budget
// One context per message is not an option. Chrome kills the oldest live context somewhere around
// sixteen, iOS Safari sooner, and a transcript has no upper bound. So there is exactly ONE viewer
// for the whole screen and it is physically MOVED into whichever block is nearest the middle of
// the reader's view. Every other block shows a poster: a still captured off the shared renderer at
// the instant it handed the context on (viewer.capturePoster(), which renders and reads the buffer
// in one task because the renderer keeps no drawing buffer between frames).
//
// This is the same discipline core/preview.js applies to the picker cards, arrived at from the
// other end. The picker has FOUR fixed rects in one scrolling grid, so it scissors one canvas into
// all four. A transcript has an unbounded number of rects, arriving over time, at unbounded scroll
// depth, so a canvas sized to the whole log would hit the backing-store ceiling on a long
// conversation. Moving one modest canvas is the version of that idea that survives an unbounded
// list.
//
// Reparenting a canvas does not disturb its context, which is what makes the move cheap: no
// renderer teardown, no scene rebuild, no reallocation. The visible cost is one frame of resize.
//
// ---------------------------------------------------------------------------- the shared clock
// All blocks read the ONE mission timeline, exactly as the fixed panes did. Seeking any block's
// chart moves the mission clock, which moves the live replay. That is the point: a block is a
// window onto one mission, not a private copy of it. Taking the context is what makes a block's
// own finding the active loop.

import { createChart } from './chart.js';
import { createViewer } from './viewer.js';
import { webglAvailable } from './stage3d.js';

/** How far a block's centre may sit from the reader's centre and still be worth activating. */
const ACTIVATE_SLACK = 1.35; // in viewport heights

/**
 * A claimed reservation must be witnessed before ready resources are allowed through its skeleton.
 * The chart and shared viewer may warm underneath it immediately; these gates control presentation,
 * not allocation, so even the instant scripted opener progresses without adding much real latency.
 */
const CHART_SKELETON_MS = 700;
const CHART_TO_PROSE_MS = 180;
const PROSE_WORD_MS = 28;
const PROSE_TO_REPLAY_MS = 240;
const REPLAY_SKELETON_MS = 1300;

/** Blocks per answer. Two is the most any authored or streamed answer cites in practice. */
export const MAX_BLOCKS_PER_ANSWER = 2;

/**
 * How long the causal line is allowed to be.
 *
 * A finding's `note` was written for the FACTS PACK the analyst answers from, where length is free
 * and precision is everything: the ssl kicker note runs to seven hundred characters of modelled
 * voltages, and dropping that whole paragraph between a chart and a replay would bury both. So the
 * block takes whole sentences off the front until the next one would not fit, and the full note is
 * still what the analyst quotes in prose above.
 */
const NOTE_CHARS = 300;

/**
 * Split prose into sentences, without splitting numbers.
 *
 * These notes are dense with measurements: "8.4 s", "41.95 s", "236 V". A naive split on `[.!?]`
 * cuts every one of them in half, and half a measurement on screen beside a chart is not a
 * shortened sentence, it is a wrong number. So a terminator only ends a sentence when it is
 * followed by whitespace AND the next non-space character opens one (a capital, a quote, a
 * bracket). `8.4` fails both halves of that test and `V. Given` passes.
 *
 * Written as a scan rather than a lookbehind regex on purpose: lookbehind is a PARSE error on
 * older Safari, and a parse error in this module takes the whole demo screen with it.
 *
 * @param {string} src @returns {string[]}
 */
function splitSentences(src) {
  const out = [];
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
  const opens = (c) => (c >= 'A' && c <= 'Z') || c === '"' || c === '“' || c === '(';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    let j = i + 1;
    // trailing terminators and closing quotes belong to the sentence that ends here
    while (j < src.length && '.!?"”\')'.includes(src[j])) j++;
    if (j >= src.length) break;
    if (!isSpace(src[j])) continue;
    let k = j;
    while (k < src.length && isSpace(src[k])) k++;
    if (k >= src.length || !opens(src[k])) continue;
    out.push(src.slice(start, j).trim());
    start = k;
    i = k - 1;
  }
  if (start < src.length) out.push(src.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Whole leading sentences of `text`, up to `max` characters. Never fewer than one, however long
 * that one is: a truncated sentence is worse than a long one, and a half-stated measurement is the
 * exact failure mode this demo's honesty rules exist to prevent.
 *
 * @param {string} text @param {number} max @returns {string}
 */
export function clampSentences(text, max) {
  const src = String(text || '').trim();
  if (src.length <= max) return src;
  const parts = splitSentences(src);
  if (!parts.length) return src;
  let out = '';
  for (const part of parts) {
    const next = out ? `${out} ${part}` : part;
    if (out && next.length > max) break;
    out = next;
  }
  return out || parts[0];
}

/**
 * The causal paragraph for a finding.
 *
 * PREFERRED: something the mission authored. `finding.note` is the per-finding field, and
 * `def.evidenceNotes[id]` is the same copy attached from a mission's LAZY side module, which is how
 * the two size-gated missions (ssl, battle) supply theirs without spending eager bytes.
 *
 * DERIVED, otherwise: a factual sentence built from what the finding already declares. It names
 * the plotted fields, the channel they came from and the window, and it says the replay under it
 * is those same seconds. It states nothing the def has not already stated, which is the only
 * honest thing a fallback can do here: inventing a mechanism for a mission that did not author one
 * would be the demo making a claim about a robot on the strength of a template.
 *
 * @param {object} def
 * @param {object} finding
 * @returns {string}
 */
export function evidenceNote(def, finding) {
  const authored = [
    finding && finding.note,
    def && def.evidenceNotes && def.evidenceNotes[finding && finding.id],
  ].find((s) => typeof s === 'string' && s.trim());
  if (authored) return clampSentences(authored.trim(), NOTE_CHARS);

  const focus = (finding && finding.focus) || {};
  const channel = focus.channel || (def.channels && def.channels[0] && def.channels[0].path) || '';
  const chan = (def.channels || []).find((c) => c.path === channel) || null;
  const keys = Array.isArray(focus.fields) && focus.fields.length
    ? focus.fields
    : ((chan && chan.fields) || []).slice(0, 2).map((f) => f.key);
  const labels = keys
    .map((k) => {
      const fd = chan && (chan.fields || []).find((f) => f.key === k);
      return (fd && fd.label) || k;
    })
    .filter(Boolean);
  const w = finding.window || [0, def.duration];
  const span = `${Number(w[0]).toFixed(1)} s to ${Number(w[1]).toFixed(1)} s`;
  // "cmd_l and vel_l and i_l" is not a sentence. Oxford-free list, because these are field labels
  // rather than clauses and a comma before "and" reads as a fourth field.
  const list =
    labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
  const traces = labels.length ? `${list} on ${channel}` : `the ${channel} channel`;
  return `Plotted above: ${traces}, ${span}. The replay below is those same seconds of the mission, and scrubbing either one moves the other.`;
}

/** Human window label for the block header. */
function windowLabel(def, finding) {
  const w = finding.window || [0, def.duration];
  const full = w[1] - w[0] >= def.duration * 0.95;
  if (full) return 'whole mission';
  return `${Number(w[0]).toFixed(1)} to ${Number(w[1]).toFixed(1)} s`;
}

/**
 * The inline evidence host for one demo screen.
 *
 * @param {object} o
 * @param {object} o.def robot definition, with `.data` attached
 * @param {object} o.timeline the mission's one TimelineStore
 * @param {HTMLElement} o.park where the shared viewer element lives when no block owns it
 * @param {HTMLElement} o.scroller the element the transcript scrolls in
 * @param {string} [o.icon] the mission's line art, for the no-WebGL and context-lost fallbacks
 * @param {(finding:object, opts:object)=>void} [o.onActivate] told whenever a block takes the context
 * @returns {{
 *   attach:(row:HTMLElement, findings:Array<object>)=>Array<object>,
 *   play:(finding:object, opts?:object)=>boolean,
 *   get activeFinding():object|null, get chart():object|null, get viewer():object|null,
 *   get blocks():number, refresh:()=>void, dispose:()=>void
 * }}
 */
export function createEvidenceEmbeds(o) {
  const { def, timeline, park, scroller } = o;
  const icon = o.icon || '';
  const onActivate = o.onActivate || (() => {});

  /** @type {Array<object>} every block on screen, in transcript order. */
  const blocks = [];
  /** Per-answer ownership keeps progressive one-token attaches inside MAX_BLOCKS_PER_ANSWER. */
  const answerBlocks = new WeakMap();
  let active = null;
  let viewer = null;
  let viewerDead = false; // no WebGL at all, or a context we could not get back
  let disposed = false;
  let pending = 0;
  let warming = 0;
  let recoveries = 0;

  // ------------------------------------------------------------------ the one viewer
  /**
   * Build the shared viewer, once, into the park.
   *
   * The park is a real, laid-out, off-screen box rather than a hidden one: the renderer sizes
   * itself off its host's rect, and a display:none host reports 0 x 0, which comes back as a 1 px
   * canvas the first block to take it would have to grow from. Parked at a sane size, the very
   * first move is a resize of a canvas that already has pixels in it.
   */
  function ensureViewer() {
    if (viewer || viewerDead || disposed) return viewer;
    if (!webglAvailable()) {
      viewerDead = true;
      return null;
    }
    try {
      viewer = createViewer(park, def, timeline);
    } catch (err) {
      console.warn(`[embeds] ${def.id}: shared replay could not be built`, err);
      viewer = null;
      viewerDead = true;
      return null;
    }
    const canvas = viewer.renderer && viewer.renderer.domElement;
    if (canvas) {
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);
    }
    return viewer;
  }

  /**
   * The context went away under us (GPU process crash, a driver reset, the browser evicting the
   * oldest context because some other tab wanted one). Every block falls back to what it already
   * has - its poster if one was captured, its line art otherwise - and the block that was live
   * grows a tap target that tries once to get the replay back.
   */
  function onContextLost() {
    viewerDead = true;
    if (active) {
      showStill(active);
      active = null;
    }
    blocks.forEach(showStill);
  }

  function onContextRestored() {
    viewerDead = false;
    schedule();
  }

  /** One deliberate attempt to rebuild the replay after a loss, driven by the visitor's tap. */
  function recover(block) {
    if (disposed || recoveries >= 2) return;
    recoveries++;
    if (viewer) {
      try {
        viewer.dispose();
      } catch (_) {
        /* a viewer whose context is already gone has little left to release */
      }
      viewer = null;
    }
    viewerDead = false;
    if (!ensureViewer()) {
      showStill(block);
      return;
    }
    activate(block, { source: 'recover' });
  }

  // ------------------------------------------------------------------ sequence construction
  /** Whether the transcript was following its tail before a new reservation changes its height. */
  function followsTail() {
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  /** Tell chat.js which newly appended reservation is now the active follow target. */
  function announceStage(block, target, wasFollowing) {
    if (!block || !block.sequence || !target) return;
    block.sequence.dispatchEvent(
      new CustomEvent('chat:evidence-stage', {
        bubbles: true,
        detail: { target, follow: !!wasFollowing },
      }),
    );
  }

  function replayHeader(finding) {
    const title = finding.title || finding.id;
    return `3D replay · ${title}`;
  }

  /**
   * Build one evidence sequence, but append only its chart reservation now.
   *
   * The sequence wrapper has no visual card of its own. Chart and replay are independent figures,
   * and the causal line is an ordinary chat paragraph between them. Later pieces do not exist in the
   * DOM until their turn, so authored prose after the token cannot appear ahead of them.
   *
   * @param {object} finding
   * @returns {object} the block record
   */
  function build(finding) {
    const sequence = document.createElement('div');
    sequence.className = 'ev-embed ev-sequence';
    sequence.dataset.ev = finding.id;
    sequence.dataset.state = 'staging';
    sequence.dataset.sev = finding.severity || 'warn';
    sequence.setAttribute('aria-busy', 'true');

    const chartEl = document.createElement('figure');
    chartEl.className = 'ev-piece ev-chart-piece is-staging';
    chartEl.dataset.sev = finding.severity || 'warn';
    chartEl.setAttribute('aria-busy', 'true');
    chartEl.innerHTML = `
      <figcaption class="ev-embed-head">
        <span class="ev-embed-dot"></span>
        <span class="ev-embed-title"></span>
        <span class="ev-embed-win mono"></span>
      </figcaption>
      <div class="ev-embed-chart is-loading"></div>`;
    chartEl.querySelector('.ev-embed-title').textContent = finding.title || finding.id;
    chartEl.querySelector('.ev-embed-win').textContent = windowLabel(def, finding);

    const replayEl = document.createElement('figure');
    replayEl.className = 'ev-piece ev-replay-piece is-staging';
    replayEl.dataset.sev = finding.severity || 'warn';
    replayEl.setAttribute('aria-busy', 'true');
    replayEl.innerHTML = `
      <figcaption class="ev-embed-head">
        <span class="ev-embed-dot"></span>
        <span class="ev-embed-title"></span>
        <span class="ev-embed-win mono"></span>
      </figcaption>
      <div class="ev-embed-3d is-loading">
        <div class="ev-embed-stage"></div>
        <img class="ev-embed-poster" alt="" hidden />
        <div class="ev-embed-art" aria-hidden="true">
          <svg viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
        </div>
        <button class="ev-embed-play mono" type="button" hidden>replay here</button>
      </div>`;
    replayEl.querySelector('.ev-embed-title').textContent = replayHeader(finding);
    replayEl.querySelector('.ev-embed-win').textContent = windowLabel(def, finding);

    // Compatibility marker for the existing no-WebGL flow probe. It is never laid out, so visitors
    // get chart + prose with no inert replay box when WebGL is unavailable.
    const fallbackArt = document.createElement('div');
    fallbackArt.className = 'ev-embed-art ev-compat-art';
    fallbackArt.setAttribute('aria-hidden', 'true');
    fallbackArt.innerHTML = `<svg viewBox="0 0 96 64">${icon}</svg>`;

    sequence.append(chartEl, fallbackArt);

    const block = {
      finding,
      sequence,
      el: sequence,
      chartEl,
      replayEl,
      chartMount: chartEl.querySelector('.ev-embed-chart'),
      stage: replayEl.querySelector('.ev-embed-3d'),
      slot: replayEl.querySelector('.ev-embed-stage'),
      poster: replayEl.querySelector('.ev-embed-poster'),
      art: replayEl.querySelector('.ev-embed-art'),
      play: replayEl.querySelector('.ev-embed-play'),
      note: evidenceNote(def, finding),
      noteWrap: null,
      noteText: null,
      chart: null,
      chartDead: false,
      chartReady: false,
      chartGateOpen: false,
      chartRevealed: false,
      replayAppended: false,
      stageReady: false,
      stageGateOpen: false,
      sequenceDone: false,
      cancelled: false,
      revealStartedAt: 0,
      revealTimers: [],
      wordTimer: 0,
      posterSrc: null,
      row: null,
    };

    block.play.addEventListener('click', () => {
      if (viewerDead) recover(block);
      else activate(block, { source: 'user' });
    });
    sequence.addEventListener('chat:evidence-cancel', () => cancelSequence(block));

    return block;
  }

  function later(block, delay, fn) {
    const timer = window.setTimeout(() => {
      const at = block.revealTimers.indexOf(timer);
      if (at >= 0) block.revealTimers.splice(at, 1);
      if (disposed || block.cancelled || !block.sequence.isConnected) return;
      fn();
    }, delay);
    block.revealTimers.push(timer);
  }

  function finishSequence(block) {
    if (!block || block.sequenceDone) return;
    block.sequenceDone = true;
    block.sequence.dataset.state = 'complete';
    block.sequence.removeAttribute('aria-busy');
    block.sequence.dispatchEvent(new CustomEvent('chat:evidence-sequence-done', { bubbles: true }));
  }

  function cancelSequence(block) {
    if (!block || block.sequenceDone) return;
    block.cancelled = true;
    for (const timer of block.revealTimers) window.clearTimeout(timer);
    block.revealTimers.length = 0;
    if (block.wordTimer) window.clearTimeout(block.wordTimer);
    block.wordTimer = 0;
    block.chartGateOpen = true;
    revealChart(block);
    finishSequence(block);
  }

  function appendCausalProse(block) {
    if (!block || block.cancelled || block.noteWrap) return;
    const wasFollowing = followsTail();
    const wrap = document.createElement('div');
    wrap.className = 'ev-causal-reservation is-staging stream-in';
    const measure = document.createElement('p');
    measure.className = 'md-p ev-embed-note ev-causal-measure';
    measure.setAttribute('aria-hidden', 'true');
    measure.textContent = block.note;
    const prose = document.createElement('p');
    prose.className = 'md-p ev-embed-note ev-causal-text';
    wrap.append(measure, prose);
    block.sequence.appendChild(wrap);
    block.noteWrap = wrap;
    block.noteText = prose;
    announceStage(block, wrap, wasFollowing);

    const words = block.note.match(/\S+\s*/g) || [];
    let index = 0;
    const next = () => {
      block.wordTimer = 0;
      if (disposed || block.cancelled || !wrap.isConnected) return;
      if (index < words.length) {
        prose.appendChild(document.createTextNode(words[index++]));
        block.wordTimer = window.setTimeout(next, PROSE_WORD_MS);
        return;
      }
      wrap.classList.remove('is-staging');
      later(block, PROSE_TO_REPLAY_MS, () => appendReplay(block));
    };
    next();
  }

  function appendReplay(block) {
    if (!block || block.cancelled || block.replayAppended) return;
    if (!webglAvailable()) {
      finishSequence(block);
      return;
    }
    const wasFollowing = followsTail();
    block.replayAppended = true;
    block.sequence.appendChild(block.replayEl);
    if (io) io.observe(block.replayEl);
    announceStage(block, block.replayEl, wasFollowing);
    schedule();
    later(block, REPLAY_SKELETON_MS, () => {
      block.stageGateOpen = true;
      // The stream may resume only after this reservation contains something real. A replay that
      // scrolled outside the activation radius during its dwell gets its still state now, then takes
      // the shared context normally when the reader returns to it.
      if (!block.stageReady) showStill(block);
      else revealReplay(block);
    });
  }

  /** Let a ready chart through only after its presentation gate has opened. */
  function revealChart(block) {
    if (!block || !block.chartGateOpen || !block.chartReady || block.chartRevealed) return;
    block.chartRevealed = true;
    block.chartMount.classList.remove('is-loading');
    block.chartMount.classList.add(block.chartDead ? 'is-unavailable' : 'is-ready');
    block.chartEl.classList.remove('is-staging');
    block.chartEl.removeAttribute('aria-busy');
    later(block, CHART_TO_PROSE_MS, () => appendCausalProse(block));
  }

  /** Let a ready replay or fallback through only after its presentation gate has opened. */
  function revealReplay(block) {
    if (!block || !block.replayAppended || !block.stageGateOpen || !block.stageReady) return;
    block.stage.classList.remove('is-loading');
    block.stage.classList.add('is-ready');
    block.replayEl.classList.remove('is-staging');
    block.replayEl.removeAttribute('aria-busy');
    // Remaining authored prose stays buffered until the replay reservation has visibly resolved.
    finishSequence(block);
  }

  /**
   * Begin the sequence as soon as the token is claimed. Offscreen readers are never pulled back, but
   * their answer must not remain paused forever merely because they scrolled up before the citation.
   */
  function armReveal(block) {
    if (disposed || !block || block.revealStartedAt) return;
    block.revealStartedAt = performance.now ? performance.now() : Date.now();
    ensureChart(block);
    later(block, CHART_SKELETON_MS, () => {
      block.chartGateOpen = true;
      revealChart(block);
    });
  }

  function armVisibleReveals() {
    for (const block of blocks) armReveal(block);
  }

  /**
   * The block's chart, built on first sight rather than at attach time.
   *
   * createChart allocates a canvas, a ResizeObserver and a paint pump, and an answer three screens
   * up the transcript has no business owning any of them until the reader is on their way back to
   * it. IntersectionObserver builds it and starts its pump on the way in and suspends the pump on
   * the way out; the canvas keeps its last frame while suspended.
   *
   * FIRST SIGHT IS ONE FRAME AFTER THE ANSWER SETTLES, and anything reading the block has to
   * account for that: the observer's first callback lands on the frame after `attach`, so a plot
   * frame is briefly empty in the message that just finished. Building it at attach instead would
   * cost a paint pump per streamed answer that lands while the reader is scrolled somewhere else,
   * which is the exact allocation this laziness exists to refuse.
   */
  function ensureChart(block) {
    if (block.chart || block.chartDead || disposed) return block.chart;
    try {
      return buildChart(block);
    } catch (err) {
      // A chart that will not build must not take the block down with it. Keep the reserved plot
      // height so failure cannot pull the causal line and replay upward after they entered the flow.
      console.warn(`[embeds] ${def.id}: inline chart for ${block.finding.id} failed`, err);
      block.chartDead = true;
      block.chartReady = true;
      block.chart = null;
      revealChart(block);
      return null;
    }
  }

  function buildChart(block) {
    const focus = block.finding.focus || {};
    const chart = createChart(block.chartMount, def, timeline);
    chart.el.dataset.mode = 'ev-embed';
    chart.setDirectLabels(true);
    chart.setMinimalChrome(true);
    chart.focusWindow({
      window: block.finding.window || [0, def.duration],
      channel: focus.channel,
      fields: focus.fields,
      tone: block.finding.severity === 'alert' ? 'alert' : 'neutral',
      shade: true,
    });
    chart.redraw();
    block.chart = chart;
    block.chartReady = true;
    revealChart(block);
    return chart;
  }

  // ------------------------------------------------------------------ posters and fallbacks
  /**
   * The still state: this block does not hold the context.
   *
   * It shows its poster if it ever had one, the mission's line art if it did not, and a tap target
   * that takes the context back. The tap target is withheld only when there is no WebGL on this
   * device at all, because offering a replay that cannot exist is worse than not offering one.
   */
  function showStill(block) {
    if (!block) return;
    block.el.classList.remove('is-live');
    block.poster.hidden = !block.posterSrc;
    block.art.hidden = !!block.posterSrc;
    block.play.hidden = !webglAvailable();
    block.stageReady = true;
    revealReplay(block);
  }

  /**
   * Freeze the block that is giving up the context.
   *
   * The capture has to happen while this block still owns the canvas and in the same task as the
   * render, so it is the FIRST thing the handover does. A failed capture is not an error: the block
   * keeps whatever poster it had, or falls back to line art.
   */
  function freeze(block) {
    if (!block) return;
    if (viewer) {
      const src = viewer.capturePoster();
      if (src) {
        block.posterSrc = src;
        block.poster.src = src;
      }
    }
    showStill(block);
  }

  // ------------------------------------------------------------------ activation
  /**
   * Hand the one context to `block`.
   *
   * Serialized by construction: there is a single `active` reference and a single element being
   * moved, so two blocks cannot both believe they own the renderer. Everything that follows the
   * move is this block's own finding being applied to the shared clock, which is what makes taking
   * the context and playing the evidence the same act.
   *
   * @param {object} block
   * @param {{source?:string}} [opts]
   */
  function activate(block, opts = {}) {
    if (disposed || !block || block === active) return;
    const v = ensureViewer();
    if (!v) {
      showStill(block);
      return;
    }
    freeze(active);
    active = block;

    block.slot.appendChild(v.el);
    block.poster.hidden = true;
    block.art.hidden = true;
    block.play.hidden = true;
    block.el.classList.add('is-live');
    block.stageReady = true;
    revealReplay(block);
    v.remeasure();

    const finding = block.finding;
    const w = finding.window || [0, def.duration];
    const full = w[1] - w[0] >= def.duration * 0.95;
    v.hideBanner();
    v.setHighlight(finding.highlight || null);
    v.flashMarker(finding.id);
    if (full) {
      timeline.setLoop(null, { speed: 1 });
      timeline.seek(Math.max(0, (finding.t != null ? finding.t : w[0]) - 8));
    } else {
      // ROUND 5: the tight replay loop, when the finding declares one. `w` still decides what this
      // block's chart plots and shades (see buildChart), so the trace keeps its context while the 3D
      // replays only the failure moment: ~0.5 s of healthy motion, the failure, ~0.5 s of the settled
      // fail state. No `loop` on the finding = the window loops, exactly as before.
      const lw = finding.loop || w;
      timeline.setLoop(lw, { speed: finding.slowmo ? 0.4 : 1 });
      timeline.seek(lw[0]);
    }
    timeline.play();
    ensureChart(block);
    if (block.chart) block.chart.setRunning(true);

    onActivate(finding, opts);
  }

  /**
   * The nearest-centre rule.
   *
   * IntersectionObserver alone cannot answer this: it reports THAT a block is visible, not which of
   * two visible blocks the reader is looking at. So visibility is the filter and the distance from
   * the scroller's own centre is the ranking, both measured in the same frame off live rects.
   *
   * Runs on a single queued frame however many scroll events arrived, and does nothing at all when
   * the winner is already the live block, which is the common case for a reader who is not moving.
   */
  function pick() {
    pending = 0;
    if (disposed || !blocks.length) return;
    armVisibleReveals();
    const view = scroller && scroller.getBoundingClientRect
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, height: window.innerHeight };
    const mid = view.top + view.height / 2;
    const reach = view.height * ACTIVATE_SLACK;
    let best = null;
    let bestD = Infinity;
    for (const b of blocks) {
      const r = b.stage.getBoundingClientRect();
      if (!r.height) continue;
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d > reach) continue;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best && best !== active) activate(best, { source: 'scroll' });
  }

  function schedule() {
    if (pending || disposed) return;
    pending = requestAnimationFrame(pick);
  }

  // The chart pump follows visibility, not activation: a chart one block above the live one is
  // still on screen and its playhead has to keep up with the mission clock.
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (list) => {
            for (const ent of list) {
              const b = blocks.find((x) => x.chartEl === ent.target || x.replayEl === ent.target);
              if (!b) continue;
              if (ent.isIntersecting) {
                ensureChart(b);
                if (b.chart) b.chart.setRunning(true);
              } else if (b.chart) {
                b.chart.setRunning(false);
              }
            }
            schedule();
          },
          { root: scroller || null, rootMargin: '200px 0px' },
        )
      : null;

  if (scroller) scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  /**
   * BUILD THE SHARED REPLAY NOW, PARKED, rather than on the frame a block first wants it.
   *
   * The opener is asked 420 ms after this screen mounts and then types itself out, so the first
   * block does not exist for several seconds. Deferring the renderer until then puts context
   * creation, the scene build and three.js's first shader compile on the single frame the reader
   * arrives at the evidence, which is the one frame in the whole visit that must not stutter. Doing
   * it here spends those milliseconds while the analyst is still writing, against a park that is
   * already the right shape, so activation is a reparent and a resize and nothing else.
   *
   * It also decouples "the demo screen is up" from "the opener finished typing". A canvas under
   * #viewer-mount is what the navigation-race and lazy-path probes read as proof the payload landed
   * and the renderer built, and hanging that on a typewriter made a real answer's length the thing
   * those tests were timing.
   *
   * One frame late, not synchronous: the transcript gets its first paint first. Still exactly one
   * context either way - this moves when it is allocated, never how many.
   */
  warming = requestAnimationFrame(() => {
    warming = 0;
    ensureViewer();
  });

  return {
    /**
     * Fill this answer's evidence tokens in place.
     *
     * Calls may arrive one token at a time while the answer is still growing, then once more with
     * the final citation list. Existing blocks are returned on that final pass, and the per-answer
     * cap applies across all calls.
     *
     * @param {HTMLElement} row the `.msg.bot` row currently streaming or settled
     * @param {Array<object>} findings the findings cited so far, in citation order
     * @returns {Array<object>} blocks created earlier or in this call
     */
    attach(row, findings) {
      if (disposed || !row) return [];
      const made = [];
      let owned = answerBlocks.get(row);
      if (!owned) {
        owned = [];
        answerBlocks.set(row, owned);
      }

      for (const finding of (findings || []).filter(Boolean)) {
        const existing = owned.find((block) => block.finding.id === finding.id);
        if (existing) {
          if (!made.includes(existing)) made.push(existing);
          continue;
        }
        if (owned.length >= MAX_BLOCKS_PER_ANSWER) break;
        let slot = Array.from(row.querySelectorAll('.ev-slot')).find(
          (candidate) => candidate.dataset.ev === finding.id && candidate.dataset.evClaimed !== '1',
        );
        let directHost = false;
        // QA and host integrations may attach directly to the transcript before an answer has typed
        // its token. Give that explicit API call a reservation without changing normal answer flow.
        if (!slot && row.classList && row.classList.contains('chat-log')) {
          slot = document.createElement('span');
          slot.className = 'ev-slot ev-slot-block';
          slot.dataset.ev = finding.id;
          row.appendChild(slot);
          directHost = true;
        }
        if (!slot) continue;

        const wasFollowing = followsTail();
        const block = build(finding);
        block.row = row;
        slot.replaceWith(block.el);
        blocks.push(block);
        owned.push(block);
        made.push(block);
        if (!directHost) {
          if (io) io.observe(block.chartEl);
          armReveal(block);
          announceStage(block, block.chartEl, wasFollowing);
        }
      }
      return made;
    },

    /**
     * Play a finding, from a chip or from the opener's own beat.
     *
     * The LAST block citing it wins, because the transcript grows downward and the newest answer is
     * the one the reader is at. Scrolling it into view is deliberate and comes first: activation is
     * driven by what is on screen, so bringing the block to the reader and giving it the context
     * are the same operation seen from two ends.
     */
    play(finding, opts = {}) {
      if (disposed || !finding) return false;
      let target = null;
      for (const b of blocks) if (b.finding.id === finding.id) target = b;
      if (!target) return false;
      try {
        const anchor = target.replayAppended ? target.replayEl : target.el;
        anchor.scrollIntoView({
          block: opts.source === 'auto' && target.sequence.dataset.state === 'staging' ? 'start' : 'center',
          behavior: opts.source === 'auto' ? 'auto' : 'smooth',
        });
      } catch (_) {
        /* an environment without scrollIntoView options still gets the activation below */
      }
      activate(target, opts);
      return true;
    },

    get activeFinding() {
      return active ? active.finding : null;
    },
    /** QA: the chart the live block owns, or the first one built. */
    get chart() {
      if (active && active.chart) return active.chart;
      const withChart = blocks.find((b) => b.chart);
      return withChart ? withChart.chart : null;
    },
    get viewer() {
      return viewer;
    },
    get blocks() {
      return blocks.length;
    },
    refresh: schedule,

    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) cancelAnimationFrame(pending);
      pending = 0;
      // A visitor who bounces off the demo inside one frame must not leave a context behind them.
      if (warming) cancelAnimationFrame(warming);
      warming = 0;
      if (io) io.disconnect();
      if (scroller) scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      // THE VIEWER GOES HOME BEFORE ANYTHING IS DETACHED, and this is not tidiness.
      // OrbitControls resolves the node it registered its document-level `keydown` on by calling
      // `domElement.getRootNode()` AT DISPOSE TIME. Remove the block first and that call returns
      // the detached subtree instead of the document, so the listener it tries to remove is one
      // nobody ever added and the real one survives every teardown, one per demo visit, forever.
      // Parking the element first keeps the canvas in the document while its controls unwind.
      if (viewer && viewer.el) park.appendChild(viewer.el);
      for (const b of blocks) {
        for (const timer of b.revealTimers) window.clearTimeout(timer);
        b.revealTimers.length = 0;
        if (b.wordTimer) window.clearTimeout(b.wordTimer);
        b.wordTimer = 0;
        if (b.chart) b.chart.dispose();
        b.chart = null;
        b.el.remove();
      }
      blocks.length = 0;
      active = null;
      if (viewer) {
        const canvas = viewer.renderer && viewer.renderer.domElement;
        if (canvas) {
          canvas.removeEventListener('webglcontextlost', onContextLost);
          canvas.removeEventListener('webglcontextrestored', onContextRestored);
        }
        viewer.dispose();
        viewer = null;
      }
      park.innerHTML = '';
    },
  };
}
