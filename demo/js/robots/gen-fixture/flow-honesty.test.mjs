// flow-honesty.test.mjs - permanent gates for the post-review honesty and action hierarchy fixes.

import { inflateSync } from 'node:zlib';
import { serve, loadPlaywright, launchChromium, harness, waitFor } from './browser-fixture.mjs';
import arm6Def from '../arm6/script.js';
import droneDef from '../drone/script.js';
import sslDef from '../ssl/script.js';
import donnaDef from '../donna/script.js';

const H = harness('flow-honesty');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const T_FAIL = 61.2;
const ACTIVE_DEFS = new Map([
  [arm6Def.id, arm6Def],
  [droneDef.id, droneDef],
  [sslDef.id, sslDef],
  [donnaDef.id, donnaDef],
]);
const LAZY_SIDE_MODULES = {
  ssl: '**/robots/ssl/role-openers.js',
  donna: '**/robots/donna/experience.js',
};

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buffer) {
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('Screenshot is not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNG screenshots are unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upperLeft = prev && x >= channels ? prev[x - channels] : 0;
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = (value + left) & 255;
      else if (filter === 2) row[x] = (value + up) & 255;
      else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (value + paeth(left, up, upperLeft)) & 255;
      else throw new Error(`Unsupported PNG filter ${filter}`);
    }
  }
  return { width, height, channels, pixels };
}

function countAlertPixels(buffer) {
  const { width, height, channels, pixels } = decodePng(buffer);
  let count = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (Math.abs(r - 255) <= 30 && Math.abs(g - 95) <= 30 && Math.abs(b - 87) <= 30) count++;
  }
  return count;
}

function tape(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('crash', () => pageErrors.push('page crashed'));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

async function newContext(browser, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => {
    localStorage.setItem('alloy_signup_seen', String(Date.now()));
    localStorage.setItem('alloy_demo_role', 'engineer');
    sessionStorage.clear();
  });
  return ctx;
}

async function waitForArg(page, fn, arg, timeoutMs = 30000, label = '') {
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

async function waitStep(page, id, step, timeout = 70000) {
  return waitForArg(
    page,
    ([mission, expectedStep]) =>
      document.body.dataset.screen === 'flow' &&
      location.hash === `#/connect/${mission}/${expectedStep}` &&
      window.__flow?.def?.id === mission &&
      window.__flow?.step === expectedStep,
    [id, step],
    timeout,
    `${id}/${step}`,
  );
}

async function visibleCount(page, selector) {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].filter((el) => {
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    }).length,
  selector);
}

async function finishStreaming(page, timeout = 30000) {
  const started = await waitFor(page, () => !!window.__demo?.chat?.streaming, timeout, 'chat streaming');
  if (started) await page.evaluate(() => window.__demo.chat.finishStreaming());
  return waitFor(page, () => !!window.__demo && !window.__demo.chat.streaming, timeout, 'chat settled');
}

async function legacyState(page) {
  return page.evaluate(() => ({
    hash: location.hash,
    screen: document.body.dataset.screen,
    provenance: (document.querySelector('#ingest-mount .ctx-prov')?.textContent || '').trim(),
    flow: !!window.__flow,
  }));
}

const server = await serve();
const browser = await launchChromium(pw);

