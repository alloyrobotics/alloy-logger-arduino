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
  function frame() {
    if (disposed) return;
    stepFollow();
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
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
