// mocks/inbox.js - beat 2 for the person who never touched the robot: a ticket inbox with the log
// attached to it.
//
// This is the family for support, CS and field ops. Their artefact is not a live stream at all; it
// is a message from somebody else, after the fact, with a file on the end of it. The argument the
// panel makes is the one that register actually lives: the machine has already been rebooted, the
// person who saw it has moved on, and the only evidence left is an attachment with no index, no
// search and no idea what you are looking for. It streams because opening it is the moment you
// realise how much of it there is.
//
// GENERIC CHROME ONLY. No product name, no logo, no imitation of anybody's mail client, and no
// invented people: the senders are queue names, the recipient is "you", and there is no address,
// no domain and no signature. Nothing on this screen is a document about a real person or company.
// What makes it read as an inbox is the grammar every ticket tool shares: a message list with a
// selected row, a thread header with a from/to line, a short body, an attachment chip, and an
// inline preview of the file.
//
// HONESTY. The attachment is described in the units this screen can actually count - lines,
// channels, values, all straight off `oldWayStats` - and never in an invented file size. The
// preview is the same printed line script every other family reads.
//
// Factory contract: (mount, def, opts) => { el, skip, dispose }, widened per mocks/base.js.

import {
  h,
  svg,
  loc,
  costLine,
  wallLabel,
  portLine,
  resolveCopy,
  createMockShell,
} from './base.js';

/** Stable family id. Rides the `seen` event, so it is never renamed once shipped. */
export const FAMILY = 'inbox';
/** The tool class this chrome imitates, in the words a caption would use. */
export const TOOL_CLASS = 'Ticket inbox';

/** Fallback attachment name when neither the role nor the def names the artefact. */
const DEFAULT_FILE = 'field-dump.log';

/**
 * @param {HTMLElement} mount
 * @param {object} def robot definition. Telemetry is used only if it is already attached.
 * @param {{role?:string|object, data?:object|null, onSeen?:Function, autostart?:boolean,
 *   stepMs?:number, maxRows?:number, reduceMotion?:boolean, tool?:string, caption?:string,
 *   file?:string}} [opts]
 * @returns {object} the standard mock handle (see mocks/base.js)
 */
