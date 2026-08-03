// guide.js - the choreography engine. Reads `def.choreo.beats` and walks a visitor through the
// mission one user-gated step at a time: the agent says one thing, one panel appears, one action
// drives the timeline, one hint names what to try, and the visitor's own tap advances.
//
//   const guide = createGuide({ def, chat, panels });
//   guide.start();
//   guide.dispose();
//
// ---------------------------------------------------------------------------- what this replaces
// Round 1 opened every demo with the whole layout on screen and a 420 ms timer that asked the
// scripted opener on the visitor's behalf, auto-played its evidence chip once, and handed over.
// Three panels and an answer all arrived inside half a second, and the review found exactly what
// you would expect: nobody knew what they were looking at, so nobody looked.
//
// A GUIDED mission (a def that ships `choreo`, which today is sbr, ssl and battle - the three
// missions the four roles are routed into) instead enters CHAT ONLY. The chart and the 3D stage are
// not in the layout at all; they arrive when the agent has said why they are about to matter. The
// 420 ms opener does not run on these missions: this engine replaces it, and app.js is the one
// place that decides which of the two flows a mission gets. Every other mission (rescue, donna,
// arm6, drone, every generated demo) is untouched, down to the timer.
//
// ---------------------------------------------------------------------------- the beat contract
// `def.choreo.beats` is authored in each robot's own module and documented in sbr/script.js. This
// engine reads, and never restates, five things per beat:
//
//   reveal   'chat' | 'chart' | 'stage'. Which panel this beat brings on screen. Written as
//            `data-guide` on #screen-demo; the STYLESHEET owns what that means, so the hidden
//            state is the one the template markup ships with and no JS ever hides a panel after
//            the browser has already laid it out.
//   answer   BEAT 1 ONLY. A script entry id. Its answer is streamed verbatim, in the visitor's
//            register, under `def.firstQuestion` as the question - the same text the facts pack
//            and the analyst are built from. Never a copy.
//   say      the agent's line, with `sayByRole` overriding it for the registers that genuinely
//            read differently. Engineer is never a key: `say` IS the engineer register.
//   actions  ordered `{ do, evidence }`. `evidence` names one of this def's own findings and this
//            file reads the window, the instant, the focus channel, the highlighted part and the
//            slow-motion flag OFF THE FINDING. Nothing about a failure window is restated in the
//            choreography, so a re-timed fault cannot leave the walk pointing at the wrong second.
//   hint     one interaction prompt, rendered as a system note under the answer.
//   cta      the label on the button that advances. THE ONLY thing that advances a beat: this
//            engine has no timers between beats and never auto-advances, because a beat the
//            visitor did not cause is just a slideshow.
//
// ---------------------------------------------------------------------------- who fires what
// `do:'replay'` goes through the host's `onEvidence(finding, {source:'auto'})`, the same
// orchestrator an evidence chip drives, so the combo the demo is selling is literally the same
// code path whether the choreography plays it or the visitor clicks it. `source:'auto'` keeps it
// out of `evidence_user_clicked`: the aha metric stays user-only, exactly as it was in round 1.
//
// ---------------------------------------------------------------------------- failure
// A choreography that throws must never cost a visitor the demo. Every step is guarded, and any
// throw settles immediately into the full layout with the chat panel already populated - which is
// the round-1 demo, minus its opener. A def with no beats never constructs this at all.

import { getRoleId, isGuidedMission } from './role.js';
import { track } from './analytics.js';

/**
 * How far the layout has opened. A beat may only ever reveal FORWARD: two beats that both reveal
 * the chart leave it alone the second time, and nothing can close a panel the visitor has already
 * been given.
 */
const REVEAL_ORDER = { chat: 0, chart: 1, stage: 2 };

/** Think beat before the agent's line, so a reveal is seen before it is narrated. */
const SAY_DELAY_MS = 260;
/** Longer beat before beat 1's scripted answer: the question has to land as a question first. */
const ANSWER_DELAY_MS = 520;

/**
 * Whether this def is driven by the choreography engine at all.
 *
 * Two gates, deliberately. `choreo` is the DATA (a mission that ships beats), `isGuidedMission` is
 * the ROUTING (a mission one of the four roles is guided into, derived in role.js from the role
 * table itself). A def carrying beats that no role routes to is not a guided mission, and a guided
 * mission whose lazy side-module failed to land has no beats to walk: either way the caller falls
 * back to the untouched round-1 flow rather than showing half a choreography.
 *
 * @param {object} def
 * @returns {boolean}
 */
export function hasChoreo(def) {
  if (!def || !isGuidedMission(def.id)) return false;
  const beats = def.choreo && def.choreo.beats;
  return Array.isArray(beats) && beats.length > 0;
}

