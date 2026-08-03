// mocks/base.js - the shared kit every "old way" mock is built out of.
//
// core/oldway.js makes beat 2's argument with ONE tool: a serial-monitor wall. That is the right
// wall for the engineer and the wrong one for everybody else, because the artefact a support lead
// or a head of robotics is actually handed is not a terminal. The mock FAMILIES in this directory
// are the other tools that argument has to be made in - a serial monitor, a plotting tool, a fleet
// dashboard, a ticket inbox - and this module is the half they share, so a family file is only the
// chrome that makes it look like its own tool class.
//
// TRIPWIRE, inherited verbatim from oldway.js and not negotiable here. A mock NEVER imports a robot
// payload and never reaches for one. It renders the def it is handed and reads telemetry only if
// that telemetry already exists (`def.data`, or `opts.data`). Three of the seven missions derive
// their channels from a lazily loaded scene payload that the brief deliberately does not build, and
// a panel that pulled one in would put a 700 KB module in front of the screen whose entire job is
// to be instant. Those three author `context.oldwaySample` instead, and `oldWayLines` prefers it.
// Every number a mock puts on screen comes out of that one line script, so the four families are
// four readings of the same recording rather than four inventions.
//
// LINE SCRIPT, not a second generator. `oldWayLines` and `oldWayStats` are imported from oldway.js
// because they are exported there; nothing in this directory re-derives telemetry. What is
// duplicated instead is small and deliberately so: the clock base and the row/step constants, which
// oldway.js keeps private, and which a mock cannot ask it for.
//
// FACTORY CONTRACT, the same one every screen module in core/ ships:
//   (mount, def, opts) => { el, skip, dispose }
// with the streaming handle widened to the shape oldway.js already returns, so a caller that today
// holds an old-way panel can hold a mock instead without learning a second vocabulary:
//   { el, family, lines, synthesized, sampled, stats, started(), start(), skip(),
//     pause(), resume(), setRole(role), dispose() }
// Nothing here advances a router, owns navigation, or auto-advances anything.
//
// STYLING. Every hook is a class with the `mk-` prefix and the integrator owns the stylesheet.
// Inline style is used only where it is structure, not decoration: the accent custom property, an
// SVG viewBox, and a width percentage that IS the datum it draws.

import { oldWayLines, oldWayStats } from '../oldway.js';
import { effectiveRole, roleById } from '../role.js';

/** Rows kept in the DOM. Every wall here is infinite; the document is not. */
export const MAX_ROWS = 140;
/** Default ms between appended records. Fast enough to be unreadable, slow enough to be legible. */
export const STEP_MS = 55;
/** Records appended per tick once a wall is warm, so the scroll never looks like a metronome. */
export const BURST = 2;
/** Samples a rolling plot keeps. Past this the trace is denser than the pixels drawing it. */
export const PLOT_WINDOW = 160;
/** Deterministic wall-clock start: 09:14:02.000, mission-relative from there. Same as oldway.js. */
const CLOCK_BASE_S = 9 * 3600 + 14 * 60 + 2;
/** ms a hidden tab waits before looking again. A background tab must not build rows nobody sees. */
const HIDDEN_MS = 400;

// ---------------------------------------------------------------------------- small helpers

/** @param {number} n @returns {string} */
export const loc = (n) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');

/** @param {number} v @param {number} dp @returns {string} */
export function fmt(v, dp) {
  if (!Number.isFinite(v)) return 'nan';
  if (!dp) return String(Math.round(v));
  return v.toFixed(dp);
}

/**
 * `09:14:53.702` - the wall clock a monitor stamps, driven by mission time.
 * Duplicated from oldway.js (it keeps `clock` private) rather than re-derived: the two panels are
 * describing the same recording, so they must stamp it the same way.
 *
 * @param {number} t seconds into the mission
 */
