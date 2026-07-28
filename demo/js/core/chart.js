// chart.js - canvas time-series panel driven by the shared timeline.
// Channel + field chips above, min/max downsampled traces, crosshair readout, synced playhead,
// finding-window shading, and an animated x-domain zoom via focus(finding).
//
// NOTE: app.js attaches the built telemetry onto the robot def as `robotDef.data` before
// constructing the chart (buildData is only called once, at load). See app.js.

import { indexAt, sampleAt, clamp } from './prng.js';

export const SERIES_COLORS = ['#2f78ff', '#D3EEB6', '#f5a623', '#FF5F57', '#9d7bff', '#4dd0e1'];

const AXIS_FONT = '11px "Geist Mono", ui-monospace, monospace';
const PAD = { l: 52, r: 14, t: 12, b: 24 };

/**
 * @param {HTMLElement} mount
 * @param {object} robotDef with `.data` attached
 * @param {object} timeline
 * @returns {{
 *   el:HTMLElement, canvas:HTMLCanvasElement,
 *   focus:(finding:object)=>void, resetZoom:()=>void,
 *   setChannel:(path:string, fields?:string[])=>void,
 *   get domain():[number,number], get channel():string, get fields():string[],
 *   redraw:()=>void, dispose:()=>void
 * }}
 */
