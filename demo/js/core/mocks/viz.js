// mocks/viz.js - beat 2 in a plotting tool: a channel tree down one side, stacked time series down
// the other, a transport bar under both.
//
// This is the family for the visitor who says "we already plot our logs". The panel's job is to
// agree with them and then show what plotting does not buy: the traces are real, the axes are real,
// the tool is genuinely watching every channel at once, and there is still nothing on screen that
// tells you WHICH of these lines is the fault or where in the recording it happened. A plot is a
// faster way to look at everything. It is not a way to be told anything.
//
// GENERIC CHROME ONLY. No product name, no logo. What makes it read as a plotting tool is the
// grammar they share: a tree of channels with their fields, a checkbox column, per-pane y bounds
// with units, a playhead pinned to the newest sample, and a transport with a scrub track, a clock
// and a rate.
//
// The tree is drawn from the def's SCHEMA, which is real on every mission including the three whose
// values are an authored slice, so the left rail never invents a channel. The traces are drawn from
// the printed line script (mocks/base.js), so the right pane never builds telemetry this screen
// refuses to load.
//
// The transport is DECORATION and is `aria-hidden`: a scrub track a keyboard can reach is a promise
// that dragging it does something, and the whole point of this panel is that it cannot go back.
//
// Factory contract: (mount, def, opts) => { el, skip, dispose }, widened per mocks/base.js.

import {
  h,
  svg,
  fmt,
  loc,
  mmss,
  costLine,
  wallLabel,
  portLine,
  resolveCopy,
  channelLabel,
  fieldMeta,
  parseLine,
  profileSeries,
  createSeriesBuffer,
  polyPoints,
  createMockShell,
} from './base.js';

/** Stable family id. Rides the `seen` event, so it is never renamed once shipped. */
export const FAMILY = 'viz';
/** The tool class this chrome imitates, in the words a caption would use. */
export const TOOL_CLASS = 'Telemetry plotter';

/** Pane viewBox. Fixed units, `preserveAspectRatio="none"`: the integrator sizes it in CSS. */
const PANE_W = 600;
const PANE_H = 120;
/** Stacked panes. Enough to show the channels disagreeing, few enough to stay readable on a phone. */
const MAX_PANES = 3;

/**
 * @param {HTMLElement} mount
 * @param {object} def robot definition. Telemetry is used only if it is already attached.
 * @param {{role?:string|object, data?:object|null, onSeen?:Function, autostart?:boolean,
 *   stepMs?:number, maxRows?:number, reduceMotion?:boolean, tool?:string, caption?:string,
 *   panes?:number}} [opts]
 * @returns {object} the standard mock handle (see mocks/base.js)
 */
