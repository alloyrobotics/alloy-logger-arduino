// mocks/fleet.js - beat 2 in a monitoring dashboard: tiles across the top, one row per stream, a
// sparkline in every row, everything green.
//
// This is the family for the visitor who runs the team rather than the robot. The tool they are
// handed is not a terminal and not a plotter; it is a wall of aggregates, and the reason it belongs
// in beat 2 is that it is genuinely WORKING. The devices are up, the streams are flowing, the
// counters are climbing, and the mission still failed, because a dashboard summarises samples and a
// fault lives in one of them. Every row here is live and none of them is the answer.
//
// GENERIC CHROME ONLY. No product name, no logo. What makes it read as a dashboard is the grammar
// they share: a header with a scope and a refresh cadence, KPI tiles with a label over a number, a
// dense table with a status dot, a last-seen column, a sparkline column and a units column.
//
// HONESTY. The rows are the mission's OWN channels and the numbers in them are the printed line
// script, so no fleet is invented: this is one machine's streams shown the way a fleet view shows
// them. The tiles count what has actually gone past on this screen, not what a fleet would have.
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
  parseLine,
  profileSeries,
  createSeriesBuffer,
  polyPoints,
  createMockShell,
} from './base.js';

/** Stable family id. Rides the `seen` event, so it is never renamed once shipped. */
export const FAMILY = 'fleet';
/** The tool class this chrome imitates, in the words a caption would use. */
export const TOOL_CLASS = 'Fleet dashboard';

/** Sparkline viewBox. Fixed units, `preserveAspectRatio="none"`: sized in CSS by the integrator. */
const SPARK_W = 120;
const SPARK_H = 28;
/** Samples a row's sparkline keeps. A dashboard sparkline is a shape, not a plot. */
const SPARK_WINDOW = 48;

/**
 * @param {HTMLElement} mount
 * @param {object} def robot definition. Telemetry is used only if it is already attached.
 * @param {{role?:string|object, data?:object|null, onSeen?:Function, autostart?:boolean,
 *   stepMs?:number, maxRows?:number, reduceMotion?:boolean, tool?:string,
 *   caption?:string}} [opts]
 * @returns {object} the standard mock handle (see mocks/base.js)
 */
