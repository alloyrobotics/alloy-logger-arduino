// chat.js - the analyst panel. Renders history, streams answers with a typewriter, parses the
// markdown subset, hydrates evidence chips, and hands the first evidence item of a finished
// answer to onEvidence(). Chips re-fire on click.
//
// onSettled() fires once per logical answer, when its typewriter has finished, whichever terminal
// path that answer took. It is the "the reader is free again" signal the signup popup waits on.

import { renderMarkdown } from './markdown.js';
import { matchEntry as matchEntryIn } from './matcher.js';

const CHARS_PER_FRAME = 3;

/** Same-origin analyst endpoint (worker/chat.js). */
const CHAT_ENDPOINT = '/demo/api/chat';
/** Turns of transcript sent back for context — 5 exchanges. */
const MAX_HISTORY = 10;
/** Consecutive transport failures before this session gives up and stays scripted. */
const MAX_LIVE_FAILURES = 2;

/**
 * @param {HTMLElement} mount
 * @param {object} robotDef
 * @param {{
 *   onEvidence?: (finding:object)=>void,
 *   onAsk?: (q:string)=>void,
 *   onSettled?: (info:{id:number})=>void,
 * }} hooks
 * @returns {{
 *   el:HTMLElement,
 *   ask:(text:string)=>void, askFirstQuestion:()=>void,
 *   matchEntry:(text:string)=>object|null,
 *   finishStreaming:()=>void, get streaming():boolean,
 *   focusInput:()=>void, dispose:()=>void
 * }}
 */
