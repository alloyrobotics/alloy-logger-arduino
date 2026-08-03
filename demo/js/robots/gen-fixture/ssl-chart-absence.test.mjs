// ssl-chart-absence.test.mjs - a tracking absence is a gap in the plot, not a reading of zero.
//
//   node demo/js/robots/gen-fixture/ssl-chart-absence.test.mjs
//
// `/bot13/vision` `visibility` is real tracker confidence, and for 72.9 % of the window the robot
// is in NO TRACKED FRAME. The export writes a zero there and the producer marks it: the channel
// block carries a `present` mask and the field def says so. The chart read neither. It plotted the
// filler zeros as a flat line on the floor, the crosshair put a dot on that line and the readout
// printed "0.000" - three separate statements that the venue's cameras measured zero confidence,
// when what happened is that nothing was measured at all. The analyst pack said the same thing in
// its tables while the prose above them explained that it should not.
//
// The contract: a field may declare `mask: '<key>'`, naming a 0/1 array on its own channel block.
// The tests below drive both halves of it -
//
//   * on a masked field: the trace BREAKS across the absence, the crosshair draws no dot there,
//     and the readout says "absent" with no unit after it;
//   * at the EDGE of an absence: a reading needs BOTH bracketing samples, because the value is
//     interpolated between them. `detections` carries a second, different mask (the cross-check's
//     per-bin coverage), so both boundary directions are real data on this one channel;
//   * on every other robot and channel: nothing changes at all. sbr is the regression case, and it
//     is checked positively (its trace is continuous, its readout is numeric everywhere).
//
// Pixels, not internals, for the trace itself: the whole failure was something the visitor could
// see, so the assertion reads the canvas the visitor is looking at.

import { serve, loadPlaywright, launchChromium, harness, waitFor } from './browser-fixture.mjs';

const H = harness('ssl-chart-absence');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const server = await serve();
const browser = await launchChromium(pw);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => localStorage.setItem('alloy_demo_role', 'engineer'));

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${server.origin}/demo/`, { waitUntil: 'domcontentloaded' });

/**
 * Tap through the guided walk, if this mission has one, until it hands over.
 *
 * sbr, ssl and battle enter CHAT ONLY: js/core/guide.js brings the chart on at beat 2 and the 3D
 * stage at beat 3, each on the visitor's own tap. Every assertion in this file is about the plot a
 * visitor is looking at, so the walk has to reach its handover first - that full layout is the
 * state this test was always describing, it just used to be the state the demo opened in.
 *
 * @returns {Promise<boolean>} whether the layout is settled (true immediately when not guided)
 */
async function settleGuide() {
  if (!(await page.evaluate(() => !!(window.__demo && window.__demo.guide)))) return true;
  // a beat per iteration, plus slack; the loop exits on `settled`, never on the count
  for (let i = 0; i < 8; i++) {
    const ready = await waitFor(
      page,
      () => {
        const d = window.__demo;
        const g = d && d.guide;
        if (d && d.chat && d.chat.streaming) d.chat.finishStreaming();
        return !!g && (g.settled || document.querySelectorAll('.guide-cta:not(:disabled)').length > 0);
      },
      30000,
      'the next guided beat',
    );
    if (!ready) return false;
    if (await page.evaluate(() => window.__demo.guide.settled)) return true;
    await page.click('.guide-cta:not(:disabled)');
  }
  return await page.evaluate(() => !!(window.__demo.guide && window.__demo.guide.settled));
}

/** Open a robot's demo screen with its chart panel expanded, and wait for the first paint. */
async function openChart(robot, channel, fields) {
  await page.evaluate((id) => { location.hash = `#/demo/${id}`; }, robot);
  const up = await waitFor(
    page,
    () => !!window.__demo && !!document.querySelector('.chart-canvas') && document.body.dataset.screen === 'demo',
    25000,
    `the ${robot} chart`,
  );
  if (!up) return false;
  if (!(await settleGuide())) return false;
  await page.evaluate(
    ([ch, fs]) => {
      const d = window.__demo;
      d.timeline.pause();
      d.timeline.seek(0);
      d.setChartOpen(true);
      if (ch) d.chart.setChannel(ch, fs);
      d.chart.resetZoom();
    },
    [channel, fields],
  );
  // resetZoom animates the domain over 420 ms; the pixel reads have to be after it settles
  await page.waitForTimeout(900);
  return true;
}

