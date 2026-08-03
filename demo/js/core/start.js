// start.js - `#/start`, the first screen. One question, one tap, three cards.
//
// The fork is by WORK FUNCTION, never by identity: what the visitor does with robots decides the
// register the analyst answers in, which mission they are guided into, and how beat 2's old-way
// panel is captioned. There is no multi-select and no Continue button, because a form is a gate
// and this screen is a doorway: the tap IS the submit. The escape hatch ("just exploring") goes
// straight to the seven-mission picker and leaves no role behind.
//
//   const start = createStart({
//     onPick: (role) => { location.hash = `#/connect/${role.mission}`; },
//     onExplore: () => { location.hash = '#/'; },
//   });
//   screens.start.appendChild(start.el);   // the router mounts it like any other screen
//   start.dispose();
//
// The tap persists the role (role.js) and fires `role_selected` (analytics.js) BEFORE `onPick`
// runs, so the router never has to remember to do either, and every event after this point is
// already segmented. Pass `persist: false` to take that over.
//
// Styling hooks are classes only, all `st-` prefixed, and the integrator owns every one of them in
// index.html. Nothing here sets a colour, a size or a layout.

import { ROLES, getRoleId, setRole, roleById } from './role.js';
import { track } from './analytics.js';

const COPY = {
  kicker: 'alloylogger live demo',
  title: 'Your robot failed. Ask it why.',
  // "a mission, real or simulated": four of the seven are synthetic scenarios and one is a scripted
  // simulation, so the blanket "a real mission" was a claim this screen cannot make. app.js passes
  // the spec's locked sub-line over the top of this one; it is the module default, and a second
  // caller (a test harness, an embed) would otherwise ship the false version.
  sub: 'Replay a mission, real or simulated, and put its telemetry in front of an analyst. First, what do you do with robots?',
  // Not "only changes how the answers are pitched": the tap also picks the mission the visitor
  // lands on and is persisted, so `#/` sends them back to it. "Only" was false about the most
  // consequential half of the tap, and undersold the half that is actually good.
  hint: 'It picks the mission you land on and how the answers are pitched. You can change it later.',
  escape: 'Just exploring. Show me every mission',
  go: 'start here',
};

/**
 * @param {HTMLElement|object} [mountOrOpts] the screen's options. An element is accepted as the
 *   first argument too, in which case the panel is appended to it and the options move along one:
 *   `createStart(mount, opts)` and `createStart(opts)` both work, so a router that mounts screens
 *   the way the other modules expect cannot silently build a panel that is never attached.
 * @param {{
 *   onPick?: (role:object) => void,
 *   onExplore?: () => void,
 *   persist?: boolean,
 *   copy?: object,
 * }} [maybeOpts]
 * @returns {{el:HTMLElement, focus:()=>void, current:()=>string|null,
 *   pick:(id:string)=>object|null, dispose:()=>void}}
 */