export function createChat(mount, robotDef, hooks = {}) {
  const onEvidence = hooks.onEvidence || (() => {});
  const onAsk = hooks.onAsk || (() => {});
  const onSettled = hooks.onSettled || (() => {});
  const findingById = new Map((robotDef.findings || []).map((f) => [f.id, f]));

  const el = document.createElement('div');
  el.className = 'chat';
  el.innerHTML = `
    <div class="chat-log" role="log" aria-live="polite" aria-label="Analyst conversation"></div>
    <div class="chat-foot">
      <div class="sugg" aria-label="Suggested questions"></div>
      <form class="chat-form" autocomplete="off">
        <input class="chat-input" type="text" maxlength="500" placeholder="Ask about this mission" aria-label="Ask about this mission" />
        <button class="chat-send" type="submit" aria-label="Send">
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true"><path d="M1.5 7.5h11M8 3l4.5 4.5L8 12" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </form>
    </div>`;
  mount.appendChild(el);

  const log = el.querySelector('.chat-log');
  const sugg = el.querySelector('.sugg');
  const form = el.querySelector('.chat-form');
  const input = el.querySelector('.chat-input');

  let streaming = false;
  let streamRaf = 0;
  let finishNow = null;
  let pendingTimer = 0;
  let disposed = false;
  /** Rolling transcript sent to the analyst endpoint: [{role, content}, ...]. */
  const history = [];
  /** AbortController for the in-flight answer, so a new question cancels the old one. */
  let inflight = null;
  let liveFailures = 0;

  // ---------- settled answers ----------
  // One question is one LOGICAL answer, whatever route it takes to the screen: a live stream, a
  // scripted answer, or a live attempt that dies before its first token and hands off to the
  // scripted one. Each gets a monotonic id at ask() time, and onSettled fires at most once for it,
  // when its typewriter has actually finished. Callers use this as "the reader is done reading":
  // the SSE `done` frame is too early (the text is still being typed out) and onEvidence only ever
  // covers evidence-bearing answers.
  let reqSeq = 0;
  /** Highest id already settled. Ids are monotonic, so this is the exactly-once guard. */
  let lastSettled = 0;

  function settleRequest(reqId) {
    if (disposed) return;
    if (!reqId || reqId <= lastSettled) return;
    lastSettled = reqId;
    onSettled({ id: reqId });
  }

  // ---------- suggested chips ----------
  (robotDef.suggested || []).forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sugg-chip';
    b.textContent = q;
    b.addEventListener('click', () => ask(q));
    sugg.appendChild(b);
  });

  // ---------- matching ----------
  // The scoring itself lives in core/matcher.js so the generator's validator can decide, with
  // the exact same code, whether a generated question will hit an answer in this panel.
  function matchEntry(text) {
    return matchEntryIn(robotDef.script || [], text);
  }

  // ---------- rendering ----------
  /** True while the log is parked at (or within a line of) the bottom. */
  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  // `force` is for events the reader caused (their own question, a finished answer). Mid-stream
  // frames pass nothing, so scrolling up to re-read an earlier answer is not fought every frame.
  function scrollDown(force) {
    if (force || atBottom()) log.scrollTop = log.scrollHeight;
  }

  function addUser(text) {
    const row = document.createElement('div');
    row.className = 'msg user';
    row.innerHTML = `<div class="bubble"></div>`;
    row.querySelector('.bubble').textContent = text;
    log.appendChild(row);
    scrollDown(true);
  }

  function addAssistantShell() {
    const row = document.createElement('div');
    row.className = 'msg bot';
    row.innerHTML = `
      <div class="bot-head"><span class="bot-dot"></span><span class="bot-name mono">alloy analyst</span></div>
      <div class="bot-body md"></div>
      <div class="ev-row"></div>`;
    log.appendChild(row);
    scrollDown(true);
    return row;
  }

  function chipLabel(f) {
    const t = f.t != null ? f.t : f.window[0];
    return `▸ ${t.toFixed(1)} s · ${f.chipLabel || shortTitle(f.title)}`;
  }

  function shortTitle(title) {
    // "Fall at 51.7 s" -> "Fall"
    return String(title).split(/\s+at\s+/i)[0].trim();
  }

  function makeChip(f) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ev-chip mono sev-' + (f.severity || 'warn');
    b.dataset.ev = f.id;
    b.textContent = chipLabel(f);
    b.title = f.title;
    b.addEventListener('click', () => onEvidence(f));
    return b;
  }

  function hydrate(row, entry) {
    // inline {{ev:id}} slots
    const inlined = new Set();
    row.querySelectorAll('.ev-slot').forEach((slot) => {
      const f = findingById.get(slot.dataset.ev);
      if (!f) {
        slot.remove();
        return;
      }
      const chip = makeChip(f);
      chip.classList.add('inline');
      slot.replaceWith(chip);
      inlined.add(f.id);
    });
    // trailing chip row: only findings the answer did not already place inline
    const evRow = row.querySelector('.ev-row');
    evRow.innerHTML = '';
    const ids = (entry && entry.evidence) || [];
    ids.forEach((id) => {
      if (inlined.has(id)) return;
      const f = findingById.get(id);
      if (f) evRow.appendChild(makeChip(f));
    });
    if (!evRow.children.length) evRow.remove();
  }

  // ---------- streaming ----------
  /** Long answers get a proportionally faster typewriter so a 2 kB answer is not a 12 s wait. */
  function charsPerFrame(len) {
    return Math.max(CHARS_PER_FRAME, Math.ceil(len / 420));
  }

  /** A `copy` affordance on every code block. The Arduino snippet is the conversion answer. */
  function addCopyButtons(row) {
    row.querySelectorAll('.md-pre').forEach((pre) => {
      if (pre.parentNode && pre.parentNode.classList.contains('md-prewrap')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'md-copy mono';
      b.textContent = 'copy';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        const text = code ? code.textContent : '';
        const mark = () => {
          b.textContent = 'copied';
          window.setTimeout(() => {
            b.textContent = 'copy';
          }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(mark, () => {});
        }
      });
      // the button lives OUTSIDE the <pre> so it does not scroll away with a long snippet
      const box = document.createElement('div');
      box.className = 'md-prewrap';
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);
      box.appendChild(b);
    });
  }

  /**
   * The typewriter. `src` may still be growing while it runs (a live answer arrives over SSE),
   * so the walker parks on the caret when it catches up instead of finishing, and only finishes
   * once close() says no more text is coming.
   *
   * @param {number} [reqId] the logical answer this stream is rendering, for onSettled
   * @returns {{push:(t:string)=>void, close:(entry?:object)=>void, get length():number}}
   */
  function startStream(reqId) {
    const row = addAssistantShell();
    const body = row.querySelector('.bot-body');
    let src = '';
    let i = 0;
    let closed = false;
    let entry = null;
    let skip = false; // reader clicked to skip the animation
    streaming = true;
    el.classList.add('is-streaming');

    // `fireEvidence` is false when the reader interrupted with a new question: the abandoned
    // answer must not seek/loop the timeline out from under the question they just asked.
    const done = (fireEvidence) => {
      streaming = false;
      el.classList.remove('is-streaming');
      finishNow = null;
      if (streamRaf) cancelAnimationFrame(streamRaf);
      streamRaf = 0;
      body.innerHTML = renderMarkdown(src);
      hydrate(row, entry);
      addCopyButtons(row);
      scrollDown(true);
      // fireEvidence === false is a SUPERSEDED answer, abandoned mid-flight because the reader
      // asked something else. It never settles: the answer they are waiting for is the next one.
      if (fireEvidence === false) return;
      const first = entry && entry.evidence && entry.evidence[0];
      const f = first ? findingById.get(first) : null;
      if (f) onEvidence(f);
      settleRequest(reqId);
    };

    // A skip while the network is still delivering can only skip what has arrived; the walker
    // stays alive and keeps pace with the remaining deltas.
    finishNow = (fireEvidence) => {
      skip = true;
      i = src.length;
      if (closed) done(fireEvidence !== false);
      else if (fireEvidence === false) {
        closed = true;
        done(false);
      }
    };

    const step = () => {
      if (disposed) return;
      if (i >= src.length) {
        if (closed) {
          done(true);
          return;
        }
        // caught up to the network: hold the caret, do not finish
        streamRaf = requestAnimationFrame(step);
        return;
      }
      i = skip ? src.length : i + charsPerFrame(src.length);
      if (i >= src.length && closed) {
        done(true);
        return;
      }
      // render a partial that never leaves a half-written token visible
      let partial = src.slice(0, i);
      partial = partial.replace(/\{\{ev:[a-z0-9_-]*$/i, '');
      const fences = (partial.match(/```/g) || []).length;
      if (fences % 2 === 1) partial += '\n```';
      const stick = atBottom();
      body.innerHTML = renderMarkdown(partial) + '<span class="caret"></span>';
      scrollDown(stick);
      streamRaf = requestAnimationFrame(step);
    };
    streamRaf = requestAnimationFrame(step);

    return {
      push(text) {
        src += text;
      },
      close(e) {
        entry = e || null;
        closed = true;
      },
      /**
       * Tear the shell back down, used when a live answer dies before producing any text. This is
       * an INTERMEDIATE step, not a terminal one: the same reqId is about to be answered from the
       * script, so nothing settles here.
       */
      discard() {
        streaming = false;
        el.classList.remove('is-streaming');
        finishNow = null;
        if (streamRaf) cancelAnimationFrame(streamRaf);
        streamRaf = 0;
        row.remove();
      },
      get length() {
        return src.length;
      },
    };
  }

  function finishStreaming(fireEvidence) {
    if (finishNow) finishNow(fireEvidence !== false);
  }

  log.addEventListener('click', (e) => {
    if (streaming && !e.target.closest('.ev-chip')) finishStreaming();
  });

  // ---------- asking ----------
  function fallbackText() {
    const list = (robotDef.suggested || []).map((s) => `- ${s}`).join('\n');
    return `I have this mission's data loaded. Try one of these:\n\n${list}`;
  }

  /**
   * Scripted answer: instant, hand-verified, no network.
   * `store:false` keeps the exchange out of the transcript — used when the server rejected the
   * question (a 400 stored here would ride along on every later request and 400 those too).
   */
  function answerScripted(q, opts, reqId) {
    const store = !opts || opts.store !== false;
    const entry = matchEntry(q);
    const body = entry ? entry.answer : fallbackText();
    // small think beat so it reads as an analyst, not an echo
    pendingTimer = window.setTimeout(() => {
      pendingTimer = 0;
      if (disposed) return;
      const s = startStream(reqId);
      s.push(body);
      s.close(entry);
      if (store) remember(q, body);
    }, 220);
  }

  /**
   * Live answer from /demo/api/chat. The shell goes up immediately so the caret stands in for a
   * spinner while the model warms up. Any failure before the first token falls back to the
   * scripted answer, so the panel is never dead — the demo still works with the endpoint down.
   */
  async function answerLive(q, reqId) {
    const ctrl = new AbortController();
    inflight = ctrl;
    const s = startStream(reqId);
    let answer = '';
    let entry = null;
    let failure = null;
    let truncated = false;
    let httpStatus = 0;
    let sawFrame = false;

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          robot: robotDef.id,
          messages: history.concat([{ role: 'user', content: q }]),
        }),
        signal: ctrl.signal,
      });
      httpStatus = res.status;
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        // SSE frames are separated by a blank line; a frame can straddle two reads.
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 2);
          if (!frame.startsWith('data:')) continue;
          let msg;
          try {
            msg = JSON.parse(frame.slice(5));
          } catch {
            continue;
          }
          sawFrame = true;
          if (msg.type === 'delta') {
            answer += msg.text;
            s.push(msg.text);
          } else if (msg.type === 'done') {
            entry = { evidence: Array.isArray(msg.evidence) ? msg.evidence : [] };
            truncated = !!msg.truncated;
          } else if (msg.type === 'error') {
            failure = msg.message;
          }
        }
      }

      // Only a `done` frame makes an answer real. A stream that died mid-sentence must not
      // become authoritative history the next question builds on.
      if (!entry || !answer) throw new Error(failure || 'stream ended early');
      if (truncated) {
        const note = '\n\n(cut short)';
        answer += note;
        s.push(note);
      }
      s.close(entry);
      liveFailures = 0; // the endpoint answered; earlier blips are forgiven
      remember(q, answer);
    } catch (err) {
      if (ctrl.signal.aborted) return; // a newer question superseded this one

      // The breaker counts only transport-level failures (endpoint unreachable for this
      // visitor). A well-formed error frame or a 4xx means the server is up: a couple of model
      // refusals must not disable live chat for the whole session.
      const badRequest = httpStatus >= 400 && httpStatus < 500;
      if (!sawFrame && !badRequest) liveFailures++;

      if (answer) {
        // Partial answer, then the stream died: keep what arrived visible with the note, but do
        // not store it and do not fire evidence.
        const note = `\n\n${failure || 'The analyst dropped out. Try that again.'}`;
        s.push(note);
        s.close(null);
      } else {
        s.discard();
        // same reqId: one question, one settle, on the fallback's completion
        answerScripted(q, { store: !badRequest }, reqId);
      }
    } finally {
      if (inflight === ctrl) inflight = null;
    }
  }

  /** Keep a short rolling transcript so follow-ups ("why?", "and the heap?") have context. */
  function remember(q, answer) {
    history.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  }

  /**
   * @param {string} text
   * @param {{live?:boolean}} [opts] `live:false` forces the scripted answer (used for the
   *   auto-fired opener, which should be instant and costs nothing to serve).
   */
  function ask(text, opts) {
    const q = String(text || '').trim();
    if (!q) return;
    // An answer queued by the think beat is still "in flight": without this a second question
    // inside the 220 ms window starts a second, independent typewriter over the same slots.
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
    // finish silently: the abandoned answer's evidence must not drive the timeline
    if (streaming) finishStreaming(false);
    onAsk(q);
    addUser(q);

    const reqId = ++reqSeq;
    const live = (!opts || opts.live !== false) && liveFailures < MAX_LIVE_FAILURES;
    if (live) answerLive(q, reqId);
    else answerScripted(q, null, reqId);
  }

  function askFirstQuestion() {
    // The opener fires on a 420 ms timer from app.js; a quick visitor can beat it by clicking a
    // suggestion. Their question wins: firing the opener anyway would abort their live call and
    // strand their bubble.
    if (log.querySelector('.msg.user')) return;
    // The opener is scripted on purpose: it lands instantly, it is the answer that was written
    // and reviewed for this mission, and it does not spend a model call on every page load.
    if (robotDef.firstQuestion) ask(robotDef.firstQuestion, { live: false });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    ask(v);
  });

  return {
    el,
    ask,
    askFirstQuestion,
    matchEntry,
    finishStreaming,
    get streaming() {
      return streaming;
    },
    focusInput() {
      input.focus();
    },
    dispose() {
      disposed = true;
      if (streamRaf) cancelAnimationFrame(streamRaf);
      if (pendingTimer) window.clearTimeout(pendingTimer);
      if (inflight) inflight.abort();
      inflight = null;
      pendingTimer = 0;
      el.remove();
    },
  };
}