export function createInboxMock(mount, def, opts = {}) {
  return createMockShell(mount, def, opts, {
    family: FAMILY,
    toolClass: TOOL_CLASS,
    build({ root, runtime, def: robot, role }) {
      const copy = resolveCopy(role, opts, TOOL_CLASS);
      const machine = robot.name || robot.id || 'the robot';
      let file = fileName(role, opts);

      // ---- chrome ------------------------------------------------------------------
      const head = h('div', 'mk-head');
      const toolEl = h('span', 'mk-tool mono', copy.tool);
      const portEl = h('span', 'mk-port mono', portLine(robot, role));
      head.append(toolEl, portEl);

      const body = h('div', 'mk-inbox-body');

      // ---- left: the queue ---------------------------------------------------------
      const list = h('div', 'mk-inbox-list');
      const threads = [
        {
          from: 'Field ops',
          subject: `Log from ${machine}, it did it again`,
          preview: 'Attaching the dump off the unit. It did the same thing again.',
          time: '09:22',
          unread: true,
          selected: true,
        },
        {
          from: 'On call',
          subject: 'Same symptom, second time this week',
          preview: 'Rebooted it and it ran fine after. No idea what to look at.',
          time: '08:41',
          unread: true,
        },
        {
          from: 'Support queue',
          subject: 'Customer is asking for an answer today',
          preview: 'They want to know whether it is the unit or the site.',
          time: 'Yesterday',
        },
        {
          from: 'Bench',
          subject: 'Overnight soak finished, nothing reproduced',
          preview: 'Ran it for eight hours on the bench. Clean.',
          time: 'Yesterday',
        },
      ];
      threads.forEach((t) => {
        const item = h('div', `mk-inbox-item${t.selected ? ' is-selected' : ''}`);
        if (t.unread) item.classList.add('is-unread');
        const dot = h('i', 'mk-inbox-unread');
        dot.setAttribute('aria-hidden', 'true');
        const main = h('div', 'mk-inbox-itemmain');
        const top = h('div', 'mk-inbox-itemtop');
        top.append(h('span', 'mk-inbox-from', t.from), h('span', 'mk-inbox-time mono', t.time));
        const subj = h('div', 'mk-inbox-subject', t.subject);
        main.append(top, subj, h('div', 'mk-inbox-snippet', t.preview));
        item.append(dot, main);
        list.appendChild(item);
      });

      // ---- right: the thread -------------------------------------------------------
      const thread = h('div', 'mk-inbox-thread');
      const subjectEl = h('h4', 'mk-inbox-threadsubject', threads[0].subject);
      const meta = h('div', 'mk-inbox-meta mono');
      meta.append(
        h('span', 'mk-inbox-avatar', 'F'),
        h('span', 'mk-inbox-metafrom', 'Field ops'),
        h('span', 'mk-inbox-metato', 'to you'),
        h('span', 'mk-inbox-metatime', '09:22'),
      );
      const prose = h('div', 'mk-inbox-prose');
      // The body never interpolates the machine's name into a sentence: `def.name` is a display
      // label ("Self-balancing robot", "SSL soccer fleet"), and dropping one mid-clause produced
      // "we stood Self-balancing robot back up". The subject line is where the name belongs.
      prose.append(
        h(
          'p',
          null,
          'It did the same thing again this morning. We power cycled it on site and it carried ' +
            'on, so there was nothing to see by the time I got there.',
        ),
        h(
          'p',
          null,
          'Pulled the log off it before we left. That is everything it recorded, I have not been ' +
            'through it.',
        ),
      );

      const att = h('div', 'mk-inbox-attach');
      const clip = svg('svg', {
        class: 'mk-inbox-clip',
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.4',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        focusable: 'false',
      });
      clip.appendChild(
        svg('path', { d: 'M10.5 5.5 6.2 9.8a1.7 1.7 0 0 0 2.4 2.4l4.7-4.7a3 3 0 0 0-4.3-4.3L4 8.2a4.4 4.4 0 0 0 6.2 6.2l3.6-3.6' }),
      );
      clip.setAttribute('aria-hidden', 'true');
      const fileEl = h('span', 'mk-inbox-file mono', file);
      // The attachment is described in units this screen can COUNT. A megabyte figure here would be
      // an invented fact about a real recording, and the line under the panel already says what is
      // in it.
      const sizeEl = h('span', 'mk-inbox-size mono', attachmentSize(runtime.stats));
      att.append(clip, fileEl, sizeEl, h('span', 'mk-inbox-dl', 'Download'));

      const pane = h('div', 'mk-inbox-pane');
      const paneHead = h('div', 'mk-inbox-panehead mono');
      paneHead.append(
        h('span', 'mk-inbox-panetitle', 'Preview'),
        h('span', 'mk-inbox-panenote', 'no index, no search'),
      );
      const wall = h('div', 'mk-inbox-wall');
      wall.setAttribute('role', 'img');
      wall.setAttribute('aria-label', wallLabel('log file preview', runtime.synthesized));
      const rows = h('div', 'mk-inbox-rows mono');
      const fade = h('div', 'mk-fade');
      fade.setAttribute('aria-hidden', 'true');
      wall.append(rows, fade);
      pane.append(paneHead, wall);

      thread.append(subjectEl, meta, prose, att, pane);
      body.append(list, thread);

      const captionEl = h('p', 'mk-caption', copy.caption);
      const costEl = h(
        'p',
        'mk-cost mono',
        costLine(
          runtime.stats,
          runtime.synthesized,
          'The machine has already been rebooted and the person who saw it has gone home. This ' +
            'file is the whole account of what happened, and it opens as one flat scroll.',
        ),
      );

      root.append(head, body, captionEl, costEl);

      // ---- streaming ---------------------------------------------------------------
      return {
        rows,
        scroller: wall,

        onLine(rec) {
          const row = h('div', 'mk-row');
          row.append(h('span', 'mk-t', rec.stamp), h('span', 'mk-txt', rec.text));
          rows.appendChild(row);
        },

        onRole(next) {
          const c = resolveCopy(next, opts, TOOL_CLASS);
          toolEl.textContent = c.tool;
          captionEl.textContent = c.caption;
          portEl.textContent = portLine(robot, next);
          // The artefact's NAME follows the role too: a lead is handed `mission-export.csv` and a
          // support engineer a field dump, and the chip has to say which one is attached here.
          file = fileName(next, opts);
          fileEl.textContent = file;
        },
      };
    },
  });
}

/**
 * What the attachment is called.
 *
 * The role names its own artefact in `role.oldWay.port` (`field-dump.log · attached to the ticket`,
 * `mission-export.csv · opened in a spreadsheet`), so the first dotted token of that line is the
 * file this inbox is holding. A role that names no artefact falls back to a field dump, which is
 * what an untriaged log off a machine is.
 *
 * @param {object} role
 * @param {{file?:string}} opts
 * @returns {string}
 */
function fileName(role, opts) {
  if (typeof opts.file === 'string' && opts.file.trim()) return opts.file.trim();
  const port = role && role.oldWay ? role.oldWay.port : null;
  if (typeof port === 'string') {
    const tok = port.split(/[\s·,]+/).find((s) => /^[\w.-]+\.[a-z0-9]{2,5}$/i.test(s));
    if (tok) return tok;
  }
  return DEFAULT_FILE;
}

/** The attachment, described only in what this screen can count. Never an invented byte size. */
function attachmentSize(stats) {
  const bits = [];
  if (stats.rows > 0) bits.push(`${stats.estimated ? '~' : ''}${loc(stats.rows)} lines`);
  if (stats.values > 0) bits.push(`${stats.estimated ? '~' : ''}${loc(stats.values)} values`);
  if (stats.channels > 0) bits.push(`${loc(stats.channels)} channels`);
  return bits.join(' · ');
}

export default createInboxMock;
