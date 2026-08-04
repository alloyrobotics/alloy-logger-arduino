// ssl-nav-race.test.mjs - the lazy scene payload cannot strand a visitor on the wrong screen.
//
//   node demo/js/robots/gen-fixture/ssl-nav-race.test.mjs
//
// The SSL match module is ~700 KB and arrives on the way into the demo screen, so there is a
// window of a second or two in which the visitor is looking at a loading card and can navigate.
// `resolveSceneData()` used to suppress every route entry after the first for a given robot id
// while a load was in flight. The load itself is deduplicated inside the def, so that suppression
// bought nothing - and it cost the second entry its continuation, while the FIRST continuation,
// tied to a navigation generation that had since moved on, correctly refused to touch the screen.
// Nothing then rendered the route. The hash said `#/demo/ssl` on top of the picker, permanently.
//
// Both sequences below reach that state through ordinary browsing, which is why this test throttles
// the import rather than reasoning about it: the race is real time, so the assertion is real time.
//
//   A  demo -> back to the picker -> the same demo again, all inside the load
//   B  demo -> the same robot's anatomy step -> demo again, all inside the load
//
// A fresh page per sequence, because a module already in the browser's module map never arrives
// late a second time.

import { serve, loadPlaywright, launchChromium, harness, waitFor, screenState } from './browser-fixture.mjs';

const H = harness('ssl-nav-race');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

/** How long match-data.js is held back. Long enough to navigate twice inside it, by hand or here. */
const DELAY_MS = 2500;

const server = await serve();
const browser = await launchChromium(pw);

/** A page whose ONLY throttled request is the match module. */
async function openThrottled() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let arrivals = 0;
  await page.route('**/robots/ssl/match-data.js', async (route) => {
    arrivals++;
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await route.continue();
  });
  // `#/missions` explicitly: `#/` is the role fork, not the four-card mission library.
  await page.goto(`${server.origin}/demo/#/missions`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(page, () => document.body.dataset.screen === 'picker');
  return { ctx, page, errors, hits: () => arrivals };
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
const onLoadingCard = (page) =>
  waitFor(
    page,
    () => {
      const m = document.getElementById('ingest-mount');
      return !!m && /Loading the match replay/i.test(m.textContent || '');
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
        location.hash === '#/demo/ssl' && !!el.querySelector('canvas')
      );
    },
    15000,
    'the demo screen',
  );

// ------------------------------------------------------------- A. demo -> picker -> same demo

H.section('A: demo -> picker -> the same demo, inside one load');
{
  const { ctx, page, errors, hits } = await openThrottled();

  await go(page, '#/demo/ssl');
  H.ok(await onLoadingCard(page), 'the loading card is parked while the module is in flight');

  await go(page, '#/missions');
  H.ok(
    await waitFor(page, () => document.body.dataset.screen === 'picker' && location.hash === '#/missions'),
    'back on the picker mid-load',
  );

  // the re-entry that used to get no continuation at all
  await go(page, '#/demo/ssl');
  H.ok(await onLoadingCard(page), 're-entry parks its own loading card rather than returning early');

  H.ok(await onDemo(page), 'the demo renders when the module lands, from the SECOND entry');

  const st = await page.evaluate(screenState);
  H.ok(st.visible.length === 1 && st.visible[0] === 'demo', `exactly the demo screen is visible (${st.visible})`);
  H.ok(st.dataset === 'demo' && st.hash === '#/demo/ssl', 'the router and the hash agree');
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  H.ok(hits() >= 1, `the match module was requested (${hits()}x)`);
  await ctx.close();
}

// ------------------------------------------------------------- B. demo -> robot step(same id) -> demo

H.section('B: demo -> the same robot anatomy step -> demo, inside one load');
{
  const { ctx, page, errors } = await openThrottled();

  await go(page, '#/demo/ssl');
  H.ok(await onLoadingCard(page), 'the loading card is parked');

  // Same id, different screen. An id-equality staleness check reads this as "unchanged", which is
  // exactly why the guard is a monotonic generation plus a hash recheck.
  await go(page, '#/connect/ssl');
  H.ok(
    await waitFor(
      page,
      () =>
        document.body.dataset.screen === 'flow' &&
        location.hash === '#/connect/ssl/robot' &&
        !!window.__flow && window.__flow.step === 'robot' &&
        document.getElementById('screen-connect').hidden,
      12000,
      'the anatomy step',
    ),
    'the anatomy step replaces the loading card for the same robot',
  );

  await go(page, '#/demo/ssl');
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
  await go(page, '#/demo/ssl');
  H.ok(await onDemo(page), 'demo -> wait -> demo renders with no navigation at all');
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
  await ctx.close();
}

await browser.close();
await server.close();
H.done();
