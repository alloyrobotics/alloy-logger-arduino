// flow-walk.test.mjs - the approved three-step flow into the chat surface.
//
// ROUND 3 changed both halves of this walk. The connect flow lost its fourth step (the three
// debug-comparison cards): the failure step now hands straight to the demo. And the demo screen
// lost its layout modes: chat, proof and follow-up collapsed into ONE transcript, because an
// evidence-bearing answer now carries its own annotated chart, its causal line and its live 3D
// replay INSIDE the message (core/embeds.js). So the assertions that used to be about which panel
// was on screen are now about what is inside the answer.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, loadPlaywright, launchChromium, harness, waitFor, ROOT } from './browser-fixture.mjs';
import { getFlowCopy } from '../../core/flow-copy.js';

const H = harness('flow-walk');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const MISSIONS = ['arm6', 'drone', 'ssl', 'donna'];
const ROLES = ['hobbyist', 'engineer', 'lead', 'marketing'];
/**
 * ROUND 5 SPLIT THESE IN TWO, and the split is the assertion.
 *
 * `window` is what the CHART plots and shades: unchanged, because the trace needs its context (ssl's
 * sawtooth is only visibly short of 240 V across the whole live stretch). `loop` is what the 3D
 * REPLAY plays on a lap: roughly half a second of healthy motion, the failure, half a second of the
 * settled fail state, which is the retime Hugh asked for after the round-4 walkthrough - every
 * mission was looping its chart window, so ssl ran 41 wall-clock seconds a lap and arm6 ran 20.
 *
 * `wall` is the lap in seconds a visitor actually waits: the loop's span over the finding's speed
 * (0.4 where it declares `slowmo`). It is asserted with the loop, because the whole point of the
 * round is a duration a person sits through and a window alone does not say what that is.
 */
const EXPECTED_FAILURE = {
  arm6: {
    id: 'drop',
    window: [52, 60],
    loop: [55.8, 57.3],
    wall: 3.75,
    channel: '/joints',
    fields: ['tau2', 'tau1', 'tau3'],
  },
  drone: {
    id: 'dip',
    window: [58, 66],
    loop: [60.7, 62.9],
    wall: 2.2,
    channel: '/pos',
    fields: ['alt'],
  },
  ssl: {
    id: 'kicker-charge',
    window: [46.3376, 62.74],
    loop: [53.477, 54.627],
    wall: 2.875,
    channel: '/bot8/kicker',
    fields: ['kickerLevel', 'kickerMax'],
  },
  donna: {
    id: 'jack-falls-foul-line',
    window: [145.878, 150.147],
    loop: [145.378, 147.398],
    wall: 2.02,
    channel: '/imu',
    fields: ['accelMagMps2', 'pitchDeg', 'rollDeg'],
  },
};

/** The wall-clock lap every public mission's failure replay has to stay inside. */
const LAP_MAX_S = 4.0;
const GEN_ID = 'g-aaaaaaaaaaaaaaaaaaaa';
const GEN_DEF = await readFile(path.join(ROOT, 'demo', 'js', 'robots', 'gen-fixture', 'def.json'), 'utf8');

const server = await serve();
const browser = await launchChromium(pw);

function closeEnough(a, b, eps = 0.03) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= eps);
}

async function waitForArg(page, fn, arg, timeoutMs = 12000, label = '') {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await page.evaluate(fn, arg);
    } catch (_) {
      value = false;
    }
    if (value) return true;
    if (Date.now() - started > timeoutMs) {
      if (label) console.error(`    (timed out waiting for ${label})`);
      return false;
    }
    await page.waitForTimeout(40);
  }
}

function consoleTape(page) {
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('crash', () => errors.push('page crashed'));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  return { errors, consoleErrors };
}

async function newPage(viewport, { role = null, reducedMotion = false, noWebgl = false } = {}) {
  const ctx = await browser.newContext({ viewport });
  const now = Date.now();
  await ctx.addInitScript(
    ({ storedRole, seenAt, disableWebgl }) => {
      localStorage.setItem('alloy_signup_seen', String(seenAt));
      sessionStorage.clear();
      if (storedRole) localStorage.setItem('alloy_demo_role', storedRole);
      else localStorage.removeItem('alloy_demo_role');
      if (disableWebgl) {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (/webgl/i.test(String(type))) return null;
          return getContext.call(this, type, ...args);
        };
      }
    },
    { storedRole: role, seenAt: now, disableWebgl: noWebgl },
  );
  const page = await ctx.newPage();
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/demo/api/chat', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      body: 'data: {"type":"delta","text":"The follow-up is ready."}\n\ndata: {"type":"done","evidence":[]}\n\n',
    }),
  );
  const tape = consoleTape(page);
  return { ctx, page, tape };
}

