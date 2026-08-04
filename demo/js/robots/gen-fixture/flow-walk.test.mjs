// flow-walk.test.mjs - the approved four-step flow through chat, proof and follow-up.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, loadPlaywright, launchChromium, harness, waitFor, ROOT } from './browser-fixture.mjs';
import { getFlowCopy } from '../../core/flow-copy.js';

const H = harness('flow-walk');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const MISSIONS = ['arm6', 'drone', 'ssl', 'donna'];
const ROLES = ['hobbyist', 'engineer', 'lead', 'marketing'];
const EXPECTED_FAILURE = {
  arm6: { id: 'drop', window: [52, 60], channel: '/joints', fields: ['tau2', 'tau1', 'tau3'] },
  drone: { id: 'dip', window: [58, 66], channel: '/pos', fields: ['alt'] },
  ssl: { id: 'kicker-charge', window: [46.3376, 62.74], channel: '/bot8/kicker', fields: ['kickerLevel', 'kickerMax'] },
  donna: { id: 'jack-falls-foul-line', window: [145.878, 150.147], channel: '/imu', fields: ['accelMagMps2', 'pitchDeg', 'rollDeg'] },
};
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
      alertBanner: visible('.v-banner[data-sev="alert"]'),
      chart: !!document.querySelector('#flow-chart-mount .chart-canvas'),
      loop: window.__flow.timeline.loopWindow,
    };
  });
  H.ok(state.intro === expectedCopy.missionIntro, `${mission} mission intro matches the selected role variant`);
  H.ok(state.evidenceClass === 0, `${mission} success step has no evidence-on failure state`);
  H.ok(!state.alertBanner, `${mission} success step has no alert finding banner`);
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
      channel: chart && chart.channel,
      fields: chart && chart.fields,
      minimal: !!document.querySelector('#flow-chart-mount .chart.chart-minimal'),
      timestampVisible: isVisible(document.querySelector('#flow-viewer-mount .v-time')),
      chartBarVisible: isVisible(document.querySelector('#flow-chart-mount .chart-bar')),
      fieldChipsVisible: isVisible(document.querySelector('#flow-chart-mount .field-chips')),
      readoutVisible: isVisible(document.querySelector('#flow-chart-mount .chart-readout')),
      canvas: !!document.querySelector('#flow-chart-mount .chart-canvas'),
    };
  });
  H.ok(state.intro === expectedCopy.failureIntro, `${mission} failure intro matches the selected role variant`);
  H.ok(closeEnough(state.loop, expected.window), `${mission} failure loop is ${expected.window.join('..')} (${JSON.stringify(state.loop)})`);
  H.ok(state.channel === expected.channel, `${mission} failure chart selects ${expected.channel} (${state.channel})`);
  H.ok(JSON.stringify(state.fields) === JSON.stringify(expected.fields), `${mission} direct-label fields match the experience (${(state.fields || []).join(', ')})`);
  H.ok(state.canvas && state.minimal, `${mission} failure chart is present in direct-label minimal mode`);
  H.ok(!state.timestampVisible, `${mission} failure step hides the replay timestamp`);
  H.ok(!state.chartBarVisible && !state.fieldChipsVisible && !state.readoutVisible, `${mission} failure step hides generic chart summary controls`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} failure step`);
}

async function assertChooseStep(page, mission, expectedCopy, mobileLabel = '') {
  H.ok(await go(page, `#/connect/${mission}/choose`, 'flow'), `${mission} choose route is reachable`);
  H.ok(await waitStep(page, mission, 'choose'), `${mission} choose step renders`);
  H.ok((await primaryCount(page)) === 1, `${mission} choose step has one primary CTA`);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('#flow-debug .flow-debug-card')].map((card) => ({
      title: (card.querySelector('h2').textContent || '').trim(),
      desc: (card.querySelector('p').textContent || '').trim(),
      time: (card.querySelector('strong').textContent || '').trim(),
    })),
  );
  H.ok(JSON.stringify(cards) === JSON.stringify(expectedCopy.debugCards), `${mission} debug cards match the selected role variant`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} choose step`);
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
  const demoMounted = await waitFor(page, () => document.body.dataset.screen === 'demo' && !!window.__demo, 30000, `${mission} chat mode`);
  H.ok(demoMounted, `${mission} choose CTA opens the demo`);
  if (!demoMounted) return false;
  const entry = await page.evaluate(() => {
    window.__flowProofTimeline = window.__demo.timeline;
    return { mode: document.getElementById('screen-demo').dataset.mode, timeline: !!window.__demo.timeline };
  });
  H.ok(entry.mode === 'chat' && entry.timeline, `${mission} enters chat-first mode with one timeline`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} chat mode`);

  H.ok(await finishAnswer(page, 1), `${mission} first answer settles`);
  H.ok(
    await waitFor(page, () => document.getElementById('screen-demo').dataset.mode === 'proof', 10000, `${mission} proof mode`),
    `${mission} evidence opens proof mode`,
  );
  const proof = await page.evaluate(() => ({
    question: (document.querySelector('.msg.user .bubble').textContent || '').trim(),
    placeholder: document.querySelector('.chat-input').getAttribute('placeholder'),
    sameTimeline: window.__demo.timeline === window.__flowProofTimeline,
    loop: window.__demo.timeline.loopWindow,
  }));
  H.ok(proof.question === expectedCopy.firstQuestion, `${mission} chat asks the selected role's first question ("${proof.question}")`);
  H.ok(proof.placeholder === expectedCopy.followUp, `${mission} proof composer carries the selected role's follow-up`);
  H.ok(proof.sameTimeline, `${mission} chat and proof modes share the same TimelineStore instance`);
  H.ok(Array.isArray(proof.loop), `${mission} proof mode keeps an evidence loop active`);
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} proof mode`);

  await page.fill('.chat-input', expectedCopy.followUp);
  await page.click('.chat-form button[type="submit"]');
  H.ok(
    await waitFor(page, () => document.getElementById('screen-demo').dataset.mode === 'followup', 10000, `${mission} follow-up mode`),
    `${mission} typed follow-up opens full-screen chat again`,
  );
  H.ok(await finishAnswer(page, 2), `${mission} follow-up answer settles`);
  H.ok(
    await waitFor(page, () => !!document.querySelector('.guide-cta[data-primary]:not(:disabled)'), 10000, 'Show why'),
    `${mission} follow-up answer carries one Show why action`,
  );
  const actions = await page.evaluate(() => document.querySelectorAll('.guide-cta[data-primary]:not(:disabled)').length);
  H.ok(actions === 1, `${mission} follow-up exposes exactly one primary Show why action (${actions})`);
  await page.click('.guide-cta[data-primary]:not(:disabled)');
  H.ok(
    await waitFor(
      page,
      () => document.getElementById('screen-demo').dataset.mode === 'proof' && Array.isArray(window.__demo.timeline.loopWindow),
      10000,
      `${mission} proof return`,
    ),
    `${mission} Show why returns to proof with loopWindow set`,
  );
  if (mobileLabel) await assertNoOverflow(page, `${mobileLabel} ${mission} returned proof`);
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
  await assertChooseStep(page, 'ssl', copy, label === 'mobile' ? 'mobile' : '');
  await completeDemo(page, 'ssl', copy, label === 'mobile' ? 'mobile' : '');
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
    await assertChooseStep(page, mission, copy);
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
  await assertChooseStep(page, 'arm6', getFlowCopy('arm6', 'hobbyist'));
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
  await assertChooseStep(page, 'arm6', getFlowCopy('arm6', 'hobbyist'), 'no-WebGL mobile');
  await completeDemo(page, 'arm6', getFlowCopy('arm6', 'hobbyist'), 'no-WebGL mobile');
  await assertClean(tape, 'no-WebGL walk');
  await ctx.close();
}

await browser.close();
await server.close();
H.done();