export function clockAt(t) {
  const total = CLOCK_BASE_S + (Number.isFinite(t) ? t : 0);
  const p2 = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = Math.floor(total) % 60;
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(ms).padStart(3, '0')}`;
}

/** `2:31` - a mission clock without a date, for transport bars and "last seen" columns. */
export function mmss(t) {
  const s = Math.max(0, Math.floor(Number.isFinite(t) ? t : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string|number} [text]
 * @returns {HTMLElement}
 */
export function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = String(text);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag
 * @param {Record<string,string|number>} [attrs]
 * @returns {SVGElement}
 */
export function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    if (attrs[k] == null) continue;
    node.setAttribute(k, String(attrs[k]));
  }
  return node;
}

/** @returns {boolean} */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// ---------------------------------------------------------------------------- the line script

/**
 * One printed line, parsed back into fields.
 *
 * The wall's grammar is `"<path> k=v k=v"` with an optional ` +N` tail when a channel has more
 * fields than a line can hold, and it is the SAME grammar whether the line came from built
 * telemetry, from an authored `context.oldwaySample` slice, or from the schema-shaped stand-in
 * wall. Parsing it back is what lets a plot, a dashboard row and a ticket attachment all read the
 * one script: no family builds a second source of numbers.
 *
 * @param {string} text
 * @returns {{path:string, fields:Array<{key:string, raw:string, value:number|null}>}}
 */
export function parseLine(text) {
  const out = { path: '', fields: [] };
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return out;
  const parts = s.split(/\s+/);
  out.path = parts[0] || '';
  for (let i = 1; i < parts.length; i++) {
    const tok = parts[i];
    // the `+2` tail says "this channel has more fields", and is not one of them
    if (tok.charAt(0) === '+') continue;
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const raw = tok.slice(eq + 1);
    const num = Number(raw);
    out.fields.push({ key, raw, value: Number.isFinite(num) ? num : null });
  }
  return out;
}

/**
 * The def's own metadata for one field, or a minimal stand-in.
 *
 * The line script carries keys, not units: a plot axis that says `deg` and a dashboard column that
 * says `A` are reading the def's SCHEMA, which is real on every mission including the three whose
 * values are an authored slice.
 *
 * @param {object} def
 * @param {string} path
 * @param {string} key
 * @returns {{label:string, unit:string, path:string, key:string}}
 */
export function fieldMeta(def, path, key) {
  const channels = Array.isArray(def && def.channels) ? def.channels : [];
  const ch = channels.find((c) => c && c.path === path);
  const f = ch && Array.isArray(ch.fields) ? ch.fields.find((x) => x && x.key === key) : null;
  return {
    path,
    key,
    label: (f && f.label) || key,
    unit: (f && typeof f.unit === 'string' && f.unit.trim()) || '',
  };
}

/** Human name for a channel: the def's own label if it authored one, else the path. */
export function channelLabel(def, path) {
  const channels = Array.isArray(def && def.channels) ? def.channels : [];
  const ch = channels.find((c) => c && c.path === path);
  return (ch && typeof ch.label === 'string' && ch.label.trim()) || path;
}

/**
 * Which fields are worth drawing, decided from the script rather than picked by hand.
 *
 * A plotting tool that opened on three flat lines would be making the wrong argument: the point of
 * beat 2 is that the answer IS in there and unreadable, not that there is nothing in there. So the
 * candidates are ranked by how much they move (spread over the observed range, normalised by
 * magnitude so a heap counter in bytes does not beat a pitch in degrees), and constants are pushed
 * to the back rather than dropped, so a mission whose sample happens to be quiet still gets traces.
 *
 * Deterministic: same lines in, same order out, no randomness anywhere.
 *
 * @param {Array<{t:number, path:string, text:string}>} lines
 * @param {object} def
 * @param {{max?:number, sample?:number, path?:string}} [opts] `path` restricts to one channel
 * @returns {Array<{id:string, path:string, key:string, label:string, unit:string, dp:number}>}
 */
export function profileSeries(lines, def, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 3;
  const sample = Number.isFinite(opts.sample) ? opts.sample : 260;
  const only = typeof opts.path === 'string' ? opts.path : null;
  /** @type {Map<string,{path:string,key:string,min:number,max:number,sum:number,n:number,allInt:boolean,first:number}>} */
  const acc = new Map();
  const n = Math.min(lines.length, sample);
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (!line) continue;
    const p = parseLine(line.text);
    if (!p.path || (only && p.path !== only)) continue;
    for (const f of p.fields) {
      if (f.value == null) continue;
      const id = p.path + '.' + f.key;
      let rec = acc.get(id);
      if (!rec) {
        rec = {
          path: p.path,
          key: f.key,
          min: f.value,
          max: f.value,
          sum: 0,
          n: 0,
          allInt: true,
          first: acc.size,
        };
        acc.set(id, rec);
      }
      if (f.value < rec.min) rec.min = f.value;
      if (f.value > rec.max) rec.max = f.value;
      if (!Number.isInteger(f.value)) rec.allInt = false;
      rec.sum += Math.abs(f.value);
      rec.n++;
    }
  }
  const ranked = [...acc.entries()].map(([id, r]) => {
    const spread = r.max - r.min;
    const mag = r.n ? r.sum / r.n : 0;
    // normalised movement, with a floor on the denominator so a channel centred on zero (a pitch
    // that swings +/-10 around 0.5) is not scored as infinitely lively
    const score = spread / Math.max(1, Math.abs(mag), Math.abs(r.max), Math.abs(r.min));
    return { id, rec: r, score: spread > 0 ? score : -1 };
  });
  ranked.sort((a, b) => b.score - a.score || a.rec.first - b.rec.first);
  return ranked.slice(0, Math.max(1, max)).map(({ id, rec }) => {
    const meta = fieldMeta(def, rec.path, rec.key);
    const span = Math.max(Math.abs(rec.max), Math.abs(rec.min));
    return {
      id,
      path: rec.path,
      key: rec.key,
      label: meta.label,
      unit: meta.unit,
      dp: rec.allInt ? 0 : span >= 1000 ? 1 : span >= 1 ? 2 : 3,
    };
  });
}

/**
 * A rolling per-series ring of `{x, y}` samples, fed one printed line at a time.
 *
 * Bounded by construction: `PLOT_WINDOW` samples per series, so a panel left streaming for an hour
 * holds exactly as much as it did in its first second. This is the reason a mock can stream
 * forever without a leak, and the reason `dispose()` has nothing to unwind here.
 *
 * @param {Array<{id:string, path:string, key:string}>} specs
 * @param {{window?:number}} [opts]
 */
export function createSeriesBuffer(specs, opts = {}) {
  const win = Number.isFinite(opts.window) ? Math.max(8, opts.window) : PLOT_WINDOW;
  /** @type {Map<string, Array<{x:number,y:number}>>} */
  const store = new Map(specs.map((s) => [s.id, []]));
  const byPath = new Map();
  specs.forEach((s) => {
    if (!byPath.has(s.path)) byPath.set(s.path, []);
    byPath.get(s.path).push(s);
  });
  return {
    specs,
    /**
     * @param {{path:string, fields:Array<{key:string, value:number|null}>}} parsed
     * @param {number} x monotonic mission time (wrapped, so it never goes backwards)
     * @returns {boolean} whether anything was stored
     */
    push(parsed, x) {
      const want = byPath.get(parsed.path);
      if (!want) return false;
      let stored = false;
      for (const spec of want) {
        const f = parsed.fields.find((z) => z.key === spec.key);
        if (!f || f.value == null) continue;
        const arr = store.get(spec.id);
        arr.push({ x, y: f.value });
        if (arr.length > win) arr.splice(0, arr.length - win);
        stored = true;
      }
      return stored;
    },
    /** @param {string} id @returns {Array<{x:number,y:number}>} */
    points(id) {
      return store.get(id) || [];
    },
    /** @param {string} id @returns {number|null} */
    last(id) {
      const arr = store.get(id);
      return arr && arr.length ? arr[arr.length - 1].y : null;
    },
    clear() {
      store.forEach((arr) => arr.splice(0, arr.length));
    },
  };
}

/**
 * `points` for an SVG polyline, in a viewBox whose axes are the caller's units.
 *
 * The plot elements ship `preserveAspectRatio="none"` and a fixed viewBox, so the integrator sizes
 * them entirely in CSS and nothing here ever measures the DOM: no ResizeObserver, no layout read,
 * no reflow per tick. That is a rendering decision AND a leak decision.
 *
 * @param {Array<{x:number,y:number}>} pts
 * @param {number} w viewBox width
 * @param {number} hgt viewBox height
 * @param {{pad?:number}} [opts] vertical padding in viewBox units
 * @returns {string}
 */
export function polyPoints(pts, w, hgt, opts = {}) {
  if (!pts || pts.length === 0) return '';
  const pad = Number.isFinite(opts.pad) ? opts.pad : 2;
  let x0 = pts[0].x;
  let x1 = pts[pts.length - 1].x;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  if (!(x1 > x0)) x1 = x0 + 1;
  if (!(hi > lo)) {
    // a flat series still has to be drawn, and drawn in the MIDDLE: a constant pinned to the floor
    // of its pane reads as a dead signal rather than a steady one
    lo -= 1;
    hi += 1;
  }
  const usable = Math.max(1, hgt - pad * 2);
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const px = ((pts[i].x - x0) / (x1 - x0)) * w;
    const py = pad + (1 - (pts[i].y - lo) / (hi - lo)) * usable;
    out[i] = `${px.toFixed(2)},${py.toFixed(2)}`;
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------- runtime

/**
 * Everything a family needs to know about this mission, resolved once.
 *
 * @param {object} def
 * @param {{data?:object|null, role?:string|object}} [opts]
 */
export function createMockRuntime(def, opts = {}) {
  const robot = def || {};
  const data = opts.data !== undefined ? opts.data : robot.data || null;
  const { lines, synthesized, sampled } = oldWayLines(robot, { data });
  const stats = oldWayStats(robot, data);

  // The wall wraps: the line script is finite and the ticker is not. Restamping each wrap forward by
  // the script's own span keeps every clock in every family monotonic, because a monitor whose
  // timestamps jump backwards every forty rows reads as generated at a glance.
  const spanS = (() => {
    if (lines.length < 2) return 0;
    const span = lines[lines.length - 1].t - lines[0].t;
    if (!(span > 0)) return 0;
    return span + span / (lines.length - 1);
  })();

  return {
    def: robot,
    data,
    lines,
    synthesized,
    sampled,
    stats,
    spanS,
    /**
     * The record at an absolute cursor, with its time already advanced by however many times the
     * script has wrapped. Families never index `lines` themselves.
     * @param {number} cursor
     */
    at(cursor) {
      if (!lines.length) return null;
      const wrap = Math.floor(cursor / lines.length);
      const line = lines[cursor % lines.length];
      const t = line.t + wrap * spanS;
      return { t, path: line.path, text: line.text, stamp: clockAt(t), wrap };
    },
  };
}

/**
 * The accessible name for a mock's streaming surface.
 *
 * A screen reader reading four hundred lines of `pitch=-14.8` aloud is the demo's whole argument
 * turned into an accessibility failure, so every family labels its wall once and hides the rows.
 * The label says WHICH wall this is, because a stand-in has to disclose itself in the accessible
 * copy too, not only in the sighted cost line.
 *
 * @param {string} toolClass e.g. 'serial monitor'
 * @param {boolean} synthesized
 */
export function wallLabel(toolClass, synthesized) {
  return synthesized
    ? `A ${toolClass} of this mission's own channel format, scrolling past unreadably. ` +
        'The values are stand-ins, not readings from this mission.'
    : `A ${toolClass} of raw telemetry from this mission, scrolling past unreadably.`;
}

