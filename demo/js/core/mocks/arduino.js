// mocks/arduino.js - beat 2 in the tool an engineer actually has open: a serial monitor with a
// plotter strip under it.
//
// This is the family closest to core/oldway.js, and it exists because the wall alone undersells the
// evening it is describing. The thing that makes a serial monitor unusable for finding a fault is
// not only that the text scrolls too fast; it is that the ONE affordance it gives you for seeing a
// shape - the plotter - draws whatever numbers happen to be printed, with no channel names, no
// units, no cursor and no way to go back. Both halves are on screen here, both fed from the same
// line script, so the panel argues with itself the way the real tool does.
//
// GENERIC CHROME ONLY. No product name, no logo, no vendor typeface, nothing that claims to be a
// screenshot of anybody's IDE. What makes it read as a serial monitor is the grammar every serial
// monitor shares: a port line, a baud rate, a line-ending selector, autoscroll and timestamp
// toggles, a monospaced output pane pinned to its bottom, a send box you have nothing to send to,
// and a status line counting what has gone past.
//
// The toolbar is DECORATION and says so: the toggles and the send box are `aria-hidden` and are not
// form controls, because a checkbox a screen reader can reach and a keyboard can focus is a promise
// that tabbing there does something. Nothing in this panel is interactive.
//
// Factory contract: (mount, def, opts) => { el, skip, dispose }, widened per mocks/base.js.

import {
  h,
  svg,
  loc,
  fmt,
  costLine,
  wallLabel,
  portLine,
  resolveCopy,
  profileSeries,
  createSeriesBuffer,
  polyPoints,
  createMockShell,
} from './base.js';

/** Stable family id. Rides the `seen` event, so it is never renamed once shipped. */
export const FAMILY = 'arduino';
/** The tool class this chrome imitates, in the words a caption would use. */
export const TOOL_CLASS = 'Serial monitor';

/** Plotter viewBox. Fixed units, `preserveAspectRatio="none"`: the integrator sizes it in CSS. */
const PLOT_W = 600;
const PLOT_H = 90;
/** Traces the plotter draws. A real one draws every printed number; three is what stays legible. */
const MAX_TRACES = 3;

/**
 * @param {HTMLElement} mount
 * @param {object} def robot definition. Telemetry is used only if it is already attached.
 * @param {{role?:string|object, data?:object|null, onSeen?:Function, autostart?:boolean,
 *   stepMs?:number, maxRows?:number, reduceMotion?:boolean, tool?:string, caption?:string,
 *   baud?:number}} [opts]
 * @returns {object} the standard mock handle (see mocks/base.js)
 */
