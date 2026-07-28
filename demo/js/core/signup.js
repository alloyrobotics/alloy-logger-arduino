// signup.js - the post-engagement signup popup.
//
// The demo's bottleneck is signups, not traffic. This module owns the one moment worth asking in:
// after a MEANINGFUL user action (orbiting the 3D scene, scrubbing the mission, clicking the chart
// or an evidence chip, typing a question), it waits for that action to END, waits out a 6 s quiet
// period, and only then puts one dialog over the still-running demo.
//
//   const popup = createSignupPopup(document.body, { href: setupPopupHref });
//   const triggers = createSignupTriggers({ host: demoScreen, popup, isDemoRoute, isStreaming });
//   triggers.chatSettled();   // from createChat's onSettled hook
//   triggers.dispose();       // teardownDemo: detaches every listener, closes an open popup
//
// Two separate one-shots, on purpose:
//   * `everShown` is module scope and survives teardown, so a visitor who walks three demos in one
//     page session still sees this at most once, even with localStorage unavailable.
//   * the idle/armed/timerPending/shown machine is per build and IS reset by teardown.
//
// The localStorage gate is written ON OPEN (an impression is what we are rate limiting, not a
// dismissal), re-checked immediately before opening, and a `storage` event from another tab
// disarms this one.

/** localStorage gate: the timestamp of the last impression. */
const GATE_KEY = 'alloy_signup_seen';
/** How long one impression suppresses the next. */
const GATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Quiet period after the arming action has ended. */
const QUIET_MS = 6000;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

const COPY = {
  heading: "Let's analyse your robot data now",
  body: 'Sign up and get 100GB free. First 100 users only.',
  cta: 'Start streaming free',
  dismiss: 'Keep exploring',
};

/**
 * Page-session one-shot. Deliberately module scope and deliberately NEVER reset by teardown: the
 * old lead form set its flag when the timer was SCHEDULED, so cancelling a pending timer burned
 * the session's only chance. This flag is set when the dialog actually opens.
 */
let everShown = false;

/**
 * Is the visitor inside the cooldown from an earlier impression?
 *
 * Storage is wrapped: Safari private mode throws on getItem, and a thrown gate check would take
 * the caller's event handler down with it.
 */