export function createFleetMock(mount, def, opts = {}) {
  return createMockShell(mount, def, opts, {
    family: FAMILY,
    toolClass: TOOL_CLASS,
    build({ root, runtime, def: robot, role }) {
      const copy = resolveCopy(role, opts, TOOL_CLASS);
      const groups = streamPaths(robot, runtime.lines);

      // One tracked field per row: the liveliest numeric field that channel actually prints. A row
      // whose channel prints nothing numeric keeps its chrome and reads `--`, which is exactly what
      // a dashboard does with a string topic.
      const specs = [];
      const rowSpec = new Map();
      for (const path of groups) {
        const found = profileSeries(runtime.lines, robot, { max: 1, path });
        if (found.length) {
          specs.push(found[0]);
          rowSpec.set(path, found[0]);
        }
      }
      const buffer = createSeriesBuffer(specs, { window: SPARK_WINDOW });

      // ---- chrome ------------------------------------------------------------------
      const head = h('div', 'mk-head');
      const toolEl = h('span', 'mk-tool mono', copy.tool);
      const portEl = h('span', 'mk-port mono', portLine(robot, role));
      head.append(toolEl, portEl);

      const scope = h('div', 'mk-fleet-scope');
      scope.append(
        h('span', 'mk-fleet-name', robot.name || robot.id || 'device'),
        h('span', 'mk-fleet-device mono', robot.device || ''),
        h('span', 'mk-fleet-pill', 'streaming'),
      );

      const tiles = h('div', 'mk-fleet-tiles');
      const tileOnline = tile('Devices online', '1 / 1');
      const tileStreams = tile(
        'Streams',
        loc(runtime.stats.channels > 0 ? runtime.stats.channels : groups.length),
      );
      const tileValues = tile('Values ingested', '0');
      const tileWindow = tile('Window', mmss(windowOf(runtime)));
      const tileAlerts = tile('Alerts', '0');
      tiles.append(tileOnline.el, tileStreams.el, tileValues.el, tileWindow.el, tileAlerts.el);

      const table = h('div', 'mk-fleet-table');
      table.setAttribute('role', 'img');
      table.setAttribute('aria-label', wallLabel('dashboard of live stream tiles', runtime.synthesized));
      const thead = h('div', 'mk-fleet-row mk-fleet-head mono');
      thead.append(
        h('span', 'mk-fleet-c-status', ''),
        h('span', 'mk-fleet-c-name', 'Stream'),
        h('span', 'mk-fleet-c-last', 'Last value'),
        h('span', 'mk-fleet-c-n', 'Records'),
        h('span', 'mk-fleet-c-spark', 'Last 48'),
        h('span', 'mk-fleet-c-seen', 'Last seen'),
      );
      table.appendChild(thead);

      const rows = new Map();
      for (const path of groups) {
        const spec = rowSpec.get(path);
        const row = h('div', 'mk-fleet-row');
        row.dataset.path = path;
        const dot = h('span', 'mk-fleet-c-status');
        dot.appendChild(h('i', 'mk-fleet-dot is-ok'));
        const name = h('span', 'mk-fleet-c-name');
        name.append(h('span', 'mk-fleet-path mono', path));
        const label = channelLabel(robot, path);
        if (label && label !== path) name.append(h('span', 'mk-fleet-sub', label));
        const last = h('span', 'mk-fleet-c-last mono');
        const lastVal = h('span', 'mk-fleet-val', '--');
        const unit = h('span', 'mk-fleet-unit', spec && spec.unit ? spec.unit : '');
        last.append(lastVal, unit);
        const n = h('span', 'mk-fleet-c-n mono', '0');
        const sparkCell = h('span', 'mk-fleet-c-spark');
        const canvas = svg('svg', {
          class: 'mk-spark-svg',
          viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
          preserveAspectRatio: 'none',
          focusable: 'false',
        });
        const trace = svg('polyline', { class: 'mk-spark-trace', fill: 'none', points: '' });
        canvas.appendChild(trace);
        sparkCell.appendChild(canvas);
        const seen = h('span', 'mk-fleet-c-seen mono', '--');
        row.append(dot, name, last, n, sparkCell, seen);
        table.appendChild(row);
        rows.set(path, { row, lastVal, unit, n, trace, seen, spec, count: 0 });
      }

      const captionEl = h('p', 'mk-caption', copy.caption);
      const costEl = h(
        'p',
        'mk-cost mono',
        costLine(
          runtime.stats,
          runtime.synthesized,
          'Every row is green and every counter is climbing. A dashboard reports the shape of the ' +
            'stream, and the fault is one sample inside it.',
        ),
      );

      root.append(head, scope, tiles, table, captionEl, costEl);

      // ---- streaming ---------------------------------------------------------------
      let values = 0;

      return {
        // No `rows`: the table is one row per channel and is built once, so nothing grows.
        onLine(rec, parsed) {
          values += parsed.fields.length;
          tileValues.set(loc(values));
          const r = rows.get(parsed.path);
          if (!r) return;
          r.count++;
          r.n.textContent = loc(r.count);
          r.seen.textContent = rec.stamp;
          if (r.spec && buffer.push(parsed, rec.t)) {
            const pts = buffer.points(r.spec.id);
            r.trace.setAttribute('points', polyPoints(pts, SPARK_W, SPARK_H, { pad: 3 }));
            const v = buffer.last(r.spec.id);
            if (v != null) r.lastVal.textContent = fmt(v, r.spec.dp);
          }
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

/** One KPI tile. Returns the node and a setter, because only the number ever changes. */
function tile(label, value) {
  const el = h('div', 'mk-fleet-tile');
  const v = h('div', 'mk-fleet-tileval mono', value);
  el.append(h('div', 'mk-fleet-tilelabel', label), v);
  return {
    el,
    set(next) {
      v.textContent = next;
    },
  };
}

/**
 * The table's rows: the def's own channel paths, falling back to whatever the line script printed
 * when a def carries no schema (a stub, a half-built generated demo).
 *
 * @param {object} def
 * @param {Array<{text:string}>} lines
 * @returns {string[]}
 */
function streamPaths(def, lines) {
  const channels = Array.isArray(def && def.channels) ? def.channels : [];
  const fromDef = channels.filter((c) => c && c.path).map((c) => c.path);
  if (fromDef.length) return fromDef;
  const seen = [];
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const p = parseLine(lines[i].text);
    if (p.path && !seen.includes(p.path)) seen.push(p.path);
  }
  return seen;
}

/** Seconds the dashboard says it is summarising: the mission's own duration, else the script's. */
function windowOf(runtime) {
  const dur = runtime.def && Number.isFinite(runtime.def.duration) ? runtime.def.duration : 0;
  if (dur > 0) return dur;
  return runtime.spanS > 0 ? runtime.spanS : 0;
}

export default createFleetMock;
