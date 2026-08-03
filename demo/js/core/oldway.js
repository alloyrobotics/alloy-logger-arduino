// oldway.js - beat 2 of the mission brief: what finding this fault costs you today.
//
// The brief's three beats are the problem, the old way, and the ask. This is the middle one, and
// it exists because the aha is a CONTRAST: an answer with a citation is only impressive next to
// the thing it replaces. So the panel is a serial-monitor wall, streaming this mission's own
// channels at this mission's own cadence, scrolling past faster than anyone can read it. No
// highlight, no search, no time axis, no replay. The caption names the register the visitor
// already lives in (`role.js` owns the copy), and the cost line counts what is scrolling past.
//
// Same factory contract as the other screens' modules: (mount, def, opts) => { el, skip, dispose }.
// Nothing here advances the router and nothing owns navigation: the brief's own CTA does that.
//
// TRIPWIRE. This module NEVER imports a robot payload, and never reaches for one. It renders the
// def it is handed, and reads telemetry only if that telemetry already exists (`def.data`, or
// `opts.data`). Three of the seven missions derive their channels from a lazily loaded scene
// payload that the brief deliberately does not build (see app.js's ensureData tripwire), and a
// panel that pulled one in would put a 700 KB module in front of the screen whose entire job is to
// be instant. Those three author the wall instead: `context.oldwaySample` is a contiguous slice of
// the mission's own values, read out of its generator offline and printed, so a real recording is
// shown as itself. `sampled` says so. A def with neither telemetry nor a sample falls back to a
// wall built from its channel SCHEMA, and then `synthesized` is true and both the cost line and
// the accessible name say the numbers are stand-ins.

import { mulberry32, seedFor } from './prng.js';
import { effectiveRole, roleById } from './role.js';

/** Rows kept in the DOM. The wall is infinite; the document is not. */
const MAX_ROWS = 140;
/** Lines built up front. The ticker wraps around this list, so the wall never runs dry. */
const MAX_LINES = 600;
/** Fields printed per line. Beyond this a line is unreadable on a phone, which is not the point. */
const MAX_FIELDS = 8;
/** Default ms between appended lines. Fast enough to be unreadable, slow enough to be legible. */
const STEP_MS = 55;
/** Lines appended per tick once the wall is warm, so the scroll never looks like a metronome. */
const BURST = 2;
/** Deterministic wall-clock start for the timestamps: 09:14:02.000, mission-relative from there. */
const CLOCK_BASE_S = 9 * 3600 + 14 * 60 + 2;

const loc = (n) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');

/** Plausible ranges by unit, for the missions whose telemetry is not built on this screen. */
const UNIT_BAND = {
  'm/s': [0, 1.4, 2],
  deg: [-18, 18, 2],
  'deg/s': [-120, 120, 1],
  A: [0.2, 3.4, 2],
  V: [11.1, 12.6, 2],
  C: [28, 64, 1],
  mm: [-40, 40, 1],
  m: [-4.5, 4.5, 2],
  Hz: [40, 60, 0],
  '%': [0, 100, 0],
  ms: [1, 22, 1],
  rad: [-3.14, 3.14, 3],
  'rad/s': [-6, 6, 2],
};

/** @param {number} v @param {number} dp */
function fmt(v, dp) {
  if (!Number.isFinite(v)) return 'nan';
  if (dp === 0) return String(Math.round(v));
  return v.toFixed(dp);
}

/**
 * Decimals for a whole FIELD, sampled across the column rather than decided per value.
 *
 * Per-value formatting is what a chart does; a firmware printf has one format string, so a column
 * that prints `1` on one line and `1.000` on the next reads as generated rather than logged. An
 * all-integer column (a counter, a flag, a step rate) stays an integer column.
 */
function dpForField(arr) {
  if (!arr || !arr.length) return 2;
  const step = Math.max(1, Math.floor(arr.length / 24));
  let mag = 0;
  let allInt = true;
  for (let i = 0; i < arr.length; i += step) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) continue;
    if (!Number.isInteger(v)) allInt = false;
    const a = Math.abs(v);
    if (a > mag) mag = a;
  }
  if (allInt) return 0;
  if (mag >= 1000) return 1;
  if (mag >= 1) return 2;
  return 3;
}

