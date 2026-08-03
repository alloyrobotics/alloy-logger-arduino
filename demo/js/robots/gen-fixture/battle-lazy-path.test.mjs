// battle-lazy-path.test.mjs - the battle mission's lazy-route browser gates: the navigation race,
// the corrupt full payload, and the corrupt preview slice, on BATTLE'S routes and modules.
//
//   node demo/js/robots/gen-fixture/battle-lazy-path.test.mjs
//
// The ssl-* browser suites exercise `#/demo/ssl` and `robots/ssl/*` by name, so a green run of
// them proves nothing about the page's SECOND lazy mission: a battle-only race or a corrupt battle
// module could strand the route while every ssl gate stays green. This suite drives the same three
// contracts through battle's own route and modules. The contracts themselves live in app.js and
// data.js and are shared; what is battle-specific here is only the route, the module paths, the
// loading-card copy (def-owned since the artifact review) and the fixture payloads.
//
//   A  demo -> picker -> the same demo again, all inside one throttled round-module load
//   B  demo -> the same robot's brief -> demo again, inside the same window
//   C  the undisturbed path renders
//   D  a round module that decodes to garbage lands on the unavailable card, not a half-built demo
//   E  a corrupt preview slice degrades the picker card to SVG line art and never throws
//
// A fresh page per sequence: a module already in the browser's module map never arrives late (or
// corrupt) a second time.

import { serve, loadPlaywright, launchChromium, harness, waitFor, screenState } from './browser-fixture.mjs';

const H = harness('battle-lazy-path');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const DELAY_MS = 2500;

const server = await serve();
const browser = await launchChromium(pw);

/** A page whose ONLY throttled request is battle's round module. */
async function openThrottled() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let arrivals = 0;
  await page.route('**/robots/battle/battle-data.js', async (route) => {
    arrivals++;
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await route.continue();
  });
  await page.goto(`${server.origin}/demo/#/missions`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => document.body.dataset.screen === 'picker');
  return { ctx, page, errors, hits: () => arrivals };
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
// The def-owned loading copy, asserted verbatim: this line is battle's and no other mission's.
const onLoadingCard = (page) =>
  waitFor(
    page,
    () => {
      const m = document.getElementById('ingest-mount');
      return !!m && /Loading the simulated round/i.test(m.textContent || '');
    },
    8000,
    'the loading card',
  );
const onDemo = (page) =>
  waitFor(
    page,
    () => {
      const el = document.getElementById('screen-demo');
      return (
        !!el && !el.hidden && document.body.dataset.screen === 'demo' &&
        location.hash === '#/demo/battle' && !!el.querySelector('canvas')
      );
    },
    15000,
    'the demo screen',
  );

// ------------------------------------------------------------- A. demo -> picker -> same demo

H.section('A: demo -> picker -> the same demo, inside one load');
{
  const { ctx, page, errors, hits } = await openThrottled();

  await go(page, '#/demo/battle');
  H.ok(await onLoadingCard(page), 'the loading card is parked while the module is in flight');

  await go(page, '#/missions');
  H.ok(
    await waitFor(page, () => document.body.dataset.screen === 'picker' && location.hash === '#/missions'),
    'back on the picker mid-load',
  );

  await go(page, '#/demo/battle');
  H.ok(await onLoadingCard(page), 're-entry parks its own loading card rather than returning early');

  H.ok(await onDemo(page), 'the demo renders when the module lands, from the SECOND entry');

  const st = await page.evaluate(screenState);
  H.ok(st.visible.length === 1 && st.visible[0] === 'demo', `exactly the demo screen is visible (${st.visible})`);
  H.ok(st.dataset === 'demo' && st.hash === '#/demo/battle', 'the router and the hash agree');
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  H.ok(hits() >= 1, `the round module was requested (${hits()}x)`);
  await ctx.close();
}

// ------------------------------------------------------------- B. demo -> connect(same id) -> demo

H.section('B: demo -> the same robot brief -> demo, inside one load');
{
  const { ctx, page, errors } = await openThrottled();

  await go(page, '#/demo/battle');
  H.ok(await onLoadingCard(page), 'the loading card is parked');

  await go(page, '#/connect/battle');
  H.ok(
    await waitFor(
      page,
      () => {
        const el = document.getElementById('screen-connect');
        const m = document.getElementById('ingest-mount');
        return (
          !!el && !el.hidden && location.hash === '#/connect/battle' &&
          !!m && !/Loading the simulated round/i.test(m.textContent || '') && (m.textContent || '').trim().length > 0
        );
      },
      12000,
      'the brief screen',
    ),
    'the brief renders over the loading card, not beside it',
  );

  await go(page, '#/demo/battle');
  H.ok(await onDemo(page), 'returning to the demo renders it');

  const st = await page.evaluate(screenState);
  H.ok(st.visible.length === 1 && st.visible[0] === 'demo', `exactly the demo screen is visible (${st.visible})`);
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  await ctx.close();
}

