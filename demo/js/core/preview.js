// preview.js - live 3D previews inside the picker cards.
//
// ONE WebGL context for the whole picker, never one per card. A single transparent canvas is
// absolutely positioned over the card GRID (not the viewport): it lives in the same scrolling
// content as the cards, so scrolling moves canvas and cards together natively and the previews
// cannot lag the page - a viewport-fixed canvas re-synced per frame is always one frame behind
// a scroll. Each rendered frame every card's .rcard-art rect, taken RELATIVE to the grid (both
// rects sampled in the same frame, so the difference is scroll-invariant), becomes a scissor +
// viewport pair. This is the three.js "multiple elements, one renderer" pattern, re-anchored.
//
// Perceived performance is the constraint that shapes everything here:
//   - the inline SVG line art stays in the DOM as the instant placeholder AND the no-WebGL
//     fallback. It is only faded out once its robot has actually rendered a frame.
//   - nothing is generated during the picker's first paint. Telemetry generation plus scene
//     construction happen after paint, one robot at a time, on requestIdleCallback.
//
// The models are the robots' real buildScene() rigs, posed once at a healthy hero moment (never
// the failure) and then orbited by the CAMERA. Nothing is animated per frame except the camera.

import * as THREE from 'three';
// Circular by module graph (app.js imports this file) but safe: ensureData is a hoisted function
// declaration, so its binding is initialised before any module in the cycle evaluates, and it is
// only ever called later from the idle builder. Importing it rather than re-deriving the seed
// keeps ONE data generator, which the deterministic-data rule depends on.
import { ensureData } from '../app.js';
// The staging solve itself (WebGL probe, light rig, hero pose, orbit-safe fit) is shared with the
// connect screen's hero, so it lives in stage3d.js. This module owns only the picker's one-canvas
// scissor rig and its constants.
import {
  webglAvailable,
  addStageLights,
  fitOrbit,
  heroTime,
  PICKER_ORBIT_MS,
} from './stage3d.js';

const ORBIT_MS = PICKER_ORBIT_MS; // one revolution
const DIST_SCALE = 0.9; // fallback distance, relative to the robot's own cameraHome distance
const ENV_CULL = 1.5; // hide scenery bigger than this many cameraHome distances
const ENV_RADIUS = 0.28; // and scenery whose centre sits further than this from the machine
const SUBJECT_FILL = 0.78; // share of the card's height the machine should occupy
const ASPECT_REF = 1.0; // the art panels are squares now: fit must hold at 1:1
const FOV = 34; // tighter than the viewer's 42: the card art panel is wide and short
const MIN_FRAME_MS = 1000 / 30 - 2;
const MAX_DPR = 2; // same ceiling as viewer.js and chart.js: the previews crossfade over vector art
const ORBIT_SAMPLES = 36; // azimuths the framing is checked against
const FADE_CLASS = 'preview-live';

/**
 * Live orbiting previews for the picker cards.
 *
 * @param {Array<{el:HTMLElement, def:object}>} entries one per card; `el` is the .rcard-art panel
 * @param {HTMLElement} [host] the element the shared canvas overlays; defaults to the entries'
 *   grid. Must contain every entry's el so the canvas scrolls with the cards.
 * @returns {{dispose:()=>void}}
 */
