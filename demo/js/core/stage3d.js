// stage3d.js - the shared 3D staging helpers: WebGL probing, the preview light rig, the
// healthy-hero timestamp, and the orbit-safe framing solve.
//
// Shared by preview.js (the picker cards' one-canvas orbiting previews) and context.js (the
// connect-screen hero). Both stage the SAME robot rigs the same way - probe for WebGL, light the
// machine, pose it at a healthy moment, cull the world down to the machine, then solve a distance
// that holds for every azimuth of the orbit - so the solve lives here once instead of being forked
// per screen. Nothing in this module touches the DOM beyond the WebGL probe canvas, and nothing in
// it owns a renderer: callers bring their own.

import * as THREE from 'three';

export const PICKER_ORBIT_MS = 14000; // one revolution

/** Healthy hero moment per robot. Deliberately not the failure window, and for rescue also
 * before the thermal build-up: its update() drives a data-driven heat glow on the left track,
 * so a late-mission pose reads as a red robot. 22 s is the cool, clean traverse. */
const T_HERO = { sbr: 20, arm6: 30, drone: 30, rescue: 22 };
const T_HERO_FALLBACK = 0.3; // fraction of duration

// Cached and released immediately: the picker is mounted and disposed on every visit, and a probe
// context left alive on each one would march the tab towards Chrome's live-context ceiling, which
// is the exact failure this module is built to avoid.
let webglSupported = null;
export function webglAvailable() {
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

/** Precedent: chart.js's zoom tween. Kept here so the 3D stages ease identically. */
export function easeOutCubic(k) {
  return 1 - (1 - k) ** 3;
}

/**
 * The posed moment for a robot's hero shot.
 *
 * Never pose a robot at or after its failure: some scenes drive data-reactive materials off the
 * telemetry (rescue's left-track heat glow, for one), so a late pose renders the wreck instead of
 * the machine. Hand-picked per built-in robot; for a generated def, back off from the earliest
 * finding window instead of trusting the raw 30 % mark.
 *
 * @param {{id:string, duration:number, findings?:Array<{window?:number[]}>}} def
 * @returns {number} seconds into the mission
 */
export function heroTime(def) {
  if (T_HERO[def.id] != null) return T_HERO[def.id];
  let ws = Infinity;
  for (const f of def.findings || []) {
    if (!f || !Array.isArray(f.window) || !Number.isFinite(f.window[0])) continue;
    if (f.window[0] < ws) ws = f.window[0];
  }
  if (!Number.isFinite(ws)) return def.duration * T_HERO_FALLBACK;
  return Math.min(def.duration * T_HERO_FALLBACK, Math.max(0, ws - 4));
}

/**
 * The preview light rig.
 *
 * The viewer's rig, pushed brighter. In the demo these dark-metal robots sit on a lit ground
 * plane inside a 58 vh panel; in a 92 px card, with no ground bounce and no fog behind them,
 * the same exposure read as a smudge. The key and the two fills carry the whole read here.
 */
export function addStageLights(scene) {
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
 *
 * MUTATES the mount: scenery is hidden by flipping `visible`, so call it once per built rig.
 *
 * @param {object} opts
 * @param {THREE.Object3D} opts.mount the group def.buildScene() populated
 * @param {object} opts.api that buildScene()'s return value (cameraHome, cameraFocus)
 * @param {number} opts.fov the camera's vertical FOV, degrees
 * @param {number} opts.fill share of the frame's height the machine should occupy
 * @param {number} opts.aspect the aspect ratio the fit must hold at
 * @param {number} [opts.samples] azimuths the framing is checked against
 * @param {number} [opts.distScale] fallback distance, relative to the robot's own cameraHome
 * @param {number} [opts.envCull] hide scenery bigger than this many cameraHome distances
 * @param {number} [opts.envRadius] and scenery whose centre sits further than this from the machine
 * @returns {{target:THREE.Vector3, dist:number, elev:number, az0:number}}
 */
export function fitOrbit(opts) {
  const {
    mount,
    api: apiIn,
    fov,
    fill,
    aspect,
    samples = 36,
    distScale = 0.9,
    envCull = 1.5,
    envRadius = 0.28,
  } = opts;
  const api = apiIn || {};
  const home = api.cameraHome;

  const target = new THREE.Vector3();
  let homeDist = 3;
  let homeTarget = null;
  let elev = 0.34;
  let az0 = 0.9;

  if (home && home.position && home.target) {
    const ht = new THREE.Vector3(home.target.x, home.target.y, home.target.z);
    const off = new THREE.Vector3(home.position.x, home.position.y, home.position.z).sub(ht);
    homeDist = off.length() || 3;
    homeTarget = ht;
    elev = Math.asin(THREE.MathUtils.clamp(off.y / homeDist, -1, 1));
    az0 = Math.atan2(off.z, off.x);
  }

  // drone and rescue travel across their worlds, so their cameraHome target only holds at t=0.
  // Both expose cameraFocus(), which reports where the machine actually is at the posed moment.
  if (typeof api.cameraFocus === 'function') {
    const p = api.cameraFocus();
    if (p && Number.isFinite(p.x)) homeTarget = new THREE.Vector3(p.x, p.y, p.z);
  }

  const focus = homeTarget || new THREE.Vector3(0, 0.4, 0);
  const limit = homeDist * envCull;
  const keep = homeDist * envRadius;
  const subject = new THREE.Box3();
  const b = new THREE.Box3();
  const env = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  mount.updateWorldMatrix(true, true);

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
  mount.traverse((o) => {
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
    if (o !== mount && o.children.length && !machineChain.has(o)) {
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
  cull(mount);

  if (subject.isEmpty()) {
    target.copy(focus);
    return { target, dist: homeDist * distScale, elev, az0 };
  }

  subject.getCenter(target);
  // Frame the WHOLE orbit, not one axis-aligned silhouette. With the camera at unit direction u
  // from the target, a subject corner at offset o needs dist >= o.u + |o.up| / kY (and the same
  // horizontally): the depth term is what perspective adds as a corner swings towards the camera.
  // A fit that ignores it is only correct at the azimuths where the machine happens to be side
  // on, and slices the machine off along the card's bottom border at the rest.
  const halfFov = Math.tan(((fov * Math.PI) / 180) / 2);
  const kY = fill * halfFov;
  const kX = kY * aspect; // square tile: horizontal allowance equals vertical
  const u = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const corner = new THREE.Vector3();
  const ce = Math.cos(elev);
  const se = Math.sin(elev);
  let dist = 0;
  for (let i = 0; i < samples; i++) {
    const az = az0 + (i / samples) * Math.PI * 2;
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
        .sub(target);
      const need =
        corner.dot(u) + Math.max(Math.abs(corner.dot(up)) / kY, Math.abs(corner.dot(right)) / kX);
      if (need > dist) dist = need;
    }
  }
  return { target, dist, elev, az0 };
}