export function createChart(mount, robotDef, timeline) {
  const data = robotDef.data || {};
  const duration = robotDef.duration;

  const el = document.createElement('div');
  el.className = 'chart';
  el.innerHTML = `
    <div class="chart-bar">
      <div class="chan-chips" role="tablist" aria-label="Telemetry channels"></div>
      <button class="chart-reset" type="button" hidden>reset zoom</button>
    </div>
    <div class="field-chips" aria-label="Fields"></div>
    <div class="chart-canvas-wrap">
      <canvas class="chart-canvas"></canvas>
      <div class="chart-readout mono" hidden></div>
    </div>`;
  mount.appendChild(el);

  const chanChips = el.querySelector('.chan-chips');
  const fieldChips = el.querySelector('.field-chips');
  const resetBtn = el.querySelector('.chart-reset');
  const wrap = el.querySelector('.chart-canvas-wrap');
  const canvas = el.querySelector('.chart-canvas');
  const readout = el.querySelector('.chart-readout');
  const ctx = canvas.getContext('2d');

  const SEV_COLORS = { alert: '#FF5F57', warn: '#f5a623', info: '#D3EEB6' };
  const SEV_FILLS = {
    alert: 'rgba(255,95,87,0.10)',
    warn: 'rgba(245,166,35,0.10)',
    info: 'rgba(211,238,182,0.09)',
  };

  let channel = robotDef.channels[0].path;
  let fields = robotDef.channels[0].fields.slice(0, 3).map((f) => f.key);
  let domain = [0, duration];
  let targetDomain = [0, duration];
  let shade = null; // [a,b] finding window shading
  let shadeSev = 'alert'; // shading follows the finding's severity, not always alert red
  let markT = null; // single instant marker, used when a finding spans the whole mission
  let hoverX = null;
  let anim = 0;
  let disposed = false;
  let dirty = true;

  const chanDef = () => robotDef.channels.find((c) => c.path === channel) || robotDef.channels[0];
  const fieldDef = (key) => chanDef().fields.find((f) => f.key === key);

  // ---------- chips ----------
  function renderChanChips() {
    chanChips.innerHTML = '';
    robotDef.channels.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip mono' + (c.path === channel ? ' on' : '');
      b.textContent = c.path;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(c.path === channel));
      b.addEventListener('click', () => setChannel(c.path));
      chanChips.appendChild(b);
    });
  }

  function renderFieldChips() {
    fieldChips.innerHTML = '';
    // Selected fields first, in series order. The row scrolls horizontally on a phone, and the
    // chips for the lines actually drawn have to be the ones you can see without scrolling.
    const all = chanDef().fields;
    const ordered = fields
      .map((k) => all.find((f) => f.key === k))
      .filter(Boolean)
      .concat(all.filter((f) => fields.indexOf(f.key) < 0));
    ordered.forEach((f) => {
      const idx = fields.indexOf(f.key);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fchip mono' + (idx >= 0 ? ' on' : '');
      if (idx >= 0) b.style.setProperty('--fc', SERIES_COLORS[idx % SERIES_COLORS.length]);
      // Built as nodes, not markup: field labels and units come from the robot def, and a
      // generated def is untrusted text. Same elements, same order, same classes as before.
      const dot = document.createElement('i');
      dot.className = 'fdot';
      b.appendChild(dot);
      b.appendChild(document.createTextNode(f.label || f.key));
      if (f.unit) {
        const em = document.createElement('em');
        em.textContent = f.unit;
        b.appendChild(em);
      }
      b.addEventListener('click', () => {
        const at = fields.indexOf(f.key);
        if (at >= 0) {
          if (fields.length > 1) fields.splice(at, 1);
        } else if (fields.length < SERIES_COLORS.length) {
          fields.push(f.key);
        }
        renderFieldChips();
        dirty = true;
      });
      fieldChips.appendChild(b);
    });
  }

  function setChannel(path, nextFields) {
    const c = robotDef.channels.find((x) => x.path === path);
    if (!c) return;
    channel = path;
    const avail = c.fields.map((f) => f.key);
    const wanted = Array.isArray(nextFields) ? nextFields.filter((f) => avail.includes(f)) : [];
    fields = wanted.length ? wanted : avail.slice(0, 3);
    renderChanChips();
    renderFieldChips();
    dirty = true;
  }

  // ---------- zoom ----------
  function animateDomain(to) {
    targetDomain = [to[0], to[1]];
    resetBtn.hidden = to[0] <= 0.001 && to[1] >= duration - 0.001;
    if (anim) cancelAnimationFrame(anim);
    const from = [domain[0], domain[1]];
    const t0 = performance.now();
    const dur = 420;
    const step = (now) => {
      const k = clamp((now - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      domain = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      dirty = true;
      if (k < 1 && !disposed) anim = requestAnimationFrame(step);
      else anim = 0;
    };
    anim = requestAnimationFrame(step);
  }

  function focus(finding) {
    if (!finding) return;
    if (finding.focus && finding.focus.channel) {
      setChannel(finding.focus.channel, finding.focus.fields);
    }
    const w = finding.window || [0, duration];
    shadeSev = finding.severity || 'warn';
    // A slow-burn finding covers the whole mission. Shading 100 % of the plot says nothing and
    // reads as a full-plot error state, so those get the full domain plus a marker at the instant
    // the answer is talking about, and no window fill.
    if (w[1] - w[0] >= duration * 0.95) {
      shade = null;
      markT = finding.t != null ? finding.t : null;
      animateDomain([0, duration]);
      return;
    }
    const pad = Math.max((w[1] - w[0]) * 0.15, 0.25);
    shade = [w[0], w[1]];
    markT = null;
    animateDomain([Math.max(0, w[0] - pad), Math.min(duration, w[1] + pad)]);
  }

  function resetZoom() {
    shade = null;
    markT = null;
    animateDomain([0, duration]);
  }

  resetBtn.addEventListener('click', resetZoom);

  // ---------- drawing ----------
  let w = 0;
  let h = 0;
  let dpr = 1;
  // measured per frame off the real tick labels: byte counts and a second unit axis both need
  // more room than a fixed 52 px gutter
  let padL = PAD.l;
  let padR = PAD.r;

  function resize() {
    const r = wrap.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(Math.floor(r.width), 120);
    h = Math.max(Math.floor(r.height), 90);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    dirty = true;
  }

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  const x2px = (t) => padL + ((t - domain[0]) / Math.max(domain[1] - domain[0], 1e-6)) * (w - padL - padR);
  const px2x = (px) => domain[0] + ((px - padL) / Math.max(w - padL - padR, 1)) * (domain[1] - domain[0]);

  /**
   * One y-range PER UNIT, not one across every selected field. Sharing an axis between deg and
   * pwm (or m/s and A) flattened the exact signal the analyst's answer quotes into a dead line at
   * the bottom of the plot, which is precisely the number the chart is there to corroborate.
   * Group 0 owns the left axis, group 1 the right; further groups keep their own scale unlabelled.
   */
  function unitGroups() {
    const ch = data[channel];
    const byUnit = new Map();
    const groups = [];
    fields.forEach((key) => {
      const unit = (fieldDef(key) || {}).unit || '';
      let g = byUnit.get(unit);
      if (!g) {
        g = { unit, keys: [], lo: Infinity, hi: -Infinity };
        byUnit.set(unit, g);
        groups.push(g);
      }
      g.keys.push(key);
    });
    if (!groups.length) groups.push({ unit: '', keys: [], lo: 0, hi: 1 });

    const i0 = ch && ch.t ? indexAt(ch.t, domain[0]) : 0;
    const i1 = ch && ch.t ? indexAt(ch.t, domain[1]) : 0;
    groups.forEach((g) => {
      if (ch && ch.t) {
        for (const key of g.keys) {
          const arr = ch[key];
          if (!arr) continue;
          for (let i = i0; i <= i1 && i < arr.length; i++) {
            const v = arr[i];
            if (!Number.isFinite(v)) continue;
            if (v < g.lo) g.lo = v;
            if (v > g.hi) g.hi = v;
          }
        }
      }
      if (!Number.isFinite(g.lo) || !Number.isFinite(g.hi)) {
        g.lo = 0;
        g.hi = 1;
      } else if (g.hi - g.lo < 1e-6) {
        const c = (g.hi + g.lo) / 2;
        g.lo = c - 0.5;
        g.hi = c + 0.5;
      } else {
        const pad = (g.hi - g.lo) * 0.12;
        g.lo -= pad;
        g.hi += pad;
      }
    });
    return groups;
  }

  function fmt(v) {
    const a = Math.abs(v);
    if (a >= 10000) return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
  }

  /** Axis tick label: the value plus its unit, so the prose and the axis agree. */
  function tick(v, unit) {
    return unit ? `${fmt(v)} ${unit}` : fmt(v);
  }

  function draw() {
    if (!w || !h) return;
    const ch = data[channel];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = AXIS_FONT;

    const groups = unitGroups();
    const gOf = new Map();
    groups.forEach((g) => g.keys.forEach((k) => gOf.set(k, g)));

    const plotH = h - PAD.t - PAD.b;
    // short panels (mobile, collapsed chart) cannot fit 5 labels without them colliding
    const rows = plotH < 150 ? 2 : plotH < 230 ? 3 : 4;

    // gutters sized off the widest label each axis will actually print
    const labelsFor = (g) => {
      const out = [];
      for (let i = 0; i <= rows; i++) out.push(tick(g.lo + ((g.hi - g.lo) * i) / rows, g.unit));
      return out;
    };
    const leftLabels = labelsFor(groups[0]);
    const rightLabels = groups.length > 1 ? labelsFor(groups[1]) : null;
    const widest = (list) => list.reduce((m, s) => Math.max(m, ctx.measureText(s).width), 0);
    padL = Math.min(Math.max(PAD.l, Math.ceil(widest(leftLabels)) + 12), Math.floor(w * 0.34));
    padR = rightLabels
      ? Math.min(Math.max(PAD.r, Math.ceil(widest(rightLabels)) + 12), Math.floor(w * 0.3))
      : PAD.r;

    const plotW = w - padL - padR;
    const yIn = (g, v) => PAD.t + (1 - (v - g.lo) / (g.hi - g.lo)) * plotH;
    const y2px = (key, v) => yIn(gOf.get(key) || groups[0], v);

    // finding window shading, tinted by severity: a warn finding must not read as an error
    if (shade) {
      const a = clamp(x2px(shade[0]), padL, w - padR);
      const b = clamp(x2px(shade[1]), padL, w - padR);
      ctx.fillStyle = SEV_FILLS[shadeSev] || SEV_FILLS.warn;
      ctx.fillRect(a, PAD.t, b - a, plotH);
      ctx.strokeStyle = SEV_COLORS[shadeSev] || SEV_COLORS.warn;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(a) + 0.5, PAD.t);
      ctx.lineTo(Math.round(a) + 0.5, PAD.t + plotH);
      ctx.moveTo(Math.round(b) + 0.5, PAD.t);
      ctx.lineTo(Math.round(b) + 0.5, PAD.t + plotH);
      ctx.stroke();
    }

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= rows; i++) {
      const v = groups[0].lo + ((groups[0].hi - groups[0].lo) * i) / rows;
      const y = Math.round(yIn(groups[0], v)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.40)';
      ctx.fillText(leftLabels[i], padL - 8, y);
      if (rightLabels) {
        ctx.textAlign = 'left';
        // tinted with the second group's first series colour so the two axes are attributable
        ctx.fillStyle = SERIES_COLORS[fields.indexOf(groups[1].keys[0]) % SERIES_COLORS.length];
        ctx.globalAlpha = 0.75;
        ctx.fillText(rightLabels[i], w - padR + 8, y);
        ctx.globalAlpha = 1;
      }
    }

    // x labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const cols = w < 420 ? 3 : 6;
    for (let i = 0; i <= cols; i++) {
      const t = domain[0] + ((domain[1] - domain[0]) * i) / cols;
      const x = Math.round(x2px(t)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.40)';
      // keep the first/last labels inside the canvas instead of centering them off the edge
      ctx.textAlign = i === 0 ? 'left' : i === cols ? 'right' : 'center';
      ctx.fillText(t.toFixed(domain[1] - domain[0] < 12 ? 1 : 0) + 's', x, PAD.t + plotH + 6);
    }
    ctx.textAlign = 'center';

    // traces, min/max downsampled to one column per pixel
    if (ch && ch.t) {
      fields.forEach((key, si) => {
        const arr = ch[key];
        if (!arr) return;
        const g = gOf.get(key) || groups[0];
        const yv = (v) => yIn(g, v);
        ctx.strokeStyle = SERIES_COLORS[si % SERIES_COLORS.length];
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const i0 = indexAt(ch.t, domain[0]);
        const i1 = Math.min(indexAt(ch.t, domain[1]) + 1, arr.length - 1);
        const n = i1 - i0;
        if (n <= plotW) {
          for (let i = i0; i <= i1; i++) {
            const x = x2px(ch.t[i]);
            const y = yv(arr[i]);
            if (i === i0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        } else {
          const per = n / plotW;
          for (let px = 0; px < plotW; px++) {
            const a = i0 + Math.floor(px * per);
            const b = Math.min(i0 + Math.floor((px + 1) * per), i1);
            let mn = Infinity;
            let mx = -Infinity;
            for (let i = a; i <= b; i++) {
              const v = arr[i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            if (!Number.isFinite(mn)) continue;
            const x = padL + px;
            if (px === 0) ctx.moveTo(x, yv(mn));
            ctx.lineTo(x, yv(mn));
            ctx.lineTo(x, yv(mx));
          }
        }
        ctx.stroke();
      });
    }

    // instant marker for a whole-mission finding, so "the money interaction" still points at
    // something even when there is no window to zoom into
    if (markT != null && markT >= domain[0] && markT <= domain[1]) {
      const x = Math.round(x2px(markT)) + 0.5;
      ctx.strokeStyle = SEV_COLORS[shadeSev] || SEV_COLORS.warn;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = SEV_COLORS[shadeSev] || SEV_COLORS.warn;
      ctx.beginPath();
      ctx.moveTo(x - 4, PAD.t);
      ctx.lineTo(x + 4, PAD.t);
      ctx.lineTo(x, PAD.t + 5);
      ctx.closePath();
      ctx.fill();
    }

    // playhead
    const pt = timeline.t;
    if (pt >= domain[0] && pt <= domain[1]) {
      const x = Math.round(x2px(pt)) + 0.5;
      ctx.strokeStyle = '#2f78ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
    }

    // crosshair
    if (hoverX != null && hoverX >= padL && hoverX <= w - padR) {
      const x = Math.round(hoverX) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.24)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ch && ch.t) {
        fields.forEach((key, si) => {
          const arr = ch[key];
          if (!arr) return;
          const v = sampleAt(ch.t, arr, px2x(hoverX));
          ctx.fillStyle = SERIES_COLORS[si % SERIES_COLORS.length];
          ctx.beginPath();
          ctx.arc(x, y2px(key, v), 2.6, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
  }

  // rAF paint pump: only repaints when something changed or the clock is running
  let paintRaf = 0;
  let lastT = -1;
  function pump() {
    if (disposed) return;
    if (dirty || timeline.t !== lastT) {
      lastT = timeline.t;
      dirty = false;
      draw();
    }
    paintRaf = requestAnimationFrame(pump);
  }

  // ---------- interaction ----------
  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    hoverX = px;
    dirty = true;
    const ch = data[channel];
    if (!ch || !ch.t || px < padL || px > w - padR) {
      readout.hidden = true;
      return;
    }
    const t = px2x(px);
    // Built as nodes, not markup: labels and units come from the robot def, and a generated def
    // is untrusted text. Same elements, same order, same classes as the old template.
    readout.textContent = '';
    const tEl = document.createElement('span');
    tEl.className = 'ro-t';
    tEl.textContent = `${t.toFixed(2)} s`;
    readout.appendChild(tEl);
    fields.forEach((key, si) => {
      const arr = ch[key];
      if (!arr) return;
      const fd = fieldDef(key) || {};
      const row = document.createElement('span');
      row.className = 'ro-row';
      const swatch = document.createElement('i');
      swatch.style.background = SERIES_COLORS[si % SERIES_COLORS.length];
      row.appendChild(swatch);
      row.appendChild(document.createTextNode(`${fd.label || key} `));
      const val = document.createElement('b');
      val.textContent = fmt(sampleAt(ch.t, arr, t));
      row.appendChild(val);
      const em = document.createElement('em');
      em.textContent = fd.unit || '';
      row.appendChild(em);
      readout.appendChild(row);
    });
    readout.hidden = false;
    const left = clamp(px + 14, 8, Math.max(w - 190, 8));
    readout.style.left = left + 'px';
  }

  function onLeave() {
    hoverX = null;
    readout.hidden = true;
    dirty = true;
  }

  function onClick(e) {
    const r = canvas.getBoundingClientRect();
    const px = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - r.left;
    if (px < padL || px > w - padR) return;
    timeline.seek(clamp(px2x(px), 0, duration));
    // Raised only on the path that really seeks, i.e. never for a click in the padded axis
    // gutters, which the guard above drops. signup.js listens for this instead of a bare canvas
    // click so it cannot arm off a click the chart itself ignored. Seek behaviour is unchanged:
    // this is a notification after the fact and nothing in this module listens to it.
    canvas.dispatchEvent(new CustomEvent('chart:seek'));
  }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);

  const offTick = timeline.onTick(() => {
    dirty = true;
  });

  renderChanChips();
  renderFieldChips();
  resize();
  pump();

  return {
    el,
    canvas,
    focus,
    resetZoom,
    setChannel,
    get domain() {
      return [domain[0], domain[1]];
    },
    get targetDomain() {
      return [targetDomain[0], targetDomain[1]];
    },
    get channel() {
      return channel;
    },
    get fields() {
      return fields.slice();
    },
    redraw() {
      dirty = true;
    },
    dispose() {
      disposed = true;
      if (anim) cancelAnimationFrame(anim);
      if (paintRaf) cancelAnimationFrame(paintRaf);
      ro.disconnect();
      offTick();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