export function signupGated() {
  try {
    const raw = window.localStorage.getItem(GATE_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return false;
    return Date.now() - at < GATE_MS;
  } catch (err) {
    return false;
  }
}

function setGate() {
  try {
    window.localStorage.setItem(GATE_KEY, String(Date.now()));
  } catch (err) {
    /* storage disabled: `everShown` still caps this at one per page load */
  }
}

/**
 * The dialog itself. Built once at boot and reused across routes, like the header CTAs: it reads
 * its href at open time, so nothing here has to be rebuilt when the demo is.
 *
 * @param {HTMLElement} host node the scrim is appended to (the scrim is position:fixed, so this
 *   only decides document order)
 * @param {{ href?: string, getHref?: () => string }} ctx
 * @returns {{ open:(trigger?:string)=>boolean, close:(reason?:string)=>void, dispose:()=>void, shown:boolean }}
 */
export function createSignupPopup(host, ctx = {}) {
  const getHref = typeof ctx.getHref === 'function' ? ctx.getHref : () => ctx.href || '#';

  const scrim = document.createElement('div');
  scrim.className = 'su-scrim';
  scrim.hidden = true;
  scrim.innerHTML = `
    <div class="su-card" role="dialog" aria-modal="true" aria-labelledby="su-heading"
         aria-describedby="su-body" tabindex="-1">
      <button class="su-x" type="button" aria-label="Close">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      <h2 class="su-h" id="su-heading"></h2>
      <p class="su-sub" id="su-body"></p>
      <div class="su-actions">
        <a class="btn su-cta" href="#" target="_blank" rel="noopener"></a>
        <button class="btn ghost su-later" type="button"></button>
      </div>
    </div>`;
  (host || document.body).appendChild(scrim);

  const card = scrim.querySelector('.su-card');
  const cta = scrim.querySelector('.su-cta');
  const later = scrim.querySelector('.su-later');
  const closeX = scrim.querySelector('.su-x');

  // textContent, never innerHTML: none of this copy is markup and none of it should ever be
  // parsed as any.
  scrim.querySelector('.su-h').textContent = COPY.heading;
  scrim.querySelector('.su-sub').textContent = COPY.body;
  cta.textContent = COPY.cta;
  later.textContent = COPY.dismiss;

  let isOpen = false;
  let openTrigger = null;
  let restoreFocus = null;
  let disposed = false;

  // ---------------------------------------------------------------- focus trap
  function focusables() {
    return Array.from(card.querySelectorAll(FOCUSABLE)).filter(
      (n) => !n.hidden && !n.closest('[hidden]') && n.offsetParent !== null,
    );
  }

  function onKeydown(e) {
    if (!isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close('dismiss');
      return;
    }

    // app.js maps a bare space to play/pause on the demo screen. Inside the dialog that would
    // stop the mission the dialog is selling, so the key never leaves the modal.
    if (e.key === ' ' && card.contains(e.target)) e.stopPropagation();

    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) {
      e.preventDefault();
      card.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = card.contains(active) && active !== card;
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------- open / close
  /**
   * @param {string} [trigger] which arming signal earned the impression, for analytics
   * @returns {boolean} true if the dialog actually opened
   */
  function open(trigger) {
    if (isOpen || disposed) return false;
    isOpen = true;
    openTrigger = trigger || 'engagement';
    restoreFocus = document.activeElement;

    cta.href = getHref();
    // Impression based: the gate is written the moment it goes up, so a visitor who never touches
    // the dialog still gets the quiet period, and a second tab sees the gate immediately.
    setGate();

    scrim.hidden = false;
    document.addEventListener('keydown', onKeydown, false);
    // The card, not the CTA: an auto popup that focuses a link reads as a hijack, and on a phone
    // focusing anything typable would throw up the keyboard over a demo nobody asked to leave.
    card.focus();

    // data-analytics-todo: capture('signup_popup_shown', { trigger: openTrigger })
    return true;
  }

  /**
   * @param {'dismiss'|'cta'|'quiet'} [reason] 'quiet' is teardown closing it behind the visitor's
   *   back; the gate is already written by open() either way.
   */
  function close(reason) {
    if (!isOpen) return;
    isOpen = false;
    scrim.hidden = true;
    document.removeEventListener('keydown', onKeydown, false);

    if (reason === 'dismiss') {
      // data-analytics-todo: capture('signup_popup_dismissed', { trigger: openTrigger })
    }

    if (restoreFocus && typeof restoreFocus.focus === 'function' && restoreFocus.isConnected) {
      restoreFocus.focus();
    }
    restoreFocus = null;
  }

  cta.addEventListener('click', () => {
    // data-analytics-todo: capture('signup_popup_clicked', { trigger: openTrigger })
    // The link opens in a new tab, so the demo is still there behind it: drop the dialog rather
    // than leave it parked over a mission the visitor is coming back to.
    close('cta');
  });
  later.addEventListener('click', () => close('dismiss'));
  closeX.addEventListener('click', () => close('dismiss'));
  scrim.addEventListener('mousedown', (e) => {
    // mousedown, not click: a drag that starts inside the card and ends on the scrim would
    // otherwise count as a dismiss.
    if (e.target === scrim) close('dismiss');
  });

  return {
    open,
    close,
    get shown() {
      return isOpen;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      close('quiet');
      document.removeEventListener('keydown', onKeydown, false);
      scrim.remove();
    },
  };
}

/**
 * The trigger machine: idle -> armed -> timerPending -> shown.
 *
 * Every listener is installed here, per demo build, and detached by dispose(). Nothing arms off a
 * programmatic event: `timeline.onChange` fires on autoplay and on every evidence seek, and
 * `chat.onAsk` fires for the auto-opener, so neither is usable as a signal of a real visitor.
 *
 * @param {{
 *   host: HTMLElement,
 *   popup: { open:(t?:string)=>boolean, close:(r?:string)=>void, shown:boolean },
 *   isDemoRoute?: () => boolean,
 *   isStreaming?: () => boolean,
 * }} ctx
 * @returns {{ chatSettled:()=>void, dispose:()=>void, state:string, holds:string[] }}
 */
export function createSignupTriggers(ctx = {}) {
  const host = ctx.host || document;
  const popup = ctx.popup || null;
  const isDemoRoute = typeof ctx.isDemoRoute === 'function' ? ctx.isDemoRoute : () => true;
  const isStreaming = typeof ctx.isStreaming === 'function' ? ctx.isStreaming : () => false;

  /** 'idle' | 'armed' | 'timerPending' | 'shown'. Reset by dispose(); `everShown` is not. */
  let state = 'idle';
  let timer = 0;
  let trigger = null;
  let disposed = false;
  /** Reasons the visitor is still mid-action. A non-empty set parks the machine in `armed`. */
  const holds = new Set();
  /**
   * Logical answers the visitor is still owed, from questions they typed themselves.
   *
   * `isStreaming()` alone is not enough to cover a question end to end. When a live answer dies
   * before its first token, chat.js discards the shell (clearing `streaming`) and only THEN
   * schedules the scripted fallback on a 220 ms think beat: for those 220 ms the panel reads as
   * idle while the visitor's answer has not been written yet. A quiet timer expiring inside that
   * gap would put the dialog up mid handoff, over a question still being answered. This counter
   * is raised the moment the question is sent and only comes down when chat.js says the answer is
   * on screen, so the whole handoff is one uninterruptible unit.
   */
  let answersPending = 0;
  /** Live pointer ids, so a two finger orbit is one hold and both fingers have to lift. */
  const pointers = new Set();
  let touches = 0;
  /** Detach thunks for every listener installed below. */
  const offs = [];

  function on(node, type, fn, opts) {
    if (!node) return;
    node.addEventListener(type, fn, opts);
    offs.push(() => node.removeEventListener(type, fn, opts));
  }

  // ---------------------------------------------------------------- machine
  function clearTimer() {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
  }

  /** Start (or restart) the quiet window, unless something says the visitor is still mid-action. */
  function schedule() {
    clearTimer();
    if (state !== 'armed' && state !== 'timerPending') return;
    if (holds.size) {
      state = 'armed';
      return;
    }
    state = 'timerPending';
    timer = window.setTimeout(fire, QUIET_MS);
  }

  function arm(kind) {
    if (disposed || everShown || state === 'shown') return;
    if (!popup || popup.shown) return;
    if (signupGated()) return;
    trigger = kind || trigger || 'engagement';
    if (state === 'idle') state = 'armed';
    schedule();
  }

  /** Further activity while armed: the quiet window starts again from here. */
  function bump() {
    if (state !== 'armed' && state !== 'timerPending') return;
    schedule();
  }

  function hold(kind) {
    if (holds.has(kind)) return;
    holds.add(kind);
    schedule();
  }

  function release(kind) {
    if (!holds.delete(kind)) return;
    schedule();
  }

  function syncPointer() {
    if (pointers.size || touches > 0) hold('pointer');
    else release('pointer');
  }

  /** A question just left the composer: hold until chat.js reports its answer rendered. */
  function holdAnswer() {
    answersPending += 1;
    hold('answer');
  }

  /**
   * One settle retires every question asked before it, not just the most recent one. chat.js runs
   * one logical answer at a time and a SUPERSEDED answer never settles: `ask()` calls
   * `finishStreaming(false)`, and that path returns before `settleRequest()`. Coming down by one
   * per settle would therefore strand the hold forever the first time a visitor asked twice in a
   * row. Clamped at zero either way, because settles also arrive for the auto-fired opener, which
   * is not a visitor question and never took a hold.
   */
  function releaseAnswer() {
    if (answersPending === 0) return;
    answersPending = 0;
    release('answer');
  }

  function disarm() {
    clearTimer();
    if (state !== 'shown') state = 'idle';
  }

  function fire() {
    timer = 0;
    if (disposed || state !== 'timerPending') return;
    if (everShown) {
      state = 'idle';
      return;
    }
    // Every guard here has its own release event (pointerup, compositionend, onSettled, the tab
    // coming back), so parking in `armed` is a hold, not a drop.
    if (
      answersPending > 0 ||
      holds.size ||
      isStreaming() ||
      document.visibilityState !== 'visible' ||
      !isDemoRoute()
    ) {
      state = 'armed';
      return;
    }
    // Re-read storage immediately before opening: another tab may have shown it during the window.
    if (signupGated()) {
      disarm();
      return;
    }
    if (!popup || popup.shown) {
      state = 'armed';
      return;
    }
    state = 'shown';
    if (!popup.open(trigger || 'engagement')) {
      // the dialog refused (already open, or disposed under us): no impression, so nothing is spent
      state = 'armed';
      return;
    }
    everShown = true;
  }

  // ---------------------------------------------------------------- arming signals
  const viewerMount = host.querySelector ? host.querySelector('#viewer-mount') : null;
  const canvas = viewerMount ? viewerMount.querySelector('.v-canvas') : null;
  const scrub = viewerMount ? viewerMount.querySelector('.v-scrub') : null;
  const chartCanvas = host.querySelector ? host.querySelector('#chart-mount .chart-canvas') : null;
  const chatMount = host.querySelector ? host.querySelector('#chat-mount') : null;
  const input = chatMount ? chatMount.querySelector('.chat-input') : null;

  // The render surface only. #viewer-mount also holds the scrubber, the transport buttons and the
  // evidence banner, which have their own semantics.
  on(canvas, 'pointerdown', (e) => {
    pointers.add(e.pointerId);
    syncPointer();
    arm('viewer-orbit');
  });
  on(
    canvas,
    'touchstart',
    (e) => {
      touches = e.touches ? e.touches.length : 1;
      syncPointer();
      arm('viewer-orbit');
    },
    { passive: true },
  );
  // OrbitControls zoom. A wheel has no end event, so every notch simply restarts the window.
  on(canvas, 'wheel', () => arm('viewer-zoom'), { passive: true });

  // The scrubber's own controls, including its finding markers. NOT wheel over `.v-scrub`: that
  // does nothing today, so it would arm on ordinary page scrolling.
  on(scrub, 'pointerdown', (e) => {
    pointers.add(e.pointerId);
    syncPointer();
    arm('timeline-scrub');
  });
  on(
    scrub,
    'touchstart',
    (e) => {
      touches = e.touches ? e.touches.length : 1;
      syncPointer();
      arm('timeline-scrub');
    },
    { passive: true },
  );
  on(scrub, 'keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') arm('timeline-keys');
  });

  // `chart:seek`, not `click`: the chart only treats a click as a seek when it lands inside the
  // plot area, and drops one in the padded axis gutters (chart.js onClick). A bare canvas click
  // would arm off a click the chart itself ignored, which is not an engagement signal. chart.js
  // raises this event on the one path that really seeks.
  on(chartCanvas, 'chart:seek', () => arm('chart-seek'));

  // Evidence chips and suggestion chips are created as answers stream, so this is delegated.
  on(chatMount, 'click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.ev-chip, .sugg-chip') : null;
    if (!t) return;
    if (t.classList.contains('sugg-chip')) {
      // A suggestion chip asks a live question just like a typed submit: hold until it settles,
      // or a pre-token failure's 220 ms fallback handoff (streaming already false) could let the
      // timer fire over an unanswered question.
      holdAnswer();
      arm('suggestion-chip');
    } else {
      arm('evidence-chip');
    }
  });

  // A visitor-typed question. Capture phase on the MOUNT, so the value is read before chat.js's
  // own submit handler clears the field. `isTrusted` rejects a programmatic submit.
  on(
    chatMount,
    'submit',
    (e) => {
      if (!e.isTrusted) return;
      const form = e.target;
      if (!form || !form.classList || !form.classList.contains('chat-form')) return;
      const field = form.querySelector('.chat-input');
      const value = field ? String(field.value || '').trim() : '';
      if (!value) return;
      // Hold BEFORE arming, so the window never even starts until the answer is on screen.
      holdAnswer();
      arm('question');
      // chat.js empties the field in its own handler, which runs after this one, and an empty
      // field fires no further input event: without this the composer hold from their typing
      // would outlive the question they just sent.
      release('composer');
    },
    true,
  );

  // ---------------------------------------------------------------- holds
  on(window, 'pointerup', (e) => {
    pointers.delete(e.pointerId);
    syncPointer();
  });
  on(window, 'pointercancel', (e) => {
    pointers.delete(e.pointerId);
    syncPointer();
  });
  on(window, 'touchend', (e) => {
    touches = e.touches ? e.touches.length : 0;
    syncPointer();
  });
  on(window, 'touchcancel', (e) => {
    touches = e.touches ? e.touches.length : 0;
    syncPointer();
  });

  /** Focused composer with something typed in it is a visitor mid-question. */
  function syncComposer(blurred) {
    const typed = input ? String(input.value || '').trim() !== '' : false;
    if (!blurred && typed && document.activeElement === input) hold('composer');
    else release('composer');
  }

  on(input, 'focus', () => syncComposer());
  on(input, 'blur', () => {
    // A composition abandoned by blurring away would otherwise hold forever.
    release('ime');
    syncComposer(true);
  });
  on(input, 'input', () => {
    syncComposer();
    bump();
  });
  on(input, 'keydown', () => bump());
  // An IME composition is held explicitly: a long one must never be outlived by the quiet window.
  on(input, 'compositionstart', () => hold('ime'));
  on(input, 'compositionend', () => {
    release('ime');
    syncComposer();
  });

  if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') {
    holds.add('hidden');
  }
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') release('hidden');
    else hold('hidden');
  });

  // Another tab showed it first: the cooldown is already written, so stand down.
  on(window, 'storage', (e) => {
    if (e.key && e.key !== GATE_KEY) return;
    if (signupGated()) disarm();
  });

  return {
    /** From createChat's onSettled hook: the answer is fully rendered, so the window can run. */
    chatSettled() {
      if (disposed) return;
      releaseAnswer();
      bump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      offs.splice(0).forEach((off) => off());
      holds.clear();
      pointers.clear();
      touches = 0;
      answersPending = 0;
      // `everShown` deliberately survives: one impression per page session, not per demo.
      state = 'idle';
      if (popup && popup.shown) popup.close('quiet');
    },
    // QA/integration handles (page state, not pixels)
    get state() {
      return state;
    },
    get holds() {
      return Array.from(holds);
    },
  };
}
