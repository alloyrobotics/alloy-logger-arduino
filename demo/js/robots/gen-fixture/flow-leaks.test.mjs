// flow-leaks.test.mjs - step churn keeps one viewer and route teardown releases every live resource.

import { serve, loadPlaywright, launchChromium, harness, waitFor } from './browser-fixture.mjs';

const H = harness('flow-leaks');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const PROBE = `(() => {
  const p = {
    raf: new Set(),
    roMade: 0,
    roGone: 0,
    ioMade: 0,
    ioGone: 0,
    gl: new Set(),
    listeners: [],
  };
  window.__flowLeakProbe = p;

  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    const id = raf((time) => { p.raf.delete(id); cb(time); });
    p.raf.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { p.raf.delete(id); return caf(id); };

  const RO = window.ResizeObserver;
  window.ResizeObserver = class extends RO {
    constructor(...args) { super(...args); p.roMade++; this.__gone = false; }
    disconnect() { if (!this.__gone) { this.__gone = true; p.roGone++; } return super.disconnect(); }
  };
  const IO = window.IntersectionObserver;
  window.IntersectionObserver = class extends IO {
    constructor(...args) { super(...args); p.ioMade++; this.__gone = false; }
    disconnect() { if (!this.__gone) { this.__gone = true; p.ioGone++; } return super.disconnect(); }
  };

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = getContext.call(this, type, ...args);
    if (ctx && /webgl/i.test(String(type))) p.gl.add(ctx);
    return ctx;
  };

  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const captureOf = (opts) => typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    const capture = captureOf(opts);
    if (listener && !p.listeners.some((row) => row.target === this && row.type === type && row.listener === listener && row.capture === capture)) {
      p.listeners.push({ target: this, type, listener, capture });
    }
    return add.call(this, type, listener, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, opts) {
    const capture = captureOf(opts);
    const at = p.listeners.findIndex((row) => row.target === this && row.type === type && row.listener === listener && row.capture === capture);
    if (at >= 0) p.listeners.splice(at, 1);
    return remove.call(this, type, listener, opts);
  };

  window.__flowLeakState = () => ({
    raf: p.raf.size,
    roLive: p.roMade - p.roGone,
    ioLive: p.ioMade - p.ioGone,
    glMade: p.gl.size,
    glLive: [...p.gl].filter((ctx) => !(ctx.isContextLost && ctx.isContextLost())).length,
    listeners: p.listeners.filter((row) => row.target === window || row.target === document || row.target.isConnected).length,
    flowCanvases: document.querySelectorAll('#flow-viewer-mount canvas, #flow-chart-mount canvas').length,
    demoCanvases: document.querySelectorAll('#viewer-mount canvas, .ev-embed canvas').length,
    pickerCanvases: document.querySelectorAll('#screen-picker canvas').length,
    hasFlow: !!window.__flow,
    hasDemo: !!window.__demo,
  });
})();`;

const server = await serve();
const browser = await launchChromium(pw);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(PROBE);
await ctx.addInitScript(() => {
  localStorage.setItem('alloy_demo_role', 'hobbyist');
  localStorage.setItem('alloy_signup_seen', String(Date.now()));
});
const page = await ctx.newPage();
const errors = [];
const consoleErrors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

async function settleFrames() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(80);
}

async function state() {
  await settleFrames();
  return page.evaluate(() => window.__flowLeakState());
}

async function go(hash, predicate, label, timeout = 30000) {
  await page.evaluate((next) => { location.hash = next; }, hash);
  return waitFor(page, predicate, timeout, label);
}

await page.goto(`${server.origin}/demo/#/start`, { waitUntil: 'domcontentloaded' });
H.ok(await waitFor(page, () => document.body.dataset.screen === 'start', 10000, 'start screen'), 'the leak probe boots before the app');
const baseline = await state();