// ------------------------------------------------------------- C. the plain path still works

H.section('C: the undisturbed path is unchanged');
{
  const { ctx, page, errors } = await openThrottled();
  await go(page, '#/demo/battle');
  H.ok(await onDemo(page), 'demo -> wait -> demo renders with no navigation at all');
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  await ctx.close();
}

// ------------------------------------------------------------- D. corrupt round module

H.section('D: a corrupt round module lands on the unavailable card');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Valid JS, valid ABI symbols, garbage payload: the module EVALUATES (so this is the retryable
  // decode path, not the reload-required eval path) and the decoder throws on it.
  await page.route('**/robots/battle/battle-data.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: [
        "export const DATASET_HASH = 'corrupt';",
        'export const FORMAT_VERSION = 1;',
        "export const VARIANT = 'match';",
        'export const META = { corrupt: true };',
        "export const BLOB_B64 = 'AAAA';",
      ].join('\n'),
    }),
  );
  await page.goto(`${server.origin}/demo/#/missions`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => document.body.dataset.screen === 'picker');
  await go(page, '#/demo/battle');
  H.ok(
    await waitFor(
      page,
      () => {
        const m = document.getElementById('ingest-mount');
        return !!m && /could not be loaded/i.test(m.textContent || '');
      },
      20000,
      'the unavailable card',
    ),
    'the demo route lands on the unavailable card instead of a half-built demo',
  );
  const st = await page.evaluate(screenState);
  H.ok(st.visible.length === 1 && st.visible[0] === 'connect', `the card parks on the connect screen (${st.visible})`);
  H.ok(errors.length === 0, `the failure is handled, not thrown (${errors.slice(0, 2).join(' | ')})`);
  await ctx.close();
}

// ------------------------------------------------------------- E. corrupt preview slice

H.section('E: a corrupt preview slice degrades the picker card');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Every card ALWAYS carries its SVG; a live preview merely hides it behind `.preview-live`. So
  // "the SVG exists" proves nothing. This sequence proves the corrupt path actually RAN: the
  // interception fired, the module decoded to null, the card never got `.preview-live`, the brief
  // hero mounts no WebGL rig, and the full demo (whose round module is untouched) still works.
  // Teeth were mutation-verified: breaking the route glob fails four of these checks.
  let previewHits = 0;
  await page.route('**/robots/battle/preview-data.js', (route) => {
    previewHits++;
    return route.fulfill({
      contentType: 'text/javascript',
      body: [
        "export const DATASET_HASH = 'corrupt';",
        'export const FORMAT_VERSION = 1;',
        "export const VARIANT = 'preview';",
        'export const META = { corrupt: true };',
        "export const BLOB_B64 = 'AAAA';",
      ].join('\n'),
    });
  });
  await page.goto(`${server.origin}/demo/#/missions`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => document.body.dataset.screen === 'picker');
  // Give the idle preview builder time to run against the corrupt slice.
  await page.waitForTimeout(3500);
  H.ok(previewHits >= 1, `the corrupt preview module was actually served (${previewHits}x)`);
  const st = await page.evaluate(async () => {
    const d = await import('/demo/js/robots/battle/data.js');
    const a = document.querySelector('#robot-grid a.rcard[data-robot="battle"]');
    const art = a && a.querySelector('.rcard-art');
    return {
      preview: d.previewData,
      card: !!a,
      svg: !!(a && a.querySelector('svg')),
      live: !!(art && art.classList.contains('preview-live')),
    };
  });
  H.ok(st.preview === null, 'previewData decoded to null instead of throwing out of the module');
  H.ok(st.card, 'the battle card is on the picker');
  H.ok(st.svg, 'and it keeps its SVG line art');
  H.ok(!st.live, 'and never claims a live preview it does not have');
  await go(page, '#/connect/battle');
  H.ok(
    await waitFor(
      page,
      () => {
        const el = document.getElementById('screen-connect');
        return !!el && !el.hidden && location.hash === '#/connect/battle';
      },
      12000,
      'the brief screen',
    ),
    'the brief route still renders with the preview slice broken',
  );
  const brief = await page.evaluate(() => {
    const m = document.getElementById('ingest-mount');
    return { svg: !!(m && m.querySelector('svg')), canvas: !!(m && m.querySelector('canvas')) };
  });
  H.ok(brief.svg, 'the brief hero falls back to the SVG line art');
  H.ok(!brief.canvas, 'no empty WebGL rig is mounted with nothing to pose in it');
  // The round module is untouched by this corruption: the demo route must still fully mount.
  await go(page, '#/demo/battle');
  H.ok(await onDemo(page), 'the full demo still mounts, because only the preview slice was corrupt');
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  await ctx.close();
}

await browser.close();
await server.close();
H.done();