try {
  H.section('drone trail geometry is honest before and after the failure boundary');
  {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const errors = tape(page);
    await page.goto(`${server.origin}/demo/#/connect/drone/mission`, { waitUntil: 'domcontentloaded', timeout: 70000 });
    H.ok(await waitStep(page, 'drone', 'mission'), 'drone success step renders');
    H.ok(
      await waitFor(page, () => !!window.__flow?.viewer && !!document.querySelector('#flow-viewer-mount canvas.v-canvas'), 15000, 'drone viewer'),
      'drone success viewer mounts',
    );
    await page.waitForTimeout(250);

    const structure = await page.evaluate((tFail) => {
      const def = window.__flow.def;
      const pos = def.buildData()['/pos'];
      const sampledTimes = [];
      for (let i = 0; i < pos.t.length; i += 3) sampledTimes.push(pos.t[i]);
      const expectedFirstRedIndex = sampledTimes.findIndex((t) => t >= tFail);
      const lines = [];
      window.__flow.viewer.scene.traverse((obj) => {
        if (!obj.isLine || obj.isLineSegments) return;
        const position = obj.geometry?.attributes?.position;
        if (!position || position.count !== sampledTimes.length) return;
        const color = obj.geometry.attributes.color;
        let redVerts = 0;
        let firstRedIndex = -1;
        if (color) {
          for (let i = 0; i < color.count; i++) {
            if (color.getX(i) > 0.9 && color.getY(i) < 0.2 && color.getZ(i) < 0.2) {
              redVerts++;
              if (firstRedIndex < 0) firstRedIndex = i;
            }
          }
        }
        lines.push({
          vertexCount: position.count,
          hasColorAttribute: !!color,
          vertexColors: !!obj.material.vertexColors,
          opacity: obj.material.opacity,
          redVerts,
          firstRedIndex,
        });
      });
      return {
        lines,
        expectedFirstRedIndex,
        expectedFirstRedTime: sampledTimes[expectedFirstRedIndex],
        previousSampleTime: sampledTimes[expectedFirstRedIndex - 1],
        expectedRedVerts: sampledTimes.length - expectedFirstRedIndex,
        loopWindow: window.__flow.timeline.loopWindow,
        t: window.__flow.timeline.t,
      };
    }, T_FAIL);

    const live = structure.lines.find((line) => line.hasColorAttribute);
    const ghost = structure.lines.find((line) => !line.hasColorAttribute);
    H.ok(structure.lines.length === 2, `drone scene has exactly one live and one ghost trail (${structure.lines.length})`);
    H.ok(!!ghost && !ghost.hasColorAttribute, 'the future ghost trail has no color attribute');
    H.ok(!!ghost && ghost.redVerts === 0, `the future ghost trail has zero alert-red vertices (${ghost?.redVerts})`);
    H.ok(!!live && live.vertexColors, 'the live trail owns the per-vertex color treatment');
    H.ok(
      structure.previousSampleTime < T_FAIL && structure.expectedFirstRedTime >= T_FAIL,
      `the sampled failure boundary brackets ${T_FAIL} s (${structure.previousSampleTime} < ${T_FAIL} <= ${structure.expectedFirstRedTime})`,
    );
    H.ok(
      !!live && live.firstRedIndex === structure.expectedFirstRedIndex,
      `the live trail first turns red at the first sampled t >= ${T_FAIL} (${live?.firstRedIndex}/${structure.expectedFirstRedIndex})`,
    );
    H.ok(
      !!live && live.redVerts === structure.expectedRedVerts,
      `every live-trail vertex from the failure sample onward is red (${live?.redVerts}/${structure.expectedRedVerts})`,
    );

    const shot = await page.locator('#flow-viewer-mount canvas.v-canvas').screenshot({ type: 'png' });
    const alertPixels = countAlertPixels(shot);
    H.ok(alertPixels === 0, `one drone success-loop canvas sample has no alert-red pixels (${alertPixels})`);
    H.ok(errors.pageErrors.length === 0, `drone structure probe has no page errors (${errors.pageErrors.join(' | ')})`);
    H.ok(errors.consoleErrors.length === 0, `drone structure probe has no console errors (${errors.consoleErrors.join(' | ')})`);
    await ctx.close();
  }

  H.section('flow provenance is verbatim wherever each mission keeps it');
  {
    const ctx = await newContext(browser, { width: 390, height: 844 });
    const page = await ctx.newPage();
    const errors = tape(page);
    for (const id of ['ssl', 'donna', 'arm6', 'drone']) {
      const expected = ACTIVE_DEFS.get(id).context?.provenance || '';
      await page.goto(`${server.origin}/demo/#/connect/${id}/robot`, { waitUntil: 'domcontentloaded', timeout: 70000 });
      H.ok(await waitStep(page, id, 'robot'), `${id} robot step renders`);
      const robot = await page.evaluate((expectedText) => {
        const el = document.getElementById('flow-provenance');
        const style = el ? getComputedStyle(el) : null;
        return {
          text: el?.textContent || '',
          visible: !!el && !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0,
          expectedPresent: !!expectedText.trim(),
          step: window.__flow.step,
        };
      }, expected);

      if (id === 'ssl' || id === 'donna') {
        H.ok(robot.expectedPresent && robot.visible, `${id} discloses provenance on step 1 before the failure step`);
        H.ok(robot.text === expected, `${id} robot step renders context.provenance verbatim`);
        H.ok(['robot', 'mission', 'failure', 'choose'].indexOf(robot.step) < 2, `${id} provenance first appears before step 3 failure`);
      } else {
        H.ok(robot.visible === robot.expectedPresent, `${id} robot provenance presence matches the definition (${robot.expectedPresent})`);
        H.ok(!robot.expectedPresent || robot.text === expected, `${id} robot provenance copy matches the definition when present`);
      }

      await page.evaluate((mission) => { location.hash = `#/connect/${mission}/failure`; }, id);
      H.ok(await waitStep(page, id, 'failure'), `${id} failure step renders`);
      const failure = await page.evaluate((expectedText) => {
        const el = document.getElementById('flow-provenance');
        const style = el ? getComputedStyle(el) : null;
        return {
          text: el?.textContent || '',
          visible: !!el && !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0,
          expectedPresent: !!expectedText.trim(),
        };
      }, expected);
      if (id === 'ssl') {
        H.ok(!failure.visible, 'ssl failure step removes the bottom provenance block');
        H.ok(failure.text === '', 'ssl failure step clears provenance text');
      } else {
        H.ok(failure.visible === failure.expectedPresent, `${id} failure provenance presence matches the definition (${failure.expectedPresent})`);
        H.ok(!failure.expectedPresent || failure.text === expected, `${id} failure step renders context.provenance verbatim when present`);
      }
    }
    H.ok(errors.pageErrors.length === 0, `provenance route walk has no page errors (${errors.pageErrors.join(' | ')})`);
    H.ok(errors.consoleErrors.length === 0, `provenance route walk has no console errors (${errors.consoleErrors.join(' | ')})`);
    await ctx.close();
  }

  H.section('lazy side-module 404s fall back before and after settlement');
  for (const id of ['ssl', 'donna']) {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const errors = tape(page);
    let release404;
    let markRequested;
    let markFulfilled;
    const held = new Promise((resolve) => { release404 = resolve; });
    const requested = new Promise((resolve) => { markRequested = resolve; });
    const fulfilled = new Promise((resolve) => { markFulfilled = resolve; });
    await page.route(LAZY_SIDE_MODULES[id], async (route) => {
      markRequested();
      await held;
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      markFulfilled();
    });

    await page.goto(`${server.origin}/demo/#/connect/${id}/failure`, { waitUntil: 'domcontentloaded', timeout: 70000 });
    await Promise.race([
      requested,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${id} side-module request timeout`)), 70000)),
    ]);
    H.ok(
      await waitForArg(page, (mission) => location.hash === `#/connect/${mission}/failure` && document.body.dataset.screen === 'connect', id, 10000, `${id} pending step route`),
      `${id} step route is entered before its side module settles`,
    );
    release404();
    await fulfilled;
    H.ok(
      await waitForArg(
        page,
        (mission) => document.body.dataset.screen === 'connect' && location.hash === `#/connect/${mission}` && !!document.querySelector('#ingest-mount .ctx-prov'),
        id,
        45000,
        `${id} legacy fallback before settlement`,
      ),
      `${id} pre-settlement step entry falls back to the legacy brief`,
    );
    const before = await legacyState(page);
    const expected = ACTIVE_DEFS.get(id).context.provenance.trim();
    H.ok(before.provenance === expected, `${id} pre-settlement fallback keeps provenance verbatim`);
    H.ok(!before.flow, `${id} pre-settlement fallback leaves no flow instance`);

    await page.evaluate(() => { location.hash = '#/missions'; });
    H.ok(await waitFor(page, () => document.body.dataset.screen === 'picker', 15000, `${id} picker between entries`), `${id} can leave the fallback brief`);
    await page.evaluate((mission) => { location.hash = `#/connect/${mission}/failure`; }, id);
    H.ok(
      await waitForArg(
        page,
        (mission) => document.body.dataset.screen === 'connect' && location.hash === `#/connect/${mission}` && !!document.querySelector('#ingest-mount .ctx-prov'),
        id,
        15000,
        `${id} legacy fallback after settlement`,
      ),
      `${id} post-settlement step entry also falls back to the legacy brief`,
    );
    const after = await legacyState(page);
    H.ok(after.provenance === expected, `${id} post-settlement fallback keeps provenance verbatim`);
    H.ok(!after.flow, `${id} post-settlement fallback leaves no flow instance`);
    H.ok(errors.pageErrors.length === 0, `${id} side-module 404 paths have no page errors (${errors.pageErrors.join(' | ')})`);
    await ctx.close();
  }

  H.section('chat, proof and follow-up keep one honest primary action');
  {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const errors = tape(page);
    await page.route('**/demo/api/chat', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
        body: 'data: {"type":"delta","text":"The follow-up is ready."}\n\ndata: {"type":"done","evidence":[]}\n\n',
      }),
    );
    await page.goto(`${server.origin}/demo/#/demo/arm6`, { waitUntil: 'domcontentloaded', timeout: 70000 });
    H.ok(
      await waitFor(page, () => document.body.dataset.screen === 'demo' && window.__demo?.mode === 'chat', 15000, 'arm6 chat mode'),
      'demo enters chat mode',
    );
    H.ok((await visibleCount(page, '#screen-demo .demo-ctas [data-cta]')) === 0, 'chat mode hides every header acquisition CTA');
    H.ok(await finishStreaming(page), 'the first answer settles');
    H.ok(
      await waitFor(page, () => document.getElementById('screen-demo').dataset.mode === 'proof', 10000, 'arm6 proof mode'),
      'the first answer opens proof mode',
    );
    H.ok((await visibleCount(page, '#screen-demo .demo-ctas [data-cta]')) === 2, 'proof mode shows both header CTAs on desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    H.ok((await visibleCount(page, '#screen-demo .demo-ctas [data-cta]')) === 0, 'proof mode hides header CTAs on mobile');
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.fill('.chat-input', 'Show me the evidence again.');
    await page.click('.chat-form button[type="submit"]');
    H.ok(
      await waitFor(page, () => document.getElementById('screen-demo').dataset.mode === 'followup', 10000, 'arm6 follow-up mode'),
      'a typed question opens follow-up mode',
    );
    H.ok((await visibleCount(page, '#screen-demo .demo-ctas [data-cta]')) === 0, 'follow-up mode hides every header acquisition CTA');
    H.ok(await finishStreaming(page), 'the follow-up answer settles');
    H.ok(
      await waitFor(page, () => document.getElementById('screen-demo').classList.contains('show-why-pending'), 10000, 'Show why pending state'),
      'the pending Show why state is explicit',
    );
    H.ok((await visibleCount(page, '#screen-demo .chat-form')) === 0, 'the composer is hidden while Show why is pending');
    const primaryActions = await visibleCount(page, '#screen-demo:not([hidden]) .guide-cta[data-primary]:not(:disabled)');
    H.ok(primaryActions === 1, `exactly one enabled [data-primary] action exists while Show why is pending (${primaryActions})`);
    H.ok(errors.pageErrors.length === 0, `CTA hierarchy walk has no page errors (${errors.pageErrors.join(' | ')})`);
    H.ok(errors.consoleErrors.length === 0, `CTA hierarchy walk has no console errors (${errors.consoleErrors.join(' | ')})`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}

H.done();