/**
 * What is scrolling past, and what you cannot do with it. Same accounting as oldway.js's cost line,
 * with the closing clause handed in so each family can name its OWN missing affordances: a
 * dashboard is not missing a time axis, it is missing the sample under the average.
 *
 * @param {{channels:number, rows:number, values:number, estimated:boolean}} stats
 * @param {boolean} synthesized
 * @param {string} tail
 */
export function costLine(stats, synthesized, tail) {
  const bits = [];
  const approx = stats.estimated ? '~' : '';
  if (stats.rows > 0) bits.push(`${approx}${loc(stats.rows)} lines`);
  if (stats.channels > 0) {
    bits.push(`${loc(stats.channels)} ${stats.channels === 1 ? 'channel' : 'channels'}`);
  }
  if (stats.values > 0) bits.push(`${approx}${loc(stats.values)} values`);
  const head = bits.length ? bits.join(' · ') + '. ' : '';
  // The synthesized tail DISCLOSES rather than merely differing. A wall of invented numbers under a
  // header naming this mission is a claim about this mission unless the panel says otherwise.
  const disclosure = synthesized
    ? " The values above are stand-ins in this mission's own channel format, not readings taken " +
      'from it.'
    : '';
  return head + tail + disclosure;
}

// ---------------------------------------------------------------------------- the shell