async function go(page, hash, screen, timeout = 30000) {
  await page.evaluate((next) => { location.hash = next; }, hash);
  return waitForArg(
    page,
    (expected) => document.body.dataset.screen === expected,
    screen,
    timeout,
    `${screen} screen`,
  );
}

async function waitStep(page, mission, step, timeout = 30000) {
  return waitForArg(
    page,
    ([id, expected]) =>
      document.body.dataset.screen === 'flow' &&
      location.hash === `#/connect/${id}/${expected}` &&
      !!window.__flow && window.__flow.def.id === id && window.__flow.step === expected,
    [mission, step],
    timeout,
    `${mission}/${step}`,
  );
}

async function primaryCount(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#screen-flow:not([hidden]) #flow-cta')];
    return buttons.filter((button) => {
      const style = getComputedStyle(button);
      return !button.disabled && style.display !== 'none' && style.visibility !== 'hidden';
    }).length;
  });
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  H.ok(overflow.doc <= 1 && overflow.body <= 1, `${label} has no horizontal overflow (${overflow.doc}/${overflow.body}px)`);
}

async function assertMissionStep(page, mission, expectedCopy, mobileLabel = '') {
  H.ok(await waitStep(page, mission, 'mission'), `${mission} mission step renders`);
  H.ok((await primaryCount(page)) === 1, `${mission} mission step has one primary CTA`);
  const state = await page.evaluate(() => {
    const visible = (selector) => [...document.querySelectorAll(selector)].some((el) => {
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    });
    return {
      intro: (document.getElementById('flow-intro').textContent || '').trim(),
      evidenceClass: [...document.querySelectorAll('.evidence-on')].filter((el) => {
        const style = getComputedStyle(el);
        return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
      }).length,
      banner: visible('#flow-viewer-mount .v-banner'),
      context: visible('#flow-context'),
      chart: !!document.querySelector('#flow-chart-mount .chart-canvas'),
      loop: window.__flow.timeline.loopWindow,
    };
  });
  H.ok(state.intro === expectedCopy.missionIntro, `${mission} mission intro matches the selected role variant`);
  H.ok(state.evidenceClass === 0, `${mission} success step has no evidence-on failure state`);
  H.ok(!state.banner, `${mission} success step has no overlay chip or finding banner`);
  H.ok(
    state.context === (mission !== 'ssl'),
    `${mission} success step ${mission === 'ssl' ? 'removes' : 'keeps'} its contextual-label block`,
  );
  H.ok(!state.chart, `${mission} success step has no failure chart or alert shading`);
  H.ok(Array.isArray(state.loop), `${mission} success step loops its healthy passage`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} mission step`);
}

async function assertFailureStep(page, mission, expectedCopy, mobileLabel = '') {
  H.ok(await go(page, `#/connect/${mission}/failure`, 'flow'), `${mission} failure route is reachable`);
  H.ok(await waitStep(page, mission, 'failure'), `${mission} failure step renders`);
  H.ok((await primaryCount(page)) === 1, `${mission} failure step has one primary CTA`);
  const expected = EXPECTED_FAILURE[mission];
  const state = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const chart = window.__flow.chart;
    return {
      intro: (document.getElementById('flow-intro').textContent || '').trim(),
      loop: window.__flow.timeline.loopWindow,
      speed: window.__flow.timeline.speed,
      // Resolved the same way flow.js resolves it: the named finding, else the alert one.
      findingWindow: (() => {
        const def = window.__flow.def;
        const id = def.experience && def.experience.failure && def.experience.failure.findingId;
        const list = def.findings || [];
        const f = list.find((x) => x.id === id) || list.find((x) => x.severity === 'alert') || {};
        return f.window;
      })(),
      channel: chart && chart.channel,
      fields: chart && chart.fields,
      minimal: !!document.querySelector('#flow-chart-mount .chart.chart-minimal'),
      headerVisible: isVisible(document.querySelector('#screen-flow .flow-head')),
      provenanceVisible: isVisible(document.getElementById('flow-provenance')),
      timestampVisible: isVisible(document.querySelector('#flow-viewer-mount .v-time')),
      chartBarVisible: isVisible(document.querySelector('#flow-chart-mount .chart-bar')),
      fieldChipsVisible: isVisible(document.querySelector('#flow-chart-mount .field-chips')),
      readoutVisible: isVisible(document.querySelector('#flow-chart-mount .chart-readout')),
      canvas: !!document.querySelector('#flow-chart-mount .chart-canvas'),
    };
  });
  H.ok(state.intro === expectedCopy.failureIntro, `${mission} failure intro matches the selected role variant`);
  H.ok(closeEnough(state.loop, expected.loop), `${mission} failure replay loops the tight ${expected.loop.join('..')} s (${JSON.stringify(state.loop)})`);
  H.ok(
    closeEnough(state.findingWindow, expected.window),
    `${mission} failure chart keeps its wider ${expected.window.join('..')} s context window (${JSON.stringify(state.findingWindow)})`,
  );
  const lap = Array.isArray(state.loop) ? (state.loop[1] - state.loop[0]) / (state.speed || 1) : Infinity;
  H.ok(
    Math.abs(lap - expected.wall) <= 0.1 && lap <= LAP_MAX_S,
    `${mission} failure replay laps in ${lap.toFixed(2)} s of wall clock at ${state.speed}x (expected ${expected.wall}, cap ${LAP_MAX_S})`,
  );
  H.ok(state.channel === expected.channel, `${mission} failure chart selects ${expected.channel} (${state.channel})`);
  H.ok(JSON.stringify(state.fields) === JSON.stringify(expected.fields), `${mission} direct-label fields match the experience (${(state.fields || []).join(', ')})`);
  H.ok(state.canvas && state.minimal, `${mission} failure chart is present in direct-label minimal mode`);
  H.ok(
    state.headerVisible === (mission !== 'ssl'),
    `${mission} failure step ${mission === 'ssl' ? 'removes' : 'keeps'} the top progress header`,
  );
  H.ok(
    state.provenanceVisible === (mission === 'donna'),
    `${mission} failure step ${mission === 'ssl' ? 'removes' : mission === 'donna' ? 'keeps' : 'does not invent'} the bottom provenance block`,
  );
  H.ok(!state.timestampVisible, `${mission} failure step hides the replay timestamp`);
  H.ok(!state.chartBarVisible && !state.fieldChipsVisible && !state.readoutVisible, `${mission} failure step hides generic chart summary controls`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} failure step`);
}

/**
 * The retired fourth step. It is asserted as GONE rather than deleted from this walk, because a
 * hash that used to exist and now silently 404s to the picker is a worse regression than the step
 * itself was: real sessions have it in their history.
 */
async function assertChooseRetired(page, mission) {
  H.ok(
    !(await page.evaluate(() => !!document.getElementById('flow-debug'))),
    `${mission} flow has no debug-comparison step markup`,
  );
  await page.evaluate((id) => { location.hash = `#/connect/${id}/choose`; }, mission);
  const landed = await waitForArg(
    page,
    (id) => document.body.dataset.screen === 'demo' && location.hash === `#/demo/${id}` && !window.__flow,
    mission,
    30000,
    `${mission} choose redirect`,
  );
  H.ok(landed, `${mission} retired choose hash redirects into the demo`);
}

