// sbr/scene.js - two-wheel stepper balancer, posed entirely from /balance.
//
// Rig layout (all internal maths in metres, the whole rig is scaled up by DISPLAY_SCALE so the
// robot reads against the viewer's 0.5 m blueprint grid):
//
//   rig            x = base travel, y = ground-contact correction
//    |- wheel L/R  spin about the axle from the cumulative step count (slip is visible: the
//    |             wheels keep turning while the body is on its face)
//    `- chassis    pivots about the axle by pitch: motors, three-plate PCB stack, battery,
//                  driver boards, ESP32, IMU, status LED
//
// Nothing here is keyframed. Pitch, step_rate and output at time t drive every transform.

import { sampleAt } from '../../core/prng.js';

const DISPLAY_SCALE = 3.0;
const R_WHEEL = 0.11; // m
const TRACK = 0.115; // m, half the wheel spacing
const STEPS_PER_REV = 3200; // 200 step motor at 1/16 microstepping
const WHEEL_CIRC = 2 * Math.PI * R_WHEEL;

// Base travel is compressed for framing: at the 6000 steps/s ceiling the real robot covers
// 1.3 m/s, which would leave the shot in half a second. A leaky integrator keeps the lunges
// legible and returns the robot to frame centre.
const TRAVEL_GAIN = 0.16;
const TRAVEL_TAU = 0.9;

// Colours are the brand palette: dark metals, one blue accent, sage status, alert red.
const C_PLATE = 0x101318;
const C_METAL = 0x1b1e24;
const C_ALU = 0x9aa3ad;
const C_RUBBER = 0x0b0c0d;
const C_HUB = 0x3a4049;
const C_BLUE = 0x2f78ff;
const C_SAGE = 0xd3eeb6;
const C_ALERT = 0xff5f57;