/**
 * @param {{
 *   def: object,
 *   chat: object,
 *   panels: {
 *     host: HTMLElement,
 *     timeline: object,
 *     chart: object,
 *     viewer?: object,
 *     onEvidence: (finding:object, opts?:{source:'user'|'auto'})=>void,
 *     setChartOpen?: (open:boolean)=>void,
 *   },
 *   role?: string|null,
 *   onSettle?: ()=>void,
 * }} ctx
 *   `chat` is core/chat.js's handle: this engine writes through its authored-message surface
 *   (`say`, `askScripted`, `addNote`, `addAction`) and never touches the log itself.
 * @returns {{ start:()=>void, dispose:()=>void, get index():number, get beatId():string|null,
 *   get settled():boolean, get beats():number }}
 */
export function createGuide(ctx) {
  const def = ctx.def;
  const chat = ctx.chat;
  const panels = ctx.panels || {};
  const host = panels.host;
  const onSettle = typeof ctx.onSettle === 'function' ? ctx.onSettle : () => {};
  const beats = (def.choreo && def.choreo.beats) || [];
  const roleId = ctx.role !== undefined ? ctx.role : getRoleId();
  const findings = new Map((def.findings || []).map((f) => [f.id, f]));

  let index = -1;
  let settled = false;
  let disposed = false;
  let started = false;

  // ---------------------------------------------------------------- copy
  /**
   * The agent's line for a beat, in this visitor's register.
   *
   * `say` is the engineer register and the default, so an unknown role, a visitor who never forked
   * and a role whose register adds nothing all take one path - the same rule chat.js's `answerFor`
   * runs on, for the same reason. `hasOwnProperty` rather than a bare lookup: a role id is
   * normalized upstream, but a map is data and data must not be able to reach a prototype method.
   *
   * @param {object} beat
   * @returns {string}
   */
  function sayFor(beat) {
    const byRole = beat.sayByRole;
    if (
      roleId &&
      byRole &&
      Object.prototype.hasOwnProperty.call(byRole, roleId) &&
      typeof byRole[roleId] === 'string' &&
      byRole[roleId].trim()
    ) {
      return byRole[roleId];
    }
    return typeof beat.say === 'string' ? beat.say : '';
  }

  // ---------------------------------------------------------------- layout
  /**
   * Open the layout as far as this beat asks for, never further and never back.
   *
   * The whole reveal is one attribute on #screen-demo. index.html ships `data-guide="chat"` in the
   * MARKUP, so a guided mission's first paint has already had the chart and the stage out of the
   * layout: there is no frame in which they exist and no JS hide after a forced layout, which is
   * the failure mode that makes a reveal transition fire on entry instead of on the beat.
   *
   * @param {string} kind
   */
  function reveal(kind) {
    if (!host || !Object.prototype.hasOwnProperty.call(REVEAL_ORDER, kind)) return;
    const now = host.dataset.guide;
    const at = Object.prototype.hasOwnProperty.call(REVEAL_ORDER, now) ? REVEAL_ORDER[now] : -1;
    if (REVEAL_ORDER[kind] <= at) return;
    host.dataset.guide = kind;
  }

  // ---------------------------------------------------------------- actions
  /**
   * Put the plot on a finding: its window, its channel, its fields.
   *
   * This is `onEvidence` with the 3D half left out, because at beat 2 the stage is not on screen
   * yet and a highlight nobody can see is not a beat. The timeline still moves: a chart zoomed to
   * 50.5-58.5 s with the playhead sitting at 12 s reads as a broken plot, so the loop is armed
   * here and the 3D beat re-arms the identical window through the real orchestrator.
   *
   * @param {object} f finding
   */
  function playChart(f) {
    const duration = def.duration || 0;
    const w = f.window || [0, duration];
    const full = duration > 0 && w[1] - w[0] >= duration * 0.95;
    // mobile parks the chart behind a collapsed toggle: opening it is the reveal on that viewport
    if (typeof panels.setChartOpen === 'function' && window.matchMedia('(max-width: 899px)').matches) {
      panels.setChartOpen(true);
    }
    if (full) {
      panels.timeline.setLoop(null, { speed: 1 });
      panels.timeline.seek(Math.max(0, (f.t != null ? f.t : w[0]) - 8));
    } else {
      panels.timeline.setLoop(w, { speed: f.slowmo ? 0.4 : 1 });
      panels.timeline.seek(w[0]);
    }
    panels.timeline.play();
    panels.chart.focus(f);
  }

  /**
   * Run a beat's declarative actions, in order.
   *
   * An action that names a finding this def does not have is a data bug worth a warning and
   * nothing more: the beat still says its line, the panel is still on screen, and the visitor
   * still advances. Dropping the whole walk over one bad id would be a far worse trade.
   *
   * @param {Array<{do:string, evidence:string}>} [actions]
   */
  function runActions(actions) {
    (actions || []).forEach((a) => {
      const f = a && a.evidence ? findings.get(a.evidence) : null;
      if (!f) {
        console.warn(`[guide] ${def.id}: no finding "${a && a.evidence}" for a "${a && a.do}" action`);
        return;
      }
      try {
        if (a.do === 'chart') playChart(f);
        // The 3D beat is the real orchestrator, unmodified: flash the marker, loop the window at
        // the finding's speed, re-aim the chart, light the part, raise the banner. `source:'auto'`
        // so it reports as `evidence_auto_played` and the aha metric stays a human click.
        else if (a.do === 'replay') panels.onEvidence(f, { source: 'auto' });
        else console.warn(`[guide] ${def.id}: unknown action "${a.do}"`);
      } catch (err) {
        console.warn(`[guide] ${def.id}: action "${a.do}" failed`, err);
      }
    });
  }

  // ---------------------------------------------------------------- the walk
  function runBeat(i) {
    if (disposed || settled) return;
    const beat = beats[i];
    if (!beat) {
      settle();
      return;
    }
    index = i;
    try {
      reveal(beat.reveal);
      runActions(beat.actions);
      track.beatShown(def.id, { beat: beat.id, role: roleId, step: i + 1 });
      const line = sayFor(beat);
      if (!line) {
        afterSay(beat, i);
        return;
      }
      chat.say(line, {
        delay: SAY_DELAY_MS,
        onDone: () => afterSay(beat, i),
      });
    } catch (err) {
      console.warn(`[guide] ${def.id}: beat "${beat.id}" failed`, err);
      settle();
    }
  }

  /**
   * Beat 1's second half: the question the mission was written around, and the authored answer.
   *
   * `beat.answer` is a REFERENCE into `def.script`. The text is not in the choreography and never
   * will be: it is the answer build-facts.mjs renders into the analyst's pack, and two copies of
   * it is two openers that drift. A missing entry is survivable - the beat has already said its
   * piece - so it falls through to the CTA rather than stalling the walk.
   *
   * @param {object} beat @param {number} i
   */
  function afterSay(beat, i) {
    if (disposed || settled) return;
    try {
      const entry = beat.answer ? chat.entryById(beat.answer) : null;
      if (entry) {
        chat.askScripted(def.firstQuestion, entry, {
          delay: ANSWER_DELAY_MS,
          onDone: () => {
            // The round-1 funnel step, kept: this IS the moment the first answer finished typing,
            // and dropping it on the three guided missions would break every comparison across
            // this change. `auto_played:false` is the honest difference - nothing fired itself
            // here, the chart and the stage are two taps away and both are the visitor's.
            track.firstAnswerSettled(def.id, {
              evidence: (entry.evidence && entry.evidence[0]) || null,
              auto_played: false,
              beat: beat.id,
            });
            endBeat(beat, i);
          },
        });
        return;
      }
      if (beat.answer) console.warn(`[guide] ${def.id}: no script entry "${beat.answer}"`);
      endBeat(beat, i);
    } catch (err) {
      console.warn(`[guide] ${def.id}: beat "${beat.id}" answer failed`, err);
      settle();
    }
  }

  /**
   * The hint, then the one control that advances. Nothing else is live on this screen while a beat
   * is open: the composer, the suggestion chips and the evidence chips are all held back by the
   * stylesheet until the walk hands over, so the CTA is the only thing to do and the only thing
   * that can be misread.
   *
   * @param {object} beat @param {number} i
   */
  function endBeat(beat, i) {
    if (disposed || settled) return;
    try {
      if (beat.hint) chat.addNote(beat.hint);
      chat.addAction(beat.cta || 'Continue', () => {
        if (disposed) return;
        track.beatCtaClicked(def.id, { beat: beat.id, role: roleId, step: i + 1 });
        runBeat(i + 1);
      });
    } catch (err) {
      console.warn(`[guide] ${def.id}: beat "${beat.id}" handover failed`, err);
      settle();
    }
  }

  /**
   * Hand over. The full layout, the suggestion chips, the composer, live evidence chips, and the
   * one coach line naming the rule the panel runs on.
   *
   * `chat.announceBeat()` is what lets the signup machine start listening at all - the same event
   * the round-1 auto-played chip raised, raised here at the equivalent moment. Until this runs,
   * every arming signal is parked, which is precisely the "arms after the 3D beat" rule: the
   * popup cannot land in the middle of the walk, and an interaction during it is not thrown away.
   */
  function settle() {
    if (settled) return;
    settled = true;
    if (host) delete host.dataset.guide;
    if (disposed) return;
    try {
      chat.addCoach();
    } catch (err) {
      console.warn(`[guide] ${def.id}: coach line failed`, err);
    }
    try {
      chat.announceBeat();
    } catch (err) {
      console.warn(`[guide] ${def.id}: beat announcement failed`, err);
    }
    try {
      onSettle();
    } catch (err) {
      console.warn(`[guide] ${def.id}: settle hook failed`, err);
    }
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      runBeat(0);
    },
    /**
     * Nothing to unwind: every timer this engine runs is chat.js's own think beat, which its
     * dispose() clears, and the only DOM it owns is inside the chat log that goes with it. The
     * flag exists so a beat still in flight when the visitor leaves cannot write to a dead panel.
     */
    dispose() {
      disposed = true;
    },
    // QA/integration handles (page state, not pixels)
    get index() {
      return index;
    },
    get beatId() {
      return index >= 0 && beats[index] ? beats[index].id : null;
    },
    get settled() {
      return settled;
    },
    get beats() {
      return beats.length;
    },
  };
}