async function finishAnswer(page, userCount, timeout = 30000) {
  const userUp = await waitForArg(
    page,
    (count) => document.querySelectorAll('.msg.user .bubble').length >= count,
    userCount,
    timeout,
    `user message ${userCount}`,
  );
  if (!userUp) return false;
  const streaming = await waitFor(
    page,
    () => !!window.__demo && !!window.__demo.chat && window.__demo.chat.streaming,
    timeout,
    'the scripted typewriter',
  );
  if (streaming) await page.evaluate(() => window.__demo.chat.finishStreaming());
  return waitForArg(
    page,
    (count) => document.querySelectorAll('.msg.bot .bot-body').length >= count && !window.__demo.chat.streaming,
    userCount,
    timeout,
    `settled answer ${userCount}`,
  );
}

async function completeDemo(page, mission, expectedCopy, mobileLabel = '') {
  await page.click('#screen-flow:not([hidden]) #flow-cta');
  const demoMounted = await waitFor(page, () => document.body.dataset.screen === 'demo' && !!window.__demo, 40000, `${mission} demo`);
  H.ok(demoMounted, `${mission} failure CTA opens the demo directly`);
  if (!demoMounted) return false;
  const entry = await page.evaluate(() => {
    window.__flowProofTimeline = window.__demo.timeline;
    return {
      mode: document.getElementById('screen-demo').dataset.mode,
      timeline: !!window.__demo.timeline,
      fixedPanes: !!document.getElementById('chart-panel') || !!document.querySelector('.right-col'),
    };
  });
  H.ok(entry.mode === 'chat' && entry.timeline, `${mission} enters the chat surface with one timeline`);
  H.ok(!entry.fixedPanes, `${mission} demo screen has no fixed viewer or chart pane left`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} chat surface`);

  H.ok(await finishAnswer(page, 1), `${mission} first answer settles`);
  H.ok(
    await waitFor(page, () => document.querySelectorAll('.ev-embed').length === 1, 20000, `${mission} inline evidence block`),
    `${mission} first answer carries its evidence inside the message`,
  );
  // The block takes the shared context on a queued frame, so the assertions below wait for the
  // handover rather than racing it.
  await waitFor(
    page,
    () => !!document.querySelector('.ev-embed .chart-canvas') && !!document.querySelector('.ev-embed.is-live .v-canvas'),
    20000,
    `${mission} live inline block`,
  );
  const block = await page.evaluate(() => {
    const b = document.querySelector('.ev-embed');
    const row = b.closest('.msg.bot');
    return {
      question: (document.querySelector('.msg.user .bubble').textContent || '').trim(),
      placeholder: document.querySelector('.chat-input').getAttribute('placeholder'),
      sameTimeline: window.__demo.timeline === window.__flowProofTimeline,
      loop: window.__demo.timeline.loopWindow,
      insideAnswer: !!row && row.contains(b),
      chart: !!b.querySelector('.chart-canvas'),
      note: (b.querySelector('.ev-embed-note').textContent || '').trim().length,
      replay: !!b.querySelector('.v-canvas'),
      live: b.classList.contains('is-live'),
      contexts: document.querySelectorAll('canvas.v-canvas').length,
      chipRow: !!b.closest('.msg.bot').querySelector('.ev-row'),
    };
  });
  H.ok(block.question === expectedCopy.firstQuestion, `${mission} chat asks the selected role's first question ("${block.question}")`);
  H.ok(block.placeholder === expectedCopy.followUp, `${mission} composer carries the selected role's follow-up`);
  H.ok(block.sameTimeline, `${mission} the block and the transcript share the same TimelineStore instance`);
  H.ok(Array.isArray(block.loop), `${mission} the live block holds its finding's loop on the shared clock`);
  H.ok(block.insideAnswer, `${mission} the evidence block is a child of the answer that cited it`);
  H.ok(block.chart && block.replay && block.live, `${mission} the block plots the finding and holds the live replay`);
  H.ok(block.note > 40, `${mission} the block states the causal line (${block.note} chars)`);
  H.ok(block.contexts === 1, `${mission} exactly one WebGL replay exists on the page (${block.contexts})`);
  H.ok(!block.chipRow, `${mission} the trailing evidence-chip row is gone: the block replaced it`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} settled answer`);

  await page.fill('.chat-input', expectedCopy.followUp);
  await page.click('.chat-form button[type="submit"]');
  H.ok(await finishAnswer(page, 2), `${mission} follow-up answer settles`);
  const after = await page.evaluate(() => ({
    mode: document.getElementById('screen-demo').dataset.mode,
    answers: document.querySelectorAll('.msg.bot .bot-body').length,
    composer: !!document.querySelector('.chat-form') && getComputedStyle(document.querySelector('.chat-form')).display !== 'none',
    primaries: document.querySelectorAll('#screen-demo [data-primary]:not(:disabled)').length,
    contexts: document.querySelectorAll('canvas.v-canvas').length,
  }));
  H.ok(after.mode === 'chat', `${mission} a follow-up does not switch the screen into another mode`);
  H.ok(after.answers >= 2, `${mission} the follow-up lands in the same transcript (${after.answers} answers)`);
  H.ok(after.composer, `${mission} the composer stays available after the follow-up`);
  H.ok(after.primaries === 0, `${mission} no Show why button competes with the evidence in the answer`);
  H.ok(after.contexts === 1, `${mission} the transcript still holds exactly one WebGL replay (${after.contexts})`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} after the follow-up`);
}

