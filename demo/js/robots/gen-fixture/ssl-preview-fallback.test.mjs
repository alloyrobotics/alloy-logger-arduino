// ssl-preview-fallback.test.mjs - a corrupt preview payload degrades, it does not throw.
//
//   node demo/js/robots/gen-fixture/ssl-preview-fallback.test.mjs
//
// `data.js` decodes the 5.9 s preview slice at module scope inside a try/catch and sets
// `previewData = null` on failure, with a comment promising graceful degradation. It was not
// graceful. `buildConnect()` read that null as "legacy robot, build its telemetry" and called
// `ensureData()`, which deliberately THROWS while the lazy match payload is unloaded - on a route
// with no error handling. A single bad byte in a generated module took the brief screen down.
//
// The fixture is the real module with its blob mangled, served in place of the real one, so the
// failure is the failure the decoder would actually hit rather than a stubbed exception. Then:
// picker, brief and demo are all driven and all have to survive it, with the card and the hero
// falling back to their SVG line art the same way the no-WebGL path does.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, loadPlaywright, launchChromium, harness, waitFor, ROOT } from './browser-fixture.mjs';

const H = harness('ssl-preview-fallback');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const PREVIEW = path.join(ROOT, 'demo', 'js', 'robots', 'ssl', 'preview-data.js');
const real = await readFile(PREVIEW, 'utf8');

/**
 * Mangle the blob, not the module. It still parses, still evaluates with no side effects, still
 * exports the same names - and then decodes to nonsense, which is the interesting failure. A
 * module that fails to PARSE is the other case and it is handled elsewhere (the unavailable card
 * distinguishes a retryable decode from a module-map-cached evaluation failure).
 */
const corrupt = real.replace(
  /(export const BLOB_B64 =\s*")([^"]+)(";)/,
  (_m, a, b, c) => `${a}${b.slice(0, 40)}${c}`,
);
if (corrupt === real) {
  console.error('FAIL  could not find BLOB_B64 in preview-data.js to corrupt');
  process.exit(1);
}

const server = await serve();
const browser = await launchChromium(pw);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.route('**/robots/ssl/preview-data.js', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
    body: corrupt,
  }),
);

await page.goto(`${server.origin}/demo/#/missions`, { waitUntil: 'domcontentloaded' });

// ---------------------------------------------------------------- the module itself

H.section('module');
{
  H.ok(
    await waitFor(page, () => document.body.dataset.screen === 'picker', 10000, 'the picker'),
    'the page boots with a corrupt preview payload',
  );
  const st = await page.evaluate(async () => {
    const d = await import('/demo/js/robots/ssl/data.js');
    return {
      preview: d.previewData,
      sceneData: d.getSceneData(),
      loaded: d.isSceneDataLoaded(),
    };
  });
  H.ok(st.preview === null, 'previewData decoded to null instead of throwing out of the module');
  H.ok(st.sceneData === null, 'getSceneData() reports that it has nothing, rather than a half-object');
  H.ok(st.loaded === false, 'the match payload is still unloaded');
}

// ---------------------------------------------------------------- picker

