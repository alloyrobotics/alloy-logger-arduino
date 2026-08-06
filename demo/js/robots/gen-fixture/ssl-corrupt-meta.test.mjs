// ssl-corrupt-meta.test.mjs - a payload that decodes but cannot be built from shows the card.
//
//   node demo/js/robots/gen-fixture/ssl-corrupt-meta.test.mjs
//
// The failure this pins: `loadSceneData()` resolving SUCCESSFULLY on a payload the mission cannot
// actually be built from. The load promise had a rejection handler that rendered an unavailable
// card, but its success handler called `route()` outside that handler, and `route()` synchronously
// builds the demo - chart, viewer, chat - from channels derived off the payload. A roster without
// Polaris #8 in it decodes perfectly and then throws out of `buildData()`, which became an
// unhandled rejection: no card, no message, and an exposed demo screen the visitor could not get a
// mission out of.
//
// Two fixes have to hold together, so this test drives BOTH, on two separate fixtures:
//
//   A  PRE-ROUTE. The semantic check runs inside `loadSceneData()`, so a bad roster REJECTS
//      rather than resolving into a doomed route. Fixture: the real match module with yellow 8
//      renumbered to yellow 88 in its META. The blob is untouched - it decodes, the popcounts
//      agree, every array is the right length - and the robot the whole kicker finding is about
//      is not in the roster, so `validateSceneData()` rejects the load.
//
//   B  POST-ROUTE. The continuation is wrapped anyway, so anything that throws AFTER the import
//      succeeded lands on the same card instead of on the floor. Fixture: a META that passes
//      `validateSceneData()` in full - every named robot present, referee track intact, ball and
//      time axes intact - whose /bot13/vision CHANNEL data is unbuildable, because the vision
//      cross-check block's `bins` is a scalar where the builder iterates a list. That throws
//      inside `buildData()`, which runs inside `buildDemo()`, which runs inside the synchronous
//      `route()` the continuation calls.
//
// B is the case the previous version of this file claimed to cover and did not. It also pins the
// reason the error branch cannot consult the navigation generation: `route()` bumps `navGen` as
// its first act, so a generation captured before it is stale BY CONSTRUCTION by the time anything
// inside it throws, and a staleness check on that branch rethrows every mid-build failure as the
// unhandled rejection this test exists to forbid.
//
// A AND B BOTH THROW BEFORE ANYTHING IS BUILT. `ensureData()` runs first in `buildDemo()`, so both
// fixtures fail with no timeline, no viewer and no canvas in existence, and "no half-built demo is
// left mounted" is satisfied by there being nothing to leave. That is not the interesting failure.
// Two more fixtures cover the interesting one, where the throw lands AFTER expensive resources
// exist:
//
//   C  INSIDE buildScene(). `createViewer()` allocates and mounts the WebGL renderer twenty lines
//      before it calls `robotDef.buildScene()`, so a throw there used to leave a canvas in the DOM
//      with a live GPU context and nobody holding the handle to release it. Fixture: scene.js
//      served with a throw at the top of buildScene.
//
//   D  AFTER the viewer returned. `buildDemo()` only assigns the global `demo` once every
//      component exists, so `renderSceneUnavailable()`'s `teardownDemo()` returned immediately
//      while a fully constructed timeline and viewer sat unreferenced. Fixture: chart.js served
//      with a throw at the top of createChart, which is the line after the viewer.
//
// Both are asserted across THREE repeated builds against a probe installed before any application
// code runs, because one leaked context is invisible and the sixteenth is a black viewer: the
// number that matters is whether it GROWS.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, loadPlaywright, launchChromium, harness, waitFor, ROOT } from './browser-fixture.mjs';

const H = harness('ssl-corrupt-meta');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const MATCH = path.join(ROOT, 'demo', 'js', 'robots', 'ssl', 'match-data.js');
const real = await readFile(MATCH, 'utf8');

// Renumber yellow 8 to yellow 88. One field, in the META only: same bytes, same popcount, same
// arrays, and the kicker/power channels now have no robot to be about.
const corrupt = real.replace('{"id":8,"nPresent"', '{"id":88,"nPresent"');
if (corrupt === real) {
  console.error('FAIL  could not find the yellow-8 roster entry in match-data.js to renumber');
  process.exit(1);
}

