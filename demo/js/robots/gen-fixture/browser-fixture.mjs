// browser-fixture.mjs - shared plumbing for the two tests that can only be answered in a browser:
// the lazy-payload navigation race and the corrupt-preview fallback. Both are about what the page
// DOES when a module arrives late or broken, which no Node-side import of app.js can reproduce
// (app.js's graph reaches three.js and the DOM on the first line).
//
// Not a test on its own. This directory is in .assetsignore, so none of it is ever served.
//
// Playwright is a dev-only dependency and is not in package.json: this repo installs nothing.
// It is resolved from an npx cache if one has it, and a test that cannot find it SKIPS loudly
// rather than failing a checkout that was never going to have a browser.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * A no-store static server over the repo. No-store is not a nicety here: Chrome will happily serve
 * a stale module across a run and the whole point of these tests is WHEN a module arrives.
 */
export async function serve() {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = path.join(ROOT, rel);
    if (!abs.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(abs);
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
        'cache-control': 'no-store, no-cache, must-revalidate',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'cache-control': 'no-store' }).end('not found');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
}

/** `playwright`, wherever this machine keeps it. Null when there is none. */
export async function loadPlaywright() {
  const tryImport = async (spec) => {
    try {
      return await import(spec);
    } catch {
      return null;
    }
  };
  let pw = await tryImport('playwright');
  if (pw) return pw;
  const roots = [];
  if (process.env.PLAYWRIGHT_ROOT) roots.push(process.env.PLAYWRIGHT_ROOT);
  const npx = path.join(process.env.HOME || '', '.npm', '_npx');
  if (existsSync(npx)) {
    for (const d of await readdir(npx)) roots.push(path.join(npx, d, 'node_modules', 'playwright'));
  }
  for (const r of roots) {
    const idx = path.join(r, 'index.mjs');
    const pkg = existsSync(idx) ? idx : r;
    if (!existsSync(pkg)) continue;
    pw = await tryImport(pathToFileURL(pkg).href);
    if (pw && pw.chromium) return pw;
  }
  return null;
}

/**
 * SwiftShader, so the demo's WebGL viewer really mounts. Without it the headless GPU stack refuses
 * a context and every assertion about the demo screen becomes an assertion about the fallback.
 */
export const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
];

/**
 * Launch chromium, tolerating a playwright whose pinned browser build is not the one this machine
 * actually downloaded (an npx-cached playwright and a locally installed browser revision drift
 * apart constantly). Falls back to the newest headless shell in the standard cache.
 */
export async function launchChromium(pw) {
  try {
    return await pw.chromium.launch({ headless: true, args: LAUNCH_ARGS });
  } catch (err) {
    const cache = path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright');
    const linux = path.join(process.env.HOME || '', '.cache', 'ms-playwright');
    const base = existsSync(cache) ? cache : existsSync(linux) ? linux : null;
    if (!base) throw err;
    const dirs = (await readdir(base))
      .filter((d) => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-'))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    for (const d of dirs) {
      for (const rel of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
      ]) {
        const exe = path.join(base, d, rel);
        if (!existsSync(exe)) continue;
        return await pw.chromium.launch({ headless: true, args: LAUNCH_ARGS, executablePath: exe });
      }
    }
    throw err;
  }
}

export function harness(name) {
  let failures = 0;
  let checks = 0;
  return {
    ok(cond, msg) {
      checks++;
      if (!cond) {
        failures++;
        console.error(`  FAIL  ${msg}`);
      }
    },
    section: (n) => console.log(`\n${n}`),
    done() {
      console.log(`\n${checks - failures}/${checks} checks passed`);
      if (failures) {
        console.error(`${failures} FAILED in ${name}`);
        process.exit(1);
      }
    },
    skip(why) {
      console.log(`SKIP  ${name}: ${why}`);
      process.exit(0);
    },
  };
}

/** Poll a page predicate. Returns true on success, false on timeout - never throws. */
export async function waitFor(page, fn, timeoutMs = 12000, label = '') {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = await page.evaluate(fn);
    } catch {
      v = false;
    }
    if (v) return true;
    if (Date.now() - t0 > timeoutMs) {
      if (label) console.error(`    (timed out waiting for ${label})`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** The screen the router believes it is on, plus what is actually visible. */
export const screenState = () => ({
  hash: location.hash,
  dataset: document.body.dataset.screen,
  visible: ['picker', 'connect', 'demo'].filter((k) => {
    const el = document.getElementById(`screen-${k}`);
    return el && !el.hidden;
  }),
  ingestHtml: (document.getElementById('ingest-mount') || {}).innerHTML || '',
});