export function createArduinoMock(mount, def, opts = {}) {
  const baud = Number.isFinite(opts.baud) ? Math.round(opts.baud) : 115200;

  return createMockShell(mount, def, opts, {
    family: FAMILY,
    toolClass: TOOL_CLASS,
    build({ root, runtime, def: robot, role }) {
      const copy = resolveCopy(role, opts, TOOL_CLASS);

      // ---- chrome ------------------------------------------------------------------
      const head = h('div', 'mk-head');
      const toolEl = h('span', 'mk-tool mono', copy.tool);
      const portEl = h('span', 'mk-port mono', portLine(robot, role));
      head.append(toolEl, portEl);

      const bar = h('div', 'mk-ard-bar');
      bar.setAttribute('aria-hidden', 'true');
      const sendBox = h('div', 'mk-ard-send');
      sendBox.append(
        h('span', 'mk-ard-input mono', 'Message (Enter to send)'),
        h('span', 'mk-ard-sendbtn', 'Send'),
      );
      const toggles = h('div', 'mk-ard-toggles mono');
      toggles.append(
        check('Autoscroll', true),
        check('Show timestamp', true),
        h('span', 'mk-ard-tool', 'Clear output'),
      );
      bar.append(sendBox, toggles);

      const out = h('div', 'mk-ard-out');
      out.setAttribute('role', 'img');
      out.setAttribute('aria-label', wallLabel('serial monitor wall', runtime.synthesized));
      const rows = h('div', 'mk-ard-rows mono');
      const fade = h('div', 'mk-fade');
      fade.setAttribute('aria-hidden', 'true');
      out.append(rows, fade);

      // ---- the plotter strip -------------------------------------------------------
      // The traces are chosen from the printed script, not named here: this panel must work on a
      // mission whose channels it has never seen (a generated demo), and on the three whose values
      // are an authored slice. A mission with nothing numeric printed gets no strip at all rather
      // than an empty axis box.
      const specs = profileSeries(runtime.lines, robot, { max: MAX_TRACES });
      const buffer = createSeriesBuffer(specs);
      const plot = h('div', 'mk-ard-plot');
      plot.setAttribute('aria-hidden', 'true');
      const canvas = svg('svg', {
        class: 'mk-plot-svg',
        viewBox: `0 0 ${PLOT_W} ${PLOT_H}`,
        preserveAspectRatio: 'none',
        focusable: 'false',
      });
      // A serial plotter draws a grid it cannot label, because it does not know what it is drawing.
      const grid = svg('g', { class: 'mk-plot-grid' });
      for (let i = 1; i < 4; i++) {
        const y = (PLOT_H / 4) * i;
        grid.appendChild(svg('line', { x1: 0, y1: y, x2: PLOT_W, y2: y }));
      }
      canvas.appendChild(grid);
      /** @type {SVGElement[]} */
      const traces = specs.map((s, i) => {
        const line = svg('polyline', {
          class: `mk-plot-trace mk-plot-trace-${i + 1}`,
          'data-series': s.id,
          fill: 'none',
          points: '',
        });
        canvas.appendChild(line);
        return line;
      });
      const legend = h('div', 'mk-ard-legend mono');
      const legendVals = specs.map((s, i) => {
        const chip = h('span', `mk-ard-chip mk-ard-chip-${i + 1}`);
        chip.append(
          h('i', 'mk-ard-swatch'),
          h('span', 'mk-ard-key', s.unit ? `${s.label} (${s.unit})` : s.label),
          h('span', 'mk-ard-val', '--'),
        );
        legend.appendChild(chip);
        return chip.querySelector('.mk-ard-val');
      });
      plot.append(canvas, legend);
      if (!specs.length) root.classList.add('mk-noplot');

      const status = h('div', 'mk-ard-status mono');
      const lnEl = h('span', 'mk-ard-ln', 'Ln 0');
      status.append(
        lnEl,
        h('span', 'mk-ard-sep', '·'),
        h('span', 'mk-ard-baud', `${loc(baud)} baud`),
        h('span', 'mk-ard-sep', '·'),
        h('span', 'mk-ard-eol', 'Both NL & CR'),
      );

      const captionEl = h('p', 'mk-caption', copy.caption);
      const costEl = h(
        'p',
        'mk-cost mono',
        costLine(
          runtime.stats,
          runtime.synthesized,
          'No time axis, no search, no replay. The moment it broke is somewhere in there.',
        ),
      );

      root.append(head, bar, out, plot, status, captionEl, costEl);

      // ---- streaming ---------------------------------------------------------------
      let count = 0;
      let dirty = false;

      /** Redraw every trace from its ring. Called at most once per appended record. */
      function drawPlot() {
        if (!dirty) return;
        dirty = false;
        for (let i = 0; i < specs.length; i++) {
          const pts = buffer.points(specs[i].id);
          traces[i].setAttribute('points', polyPoints(pts, PLOT_W, PLOT_H, { pad: 6 }));
          const last = buffer.last(specs[i].id);
          legendVals[i].textContent = last == null ? '--' : fmt(last, specs[i].dp);
        }
      }

      return {
        rows,
        scroller: out,

        onLine(rec, parsed) {
          count++;
          const row = h('div', 'mk-row');
          row.append(
            h('span', 'mk-t', rec.stamp),
            h('span', 'mk-arrow', '->'),
            h('span', 'mk-txt', rec.text),
          );
          rows.appendChild(row);
          if (buffer.push(parsed, rec.t)) dirty = true;
          drawPlot();
          lnEl.textContent = `Ln ${loc(count)}`;
        },

        onRole(next) {
          const c = resolveCopy(next, opts, TOOL_CLASS);
          toolEl.textContent = c.tool;
          captionEl.textContent = c.caption;
          // The chrome follows the ROLE, not just the caption: captioning the panel "the CSV your
          // team exports" over a header that reads `115200 baud` had the screen contradict itself.
          portEl.textContent = portLine(robot, next);
        },
      };
    },
  });
}

/** One toolbar toggle, drawn rather than instantiated: nothing in this panel is interactive. */
function check(label, on) {
  const wrap = h('span', `mk-ard-check${on ? ' is-on' : ''}`);
  wrap.append(h('i', 'mk-ard-box'), h('span', 'mk-ard-label', label));
  return wrap;
}

export default createArduinoMock;