H.section('picker');
{
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.rcard')].map((a) => ({
      id: a.dataset.robot,
      live: a.querySelector('.rcard-art').classList.contains('preview-live'),
      svg: !!a.querySelector('.rcard-art svg'),
      tag: (a.querySelector('.rcard-tag').textContent || '').trim(),
    })),
  );
  H.ok(cards.length === 4, `all four public cards are on the picker (${cards.length})`);
  const ssl = cards.find((c) => c.id === 'ssl');
  H.ok(!!ssl, 'the SSL card is built');
  H.ok(ssl && ssl.svg, 'the SSL card keeps its SVG line art');
  H.ok(
    ssl && ssl.tag === 'A real match replay, three planted faults, one real tracking loss',
    `the SSL card still carries its tagline ("${ssl && ssl.tag}")`,
  );
  // give the idle preview builder a chance to do the wrong thing before asserting it did not
  await page.waitForTimeout(1800);
  const stillDark = await page.evaluate(() =>
    document.querySelector('.rcard[data-robot="ssl"] .rcard-art').classList.contains('preview-live'),
  );
  H.ok(!stillDark, 'the SSL card is never handed to the live preview with no payload to draw');
  const others = await page.evaluate(() =>
    [...document.querySelectorAll('.rcard')]
      .filter((a) => a.dataset.robot !== 'ssl')
      .map((a) => a.querySelector('.rcard-art').classList.contains('preview-live')),
  );
  H.ok(others.length === 3, `the non-SSL public roster contains three cards (${others.length})`);
  H.ok(others.some(Boolean), 'the other three cards still preview normally');
  H.ok(errors.length === 0, `no uncaught page errors on the picker (${errors.slice(0, 2).join(' | ')})`);
}

// ---------------------------------------------------------------- robot step

H.section('robot step');
{
  await page.evaluate(() => { location.hash = '#/connect/ssl'; });
  H.ok(
    await waitFor(
      page,
      () =>
        document.body.dataset.screen === 'flow' &&
        location.hash === '#/connect/ssl/robot' &&
        !!window.__flow && window.__flow.step === 'robot',
      20000,
      'the robot step',
    ),
    'the experience redirect renders the robot step rather than throwing',
  );
  const step = await page.evaluate(async () => {
    const def = (await import('/demo/js/robots/ssl/script.js')).default;
    return {
      title: (document.getElementById('flow-title').textContent || '').trim(),
      cta: (document.getElementById('flow-cta').textContent || '').replace(/\s+/g, ' ').trim(),
      svg: !!document.querySelector('#flow-fallback svg'),
      canvas: !!document.querySelector('#flow-viewer-mount canvas'),
      provenance: (def.context && def.context.provenance) || '',
    };
  });
  H.ok(step.title === 'SSL soccer fleet', `the robot step identifies the mission ("${step.title}")`);
  H.ok(step.svg || step.canvas, 'the robot step keeps a visual surface while the full payload recovers');
  H.ok(/Next: the mission/.test(step.cta), `the flow remains completable ("${step.cta}")`);
  H.ok(/synthes/i.test(step.provenance), 'the definition retains its authored provenance disclosure');
  const roundWord = new RegExp(`\\b${['fin', 'al'].join('')}s?\\b`, 'i');
  H.ok(!roundWord.test(step.provenance), 'the disclosure avoids the banned round-stage label');
  H.ok(errors.length === 0, `no uncaught page errors on the robot step (${errors.slice(0, 2).join(' | ')})`);
  const tripwire = consoleErrors.filter((t) => /ensureData\(ssl\)/.test(t));
  H.ok(tripwire.length === 0, `ensureData's tripwire never fires (${tripwire.length} hits)`);
}

// ---------------------------------------------------------------- demo

H.section('demo');
{
  // The match module is untouched, so the demo itself must still work: a broken PREVIEW is not a
  // broken mission, and degrading the two staged screens must not cost the visitor the replay.
  await page.evaluate(() => { location.hash = '#/demo/ssl'; });
  H.ok(
    await waitFor(
      page,
      () => {
        const el = document.getElementById('screen-demo');
        return !!el && !el.hidden && !!el.querySelector('canvas') && document.body.dataset.screen === 'demo';
      },
      20000,
      'the demo screen',
    ),
    'the demo still loads and mounts its viewer',
  );
  H.ok(
    await page.evaluate(() => !!document.querySelector('.v-shud:not([hidden])')),
    'the HUD strip is live, so the match payload really decoded',
  );
  H.ok(errors.length === 0, `no uncaught page errors on the demo (${errors.slice(0, 2).join(' | ')})`);
}

await ctx.close();
await browser.close();
await server.close();
H.done();