/**
 * Is any pixel in the canvas column at time `t` painted in the first series colour?
 *
 * The trace is the only thing drawn in `#2f78ff`... except the playhead, which is the same blue by
 * design, so the timeline is parked at 0 and the columns probed are nowhere near it. Sampling a
 * 21 px band absorbs line occlusion, antialiasing and fractional x placement without reaching a gap edge.
 */
const traceAt = (t) =>
  page.evaluate((tt) => {
    const d = window.__demo;
    const canvas = document.querySelector('.chart-canvas');
    const c = canvas.getContext('2d');
    const dpr = canvas.width / canvas.clientWidth;
    // The gutters are measured per frame off the real tick labels, so the mapping has to come from
    // the chart rather than from a guess at the padding constant.
    const p = d.chart.plot;
    const [d0, d1] = d.chart.domain;
    const x = Math.round((p.left + ((tt - d0) / (d1 - d0)) * (p.right - p.left)) * dpr);
    const img = c.getImageData(Math.max(0, x - 10), 0, 21, canvas.height).data;
    let hits = 0;
    for (let i = 0; i < img.length; i += 4) {
      // #2f78ff with a tolerance for the line's antialiased edges
      if (Math.abs(img[i] - 0x2f) < 40 && Math.abs(img[i + 1] - 0x78) < 40 && img[i + 2] > 0xb0) hits++;
    }
    return hits;
  }, t);

async function waitForTrace(t, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let hits = 0;
  do {
    hits = await traceAt(t);
    if (hits > 0) return hits;
    await page.waitForTimeout(40);
  } while (Date.now() < deadline);
  return hits;
}

/** Hover the canvas at time `t` and read back what the readout says. */
const readoutAt = (t) =>
  page.evaluate((tt) => {
    const d = window.__demo;
    const canvas = document.querySelector('.chart-canvas');
    const r = canvas.getBoundingClientRect();
    const p = d.chart.plot;
    const [d0, d1] = d.chart.domain;
    const x = p.left + ((tt - d0) / (d1 - d0)) * (p.right - p.left);
    canvas.dispatchEvent(
      new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + r.height / 2, bubbles: true }),
    );
    const ro = document.querySelector('.chart-readout');
    return {
      hidden: ro.hidden,
      rows: [...ro.querySelectorAll('.ro-row')].map((row) => ({
        text: (row.textContent || '').replace(/\s+/g, ' ').trim(),
        value: (row.querySelector('b').textContent || '').trim(),
        unit: (row.querySelector('em').textContent || '').trim(),
        absentClass: row.querySelector('b').classList.contains('ro-absent'),
      })),
    };
  }, t);

// ---------------------------------------------------------------- the masked field

H.section('the masked field');
{
  H.ok(await openChart('ssl', '/bot13/vision', ['visibility']), 'the SSL demo mounts with /bot13/vision charted');

  const wired = await page.evaluate(() => {
    const d = window.__demo;
    const ch = d.def.channels.find((c) => c.path === '/bot13/vision');
    const vis = ch.fields.find((f) => f.key === 'visibility');
    const det = ch.fields.find((f) => f.key === 'detections');
    const block = d.def.data['/bot13/vision'];
    const m = (vis.mask && block[vis.mask]) || null;
    const dm = (det.mask && block[det.mask]) || null;
    let present = 0;
    if (m) for (let i = 0; i < m.length; i++) present += m[i] ? 1 : 0;
    let detPresent = 0;
    if (dm) for (let i = 0; i < dm.length; i++) detPresent += dm[i] ? 1 : 0;
    return {
      mask: vis.mask || null,
      detMask: det.mask || null,
      n: m ? m.length : 0,
      present,
      detPresent,
    };
  });
  H.ok(wired.mask === 'present', `visibility declares its presence mask ("${wired.mask}")`);
  H.ok(
    wired.detMask === 'detectionsPresent',
    `detections declares its own, different mask ("${wired.detMask}")`,
  );
  H.ok(
    wired.present > 0 && wired.present < wired.n,
    `the mask has both halves in it (${wired.present} readings of ${wired.n} samples)`,
  );
  H.ok(
    wired.detPresent > 0 && wired.detPresent < wired.n && wired.detPresent !== wired.present,
    `and so does the coverage mask, disagreeing with the presence one (${wired.detPresent} covered of ${wired.n})`,
  );
}

