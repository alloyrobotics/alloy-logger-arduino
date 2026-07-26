// stub/scene.js - a cube rover on four wheels. Poses from /drive.x, wheels spin from /drive.vel,
// body shudders during the stall. Proves the buildScene contract: update / setHighlight / dispose.

import { sampleAt } from '../../core/prng.js';

// World framing: the rover covers ~12 m of ground over 20 s, far more than fits in shot, so
// distance is compressed and the origin is pinned to where it stalls. The stall is therefore
// always dead centre of frame.
const X_SCALE = 0.34;
const X_STALL = 5.85; // /drive.x at t = 10.0 s

export const cameraHome = {
  position: { x: 4.2, y: 2.5, z: 5.0 },
  target: { x: 0, y: 0.35, z: 0 },
};

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  mount.add(root);

  const parts = new Map();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.45, metalness: 0.35 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x025dfe, roughness: 0.35, metalness: 0.2, emissive: 0x02204f, emissiveIntensity: 0.6 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.9, metalness: 0.05 });
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xd3eeb6, emissive: 0xd3eeb6, emissiveIntensity: 1.4 });

  // chassis
  const chassis = new THREE.Group();
  root.add(chassis);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.34, 0.52), bodyMat);
  body.position.y = 0.33;
  body.castShadow = true;
  body.receiveShadow = true;
  chassis.add(body);
  parts.set('body', [body]);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.36), trimMat);
  deck.position.y = 0.525;
  deck.castShadow = true;
  chassis.add(deck);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 12), ledMat);
  led.position.set(0.3, 0.56, 0);
  chassis.add(led);

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.09, 22);
  const wheels = [];
  [
    [0.26, 0.3],
    [0.26, -0.3],
    [-0.26, 0.3],
    [-0.26, -0.3],
  ].forEach(([wx, wz]) => {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.17, wz);
    w.castShadow = true;
    chassis.add(w);
    wheels.push(w);
  });
  parts.set('wheels', wheels);

  // the obstacle it stalls against
  const blockMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.95 });
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.5, 1.6), blockMat);
  block.position.set(0.62, 0.25, 0);
  block.castShadow = true;
  block.receiveShadow = true;
  root.add(block);

  // highlight state
  let highlight = null;
  const baseEmissive = new Map();
  [bodyMat, trimMat, wheelMat].forEach((m) => baseEmissive.set(m, { color: m.emissive.clone(), intensity: m.emissiveIntensity }));

  const hotMat = new THREE.MeshStandardMaterial({
    color: 0x2a2f38,
    roughness: 0.45,
    metalness: 0.35,
    emissive: 0xff5f57,
    emissiveIntensity: 0.0,
  });

  function setHighlight(partId) {
    highlight = partId || null;
    parts.forEach((meshes, id) => {
      meshes.forEach((m) => {
        if (id === 'body') m.material = highlight === 'body' ? hotMat : bodyMat;
      });
    });
    if (!highlight) hotMat.emissiveIntensity = 0;
  }

  let wheelPhase = 0;
  let lastT = 0;

  function update(tSec, data) {
    const d = data['/drive'];
    if (!d) return;
    const x = sampleAt(d.t, d.x, tSec);
    const vel = sampleAt(d.t, d.vel, tSec);
    const cur = sampleAt(d.t, d.current, tSec);

    chassis.position.x = (x - X_STALL) * X_SCALE;

    const dt = Math.min(Math.abs(tSec - lastT), 0.12);
    lastT = tSec;
    // roll rate matched to the compressed ground speed so the wheels do not skate
    wheelPhase += ((vel * X_SCALE) / 0.17) * dt;
    wheels.forEach((w) => {
      w.rotation.y = wheelPhase;
    });

    // stall shudder: high current with no motion
    const strain = Math.max(0, (cur - 6) / 14) * (1 - Math.min(vel / 0.3, 1));
    chassis.rotation.z = Math.sin(tSec * 47) * 0.035 * strain;
    chassis.position.y = Math.abs(Math.sin(tSec * 61)) * 0.012 * strain;

    led.material.emissiveIntensity = strain > 0.15 ? 0.3 + Math.abs(Math.sin(tSec * 9)) * 1.6 : 1.2;
    led.material.color.setHex(strain > 0.15 ? 0xff5f57 : 0xd3eeb6);
    led.material.emissive.setHex(strain > 0.15 ? 0xff5f57 : 0xd3eeb6);

    if (highlight) {
      hotMat.emissiveIntensity = 0.35 + Math.abs(Math.sin(tSec * 4.4)) * 0.75;
    }
  }

  function dispose() {
    mount.remove(root);
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    [bodyMat, trimMat, wheelMat, ledMat, blockMat, hotMat].forEach((m) => m.dispose());
  }

  return { update, setHighlight, dispose, cameraHome };
}