/**
 * The same walk with no WebGL at all. The block is still the answer's evidence, minus the third
 * panel: the chart and the causal line carry it, and the replay slot falls back to the mission's
 * own line art rather than an empty box.
 */
async function completeDemoNoWebgl(page, mission, expectedCopy, mobileLabel = '') {
  await page.click('#screen-flow:not([hidden]) #flow-cta');
  const demoMounted = await waitFor(page, () => document.body.dataset.screen === 'demo' && !!window.__demo, 40000, `${mission} demo`);
  H.ok(demoMounted, `${mission} failure CTA opens the demo directly without WebGL`);
  if (!demoMounted) return false;
  H.ok(await finishAnswer(page, 1), `${mission} first answer settles without WebGL`);
  H.ok(
    await waitFor(page, () => document.querySelectorAll('.ev-embed').length === 1, 20000, `${mission} inline block`),
    `${mission} the answer still carries an evidence block without WebGL`,
  );
  // The plot is part of the answer, so it is waited for rather than sampled: reading the block in
  // the same tick the figure appears used to catch the frame before the canvas was in it.
  await waitFor(page, () => !!document.querySelector('.ev-embed .chart-canvas'), 20000, `${mission} inline chart`);
  const block = await page.evaluate(() => {
    const b = document.querySelector('.ev-embed');
    const art = b.querySelector('.ev-embed-art');
    return {
      chart: !!b.querySelector('.chart-canvas'),
      note: (b.querySelector('.ev-embed-note').textContent || '').trim().length,
      replay: !!b.querySelector('.v-canvas'),
      art: !!art && !art.hidden && !!art.querySelector('svg'),
      live: b.classList.contains('is-live'),
    };
  });
  H.ok(
    block.chart && block.note > 40,
    `${mission} the chart and the causal line still carry the evidence (chart=${block.chart} note=${block.note})`,
  );
  H.ok(!block.replay && !block.live, `${mission} no replay is claimed where no context can exist`);
  H.ok(block.art, `${mission} the replay slot falls back to the mission's line art`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} settled answer`);
}

async function assertClean(tape, label) {
  H.ok(tape.errors.length === 0, `${label} has no page errors (${tape.errors.slice(0, 2).join(' | ')})`);
  H.ok(tape.consoleErrors.length === 0, `${label} has no console errors (${tape.consoleErrors.slice(0, 2).join(' | ')})`);
}

async function fullWalk(viewport, label) {
  const run = await newPage(viewport);
  const { page, ctx, tape } = run;
  await page.goto(`${server.origin}/demo/#/start`, { waitUntil: 'domcontentloaded' });
  H.section(`${label}: seat, library and complete flow`);
  H.ok(await waitFor(page, () => document.body.dataset.screen === 'start', 10000, 'seat fork'), `${label} opens the seat fork`);
  H.ok((await page.locator('#screen-start .wordmark').count()) === 0, `${label} seat fork removes redundant AlloyLogger branding`);
  H.ok((await page.locator('#screen-start .st-escape').count()) === 0, `${label} seat fork removes the bottom-center escape link`);
  await page.click('.st-card[data-role="engineer"]');
  H.ok((await page.locator('.st-continue:not(:disabled)').count()) === 1, `${label} seat fork has one enabled Continue CTA`);
  await page.click('.st-continue');
  H.ok(await waitStep(page, 'ssl', 'robot'), `${label} seat choice routes to the engineer mission`);
  await page.click('#screen-flow:not([hidden]) .flow-id');
  H.ok(await waitFor(page, () => document.body.dataset.screen === 'picker', 15000, 'mission library'), `${label} reaches the mission library`);
  H.ok((await page.locator('.rcard').count()) === 4, `${label} mission library contains four cards`);
  await page.click('.rcard[data-robot="ssl"]');
  await page.click('#picker-open');
  H.ok(await waitStep(page, 'ssl', 'robot'), `${label} opens SSL at step 1`);
  H.ok((await primaryCount(page)) === 1, `${label} robot step has one primary CTA`);
  if (label === 'mobile') await assertNoOverflow(page, 'mobile SSL robot step');

  const copy = getFlowCopy('ssl', 'engineer');
  await page.click('#flow-cta');
  await assertMissionStep(page, 'ssl', copy, label === 'mobile' ? 'mobile' : '');
  await assertFailureStep(page, 'ssl', copy, label === 'mobile' ? 'mobile' : '');
  await completeDemo(page, 'ssl', copy, label === 'mobile' ? 'mobile' : '');
  await assertChooseRetired(page, 'ssl');
  await assertClean(tape, `${label} full walk`);
  await ctx.close();
}

