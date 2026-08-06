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
// The anatomy orbit, the commanded-camera ease and the reduced-motion query are staging decisions,
// not viewer internals: the picker previews and the connect hero already take theirs from stage3d,
// and this module is the third stage that has to answer them identically. Already in the eager
// graph (preview.js and context.js both import it), so this costs no extra module fetch.
import {
  ANATOMY_ORBIT_MS,
  CAMERA_EASE_MS,
  easeOutCubic,
  orbitSpeedFor,
  prefersReducedMotion,
} from './stage3d.js';

/**
 * @param {HTMLElement} mount
 * @param {object} robotDef with `.data` attached
 * @param {object} timeline
 * @returns {{
 *   el:HTMLElement, scene:THREE.Scene, camera:THREE.Camera, renderer:THREE.WebGLRenderer,
 *   sceneApi:object, setHighlight:(partId:string|null)=>void, get highlight():string|null,
 *   resetView:()=>void, flashMarker:(findingId:string)=>void,
 *   showBanner:(finding:object, onDismiss?:()=>void)=>void,
 *   showContextBanner:(text:string, onDismiss?:()=>void)=>void, hideBanner:()=>void,
 *   setAnatomy:(parts:Array<object>|null)=>void,
 *   applyCamera:(pose:object|null)=>void, setCamera:(pose:object|null)=>void,
 *   setOrbit:(on:boolean)=>void, setAutoRotate:(on:boolean)=>void,
 *   dispose:()=>void
 * }}
 */
export function createViewer(mount, robotDef, timeline) {
  /**
   * TRANSACTIONAL CONSTRUCTION. Everything below allocates before it can be handed back, and the
   * most expensive allocation - the WebGL renderer and its canvas - is mounted in the first twenty
   * lines, long before `robotDef.buildScene()` runs. A throw in buildScene, or in any of the
   * initialisation after it, used to leave that canvas in the DOM with a live GPU context behind
   * it and nobody holding a reference to dispose it: the caller only ever had the exception.
   * Sixteen of those and Chrome starts killing the oldest live contexts, which is the same failure
   * the dispose() path already documents, arriving by a route dispose() cannot reach.
   *
   * So each acquisition registers its own release as it happens, and a throw unwinds them newest
   * first. `createViewerInner` is the function this one used to be, unchanged except that it now
   * calls `acquire()` at each allocation; keeping it whole is deliberate, because the returned
   * object closes over forty locals and splitting it to get a try block would have been the edit
   * that introduced a bug.
   */
  const acquired = [];
  const acquire = (release) => acquired.push(release);
  try {
    return createViewerInner(mount, robotDef, timeline, acquire);
  } catch (err) {
    while (acquired.length) {
      const release = acquired.pop();
      // A half-built viewer's teardown can itself throw; the ORIGINAL error is the useful one and
      // must be the one that reaches the caller, so a failed release is logged and stepped over.
      try {
        release();
      } catch (releaseErr) {
        console.warn(`[viewer] partial teardown: ${releaseErr && releaseErr.message}`);
      }
    }
    throw err;
  }
}

