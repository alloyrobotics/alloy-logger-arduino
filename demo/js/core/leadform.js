// leadform.js - the "now build this for MY robot" lead capture modal.
//
// The demo's whole job is to get a verified email address attached to a real use case. This is
// the one place that happens: a dialog over the running demo (the timeline is never paused, the
// mission keeps playing behind the scrim, because the thing being sold is the thing still moving)
// that posts { use_case, email, robot_seen, website, dwell_ms } to POST /api/demo-gen/submit.
//
//   const form = createLeadForm(document.body, { getDef: () => currentRobotDef });
//   form.open('header');   // or 'evidence' for the one-shot popup
//
// Server contract (worker/demo-gen.js): 202 is ALWAYS success from the visitor's side, including
// the honeypot, dwell and suppression paths, which deliberately look identical to a real submit.
// 400 is a validation miss we should have caught client-side, 429 is a rate window, 413/415 are
// body shape. Nothing here ever learns whether a job row was really created.
//
// The email is verified BEFORE anything is generated, so the confirmed state promises a
// confirmation click, not a demo.

const ENDPOINT = '/api/demo-gen/submit';

/** localStorage gate: set when the visitor dismisses or submits, never when the form opens. */
export const GATE_KEY = 'alloy_leadform_seen';
/** How long a dismissal suppresses the one-shot popup. */
export const GATE_MS = 7 * 24 * 60 * 60 * 1000;

/** The four canned robots. A generated demo's id is a slug and never goes on the wire as one. */
const CANNED = new Set(['sbr', 'arm6', 'drone', 'rescue']);

const MIN_CHARS = 40;
const MAX_CHARS = 600;

/**
 * A VERBATIM copy of the Worker's EMAIL_RE (worker/demo-gen.js). It has to be the same regex, not
 * a looser client-side approximation: anything this accepts and the Worker rejects is a visitor
 * who types a valid-looking address, gets no inline hint, and receives a bare 400 with no
 * explanation. Conservative on purpose there and here.
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;

/** The Worker's other silent 400: a use case has to be at least this many whitespace tokens. */
const MIN_TOKENS = 5;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

const PLACEHOLDER =
  '2v2 RoboCup open-league soccer sim, 4 agents on ROS 2, we keep losing the ball on defensive clears';

/**
 * Three worked examples, one per shape of robot the generator is expected to cover. They are
 * prefills, not templates: the visitor edits them, and the specificity is the point.
 */
const EXAMPLES = [
  { label: 'sim', text: PLACEHOLDER },
  {
    label: 'hardware',
    text: 'SO-101 arm doing tabletop pick and place with a wrist cam, it drops soft objects',
  },
  {
    label: 'fleet',
    text: '12 AMRs in a warehouse on a shared map, two of them keep deadlocking in the same aisle',
  },
];

const COPY = {
  heading: 'Now see it for your robot.',
  sub:
    'Describe your setup and we will build this exact demo for it. Your devices, your channels, ' +
    'your failure. The more specific, the better.',
  privacy: 'We email you the link when it is ready. That is the only thing we use it for.',
  submit: 'Build my demo',
  confirmedHeading: 'Check your email.',
  /** @param {string} email */
  confirmedBody: (email) =>
    `Click the confirmation link we just sent to ${email}, and we start building. ` +
    'The demo link follows, usually within a few hours.',
  queued: 'You already have one queued. Check your inbox.',
  error: 'That did not go through. Try again in a minute.',
  shortHint: `Add a bit more detail, at least ${MIN_CHARS} characters.`,
  tokensHint: `Describe it in words, at least ${MIN_TOKENS} of them.`,
  emailHint: 'That email does not look right.',
};

/**
 * Has the visitor already dismissed or submitted the form inside the cooldown? Read by app.js
 * before it arms the one-shot popup; the header button ignores it on purpose, because a visitor
 * who deliberately clicks "build this for my robot" is asking for the form.
 *
 * Storage is wrapped: Safari private mode throws on getItem, and a thrown gate check would take
 * the demo's evidence handler down with it.
 */
export function leadFormGated() {
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
    /* storage disabled: the popup gets to show again, which is the harmless direction */
  }
}

/**
 * @param {HTMLElement} host node the scrim is appended to (the scrim is position:fixed, so this
 *   only decides document order)
 * @param {{ getDef?: () => (object|null), endpoint?: string }} ctx
 * @returns {{ open:(trigger?:string)=>void, close:(reason?:string)=>void, dispose:()=>void, shown:boolean }}
 */
