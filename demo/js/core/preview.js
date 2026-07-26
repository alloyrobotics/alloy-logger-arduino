// preview.js - live 3D previews inside the picker cards.
//
// ONE WebGL context for the whole picker, never one per card. A single transparent canvas is
// pinned over the viewport (position: fixed, pointer-events: none) and every rendered frame each
// card's .rcard-art rect is turned into a scissor + viewport pair, so the previews stay glued to
// their cards while the page scrolls, resizes or a card lifts on hover. This is the three.js
// "multiple elements, one renderer" pattern.
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

/** Healthy hero moment per robot. Deliberately not the failure window, and for rescue also
 * before the thermal build-up: its update() drives a data-driven heat glow on the left track,
 * so a late-mission pose reads as a red robot. 22 s is the cool, clean traverse. */
const T_HERO = { sbr: 20, arm6: 30, drone: 30, rescue: 22 };
const T_HERO_FALLBACK = 0.3; // fraction of duration

const ORBIT_MS = 14000; // one revolution
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

// Cached and released immediately: the picker is mounted and disposed on every visit, and a probe
// context left alive on each one would march the tab towards Chrome's live-context ceiling, which
// is the exact failure this module is built to avoid.
let webglSupported = null;
function webglAvailable() {
  if (webglSupported !== null) return webglSupported;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    webglSupported = !!(window.WebGLRenderingContext && gl);
    if (gl) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  } catch (_) {
    webglSupported = false;
  }
  return webglSupported;
}

/**
 * Live orbiting previews for the picker cards.
 *
 * @param {Array<{el:HTMLElement, def:object}>} entries one per card; `el` is the .rcard-art panel
 * @returns {{dispose:()=>void}}
 */