/**
 * Build a mock family.
 *
 * The shell owns everything that is the same in all four - role resolution, the line script, the
 * ticker, the on-screen gate, reduced motion, the row cap, disposal - and the family owns its
 * chrome. A family therefore cannot forget to clear a timer or disconnect an observer, because it
 * never holds either.
 *
 * @param {HTMLElement} mount
 * @param {object} def robot definition. Telemetry is used only if it is already attached.
 * @param {{
 *   role?: string|object,
 *   data?: object|null,
 *   onSeen?: (info:{robot:string, family:string, synthesized:boolean, sampled:boolean,
 *     role:string}) => void,
 *   autostart?: boolean,
 *   stepMs?: number,
 *   maxRows?: number,
 *   reduceMotion?: boolean,
 * }} opts `onSeen` fires ONCE, when the mock has actually started streaming on screen, which is the
 *   only honest moment to report it. `reduceMotion` forces the static path (tests, and a caller
 *   that already knows).
 * @param {{
 *   family: string,
 *   toolClass: string,
 *   build: (ctx:{root:HTMLElement, runtime:object, def:object, role:object}) => {
 *     onLine: (rec:{t:number, path:string, text:string, stamp:string},
 *              parsed:{path:string, fields:Array}, i:number) => void,
 *     onRole?: (role:object) => void,
 *     onFill?: () => void,
 *     rows?: HTMLElement,
 *     scroller?: HTMLElement,
 *   },
 * }} spec
 * @returns {{el:HTMLElement, family:string, lines:Array, synthesized:boolean, sampled:boolean,
 *   stats:object, started:()=>boolean, start:()=>void, skip:()=>void, pause:()=>void,
 *   resume:()=>void, setRole:(r:string|object)=>void, dispose:()=>void}}
 */
