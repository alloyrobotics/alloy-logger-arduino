// signup.js - the post-engagement signup popup.
//
// The demo's bottleneck is signups, not traffic. This module owns the one moment worth asking in:
// after a MEANINGFUL user action (orbiting the 3D scene, scrubbing the mission, clicking the chart
// or an evidence chip, typing a question), it waits for that action to END, waits out a 6 s quiet
// period, and only then puts one dialog over the still-running demo.
//
//   const popup = createSignupPopup(document.body, { getRobot: () => id, src: 'dm' });
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
//
// ---------------------------------------------------------------------------- what arms it
// Only the aha itself: an evidence chip clicked by hand, a suggestion chip, or a typed question.
// Orbiting the scene, scrubbing the mission and clicking the chart are engagement, but they are
// engagement with a 3D toy — a visitor who has done nothing but spin a robot has not yet seen the
// thing being sold, and asking them for an email is spending the session's one ask on a stranger.
// Those surfaces still BUMP (any activity restarts the quiet window, so the dialog never lands
// mid-drag) and still hold on pointer down; they just no longer start the machine.
//
// And nothing arms before `chat:autobeat`, the event chat.js raises when the demo has finished
// playing the scripted chip for the visitor. Before that beat, the visitor is being taught; a chip
// click at that point is them following along, not them driving.

import { getRoleId } from './role.js';
import { track, capture } from './analytics.js';

/** localStorage gate: the timestamp of the last impression. */
const GATE_KEY = 'alloy_signup_seen';
/** How long one impression suppresses the next. */
const GATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Quiet period after the arming action has ended. */
const QUIET_MS = 6000;
/**
 * Belt and braces on the aha gate. chat.js announces `chat:autobeat` on every path it owns, but a
 * demo whose chat panel never got as far as its opener (a build where app.js's 420 ms handoff
 * never ran, a def with no script at all) must not become a page that can never convert. After
 * this long, arming signals are honoured on their own.
 */
const BEAT_GRACE_MS = 15000;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

/** Same-origin capture endpoint. 202 is the only success it ever admits to. */
const ENDPOINT = '/api/signup-lead';

/**
 * Deliberately loose. The server is the authority on what it will store, and a client regex that
 * argues with a real address is a lost lead: this only catches the obvious typo before the round
 * trip, and the 400 `bad_email` path repeats the same message for anything it lets through.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COPY = {
  heading: "Let's analyse your robot data now",
  body: 'Sign up and get 100GB free. First 100 users only.',
  placeholder: 'Work email',
  submit: 'Claim 100GB free',
  sending: 'Sending',
  emailHint: "That email doesn't look right.",
  error: 'Something broke. Try again.',
  confirmedHeading: "You're in.",
  confirmedBody: "We'll set you up and email your access shortly.",
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
 * The dialog itself. Built once at boot and reused across routes: it reads the current robot at
 * submit time, so nothing here has to be rebuilt when the demo is.
 *
 * It captures the email in place rather than linking out. A link-out spends the session's one ask
 * on a tab switch and loses everyone whose browser eats the popup or who never finishes the signup
 * form on the far side; a single field posts the lead the moment it is typed and leaves the demo
 * running underneath.
 *
 * Dismissal is explicit only: the X or Escape, in every state. Clicking the scrim does nothing,
 * because the card is near fullscreen and a mis-click on the sliver of scrim around it would throw
 * away that single ask.
 *
 * @param {HTMLElement} host node the scrim is appended to (the scrim is position:fixed, so this
 *   only decides document order)
 * @param {{ endpoint?: string, getRobot?: () => (string|null), src?: string|null }} ctx
 *   `getRobot` is read at submit time (the visitor may have walked several demos); `src` is the
 *   channel tag the visitor arrived on, fixed for the page load.
 * @returns {{ open:(trigger?:string)=>boolean, close:(reason?:string)=>void, dispose:()=>void, shown:boolean, state:string }}
 */