export function createPickerPreviews(entries) {
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
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
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
    document.body.appendChild(canvas);
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
    // documentElement.clientWidth/Height, NOT innerWidth/Height: the canvas is laid out at 100% of
    // the initial containing block, which excludes a classic (non-overlay) scrollbar, and
    // getBoundingClientRect - which every scissor rect is computed from - is in the same space.
    // Sizing off innerWidth squeezes the whole layer left of its cards on Windows/Linux Chrome.
    const el = document.documentElement;
    const w = Math.max(1, el.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, el.clientHeight || window.innerHeight || 1);
    if (w === sizedW && h === sizedH) return;
    sizedW = w;
    sizedH = h;
    renderer.setSize(w, h, false);
    needsRender = true;
  }

  // ------------------------------------------------------------------ scene per robot
  function addLights(scene) {
    // The viewer's rig, pushed brighter. In the demo these dark-metal robots sit on a lit ground
    // plane inside a 58 vh panel; in a 92 px card, with no ground bounce and no fog behind them,
    // the same exposure read as a smudge. The key and the two fills carry the whole read here.
    scene.add(new THREE.HemisphereLight(0xa8bcd6, 0x1a1d22, 1.5));
    scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(5, 8, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x2f78ff, 0.7);
    fill.position.set(-5, 3, -4);
    scene.add(fill);
    const front = new THREE.DirectionalLight(0xbcd2f0, 0.6);
    front.position.set(-3, 4, 6);
    scene.add(front);
    const rim = new THREE.DirectionalLight(0xffffff, 0.55);
    rim.position.set(0, 2.5, -7);
    scene.add(rim);
  }

  /**
   * Hide the world, keep the machine, then frame it.
   *
   * The demo viewer looks at these scenes across a 58 vh panel, so drone draws a 20 x 14 m survey
   * field and rescue builds a whole rubble ramp. Inside a 92 px card those read as abstract lines
   * and a grey slab with the robot lost in them, so anything markedly bigger than the shot itself
   * is hidden for the preview. What is left is the machine, floating in the card's grid panel like
   * the line art it replaces.
   */
  function frameRec(rec) {
    const api = rec.api || {};
    const home = api.cameraHome;

    let homeDist = 3;
    let homeTarget = null;
    rec.elev = 0.34;
    rec.az0 = 0.9;

    if (home && home.position && home.target) {
      const ht = new THREE.Vector3(home.target.x, home.target.y, home.target.z);
      const off = new THREE.Vector3(home.position.x, home.position.y, home.position.z).sub(ht);
      homeDist = off.length() || 3;
      homeTarget = ht;
      rec.elev = Math.asin(THREE.MathUtils.clamp(off.y / homeDist, -1, 1));
      rec.az0 = Math.atan2(off.z, off.x);
    }

    // drone and rescue travel across their worlds, so their cameraHome target only holds at t=0.
    // Both expose cameraFocus(), which reports where the machine actually is at the posed moment.
    if (typeof api.cameraFocus === 'function') {
      const p = api.cameraFocus();
      if (p && Number.isFinite(p.x)) homeTarget = new THREE.Vector3(p.x, p.y, p.z);
    }

    const focus = homeTarget || new THREE.Vector3(0, 0.4, 0);
    const limit = homeDist * ENV_CULL;
    const keep = homeDist * ENV_RADIUS;
    const subject = new THREE.Box3();
    const b = new THREE.Box3();
    const env = new THREE.Box3();
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    rec.mount.updateWorldMatrix(true, true);

    const worldBox = (o) => {
      if (!o.geometry) return null;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (!o.geometry.boundingBox) return null;
      b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      return b.isEmpty() ? null : b;
    };
    // too big to be part of the machine (survey field, rubble ramp, ground planes), or too far from
    // it to belong in a 92 px shot (flown track, scattered debris, drop lines). Leaves `size` and
    // `centre` set for the box it was handed.
    const isScenery = (bx) => {
      bx.getSize(size);
      bx.getCenter(centre);
      return Math.max(size.x, size.y, size.z) > limit || centre.distanceTo(focus) > keep;
    };

    // The machine, for the cull below: the mesh nearest the focus point that is not itself scenery.
    // Its ancestors are the only groups allowed to stay bigger than the shot.
    let anchor = null;
    let anchorDist = Infinity;
    let anchorSize = Infinity;
    rec.mount.traverse((o) => {
      if (o.visible === false) return;
      const bx = worldBox(o);
      if (!bx || isScenery(bx)) return;
      const d = bx.distanceToPoint(focus);
      const s = Math.max(size.x, size.y, size.z);
      if (d < anchorDist - 1e-6 || (d <= anchorDist + 1e-6 && s < anchorSize)) {
        anchorDist = d;
        anchorSize = s;
        anchor = o;
      }
    });
    const machineChain = new Set();
    for (let p = anchor; p; p = p.parent) machineChain.add(p);

    // A walk rather than a traverse, so a scenery GROUP can be dropped whole. Testing mesh by mesh
    // leaves the small parts of a big group behind: rescue's rubble pile lost its ramp but kept the
    // loose chunks near the machine, which floated around it looking like render garbage.
    const cull = (o) => {
      if (o.visible === false) return;
      // path rings, survey lanes, motion trails: line/point renderables are world dressing, and
      // leaving them in inflates the subject box so the machine frames small in the card
      if (o.isLine || o.isLineSegments || o.isPoints) {
        o.visible = false;
        return;
      }
      if (o !== rec.mount && o.children.length && !machineChain.has(o)) {
        env.setFromObject(o);
        if (!env.isEmpty()) {
          env.getSize(size);
          if (Math.max(size.x, size.y, size.z) > limit) {
            o.visible = false;
            return;
          }
        }
      }
      const bx = worldBox(o);
      if (bx) {
        if (isScenery(bx)) {
          o.visible = false;
          return;
        }
        subject.union(bx);
      }
      for (const child of o.children) cull(child);
    };
    cull(rec.mount);

    if (subject.isEmpty()) {
      rec.target.copy(focus);
      rec.dist = homeDist * DIST_SCALE;
      return;
    }

    subject.getCenter(rec.target);
    // Frame the WHOLE orbit, not one axis-aligned silhouette. With the camera at unit direction u
    // from the target, a subject corner at offset o needs dist >= o.u + |o.up| / kY (and the same
    // horizontally): the depth term is what perspective adds as a corner swings towards the camera.
    // A fit that ignores it is only correct at the azimuths where the machine happens to be side
    // on, and slices the machine off along the card's bottom border at the rest.
    const halfFov = Math.tan(((FOV * Math.PI) / 180) / 2);
    const kY = SUBJECT_FILL * halfFov;
    const kX = kY * ASPECT_REF; // square tile: horizontal allowance equals vertical
    const u = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const corner = new THREE.Vector3();
    const ce = Math.cos(rec.elev);
    const se = Math.sin(rec.elev);
    let dist = 0;
    for (let i = 0; i < ORBIT_SAMPLES; i++) {
      const az = rec.az0 + (i / ORBIT_SAMPLES) * Math.PI * 2;
      u.set(ce * Math.cos(az), se, ce * Math.sin(az));
      right.set(Math.sin(az), 0, -Math.cos(az)); // three's lookAt basis for world up +Y
      up.crossVectors(u, right);
      for (let j = 0; j < 8; j++) {
        corner
          .set(
            j & 1 ? subject.max.x : subject.min.x,
            j & 2 ? subject.max.y : subject.min.y,
            j & 4 ? subject.max.z : subject.min.z
          )
          .sub(rec.target);
        const need =
          corner.dot(u) +
          Math.max(Math.abs(corner.dot(up)) / kY, Math.abs(corner.dot(right)) / kX);
        if (need > dist) dist = need;
      }
    }
    rec.dist = dist;
  }

  function buildOne(rec) {
    if (disposed || rec.ready) return;
    const def = rec.def;
    const data = ensureData(def);

    const scene = new THREE.Scene();
    scene.background = null; // transparent: the card's own panel is the backdrop
    addLights(scene);

    const mount = new THREE.Group();
    mount.name = `preview-${def.id}`;
    scene.add(mount);

    const api = def.buildScene(THREE, mount) || {};
    rec.scene = scene;
    rec.mount = mount;
    rec.api = api;

    const tHero = T_HERO[def.id] != null ? T_HERO[def.id] : def.duration * T_HERO_FALLBACK;
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
  function rectFor(rec, cw, ch) {
    const r = rec.el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < 8 || h < 8) return null;
    if (r.bottom <= 0 || r.top >= ch || r.right <= 0 || r.left >= cw) return null;
    return { x: Math.round(r.left), y: Math.round(ch - r.bottom), w, h };
  }

  function placeCamera(rec, elapsed) {
    const az = reduceMotion ? rec.az0 : rec.az0 + (elapsed / ORBIT_MS) * Math.PI * 2;
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

    for (const rec of recs) {
      if (!rec.ready || !rec.visible) continue;
      const box = rectFor(rec, cw, ch);
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