export function createVizMock(mount, def, opts = {}) {
  const paneCount = Number.isFinite(opts.panes) ? Math.max(1, Math.min(4, opts.panes)) : MAX_PANES;

  return createMockShell(mount, def, opts, {
    family: FAMILY,
    toolClass: TOOL_CLASS,
    build({ root, runtime, def: robot, role }) {
      const copy = resolveCopy(role, opts, TOOL_CLASS);
      const specs = profileSeries(runtime.lines, robot, { max: paneCount });
      const buffer = createSeriesBuffer(specs);
      const plotted = new Set(specs.map((s) => s.id));

      // ---- chrome ------------------------------------------------------------------
      const head = h('div', 'mk-head');
      const toolEl = h('span', 'mk-tool mono', copy.tool);
      const portEl = h('span', 'mk-port mono', portLine(robot, role));
      head.append(toolEl, portEl);

      const body = h('div', 'mk-viz-body');

      // ---- left rail: the channel tree ---------------------------------------------
      const tree = h('div', 'mk-viz-tree mono');
      tree.setAttribute('aria-hidden', 'true');
      tree.appendChild(h('div', 'mk-viz-treehead', 'Channels'));
      /** @type {Map<string, HTMLElement>} */
      const countCells = new Map();
      for (const group of channelGroups(robot, runtime.lines)) {
        const g = h('div', 'mk-viz-group');
        const gh = h('div', 'mk-viz-grouphead');
        gh.append(
          h('span', 'mk-viz-caret', '▾'),
          h('span', 'mk-viz-path', group.path),
          h('span', 'mk-viz-count', '0'),
        );
        countCells.set(group.path, gh.querySelector('.mk-viz-count'));
        g.appendChild(gh);
        const label = channelLabel(robot, group.path);
        if (label && label !== group.path) g.appendChild(h('div', 'mk-viz-grouplabel', label));
        for (const key of group.keys) {
          const meta = fieldMeta(robot, group.path, key);
          const on = plotted.has(group.path + '.' + key);
          const leaf = h('div', `mk-viz-leaf${on ? ' is-on' : ''}`);
          leaf.append(
            h('i', 'mk-viz-box'),
            h('span', 'mk-viz-leafkey', meta.label),
            h('span', 'mk-viz-leafunit', meta.unit || ''),
          );
          g.appendChild(leaf);
        }
        tree.appendChild(g);
      }

      // ---- right: stacked panes ----------------------------------------------------
      const panes = h('div', 'mk-viz-panes');
      panes.setAttribute('role', 'img');
      panes.setAttribute('aria-label', wallLabel('stack of telemetry plots', runtime.synthesized));
      const views = specs.map((s, i) => {
        const pane = h('div', `mk-viz-pane mk-viz-pane-${i + 1}`);
        const ph = h('div', 'mk-viz-panehead mono');
        ph.append(
          h('i', `mk-viz-swatch mk-plot-trace-${i + 1}`),
          h('span', 'mk-viz-name', s.path + '/' + s.label),
          h('span', 'mk-viz-last', '--'),
          h('span', 'mk-viz-unit', s.unit || ''),
        );
        const canvas = svg('svg', {
          class: 'mk-plot-svg',
          viewBox: `0 0 ${PANE_W} ${PANE_H}`,
          preserveAspectRatio: 'none',
          focusable: 'false',
        });
        const grid = svg('g', { class: 'mk-plot-grid' });
        for (let k = 1; k < 4; k++) {
          const y = (PANE_H / 4) * k;
          grid.appendChild(svg('line', { x1: 0, y1: y, x2: PANE_W, y2: y }));
        }
        canvas.appendChild(grid);
        const trace = svg('polyline', {
          class: `mk-plot-trace mk-plot-trace-${i + 1}`,
          fill: 'none',
          points: '',
          'data-series': s.id,
        });
        canvas.appendChild(trace);
        // the playhead sits at the newest sample, which is always the right edge: this tool is
        // watching a stream, and the one thing it cannot do is put the cursor anywhere else
        const cursor = svg('line', {
          class: 'mk-viz-cursor',
          x1: PANE_W - 1,
          y1: 0,
          x2: PANE_W - 1,
          y2: PANE_H,
        });
        canvas.appendChild(cursor);
        const axis = h('div', 'mk-viz-axis mono');
        const hiEl = h('span', 'mk-viz-hi', '--');
        const loEl = h('span', 'mk-viz-lo', '--');
        axis.append(hiEl, loEl);
        const plotWrap = h('div', 'mk-viz-plot');
        plotWrap.append(axis, canvas);
        pane.append(ph, plotWrap);
        panes.appendChild(pane);
        return { spec: s, trace, hiEl, loEl, lastEl: ph.querySelector('.mk-viz-last') };
      });
      if (!specs.length) {
        root.classList.add('mk-noplot');
        panes.appendChild(h('div', 'mk-viz-empty mono', 'no numeric channels in this window'));
      }
      body.append(tree, panes);

      // ---- transport ---------------------------------------------------------------
      const transport = h('div', 'mk-viz-transport mono');
      transport.setAttribute('aria-hidden', 'true');
      const playGlyph = svg('svg', {
        class: 'mk-viz-play',
        viewBox: '0 0 12 12',
        fill: 'currentColor',
        focusable: 'false',
      });
      playGlyph.appendChild(svg('rect', { x: 2, y: 2, width: 3, height: 8 }));
      playGlyph.appendChild(svg('rect', { x: 7, y: 2, width: 3, height: 8 }));
      const clockEl = h('span', 'mk-viz-clock', '0:00');
      const track = h('div', 'mk-viz-track');
      const fillEl = h('i', 'mk-viz-fill');
      // structure-critical inline style: this width IS the datum, there is no class for 37.2%
      fillEl.style.width = '0%';
      track.appendChild(fillEl);
      const durEl = h('span', 'mk-viz-dur', mmss(spanOf(runtime)));
      transport.append(
        playGlyph,
        clockEl,
        track,
        durEl,
        h('span', 'mk-viz-rate', '1.0x'),
        h('span', 'mk-viz-live', 'live'),
      );

      const captionEl = h('p', 'mk-caption', copy.caption);
      const costEl = h(
        'p',
        'mk-cost mono',
        costLine(
          runtime.stats,
          runtime.synthesized,
          'Every channel is on screen and none of them is labelled as the problem. Nothing here ' +
            'searches, nothing here explains, and the cursor only ever sits on the newest sample.',
        ),
      );

      root.append(head, body, transport, captionEl, costEl);

      // ---- streaming ---------------------------------------------------------------
      const counts = new Map();
      const total = runtime.lines.length || 1;
      let dirty = false;

      function draw() {
        if (!dirty) return;
        dirty = false;
        for (const v of views) {
          const pts = buffer.points(v.spec.id);
          if (!pts.length) continue;
          v.trace.setAttribute('points', polyPoints(pts, PANE_W, PANE_H, { pad: 8 }));
          let lo = Infinity;
          let hi = -Infinity;
          for (const p of pts) {
            if (p.y < lo) lo = p.y;
            if (p.y > hi) hi = p.y;
          }
          v.hiEl.textContent = fmt(hi, v.spec.dp);
          v.loEl.textContent = fmt(lo, v.spec.dp);
          v.lastEl.textContent = fmt(pts[pts.length - 1].y, v.spec.dp);
        }
      }

      return {
        // No `rows`: this family holds no growing list. Its DOM is fixed at build and every trace
        // is a bounded ring, so there is nothing for the shell to cap and nothing to scroll.
        onLine(rec, parsed, i) {
          if (buffer.push(parsed, rec.t)) dirty = true;
          draw();
          const n = (counts.get(parsed.path) || 0) + 1;
          counts.set(parsed.path, n);
          const cell = countCells.get(parsed.path);
          if (cell) cell.textContent = loc(n);
          clockEl.textContent = mmss(rec.t);
          fillEl.style.width = `${(((i % total) / total) * 100).toFixed(1)}%`;
        },

        onRole(next) {
          const c = resolveCopy(next, opts, TOOL_CLASS);
          toolEl.textContent = c.tool;
          captionEl.textContent = c.caption;
          portEl.textContent = portLine(robot, next);
        },
      };
    },
  });
}