H.section('one viewer survives all three steps and no second context is created');
for (let cycle = 0; cycle < 3; cycle++) {
  H.ok(
    await go(
      '#/connect/arm6/robot',
      () => document.body.dataset.screen === 'flow' && !!window.__flow && window.__flow.step === 'robot',
      `cycle ${cycle + 1} robot step`,
    ),
    `cycle ${cycle + 1} enters the anatomy step`,
  );
  const robot = await state();
  H.ok(robot.glLive === baseline.glLive + 1, `cycle ${cycle + 1} owns one live WebGL context (${robot.glLive})`);
  H.ok(robot.hasFlow && !robot.hasDemo, `cycle ${cycle + 1} exposes only the flow instance`);

  const stepStates = [robot];
  for (const step of ['mission', 'failure']) {
    H.ok(
      await go(
        `#/connect/arm6/${step}`,
        () => document.body.dataset.screen === 'flow' && !!window.__flow,
        `cycle ${cycle + 1} ${step} step`,
      ),
      `cycle ${cycle + 1} enters ${step}`,
    );
    stepStates.push(await state());
  }
  H.ok(
    stepStates.every((sample) => sample.glMade === robot.glMade),
    `cycle ${cycle + 1} reuses the same context across all steps (${stepStates.map((sample) => sample.glMade).join(',')})`,
  );
  H.ok(
    stepStates.every((sample) => sample.glLive === robot.glLive),
    `cycle ${cycle + 1} keeps the live context count flat (${stepStates.map((sample) => sample.glLive).join(',')})`,
  );

  H.ok(
    await go('#/start', () => document.body.dataset.screen === 'start' && !window.__flow, `cycle ${cycle + 1} teardown`),
    `cycle ${cycle + 1} leaves the flow family`,
  );
  const after = await state();
  H.ok(after.glLive === baseline.glLive, `cycle ${cycle + 1} releases its WebGL context (${after.glLive})`);
  H.ok(after.roLive === baseline.roLive, `cycle ${cycle + 1} disconnects every ResizeObserver (${after.roLive})`);
  H.ok(after.ioLive === baseline.ioLive, `cycle ${cycle + 1} disconnects every IntersectionObserver (${after.ioLive})`);
  H.ok(after.raf <= baseline.raf, `cycle ${cycle + 1} leaves no orphan animation frame (${after.raf})`);
  H.ok(after.listeners === baseline.listeners, `cycle ${cycle + 1} restores persistent listener count (${after.listeners})`);
  H.ok(
    after.flowCanvases === 0 && after.demoCanvases === 0 && after.pickerCanvases === 0,
    `cycle ${cycle + 1} leaves no flow, demo or picker canvas (${after.flowCanvases}/${after.demoCanvases}/${after.pickerCanvases})`,
  );
}

// ROUND 3 deleted the fourth step. The hash is still one real sessions have in their history, so
// it is redirected rather than 404ed, and the redirect is the leak-relevant part: it must land on
// the demo screen with the flow torn down, not leave a flow instance behind it.
H.section('the retired choose hash redirects into the demo');
{
  H.ok(
    await go(
      '#/connect/arm6/robot',
      () => document.body.dataset.screen === 'flow' && !!window.__flow && window.__flow.step === 'robot',
      'arm6 robot step before the redirect',
    ),
    'the flow is up before the retired hash is used',
  );
  H.ok(
    await go(
      '#/connect/arm6/choose',
      () => document.body.dataset.screen === 'demo' && location.hash === '#/demo/arm6' && !window.__flow,
      'the choose redirect',
    ),
    'the retired choose hash lands on the demo with the flow torn down',
  );
  const inDemo = await state();
  H.ok(inDemo.hasDemo && !inDemo.hasFlow, 'only the demo instance is exposed after the redirect');
  H.ok(
    await go('#/start', () => document.body.dataset.screen === 'start' && !window.__demo, 'demo teardown'),
    'the demo tears down on the way out',
  );
  const after = await state();
  H.ok(after.glLive === baseline.glLive, `the demo releases its WebGL context (${after.glLive})`);
  H.ok(after.roLive === baseline.roLive, `the demo disconnects every ResizeObserver (${after.roLive})`);
  H.ok(after.ioLive === baseline.ioLive, `the demo disconnects every IntersectionObserver (${after.ioLive})`);
  H.ok(after.demoCanvases === 0, `no demo or inline-block canvas survives (${after.demoCanvases})`);
  H.ok(after.listeners === baseline.listeners, `the demo restores the persistent listener count (${after.listeners})`);
}