// Integration note: nudged back and up from (1.45, 1.02, 2.15)/(0, 0.42, 0). At the old framing the
// top deck sat behind the evidence banner during the fall window, which is the one moment the whole
// chassis has to be readable.
export const cameraHome = {
  position: { x: 1.62, y: 1.34, z: 2.4 },
  target: { x: 0, y: 0.52, z: 0 },
};

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  root.scale.setScalar(DISPLAY_SCALE);
  mount.add(root);

  const geoms = [];
  const mats = [];
  const track = (o) => {
    if (o.geometry) geoms.push(o.geometry);
    return o;
  };
  const mkMat = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    mats.push(m);
    return m;
  };

  const matPlate = mkMat({ color: C_PLATE, roughness: 0.66, metalness: 0.12 });
  const matMetal = mkMat({ color: C_METAL, roughness: 0.36, metalness: 0.86 });
  const matAlu = mkMat({ color: C_ALU, roughness: 0.28, metalness: 0.94 });
  const matRubber = mkMat({ color: C_RUBBER, roughness: 0.97, metalness: 0.02 });
  const matHub = mkMat({ color: C_HUB, roughness: 0.42, metalness: 0.8 });
  const matAccent = mkMat({
    color: C_BLUE,
    roughness: 0.34,
    metalness: 0.25,
    emissive: 0x0a2a6a,
    emissiveIntensity: 0.75,
  });
  const matDark = mkMat({ color: 0x14161a, roughness: 0.78, metalness: 0.15 });
  const matLed = mkMat({ color: C_SAGE, emissive: C_SAGE, emissiveIntensity: 1.6, roughness: 0.4 });

  const rig = new THREE.Group();
  root.add(rig);

  // ---------------------------------------------------------------- wheels
  const wheels = [];
  const treadGeo = track(new THREE.BoxGeometry(0.02, 0.012, 0.05));
  const tyreGeo = track(new THREE.CylinderGeometry(R_WHEEL - 0.01, R_WHEEL - 0.01, 0.042, 30));
  const rimGeo = track(new THREE.TorusGeometry(R_WHEEL * 0.78, 0.009, 8, 26));
  const hubGeo = track(new THREE.CylinderGeometry(0.021, 0.021, 0.052, 14));
  const spokeGeo = track(new THREE.BoxGeometry(0.0075, R_WHEEL * 0.72, 0.01));

  for (const side of [1, -1]) {
    const spin = new THREE.Group();
    spin.position.set(0, R_WHEEL, side * TRACK);
    rig.add(spin);
    wheels.push(spin);

    const tyre = new THREE.Mesh(tyreGeo, matRubber);
    tyre.rotation.x = Math.PI / 2;
    tyre.castShadow = true;
    tyre.receiveShadow = true;
    spin.add(tyre);

    const rim = new THREE.Mesh(rimGeo, matHub);
    rim.castShadow = true;
    spin.add(rim);

    const hub = new THREE.Mesh(hubGeo, matAlu);
    hub.rotation.x = Math.PI / 2;
    hub.castShadow = true;
    spin.add(hub);

    for (let k = 0; k < 5; k++) {
      const sp = new THREE.Mesh(spokeGeo, matAccent);
      sp.rotation.z = (k * Math.PI * 2) / 5;
      sp.position.set(
        Math.sin(sp.rotation.z) * -R_WHEEL * 0.36,
        Math.cos(sp.rotation.z) * R_WHEEL * 0.36,
        0
      );
      spin.add(sp);
    }
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI * 2) / 12;
      const tr = new THREE.Mesh(treadGeo, matRubber);
      tr.position.set(Math.sin(a) * (R_WHEEL - 0.006), Math.cos(a) * (R_WHEEL - 0.006), 0);
      tr.rotation.z = -a;
      tr.castShadow = true;
      spin.add(tr);
    }
  }

  // ---------------------------------------------------------------- chassis (pivots on the axle)
  const chassis = new THREE.Group();
  chassis.position.set(0, R_WHEEL, 0);
  rig.add(chassis);

  const bodyMeshes = [];
  const addBody = (mesh, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    chassis.add(mesh);
    bodyMeshes.push(mesh);
    return mesh;
  };

  // stepper bodies, bolted to the bottom plate, shafts out to the wheels
  const motorGeo = track(new THREE.BoxGeometry(0.058, 0.058, 0.058));
  const bossGeo = track(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 12));
  for (const side of [1, -1]) {
    const mb = new THREE.Mesh(motorGeo, matMetal);
    mb.position.set(0, 0, side * 0.052);
    addBody(mb);
    const boss = new THREE.Mesh(bossGeo, matAlu);
    boss.rotation.x = Math.PI / 2;
    boss.position.set(0, 0, side * 0.09);
    addBody(boss);
  }

  // three-plate stack. These, plus their silkscreen edges, ARE the 'body' the finding points at.
  const stackMeshes = [];
  const plateGeo = track(new THREE.BoxGeometry(0.24, 0.008, 0.135));
  const plateY = [0.055, 0.155, 0.255];
  for (const y of plateY) {
    const pl = new THREE.Mesh(plateGeo, matPlate);
    pl.position.set(0, y, 0);
    addBody(pl);
    stackMeshes.push(pl);
  }
  // accent silkscreen edge on the top plate, the one brand-blue line on the robot
  const edgeGeo = track(new THREE.BoxGeometry(0.24, 0.0022, 0.006));
  for (const z of [0.0655, -0.0655]) {
    const ed = new THREE.Mesh(edgeGeo, matAccent);
    ed.position.set(0, plateY[2] + 0.005, z);
    addBody(ed, false);
    stackMeshes.push(ed);
  }

  // standoffs
  const standoffGeo = track(new THREE.CylinderGeometry(0.0042, 0.0042, 0.092, 10));
  for (const x of [0.098, -0.098]) {
    for (const z of [0.052, -0.052]) {
      for (let k = 0; k < 2; k++) {
        const so = new THREE.Mesh(standoffGeo, matAlu);
        so.position.set(x, (plateY[k] + plateY[k + 1]) / 2, z);
        addBody(so);
      }
    }
  }

  // battery pack on the bottom plate
  const batt = new THREE.Mesh(track(new THREE.BoxGeometry(0.096, 0.03, 0.05)), matDark);
  batt.position.set(-0.03, 0.074, 0);
  addBody(batt);
  const battBand = new THREE.Mesh(track(new THREE.BoxGeometry(0.02, 0.031, 0.051)), matAccent);
  battBand.position.set(0.005, 0.074, 0);
  addBody(battBand, false);

  // two stepper drivers with heatsinks on the middle plate
  const drvGeo = track(new THREE.BoxGeometry(0.03, 0.005, 0.042));
  const sinkGeo = track(new THREE.BoxGeometry(0.02, 0.012, 0.02));
  for (const x of [0.055, -0.055]) {
    const drv = new THREE.Mesh(drvGeo, matDark);
    drv.position.set(x, plateY[1] + 0.007, 0.03);
    addBody(drv);
    const sink = new THREE.Mesh(sinkGeo, matAlu);
    sink.position.set(x, plateY[1] + 0.015, 0.03);
    addBody(sink);
  }

  // ESP32 module + IMU breakout on the top plate
  const esp = new THREE.Mesh(track(new THREE.BoxGeometry(0.052, 0.007, 0.028)), matDark);
  esp.position.set(-0.045, plateY[2] + 0.008, -0.022);
  addBody(esp);
  const can = new THREE.Mesh(track(new THREE.BoxGeometry(0.018, 0.004, 0.016)), matAlu);
  can.position.set(-0.056, plateY[2] + 0.013, -0.022);
  addBody(can);
  const imu = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.005, 0.017)), matDark);
  imu.position.set(0.045, plateY[2] + 0.007, 0.024);
  addBody(imu);
  const imuChip = new THREE.Mesh(track(new THREE.BoxGeometry(0.008, 0.003, 0.008)), matHub);
  imuChip.position.set(0.045, plateY[2] + 0.011, 0.024);
  addBody(imuChip);

  // status LED
  const led = new THREE.Mesh(track(new THREE.SphereGeometry(0.007, 12, 10)), matLed);
  led.position.set(0.098, plateY[2] + 0.012, -0.04);
  chassis.add(led);
  const ledPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.016, 0.004, 0.012)), matHub);
  ledPad.position.set(0.098, plateY[2] + 0.006, -0.04);
  addBody(ledPad, false);

  // motor wiring, top plate down to each stepper
  for (const side of [1, -1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.02, plateY[2], side * 0.05),
      new THREE.Vector3(-0.055, plateY[1] + 0.05, side * 0.078),
      new THREE.Vector3(-0.05, plateY[0] + 0.03, side * 0.072),
      new THREE.Vector3(-0.018, 0.02, side * 0.06),
    ]);
    const wire = new THREE.Mesh(track(new THREE.TubeGeometry(curve, 22, 0.0035, 5, false)), matDark);
    addBody(wire, false);
  }

  // ---------------------------------------------------------------- highlight
  // 'body' = the PCB stack, NOT every mesh bolted to it. Repainting motors, standoffs, battery and
  // wiring alert-red turned the robot into a flat red slab with no depth cues, so at 88 deg pitch
  // you could not tell it had fallen. Marking the stack alone leaves the rest of the model shaded.
  const hotMeshes = stackMeshes;
  for (const mesh of hotMeshes) {
    const hot = mesh.material.clone();
    hot.emissive = new THREE.Color(C_ALERT);
    hot.emissiveIntensity = 0;
    mats.push(hot);
    mesh.userData.baseMat = mesh.material;
    mesh.userData.hotMat = hot;
  }
  const hotMats = hotMeshes.map((m) => m.userData.hotMat);

  let highlight = null;
  function setHighlight(partId) {
    highlight = partId || null;
    const on = highlight === 'body';
    for (const mesh of hotMeshes) mesh.material = on ? mesh.userData.hotMat : mesh.userData.baseMat;
    if (!on) for (const hm of hotMats) hm.emissiveIntensity = 0;
  }

  // ---------------------------------------------------------------- derived motion tracks
  // Built once from the telemetry, so seeking and looping are exact rather than incremental.
  let tracks = null;
  function buildTracks(bal) {
    const n = bal.t.length;
    const steps = new Float64Array(n); // cumulative motor revolutions * 2pi
    const travel = new Float64Array(n); // leaky base displacement, metres
    let acc = 0;
    let x = 0;
    for (let i = 1; i < n; i++) {
      const dt = bal.t[i] - bal.t[i - 1];
      const sr = (bal.step_rate[i] + bal.step_rate[i - 1]) * 0.5;
      acc += (sr * dt * 2 * Math.PI) / STEPS_PER_REV;
      steps[i] = acc;
      // positive step_rate drives the base under a backward lean, i.e. toward -x
      const v = (-sr / STEPS_PER_REV) * WHEEL_CIRC;
      x += (v * TRAVEL_GAIN - x / TRAVEL_TAU) * dt;
      travel[i] = x;
    }
    return { t: bal.t, steps, travel, src: bal.t };
  }

  // Extreme points of the chassis in the pitch plane, relative to the axle. Once the robot goes
  // past ~80 deg one of these, not the wheels, is what is touching the floor, so the rig gets
  // lifted by however far the lowest one would have gone through it.
  const CORNERS = [
    [0.12, 0.259],
    [-0.12, 0.259],
    [0.12, 0.051],
    [-0.12, 0.051],
    [0.029, -0.029],
    [-0.029, -0.029],
  ];

  function update(tSec, data) {
    const bal = data && data['/balance'];
    if (!bal) return;
    if (!tracks || tracks.src !== bal.t) tracks = buildTracks(bal);

    const pitch = sampleAt(bal.t, bal.pitch, tSec);
    const stepRate = sampleAt(bal.t, bal.step_rate, tSec);
    const out = sampleAt(bal.t, bal.output, tSec);
    const spinAngle = sampleAt(tracks.t, tracks.steps, tSec);
    const travel = sampleAt(tracks.t, tracks.travel, tSec);

    const th = (pitch * Math.PI) / 180;
    chassis.rotation.z = -th;

    // ground contact: once it is past ~80 deg the stack, not the wheels, is on the floor
    const sin = Math.sin(th);
    const cos = Math.cos(th);
    let lowest = 0;
    for (const [cx, cy] of CORNERS) {
      const y = R_WHEEL + (-cx * sin + cy * cos);
      if (y < lowest) lowest = y;
    }
    rig.position.y = -lowest;
    rig.position.x = travel;

    for (const w of wheels) w.rotation.z = spinAngle;

    // status LED: sage while it is holding, amber under heavy command, alert once it is over
    const tilt = Math.abs(pitch);
    const effort = Math.min(Math.abs(out) / 255, 1);
    if (tilt > 20) {
      led.material.color.setHex(C_ALERT);
      led.material.emissive.setHex(C_ALERT);
      led.material.emissiveIntensity = 1.1 + Math.abs(Math.sin(tSec * 13)) * 1.9;
    } else if (effort > 0.72) {
      led.material.color.setHex(0xf5a623);
      led.material.emissive.setHex(0xf5a623);
      led.material.emissiveIntensity = 1.4;
    } else {
      led.material.color.setHex(C_SAGE);
      led.material.emissive.setHex(C_SAGE);
      led.material.emissiveIntensity = 1.0 + effort * 0.9;
    }

    // stepper buzz: a sub-millimetre shake proportional to command, so a railed motor reads as
    // working hard even when the robot is not moving
    const buzz = Math.max(0, (Math.abs(stepRate) - 3600) / 2400) * 0.0016;
    chassis.position.z = Math.sin(tSec * 190) * buzz;
    chassis.position.y = R_WHEEL + Math.abs(Math.sin(tSec * 151)) * buzz * 0.6;

    if (highlight === 'body') {
      // kept low enough that the plate's own shading still reads under the pulse
      const pulse = 0.12 + Math.abs(Math.sin(tSec * 4.2)) * 0.36;
      for (const hm of hotMats) hm.emissiveIntensity = pulse;
    }
  }

  function dispose() {
    mount.remove(root);
    for (const g of geoms) g.dispose();
    for (const m of mats) m.dispose();
    geoms.length = 0;
    mats.length = 0;
    bodyMeshes.length = 0;
    wheels.length = 0;
    tracks = null;
  }

  return { update, setHighlight, dispose, cameraHome };
}