H.section('the trace breaks across the absence');
{
  // 25 s: tracked below the plot ceiling. 60 s and 100 s: long after the last tracked sample at 29.70 s.
  const live = await waitForTrace(25);
  const gap60 = await traceAt(60);
  const gap100 = await traceAt(100);
  H.ok(live > 0, `the trace is drawn where the tracker had the robot (${live} px at 25 s)`);
  H.ok(gap60 === 0, `and NOT drawn inside the absence (${gap60} px at 60 s)`);
  H.ok(gap100 === 0, `still nothing at the end of the window (${gap100} px at 100 s)`);
}

H.section('the readout says absent, not a number');
{
  const live = await readoutAt(10);
  H.ok(!live.hidden && live.rows.length === 1, `the readout is up over a tracked sample (${live.rows.length} row)`);
  H.ok(
    live.rows.length === 1 && /^[\d.]+$/.test(live.rows[0].value),
    `and reads a number there ("${live.rows[0] && live.rows[0].value}")`,
  );

  const gap = await readoutAt(60);
  H.ok(!gap.hidden && gap.rows.length === 1, 'the readout is still up inside the absence');
  H.ok(
    gap.rows.length === 1 && gap.rows[0].value === 'absent',
    `and says absent rather than a value ("${gap.rows[0] && gap.rows[0].value}")`,
  );
  H.ok(
    gap.rows.length === 1 && gap.rows[0].unit === '',
    `with no unit after it, because there is no quantity ("${gap.rows[0] && gap.rows[0].unit}")`,
  );
  H.ok(gap.rows.length === 1 && gap.rows[0].absentClass, 'and it is styled as absent, not as a reading');
}

H.section('the second mask on the same channel');
{
  await page.evaluate(() => window.__demo.chart.setChannel('/bot13/vision', ['detections']));
  await page.waitForTimeout(200);
  const live = await readoutAt(10);
  H.ok(
    live.rows.length === 1 && /^[\d.]+$/.test(live.rows[0].value),
    `detections reads a number where the cross-check covers the bin ("${live.rows[0] && live.rows[0].value}" at 10 s)`,
  );
  const gap = await readoutAt(60);
  H.ok(
    gap.rows.length === 1 && gap.rows[0].value === 'absent',
    `and absent where it holds no count at all ("${gap.rows[0] && gap.rows[0].value}" at 60 s)`,
  );
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
}

// ---------------------------------------------------------------- the boundary
//
// The masking test above probes DEEP inside a gap, where the sample at the cursor and the one after
// it are both absent and any rule at all gets the answer right. The rule was wrong at the EDGE:
// hover masking looked only at the sample at-or-before the cursor while the value came from
// `sampleAt`, which interpolates through the sample AFTER it whatever its mask says. Between bot
// 13's last tracked sample at 29.6999 s (3/255) and the first absent one at 29.77494 s the readout
// therefore averaged a measurement with an absence marker and printed 1.5/255 - a confidence no
// camera ever reported. Both probes below sit inside a single 75 ms sample interval, so the chart
// is zoomed to the finding's own window first (0.01 s per pixel) rather than the whole 110 s.

