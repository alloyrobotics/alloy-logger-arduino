// viewer.js - the 3D replay panel. Owns renderer, camera, lights, ground and scene chrome.
// The robot itself comes from robotDef.buildScene(THREE, mount); this module only drives it
// from the shared timeline and wraps it in HUD chrome (transport, speed, reset view, scrubber).
//
// NOTE: app.js attaches the built telemetry onto the robot def as `robotDef.data` before
// constructing the viewer.

import * as THREE from 'three';
// NOTE: the vendored addon lives at vendor/addons/OrbitControls.js (flat, per the build brief),
// not at the upstream vendor/addons/controls/ path, so the specifier is flat too.
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { clamp } from './prng.js';

/**
 * @param {HTMLElement} mount
 * @param {object} robotDef with `.data` attached
 * @param {object} timeline
 * @returns {{
 *   el:HTMLElement, scene:THREE.Scene, camera:THREE.Camera, renderer:THREE.WebGLRenderer,
 *   sceneApi:object, setHighlight:(partId:string|null)=>void, get highlight():string|null,
 *   resetView:()=>void, flashMarker:(findingId:string)=>void,
 *   showBanner:(finding:object, onDismiss?:()=>void)=>void, hideBanner:()=>void,
 *   dispose:()=>void
 * }}
 */