// The mid-build fixture. `visionCrossCheck.robots.<name>.bins` is a list of [binIndex, n, cameras]
// triples the /bot13/vision detections series is resampled from; here it is the bin COUNT instead,
// which is exactly the shape a producer change could ship. Nothing `validateSceneData()` looks at
// is touched, so the load resolves and the throw happens where it could not before.
const MID_BUILD_FROM = '"bins":[[';
const midBuild = real.replace(MID_BUILD_FROM, '"binCount":0,"bins":0,"binsWere":[[');
if (midBuild === real) {
  console.error('FAIL  could not find a visionCrossCheck bins array in match-data.js to break');
  process.exit(1);
}

// The two mid-build fixtures. Built by patching the REAL module rather than by substituting a stub,
// so every other export stays exactly what it was and the only difference is the throw.
const SCENE = path.join(ROOT, 'demo', 'js', 'robots', 'ssl', 'scene.js');
const CHART = path.join(ROOT, 'demo', 'js', 'core', 'chart.js');
const realScene = await readFile(SCENE, 'utf8');
const realChart = await readFile(CHART, 'utf8');

const SCENE_FROM = 'export function buildScene(THREE, mount) {';
const sceneThrows = realScene.replace(
  SCENE_FROM,
  `${SCENE_FROM}\n  throw new Error('fixture: buildScene throws after the renderer is mounted');`,
);
// Scoped to this mission by id, unlike scene.js which is the SSL module already. A chart that
// threw for every def would take the other four missions down with it, and "the page still works
// afterwards" is one of the things being asserted.
const CHART_FROM = 'export function createChart(mount, robotDef, timeline) {';
const chartThrows = realChart.replace(
  CHART_FROM,
  `${CHART_FROM}\n  if (robotDef && robotDef.id === 'ssl') throw new Error('fixture: createChart throws after the viewer is built');`,
);
if (sceneThrows === realScene || chartThrows === realChart) {
  console.error('FAIL  could not find buildScene/createChart to patch');
  process.exit(1);
}

/**
 * Counters for the resources a half-built viewer leaks, installed BEFORE any application code runs.
 *
 * Every one of these is a thing `dispose()` already promises to release and the failure path did
 * not: an animation frame, a ResizeObserver, and above all a WebGL context, which survives its own
 * renderer.dispose() until the detached canvas is collected. `isContextLost()` is what makes the
 * last one measurable at all - `forceContextLoss()` is exactly how the viewer releases it, and a
 * context nobody released is still live.
 */
const PROBE = `(() => {
  const p = { raf: new Set(), roMade: 0, roGone: 0, gl: [] };
  window.__probe = p;
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    const id = raf((t) => { p.raf.delete(id); cb(t); });
    p.raf.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { p.raf.delete(id); return caf(id); };
  const RO = window.ResizeObserver;
  window.ResizeObserver = class extends RO {
    constructor(...a) { super(...a); p.roMade++; }
    disconnect() { p.roGone++; return super.disconnect(); }
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest);
    if (ctx && /webgl/i.test(String(type))) p.gl.push(ctx);
    return ctx;
  };
  window.__probeState = () => ({
    raf: p.raf.size,
    roLive: p.roMade - p.roGone,
    glMade: p.gl.length,
    glLive: p.gl.filter((c) => !(c.isContextLost && c.isContextLost())).length,
    canvases: document.querySelectorAll('#viewer-mount canvas').length,
    viewers: document.querySelectorAll('#viewer-mount .viewer').length,
    hasDemo: !!window.__demo,
  });
})();`;

const server = await serve();
const browser = await launchChromium(pw);

/**
 * A page serving `body` in place of the real match module, with its uncaught-error and
 * console-error tapes attached. Each fixture gets its OWN context: the ES module map caches a
 * module by specifier for the life of a document, so two payloads cannot share one page.
 *
 * `routes` adds further module substitutions, for the fixtures whose payload is fine and whose
 * failure is in the build.
 */
