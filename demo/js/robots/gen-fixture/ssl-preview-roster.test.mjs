// ssl-preview-roster.test.mjs - the preview draws the robots the slice tracked, and no others.
//
//   node demo/js/robots/gen-fixture/ssl-preview-roster.test.mjs
//
// The failure this pins: two robots STACKED ON THE CENTRE SPOT in the picker card and the brief
// hero. The preview slice is 6 s cut out of the middle of a 110 s window, and two of the match's
// nineteen robots are in no tracked frame anywhere inside it. They were still carried in the
// slice's roster with `nPresent: 0`, and a robot with no presence run has nothing for the decoder's
// hold-fill to hold: every pose component decodes to zero. The scene then built geometry for them,
// found them at full opacity (no absence run to fade against), and posed them both at (0, 0).
//
// Two independent fixes, and this file drives each on its own:
//
//   1  THE EXPORT. `export_web.py` omits a zero-presence robot from the preview variant's roster -
//      bitmap blocks, column chunks and META.robots together. Asserted here against the SHIPPED
//      module: the roster is what the slice tracked, and the rendered scene shows exactly it.
//
//   2  THE SCENE. `scene.js` keeps a robot hidden until its first tracked sample, so a payload
//      that does carry one cannot put a phantom on the centre spot. Asserted against a decoded
//      payload with a fabricated zero-presence robot spliced into it, which is what a future
//      export regression would hand the page.
//
// Decode statistics alone cannot see this: the popcounts were always right, and every check in
// ssl-data.test.mjs passed while the card drew two robots on top of each other. So the assertion
// here is on the RENDER - the scene graph the preview builds, at the hero instant it is posed at.

import { serve, loadPlaywright, launchChromium, harness, waitFor } from './browser-fixture.mjs';

const H = harness('ssl-preview-roster');
const pw = await loadPlaywright();
if (!pw) H.skip('playwright not resolvable on this machine');