export function createViewer(mount, robotDef, timeline) {
  const data = robotDef.data || {};
  const duration = robotDef.duration;

  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `
    <div class="v-stage"></div>
    <div class="v-banner" hidden>
      <span class="v-bdot"></span>
      <span class="v-btext"></span>
      <button class="v-bx" type="button" aria-label="Exit loop">exit</button>
    </div>
    <div class="v-hud">
      <div class="v-row">
        <button class="v-btn v-play" type="button" aria-label="Play or pause">
          <svg class="i-play" width="12" height="13" viewBox="0 0 12 13" aria-hidden="true"><path d="M1 1l10 5.5L1 12z" fill="currentColor"/></svg>
          <svg class="i-pause" width="11" height="12" viewBox="0 0 11 12" aria-hidden="true" hidden><rect x="0" y="0" width="3.5" height="12" fill="currentColor"/><rect x="7.5" y="0" width="3.5" height="12" fill="currentColor"/></svg>
        </button>
        <div class="v-speeds mono" role="group" aria-label="Playback speed">
          <button type="button" data-sp="0.4">0.4x</button>
          <button type="button" data-sp="1" class="on">1x</button>
          <button type="button" data-sp="2">2x</button>
        </div>
        <div class="v-time mono">0.00 / ${duration.toFixed(1)} s</div>
        <button class="v-btn v-home mono" type="button" title="Reset view">reset view</button>
      </div>
      <div class="v-scrub" role="slider" tabindex="0" aria-label="Mission scrubber" aria-valuemin="0" aria-valuemax="${duration}" aria-valuenow="0">
        <div class="v-track"></div>
        <div class="v-loop" hidden></div>
        <div class="v-marks"></div>
        <div class="v-head"></div>
      </div>
    </div>`;
  mount.appendChild(el);

  const stage = el.querySelector('.v-stage');
  const banner = el.querySelector('.v-banner');
  const bannerText = el.querySelector('.v-btext');
  const bannerX = el.querySelector('.v-bx');
  const playBtn = el.querySelector('.v-play');
  const iPlay = el.querySelector('.i-play');
  const iPause = el.querySelector('.i-pause');
  const timeEl = el.querySelector('.v-time');
  const homeBtn = el.querySelector('.v-home');
  const scrub = el.querySelector('.v-scrub');
  const loopEl = el.querySelector('.v-loop');
  const marksEl = el.querySelector('.v-marks');
  const headEl = el.querySelector('.v-head');

  // ---------- three.js ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(320, 240, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x111111, 1);
  renderer.domElement.className = 'v-canvas';
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // A flat clear colour made the fogged horizon terminate in a hard black seam across the top of
  // the stage. A 2 px vertical ramp (deep at the zenith, one step above the canvas at the horizon)
  // gives the fog something to dissolve into, so the far grid fades instead of being cut off.
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 2;
  skyCanvas.height = 128;
  {
    const g = skyCanvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#0b0c0e');
    grad.addColorStop(0.62, '#101215');
    grad.addColorStop(1, '#171a1e');
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 128);
  }
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x14161a, 12, 52);

  const BASE_FOV = 42;
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 4 / 3, 0.05, 200);
  camera.position.set(3.4, 2.1, 4.2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = false;
  controls.minDistance = 0.9;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 0.45, 0);

  // lights. The idle (un-highlighted) scene is what a visitor stares at while the first answer
  // streams, so the base exposure has to read as "dark and engineered", not as a failed WebGL init.
  const hemi = new THREE.HemisphereLight(0xa8bcd6, 0x121316, 0.92);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffffff, 0.13);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(5, 8, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 34;
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -9;
  key.shadow.bias = -0.0012;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x2f78ff, 0.45);
  fill.position.set(-5, 3, -4);
  scene.add(fill);
  // a second cool fill from behind the default camera, so near faces are never pure silhouette
  const front = new THREE.DirectionalLight(0xbcd2f0, 0.3);
  front.position.set(-3, 4, 6);
  scene.add(front);

  // ground + blueprint grid
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x151619, roughness: 0.96, metalness: 0.0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 120, 0x2f78ff, 0xffffff);
  grid.material.opacity = 0.09;
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  grid.position.y = 0.001;
  scene.add(grid);

  const gridCoarse = new THREE.GridHelper(60, 12, 0x2f78ff, 0x2f78ff);
  gridCoarse.material.opacity = 0.13;
  gridCoarse.material.transparent = true;
  gridCoarse.material.depthWrite = false;
  gridCoarse.position.y = 0.002;
  scene.add(gridCoarse);

  // ---------- robot scene ----------
  // `mount` handed to buildScene is a THREE.Group parented at the world origin, not a DOM node:
  // viewer.js owns the renderer/camera/lights/ground, so a robot def only ever needs a scene-graph
  // container to add its meshes to. Robot agents call mount.add(...) and may reach mount.parent
  // for the full scene if they need it.
  const robotRoot = new THREE.Group();
  robotRoot.name = 'robot-root';
  scene.add(robotRoot);
  const sceneApi = robotDef.buildScene(THREE, robotRoot) || {};
  const home = sceneApi.cameraHome || { position: { x: 3.4, y: 2.1, z: 4.2 }, target: { x: 0, y: 0.45, z: 0 } };
  camera.position.set(home.position.x, home.position.y, home.position.z);
  controls.target.set(home.target.x, home.target.y, home.target.z);
  controls.update();

  function resetView() {
    camera.position.set(home.position.x, home.position.y, home.position.z);
    controls.target.set(home.target.x, home.target.y, home.target.z);
    controls.update();
  }
  homeBtn.addEventListener('click', resetView);

  let highlight = null;
  function setHighlight(partId) {
    highlight = partId || null;
    if (typeof sceneApi.setHighlight === 'function') sceneApi.setHighlight(highlight);
  }

  // ---------- resize ----------
  function resize() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(Math.floor(r.width), 80);
    const h = Math.max(Math.floor(r.height), 80);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Every robot's cameraHome was framed against the wide desktop right column. On a phone the
    // panel is far squarer, so a fixed vertical fov crops the subject out of the sides. Widen the
    // fov as the aspect narrows, but only by the square root of the deficit: full horizontal-fov
    // lock would shrink the robot as much as the old framing did.
    const REF = 2.2;
    camera.fov =
      camera.aspect >= REF
        ? BASE_FOV
        : (2 * Math.atan(Math.tan(((BASE_FOV * Math.PI) / 180) / 2) * Math.sqrt(REF / camera.aspect)) * 180) / Math.PI;
    camera.updateProjectionMatrix();
    // the banner picks its wording off the panel width, so a rotate or a resize has to re-word it
    if (bannerFinding) bannerText.textContent = bannerCopy(bannerFinding);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  // ---------- scrubber ----------
  const markEls = new Map();
  (robotDef.findings || []).forEach((f) => {
    const m = document.createElement('button');
    m.type = 'button';
    m.className = 'v-mark sev-' + (f.severity || 'warn');
    m.style.left = ((f.t != null ? f.t : (f.window[0] + f.window[1]) / 2) / duration) * 100 + '%';
    m.title = f.title;
    m.setAttribute('aria-label', f.title);
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      timeline.seek(f.t != null ? f.t : f.window[0]);
    });
    marksEl.appendChild(m);
    markEls.set(f.id, m);
  });

  function flashMarker(findingId) {
    const m = markEls.get(findingId);
    if (!m) return;
    m.classList.remove('flash');
    void m.offsetWidth;
    m.classList.add('flash');
  }

  let dragging = false;
  function scrubTo(clientX) {
    const r = scrub.getBoundingClientRect();
    const f = clamp((clientX - r.left) / Math.max(r.width, 1), 0, 1);
    timeline.seek(f * duration);
  }
  scrub.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('v-mark')) return;
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
  });
  scrub.addEventListener('pointermove', (e) => {
    if (dragging) scrubTo(e.clientX);
  });
  function endDrag(e) {
    dragging = false;
    try {
      scrub.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* pointer already released */
    }
  }
  scrub.addEventListener('pointerup', endDrag);
  // without this a cancelled gesture (touch turned into a scroll, button released off-window)
  // leaves dragging latched and every later hover scrubs the mission
  scrub.addEventListener('pointercancel', endDrag);
  scrub.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowRight') {
      timeline.seek(timeline.t + step);
      e.preventDefault();
    }
    if (e.key === 'ArrowLeft') {
      timeline.seek(timeline.t - step);
      e.preventDefault();
    }
    if (e.key === ' ' || e.key === 'Enter') {
      timeline.toggle();
      e.preventDefault();
      // app.js has a window-level space handler; without this the two toggles cancel out and
      // space looks dead whenever the scrubber holds focus
      e.stopPropagation();
    }
  });

  // ---------- transport ----------
  playBtn.addEventListener('click', () => timeline.toggle());
  el.querySelectorAll('.v-speeds button').forEach((b) => {
    b.addEventListener('click', () => {
      timeline.setSpeed(parseFloat(b.dataset.sp));
    });
  });

  // ---------- banner ----------
  let bannerDismiss = null;
  let bannerFinding = null;

  /** A finding whose window is the whole mission is replayed, not looped. */
  const isFullMission = (f) => (f.window[1] - f.window[0]) >= duration * 0.95;

  function bannerCopy(finding) {
    const win = `${finding.window[0].toFixed(1)}-${finding.window[1].toFixed(1)} s`;
    const what = isFullMission(finding) ? 'replaying the full mission' : `looping ${win}`;
    // on a phone the full string wraps to two lines and eats the top third of the stage, which is
    // exactly where the robot sits at most finding moments, so only the tail is dropped there
    return el.clientWidth < 560
      ? `${finding.title} · ${what}`
      : `${finding.title} · ${what} · tap to exit`;
  }

  function showBanner(finding, onDismiss) {
    bannerFinding = finding;
    bannerText.textContent = bannerCopy(finding);
    banner.dataset.sev = finding.severity || 'warn';
    banner.hidden = false;
    bannerDismiss = onDismiss || null;
  }
  function hideBanner() {
    banner.hidden = true;
    bannerDismiss = null;
    bannerFinding = null;
  }
  function dismiss() {
    const cb = bannerDismiss;
    hideBanner();
    if (cb) cb();
  }
  bannerX.addEventListener('click', dismiss);
  banner.addEventListener('click', (e) => {
    if (e.target !== bannerX) dismiss();
  });

  // ---------- render loop ----------
  const offTick = timeline.onTick(applyT);
  const offChange = timeline.onChange(applyState);

  function applyT(t) {
    if (typeof sceneApi.update === 'function') sceneApi.update(t, data);
    headEl.style.left = (t / duration) * 100 + '%';
    timeEl.textContent = `${t.toFixed(2)} / ${duration.toFixed(1)} s`;
    scrub.setAttribute('aria-valuenow', t.toFixed(2));
  }

  function applyState(s) {
    iPlay.hidden = s.playing;
    iPause.hidden = !s.playing;
    playBtn.classList.toggle('on', s.playing);
    el.querySelectorAll('.v-speeds button').forEach((b) => {
      b.classList.toggle('on', parseFloat(b.dataset.sp) === s.speed);
    });
    if (s.loopWindow) {
      loopEl.hidden = false;
      loopEl.style.left = (s.loopWindow[0] / duration) * 100 + '%';
      loopEl.style.width = ((s.loopWindow[1] - s.loopWindow[0]) / duration) * 100 + '%';
    } else {
      loopEl.hidden = true;
    }
  }

  // Optional per-robot camera follow. A scene may expose `cameraFocus(tSec)` returning the point
  // the shot should stay on; the viewer translates BOTH camera and target by the same delta, so
  // whatever orbit the user has dialled in survives and reset-view still means the same framing.
  // Robots that frame a fixed workspace (sbr, arm6) simply do not implement it.
  const follow = typeof sceneApi.cameraFocus === 'function' ? sceneApi.cameraFocus : null;
  const followPt = new THREE.Vector3();
  let followed = false;
  function stepFollow() {
    if (!follow) return;
    const want = follow(timeline.t);
    if (!want) return;
    if (!followed) {
      followPt.set(want.x, want.y, want.z);
      followed = true;
    } else {
      const jump = Math.abs(want.x - followPt.x) + Math.abs(want.y - followPt.y) + Math.abs(want.z - followPt.z);
      // lag the camera so the subject moves inside the frame (an altitude dip has to be visible),
      // but snap on a seek so scrubbing never drags the shot across the field
      if (jump > 1.2) followPt.set(want.x, want.y, want.z);
      else followPt.lerp(want, 0.06);
    }
    const dx = followPt.x - controls.target.x;
    const dy = followPt.y - controls.target.y;
    const dz = followPt.z - controls.target.z;
    controls.target.set(followPt.x, followPt.y, followPt.z);
    camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
  }

  let raf = 0;
  let disposed = false;
  function frame() {
    if (disposed) return;
    stepFollow();
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  resize();
  applyT(timeline.t);
  applyState({ t: timeline.t, playing: timeline.playing, speed: timeline.speed, loopWindow: timeline.loopWindow, duration });
  frame();

  return {
    el,
    scene,
    camera,
    renderer,
    controls,
    sceneApi,
    setHighlight,
    get highlight() {
      return highlight;
    },
    resetView,
    flashMarker,
    showBanner,
    hideBanner,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      offTick();
      offChange();
      if (typeof sceneApi.dispose === 'function') sceneApi.dispose();
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => m.dispose && m.dispose());
        }
      });
      skyTex.dispose();
      renderer.dispose();
      // dispose() alone frees GPU objects but keeps the context alive until the detached canvas is
      // collected. Sixteen robot switches later Chrome starts killing the oldest live contexts and
      // the viewer goes black, so the context is released explicitly here.
      if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      el.remove();
    },
  };
}