H.section('a masked readout never interpolates across the boundary');
{
  await page.evaluate(() => {
    const d = window.__demo;
    // focus() zooms to the finding's window AND selects the fields the finding focuses (both of
    // them), so the single-field selection has to come after it or the readout carries two rows.
    d.chart.focus(d.def.findings.find((f) => f.id === 'vision-confidence'));
    d.chart.setChannel('/bot13/vision', ['visibility']);
  });
  await page.waitForTimeout(900);

  // present -> absent, at the real boundary
  const inside = await readoutAt(29.66);
  const across = await readoutAt(29.7374);
  const beyond = await readoutAt(29.81);
  H.ok(
    inside.rows.length === 1 && /^[\d.]+$/.test(inside.rows[0].value),
    `between two tracked samples it still reads a number ("${inside.rows[0] && inside.rows[0].value}" at 29.66 s)`,
  );
  H.ok(
    across.rows.length === 1 && across.rows[0].value === 'absent',
    `between the last tracked sample and the first absent one it says absent, not 1.5/255 ("${across.rows[0] && across.rows[0].value}" at 29.74 s)`,
  );
  H.ok(across.rows.length === 1 && across.rows[0].absentClass, 'and is styled as absent there too');
  H.ok(
    beyond.rows.length === 1 && beyond.rows[0].value === 'absent',
    `and stays absent past it ("${beyond.rows[0] && beyond.rows[0].value}" at 29.81 s)`,
  );

  // absent -> present, the other direction and the other mask: the cross-check holds no count for
  // the bin at 27.25 s and does hold one for the bin at 27.5 s, so 27.487 s brackets an absence
  // with a reading. This direction was already right - the sample at-or-before the cursor is the
  // absent one - and it is asserted so that "both bracketing samples must be present" cannot be
  // implemented as "either of them" and still pass.
  await page.evaluate(() => window.__demo.chart.setChannel('/bot13/vision', ['detections']));
  await page.waitForTimeout(200);
  const rising = await readoutAt(27.4874);
  const covered = await readoutAt(27.6);
  H.ok(
    rising.rows.length === 1 && rising.rows[0].value === 'absent',
    `an uncovered sample followed by a covered one reads absent, not half of the covered count ("${rising.rows[0] && rising.rows[0].value}" at 27.49 s)`,
  );
  H.ok(
    covered.rows.length === 1 && /^[\d.]+$/.test(covered.rows[0].value),
    `and the covered interval after it reads its count ("${covered.rows[0] && covered.rows[0].value}" at 27.60 s)`,
  );
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  await page.evaluate(() => window.__demo.chart.resetZoom());
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------- the regression case

H.section('sbr: the mask contract is inert');
{
  H.ok(await openChart('sbr', '/balance', ['pitch']), 'the sbr demo mounts with its pitch charted');
  const declared = await page.evaluate(() =>
    window.__demo.def.channels.flatMap((c) => c.fields.filter((f) => f.mask).map((f) => `${c.path}.${f.key}`)),
  );
  H.ok(declared.length === 0, `no sbr field declares a mask (${declared.join(', ') || 'none'})`);

  const duration = await page.evaluate(() => window.__demo.def.duration);
  const probes = [0.25, 0.4, 0.6, 0.8].map((k) => Number((duration * k).toFixed(2)));
  const drawn = [];
  for (const t of probes) drawn.push(await waitForTrace(t));
  H.ok(
    drawn.every((n) => n > 0),
    `its trace is continuous across the mission (${probes.map((t, i) => `${t}s:${drawn[i]}px`).join(' ')})`,
  );

  const rows = [];
  for (const t of probes) rows.push(await readoutAt(t));
  const values = rows.flatMap((r) => r.rows.map((x) => x.value));
  H.ok(values.length > 0, `the readout reports every selected field (${values.length} values)`);
  H.ok(
    values.every((v) => /^-?[\d.,]+$/.test(v)),
    `and every one of them is a number, never "absent" (${values.slice(0, 4).join(', ')})`,
  );
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
}

await ctx.close();
await browser.close();
await server.close();
H.done();