// The inline evidence block is where the demo screen's renderer and charts now live, so the leak
// claim that used to be about the fixed panes is about the block: a settled answer allocates one
// context and one chart, and leaving the screen must release both.
H.section('an inline evidence block releases its context and its chart');
{
  H.ok(
    await go('#/demo/arm6', () => document.body.dataset.screen === 'demo' && !!window.__demo, 'arm6 demo'),
    'the arm6 demo opens as a transcript',
  );
  const typing = await waitFor(page, () => window.__demo && window.__demo.chat.streaming, 30000, 'the arm6 opener');
  if (typing) await page.evaluate(() => window.__demo.chat.finishStreaming());
  H.ok(
    await waitFor(page, () => document.querySelectorAll('.ev-embed').length > 0, 30000, 'the inline block'),
    'the settled answer carries an inline evidence block',
  );
  const live = await state();
  H.ok(live.glLive === baseline.glLive + 1, `the block owns exactly one live WebGL context (${live.glLive})`);
  H.ok(
    live.demoCanvases >= 2,
    `and the block really holds a replay canvas and a chart canvas (${live.demoCanvases})`,
  );
  H.ok(
    await go('#/start', () => document.body.dataset.screen === 'start' && !window.__demo, 'block teardown'),
    'leaving the demo tears the block down',
  );
  const after = await state();
  H.ok(after.glLive === baseline.glLive, `the block releases its WebGL context (${after.glLive})`);
  H.ok(after.roLive === baseline.roLive, `the block disconnects every ResizeObserver (${after.roLive})`);
  H.ok(after.ioLive === baseline.ioLive, `the block disconnects every IntersectionObserver (${after.ioLive})`);
  H.ok(after.raf <= baseline.raf, `the block leaves no orphan animation frame (${after.raf})`);
  H.ok(after.demoCanvases === 0, `no canvas survives the block (${after.demoCanvases})`);
  H.ok(after.listeners === baseline.listeners, `the block restores the persistent listener count (${after.listeners})`);
}

H.section('changing mission replaces rather than stacks the viewer');
H.ok(
  await go('#/connect/arm6/robot', () => document.body.dataset.screen === 'flow' && window.__flow?.def.id === 'arm6', 'arm6 flow'),
  'arm6 flow mounts',
);
const arm = await state();
H.ok(
  await go('#/connect/drone/robot', () => document.body.dataset.screen === 'flow' && window.__flow?.def.id === 'drone', 'drone flow'),
  'changing mission mounts the drone flow',
);
const drone = await state();
H.ok(drone.glMade > arm.glMade, `the changed mission builds its own viewer (${arm.glMade} to ${drone.glMade})`);
H.ok(drone.glLive === arm.glLive, `the old context is released before the new one stands (${arm.glLive} to ${drone.glLive})`);
H.ok(
  await go('#/start', () => document.body.dataset.screen === 'start' && !window.__flow, 'final teardown'),
  'the changed mission also tears down',
);
const final = await state();
H.ok(final.glLive === baseline.glLive, `final WebGL live count returns to baseline (${final.glLive})`);
H.ok(final.roLive === baseline.roLive && final.ioLive === baseline.ioLive, `final observer counts return to baseline (${final.roLive}/${final.ioLive})`);
H.ok(final.raf <= baseline.raf, `final queued frame count returns to baseline (${final.raf})`);
H.ok(final.listeners === baseline.listeners, `final persistent listener count returns to baseline (${final.listeners})`);
H.ok(errors.length === 0, `route churn has no page errors (${errors.slice(0, 2).join(' | ')})`);
H.ok(consoleErrors.length === 0, `route churn has no console errors (${consoleErrors.slice(0, 2).join(' | ')})`);

await ctx.close();
await browser.close();
await server.close();
H.done();