export function createSignupPopup(host, ctx = {}) {
  const endpoint = ctx.endpoint || ENDPOINT;
  const getRobot = typeof ctx.getRobot === 'function' ? ctx.getRobot : () => null;
  const src = ctx.src ? String(ctx.src) : null;

  const scrim = document.createElement('div');
  scrim.className = 'su-scrim';
  scrim.hidden = true;
  scrim.innerHTML = `
    <div class="su-card" role="dialog" aria-modal="true" aria-labelledby="su-heading"
         aria-describedby="su-body" tabindex="-1" data-state="form">
      <button class="su-x" type="button" aria-label="Close">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>

      <div class="su-pane-form">
        <h2 class="su-h" id="su-heading"></h2>
        <p class="su-sub" id="su-body"></p>
        <form class="su-form" novalidate>
          <div class="su-hp" aria-hidden="true">
            <label for="su-website">Website</label>
            <input class="su-hp-input" type="text" id="su-website" name="website"
                   tabindex="-1" autocomplete="off" />
          </div>
          <input class="su-email" id="su-email" name="email" type="email" inputmode="email"
                 autocomplete="email" aria-label="Work email" />
          <button class="btn su-submit" type="submit"></button>
        </form>
        <p class="su-err" role="alert" hidden></p>
      </div>

      <div class="su-pane-done" hidden>
        <h2 class="su-h su-done-h" id="su-done-heading"></h2>
        <p class="su-sub su-done-body" id="su-done-body"></p>
      </div>
    </div>`;
  (host || document.body).appendChild(scrim);

  const card = scrim.querySelector('.su-card');
  const closeX = scrim.querySelector('.su-x');
  const paneForm = scrim.querySelector('.su-pane-form');
  const paneDone = scrim.querySelector('.su-pane-done');
  const form = paneForm.querySelector('.su-form');
  const emailInput = paneForm.querySelector('.su-email');
  const honeypot = paneForm.querySelector('.su-hp-input');
  const submitBtn = paneForm.querySelector('.su-submit');
  const errEl = paneForm.querySelector('.su-err');

  // textContent, never innerHTML: none of this copy is markup and none of it should ever be
  // parsed as any.
  paneForm.querySelector('.su-h').textContent = COPY.heading;
  paneForm.querySelector('.su-sub').textContent = COPY.body;
  paneDone.querySelector('.su-done-h').textContent = COPY.confirmedHeading;
  paneDone.querySelector('.su-done-body').textContent = COPY.confirmedBody;
  submitBtn.textContent = COPY.submit;
  emailInput.placeholder = COPY.placeholder;

  let isOpen = false;
  let openTrigger = null;
  let restoreFocus = null;
  let disposed = false;
  /** 'form' | 'sending' | 'confirmed' | 'error'. Mirrored onto card.dataset.state for QA and CSS. */
  let state = 'form';
  /** Wall clock at open, for the dwell the server uses to score the lead. */
  let openedAt = 0;

  // ---------------------------------------------------------------- state
  function setState(next) {
    state = next;
    card.dataset.state = next;
    const done = next === 'confirmed';
    paneForm.hidden = done;
    paneDone.hidden = !done;
    // The dialog's name and description must follow the pane that is actually on screen. Left
    // pointing at the form's heading, a screen reader announces the confirmed dialog as the ask
    // the visitor just answered, and the `hidden` pane it names is not exposed at all, so the
    // dialog reads as unlabelled to some ATs and as stale to the rest.
    card.setAttribute('aria-labelledby', done ? 'su-done-heading' : 'su-heading');
    card.setAttribute('aria-describedby', done ? 'su-done-body' : 'su-body');
    submitBtn.disabled = next === 'sending';
    submitBtn.textContent = next === 'sending' ? COPY.sending : COPY.submit;
  }

  function showError(message) {
    errEl.textContent = message;
    errEl.hidden = false;
  }

  function clearError() {
    errEl.hidden = true;
    errEl.textContent = '';
  }

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

  // ---------------------------------------------------------------- submit
  /**
   * One field, so validation is one rule. The value is never cleared on any failure path: the
   * visitor re-submits the address already sitting in the box.
   */
  async function onSubmit(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (state === 'sending' || state === 'confirmed' || disposed) return;
    clearError();

    const email = String(emailInput.value || '').trim();
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      setState('error');
      showError(COPY.emailHint);
      emailInput.focus();
      return;
    }

    // `role` is read at submit time, not at construction: the dialog outlives every route, and a
    // visitor can fork, explore, and land here having changed nothing but their seat. Null for a
    // visitor who never went through the fork, which the worker stores as NULL.
    const payload = {
      email,
      hp: String(honeypot.value || ''),
      dwell_ms: Math.max(0, Date.now() - openedAt),
      robot: getRobot() || null,
      role: getRoleId(),
      src,
    };

    setState('sending');
    let res = null;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (disposed) return;
      setState('error');
      showError(COPY.error);
      return;
    }
    if (disposed) return;

    // 202 is the only success the server ever admits to, and it deliberately covers the silent
    // drops (honeypot, per-IP cap, duplicate). Every one of them is a send as far as this is
    // concerned: the alternative leaks who is already on the list.
    if (res.status === 202) {
      setState('confirmed');
      // The end of the funnel. The email identifies the person in PostHog and is deliberately not
      // sent as an event property (analytics.js splits it out): a lead's address belongs on their
      // profile, not on a row anyone reading the funnel can see.
      track.leadSubmitted(payload.robot, {
        email,
        src,
        trigger: openTrigger,
        dwell_ms: payload.dwell_ms,
      });
      closeX.focus();
      return;
    }

    let reason = '';
    if (res.status === 400) {
      try {
        const body = await res.json();
        reason = body && body.reason ? String(body.reason) : '';
      } catch (err) {
        reason = '';
      }
      if (disposed) return;
    }
    setState('error');
    showError(reason === 'bad_email' ? COPY.emailHint : COPY.error);
    if (reason === 'bad_email') emailInput.focus();
    // Not one of the nine funnel events: a submit that got as far as an error is a lead the page
    // nearly had, and the rate of it is the difference between "nobody wants this" and "the
    // endpoint is broken".
    capture('signup_popup_failed', {
      trigger: openTrigger,
      robot: payload.robot,
      status: res.status,
      reason: reason || null,
    });
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
    openedAt = Date.now();
    restoreFocus = document.activeElement;

    clearError();
    setState('form');
    // Impression based: the gate is written the moment it goes up, so a visitor who never touches
    // the dialog still gets the quiet period, and a second tab sees the gate immediately.
    setGate();

    scrim.hidden = false;
    document.addEventListener('keydown', onKeydown, false);
    // The card, never the email field: on a phone, focusing anything typable throws the keyboard
    // up over a demo nobody asked to leave, and an auto popup that grabs the caret reads as a
    // hijack. Only a deliberate tap lands in the input.
    card.focus();

    track.popupShown(getRobot() || null, openTrigger);
    return true;
  }

  /**
   * @param {'dismiss'|'quiet'} [reason] 'quiet' is teardown closing it behind the visitor's back;
   *   the gate is already written by open() either way. Closing is allowed in every state,
   *   including mid-send: the request is already in flight and the server is the source of truth,
   *   so nothing is lost by taking the card away.
   */
  function close(reason) {
    if (!isOpen) return;
    isOpen = false;
    scrim.hidden = true;
    document.removeEventListener('keydown', onKeydown, false);

    // Only an explicit dismissal is reported. A 'quiet' close is teardown taking the card away
    // behind the visitor's back, which says nothing about what they wanted.
    if (reason === 'dismiss') {
      capture('signup_popup_dismissed', {
        trigger: openTrigger,
        robot: getRobot() || null,
        state,
      });
    }

    if (restoreFocus && typeof restoreFocus.focus === 'function' && restoreFocus.isConnected) {
      restoreFocus.focus();
    }
    restoreFocus = null;
  }

  form.addEventListener('submit', onSubmit);
  // Typing again after a rejection clears the complaint, so the message never outlives the value
  // it was about.
  emailInput.addEventListener('input', () => {
    if (state === 'error') {
      setState('form');
      clearError();
    }
  });
  closeX.addEventListener('click', () => close('dismiss'));
  // Deliberately NO scrim click/mousedown dismissal. The card is near fullscreen, so a stray click
  // anywhere off it would land on the scrim and close the one ask of the session by accident.
  // Dismissal is explicit only: the X or Escape, in every state.

  return {
    open,
    close,
    get shown() {
      return isOpen;
    },
    get state() {
      return state;
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
  /**
   * Has the demo finished showing the visitor what an evidence chip does (`chat:autobeat`)?
   * Until it has, an arming signal is PARKED rather than dropped: a chip click one frame before
   * the announcement is still an aha, and throwing it away would cost the page a real lead for a
   * race the visitor cannot see.
   */
  let beatDone = false;
  let parked = null;
  let graceTimer = 0;

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
    // Before the scripted beat, hold the signal instead of acting on it or losing it.
    if (!beatDone) {
      parked = kind || parked || 'engagement';
      return;
    }
    trigger = kind || trigger || 'engagement';
    if (state === 'idle') state = 'armed';
    schedule();
  }

  /**
   * `chat:autobeat`, or the grace timer. Anything the visitor did while the beat was still running
   * is honoured now, with the trigger it was originally parked under, so the reported trigger is
   * still the interaction that earned the impression.
   */
  function beatFinished() {
    if (disposed || beatDone) return;
    beatDone = true;
    if (graceTimer) {
      window.clearTimeout(graceTimer);
      graceTimer = 0;
    }
    if (parked) {
      const kind = parked;
      parked = null;
      arm(kind);
    }
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

  // The three surfaces below no longer ARM. They are still tracked, because a hold and a bump are
  // about not interrupting the visitor, and that is true whether or not the machine started here:
  // pointers held down keep the dialog off the screen, and any activity restarts the quiet window.
  //
  // The render surface only. #viewer-mount also holds the scrubber, the transport buttons and the
  // evidence banner, which have their own semantics.
  on(canvas, 'pointerdown', (e) => {
    pointers.add(e.pointerId);
    syncPointer();
    bump();
  });
  on(
    canvas,
    'touchstart',
    (e) => {
      touches = e.touches ? e.touches.length : 1;
      syncPointer();
      bump();
    },
    { passive: true },
  );
  // OrbitControls zoom. A wheel has no end event, so every notch simply restarts the window.
  on(canvas, 'wheel', () => bump(), { passive: true });

  // The scrubber's own controls, including its finding markers. NOT wheel over `.v-scrub`: that
  // does nothing today, so it would fire on ordinary page scrolling.
  on(scrub, 'pointerdown', (e) => {
    pointers.add(e.pointerId);
    syncPointer();
    bump();
  });
  on(
    scrub,
    'touchstart',
    (e) => {
      touches = e.touches ? e.touches.length : 1;
      syncPointer();
      bump();
    },
    { passive: true },
  );
  on(scrub, 'keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') bump();
  });

  // `chart:seek`, not `click`: the chart only treats a click as a seek when it lands inside the
  // plot area, and drops one in the padded axis gutters (chart.js onClick). chart.js raises this
  // event on the one path that really seeks.
  on(chartCanvas, 'chart:seek', () => bump());

  // The beat, from chat.js. Delegated on the mount rather than the panel: the chat element is
  // rebuilt with the demo, the mount is not.
  on(chatMount, 'chat:autobeat', () => beatFinished());
  graceTimer = window.setTimeout(beatFinished, BEAT_GRACE_MS);

  // THE arming signals: a chip the visitor clicked, a suggestion they chose, a question they
  // typed. Evidence chips and suggestion chips are created as answers stream, so this is
  // delegated. A click event is a real click: the auto-played beat calls onEvidence directly and
  // never dispatches one, so the demo playing its own chip cannot arm this.
  on(chatMount, 'click', (e) => {
    // `isTrusted`, the same guard the submit path below carries. The auto-played beat calls
    // onEvidence directly and dispatches nothing, so this is belt and braces today, but the whole
    // point of this listener is that it fires for a real interaction: a synthetic click from a
    // future replay helper, a test harness or an extension must not be able to mint the aha.
    if (!e.isTrusted) return;
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
      if (graceTimer) {
        window.clearTimeout(graceTimer);
        graceTimer = 0;
      }
      parked = null;
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
    /** Whether the scripted beat has been announced, and what is waiting on it. */
    get beatDone() {
      return beatDone;
    },
    get parked() {
      return parked;
    },
  };
}