const server = await serve();
const browser = await launchChromium(pw);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${server.origin}/demo/`, { waitUntil: 'domcontentloaded' });
await waitFor(page, () => document.body.dataset.screen === 'picker', 10000, 'the picker');

/**
 * Build the SSL scene exactly the way `core/preview.js` builds a picker card - buildScene() into a
 * bare Group, one update() at the def's own hero time - and read back what the scene graph holds.
 * No renderer: the property is which robots the scene POSED and left visible, which is scene-graph
 * state, not pixels, and reading it directly is what makes the assertion exact.
 *
 * `mutate` runs on the decoded payload before the scene sees it.
 */
const renderRoster = async (mutateSrc) =>
  page.evaluate(async (src) => {
    const THREE = await import('/demo/vendor/three.module.js');
    const def = (await import('/demo/js/robots/ssl/script.js')).default;
    const data = def.getSceneData();
    // eslint-disable-next-line no-new-func
    if (src) new Function('data', src)(data);
    const mount = new THREE.Group();
    const api = def.buildScene(THREE, mount);
    api.update(def.heroTime(), data);
    const bots = [];
    mount.traverse((o) => {
      if (!/^bot_[yb]\d+$/.test(o.name || '')) return;
      bots.push({
        name: o.name,
        visible: o.visible,
        // world visibility: a hidden ancestor hides the group whatever its own flag says
        drawn: o.visible && (!o.parent || o.parent.visible),
        x: Number(o.position.x.toFixed(4)),
        z: Number(o.position.z.toFixed(4)),
      });
    });
    if (typeof api.dispose === 'function') api.dispose();
    return {
      variant: data.variant,
      heroTime: def.heroTime(),
      roster: data.robots.map((r) => ({ key: r.key, nPresent: r.nPresent })),
      bots,
    };
  }, mutateSrc || '');

// ---------------------------------------------------------------- the shipped preview slice

H.section('the shipped preview roster');
let shipped = null;
{
  shipped = await renderRoster(null);
  H.ok(shipped.variant === 'preview', `the picker and the brief pose the preview slice (${shipped.variant})`);
  const zero = shipped.roster.filter((r) => r.nPresent === 0);
  H.ok(
    zero.length === 0,
    `no robot in the preview roster is absent for the whole slice (${zero.map((r) => r.key).join(', ') || 'none'})`,
  );
  H.ok(shipped.roster.length > 0, `the slice tracked ${shipped.roster.length} robots`);
}

// ---------------------------------------------------------------- what the scene actually draws

H.section('the rendered scene at the hero instant');
{
  const drawn = shipped.bots.filter((b) => b.drawn);
  H.ok(
    shipped.bots.length === shipped.roster.length,
    `the scene builds one group per roster entry (${shipped.bots.length} of ${shipped.roster.length})`,
  );
  H.ok(
    drawn.length === shipped.roster.length,
    `every roster robot is visible at the hero instant (${drawn.length} of ${shipped.roster.length})`,
  );
  const names = new Set(shipped.roster.map((r) => r.key));
  const extra = drawn.filter((b) => !names.has(b.name));
  H.ok(extra.length === 0, `and nothing outside the roster is drawn (${extra.map((b) => b.name).join(', ') || 'none'})`);

  // The failure signature itself: a robot standing on the centre spot, and two robots on the same
  // spot. Both are things the hold-filled zero produced and neither is a pose the tracker reported.
  const atOrigin = drawn.filter((b) => Math.abs(b.x) < 1e-3 && Math.abs(b.z) < 1e-3);
  H.ok(
    atOrigin.length === 0,
    `no robot is posed on the centre spot (${atOrigin.map((b) => b.name).join(', ') || 'none'})`,
  );
  const seen = new Map();
  const stacked = [];
  for (const b of drawn) {
    const k = `${b.x},${b.z}`;
    if (seen.has(k)) stacked.push(`${seen.get(k)}+${b.name}`);
    else seen.set(k, b.name);
  }
  H.ok(stacked.length === 0, `no two robots share a position (${stacked.join(', ') || 'none'})`);
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
}

// ---------------------------------------------------------------- the scene's own guard

H.section('a zero-presence robot in the payload is never drawn');
{
  // Splice in the robot the export now omits: same shape as a decoded robot, presence mask all
  // zeros, every pose column zero-filled - which is exactly what the decoder produces for a robot
  // with no presence run. If the scene ever poses this, the card is back to a phantom on the spot.
  const inject = `
    const n = data.tRobot.length;
    const zeros = () => new Float32Array(n);
    data.robots.push({
      refereeColor: 'blue', id: 99, key: 'bot_b99', name: 'blue99',
      team: data.teams ? data.teams.blue : null,
      present: new Uint8Array(n), runs: [],
      x: zeros(), y: zeros(), yaw: zeros(), vx: zeros(), vy: zeros(), w: zeros(),
      vis: zeros(), nPresent: 0, presentFrac: 0,
    });
  `;
  const r = await renderRoster(inject);
  const ghost = r.bots.find((b) => b.name === 'bot_b99');
  H.ok(!!ghost, 'the fabricated robot really did reach the scene builder');
  H.ok(ghost && !ghost.drawn, 'and the scene keeps it hidden: it has no tracked pose to draw');
  const drawn = r.bots.filter((b) => b.drawn);
  H.ok(
    drawn.length === shipped.roster.length,
    `the real roster is unaffected (${drawn.length} drawn, ${shipped.roster.length} expected)`,
  );
  const atOrigin = drawn.filter((b) => Math.abs(b.x) < 1e-3 && Math.abs(b.z) < 1e-3);
  H.ok(atOrigin.length === 0, `still nothing on the centre spot (${atOrigin.map((b) => b.name).join(', ') || 'none'})`);
  H.ok(errors.length === 0, `no uncaught page errors (${errors.slice(0, 2).join(' | ')})`);
}

await ctx.close();
await browser.close();
await server.close();
H.done();