export function createLeadForm(host, ctx = {}) {
  const endpoint = ctx.endpoint || ENDPOINT;
  const getDef = typeof ctx.getDef === 'function' ? ctx.getDef : () => null;

  const scrim = document.createElement('div');
  scrim.className = 'lead-scrim';
  scrim.hidden = true;
  scrim.innerHTML = `
    <div class="lead-card" role="dialog" aria-modal="true" aria-labelledby="lead-heading"
         aria-describedby="lead-sub" tabindex="-1" data-state="form">
      <button class="lead-x" type="button" aria-label="Close">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>

      <div class="lead-pane lead-pane-form">
        <h2 class="lead-h" id="lead-heading"></h2>
        <p class="lead-sub" id="lead-sub"></p>

        <div class="lead-chips" role="group" aria-label="Example setups"></div>

        <form class="lead-form" novalidate>
          <div class="lead-field">
            <textarea class="lead-ta" id="lead-usecase" name="use_case" rows="4"
                      maxlength="${MAX_CHARS}" required
                      aria-label="Describe your robot and what goes wrong"></textarea>
            <span class="lead-count mono" aria-hidden="true">0/${MAX_CHARS}</span>
          </div>
          <p class="lead-hint" data-for="use_case" hidden></p>

          <div class="lead-hp" aria-hidden="true">
            <label for="lead-website">Website</label>
            <input type="text" id="lead-website" name="website" tabindex="-1" autocomplete="off" />
          </div>

          <input class="lead-email" id="lead-email" name="email" type="email" inputmode="email"
                 autocomplete="email" required placeholder="you@yourlab.com"
                 aria-label="Your email" />
          <p class="lead-hint" data-for="email" hidden></p>

          <p class="lead-fine"></p>
          <p class="lead-err" role="alert" hidden></p>

          <button class="btn lead-submit" type="submit"></button>
        </form>
      </div>

      <div class="lead-pane lead-pane-done" hidden>
        <div class="lead-tick" aria-hidden="true">
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
            <path d="M1 6l4.6 4.6L15 1.2" stroke="currentColor" stroke-width="1.9"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h2 class="lead-h lead-done-h"></h2>
        <p class="lead-sub lead-done-body"></p>
        <button class="btn ghost lead-close" type="button">Back to the demo</button>
      </div>
    </div>`;
  (host || document.body).appendChild(scrim);

  const card = scrim.querySelector('.lead-card');
  const paneForm = scrim.querySelector('.lead-pane-form');
  const paneDone = scrim.querySelector('.lead-pane-done');
  const form = scrim.querySelector('.lead-form');
  const ta = scrim.querySelector('.lead-ta');
  const counter = scrim.querySelector('.lead-count');
  const emailInput = scrim.querySelector('.lead-email');
  const honeypot = scrim.querySelector('.lead-hp input');
  const submitBtn = scrim.querySelector('.lead-submit');
  const errEl = scrim.querySelector('.lead-err');
  const chipRow = scrim.querySelector('.lead-chips');
  const hints = {
    use_case: scrim.querySelector('.lead-hint[data-for="use_case"]'),
    email: scrim.querySelector('.lead-hint[data-for="email"]'),
  };

  // textContent, never innerHTML: none of this copy is markup and none of it should ever be
  // parsed as any.
  scrim.querySelector('.lead-h').textContent = COPY.heading;
  scrim.querySelector('.lead-sub').textContent = COPY.sub;
  scrim.querySelector('.lead-fine').textContent = COPY.privacy;
  submitBtn.textContent = COPY.submit;
  ta.placeholder = PLACEHOLDER;

  EXAMPLES.forEach((ex) => {
    const b = document.createElement('button');
    b.className = 'lead-chip';
    b.type = 'button';
    b.textContent = ex.label;
    b.addEventListener('click', () => {
      ta.value = ex.text;
      syncCounter();
      clearHint('use_case');
      ta.focus();
      // caret to the end, so editing the prefill starts where the visitor would keep typing
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    chipRow.appendChild(b);
  });

  let isOpen = false;
  let state = 'form';
  let openedAt = 0;
  let openTrigger = null;
  let restoreFocus = null;
  let disposed = false;

  function syncCounter() {
    const n = ta.value.length;
    counter.textContent = `${n}/${MAX_CHARS}`;
    counter.classList.toggle('short', n > 0 && n < MIN_CHARS);
  }

  function showHint(which, text) {
    const el = hints[which];
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }
  function clearHint(which) {
    const el = hints[which];
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  function setState(next) {
    state = next;
    card.dataset.state = next;
    const done = next === 'confirmed';
    paneForm.hidden = done;
    paneDone.hidden = !done;
    submitBtn.disabled = next === 'sending';
    submitBtn.textContent = next === 'sending' ? 'Sending' : COPY.submit;
  }

  /** The id we tell the server the visitor was watching, or nothing at all. */
  function robotSeen() {
    const def = getDef();
    if (!def || def.generated) return null;
    return CANNED.has(def.id) ? def.id : null;
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
  function validate() {
    let ok = true;
    const uc = ta.value.trim();
    if (uc.length < MIN_CHARS) {
      showHint('use_case', COPY.shortHint);
      ok = false;
    } else if (uc.split(/\s+/).filter(Boolean).length < MIN_TOKENS) {
      // 40 characters of one long unbroken token passes the length check and is still a silent
      // 400 at the Worker. Same rule, same place the length hint appears.
      showHint('use_case', COPY.tokensHint);
      ok = false;
    } else {
      clearHint('use_case');
    }
    const email = emailInput.value.trim();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      showHint('email', COPY.emailHint);
      ok = false;
    } else {
      clearHint('email');
    }
    return ok;
  }

  function fail(message, reason) {
    setState('error');
    errEl.textContent = message;
    errEl.hidden = false;
    // data-analytics-todo: capture('leadform_failed', { trigger: openTrigger, reason })
  }

  function succeed(email, duplicate) {
    setGate();
    setState('confirmed');
    paneDone.querySelector('.lead-done-h').textContent = COPY.confirmedHeading;
    paneDone.querySelector('.lead-done-body').textContent = duplicate
      ? COPY.queued
      : COPY.confirmedBody(email);
    paneDone.querySelector('.lead-close').focus();
    // data-analytics-todo: capture('leadform_submitted', { trigger: openTrigger, robot: robotSeen(), duplicate })
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state === 'sending') return;
    errEl.hidden = true;
    if (!validate()) {
      const bad = ta.value.trim().length < MIN_CHARS ? ta : emailInput;
      bad.focus();
      return;
    }

    const email = emailInput.value.trim();
    const payload = {
      use_case: ta.value.trim(),
      email,
      website: honeypot.value,
      dwell_ms: Date.now() - openedAt,
    };
    const seen = robotSeen();
    if (seen) payload.robot_seen = seen;

    setState('sending');
    let res = null;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      fail(COPY.error, 'network');
      return;
    }
    if (disposed) return;

    // 202 is the only success the server ever admits to, and it covers the silent-drop paths
    // (honeypot, dwell, suppression) on purpose. Treat every one of them as sent.
    if (res.status === 202) {
      let body = null;
      try {
        body = await res.json();
      } catch (err) {
        body = null;
      }
      succeed(email, Boolean(body && body.duplicate));
      return;
    }
    if (res.status === 429) {
      fail(COPY.queued, 'rate');
      return;
    }
    fail(COPY.error, `http_${res.status}`);
  }

  // ---------------------------------------------------------------- open / close
  function open(trigger) {
    if (isOpen || disposed) return;
    isOpen = true;
    openTrigger = trigger || 'header';
    openedAt = Date.now();
    restoreFocus = document.activeElement;

    errEl.hidden = true;
    clearHint('use_case');
    clearHint('email');
    setState('form');
    syncCounter();

    scrim.hidden = false;
    document.addEventListener('keydown', onKeydown, false);

    // An auto popup that grabs the textarea throws up the phone keyboard over the demo the
    // visitor did not ask to leave, so only a deliberate click lands in the field.
    if (openTrigger === 'header') ta.focus();
    else card.focus();

    // data-analytics-todo: capture('leadform_shown', { trigger: openTrigger })
  }

  /**
   * @param {'dismiss'|'quiet'} [reason] 'dismiss' is the visitor closing it, which arms the
   *   7 day cooldown. 'quiet' is teardown and leaves the gate alone.
   */
  function close(reason) {
    if (!isOpen) return;
    isOpen = false;
    scrim.hidden = true;
    document.removeEventListener('keydown', onKeydown, false);

    if (reason !== 'quiet') {
      setGate();
      // data-analytics-todo: capture('leadform_dismissed', { trigger: openTrigger, state })
    }

    if (restoreFocus && typeof restoreFocus.focus === 'function' && restoreFocus.isConnected) {
      restoreFocus.focus();
    }
    restoreFocus = null;
  }

  ta.addEventListener('input', () => {
    syncCounter();
    const uc = ta.value.trim();
    if (uc.length >= MIN_CHARS && uc.split(/\s+/).filter(Boolean).length >= MIN_TOKENS) clearHint('use_case');
  });
  emailInput.addEventListener('input', () => {
    if (EMAIL_RE.test(emailInput.value.trim())) clearHint('email');
  });
  form.addEventListener('submit', onSubmit);
  scrim.querySelector('.lead-x').addEventListener('click', () => close('dismiss'));
  paneDone.querySelector('.lead-close').addEventListener('click', () => close('dismiss'));
  scrim.addEventListener('mousedown', (e) => {
    // mousedown, not click: a drag that starts inside the textarea and ends on the scrim would
    // otherwise close the dialog and throw the visitor's typing away.
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