async function pageWith(body, routes = []) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  for (const [glob, moduleBody] of routes) {
    await page.route(glob, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
        body: moduleBody,
      }),
    );
  }
  const errors = [];
  /** Unhandled promise rejections surface here in Chromium, which is the whole point of this test. */
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('crash', () => errors.push('page crashed'));
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.route('**/robots/ssl/match-data.js', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      body,
    }),
  );
  await page.goto(`${server.origin}/demo/#/missions`, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errors, consoleErrors };
}

/** The unavailable card, as the visitor would read it. */
const readCard = () => {
  const m = document.getElementById('ingest-mount');
  const a = m && m.querySelector('a[href="#/missions"]');
  return {
    text: ((m && m.textContent) || '').replace(/\s+/g, ' ').trim(),
    backHref: a ? a.getAttribute('href') : null,
    demoHidden: document.getElementById('screen-demo').hidden,
    hasDemo: !!window.__demo,
  };
};

const cardIsUp = () => {
  const m = document.getElementById('ingest-mount');
  return (
    document.body.dataset.screen === 'connect' &&
    !!m &&
    /could not be loaded/i.test(m.textContent || '')
  );
};

// ===================================================================================== fixture A
// The load itself rejects: a roster with no Polaris #8 in it never reaches route().

const A = await pageWith(corrupt);
const { page, errors, consoleErrors } = A;

// ---------------------------------------------------------------- the load itself rejects

H.section('A: the load rejects before the route');
{
  H.ok(
    await waitFor(page, () => document.body.dataset.screen === 'picker', 10000, 'the picker'),
    'the page boots normally - nothing eager depends on the match module',
  );
  const st = await page.evaluate(async () => {
    const d = await import('/demo/js/robots/ssl/data.js');
    let rejected = null;
    try {
      await d.loadSceneData();
    } catch (err) {
      rejected = { message: String(err && err.message), retryable: err && err.retryable };
    }
    return { rejected, loaded: d.isSceneDataLoaded() };
  });
  H.ok(st.rejected !== null, 'loadSceneData() REJECTS on a roster this mission cannot be built from');
  H.ok(
    st.rejected && /missing the robots this mission is about/i.test(st.rejected.message),
    `and it says why: "${st.rejected && st.rejected.message}"`,
  );
  H.ok(st.rejected && st.rejected.retryable === true, 'the rejection is marked retryable');
  H.ok(st.loaded === false, 'and nothing was cached as loaded');
}

// ---------------------------------------------------------------- the route shows the card

H.section('A: unavailable card');
{
  await page.evaluate(() => { location.hash = '#/demo/ssl'; });
  H.ok(
    await waitFor(page, cardIsUp, 20000, 'the unavailable card'),
    'the demo route lands on the unavailable card instead of a half-built demo',
  );
  const card = await page.evaluate(readCard);
  H.ok(/could not be loaded/i.test(card.text), `the card states the failure ("${card.text.slice(0, 90)}")`);
  H.ok(card.backHref === '#/missions', 'the card offers a way back to the robots');
  H.ok(card.demoHidden, 'the demo screen is not left exposed behind the card');
  H.ok(!card.hasDemo, 'no half-built demo is left mounted');
}

// ---------------------------------------------------------------- nothing went unhandled

H.section('A: no unhandled rejection');
{
  // Chromium reports an unhandled rejection as a page error. The console WARNING the failure path
  // writes on purpose is not one, so a clean run here means the throw was caught, not silenced.
  H.ok(
    errors.length === 0,
    `no uncaught page errors or unhandled rejections (${errors.slice(0, 3).join(' | ')})`,
  );
  const unhandled = consoleErrors.filter((t) => /Uncaught \(in promise\)|not in the decoded roster/.test(t));
  H.ok(
    unhandled.length === 0,
    `the roster failure never reaches the console as an uncaught error (${unhandled.slice(0, 2).join(' | ')})`,
  );
}

// ---------------------------------------------------------------- the rest of the page survives