export function createMockShell(mount, def, opts, spec) {
  const robot = def || {};
  const onSeen = typeof opts.onSeen === 'function' ? opts.onSeen : () => {};
  const stepMs = Number.isFinite(opts.stepMs) ? Math.max(16, opts.stepMs) : STEP_MS;
  const maxRows = Number.isFinite(opts.maxRows) ? Math.max(12, opts.maxRows) : MAX_ROWS;
  const autostart = opts.autostart !== false;
  const reduceMotion =
    typeof opts.reduceMotion === 'boolean' ? opts.reduceMotion : prefersReducedMotion();

  let role =
    (typeof opts.role === 'object' && opts.role && opts.role.id ? opts.role : null) ||
    roleById(opts.role) ||
    effectiveRole();

  const runtime = createMockRuntime(robot, { data: opts.data });

  const root = h('div', `mk mk-${spec.family}`);
  root.dataset.family = spec.family;
  // The tool class rides the DOM so a QA pass, an analytics hook and the integrator's stylesheet
  // can all ask what this panel is imitating without importing the family module to find out.
  root.dataset.tool = spec.toolClass;
  root.dataset.role = role.id;
  if (robot.accent) root.style.setProperty('--acc', robot.accent);
  if (reduceMotion) root.classList.add('mk-static');

  const view = spec.build({ root, runtime, def: robot, role });
  const rowsEl = view && view.rows ? view.rows : null;
  const scroller = view && view.scroller ? view.scroller : rowsEl;

  mount.appendChild(root);

  let cursor = 0;
  let started = false;
  let seen = false;
  let paused = false;
  let filled = false;
  let disposed = false;
  let timer = 0;
  let io = null;

  function step() {
    const rec = runtime.at(cursor);
    if (!rec) return;
    cursor++;
    view.onLine(rec, parseLine(rec.text), cursor - 1);
    if (rowsEl) {
      while (rowsEl.childElementCount > maxRows) rowsEl.removeChild(rowsEl.firstElementChild);
    }
    // pinned to its OWN bottom, never to the page's: this must never scroll the document
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function markSeen() {
    if (seen) return;
    seen = true;
    onSeen({
      robot: robot.id,
      family: spec.family,
      synthesized: runtime.synthesized,
      sampled: runtime.sampled,
      role: role.id,
    });
  }

  function tick() {
    timer = 0;
    if (disposed || paused || filled) return;
    if (typeof document !== 'undefined' && document.hidden) {
      timer = window.setTimeout(tick, HIDDEN_MS);
      return;
    }
    for (let i = 0; i < BURST; i++) step();
    timer = window.setTimeout(tick, stepMs);
  }

  /** Land the whole thing at once and stop. Reduced motion, `skip()` and a dead ticker all end here. */
  function fill() {
    if (filled || disposed) return;
    filled = true;
    if (timer) window.clearTimeout(timer);
    timer = 0;
    const want = Math.min(maxRows, runtime.lines.length);
    // `cursor` may already be part way in (a skip mid-stream), so top up rather than restart: the
    // clock has to stay monotonic across the join.
    while (cursor < want) step();
    root.classList.add('mk-filled');
    root.classList.remove('mk-live');
    if (typeof view.onFill === 'function') view.onFill();
    markSeen();
  }

  /** Begin streaming. Idempotent: the observer and an explicit call cannot double-start it. */
  function start() {
    if (started || disposed || !runtime.lines.length) return;
    started = true;
    root.classList.add('mk-live');
    if (reduceMotion) {
      fill();
      return;
    }
    markSeen();
    // seed a few records so the panel is never an empty frame on its first paint
    for (let i = 0; i < 6; i++) step();
    timer = window.setTimeout(tick, stepMs);
  }

  if (autostart) {
    // A mock that started at mount would have scrolled its whole point past before the visitor
    // reached it, and its `seen` event would fire for a panel nobody saw. Start it when it is
    // actually on screen.
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          start();
          if (io) {
            io.disconnect();
            io = null;
          }
        },
        // Threshold 0 with a bottom margin, deliberately NOT a fractional threshold: a ratio is
        // intersected area over TARGET area, so a panel taller than the viewport can fill the whole
        // screen at a ratio of 0.3 and never trip a 0.35 threshold. See oldway.js.
        { threshold: 0, rootMargin: '0px 0px -25% 0px' },
      );
      io.observe(root);
    } else {
      start();
    }
  }

  return {
    el: root,
    family: spec.family,
    /** The built script, for tests and for a QA readout. */
    lines: runtime.lines,
    /** Whether the numbers are stand-ins because this mission's telemetry is not built here. */
    synthesized: runtime.synthesized,
    /** Whether this is the def's authored slice of its own values (`context.oldwaySample`). */
    sampled: runtime.sampled,
    stats: runtime.stats,
    started: () => started,

    start,

    /** The impatient-reader path: land the whole thing at once, and keep it. Never navigates. */
    skip: fill,

    pause() {
      paused = true;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      root.classList.remove('mk-live');
    },

    resume() {
      if (disposed || filled || !started) return;
      paused = false;
      root.classList.add('mk-live');
      if (!timer) timer = window.setTimeout(tick, stepMs);
    },

    /** Re-caption for a role chosen after this panel was built. */
    setRole(r) {
      role = (typeof r === 'object' && r && r.id ? r : roleById(r)) || effectiveRole();
      root.dataset.role = role.id;
      if (typeof view.onRole === 'function') view.onRole(role);
    },

    /** Idempotent, and safe when the mount has already been emptied out from under us. */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      if (io) {
        try {
          io.disconnect();
        } catch (_) {
          /* observer already dead */
        }
        io = null;
      }
      if (root && typeof root.remove === 'function') root.remove();
    },
  };
}