export function createStart(mountOrOpts, maybeOpts) {
  const isEl = !!(mountOrOpts && typeof mountOrOpts === 'object' && mountOrOpts.nodeType === 1);
  const mount = isEl ? mountOrOpts : null;
  const opts = (isEl ? maybeOpts : mountOrOpts) || {};

  const onPick = typeof opts.onPick === 'function' ? opts.onPick : () => {};
  const onExplore = typeof opts.onExplore === 'function' ? opts.onExplore : null;
  const persist = opts.persist !== false;
  const copy = { ...COPY, ...(opts.copy || {}) };

  // The role a returning visitor already chose. The card is marked, never auto-advanced: bouncing
  // someone straight past the only screen they can change their mind on is a trap, not a shortcut.
  const currentId = getRoleId();

  const el = document.createElement('div');
  el.className = 'st';

  el.innerHTML = `
    <header class="st-head">
      <p class="st-kicker mono"></p>
      <h1 class="st-title"></h1>
      <p class="st-sub"></p>
    </header>
    <div class="st-cards" role="group"></div>
    <p class="st-hint"></p>
    <a class="st-escape" href="#/"><span></span> <span class="st-escape-go" aria-hidden="true">&rsaquo;</span></a>`;

  const q = (sel) => el.querySelector(sel);
  q('.st-kicker').textContent = copy.kicker;
  q('.st-title').textContent = copy.title;
  q('.st-sub').textContent = copy.sub;
  q('.st-hint').textContent = copy.hint;
  q('.st-escape span').textContent = copy.escape;

  const cards = q('.st-cards');
  cards.setAttribute('aria-label', copy.title);

  ROLES.forEach((role) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'st-card';
    btn.dataset.role = role.id;
    if (role.id === currentId) btn.classList.add('is-current');
    btn.innerHTML = `
      <span class="st-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">${role.glyph}</svg>
      </span>
      <span class="st-kick mono"></span>
      <span class="st-label"></span>
      <span class="st-blurb"></span>
      <span class="st-go mono"></span>`;
    btn.querySelector('.st-kick').textContent = role.kicker;
    btn.querySelector('.st-label').textContent = role.label;
    btn.querySelector('.st-blurb').textContent = role.blurb;
    // a returning visitor is told which one they are on, in the slot that otherwise says "start here"
    btn.querySelector('.st-go').textContent =
      role.id === currentId ? 'continue' : copy.go;
    // the visible label is the whole card; the accessible name should be the sentence, not the glyph
    btn.setAttribute('aria-label', `${role.label}. ${role.blurb}`);
    cards.appendChild(btn);
  });

  if (mount) mount.appendChild(el);

  let picked = false;
  let disposed = false;

  /**
   * Take a role. Exactly once per screen, ever: a double tap, or a tap during the route change
   * the first one started, must not fire a second `role_selected` or a second navigation.
   *
   * @param {string} id
   * @returns {object|null} the role record, or null if the id is not a role
   */
  function choose(id) {
    if (picked || disposed) return null;
    const role = roleById(id);
    if (!role) return null;
    picked = true;
    el.classList.add('st-picked');
    const card = cards.querySelector(`.st-card[data-role="${role.id}"]`);
    if (card) card.classList.add('is-picked');

    // order matters: persist, then report, then navigate. The super-prop has to be registered
    // before `role_selected` leaves, or the fork's own event is the one row missing its role.
    if (persist) setRole(role.id);
    track.roleSelected(role, { returning: role.id === currentId, mission: role.mission });
    onPick(role);
    return role;
  }

  function onClick(e) {
    const card = e.target && e.target.closest ? e.target.closest('.st-card') : null;
    if (!card) return;
    e.preventDefault();
    choose(card.dataset.role);
  }

  /** Left/right (and up/down) walk the three cards. Tab and Enter already work: these are buttons. */
  function onKey(e) {
    const key = e.key;
    const fwd = key === 'ArrowRight' || key === 'ArrowDown';
    const back = key === 'ArrowLeft' || key === 'ArrowUp';
    if (!fwd && !back) return;
    const list = Array.from(cards.querySelectorAll('.st-card'));
    if (!list.length) return;
    const at = list.indexOf(document.activeElement && document.activeElement.closest('.st-card'));
    const next = at < 0 ? 0 : (at + (fwd ? 1 : -1) + list.length) % list.length;
    e.preventDefault();
    list[next].focus();
  }

  function onEscapeClick(e) {
    // With no handler the anchor's own href is the behaviour, which is the right fallback: the
    // picker is a real route. A handler takes it over so the router can decide (and so leaving
    // deliberately WITHOUT a role stays one code path).
    if (!onExplore || picked || disposed) return;
    e.preventDefault();
    picked = true;
    onExplore();
  }

  cards.addEventListener('click', onClick);
  cards.addEventListener('keydown', onKey);
  const escape = q('.st-escape');
  escape.addEventListener('click', onEscapeClick);

  return {
    el,

    /** Move focus onto the fork: the returning visitor's card, or the first one. */
    focus() {
      const card =
        cards.querySelector('.st-card.is-current') || cards.querySelector('.st-card');
      if (card && typeof card.focus === 'function') card.focus();
    },

    /** The role this visitor arrived with, if any. Page state for QA, not a pixel. */
    current: () => currentId,

    /** Programmatic tap, for deep links and for QA. Runs the full persist/report/advance path. */
    pick: choose,

    /** Idempotent, and safe when the mount has already been emptied out from under us. */
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        cards.removeEventListener('click', onClick);
        cards.removeEventListener('keydown', onKey);
        escape.removeEventListener('click', onEscapeClick);
      } catch (_) {
        /* nodes already gone: listeners went with them */
      }
      if (el && typeof el.remove === 'function') el.remove();
    },
  };
}