H.section('A: the other missions still work');
{
  await page.evaluate(() => { location.hash = '#/demo/sbr'; });
  H.ok(
    await waitFor(
      page,
      () => {
        const el = document.getElementById('screen-demo');
        return !!el && !el.hidden && !!el.querySelector('canvas') && document.body.dataset.screen === 'demo';
      },
      20000,
      'the sbr demo',
    ),
    'a broken SSL payload does not take the other four missions down with it',
  );
  H.ok(errors.length === 0, `still no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
}

await A.ctx.close();

// ===================================================================================== fixture B
// The load RESOLVES and the build throws. This is the path the generation check used to swallow.

const B = await pageWith(midBuild);

H.section('B: a post-import build failure lands on the card');
{
  H.ok(
    await waitFor(B.page, () => document.body.dataset.screen === 'picker', 10000, 'the picker'),
    'the page boots normally',
  );
  // Straight into the demo route with NOTHING pre-loaded, which is the only way to reach the load
  // continuation: the payload has to still be in flight when the route is entered.
  await B.page.evaluate(() => { location.hash = '#/demo/ssl'; });
  H.ok(
    await waitFor(B.page, cardIsUp, 20000, 'the unavailable card'),
    'the mid-build throw renders the unavailable card, not an exposed demo screen',
  );
  const card = await B.page.evaluate(readCard);
  H.ok(/could not be loaded/i.test(card.text), `the card states the failure ("${card.text.slice(0, 90)}")`);
  H.ok(card.backHref === '#/missions', 'the card offers a way back to the robots');
  H.ok(card.demoHidden, 'the demo screen is not left exposed behind the card');
  H.ok(!card.hasDemo, 'no half-built demo is left mounted');
  // The load succeeded, so the copy must be the RETRYABLE sentence: the module evaluated fine and
  // picking the mission again re-runs the build. "Reload the page" would be wrong advice here.
  H.ok(
    /pick the mission again/i.test(card.text),
    'and offers the retry that actually applies, since the module itself evaluated',
  );

  // The half that makes this fixture different from A: the LOAD succeeded. Probed after the fact
  // so the route above went through the load continuation rather than finding a warm cache.
  const st = await B.page.evaluate(async () => {
    const d = await import('/demo/js/robots/ssl/data.js');
    let rejected = null;
    try {
      await d.loadSceneData();
    } catch (err) {
      rejected = String(err && err.message);
    }
    let built = null;
    try {
      const { mulberry32, seedFor } = await import('/demo/js/core/prng.js');
      d.buildData(mulberry32(seedFor('ssl')));
      built = 'ok';
    } catch (err) {
      built = `threw: ${err && err.message}`;
    }
    return { rejected, loaded: d.isSceneDataLoaded(), built };
  });
  H.ok(
    st.rejected === null && st.loaded === true,
    `loadSceneData() RESOLVED and validated this payload (${st.rejected || 'no rejection'})`,
  );
  H.ok(
    typeof st.built === 'string' && st.built.startsWith('threw:'),
    `so the throw came from buildData(), which route() calls synchronously (${st.built})`,
  );
}

H.section('B: no unhandled rejection');
{
  H.ok(
    B.errors.length === 0,
    `the mid-build throw is caught, not an unhandled rejection (${B.errors.slice(0, 3).join(' | ')})`,
  );
  const unhandled = B.consoleErrors.filter((t) => /Uncaught \(in promise\)/.test(t));
  H.ok(
    unhandled.length === 0,
    `nothing reaches the console as an uncaught error (${unhandled.slice(0, 2).join(' | ')})`,
  );
}

H.section('B: navigation still works afterwards');
{
  // The failure path resets currentRoute to the 'load' sentinel. If it did not, the router would
  // believe it is still on a screen it never finished building and the next hash change would be
  // handled as a no-op - the card would sit there over every subsequent navigation.
  await B.page.evaluate(() => { location.hash = '#/missions'; });
  H.ok(
    await waitFor(
      B.page,
      () => document.body.dataset.screen === 'picker' && !document.getElementById('screen-picker').hidden,
      15000,
      'the picker',
    ),
    'the card is not a dead end: back to the robots works',
  );
  await B.page.evaluate(() => { location.hash = '#/demo/sbr'; });
  H.ok(
    await waitFor(
      B.page,
      () => {
        const el = document.getElementById('screen-demo');
        return !!el && !el.hidden && !!el.querySelector('canvas') && document.body.dataset.screen === 'demo';
      },
      20000,
      'the sbr demo',
    ),
    'and another mission builds fully after the failed one',
  );
  // Back into the broken mission: it must fail the SAME way, not half-build off the cached data.
  await B.page.evaluate(() => { location.hash = '#/demo/ssl'; });
  H.ok(
    await waitFor(B.page, cardIsUp, 20000, 'the unavailable card again'),
    're-entering the broken mission shows the card again rather than a half-built demo',
  );
  H.ok(B.errors.length === 0, `still no uncaught page errors (${B.errors.slice(0, 2).join(' | ')})`);
}

await B.ctx.close();

// ================================================================================ fixtures C + D
// The payload is FINE in both. The build is what throws, after resources exist.

/**
 * Build the demo AND make an evidence block take the shared context, `times` times, sampling the
 * probe after each.
 *
 * ROUND 3 MOVED THE ALLOCATION. `buildDemo()` used to construct a renderer and a chart on the spot,
 * so calling it was the whole experiment. It no longer does either: the demo screen is a transcript,
 * and the renderer and the charts are allocated by the inline evidence block that an answer mounts
 * (core/embeds.js), lazily, on the block nearest the reader. Driving `buildDemo` alone now proves
 * nothing about leaks, because there is nothing to leak yet.
 *
 * So the retry is build + attach a block + hand it the context, which is exactly the sequence a
 * settled evidence-bearing answer runs. `attach()` and `play()` are the host's own API and
 * `window.__demo.embeds` is the handle the demo already exposes for QA.
 *
 * The router is still not the subject: going back through it would mean a trip via the picker,
 * whose own previews allocate a context and would drown the number being measured.
 */
async function retryBuilds(page, times) {
  return page.evaluate(async (n) => {
    const app = await import('/demo/js/app.js');
    const def = (await import('/demo/js/robots/ssl/script.js')).default;
    // The payload has to be IN, or the throw happens in ensureData() before anything is built,
    // which is the case fixtures A and B already cover.
    await def.loadSceneData();
    const baseline = window.__probeState();
    const errors = [];
    const states = [];
    for (let i = 0; i < n; i++) {
      try {
        app.buildDemo(def);
        const d = window.__demo;
        const finding = (def.findings || [])[0];
        const row = d.chat.el.querySelector('.chat-log');
        d.embeds.attach(row, [finding]);
        d.embeds.play(finding, { source: 'user' });
        errors.push(null);
      } catch (err) {
        errors.push(String((err && err.message) || err));
      }
      // A frame may already be queued; give it one turn to run before counting.
      await new Promise((r) => requestAnimationFrame(() => r()));
      states.push(window.__probeState());
    }
    // The last build is left standing on purpose everywhere else in this file; here it owns the
    // one context under test, so it is torn down before the caller navigates on.
    app.buildDemo(def);
    window.__demo.embeds.dispose();
    window.__demo.chat.dispose();
    window.__demo.timeline.dispose();
    return { baseline, errors, states };
  }, times);
}

for (const [name, glob, moduleBody, where] of [
  ['C', '**/robots/ssl/scene.js', sceneThrows, 'inside buildScene(), with the renderer already mounted'],
  ['D', '**/core/chart.js', chartThrows, 'after createViewer() returned'],
]) {
  const F = await pageWith(real, [[glob, moduleBody]]);
  H.section(`${name}: a throw ${where}`);
  H.ok(
    await waitFor(F.page, () => document.body.dataset.screen === 'picker', 10000, 'the picker'),
    'the page boots normally',
  );

  const { baseline, errors, states } = await retryBuilds(F.page, 3);
  // CONTAINED, not propagated. The block owns the failure now: `ensureViewer` and `ensureChart`
  // each catch, mark themselves dead and hand the block its fallback (line art for the replay, no
  // plot frame for the chart). The reader is left with an answer that is short of one panel rather
  // than a demo screen that threw.
  H.ok(
    errors.every((e) => e === null),
    `the failure is contained inside the block, not thrown at the screen (${errors.map((e) => String(e).slice(0, 40)).join(' | ')})`,
  );
  H.ok(
    states.every((s) => s.hasDemo),
    'the transcript is still standing after each of them',
  );
  H.ok(
    states.every((s) => s.canvases === 0 && s.viewers === 0),
    `nothing is left parked in the shared-context mount (${states.map((s) => `${s.viewers}/${s.canvases}`).join(' ')})`,
  );

  // THE GROWTH TEST, unchanged in intent. One leaked context is invisible; the number that matters
  // is whether repeating the failure accumulates them.
  //
  // The CEILING is baseline + 1, and that one is the point of the whole architecture: a demo screen
  // owns exactly ONE context however many evidence blocks its transcript holds, and rebuilding the
  // demo disposes the previous one before the next is asked for. Fixture C never reaches a renderer
  // (buildScene throws inside createViewer, which unwinds its own allocation), so it stays at the
  // baseline; fixture D reaches one and keeps exactly one.
  H.ok(
    states.every((s) => s.glLive <= baseline.glLive + 1),
    `at most one demo WebGL context is live at a time (${baseline.glLive} -> ${states.map((s) => s.glLive).join(',')})`,
  );
  H.ok(
    states[states.length - 1].glLive === states[0].glLive,
    `and repeating the failure does not accumulate them (${states.map((s) => s.glLive).join(',')})`,
  );
  H.ok(
    states.every((s) => s.roLive <= baseline.roLive + 1),
    `no ResizeObserver pile-up (${baseline.roLive} -> ${states.map((s) => s.roLive).join(',')})`,
  );
  H.ok(
    states.every((s) => s.raf <= baseline.raf + 2),
    `no animation-frame pile-up (${baseline.raf} -> ${states.map((s) => s.raf).join(',')})`,
  );

  // ...and the page is still usable: another mission builds fully after three failed ones.
  await F.page.evaluate(() => { location.hash = '#/demo/sbr'; });
  H.ok(
    await waitFor(
      F.page,
      () => {
        const el = document.getElementById('screen-demo');
        return !!el && !el.hidden && !!el.querySelector('canvas') && document.body.dataset.screen === 'demo';
      },
      20000,
      'the sbr demo',
    ),
    'and another mission builds fully after three failed builds',
  );
  H.ok(
    F.errors.length === 0,
    `no uncaught page errors or unhandled rejections (${F.errors.slice(0, 3).join(' | ')})`,
  );
  await F.ctx.close();
}

// ===================================================================================== fixture E
// The DEEPEST failure point, and the only one that can leak a timeline SUBSCRIPTION.
//
// C throws before `createViewer()` has subscribed to anything, so "no leaked subscription" is true
// there for the uninteresting reason. The subscriptions are taken near the end, and the first
// `applyT()` runs after them - which is the first time `sceneApi.update()` is called, and the first
// time a lazily built scene touches its payload. A throw THERE has the renderer, the observer, the
// animation frame and both subscriptions all live at once.
//
// The timeline is a PROXY that counts subscribe against unsubscribe. `createViewer` reaches the
// timeline only through its interface, so a proxy is the real calling convention, and counting on
// it needs no test-only hook in the production module.

{
  const E = await pageWith(real);
  H.section('E: a throw on the first frame, with everything already subscribed');
  H.ok(
    await waitFor(E.page, () => document.body.dataset.screen === 'picker', 10000, 'the picker'),
    'the page boots normally',
  );

  const out = await E.page.evaluate(async () => {
    const { createViewer } = await import('/demo/js/core/viewer.js');
    const { createTimeline } = await import('/demo/js/core/timeline.js');
    const { mulberry32, seedFor } = await import('/demo/js/core/prng.js');
    const def = (await import('/demo/js/robots/ssl/script.js')).default;
    await def.loadSceneData();
    def.data = def.buildData(mulberry32(seedFor('ssl')));

    const mount = document.getElementById('viewer-mount');
    const baseline = window.__probeState();
    const results = [];
    for (let i = 0; i < 3; i++) {
      const inner = createTimeline(def.duration);
      let subs = 0;
      const timeline = Object.create(inner);
      for (const k of ['onTick', 'onChange']) {
        timeline[k] = (cb) => {
          subs++;
          const off = inner[k](cb);
          return () => {
            subs--;
            return off();
          };
        };
      }
      let threw = null;
      try {
        createViewer(mount, {
          ...def,
          buildScene: () => ({
            update() {
              throw new Error('fixture: sceneApi.update throws on the first frame');
            },
          }),
        }, timeline);
      } catch (err) {
        threw = String((err && err.message) || err);
      }
      inner.dispose();
      await new Promise((r) => requestAnimationFrame(() => r()));
      results.push({ threw, subs, state: window.__probeState() });
    }
    return { baseline, results };
  });

  H.ok(
    out.results.every((r) => r.threw && /first frame/.test(r.threw)),
    `every build throws from the first frame (${out.results.map((r) => String(r.threw).slice(0, 40)).join(' | ')})`,
  );
  H.ok(
    out.results.every((r) => r.subs === 0),
    `and every timeline subscription it took is released (${out.results.map((r) => r.subs).join(',')})`,
  );
  H.ok(
    out.results.every((r) => r.state.canvases === 0 && r.state.viewers === 0),
    `no viewer DOM and no canvas survives (${out.results.map((r) => `${r.state.viewers}/${r.state.canvases}`).join(' ')})`,
  );
  H.ok(
    out.results[out.results.length - 1].state.glMade > out.baseline.glMade,
    `each attempt really constructs a renderer (${out.baseline.glMade} -> ${out.results.map((r) => r.state.glMade).join(',')})`,
  );
  H.ok(
    out.results.every((r) => r.state.glLive === out.baseline.glLive),
    `and no live WebGL context survives any of them (${out.baseline.glLive} -> ${out.results.map((r) => r.state.glLive).join(',')})`,
  );
  H.ok(
    out.results.every((r) => r.state.roLive === out.baseline.roLive),
    `no ResizeObserver is left connected (${out.baseline.roLive} -> ${out.results.map((r) => r.state.roLive).join(',')})`,
  );
  H.ok(
    out.results.every((r) => r.state.raf <= out.baseline.raf),
    `no orphan animation frame is left queued (${out.baseline.raf} -> ${out.results.map((r) => r.state.raf).join(',')})`,
  );
  H.ok(
    E.errors.length === 0,
    `no uncaught page errors or unhandled rejections (${E.errors.slice(0, 3).join(' | ')})`,
  );
  await E.ctx.close();
}

await browser.close();
await server.close();

// ============================================================== the shape of the error branch
//
// Fixture B proves the visitor-visible property, but it cannot prove WHICH of the two guards
// caught the throw: `route()` wraps its own synchronous build, so the continuation's catch is
// never reached for a buildDemo failure. The continuation's catch is still the only thing standing
// under everything ELSE route() does - the picker, the brief, a generated def's resolution - and
// the exact defect this file exists for was a staleness check ON THAT BRANCH. `route()` bumps
// navGen as its first act, so a generation captured before it is stale by construction the moment
// anything inside it throws, and `if (stale()) throw err` rethrows every one of them into the void.
//
// That is a property of the branch, not of any fixture, so it is asserted on the source.

H.section('the continuation error branch is unconditional');
{
  const src = await readFile(path.join(ROOT, 'demo', 'js', 'app.js'), 'utf8');
  const at = src.indexOf('def.loadSceneData().then(');
  H.ok(at > 0, 'resolveSceneData still hands the route back through a load continuation');
  const cont = src.slice(at);
  const m = /catch \(err\) \{([\s\S]*?)\n\s*\}/.exec(cont);
  H.ok(!!m, "the continuation's route() call is wrapped in its own catch");
  const body = m ? m[1] : '';
  H.ok(
    /unavailable\(\s*err\s*\)/.test(body),
    `the catch routes to the unavailable card (${body.trim().replace(/\s+/g, ' ').slice(0, 80)})`,
  );
  H.ok(
    !/stale\s*\(/.test(body),
    'and it does NOT consult the navigation generation, which route() has already invalidated',
  );
}

H.done();