function createViewerInner(mount, robotDef, timeline, acquire) {
  // `robotDef.data` is chart/chat telemetry. A def whose 3D scene is driven by something else
  // (the SSL match replay is driven by a decoded tracker export, not by its channels) exposes
  // `getSceneData()` and the scene gets that instead. Resolved per call rather than snapshotted
  // once, so a def that finishes loading its scene payload after mount still feeds its scene.
  const sceneDataOf = () =>
    (typeof robotDef.getSceneData === 'function' ? robotDef.getSceneData() : null) ||
    robotDef.data ||
    {};
  const data = sceneDataOf();
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
  acquire(() => el.remove());

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
  // The one that matters. Same three steps dispose() takes, in the same order and for the same
  // reason: dispose() alone frees GPU objects but keeps the CONTEXT alive until the detached canvas
  // is collected, so the context is released explicitly.
  acquire(() => {
    renderer.dispose();
    if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  });

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
  acquire(() => skyTex.dispose());
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x14161a, 12, 52);

  const BASE_FOV = 42;
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 4 / 3, 0.05, 200);
  camera.position.set(3.4, 2.1, 4.2);

  const controls = new OrbitControls(camera, renderer.domElement);
  acquire(() => controls.dispose());
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
  // Every geometry and material under `scene` at the moment of a failure, including anything
  // buildScene added before it threw. dispose() does this by traversal too; a partial scene graph
  // is still a scene graph.
  acquire(() =>
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose && m.dispose());
      }
    }),
  );
  const sceneApi = robotDef.buildScene(THREE, robotRoot) || {};
  acquire(() => {
    if (typeof sceneApi.dispose === 'function') sceneApi.dispose();
  });

  // ---------- optional per-scene rendering treatment ----------
  // A scene MAY ask for a different look by returning a `rendering` block. The four original
  // hand-written robots return nothing here and are rendered exactly as they always were - which
  // is the point: they were approved on this image, and tone mapping or an environment map applied
  // globally would silently restyle all four. Generated scenes ask, because their content is different:
  // 180 mm robots on a 2 m field need a shadow frustum two orders of magnitude tighter than a
  // fixed 18 m ortho, and metal parts with no IBL to reflect collapse to flat grey.
  let pmrem = null;
  let envRT = null;
  const rq = sceneApi.rendering;

  /**
   * Max-anisotropy every texture under the robot root. Only the renderer knows the GPU's limit,
   * and a painted floor viewed along its own plane beads into a dotted line at the default of 1.
   *
   * Called TWICE, and it has to be: a scene that builds its meshes in `buildScene()` is textured by
   * the first call, and a scene that builds them on its first `update()` - which is how a def with
   * a lazily loaded payload has to work, because it has nothing to build from until then - is
   * textured by the second. A traversal of an empty group is free, and setting the same anisotropy
   * on an already-treated texture is a no-op, so neither call costs the other anything.
   */
  function applyAnisotropy() {
    const maxA = renderer.capabilities.getMaxAnisotropy();
    robotRoot.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.map || m.map.anisotropy === maxA) continue;
        m.map.anisotropy = maxA;
        m.map.needsUpdate = true;
      }
    });
  }

  if (rq && typeof rq === 'object') {
    if (rq.toneMap === 'aces') {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = typeof rq.exposure === 'number' ? rq.exposure : 1.0;
    }
    if (rq.env) {
      // A 64 x 32 equirect ramp PMREM'd once, rather than vendoring RoomEnvironment: it is the
      // difference between "metalness means something" and "every metal part is dead grey", and
      // it costs one 256 px cubemap built at construction and nothing per frame.
      const W = 64;
      const H = 32;
      const buf = new Float32Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        const v = y / (H - 1);
        // sky above, floor bounce below, one soft bright band where the key light sits
        const sky = 0.10 + 0.55 * Math.pow(1 - v, 1.6);
        const band = Math.exp(-Math.pow((v - 0.22) * 5.2, 2)) * 0.9;
        const lum = sky + band;
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          buf[i] = lum * 0.96;
          buf[i + 1] = lum * 0.98;
          buf[i + 2] = lum * 1.06;
          buf[i + 3] = 1;
        }
      }
      const eq = new THREE.DataTexture(buf, W, H, THREE.RGBAFormat, THREE.FloatType);
      eq.mapping = THREE.EquirectangularReflectionMapping;
      eq.needsUpdate = true;
      pmrem = new THREE.PMREMGenerator(renderer);
      envRT = pmrem.fromEquirectangular(eq);
      // A GPU allocation the scene traverse above cannot reach, on the failure path as on dispose().
      acquire(() => {
        scene.environment = null;
        if (envRT) envRT.dispose();
        if (pmrem) pmrem.dispose();
      });
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.55;
      eq.dispose();
    }
    if (rq.anisotropy) applyAnisotropy();
    if (rq.fog && typeof rq.fog === 'object') {
      scene.fog = new THREE.Fog(rq.fog.color, rq.fog.near, rq.fog.far);
    }
    if (rq.grids === false) {
      grid.visible = false;
      gridCoarse.visible = false;
    }
    if (rq.ground === false) ground.visible = false;
    // A scene may opt OUT of shadows entirely. The branch below only ever handled an object, so a
    // plain `false` used to be silently ignored - and for a scene whose subjects are 180 mm across
    // a 1024^2 map over an 18 m frustum (~18 mm/texel) is worse than no shadow at all.
    if (rq.shadow === false) {
      key.castShadow = false;
      renderer.shadowMap.enabled = false;
    }
    if (rq.shadow && typeof rq.shadow === 'object') {
      const sh = rq.shadow;
      const half = typeof sh.half === 'number' ? sh.half : 9;
      const cx = sh.center && typeof sh.center.x === 'number' ? sh.center.x : 0;
      const cz = sh.center && typeof sh.center.z === 'number' ? sh.center.z : 0;
      if (typeof sh.mapSize === 'number') key.shadow.mapSize.set(sh.mapSize, sh.mapSize);
      key.shadow.camera.left = -half;
      key.shadow.camera.right = half;
      key.shadow.camera.top = half;
      key.shadow.camera.bottom = -half;
      key.shadow.camera.far = 34 + half;
      if (typeof sh.bias === 'number') key.shadow.bias = sh.bias;
      if (typeof sh.normalBias === 'number') key.shadow.normalBias = sh.normalBias;
      // the light and its target both move onto the play area, or a tight frustum simply misses it
      key.position.set(cx + 5, 8, cz + 4);
      key.target.position.set(cx, 0, cz);
      scene.add(key.target);
      key.target.updateMatrixWorld();
      key.shadow.camera.updateProjectionMatrix();
    }
  }

  // ---------- optional scene HUD strip ----------
  // A scene MAY expose `hudState(tSec)` and get a compact fixed strip over the top of the stage.
  // It exists because a follow-cam on a 46 dvh phone panel cannot show a legible in-world
  // scoreboard: at that crop the shot is ~3 m wide, so anything at the far end of a 12 m pitch is
  // a few pixels tall. The scene returns STATE, never markup, and the viewer writes it with
  // textContent; the DOM is only touched when `state.version` changes.
  //
  //   { version:string, clock:string, stage:string,
  //     state: { label:string, tone:'live'|'stop'|'halt'|'prep'|'goal', note?:string },
  //     teams: [{ name, color:'yellow'|'blue'|'red', score,
  //               cards?, reds?, maxBots?, keeper?, timeouts? }] }
  //
  // `keeper` is the team's registered goalkeeper id and rides as a chip beside the team name,
  // because that is where the identity honestly lives: a robot carries no keeper marking, the id
  // is game-controller state. `timeouts` is the count REMAINING (no seconds field is exported).
  // `stage` is the half.
  //
  // Everything after `score` is OPTIONAL and belongs to a ruleset that has it. Cards, reds,
  // max_allowed_bots, the keeper and timeouts are league discipline state: a scene whose game has
  // none of them omits those keys entirely and this renders nothing for them, rather than being
  // handed zeroes and printing a truthful-looking "0Y" for a competition with no cards. A scene
  // that DOES define a field keeps the old rendering byte for byte, zeroes included, because "0Y"
  // is the state there and a blank is an unanswered question.
  //
  // `state.note` is the same deal one level up: a free-text callout for a round-level effect the
  // label cannot carry (a defense buff, a supply run). It shares the note element with the
  // discipline summary, which is unreachable in the same frame - a ruleset either has discipline
  // state or has notes - and it must be covered by `version`, or a note will go stale behind the
  // short-circuit below.
  let updateSceneHud = null;
  if (typeof sceneApi.hudState === 'function') {
    if (!document.getElementById('v-shud-css')) {
      const st = document.createElement('style');
      st.id = 'v-shud-css';
      st.textContent = `
.v-shud{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:center;
  flex-wrap:wrap;row-gap:2px;column-gap:10px;
  padding:8px 12px;pointer-events:none;font-size:11.5px;color:var(--tx-body);
  background:linear-gradient(180deg,rgba(17,17,17,0.82) 0%,rgba(17,17,17,0.42) 62%,rgba(17,17,17,0) 100%);}
.v-shud[hidden]{display:none;}
/* Two groups, one line while there is room for one. Under 1000px the second group takes a full
   basis and becomes the second ROW: no required match state is ever display:none'd, it reflows.
   The strip is capped at two rows by construction, since neither group ever wraps internally. */
.v-sh-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap;}
.v-sh-main{flex:1 1 auto;}
.v-sh-sub{flex:0 1 auto;justify-content:flex-end;}
.v-sh-team{display:flex;align-items:center;gap:6px;min-width:0;color:var(--tx);white-space:nowrap;}
.v-sh-team b{font-weight:500;overflow:hidden;text-overflow:ellipsis;}
.v-sh-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 1px rgba(0,0,0,0.5);}
.v-sh-dot[data-c="yellow"]{background:#ffe600;}
.v-sh-dot[data-c="blue"]{background:#0033ff;}
.v-sh-dot[data-c="red"]{background:#e5484d;}
/* nowrap + no shrink: the score is the one thing on the strip that must never break, and with the
   keeper chips beside it there is no longer slack at 390px for it to wrap "0 : 2" onto 3 lines. */
.v-sh-score{font-family:'Geist Mono',ui-monospace,monospace;font-size:13px;color:var(--tx);
  letter-spacing:0.04em;padding:0 2px;white-space:nowrap;flex:0 0 auto;}
.v-sh-gap{flex:1 1 auto;}
.v-sh-clock{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;color:var(--tx-mute);}
.v-sh-state{font-family:'Geist Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.06em;
  border:1px solid var(--line-hi);border-radius:60px;padding:2px 9px;color:var(--tx-mute);white-space:nowrap;}
.v-sh-state[data-tone="live"]{color:var(--sage);border-color:rgba(211,238,182,0.35);}
.v-sh-state[data-tone="stop"]{color:var(--warn);border-color:rgba(245,166,35,0.35);}
.v-sh-state[data-tone="halt"]{color:var(--alert);border-color:rgba(255,95,87,0.4);}
.v-sh-state[data-tone="goal"]{color:var(--tx);border-color:var(--line-hi);background:rgba(2,93,254,0.24);}
.v-sh-note{font-family:'Geist Mono',ui-monospace,monospace;font-size:10px;color:var(--tx-mute);
  white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.v-sh-note:empty{display:none;}
.v-sh-kp{font-family:'Geist Mono',ui-monospace,monospace;font-size:9px;font-style:normal;
  letter-spacing:0.04em;color:var(--tx-mute);border:1px solid var(--line);border-radius:3px;
  padding:0 3px;line-height:1.5;flex:0 0 auto;}
.v-sh-kp:empty{display:none;}
.v-sh-stage{font-family:'Geist Mono',ui-monospace,monospace;font-size:10px;color:var(--tx-mute);
  letter-spacing:0.06em;white-space:nowrap;flex:0 0 auto;}
.v-sh-stage:empty{display:none;}
/* max_allowed_bots. The ONE field on the strip that Tier S16 does not require, so it is the one
   thing allowed to fold away, and it is also a permitted maximum rather than an observed count. */
.v-sh-max{font-family:'Geist Mono',ui-monospace,monospace;font-size:10px;color:var(--tx-mute);
  white-space:nowrap;flex:0 0 auto;}
.v-sh-max:empty{display:none;}
/* Under 1000px the stage panel is no longer wide enough for one line, so the second group wraps to
   its own row. Score, stage, stage clock, cards, timeouts and the keeper chips all stay ON SCREEN:
   they change rows, they do not disappear. */
@media (max-width:1000px){
  .v-shud{column-gap:8px;padding:7px 10px;}
  .v-sh-sub{flex:1 0 100%;justify-content:flex-start;}
  .v-sh-note,.v-sh-stage,.v-sh-clock,.v-sh-max{font-size:9.5px;}
  .viewer.has-shud .v-banner{top:58px;}}
/* the evidence banner also opens at the top of the stage: with a HUD there it drops below the
   strip instead of landing on top of the score. Scoped to viewers that HAVE a HUD, so the four
   robots without one keep the banner exactly where it has always been. */
.viewer.has-shud .v-banner{top:42px;}
/* Phone. Still two rows, still nothing hidden that S16 asks for: the type comes down, the gaps
   come in, and max_allowed_bots (which S16 does not ask for) is the single field that folds, which
   is what buys the cards/timeouts note the width to sit beside the stage and the clock at 360px. */
@media (max-width:700px){.v-shud{column-gap:6px;row-gap:1px;padding:5px 8px;font-size:10.5px;}
  .v-sh-row{gap:6px;}
  .v-sh-max{display:none;}
  .v-sh-note,.v-sh-stage,.v-sh-clock{font-size:9px;}
  .v-sh-state{font-size:9px;padding:2px 7px;}
  .v-sh-kp{font-size:8.5px;padding:0 2px;}
  .viewer.has-shud .v-banner{top:50px;}}`;
      document.head.appendChild(st);
    }
    el.classList.add('has-shud');
    const hudEl = document.createElement('div');
    hudEl.className = 'v-shud';
    hudEl.hidden = true;
    hudEl.innerHTML = `
      <span class="v-sh-row v-sh-main">
        <span class="v-sh-team"><i class="v-sh-dot"></i><b></b><i class="v-sh-kp"></i></span>
        <span class="v-sh-score"></span>
        <span class="v-sh-team"><i class="v-sh-kp"></i><b></b><i class="v-sh-dot"></i></span>
        <span class="v-sh-gap"></span>
        <span class="v-sh-state"></span>
      </span>
      <span class="v-sh-row v-sh-sub">
        <span class="v-sh-stage"></span>
        <span class="v-sh-clock"></span>
        <span class="v-sh-note"></span>
        <span class="v-sh-max"></span>
      </span>`;
    stage.appendChild(hudEl);
    const shTeams = hudEl.querySelectorAll('.v-sh-team');
    const shDots = hudEl.querySelectorAll('.v-sh-dot');
    const shNames = hudEl.querySelectorAll('.v-sh-team b');
    const shKeep = hudEl.querySelectorAll('.v-sh-kp');
    const shScore = hudEl.querySelector('.v-sh-score');
    const shStage = hudEl.querySelector('.v-sh-stage');
    const shNote = hudEl.querySelector('.v-sh-note');
    const shMax = hudEl.querySelector('.v-sh-max');
    const shClock = hudEl.querySelector('.v-sh-clock');
    const shState = hudEl.querySelector('.v-sh-state');
    // ---------- optional per-subject chip row (HUD chip ABI v1) ----------
    //
    // A scene MAY additionally send `{ chipsAbi: 1, chips: [{ name, state, note, tone }] }`, and get
    // a third row of per-subject status chips under the match state. It exists because a mission
    // with more than one recorded subject has more than one presence story at any instant, and the
    // single `state.note` above cannot carry three of them: the Donna team replay drives three
    // Wolfgang-OP humanoids from three independently recorded logs, and at 100 s one of them is off
    // the field serving a penalty while another is mid-fall. "Where is she?" has to be answerable
    // from the strip, not inferred from an empty patch of pitch.
    //
    // `tone` is an ENUM, not a colour: `live` (the subject's own log observed it), `hold` (observed
    // pose is stale and disclosed as held) and `hidden` (not observed at all, so not drawn). No
    // scene-specific hex ever crosses this ABI.
    //
    // VERSION GUARDED, AND THE GUARD IS THE POINT. `chipsAbi` must equal HUD_CHIP_ABI exactly.
    // Everything below - the extra stylesheet, the row element, every chip element and every write
    // - is created LAZILY on the first state that declares the ABI, so a scene that does not send
    // chips (which is all six of the other missions) never reaches any of it: no element, no
    // attribute, no stylesheet, no byte of the strip's DOM different from what it has always been.
    const HUD_CHIP_ABI = 1;
    let chipRow = null;
    let chipEls = [];
    function ensureChips(n) {
      if (chipRow && chipEls.length >= n) return;
      if (!document.getElementById('v-shud-chips-css')) {
        const cst = document.createElement('style');
        cst.id = 'v-shud-chips-css';
        cst.textContent = `
.v-sh-chips{flex:1 0 100%;justify-content:flex-start;gap:10px;flex-wrap:wrap;row-gap:2px;}
.v-sh-chip{display:flex;align-items:center;gap:5px;min-width:0;white-space:nowrap;
  font-family:'Geist Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:0.04em;
  color:var(--tx-mute);border:1px solid var(--line);border-radius:60px;padding:1px 8px 1px 6px;}
.v-sh-cdot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--tx-mute);
  box-shadow:0 0 0 1px rgba(0,0,0,0.5);}
/* live = the subject's own log observed it; hold = the drawn pose is stale and disclosed;
   hidden = never observed in this interval, so nothing is drawn for it on the stage. */
.v-sh-chip[data-tone="live"] .v-sh-cdot{background:var(--sage);}
.v-sh-chip[data-tone="hold"] .v-sh-cdot{background:var(--warn);}
.v-sh-chip[data-tone="hidden"] .v-sh-cdot{background:transparent;box-shadow:inset 0 0 0 1px var(--tx-mute);}
.v-sh-chip[data-tone="hold"],.v-sh-chip[data-tone="hidden"]{border-color:var(--line-hi);}
.v-sh-chip b{font-weight:500;color:var(--tx);}
.v-sh-chip em{font-style:normal;}
.v-sh-chip u{text-decoration:none;color:var(--warn);}
.v-sh-chip u:empty{display:none;}
@media (max-width:1000px){.v-sh-chips{gap:8px;}}
@media (max-width:700px){.v-sh-chips{gap:6px;}.v-sh-chip{font-size:8.5px;padding:1px 6px 1px 5px;}}`;
        document.head.appendChild(cst);
      }
      if (!chipRow) {
        chipRow = document.createElement('span');
        chipRow.className = 'v-sh-row v-sh-chips';
        hudEl.appendChild(chipRow);
      }
      while (chipEls.length < n) {
        const chip = document.createElement('span');
        chip.className = 'v-sh-chip';
        chip.innerHTML = '<i class="v-sh-cdot"></i><b></b><em></em><u></u>';
        chipRow.appendChild(chip);
        chipEls.push({
          el: chip,
          name: chip.querySelector('b'),
          state: chip.querySelector('em'),
          note: chip.querySelector('u'),
        });
      }
    }

    let shVer = null;
    updateSceneHud = (t) => {
      const s = sceneApi.hudState(t);
      if (!s || !s.teams) {
        hudEl.hidden = true;
        return;
      }
      hudEl.hidden = false;
      if (s.version === shVer) return;
      shVer = s.version;
      for (let i = 0; i < shTeams.length && i < s.teams.length; i++) {
        const tm = s.teams[i];
        shDots[i].dataset.c = tm.color || '';
        shNames[i].textContent = tm.name || '';
        // Keeper id straight off the team's TeamInfo. Blank when the referee state has none, so
        // the chip disappears rather than inventing a keeper.
        if (shKeep[i]) shKeep[i].textContent = tm.keeper == null ? '' : `K${tm.keeper}`;
      }
      shScore.textContent = `${s.teams[0].score} : ${s.teams[1].score}`;
      shStage.textContent = s.stage || '';
      shClock.textContent = s.clock || '';
      const st2 = s.state || {};
      shState.textContent = st2.label || '';
      shState.dataset.tone = st2.tone || 'stop';
      // Cards and timeouts are Tier S16 state for a ruleset that HAS them, and always render
      // there. max_allowed_bots is not, so it lives in its own element and is the one field the
      // phone breakpoint is allowed to fold. A scene whose game has no discipline state at all
      // defines none of these keys and contributes no note, which leaves the element to
      // `state.note` (and, with neither, to `:empty { display:none }`).
      const notes = [];
      const maxes = [];
      if (st2.note) notes.push(st2.note);
      s.teams.forEach((tm) => {
        const bits = [];
        // Cards are shown at zero as well: "0Y" is the state, a blank is an unanswered question.
        // The test is DEFINED, not truthy: a league with cards renders "0Y" exactly as it always
        // has, and a game without them never grows the key in the first place.
        if ('cards' in tm) bits.push(`${tm.cards || 0}Y`);
        if (tm.reds) bits.push(`${tm.reds}R`);
        // Timeouts REMAINING, not taken. Shown at zero too, because "0 TO" is the interesting state.
        if (tm.timeouts != null) bits.push(`${tm.timeouts}TO`);
        if (bits.length) notes.push(`${tm.name} ${bits.join(' ')}`);
        if (tm.maxBots != null) maxes.push(tm.maxBots);
      });
      shNote.textContent = notes.join(' · ');
      shMax.textContent = maxes.length ? `max ${maxes.join('/')}` : '';

      // Chips last, and only for a scene that declared the ABI. A scene whose chips vanish between
      // states (a mission that stops sending them) empties the row rather than leaving three stale
      // subjects on the strip.
      if (s.chipsAbi === HUD_CHIP_ABI && Array.isArray(s.chips) && s.chips.length) {
        ensureChips(s.chips.length);
        for (let i = 0; i < chipEls.length; i++) {
          const c = s.chips[i];
          const slot = chipEls[i];
          slot.el.hidden = !c;
          if (!c) continue;
          slot.el.dataset.tone = c.tone || 'live';
          slot.name.textContent = c.name || '';
          slot.state.textContent = c.state || '';
          slot.note.textContent = c.note || '';
        }
      } else if (chipRow) {
        for (let i = 0; i < chipEls.length; i++) chipEls[i].el.hidden = true;
      }
    };
  }

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
    // The anatomy cards were placed by the grid against the OLD box, and the leaders were drawn to
    // an old projection. Both are stale the instant the panel changes shape, and under reduced
    // motion this is the only place they are ever recomputed.
    measureAnatomy();
    projectAnatomy();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  acquire(() => ro.disconnect());

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
    // on a phone the banner is a compact pill: the title alone (the loop range is already
    // visible as the highlighted span on the scrubber, and the whole pill is tappable)
    return el.clientWidth < 560
      ? finding.title
      : `${finding.title} · ${what} · tap to exit`;
  }

  function showBanner(finding, onDismiss) {
    bannerFinding = finding;
    bannerText.textContent = bannerCopy(finding);
    banner.dataset.sev = finding.severity || 'warn';
    delete banner.dataset.static;
    bannerX.hidden = false;
    banner.hidden = false;
    el.classList.add('has-banner');
    bannerDismiss = onDismiss || null;
    anatomyReflowed();
  }

  /**
   * The same banner strip, with no severity.
   *
   * The success step loops a passage where NOTHING went wrong, and it still has to say which
   * passage it is looping. Reusing showBanner() there would have meant handing it a fake finding
   * with a severity, and the strip would have opened with an alert-red border and a pulsing dot
   * over a robot doing its job perfectly - the one screen in the flow whose whole point is that
   * there is no fault to see. So the tone is a separate entry point rather than a parameter: a
   * caller either has a finding (severity, window wording, exit affordance) or has a label.
   *
   * `text` is written verbatim, because the caller knows what the loop is; the banner does not
   * re-word it by panel width the way a finding's window copy is re-worded. With no `onDismiss`
   * there is nothing to exit, so the exit button and the pointer cursor go away and the strip is
   * a caption rather than a control.
   *
   * @param {string} text
   * @param {(()=>void)=} onDismiss
   */
  function showContextBanner(text, onDismiss) {
    bannerFinding = null;
    bannerText.textContent = text == null ? '' : String(text);
    banner.dataset.sev = 'neutral';
    bannerDismiss = onDismiss || null;
    bannerX.hidden = !bannerDismiss;
    if (bannerDismiss) delete banner.dataset.static;
    else banner.dataset.static = '1';
    ensureBannerStyles();
    banner.hidden = false;
    el.classList.add('has-banner');
    anatomyReflowed();
  }

  /**
   * The neutral tone, injected rather than shipped in the page stylesheet: the base `.v-banner`
   * rules belong to another writer's file, and this variant is only reachable through the entry
   * point above. Same trick as the scene HUD strip below, same id-guard, one stylesheet per page.
   */
  function ensureBannerStyles() {
    if (document.getElementById('v-ban-neutral-css')) return;
    const st = document.createElement('style');
    st.id = 'v-ban-neutral-css';
    st.textContent = `
.v-banner[data-sev="neutral"]{border-color:var(--line-hi);}
.v-banner[data-sev="neutral"] .v-bdot{background:var(--tx-mute);animation:none;}
.v-banner[data-static]{cursor:default;}`;
    document.head.appendChild(st);
  }

  function hideBanner() {
    banner.hidden = true;
    bannerDismiss = null;
    bannerFinding = null;
    delete banner.dataset.static;
    bannerX.hidden = false;
    el.classList.remove('has-banner');
    anatomyReflowed();
  }
  function dismiss() {
    // A caption with nothing to exit is not a control, so a tap on it does nothing. Only ever true
    // for a context banner opened without a callback; every finding banner clears the flag.
    if (banner.dataset.static) return;
    const cb = bannerDismiss;
    hideBanner();
    if (cb) cb();
  }
  bannerX.addEventListener('click', dismiss);
  banner.addEventListener('click', (e) => {
    if (e.target !== bannerX) dismiss();
  });

  // ---------- optional anatomy overlay ----------
  //
  // Four callout cards in the corners of the stage, each tied to a real point on the machine by a
  // hairline leader. `setAnatomy(parts)` opens it, `setAnatomy(null)` closes it, and a viewer that
  // is never asked allocates nothing: no element, no stylesheet, no per-frame work, which is what
  // keeps the six missions that do not use it byte-identical to what they were approved on.
  //
  // WHY THE LINE HAS TO BE RE-PROJECTED EVERY FRAME. A static callout is only honest while the
  // camera and the machine both hold still. This step does neither: the anatomy orbit turns the
  // robot through a full revolution, and a scene with a follow cam is still tracking its subject
  // underneath. So the anchor is a WORLD point, resolved through the scene's own rig every frame
  // (`sceneApi.anchors()`), projected with `Vector3.project(camera)`, and the leader is redrawn
  // from the card's edge to wherever that point now sits. A label that drifts off its part while
  // the shot moves is worse than no label: it teaches the wrong part.
  //
  // The scene interface is optional and additive:
  //     sceneApi.anchors?.() -> { [partId]: () => THREE.Vector3 }   world position, posed NOW
  // Absent, or missing an id, or returning null for an instant the subject is not observed (a
  // humanoid off the field), and that part simply has no leader; its CARD still renders, because
  // the card is the copy and the flow has already hidden its own DOM copy of it.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let anatomyEl = null;
  let anatomySvg = null;
  let anatomySlots = [];
  let anatomyAnchors = null;
  let anatomyPending = false; // some id has not resolved yet: a scene may build its rig lazily
  let anatomyMeasured = false;
  let anatomyTick = null; // per-frame projection; null whenever the overlay is closed
  const anchorNdc = new THREE.Vector3();
  const anchorCam = new THREE.Vector3();

  function ensureAnatomyStyles() {
    if (document.getElementById('v-anat-css')) return;
    const st = document.createElement('style');
    st.id = 'v-anat-css';
    // One grid, both layouts. The two columns push the cards to the left and right edges, and the
    // outer rows pin them top and bottom, so on a wide panel they read as four corners with the
    // machine in the middle, and on a phone - where the columns are half of 390 px - the same four
    // cards read as 2x2 above and below it. No breakpoint decides which; the panel width does.
    st.textContent = `
.v-anat{position:absolute;inset:0;z-index:2;pointer-events:none;
  display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  grid-template-rows:auto minmax(0,1fr) auto;gap:10px;padding:14px;}
.viewer.has-shud .v-anat{padding-top:48px;}
/* The scene HUD strip and the evidence banner both open across the top of the stage, and the two
   upper cards are the only thing on the overlay with a claim on that space. They step down rather
   than being covered: a callout half behind a banner is a callout nobody reads. */
.viewer.has-banner .v-anat{padding-top:58px;}
.viewer.has-shud.has-banner .v-anat{padding-top:92px;}
.v-anat-lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;}
/* the leader itself: a hairline, at the same weight as every other rule on this page */
.v-anat-line{stroke:rgba(255,255,255,0.16);stroke-width:1;}
.v-anat-dot{fill:rgba(255,255,255,0.24);}
.v-anat-card{max-width:300px;padding:13px 14px;border:1px solid var(--line-hi);border-radius:10px;
  background:rgba(24,24,24,0.86);backdrop-filter:blur(10px);
  animation:vAnatIn .34s cubic-bezier(.16,1,.3,1) both;animation-delay:var(--vd,0s);}
.v-anat-card h2{font-size:14px;font-weight:500;color:var(--tx);line-height:1.25;}
.v-anat-card p{margin-top:6px;font-size:12px;line-height:1.45;color:var(--tx-body);}
.v-anat-1{grid-row:1;grid-column:1;justify-self:start;}
.v-anat-2{grid-row:1;grid-column:2;justify-self:end;}
.v-anat-3{grid-row:3;grid-column:1;justify-self:start;}
.v-anat-4{grid-row:3;grid-column:2;justify-self:end;}
@keyframes vAnatIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
@media (max-width:700px){
  .v-anat{gap:8px;padding:10px;}
  .v-anat-card{max-width:none;padding:11px 12px;}
  .v-anat-card h2{font-size:13px;}
  .v-anat-card p{margin-top:5px;font-size:11.5px;}}
/* Asked for less motion: the cards are already there when the step opens, and the leader lines are
   projected once and on resize rather than every frame. Nothing on this overlay moves. */
@media (prefers-reduced-motion:reduce){.v-anat-card{animation:none;}}
/* ---- directed tour ----
   The cards stop being four labels that arrive together and become four BEATS. Only added when a
   tour is actually running (never under reduced motion, never on a def without a tour), so every
   other overlay keeps the stagger it was approved on.

   ONE CARD AT A TIME, and the previous one leaves. Holding spent cards on the overlay at reduced
   weight was tried first, and by the fourth beat it is four blocks of text and four leader lines
   over a shot whose whole point is that it is close on a moving machine: the label that is being
   demonstrated right now stops being findable, which is the one thing the sequence exists to do.
   A card that has had its beat lifts out (it was read, it is finished) and a card that has not had
   one yet rises in, so the direction of travel says which way the sequence is going. */
.v-anat.is-tour .v-anat-card{opacity:0;transform:translateY(10px);animation:none;
  transition:opacity .4s ease,transform .4s cubic-bezier(.16,1,.3,1);}
.v-anat.is-tour .v-anat-card.is-seen{opacity:0;transform:translateY(-8px);}
.v-anat.is-tour .v-anat-card.is-live{opacity:1;transform:none;
  border-color:color-mix(in srgb,var(--acc,#2f78ff) 42%,var(--line-hi));}`;
    document.head.appendChild(st);
  }

  /**
   * Where each card sits inside the stage, in stage pixels.
   *
   * Read in one batch and cached, because the alternative is four `getBoundingClientRect()` calls
   * interleaved with four SVG attribute writes on every frame, which is a layout flush per card.
   * The cards do not move between resizes - the grid places them - so the cache is only stale when
   * the stage is, and `resize()` is exactly where that is already known.
   */
  function measureAnatomy() {
    if (!anatomySlots.length) return;
    const sr = stage.getBoundingClientRect();
    if (sr.width < 1 || sr.height < 1) return; // the panel has no size yet; the observer will call back
    let ok = true;
    for (const slot of anatomySlots) {
      const r = slot.card.getBoundingClientRect();
      if (r.width < 1) ok = false;
      slot.cx = r.left - sr.left + r.width / 2;
      slot.cy = r.top - sr.top + r.height / 2;
      slot.hw = r.width / 2;
      slot.hh = r.height / 2;
    }
    anatomyMeasured = ok;
  }

  /**
   * The overlay's own box did not change but its contents moved inside it: opening or closing the
   * banner steps the two upper cards down or back up, and the leaders are drawn from cached card
   * geometry. No ResizeObserver fires for that, because the stage is the same size it was.
   * Inert, and cheap to call blind, while no anatomy is open.
   */
  function anatomyReflowed() {
    if (!anatomySlots.length) return;
    measureAnatomy();
    projectAnatomy();
  }

  function hideLeader(slot) {
    if (!slot.shown) return;
    slot.shown = false;
    slot.g.setAttribute('display', 'none');
  }

  function projectAnatomy() {
    if (!anatomySlots.length) return;
    if (!anatomyMeasured) measureAnatomy();
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w < 1 || h < 1) return;
    // A scene whose rig is built on its first update() has no anchors at setAnatomy() time. Re-ask
    // until every id resolves, then stop asking: the map is rebuilt at most once per frame while
    // something is still missing, and never once everything is found.
    if (anatomyPending && typeof sceneApi.anchors === 'function') {
      anatomyAnchors = sceneApi.anchors() || null;
      anatomyPending = anatomySlots.some((s) => !anatomyAnchors || typeof anatomyAnchors[s.id] !== 'function');
    }
    for (const slot of anatomySlots) {
      // Only the beat being flown has a card on screen, so it is the only one with anything for a
      // leader to start from. Off the tour every slot is revealed from the first frame and this is
      // inert.
      if (!slot.revealed) {
        hideLeader(slot);
        continue;
      }
      const get = anatomyAnchors ? anatomyAnchors[slot.id] : null;
      const p = typeof get === 'function' ? get() : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        hideLeader(slot);
        continue;
      }
      // Behind the camera. `project()` divides by w, and w is negative back there, so the point
      // comes out mirrored into the frame and the leader would confidently point at empty floor.
      // Camera space is the only place the question has a clean answer.
      anchorCam.set(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
      if (anchorCam.z > -camera.near) {
        hideLeader(slot);
        continue;
      }
      anchorNdc.set(p.x, p.y, p.z).project(camera);
      if (anchorNdc.x < -1 || anchorNdc.x > 1 || anchorNdc.y < -1 || anchorNdc.y > 1) {
        hideLeader(slot); // off frame: the part the card names is not in shot right now
        continue;
      }
      const ax = (anchorNdc.x * 0.5 + 0.5) * w;
      const ay = (-anchorNdc.y * 0.5 + 0.5) * h;
      const dx = ax - slot.cx;
      const dy = ay - slot.cy;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      // The anchor has orbited under its own card: a leader here would be a scribble inside a box.
      if (adx <= slot.hw && ady <= slot.hh) {
        hideLeader(slot);
        continue;
      }
      // Leave the card at its border rather than its centre, with a small gap, so the line reads as
      // touching the card instead of being drawn over it.
      const tx = adx > 0.001 ? (slot.hw + 5) / adx : Infinity;
      const ty = ady > 0.001 ? (slot.hh + 5) / ady : Infinity;
      const t = Math.min(tx, ty);
      const sx = slot.cx + dx * t;
      const sy = slot.cy + dy * t;
      if ((ax - sx) * (ax - sx) + (ay - sy) * (ay - sy) < 64) {
        hideLeader(slot); // under 8 px of leader is a smudge, not a line
        continue;
      }
      // Half-pixel guard: at 60 fps most frames move the anchor by less than a pixel, and skipping
      // those writes keeps the overlay off the critical path of a scene that is already rendering.
      if (
        slot.shown &&
        Math.abs(sx - slot.sx) < 0.5 &&
        Math.abs(sy - slot.sy) < 0.5 &&
        Math.abs(ax - slot.ax) < 0.5 &&
        Math.abs(ay - slot.ay) < 0.5
      ) {
        continue;
      }
      slot.sx = sx;
      slot.sy = sy;
      slot.ax = ax;
      slot.ay = ay;
      slot.line.setAttribute('x1', sx.toFixed(1));
      slot.line.setAttribute('y1', sy.toFixed(1));
      slot.line.setAttribute('x2', ax.toFixed(1));
      slot.line.setAttribute('y2', ay.toFixed(1));
      slot.dot.setAttribute('cx', ax.toFixed(1));
      slot.dot.setAttribute('cy', ay.toFixed(1));
      if (!slot.shown) {
        slot.shown = true;
        slot.g.setAttribute('display', '');
      }
    }
  }

  // ---------- directed anatomy tour ----------
  //
  // The anatomy step used to be a machine turning on the spot under four labels that all arrived at
  // once. A visitor learning what an omni drive IS gets nothing from a slow revolution: the claim is
  // that the machine moves in any direction without turning to face it, and a stationary robot
  // cannot demonstrate it. So a def MAY ship `anatomyTour` and the step becomes four SHOTS. Each
  // shot owns one card, one passage of the mission, and one camera move, and they run in sequence.
  //
  //   def.anatomyTour = {
  //     hold: 2900,                                   // ms a shot is held, and its card is live
  //     basis: { origin: partId, forward: partId },    // two anchors -> the robot's own frame
  //     beats: [{
  //       part:   partId,          // which card this shot belongs to
  //       window: [t0, t1],        // the seconds of the mission it plays, replayed once per hold
  //       frame:  'robot'|'world', // whose axes the offsets below are read in
  //       pos:    [fwd, side, up], // camera offset from the aim point, metres, at the shot's start
  //       posEnd: [fwd, side, up], // and at its end: the move. Omitted = a locked-off shot.
  //       aim:    [fwd, side, up], // aim point, offset from the part's own anchor
  //       aimEnd: [fwd, side, up],
  //     }],
  //   }
  //
  // WHY EACH BEAT CARRIES ITS OWN WINDOW. The first version ran one contiguous passage and split it
  // into four equal quarters. That makes the footage an accident of where the quarter boundaries
  // fall: the dribbler card ended up over 2.9 s in which the subject was never closer than 1.87 m
  // to the ball, which is a card claiming ball control over footage of a robot nowhere near it.
  // A log is not obliged to demonstrate four mechanisms in a row. Naming the passage per beat means
  // each card is over the seconds that actually show its claim, and the cut between beats is a cut,
  // which is the ordinary grammar for changing what a shot is about.
  //
  // WHY THE SHOTS ARE OFFSETS IN A FRAME AND NOT WORLD POSES. The subject is driving at up to
  // 3 m/s. A world pose is a shot of the patch of carpet the robot was standing on when the pose was
  // written; an offset resolved against the live rig every frame is a camera bolted to the machine,
  // which is what "tracks the robot as it moves" means. `frame: 'robot'` bolts it to the hull, so
  // the world sweeps past a robot that holds still in frame - a chase shot, and the reading that
  // makes a crab-walk legible. `frame: 'world'` bolts it to the robot's POSITION only, so the robot
  // visibly turns inside the frame; a beat about the machine's own rotation has to use it, or the
  // camera turns with the robot and the rotation disappears.
  //
  // The basis comes from two of the anatomy anchors the overlay already resolves - no new scene API,
  // and it stays correct through a presence gap, because the anchors hold their last observed pose
  // exactly as the labels do.
  //
  // WHY THE BEAT CLOCK IS THE WALL CLOCK AND THE MOTION CLOCK IS THE TIMELINE. The first version
  // derived the beat index from `timeline.t`, which sounds tidier - one clock - but ties how long a
  // card is readable to how fast its passage happens to be replayed, and breaks entirely once each
  // beat has its own window. Here the wall clock decides WHICH shot, and the timeline decides what
  // the world is doing inside it: the beat's window is handed to the timeline as a loop whose speed
  // is derived so the passage plays through exactly once per hold. Nothing to keep in sync by hand,
  // and a passage that needs slow motion to be legible at 0.4 m gets it by being short.
  const TOUR_HOLD_MS = 2900;
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const WORLD_FWD = new THREE.Vector3(1, 0, 0);
  const tourSpec =
    robotDef.anatomyTour && typeof robotDef.anatomyTour === 'object' ? robotDef.anatomyTour : null;
  const tourHold =
    tourSpec && Number.isFinite(tourSpec.hold) && tourSpec.hold > 400 ? tourSpec.hold : TOUR_HOLD_MS;
  let tourOn = false;
  let tourStart = 0; // rAF handle for the deferred start
  let tourFrom = 0; // wall ms the sequence started at
  let tourBeatAt = 0; // and the current shot
  let tourIdx = -1;
  const tourOrigin = new THREE.Vector3();
  const tourNose = new THREE.Vector3();
  const tourAnchor = new THREE.Vector3();
  const tourFwd = new THREE.Vector3();
  const tourSide = new THREE.Vector3();
  const tourPos = new THREE.Vector3();
  const tourAim = new THREE.Vector3();

  /** The slot a beat's card is, or -1. Beats name parts; slots are in the order the flow passed. */
  function tourSlotOf(beat) {
    return anatomySlots.findIndex((slot) => slot.id === (beat && beat.part));
  }

  /** Every beat names a card that exists, a window and a start offset, and the basis resolves. */
  function tourUsable() {
    if (!tourSpec || !anatomySlots.length) return false;
    const beats = tourSpec.beats;
    if (!Array.isArray(beats) || !beats.length) return false;
    const basis = tourSpec.basis || {};
    const resolves = (id) =>
      typeof id === 'string' && anatomyAnchors && typeof anatomyAnchors[id] === 'function';
    if (!resolves(basis.origin) || !resolves(basis.forward)) return false;
    return beats.every((beat) => {
      const w = beat && beat.window;
      return (
        tourSlotOf(beat) >= 0 &&
        Array.isArray(beat.pos) &&
        resolves(beat.part) &&
        Array.isArray(w) &&
        Number.isFinite(w[0]) &&
        w[1] > w[0]
      );
    });
  }

  /** `a` blended `k` of the way to `b`, per component, with `b` defaulting to `a`: a locked shot. */
  function tourAxis(a, b, i, k) {
    const from = (a && a[i]) || 0;
    const to = b && Number.isFinite(b[i]) ? b[i] : from;
    return from + (to - from) * k;
  }

  /**
   * The camera pose for a beat at phase `k`, resolved against the rig as it is posed RIGHT NOW.
   *
   * @returns {boolean} false when the rig cannot answer this frame, which leaves the camera where
   *   the last good frame put it rather than snapping it to the origin.
   */
  function tourPose(beat, k, outPos, outAim) {
    if (!anatomyAnchors) return false;
    const getA = anatomyAnchors[beat.part];
    if (typeof getA !== 'function') return false;
    tourAnchor.copy(getA());
    if (beat.frame === 'world') {
      tourFwd.copy(WORLD_FWD);
    } else {
      const getO = anatomyAnchors[tourSpec.basis.origin];
      const getF = anatomyAnchors[tourSpec.basis.forward];
      if (typeof getO !== 'function' || typeof getF !== 'function') return false;
      // Copied out, never aliased: the anchor closures each own ONE Vector3 and hand the same
      // instance back every call, so a beat whose part IS the basis origin would otherwise read its
      // own anchor twice and derive a zero-length forward.
      tourOrigin.copy(getO());
      tourNose.copy(getF());
      tourFwd.set(tourNose.x - tourOrigin.x, 0, tourNose.z - tourOrigin.z);
      if (tourFwd.lengthSq() < 1e-8) return false;
      tourFwd.normalize();
    }
    tourSide.crossVectors(tourFwd, WORLD_UP).normalize();
    outAim
      .copy(tourAnchor)
      .addScaledVector(tourFwd, tourAxis(beat.aim, beat.aimEnd, 0, k))
      .addScaledVector(tourSide, tourAxis(beat.aim, beat.aimEnd, 1, k));
    outAim.y += tourAxis(beat.aim, beat.aimEnd, 2, k);
    outPos
      .copy(outAim)
      .addScaledVector(tourFwd, tourAxis(beat.pos, beat.posEnd, 0, k))
      .addScaledVector(tourSide, tourAxis(beat.pos, beat.posEnd, 1, k));
    outPos.y += tourAxis(beat.pos, beat.posEnd, 2, k);
    return Number.isFinite(outPos.x) && Number.isFinite(outAim.x);
  }

  /**
   * Hand the beat's passage to the timeline, and light its card.
   *
   * Exactly one card is on the overlay: the one whose shot is running. `revealed` is what
   * `projectAnatomy()` reads, so turning it off for every other slot retires their leader lines
   * with them - a leader drawn to an invisible card is a hairline across the shot pointing at
   * nothing. `seen` is only ever a class, and only decides which way a card leaves.
   */
  function tourEnterBeat(idx) {
    const beat = tourSpec.beats[idx];
    const live = tourSlotOf(beat);
    const seconds = beat.window[1] - beat.window[0];
    timeline.setLoop([beat.window[0], beat.window[1]], { speed: seconds / (tourHold / 1000) });
    timeline.seek(beat.window[0]);
    timeline.play();
    for (let i = 0; i < anatomySlots.length; i++) {
      const slot = anatomySlots[i];
      const isLive = i === live;
      if (idx === 0) slot.seen = false; // the wrap reads the same way round as the first pass
      slot.revealed = isLive;
      slot.card.classList.toggle('is-live', isLive);
      slot.card.classList.toggle('is-seen', slot.seen && !isLive);
      if (isLive) slot.seen = true;
      else hideLeader(slot);
    }
    anatomyReflowed();
  }

  /**
   * Applied LAST in the frame, for the same reason the commanded ease is: OrbitControls' damped
   * `update()` is still adding a decaying slice of rotation, and it clamps the radius to
   * `minDistance`, which is a metre out from a robot 180 mm across. Writing after it is what lets
   * the shot sit where the beat asked for.
   */
  function stepTour(now) {
    const beats = tourSpec.beats;
    // `tourFrom` is the origin of the whole SEQUENCE and is never moved: the beat index has to be a
    // function of time since the tour opened, or the shot that just started immediately reads as
    // beat 0 again on the next frame and the sequence never leaves its first card.
    const slot = Math.floor(Math.max(0, now - tourFrom) / tourHold);
    const idx = slot % beats.length;
    if (idx !== tourIdx) {
      tourIdx = idx;
      tourBeatAt = tourFrom + slot * tourHold;
      tourEnterBeat(idx);
    }
    const k = clamp((now - tourBeatAt) / tourHold, 0, 1);
    if (!tourPose(beats[idx], k, tourPos, tourAim)) return;
    camera.position.copy(tourPos);
    controls.target.copy(tourAim);
    camera.lookAt(controls.target);
  }

  function startTour() {
    tourStart = 0;
    if (disposed) return;
    if (!tourUsable()) {
      // The def asked for a tour and the scene cannot answer it (an anchor that never resolved, a
      // beat naming a card that is not on this overlay). Fall back to the orbit rather than to a
      // frozen frame: a def that declares a tour also declares `rotation: 'tour'`, so the flow has
      // already switched the auto-rotate off and nothing else is going to turn it back on.
      setOrbit(true);
      return;
    }
    // The step's own playback is written by the flow SYNCHRONOUSLY after `setAnatomy()` returns
    // (a hero seek and a pause), which is why the start is deferred a frame: the tour is the later
    // writer, and it wants a passage running rather than one instant held.
    ensureControlHooks();
    camTween = null;
    orbitWanted = false;
    controls.autoRotate = false;
    tourIdx = -1;
    tourFrom = nowMs();
    tourBeatAt = tourFrom;
    tourOn = true;
    if (anatomyEl) anatomyEl.classList.add('is-tour');
    anatomySlots.forEach((slot) => {
      slot.revealed = false;
      slot.seen = false;
      hideLeader(slot);
    });
  }

  function stopTour() {
    if (tourStart) cancelAnimationFrame(tourStart);
    tourStart = 0;
    tourOn = false;
    tourIdx = -1;
    if (anatomyEl) anatomyEl.classList.remove('is-tour');
    anatomySlots.forEach((slot) => {
      slot.revealed = true;
      slot.seen = false;
      slot.card.classList.remove('is-live', 'is-seen');
    });
    // The timeline is deliberately NOT restored here: the caller closing the overlay is the flow
    // moving to its next step, and that step writes its own loop one line later. Putting the old
    // window back would be a third writer racing the two that matter.
  }

  /**
   * A hand on the stage ends the sequence, because a choreographed camera and a dragged one cannot
   * both be right and the visitor's is the one that is asked for. Every card is left on the overlay
   * at full weight - the tour's job was to introduce them one at a time, and it is over - and the
   * replay is widened from the one beat's window to the whole passage so the scene the visitor is
   * now steering is still alive rather than looping two seconds of it.
   */
  function tourHandover() {
    if (!tourOn) return;
    const beats = tourSpec.beats;
    const lo = Math.min(...beats.map((b) => b.window[0]));
    const hi = Math.max(...beats.map((b) => b.window[1]));
    stopTour();
    projectAnatomy();
    timeline.setLoop([lo, hi], { speed: 1 });
    timeline.play();
  }

  function clearAnatomy() {
    stopTour();
    anatomyTick = null;
    anatomySlots = [];
    anatomyAnchors = null;
    anatomyPending = false;
    anatomyMeasured = false;
    if (anatomyEl) anatomyEl.remove();
    anatomyEl = null;
    anatomySvg = null;
    el.classList.remove('has-anat');
  }

  /**
   * Open (or close) the anatomy overlay.
   *
   * @param {Array<{id:string,anchor?:string,label:string,description:string}>|null} parts
   *   up to four; `anchor` is the key into `sceneApi.anchors()`, defaulting to `id`.
   */
  function setAnatomy(parts) {
    const list = Array.isArray(parts) ? parts.filter(Boolean).slice(0, 4) : null;
    clearAnatomy();
    if (!list || !list.length) return;
    ensureAnatomyStyles();
    ensureControlHooks();

    anatomyEl = document.createElement('div');
    anatomyEl.className = 'v-anat';
    anatomySvg = document.createElementNS(SVG_NS, 'svg');
    anatomySvg.setAttribute('class', 'v-anat-lines');
    // The leaders duplicate no information: the card carries the copy, the line only says which
    // part it belongs to. Nothing for a screen reader to read out.
    anatomySvg.setAttribute('aria-hidden', 'true');
    anatomyEl.appendChild(anatomySvg);

    list.forEach((part, i) => {
      const card = document.createElement('article');
      card.className = `v-anat-card v-anat-${i + 1}`;
      card.style.setProperty('--vd', `${(i * 0.06).toFixed(2)}s`);
      const h = document.createElement('h2');
      h.textContent = part.label || '';
      const p = document.createElement('p');
      p.textContent = part.description || '';
      card.append(h, p);
      anatomyEl.appendChild(card);

      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('display', 'none');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'v-anat-line');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'v-anat-dot');
      dot.setAttribute('r', '2.5');
      g.append(line, dot);
      anatomySvg.appendChild(g);

      anatomySlots.push({
        id: part.anchor || part.id,
        card,
        g,
        line,
        dot,
        cx: 0,
        cy: 0,
        hw: 0,
        hh: 0,
        sx: 0,
        sy: 0,
        ax: 0,
        ay: 0,
        shown: false,
        revealed: true, // a tour leaves this on for the live card only
        seen: false, // and this on for the cards whose beat has already run
      });
    });

    stage.appendChild(anatomyEl);
    el.classList.add('has-anat');
    anatomyAnchors = typeof sceneApi.anchors === 'function' ? sceneApi.anchors() || null : null;
    anatomyPending = anatomySlots.some((s) => !anatomyAnchors || typeof anatomyAnchors[s.id] !== 'function');
    measureAnatomy();
    // Reduced motion gets ONE projection pass, and further passes only when the geometry it was
    // computed against actually changed: a resize, or the visitor orbiting by hand. Everything else
    // on this step is already still, so a per-frame loop would burn a rAF to redraw four identical
    // lines. Everything else re-projects with the render loop.
    if (!prefersReducedMotion()) anatomyTick = projectAnatomy;
    projectAnatomy();

    // A tour is motion, and it is the whole screen's motion: refused outright when the visitor
    // asked for less of it, which leaves the static posed hero with all four labels attached - a
    // complete screen, the one this step shipped with.
    if (tourSpec && !prefersReducedMotion()) tourStart = requestAnimationFrame(startTour);
  }

  // ---------- commanded camera + anatomy orbit ----------
  //
  // Both ride the existing OrbitControls rather than replacing it, so whatever the visitor does by
  // hand still wins afterwards and `reset view` still means the scene's own cameraHome.
  let orbitWanted = false;
  let camTween = null;
  let controlHooksOn = false;
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function cancelCamTween() {
    camTween = null;
    controls.autoRotate = orbitWanted;
    // Same event, and it has to be the same handler: the tour outranks the ease in the frame loop,
    // so cancelling only the ease would leave the choreography overwriting the drag it was supposed
    // to yield to on that frame and every frame after it.
    tourHandover();
  }

  /**
   * Put the shot exactly on a pose and leave nothing behind that will move it off again.
   *
   * OrbitControls with damping DECAYS its accumulated rotation instead of clearing it, so for
   * roughly a second after any rotation - a drag, or the anatomy orbit being switched off - every
   * `update()` is still adding a shrinking slice of angle. A commanded move that ends during that
   * window lands on its pose and then quietly drifts about a degree off it. One `update()` with
   * damping OFF is the only way to zero that accumulator from outside the module, and because that
   * flushing update applies the whole remaining slice first, the pose is written on both sides of
   * it. Costs one extra update per commanded move, and only on that path.
   */
  function settleControls(p, t) {
    const damped = controls.enableDamping;
    controls.enableDamping = false;
    camera.position.copy(p);
    controls.target.copy(t);
    controls.update();
    controls.enableDamping = damped;
    camera.position.copy(p);
    controls.target.copy(t);
    camera.lookAt(controls.target);
  }

  function onControlsChange() {
    // Only ever installed for the overlay. Under reduced motion this is the re-projection path
    // (a hand orbit is the visitor's own motion, not ours); with the render loop running it is
    // redundant and costs one no-op call per interaction frame.
    if (!anatomyTick) projectAnatomy();
  }

  function ensureControlHooks() {
    if (controlHooksOn) return;
    controlHooksOn = true;
    // A commanded move is a suggestion, not a seatbelt: the moment a hand lands on the stage the
    // ease gets out of the way.
    controls.addEventListener('start', cancelCamTween);
    controls.addEventListener('change', onControlsChange);
  }

  function releaseControlHooks() {
    if (!controlHooksOn) return;
    controlHooksOn = false;
    controls.removeEventListener('start', cancelCamTween);
    controls.removeEventListener('change', onControlsChange);
  }

  /**
   * Ease the shot to a pose the experience asked for. `null` means the scene's own home framing.
   *
   * @param {{position:{x,y,z},target:{x,y,z}}|null} pose
   */
  function applyCamera(pose) {
    if (!pose || !pose.position || !pose.target) {
      camTween = null;
      resetView();
      // Off the scene's own contract rather than off wherever resetView() left the camera: its
      // controls.update() has the same decaying-rotation problem every other update does.
      settleControls(
        new THREE.Vector3(home.position.x, home.position.y, home.position.z),
        new THREE.Vector3(home.target.x, home.target.y, home.target.z),
      );
      controls.autoRotate = orbitWanted;
      projectAnatomy();
      return;
    }
    const p = pose.position;
    const t = pose.target;
    if (![p.x, p.y, p.z, t.x, t.y, t.z].every((n) => Number.isFinite(n))) return;
    ensureControlHooks();
    const toP = new THREE.Vector3(p.x, p.y, p.z);
    const toT = new THREE.Vector3(t.x, t.y, t.z);
    if (prefersReducedMotion()) {
      camTween = null;
      settleControls(toP, toT);
      projectAnatomy();
      return;
    }
    camTween = {
      fromP: camera.position.clone(),
      fromT: controls.target.clone(),
      toP,
      toT,
      start: nowMs(),
      ms: CAMERA_EASE_MS,
    };
    controls.autoRotate = false; // the orbit resumes from wherever the move lands
  }

  /**
   * The slow deliberate anatomy rotation. One revolution every ANATOMY_ORBIT_MS.
   *
   * Refused outright under reduced motion, which is the whole fallback: the step then shows a
   * static hero pose with the labels attached to it, which is a complete screen rather than a
   * degraded one.
   *
   * @param {boolean} on
   */
  function setOrbit(on) {
    orbitWanted = !!on && !prefersReducedMotion();
    controls.autoRotateSpeed = orbitSpeedFor(ANATOMY_ORBIT_MS);
    controls.autoRotate = orbitWanted && !camTween;
  }

  /**
   * Applied LAST in the frame, after both stepFollow() and controls.update().
   *
   * Not a stylistic ordering. OrbitControls with damping never zeroes its `sphericalDelta`: it
   * decays it by `dampingFactor` per frame, so for a second or so after any rotation - including
   * the anatomy orbit being switched off - `update()` is still adding a shrinking slice of angle
   * every frame. Written before `update()`, the ease is that slice's starting point and the move
   * lands tens of millimetres beside the pose it was given. Written after, the ease is the last
   * writer and lands exactly on it, with the control's own glide-out harmlessly overwritten for
   * the length of the move. `lookAt` is the line `update()` would have run.
   *
   * Absolute in the same way against a follow cam: a commanded move outranks the chase for its
   * duration. The follow reclaims the target on the first frame after it lands, and because it
   * translates camera and target by the same delta, the orbit offset this set survives.
   */
  function applyCameraTween(now) {
    const k = clamp((now - camTween.start) / camTween.ms, 0, 1);
    if (k >= 1) {
      settleControls(camTween.toP, camTween.toT);
      camTween = null;
      controls.autoRotate = orbitWanted;
      return;
    }
    const e = easeOutCubic(k);
    camera.position.lerpVectors(camTween.fromP, camTween.toP, e);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, e);
    camera.lookAt(controls.target);
  }

  // ---------- render loop ----------
  const offTick = timeline.onTick(applyT);
  acquire(() => offTick());
  const offChange = timeline.onChange(applyState);
  acquire(() => offChange());

  function applyT(t) {
    if (typeof sceneApi.update === 'function') sceneApi.update(t, sceneDataOf());
    if (updateSceneHud) updateSceneHud(t);
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
  //
  // A scene may also return `followTuning`, which swaps the fixed-rate chase for a
  // critically-damped spring aimed slightly AHEAD of the subject. The fixed lerp translates the
  // camera by exactly the target's delta every frame, so the camera-to-subject vector never
  // changes and the whole world reads as one rigid plane being panned. A spring with lead runs
  // into turns and falls behind on reversals, which is what gives the shot parallax. Canned
  // scenes return nothing and keep the lerp they were approved on.
  const follow = typeof sceneApi.cameraFocus === 'function' ? sceneApi.cameraFocus : null;
  const tune = sceneApi.followTuning && typeof sceneApi.followTuning === 'object' ? sceneApi.followTuning : null;
  const followPt = new THREE.Vector3();
  const followVel = new THREE.Vector3();
  const wantPrev = new THREE.Vector3();
  const wantVel = new THREE.Vector3();
  const aimPt = new THREE.Vector3();
  let followed = false;
  let lastFollowMs = 0;
  function stepFollow() {
    if (!follow) return;
    const want = follow(timeline.t);
    if (!want) return;
    if (!followed) {
      followPt.set(want.x, want.y, want.z);
      wantPrev.copy(followPt);
      followVel.set(0, 0, 0);
      wantVel.set(0, 0, 0);
      lastFollowMs = 0;
      followed = true;
    } else if (tune) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const dt = lastFollowMs ? clamp((now - lastFollowMs) / 1000, 1 / 240, 1 / 20) : 1 / 60;
      lastFollowMs = now;
      const jump = Math.abs(want.x - followPt.x) + Math.abs(want.y - followPt.y) + Math.abs(want.z - followPt.z);
      if (jump > (tune.snap || 1.2)) {
        followPt.set(want.x, want.y, want.z);
        followVel.set(0, 0, 0);
        wantVel.set(0, 0, 0);
      } else {
        // subject velocity, low-passed so a single noisy frame does not fling the lead point
        const k = 0.25;
        wantVel.x += ((want.x - wantPrev.x) / dt - wantVel.x) * k;
        wantVel.y += ((want.y - wantPrev.y) / dt - wantVel.y) * k;
        wantVel.z += ((want.z - wantPrev.z) / dt - wantVel.z) * k;
        const lead = typeof tune.lead === 'number' ? tune.lead : 0.3;
        aimPt.set(want.x + wantVel.x * lead, want.y + wantVel.y * lead, want.z + wantVel.z * lead);
        const w = typeof tune.omega === 'number' ? tune.omega : 4.2;
        // critically damped: acc = w^2 (aim - p) - 2 w v, integrated semi-implicitly
        followVel.x += (w * w * (aimPt.x - followPt.x) - 2 * w * followVel.x) * dt;
        followVel.y += (w * w * (aimPt.y - followPt.y) - 2 * w * followVel.y) * dt;
        followVel.z += (w * w * (aimPt.z - followPt.z) - 2 * w * followVel.z) * dt;
        followPt.x += followVel.x * dt;
        followPt.y += followVel.y * dt;
        followPt.z += followVel.z * dt;
      }
      wantPrev.set(want.x, want.y, want.z);
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
  let lastFrameMs = 0;
  function frame() {
    if (disposed) return;
    stepFollow();
    // Everything conditional below is dead for a viewer that was never handed an anatomy or a
    // camera pose, which is every mission that is not in the three-step flow: `camTween` stays null,
    // `autoRotate` stays the false OrbitControls was constructed with, and the loop runs the three
    // lines it always ran. The clock is only read when one of them is live.
    if (controls.autoRotate) {
      const now = nowMs();
      // Time-based rather than per-frame, so the revolution takes ANATOMY_ORBIT_MS on a 144 Hz
      // laptop and on a throttled phone alike. Clamped, or a backgrounded tab returning to the
      // foreground spins the robot through whatever it missed in one frame.
      const dt = lastFrameMs ? clamp((now - lastFrameMs) / 1000, 1 / 240, 1 / 10) : 1 / 60;
      lastFrameMs = now;
      controls.update(dt);
    } else {
      lastFrameMs = 0;
      controls.update();
    }
    if (camTween) applyCameraTween(nowMs());
    // After the ease and after `update()`, and it outranks both: while a tour is running the
    // choreography owns the shot. `startTour()` has already cleared the ease, so the two only ever
    // coexist for the single frame a hand-drag takes to cancel it.
    if (tourOn) stepTour(nowMs());
    renderer.render(scene, camera);
    // After the render, so the matrices this projects against are the ones the frame on screen was
    // drawn with: the label lands on the pixels it belongs to rather than one frame behind them.
    if (anatomyTick) anatomyTick();
    raf = requestAnimationFrame(frame);
  }

  /**
   * A still of the frame currently on screen, as a data URI.
   *
   * The inline evidence blocks share ONE context, so this viewer is physically moved from answer to
   * answer and the block it leaves has to keep showing something truthful. A poster is what it
   * keeps.
   *
   * The renderer is constructed with `preserveDrawingBuffer: false`, so the drawing buffer is only
   * readable until the compositor takes it, which happens at the end of the task that painted it.
   * Rendering here and reading in the SAME synchronous task is therefore the whole trick, and the
   * reason this cannot be a `toDataURL` from outside: a caller reading the canvas one task later
   * gets a transparent rectangle.
   *
   * Returns null on any failure (a lost context, a zero-sized canvas, a browser that taints the
   * canvas), and the caller falls back to line art.
   *
   * @returns {string|null}
   */
  function capturePoster() {
    if (disposed) return null;
    try {
      const el2 = renderer.domElement;
      if (!el2 || !el2.width || !el2.height) return null;
      if (renderer.getContext && renderer.getContext().isContextLost && renderer.getContext().isContextLost()) {
        return null;
      }
      renderer.render(scene, camera);
      return el2.toDataURL('image/jpeg', 0.72) || null;
    } catch (_) {
      return null;
    }
  }

  // Registered BEFORE frame() rather than after, so a throw inside the first frame - which runs
  // sceneApi.update() and the renderer, the two places a bad payload actually blows up - still
  // stops the loop. `disposed` is the same flag dispose() sets, so a frame already queued no-ops.
  acquire(() => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
  });

  resize();
  applyT(timeline.t);
  // The scene's meshes exist now, however late it built them. See applyAnisotropy().
  if (rq && typeof rq === 'object' && rq.anisotropy) applyAnisotropy();
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
    capturePoster,
    /** Re-measure after the element has been moved into a differently sized host. */
    remeasure: resize,
    flashMarker,
    showBanner,
    showContextBanner,
    hideBanner,
    setAnatomy,
    applyCamera,
    // `setCamera` / `setCameraPose` / `setAutoRotate` are the names the flow probes for. Aliases
    // rather than a rename, because `applyCamera` and `setOrbit` are the names in the plan and the
    // flow lane must not have to change a line to get either behaviour.
    setCamera: applyCamera,
    setCameraPose: applyCamera,
    setOrbit,
    setAutoRotate: setOrbit,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      // The overlay first: its per-frame hook has to stop before anything it reads is torn down,
      // and its DOM is a child of `stage`, which the canvas removal below does not cover.
      camTween = null;
      orbitWanted = false;
      controls.autoRotate = false;
      clearAnatomy();
      releaseControlHooks();
      ro.disconnect();
      offTick();
      offChange();
      if (typeof sceneApi.dispose === 'function') sceneApi.dispose();
      // the PMREM render target is a GPU allocation the scene traverse below cannot reach
      if (envRT) envRT.dispose();
      if (pmrem) pmrem.dispose();
      scene.environment = null;
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
