// start.js - the seat fork at #/start.
//
// A card selects a work function. The single Continue button persists it, records role_selected,
// and advances.

import { ROLES, getRoleId, setRole, roleById } from './role.js';
import { track } from './analytics.js';

const COPY = {
  title: 'What do you do?',
  sub: 'This will help personalize the demo experience.',
  continue: 'Continue',
};

const LABELS = Object.freeze({
  hobbyist: 'Hobbyist',
  engineer: 'Engineer',
  lead: 'Leadership',
  marketing: 'Marketing, support, or sales',
});

/**
 * @param {HTMLElement|object} [mountOrOpts]
 * @param {{
 *   onPick?: (role:object) => void,
 *   persist?: boolean,
 *   copy?: object,
 * }} [maybeOpts]
 * @returns {{el:HTMLElement, focus:()=>void, current:()=>string|null,
 *   select:(id:string)=>object|null, pick:(id:string)=>object|null, dispose:()=>void}}
 */
export function createStart(mountOrOpts, maybeOpts) {
  const isEl = !!(mountOrOpts && typeof mountOrOpts === 'object' && mountOrOpts.nodeType === 1);
  const mount = isEl ? mountOrOpts : null;
  const opts = (isEl ? maybeOpts : mountOrOpts) || {};
  const onPick = typeof opts.onPick === 'function' ? opts.onPick : () => {};
  const persist = opts.persist !== false;
  const copy = { ...COPY, ...(opts.copy || {}) };
  const arrivalId = getRoleId();

  const el = document.createElement('div');
  el.className = 'st';
  el.innerHTML = `
    <header class="st-head">
      <h1 class="st-title"></h1>
      <p class="st-sub"></p>
    </header>
    <div class="st-cards" role="radiogroup"></div>
    <button class="st-continue" type="button" disabled><span></span><span aria-hidden="true">→</span></button>`;

  const q = (sel) => el.querySelector(sel);
  q('.st-title').textContent = copy.title;
  q('.st-sub').textContent = copy.sub;
  q('.st-continue span').textContent = copy.continue;

  const cards = q('.st-cards');
  cards.setAttribute('aria-label', copy.title);
  const continueButton = q('.st-continue');
  let selectedId = arrivalId;
  let committed = false;
  let disposed = false;

  ROLES.forEach((role) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'st-card';
    button.dataset.role = role.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(role.id === selectedId));
    button.innerHTML = '<span class="st-radio" aria-hidden="true"><i></i></span><span class="st-label"></span>';
    button.querySelector('.st-label').textContent = LABELS[role.id] || role.label;
    if (role.id === selectedId) button.classList.add('is-selected');
    cards.appendChild(button);
  });
  continueButton.disabled = !selectedId;

  if (mount) mount.appendChild(el);

  function renderSelection() {
    cards.querySelectorAll('.st-card').forEach((button) => {
      const selected = button.dataset.role === selectedId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', String(selected));
    });
    continueButton.disabled = !selectedId || committed;
  }

  function select(id) {
    if (disposed || committed) return null;
    const role = roleById(id);
    if (!role) return null;
    selectedId = role.id;
    renderSelection();
    return role;
  }

  function commit(id = selectedId) {
    if (disposed || committed) return null;
    const role = roleById(id);
    if (!role) return null;
    selectedId = role.id;
    committed = true;
    el.classList.add('st-picked');
    renderSelection();
    if (persist) setRole(role.id);
    track.roleSelected(role, { returning: role.id === arrivalId, mission: role.mission });
    onPick(role);
    return role;
  }

  function onCardsClick(event) {
    const card = event.target && event.target.closest ? event.target.closest('.st-card') : null;
    if (!card) return;
    event.preventDefault();
    select(card.dataset.role);
  }

  function onCardsKey(event) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    const list = Array.from(cards.querySelectorAll('.st-card'));
    if (!list.length) return;
    const at = list.indexOf(document.activeElement && document.activeElement.closest('.st-card'));
    const next = at < 0 ? 0 : (at + (forward ? 1 : -1) + list.length) % list.length;
    event.preventDefault();
    list[next].focus();
    select(list[next].dataset.role);
  }

  function onContinue() {
    commit();
  }

  cards.addEventListener('click', onCardsClick);
  cards.addEventListener('keydown', onCardsKey);
  continueButton.addEventListener('click', onContinue);

  return {
    el,
    focus() {
      const selected = cards.querySelector('.st-card.is-selected');
      const first = cards.querySelector('.st-card');
      (selected || first)?.focus();
    },
    current: () => selectedId,
    select,
    pick: commit,
    dispose() {
      if (disposed) return;
      disposed = true;
      cards.removeEventListener('click', onCardsClick);
      cards.removeEventListener('keydown', onCardsKey);
      continueButton.removeEventListener('click', onContinue);
      el.remove();
    },
  };
}