await fullWalk({ width: 1440, height: 900 }, 'desktop');
await fullWalk({ width: 390, height: 844 }, 'mobile');

H.section('all 16 role and mission copy variants render in the live DOM');
for (const role of ROLES) {
  const run = await newPage({ width: 1440, height: 900 }, { role });
  const { page, ctx, tape } = run;
  await page.goto(`${server.origin}/demo/#/start`, { waitUntil: 'domcontentloaded' });
  for (const mission of MISSIONS) {
    const copy = getFlowCopy(mission, role);
    H.ok(await go(page, `#/connect/${mission}/mission`, 'flow'), `${role}/${mission} mission route opens`);
    await assertMissionStep(page, mission, copy);
    await assertFailureStep(page, mission, copy);
    await completeDemo(page, mission, copy);
  }
  await assertClean(tape, `${role} variant matrix`);
  await ctx.close();
}

H.section('generated demo keeps the published legacy brief contract');
{
  const run = await newPage({ width: 1440, height: 900 }, { role: 'engineer' });
  const { page, ctx, tape } = run;
  await page.route(`**/robots/${GEN_ID}/def.json`, (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: GEN_DEF }),
  );
  await page.goto(`${server.origin}/demo/#/connect/${GEN_ID}`, { waitUntil: 'domcontentloaded' });
  H.ok(
    await waitFor(
      page,
      () => document.body.dataset.screen === 'connect' && !!document.querySelector('#ingest-mount .ctx'),
      20000,
      'generated legacy brief',
    ),
    'the generated def.json route renders the legacy brief',
  );
  const state = await page.evaluate(() => ({
    hash: location.hash,
    text: (document.getElementById('ingest-mount').textContent || '').replace(/\s+/g, ' ').trim(),
    flow: !!window.__flow,
  }));
  H.ok(state.hash === `#/connect/${GEN_ID}`, `generated route stays on the legacy connect hash (${state.hash})`);
  H.ok(state.text.includes('ESP32-S3, hall encoders, INA219 current sense'), 'generated brief reads the visitor-authored device description');
  H.ok(!state.flow, 'generated demos do not receive an experience block or flow instance');
  await assertClean(tape, 'generated legacy brief');
  await ctx.close();
}

