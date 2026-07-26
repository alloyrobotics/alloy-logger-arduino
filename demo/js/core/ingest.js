// ingest.js - the faux connect sequence between picker and demo. A mono terminal card that
// streams plausible upload lines derived from the robot's ACTUAL channel row counts, ~2.5 s total,
// then auto-advances. Skippable.

/**
 * Build the line script from real row counts.
 * @param {object} robotDef with `.data` attached
 */
export function ingestLines(robotDef) {
  const data = robotDef.data || {};
  const rows = {};
  let total = 0;
  robotDef.channels.forEach((c) => {
    const ch = data[c.path];
    const n = ch && ch.t ? ch.t.length : 0;
    rows[c.path] = n;
    total += n * c.fields.length;
  });

  const bytes = Math.round(total * 4.7);
  const kb = (bytes / 1024).toFixed(1);
  const chunks = Math.max(2, Math.round(bytes / 16384));

  const lines = [
    { text: `alloy.begin(key, "robots/${robotDef.id}")`, cls: 'cmd' },
    { text: `wifi link up · device ${robotDef.id}-01 · rssi -58 dBm`, cls: 'dim' },
    { text: `handshake ok · mission ${robotDef.id}-01 open`, cls: 'ok' },
  ];

  // Rate is measured off the channel's own timestamps, not assumed from robotDef.rate: sub-rate
  // channels (/sys is a tenth of the control loop) were being announced at the control rate, on
  // the one screen whose job is to establish that these are real logs.
  const rateOf = (path) => {
    const ch = data[path];
    if (!ch || !ch.t || ch.t.length < 2) return robotDef.rate;
    const span = ch.t[ch.t.length - 1] - ch.t[0];
    if (!(span > 0)) return robotDef.rate;
    return Math.round((ch.t.length - 1) / span);
  };

  robotDef.channels.forEach((c) => {
    lines.push({
      text: `describe ${c.path} · ${c.fields.length} fields · ${rateOf(c.path)} Hz`,
      cls: 'dim',
    });
  });

  lines.push({ text: `POST /v1/chunk 202 (${(bytes / chunks / 1024).toFixed(1)} KB)`, cls: 'cmd' });
  lines.push({ text: `POST /v1/chunk 202 · ${chunks} chunks · ${kb} KB total`, cls: 'cmd' });

  robotDef.channels.forEach((c) => {
    const table = `alloy.fleet.${c.path.replace(/^\//, '').replace(/\W+/g, '_')}`;
    lines.push({ text: `mesh table ${table} +${rows[c.path].toLocaleString('en-US')} rows`, cls: 'ok' });
  });

  lines.push({ text: `alloy.end() · ${robotDef.duration.toFixed(1)} s of telemetry`, cls: 'cmd' });
  lines.push({ text: `mission finalized -> ${robotDef.id}-01.mcap`, cls: 'ok' });
  lines.push({ text: `analyst context ready`, cls: 'ok' });

  return lines;
}

/**
 * @param {HTMLElement} mount
 * @param {object} robotDef with `.data` attached
 * @param {{ onDone?: ()=>void, total?: number }} opts
 * @returns {{ el:HTMLElement, skip:()=>void, dispose:()=>void }}
 */
export function createIngest(mount, robotDef, opts = {}) {
  const onDone = opts.onDone || (() => {});
  const totalMs = opts.total != null ? opts.total : 2500;
  const lines = ingestLines(robotDef);

  const el = document.createElement('div');
  el.className = 'ingest';
  el.innerHTML = `
    <div class="ing-card">
      <div class="ing-top">
        <span class="ing-dots"><i></i><i></i><i></i></span>
        <span class="ing-title mono">alloy stream · ${robotDef.id}-01</span>
        <button class="ing-skip mono" type="button">skip</button>
      </div>
      <div class="ing-body mono" role="log" aria-live="polite"></div>
      <div class="ing-bar"><span></span></div>
    </div>
    <div class="ing-cap">Streaming this mission into Alloy. Nothing leaves your browser, this demo is fully local.</div>`;
  mount.appendChild(el);

  const body = el.querySelector('.ing-body');
  const bar = el.querySelector('.ing-bar span');
  const skipBtn = el.querySelector('.ing-skip');

  let i = 0;
  let timer = 0;
  let done = false;
  const per = Math.max(totalMs / lines.length, 40);

  function push() {
    if (done) return;
    if (i >= lines.length) {
      finish();
      return;
    }
    const l = lines[i++];
    const row = document.createElement('div');
    row.className = 'ing-line ' + l.cls;
    row.innerHTML = `<span class="ing-arrow">${l.cls === 'cmd' ? '$' : l.cls === 'ok' ? '✓' : '·'}</span><span></span>`;
    row.lastElementChild.textContent = l.text;
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
    bar.style.width = (i / lines.length) * 100 + '%';
    timer = window.setTimeout(push, per);
  }

  function finish() {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    bar.style.width = '100%';
    window.setTimeout(() => {
      if (!el.isConnected) return;
      onDone();
    }, 180);
  }

  function skip() {
    if (done) return;
    window.clearTimeout(timer);
    while (i < lines.length) {
      const l = lines[i++];
      const row = document.createElement('div');
      row.className = 'ing-line ' + l.cls;
      row.innerHTML = `<span class="ing-arrow">${l.cls === 'cmd' ? '$' : l.cls === 'ok' ? '✓' : '·'}</span><span></span>`;
      row.lastElementChild.textContent = l.text;
      body.appendChild(row);
    }
    body.scrollTop = body.scrollHeight;
    finish();
  }

  skipBtn.addEventListener('click', skip);
  timer = window.setTimeout(push, 120);

  return {
    el,
    skip,
    dispose() {
      done = true;
      window.clearTimeout(timer);
      el.remove();
    },
  };
}