/**
 * The two strings the chrome is captioned with, and they do NOT come from the same place.
 *
 * The TOOL NAME describes the frame it sits on, so the family owns it. oldway.js takes that label
 * from `role.oldWay.tool` and is right to, because it ships one chrome and the engineer's artefact
 * IS a serial monitor; here there are four, and a dashboard with `SERIAL MONITOR` over it is a
 * panel contradicting itself in its own header.
 *
 * The CAPTION is a sentence about the visitor's working life rather than about the frame, so the
 * role owns it exactly as it does in oldway.js, and role.js stays the only place that copy lives.
 * The three intended pairings each read correctly off the role's own line: the engineer's serial
 * monitor, the lead's export in a dashboard, the operator's log in an inbox. A screen that pairs
 * them differently overrides `caption` rather than teaching this module about pairings.
 *
 * @param {object} role
 * @param {{tool?:string, caption?:string}} opts
 * @param {string} familyTool the family's own tool-class name
 * @returns {{tool:string, caption:string}}
 */
export function resolveCopy(role, opts, familyTool) {
  const ro = (role && role.oldWay) || {};
  const tool = typeof opts.tool === 'string' && opts.tool.trim() ? opts.tool.trim() : null;
  const caption =
    typeof opts.caption === 'string' && opts.caption.trim() ? opts.caption.trim() : null;
  return {
    tool: tool || familyTool,
    caption: caption || ro.caption || '',
  };
}

/**
 * The artefact this role is holding, for THIS mission. Same resolution order as oldway.js's
 * `portLine`, which is private there: the role's own `oldWay.port` first, because a ticket
 * attachment and a spreadsheet export are not serial ports; then the def's `context.port`, because
 * a mission that was not captured over USB must not claim it was; then the ESP32 default.
 *
 * @param {object} def
 * @param {object} role
 */
export function portLine(def, role) {
  const rolePort = role && role.oldWay ? role.oldWay.port : null;
  if (typeof rolePort === 'string' && rolePort.trim()) return rolePort.trim();
  const ctxPort = def && def.context ? def.context.port : null;
  if (typeof ctxPort === 'string' && ctxPort.trim()) return ctxPort.trim();
  const rate = Number.isFinite(def && def.rate) ? `${Math.round(def.rate)} Hz loop` : 'free running';
  return `/dev/cu.usbserial-0001 · 115200 baud · ${rate}`;
}