H.section('reduced motion walk');
{
  const run = await newPage({ width: 1440, height: 900 }, { role: 'hobbyist', reducedMotion: true });
  const { page, ctx, tape } = run;
  await page.goto(`${server.origin}/demo/#/connect/arm6/robot`, { waitUntil: 'domcontentloaded' });
  H.ok(await waitStep(page, 'arm6', 'robot'), 'reduced motion renders the anatomy step');
  await page.click('#flow-cta');
  H.ok(await waitStep(page, 'arm6', 'mission'), 'reduced motion renders the success step');
  const paused = await page.evaluate(() => ({
    playing: window.__flow.timeline.playing,
    playVisible: !document.getElementById('flow-play').hidden,
  }));
  H.ok(!paused.playing && paused.playVisible, 'reduced motion pauses the success loop and exposes its play affordance');
  await assertFailureStep(page, 'arm6', getFlowCopy('arm6', 'hobbyist'));
  await completeDemo(page, 'arm6', getFlowCopy('arm6', 'hobbyist'));
  await assertClean(tape, 'reduced motion walk');
  await ctx.close();
}

H.section('no WebGL walk');
{
  const run = await newPage({ width: 390, height: 844 }, { role: 'hobbyist', noWebgl: true });
  const { page, ctx, tape } = run;
  await page.goto(`${server.origin}/demo/#/connect/arm6/robot`, { waitUntil: 'domcontentloaded' });
  H.ok(await waitStep(page, 'arm6', 'robot'), 'no-WebGL mode renders the anatomy step');
  const fallback = await page.evaluate(() => ({
    visible: !document.getElementById('flow-fallback').hidden,
    cards: document.querySelectorAll('#flow-anatomy .flow-part').length,
  }));
  H.ok(fallback.visible && fallback.cards === 4, `no-WebGL anatomy uses SVG fallback plus four copy cards (${fallback.visible}/${fallback.cards})`);
  await page.click('#flow-cta');
  await assertMissionStep(page, 'arm6', getFlowCopy('arm6', 'hobbyist'), 'no-WebGL mobile');
  await assertFailureStep(page, 'arm6', getFlowCopy('arm6', 'hobbyist'), 'no-WebGL mobile');
  await completeDemoNoWebgl(page, 'arm6', getFlowCopy('arm6', 'hobbyist'), 'no-WebGL mobile');
  await assertClean(tape, 'no-WebGL walk');
  await ctx.close();
}

await browser.close();
await server.close();
H.done();