/**
 * The tree's rows: the def's own channels and their field keys, falling back to whatever the line
 * script actually printed when a def carries no schema (a stub, a half-built generated demo).
 *
 * @param {object} def
 * @param {Array<{text:string}>} lines
 * @returns {Array<{path:string, keys:string[]}>}
 */
function channelGroups(def, lines) {
  const channels = Array.isArray(def && def.channels) ? def.channels : [];
  const fromDef = channels
    .filter((c) => c && c.path)
    .map((c) => ({
      path: c.path,
      keys: (Array.isArray(c.fields) ? c.fields : []).map((f) => f && f.key).filter(Boolean),
    }));
  if (fromDef.length) return fromDef;

  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const p = parseLine(lines[i].text);
    if (!p.path) continue;
    if (!seen.has(p.path)) seen.set(p.path, new Set());
    p.fields.forEach((f) => seen.get(p.path).add(f.key));
  }
  return [...seen.entries()].map(([path, keys]) => ({ path, keys: [...keys] }));
}

/** Seconds the transport's track spans: the def's own duration, else the script's own span. */
function spanOf(runtime) {
  const dur = runtime.def && Number.isFinite(runtime.def.duration) ? runtime.def.duration : 0;
  if (dur > 0) return dur;
  return runtime.spanS > 0 ? runtime.spanS : 0;
}

export default createVizMock;