export function createPickerPreviews(entries, host) {
  const recs = (entries || [])
    .filter((e) => e && e.el && e.def && typeof e.def.buildScene === 'function')
    .map((e) => ({
      el: e.el,
      def: e.def,
      scene: null,
      camera: null,
      mount: null,
      api: null,
      ready: false,
      visible: true,
      target: new THREE.Vector3(),
      dist: 3,
      elev: 0.3,
      az0: 0,
    }));

  if (!recs.length) return { dispose() {} };

  host = host || recs[0].el.closest('#robot-grid') || recs[0].el.parentElement;
  const hostPosition = getComputedStyle(host).position;
  if (hostPosition === 'static') host.style.position = 'relative';

  let disposed = false;
  let renderer = null;
  let canvas = null;
  let raf = 0;
  let lastFrame = 0;
  let idleHandle = 0;
  let idleIsRIC = false;
  let startedAt = 0;
  let needsRender = true; // reduced-motion path renders only when something moved
  let contextLost = false;

  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ visibility
  let io = null;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (list) => {
        for (const ent of list) {
          const rec = recs.find((r) => r.el === ent.target);
          if (rec) rec.visible = ent.isIntersecting;
        }
        needsRender = true;
      },
      { rootMargin: '120px 0px' }
    );
    recs.forEach((r) => io.observe(r.el));
  }

  const markDirty = () => {
    needsRender = true;
  };
  window.addEventListener('scroll', markDirty, { passive: true, capture: true });
  window.addEventListener('resize', markDirty);
  document.addEventListener('visibilitychange', markDirty);

  // ------------------------------------------------------------------ renderer (lazy)
  function ensureRenderer() {
    if (renderer || disposed) return renderer;
    if (!webglAvailable()) return null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch (_) {
      renderer = null;
      return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(true);
    renderer.shadowMap.enabled = false;
    canvas = renderer.domElement;
    canvas.className = 'picker-preview-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    // absolute inside the grid, NOT fixed to the viewport: it scrolls with the cards natively,
    // which is what keeps the previews glued during scroll with zero per-frame chase
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    // A context can drop under us at any time (GPU-process crash, driver reset, Chrome evicting the
    // oldest context, Android backgrounding). three preventDefaults the event and re-initialises on
    // restore, but the 3D is gone in the meantime, so hand the cards back to the SVG line art -
    // the same fallback the no-WebGL path uses - instead of leaving four empty panels.
    canvas.addEventListener('webglcontextlost', () => {
      contextLost = true;
      recs.forEach((r) => r.el.classList.remove(FADE_CLASS));
    });
    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      sizedW = 0;
      sizedH = 0;
      needsRender = true;
    });
    host.appendChild(canvas);
    sizeCanvas();
    return renderer;
  }

  // The CSS size the canvas was last sized to. Comparing against this rather than against the
  // drawing buffer keeps setSize (which reallocates and clears the buffer) out of the steady-state
  // frame, where a half-pixel rounding difference would otherwise re-trigger it every frame.
  let sizedW = 0;
  let sizedH = 0;
  function sizeCanvas() {
    if (!renderer) return;
    // the canvas covers the grid, so the drawing buffer is sized to the grid's own box
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === sizedW && h === sizedH) return;
    sizedW = w;
    sizedH = h;
    renderer.setSize(w, h, false);
    needsRender = true;
  }

  // ------------------------------------------------------------------ scene per robot
  // Hide the world, keep the machine, then frame it. The solve is shared with the connect-screen
  // hero (stage3d.js); this adapter only feeds it the picker's constants and copies the result
  // onto the record the render loop reads.
  function frameRec(rec) {
    const fit = fitOrbit({
      mount: rec.mount,
      api: rec.api,
      fov: FOV,
      fill: SUBJECT_FILL,
      aspect: ASPECT_REF,
      samples: ORBIT_SAMPLES,
      distScale: DIST_SCALE,
      envCull: ENV_CULL,
      envRadius: ENV_RADIUS,
    });
    rec.target.copy(fit.target);
    rec.dist = fit.dist;
    rec.elev = fit.elev;
    rec.az0 = fit.az0;
  }

  function buildOne(rec) {
    if (disposed || rec.ready) return;
    const def = rec.def;
    const data = ensureData(def);

    const scene = new THREE.Scene();
    scene.background = null; // transparent: the card's own panel is the backdrop
    addStageLights(scene);

    const mount = new THREE.Group();
    mount.name = `preview-${def.id}`;
    scene.add(mount);

    const api = def.buildScene(THREE, mount) || {};
    rec.scene = scene;
    rec.mount = mount;
    rec.api = api;

    const tHero = heroTime(def);
    if (typeof api.update === 'function') api.update(tHero, data);
    if (typeof api.setHighlight === 'function') api.setHighlight(null);

    frameRec(rec);

    const cam = new THREE.PerspectiveCamera(FOV, 2, 0.05, 400);
    rec.camera = cam;
    rec.ready = true;
    needsRender = true;
  }

  // ------------------------------------------------------------------ staggered builder
  function scheduleIdle(fn) {
    if (typeof window.requestIdleCallback === 'function') {
      idleIsRIC = true;
      idleHandle = window.requestIdleCallback(fn, { timeout: 1200 });
    } else {
      idleIsRIC = false;
      idleHandle = window.setTimeout(fn, 60);
    }
  }

  function cancelIdle() {
    if (!idleHandle) return;
    if (idleIsRIC && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleHandle);
    else if (!idleIsRIC) window.clearTimeout(idleHandle);
    idleHandle = 0;
  }

  function step(i) {
    idleHandle = 0;
    if (disposed || i >= recs.length) return;
    if (!ensureRenderer()) return; // no WebGL: the SVG line art stays, which is the fallback
    if (!raf) raf = requestAnimationFrame(frame);
    try {
      buildOne(recs[i]);
    } catch (err) {
      // one broken robot must not take the other three previews down
      console.warn('[preview] scene build failed for', recs[i].def.id, err);
    }
    scheduleIdle(() => step(i + 1));
  }

  // ------------------------------------------------------------------ render loop
  // Card rect RELATIVE to the grid. Both rects are read in the same frame, so their difference is
  // unaffected by scroll position; scroll cannot detach a preview from its card.
  function rectFor(rec, cw, ch, hostRect) {
    const r = rec.el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < 8 || h < 8) return null;
    const x = Math.round(r.left - hostRect.left);
    const top = Math.round(r.top - hostRect.top);
    if (top + h <= 0 || top >= ch || x + w <= 0 || x >= cw) return null;
    return { x, y: ch - (top + h), w, h };
  }

  function placeCamera(rec, elapsed) {
    const az = reduceMotion ? rec.az0 : rec.az0 + (elapsed / ORBIT_MS) * Math.PI * 2;
    rec.az = az; // live phase readout for phaseFor()
    const ce = Math.cos(rec.elev);
    rec.camera.position.set(
      rec.target.x + rec.dist * ce * Math.cos(az),
      rec.target.y + rec.dist * Math.sin(rec.elev),
      rec.target.z + rec.dist * ce * Math.sin(az)
    );
    rec.camera.lookAt(rec.target);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (disposed || !renderer || contextLost || document.hidden) return;
    // The 30 fps cap is for the orbit only. The canvas is position: fixed, so a skipped frame during
    // a scroll leaves every robot a full frame of scroll travel away from its card, painted over the
    // card's own text. Anything that moved the cards (scroll, resize, visibility) renders at once.
    if (!needsRender && now - lastFrame < MIN_FRAME_MS) return;
    lastFrame = now;
    if (reduceMotion && !needsRender) return;
    needsRender = false;

    if (!startedAt) startedAt = now;
    const elapsed = now - startedAt;

    sizeCanvas();
    const cw = sizedW;
    const ch = sizedH;

    // wipe the whole canvas first: a card that scrolled out of view would otherwise leave its last
    // frame smeared across the viewport, since a scissored render only clears its own rect
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cw, ch);
    renderer.setScissor(0, 0, cw, ch);
    renderer.clear(true, true, true);
    renderer.setScissorTest(true);

    const hostRect = host.getBoundingClientRect();
    for (const rec of recs) {
      if (!rec.ready || !rec.visible) continue;
      const box = rectFor(rec, cw, ch, hostRect);
      if (!box) continue;
      renderer.setViewport(box.x, box.y, box.w, box.h);
      renderer.setScissor(box.x, box.y, box.w, box.h);
      if (rec.camera.aspect !== box.w / box.h) {
        rec.camera.aspect = box.w / box.h;
        rec.camera.updateProjectionMatrix();
      }
      placeCamera(rec, elapsed);
      renderer.render(rec.scene, rec.camera);
      if (!rec.el.classList.contains(FADE_CLASS)) rec.el.classList.add(FADE_CLASS);
    }
  }

  // ------------------------------------------------------------------ go
  // The loop is started by the first successful ensureRenderer() in step(), never before: with no
  // WebGL there is nothing for it to draw, and an empty rAF loop would wake the tab at display rate
  // for the whole visit.
  scheduleIdle(() => step(0));

  return {
    // Where a card's camera is RIGHT NOW, so another screen can hand a robot off to its own stage
    // without the shot jumping. Null until that card has been built and framed, and while the
    // context is down, because there is no live phase to report in either case.
    phaseFor(id) {
      const rec = recs.find((r) => r.def.id === id);
      if (!rec || !rec.ready || contextLost) return null;
      return {
        az: rec.az != null ? rec.az : rec.az0,
        elev: rec.elev,
        dist: rec.dist,
        fov: FOV,
        fill: SUBJECT_FILL,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelIdle();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (io) io.disconnect();
      window.removeEventListener('scroll', markDirty, { capture: true });
      window.removeEventListener('resize', markDirty);
      document.removeEventListener('visibilitychange', markDirty);

      for (const rec of recs) {
        rec.el.classList.remove(FADE_CLASS);
        try {
          if (rec.api && typeof rec.api.dispose === 'function') rec.api.dispose();
        } catch (_) {
          /* a robot that failed to build has nothing to release */
        }
        if (rec.scene) {
          rec.scene.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              mats.forEach((m) => m && m.dispose && m.dispose());
            }
          });
        }
        rec.scene = null;
        rec.mount = null;
        rec.api = null;
        rec.camera = null;
        rec.ready = false;
      }

      if (renderer) {
        renderer.dispose();
        // same discipline as viewer.js: dispose() frees GPU objects but leaves the context alive
        // until the detached canvas is collected, and Chrome kills the oldest live context once
        // enough have accumulated. Release it explicitly.
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        renderer = null;
        canvas = null;
      }
    },
  };
}