/** `09:14:53.702` - the wall clock a serial monitor stamps, driven by mission time. */
function clock(t) {
  const total = CLOCK_BASE_S + (Number.isFinite(t) ? t : 0);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = Math.floor(total) % 60;
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(ms).padStart(3, '0')}`;
}

/**
 * What is actually in this mission, counted rather than claimed.
 *
 * A def whose channels come from a lazy payload has no arrays here, and building them is exactly
 * what this screen must not do. Its row count is ESTIMATED from the mission's own duration and
 * rate, which is the honest number for "how much log is this" without decoding anything, and the
 * caller is told so through `estimated`.
 *
 * @param {object} def
 * @param {object|null} data
 * @returns {{channels:number, rows:number, values:number, estimated:boolean}}
 */
export function oldWayStats(def, data) {
  const channels = Array.isArray(def.channels) ? def.channels : [];
  let rows = 0;
  let values = 0;
  let counted = false;
  channels.forEach((c) => {
    if (!c) return;
    const ch = data ? data[c.path] : null;
    const n = ch && ch.t && ch.t.length ? ch.t.length : 0;
    if (n) counted = true;
    const fields = Array.isArray(c.fields) ? c.fields.length : 0;
    rows += n;
    values += n * fields;
  });
  if (counted) return { channels: channels.length, rows, values, estimated: false };

  // Nothing built on this screen, so the AUTHORED count is the honest one. Every def carries the
  // real row-times-field total in `context.datapoints`, measured under node against the same seed
  // this page runs, and the brief prints it four lines below this panel's cost line. Estimating
  // `duration x rate` instead put two different volumes for the same mission on one screen: donna
  // read "~36,720 lines · ~91,800 values" here and "34,899 raw datapoints" there, an overstatement
  // of 2.6x about a REAL recording. No row count is invented alongside it: rows are not authored,
  // and a made-up line count is the same bug one field narrower.
  const ctx = def.context || {};
  const authoredChannels =
    Number.isFinite(ctx.channels) && ctx.channels > 0 ? Math.round(ctx.channels) : channels.length;
  if (Number.isFinite(ctx.datapoints) && ctx.datapoints > 0) {
    return {
      channels: authoredChannels,
      rows: 0,
      values: Math.round(ctx.datapoints),
      estimated: false,
    };
  }

  const dur = Number.isFinite(def.duration) ? def.duration : 0;
  const rate = Number.isFinite(def.rate) ? def.rate : 0;
  const per = Math.max(1, Math.round(dur * rate));
  rows = 0;
  values = 0;
  channels.forEach((c) => {
    const fields = Array.isArray(c && c.fields) ? c.fields.length : 0;
    rows += per;
    values += per * fields;
  });
  return { channels: channels.length, rows, values, estimated: true };
}

/**
 * The wall's line script.
 *
 * Real telemetry is walked in TIME order across every channel at once, striding each one so the
 * whole mission is represented in at most MAX_LINES rows: a wall that only ever showed the first
 * two seconds would be a different lie from the one this panel is making.
 *
 * A def whose telemetry is not built here can author the wall instead of having one invented for
 * it: `context.oldwaySample` is a contiguous slice of that mission's OWN values, read out of its
 * generator offline and printed. It is preferred over everything below, because a real slice of a
 * real recording is not a thing to synthesize a substitute for.
 *
 * @param {object} def the robot definition, as handed to the brief
 * @param {{ data?:object|null, max?:number }} [opts] `data` defaults to `def.data` IF it exists;
 *   it is never built here.
 * @returns {{lines:Array<{t:number, path:string, text:string}>, synthesized:boolean,
 *   sampled:boolean}}
 */
export function oldWayLines(def, opts = {}) {
  const channels = (Array.isArray(def && def.channels) ? def.channels : []).filter(
    (c) => c && c.path && Array.isArray(c.fields) && c.fields.length,
  );
  const max = Number.isFinite(opts.max) ? opts.max : MAX_LINES;

  // The authored slice first, and BEFORE the channel check: it is already printed lines, so it does
  // not need a channel table to render, and the three missions that ship one are exactly the three
  // whose channels come from a payload this screen refuses to load.
  const sample = sampledLines(def, max);
  if (sample) return { lines: sample, synthesized: false, sampled: true };

  if (!channels.length) return { lines: [], synthesized: false, sampled: false };

  const data = opts.data !== undefined ? opts.data : def.data || null;
  const hasReal = !!(
    data && channels.some((c) => data[c.path] && data[c.path].t && data[c.path].t.length)
  );

  const lines = [];
  if (hasReal) {
    // one cursor per channel, always advancing whichever is earliest: a merge, not a concat
    const total = totalRows(channels, data);
    const cursors = channels
      .map((c) => {
        const ch = data[c.path];
        const t = ch && ch.t ? ch.t : null;
        if (!t || !t.length) return null;
        // every channel contributes in proportion to its own row count, so a 10 Hz /sys line does
        // not appear as often as a 50 Hz control line
        const share = Math.max(1, Math.round((t.length / total) * max));
        const dp = new Map(c.fields.map((f) => [f.key, dpForField(ch[f.key])]));
        return { c, ch, t, dp, i: 0, stride: Math.max(1, Math.floor(t.length / share)) };
      })
      .filter(Boolean);

    while (lines.length < max) {
      let pick = null;
      for (const cur of cursors) {
        if (cur.i >= cur.t.length) continue;
        if (!pick || cur.t[cur.i] < pick.t[pick.i]) pick = cur;
      }
      if (!pick) break;
      lines.push(
        lineFor(pick.c, pick.t[pick.i], (f) => valueAt(pick.ch, f.key, pick.i, pick.dp.get(f.key))),
      );
      pick.i += pick.stride;
    }
    return { lines, synthesized: false, sampled: false };
  }

  // No telemetry on this screen, by design. The schema is real, the numbers are a stand-in, and
  // the cadence is the mission's own: same wall, same unreadability, nothing decoded.
  const rnd = mulberry32(seedFor(def.id || 'oldway'));
  const dur = Number.isFinite(def.duration) && def.duration > 0 ? def.duration : 60;
  const step = dur / max;
  const state = new Map();
  // Channels are interleaved by weight, not round-robined: a strict repeating order lines the
  // paths up into a visible column down a fast-scrolling wall, which is the one thing a real
  // serial log never looks like. Weight is the field count, so the busiest channel talks most.
  const weights = channels.map((c) => c.fields.length);
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const pickChannel = () => {
    let r = rnd() * wSum;
    for (let k = 0; k < channels.length; k++) {
      r -= weights[k];
      if (r <= 0) return channels[k];
    }
    return channels[channels.length - 1];
  };
  for (let i = 0; i < max; i++) {
    const c = pickChannel();
    const t = i * step;
    lines.push(
      lineFor(c, t, (f) => {
        const key = c.path + '.' + f.key;
        const band = UNIT_BAND[f.unit] || [-1, 1, 2];
        const prev = state.has(key) ? state.get(key) : band[0] + (band[1] - band[0]) * rnd();
        // a random walk inside the band: consecutive lines that jump the whole range read as noise
        const next = Math.min(
          band[1],
          Math.max(band[0], prev + (rnd() - 0.5) * (band[1] - band[0]) * 0.12),
        );
        state.set(key, next);
        return fmt(next, band[2]);
      }),
    );
  }
  return { lines, synthesized: true, sampled: false };
}

/**
 * `context.oldwaySample` as wall lines, or null when the def ships none.
 *
 * The authored format is one line per record: `"<t> <path> k=v k=v"`. Only the leading timestamp
 * and the path are parsed out; the rest of the line is printed exactly as authored, so a value that
 * was read out of the mission's own generator reaches the screen byte for byte, absent readings
 * (`k=null`) included.
 *
 * @param {object} def
 * @param {number} max
 * @returns {Array<{t:number, path:string, text:string}>|null}
 */
function sampledLines(def, max) {
  const raw = def && def.context ? def.context.oldwaySample : null;
  if (!Array.isArray(raw) || !raw.length) return null;
  const lines = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const m = entry.trim().match(/^(-?\d+(?:\.\d+)?)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const t = Number(m[1]);
    lines.push({
      t: Number.isFinite(t) ? t : 0,
      path: m[2],
      text: m[3] ? `${m[2]} ${m[3]}` : m[2],
    });
    if (lines.length >= max) break;
  }
  return lines.length ? lines : null;
}

/** @param {Array} channels @param {object} data */
function totalRows(channels, data) {
  let n = 0;
  channels.forEach((c) => {
    const ch = data[c.path];
    if (ch && ch.t) n += ch.t.length;
  });
  return n || 1;
}

/** @param {object} ch @param {string} key @param {number} i @param {number} dp column decimals */
function valueAt(ch, key, i, dp) {
  const arr = ch ? ch[key] : null;
  if (!arr || i >= arr.length) return 'nan';
  const v = arr[i];
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return v;
  return fmt(Number(v), Number.isFinite(dp) ? dp : 2);
}

/**
 * One printed line, in the grammar a firmware printf actually produces.
 * @param {object} c channel
 * @param {number} t mission time
 * @param {(f:object)=>string} val
 */
function lineFor(c, t, val) {
  const fields = c.fields.slice(0, MAX_FIELDS);
  const body = fields.map((f) => `${f.key}=${val(f)}`).join(' ');
  const more = c.fields.length > MAX_FIELDS ? ` +${c.fields.length - MAX_FIELDS}` : '';
  return { t, path: c.path, text: `${c.path} ${body}${more}` };
}

/**
 * The panel.
 *
 * @param {HTMLElement} mount
 * @param {object} def robot definition. Telemetry is used only if it is already attached.
 * @param {{
 *   role?: string|object,
 *   data?: object|null,
 *   onSeen?: (info:{robot:string, synthesized:boolean, sampled:boolean, role:string}) => void,
 *   autostart?: boolean,
 *   stepMs?: number,
 *   maxRows?: number,
 * }} [opts] `onSeen` fires ONCE, when the wall has actually started streaming on screen, which is
 *   the only honest moment to call `oldway_seen`.
 * @returns {{el:HTMLElement, lines:Array, synthesized:boolean, started:()=>boolean,
 *   start:()=>void, skip:()=>void, pause:()=>void, resume:()=>void,
 *   setRole:(r:string|object)=>void, dispose:()=>void}}
 */
export function createOldWay(mount, def, opts = {}) {
  const robot = def || {};
  const onSeen = typeof opts.onSeen === 'function' ? opts.onSeen : () => {};
  const stepMs = Number.isFinite(opts.stepMs) ? Math.max(16, opts.stepMs) : STEP_MS;
  const maxRows = Number.isFinite(opts.maxRows) ? Math.max(12, opts.maxRows) : MAX_ROWS;
  const autostart = opts.autostart !== false;

  let role =
    (typeof opts.role === 'object' && opts.role && opts.role.id ? opts.role : null) ||
    roleById(opts.role) ||
    effectiveRole();

  const data = opts.data !== undefined ? opts.data : robot.data || null;
  const { lines, synthesized, sampled } = oldWayLines(robot, { data });
  const stats = oldWayStats(robot, data);

  // The wall wraps: the line script is finite and the ticker is not. Restamping each wrap forward
  // by the script's own span keeps the clock monotonic, because a serial monitor whose timestamps
  // jump backwards every forty rows is the one thing that reads as generated at a glance.
  const spanS = (() => {
    if (lines.length < 2) return 0;
    const first = lines[0].t;
    const last = lines[lines.length - 1].t;
    const span = last - first;
    if (!(span > 0)) return 0;
    return span + span / (lines.length - 1);
  })();

  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = document.createElement('div');
  el.className = 'ow';
  if (robot.accent) el.style.setProperty('--acc', robot.accent);
  el.innerHTML = `
    <div class="ow-head">
      <span class="ow-tool mono"></span>
      <span class="ow-port mono"></span>
    </div>
    <div class="ow-wall" role="img">
      <div class="ow-rows mono"></div>
      <div class="ow-fade" aria-hidden="true"></div>
    </div>
    <p class="ow-caption"></p>
    <p class="ow-cost mono"></p>`;

  const q = (sel) => el.querySelector(sel);
  const wall = q('.ow-wall');
  const rowsEl = q('.ow-rows');
  const toolEl = q('.ow-tool');
  const portEl = q('.ow-port');
  const captionEl = q('.ow-caption');

  // The wall is decoration with a job: a screen reader reading four hundred lines of `pitch=-14.8`
  // aloud is the demo's whole argument turned into an accessibility failure. One label instead,
  // and it says which of the two walls this is: a slice of the mission's own values, or a stand-in
  // in the mission's channel format. The sighted disclosure is the cost line's tail.
  wall.setAttribute(
    'aria-label',
    synthesized
      ? "A serial monitor wall in this mission's own channel format, scrolling past unreadably. " +
        'The values are stand-ins, not readings from this mission.'
      : 'A serial monitor wall of raw telemetry from this mission, scrolling past unreadably.',
  );

  q('.ow-cost').textContent = costLine(stats, synthesized);
  applyRole(role);

  mount.appendChild(el);

  let cursor = 0;
  let started = false;
  let seen = false;
  let paused = false;
  let filled = false;
  let disposed = false;
  let timer = 0;
  let io = null;

  /** @param {object} r */
  function applyRole(r) {
    role = r || effectiveRole();
    toolEl.textContent = role.oldWay.tool;
    captionEl.textContent = role.oldWay.caption;
    // The chrome follows the ROLE, not just the caption. Captioning the panel "the CSV your team
    // exports" over a header that reads `115200 baud` had the screen contradict itself for two of
    // the three roles; each role names the artefact it is actually handed.
    portEl.textContent = portLine(robot, role);
    el.dataset.role = role.id;
  }

  function appendLine() {
    if (!lines.length) return;
    const wrap = Math.floor(cursor / lines.length);
    const l = lines[cursor % lines.length];
    cursor++;
    const row = document.createElement('div');
    row.className = 'ow-line';
    const ts = document.createElement('span');
    ts.className = 'ow-t';
    ts.textContent = clock(l.t + wrap * spanS);
    const arrow = document.createElement('span');
    arrow.className = 'ow-arrow';
    arrow.textContent = '->';
    const txt = document.createElement('span');
    txt.className = 'ow-txt';
    txt.textContent = l.text;
    row.append(ts, arrow, txt);
    rowsEl.appendChild(row);
    while (rowsEl.childElementCount > maxRows) rowsEl.removeChild(rowsEl.firstElementChild);
    // the wall is pinned to its own bottom, never to the page's: this must not scroll the document
    wall.scrollTop = wall.scrollHeight;
  }

  function markSeen() {
    if (seen) return;
    seen = true;
    onSeen({ robot: robot.id, synthesized, sampled, role: role.id });
  }

  function tick() {
    timer = 0;
    if (disposed || paused || filled) return;
    if (typeof document !== 'undefined' && document.hidden) {
      // a background tab must not burn a timer building rows nobody is watching
      timer = window.setTimeout(tick, 400);
      return;
    }
    for (let i = 0; i < BURST; i++) appendLine();
    timer = window.setTimeout(tick, stepMs);
  }

  /** Fill the wall in one go and stop. Reduced motion, `skip()`, and a dead ticker all land here. */
  function fill() {
    if (filled || disposed) return;
    filled = true;
    if (timer) window.clearTimeout(timer);
    timer = 0;
    const want = Math.min(maxRows, lines.length);
    while (rowsEl.childElementCount < want) appendLine();
    el.classList.add('ow-filled');
    markSeen();
  }

  /** Begin streaming. Idempotent: the observer and an explicit call cannot double-start it. */
  function start() {
    if (started || disposed || !lines.length) return;
    started = true;
    el.classList.add('ow-live');
    if (reduceMotion) {
      fill();
      return;
    }
    markSeen();
    // seed a few rows so the panel is never an empty box on its first frame
    for (let i = 0; i < 6; i++) appendLine();
    timer = window.setTimeout(tick, stepMs);
  }

  if (autostart) {
    // The brief is a scrolling column and this is its second beat: a wall that started at mount
    // would have scrolled its whole point past before the visitor got there, and `oldway_seen`
    // would fire for a panel nobody saw. Start it when it is actually on screen.
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            start();
            if (io) {
              io.disconnect();
              io = null;
            }
          }
        },
        // Threshold 0 with a bottom margin, deliberately NOT a fractional threshold: a ratio is
        // intersected area over TARGET area, so a panel taller than the viewport can fill the
        // whole screen at a ratio of 0.3 and never trip a 0.35 threshold. This fires when the
        // panel's leading edge has come up into the top three quarters of the viewport, which is
        // reachable at every panel height and on every phone.
        { threshold: 0, rootMargin: '0px 0px -25% 0px' },
      );
      io.observe(el);
    } else {
      start();
    }
  }

  return {
    el,
    /** The built script, for tests and for a QA readout. */
    lines,
    /** Whether the numbers are stand-ins because this mission's telemetry is not built here. */
    synthesized,
    /** Whether the wall is the def's authored slice of its own values (`context.oldwaySample`). */
    sampled,
    started: () => started,

    start,

    /** The impatient-reader path: land the whole wall at once, and keep it. Never navigates. */
    skip: fill,

    pause() {
      paused = true;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      el.classList.remove('ow-live');
    },

    resume() {
      if (disposed || filled || !started) return;
      paused = false;
      el.classList.add('ow-live');
      if (!timer) timer = window.setTimeout(tick, stepMs);
    },

    /** Re-caption for a role chosen after this panel was built. */
    setRole(r) {
      applyRole((typeof r === 'object' && r && r.id ? r : roleById(r)) || effectiveRole());
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
      if (el && typeof el.remove === 'function') el.remove();
    },
  };
}

/**
 * The header's second half: the artefact this role is actually holding, for THIS mission.
 *
 * Resolution order, and the reason for each step:
 *   1. the role's own `oldWay.port`, because a support ticket attachment and a spreadsheet export
 *      are not serial ports and captioning them as one made the panel contradict its own caption
 *   2. the def's `context.port`, because the engineer's view of a mission that was NOT captured
 *      over USB serial must not claim it was: donna is a ROS 2 rosbag2 recording off a humanoid,
 *      and printing `/dev/cu.usbserial-0001` under her provenance line invents a capture path
 *   3. the ESP32 default, which is what the four synthetic missions are
 *
 * @param {object} def
 * @param {object} [role]
 */
function portLine(def, role) {
  const rolePort = role && role.oldWay ? role.oldWay.port : null;
  if (typeof rolePort === 'string' && rolePort.trim()) return rolePort.trim();
  const ctxPort = def && def.context ? def.context.port : null;
  if (typeof ctxPort === 'string' && ctxPort.trim()) return ctxPort.trim();
  const rate = Number.isFinite(def.rate) ? `${Math.round(def.rate)} Hz loop` : 'free running';
  return `/dev/cu.usbserial-0001 · 115200 baud · ${rate}`;
}

/** What is scrolling past, and what you cannot do with it. */
function costLine(stats, synthesized) {
  const bits = [];
  if (stats.rows > 0) {
    bits.push(`${stats.estimated ? '~' : ''}${loc(stats.rows)} lines`);
  }
  if (stats.channels > 0) {
    bits.push(`${loc(stats.channels)} ${stats.channels === 1 ? 'channel' : 'channels'}`);
  }
  if (stats.values > 0) bits.push(`${stats.estimated ? '~' : ''}${loc(stats.values)} values`);
  const head = bits.length ? bits.join(' · ') + '. ' : '';
  // The synthesized tail DISCLOSES rather than merely differing. A wall of invented numbers under a
  // header naming this mission is a claim about this mission unless the panel says otherwise, and
  // one word shorter is not saying otherwise.
  const tail = synthesized
    ? 'No time axis, no search, no replay. The values above are stand-ins in this mission\'s own ' +
      'channel format, not readings taken from it.'
    : 'No time axis, no search, no replay. The moment it broke is somewhere in there.';
  return head + tail;
}
