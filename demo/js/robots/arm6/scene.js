// arm6/scene.js - the 6-axis arm, its two pads and the payload it drops.
//
// Every link is posed straight from /joints (q0..q5, interpolated between samples), so the model is
// the exact same kinematic chain data.js logs. Link lengths, pad poses and the payload size are
// imported from ./data.js rather than restated here, so the TCP of this hierarchy lands exactly on
// the logged /ee samples and the payload sits exactly on the pads.
//
// Named highlight parts:
//   'j2'   - the shoulder-lift joint housing + its anodized ring (the joint that saturated)
//   'drv3' - the driver bay on the pedestal that runs J2 (the channel that overheats)
//
// Anatomy anchors (sceneApi.anchors(), used by the three-step flow to hang labels on the robot):
//   'j2'      - outer face of the shoulder joint housing
//   'gripper' - the TCP between the jaws, the exact point /ee logs
//   'drv3'    - top face of the driver bay
//   'base'    - the turret housing, on the q0 rotation axis
// Each one is read from the posed graph at call time, so labels stay attached while the arm moves
// and while the camera orbits.

import { sampleAt, clamp, smoothstep, lerp } from '../../core/prng.js';
import {
  LINKS, CUBE, PAD_TOP, GRASP_Y, PADS, PAD_A, PAD_B,
  DROP_T, SWAP_T, RESET_T, PROGRAMMED_RELEASE_T, rate,
} from './data.js';

const DEG = Math.PI / 180;
const GRAV = 9.81;

export const cameraHome = {
  position: { x: 2.02, y: 1.26, z: 1.86 },
  target: { x: 0.38, y: 0.40, z: -0.06 },
};

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  root.name = 'arm6';
  mount.add(root);

  // ---------------------------------------------------------------- materials
  const M = {
    casting: new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.52, metalness: 0.55 }),
    shell: new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.44, metalness: 0.42 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x0f1114, roughness: 0.72, metalness: 0.25 }),
    anod: new THREE.MeshStandardMaterial({
      color: 0x0b3a8f, roughness: 0.34, metalness: 0.6, emissive: 0x02204f, emissiveIntensity: 0.55,
    }),
    jaw: new THREE.MeshStandardMaterial({ color: 0x585f6b, roughness: 0.35, metalness: 0.8 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x181b20, roughness: 0.9, metalness: 0.1 }),
    nylon: new THREE.MeshStandardMaterial({ color: 0xd3eeb6, roughness: 0.82, metalness: 0.02 }),
    // The heavy blank is the SUBJECT of "why did the arm drop the payload?". At metalness 0.95
    // with no environment map it rendered near-black on a near-black floor, so the one thing the
    // answer is about was invisible. Brighter, mostly diffuse, with a little self-lift.
    steel: new THREE.MeshStandardMaterial({
      color: 0xc3ccd6, roughness: 0.42, metalness: 0.28, emissive: 0x2a3038, emissiveIntensity: 1,
    }),
    led: new THREE.MeshStandardMaterial({ color: 0xd3eeb6, emissive: 0xd3eeb6, emissiveIntensity: 1.5 }),
    chip: new THREE.MeshStandardMaterial({ color: 0x2f78ff, emissive: 0x2f78ff, emissiveIntensity: 0.9 }),
  };
  const lineA = new THREE.LineBasicMaterial({ color: 0xd3eeb6, transparent: true, opacity: 0.42 });
  const lineB = new THREE.LineBasicMaterial({ color: 0x2f78ff, transparent: true, opacity: 0.5 });
  const lineEnv = new THREE.LineBasicMaterial({ color: 0x2f78ff, transparent: true, opacity: 0.2 });
  const materials = Object.values(M).concat([lineA, lineB, lineEnv]);

  const geos = [];
  function geo(g) {
    geos.push(g);
    return g;
  }
  function mesh(g, m, cast = true) {
    const o = new THREE.Mesh(geo(g), m);
    o.castShadow = cast;
    o.receiveShadow = true;
    return o;
  }

  // ------------------------------------------------------------- ground dress
  // faint arc showing the program's outer reach, so "full reach" reads visually
  const envPts = [];
  for (let i = 0; i <= 72; i++) {
    const a = (-52 + (i / 72) * 104) * DEG;
    envPts.push(new THREE.Vector3(PADS.B.r * Math.cos(a), 0.004, -PADS.B.r * Math.sin(a)));
  }
  const env = new THREE.Line(geo(new THREE.BufferGeometry().setFromPoints(envPts)), lineEnv);
  root.add(env);

  function buildPad(world, lineMat) {
    const g = new THREE.Group();
    g.position.set(world.x, 0, world.z);
    const plate = mesh(new THREE.BoxGeometry(0.17, PAD_TOP, 0.17), M.pad, false);
    plate.position.y = PAD_TOP / 2;
    plate.receiveShadow = true;
    g.add(plate);
    const nest = new THREE.LineLoop(
      geo(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.043, PAD_TOP + 0.002, -0.043),
        new THREE.Vector3(0.043, PAD_TOP + 0.002, -0.043),
        new THREE.Vector3(0.043, PAD_TOP + 0.002, 0.043),
        new THREE.Vector3(-0.043, PAD_TOP + 0.002, 0.043),
      ])),
      lineMat
    );
    g.add(nest);
    root.add(g);
    return g;
  }
  buildPad(PAD_A, lineA);
  buildPad(PAD_B, lineB);

  // ----------------------------------------------------------------- pedestal
  const base = mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.05, 36), M.casting);
  base.position.y = 0.025;
  root.add(base);

  const plinth = mesh(new THREE.CylinderGeometry(0.155, 0.185, 0.09, 30), M.shell);
  plinth.position.y = 0.09;
  root.add(plinth);

  const boltGeo = geo(new THREE.CylinderGeometry(0.011, 0.011, 0.014, 8));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const b = new THREE.Mesh(boltGeo, M.trim);
    b.position.set(Math.cos(a) * 0.185, 0.053, Math.sin(a) * 0.185);
    b.castShadow = true;
    root.add(b);
  }

  // driver bay (drv3 lives here)
  const drvBay = new THREE.Group();
  drvBay.position.set(-0.235, 0.085, 0.0);
  root.add(drvBay);
  const drvBox = mesh(new THREE.BoxGeometry(0.095, 0.15, 0.17), M.casting);
  drvBay.add(drvBox);
  const finGeo = geo(new THREE.BoxGeometry(0.014, 0.13, 0.175));
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(finGeo, M.shell);
    fin.position.set(-0.052 - i * 0.019, 0.006, 0);
    fin.castShadow = true;
    drvBay.add(fin);
  }
  const drvChip = mesh(new THREE.BoxGeometry(0.006, 0.026, 0.026), M.chip, false);
  drvChip.position.set(0.05, 0.03, 0.05);
  drvBay.add(drvChip);

  // ------------------------------------------------------------------- turret
  const turret = new THREE.Group();
  turret.position.y = 0.135;
  root.add(turret);

  const turretHouse = mesh(new THREE.CylinderGeometry(0.13, 0.145, 0.105, 28), M.shell);
  turretHouse.position.y = 0.05;
  turret.add(turretHouse);
  const turretRing = mesh(new THREE.CylinderGeometry(0.134, 0.134, 0.012, 28), M.anod, false);
  turretRing.position.y = 0.104;
  turret.add(turretRing);

  // torso pitch (J1)
  const torso = new THREE.Group();
  torso.position.y = LINKS.Y1 - 0.135;
  turret.add(torso);

  const column = mesh(new THREE.BoxGeometry(0.115, LINKS.L1, 0.135), M.shell);
  column.position.y = LINKS.L1 / 2;
  torso.add(column);
  const columnRib = mesh(new THREE.BoxGeometry(0.135, LINKS.L1 * 0.62, 0.028), M.casting);
  columnRib.position.set(0, LINKS.L1 * 0.5, 0.072);
  torso.add(columnRib);
  const led = mesh(new THREE.BoxGeometry(0.012, 0.048, 0.008), M.led, false);
  led.position.set(0, LINKS.L1 * 0.78, 0.073);
  torso.add(led);

  // shoulder lift (J2) - the story joint
  const shoulder = new THREE.Group();
  shoulder.position.y = LINKS.L1;
  torso.add(shoulder);

  const j2House = mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.17, 26), M.casting);
  j2House.rotation.x = Math.PI / 2;
  shoulder.add(j2House);
  const j2Ring = mesh(new THREE.CylinderGeometry(0.083, 0.083, 0.026, 26), M.anod);
  j2Ring.rotation.x = Math.PI / 2;
  j2Ring.position.z = 0.088;
  shoulder.add(j2Ring);
  const j2Ring2 = mesh(new THREE.CylinderGeometry(0.083, 0.083, 0.026, 26), M.anod);
  j2Ring2.rotation.x = Math.PI / 2;
  j2Ring2.position.z = -0.088;
  shoulder.add(j2Ring2);

  const upper = mesh(new THREE.CylinderGeometry(0.052, 0.044, LINKS.L2, 22), M.shell);
  upper.position.y = LINKS.L2 / 2;
  shoulder.add(upper);
  const upperRib = mesh(new THREE.BoxGeometry(0.026, LINKS.L2 * 0.74, 0.088), M.casting);
  upperRib.position.y = LINKS.L2 * 0.5;
  shoulder.add(upperRib);

  // elbow (J3)
  const elbow = new THREE.Group();
  elbow.position.y = LINKS.L2;
  shoulder.add(elbow);
  const j3House = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.14, 22), M.casting);
  j3House.rotation.x = Math.PI / 2;
  elbow.add(j3House);
  const j3Ring = mesh(new THREE.CylinderGeometry(0.064, 0.064, 0.02, 22), M.anod);
  j3Ring.rotation.x = Math.PI / 2;
  j3Ring.position.z = 0.072;
  elbow.add(j3Ring);
  const fore = mesh(new THREE.CylinderGeometry(0.042, 0.035, LINKS.L3, 20), M.shell);
  fore.position.y = LINKS.L3 / 2;
  elbow.add(fore);
  const foreRib = mesh(new THREE.BoxGeometry(0.02, LINKS.L3 * 0.7, 0.07), M.casting);
  foreRib.position.y = LINKS.L3 * 0.48;
  elbow.add(foreRib);

  // wrist pitch (J4)
  const wrist = new THREE.Group();
  wrist.position.y = LINKS.L3;
  elbow.add(wrist);
  const j4House = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.105, 20), M.casting);
  j4House.rotation.x = Math.PI / 2;
  wrist.add(j4House);
  const wristTube = mesh(new THREE.CylinderGeometry(0.033, 0.031, 0.09, 18), M.shell);
  wristTube.position.y = 0.045;
  wrist.add(wristTube);

  // wrist roll (J5) + parallel gripper
  const roll = new THREE.Group();
  roll.position.y = 0.09;
  wrist.add(roll);
  const gripBody = mesh(new THREE.BoxGeometry(0.098, 0.05, 0.062), M.casting);
  gripBody.position.y = 0.026;
  roll.add(gripBody);
  const gripRail = mesh(new THREE.BoxGeometry(0.108, 0.012, 0.03), M.anod, false);
  gripRail.position.y = 0.054;
  roll.add(gripRail);

  const jaws = [];
  for (const side of [-1, 1]) {
    const j = new THREE.Group();
    j.position.y = 0.058;
    roll.add(j);
    const finger = mesh(new THREE.BoxGeometry(0.014, 0.082, 0.05), M.jaw);
    finger.position.y = 0.041;
    j.add(finger);
    const tip = mesh(new THREE.BoxGeometry(0.012, 0.019, 0.05), M.trim);
    tip.position.set(-side * 0.001, 0.082, 0);
    j.add(tip);
    jaws.push({ g: j, side });
  }

  // TCP anchor: exactly LINKS.L4 out from the J4 pivot, i.e. the point /ee logs
  const tcpAnchor = new THREE.Object3D();
  tcpAnchor.position.y = LINKS.L4 - 0.09;
  roll.add(tcpAnchor);

  // ------------------------------------------------------------------ payload
  const cubeGeo = geo(new THREE.BoxGeometry(CUBE, CUBE, CUBE));
  const cubeNylon = new THREE.Mesh(cubeGeo, M.nylon);
  cubeNylon.castShadow = true;
  cubeNylon.receiveShadow = true;
  root.add(cubeNylon);
  const cubeSteel = new THREE.Mesh(cubeGeo, M.steel);
  cubeSteel.castShadow = true;
  cubeSteel.receiveShadow = true;
  cubeSteel.visible = false;
  root.add(cubeSteel);

  // ---------------------------------------------------------------- highlight
  const PARTS = {
    j2: [j2House, j2Ring, j2Ring2],
    drv3: [drvBox, drvChip],
  };
  // one hot clone per MESH (not per material): several parts share a base material, so a shared
  // clone would have one part clearing the other's pulse
  const baseMat = new Map();
  const hotMat = new Map();
  Object.keys(PARTS).forEach((id) => {
    PARTS[id].forEach((m) => {
      baseMat.set(m, m.material);
      const h = m.material.clone();
      h.emissive = new THREE.Color(0xff5f57);
      h.emissiveIntensity = 0;
      hotMat.set(m, h);
      materials.push(h);
    });
  });

  let highlight = null;
  function setHighlight(partId) {
    highlight = PARTS[partId] ? partId : null;
    Object.keys(PARTS).forEach((id) => {
      PARTS[id].forEach((m) => {
        if (id === highlight) {
          const h = hotMat.get(m);
          h.emissiveIntensity = 0.8; // live immediately, before the next frame renders
          m.material = h;
        } else {
          m.material = baseMat.get(m);
          hotMat.get(m).emissiveIntensity = 0;
        }
      });
    });
  }

  // ------------------------------------------------------------------ anchors
  // Label anchors for the anatomy step. The offsets are in the anchor node's OWN local frame, so
  // each one rides the joint it belongs to: j2 swings with the shoulder, gripper travels with the
  // TCP, base yaws with the turret, drv3 stays on the fixed pedestal.
  const ANCHOR_NODES = {
    j2: { node: shoulder, o: [0, 0, 0.088] },
    gripper: { node: tcpAnchor, o: [0, 0, 0] },
    drv3: { node: drvBay, o: [0, 0.078, 0] },
    base: { node: turret, o: [0, 0.052, 0] },
  };

  function anchorWorld(spec) {
    // A caller can read an anchor at any point in the frame, including before the renderer has
    // refreshed the graph, so each read updates its own chain instead of trusting matrixWorld.
    spec.node.updateWorldMatrix(true, false);
    // A fresh vector every call: the projection step mutates whatever it is handed.
    return new THREE.Vector3(spec.o[0], spec.o[1], spec.o[2]).applyMatrix4(spec.node.matrixWorld);
  }

  /**
   * World positions of the four anatomy anchors, posed at call time.
   * @returns {Record<string, () => import('three').Vector3>}
   */
  function anchors() {
    const out = {};
    Object.keys(ANCHOR_NODES).forEach((id) => {
      out[id] = () => anchorWorld(ANCHOR_NODES[id]);
    });
    return out;
  }

  // ------------------------------------------------------- data-derived state
  let prep = null;

  /** Build the payload timeline once, straight out of the logged /ee grip channel. */
  function prepare(data) {
    const ee = data['/ee'];
    const t = ee.t;
    const n = t.length;

    // grip segments = [pick sample, release sample]
    const segs = [];
    let open = -1;
    for (let i = 1; i < n; i++) {
      if (ee.grip[i] === 1 && ee.grip[i - 1] === 0) open = i;
      if (ee.grip[i] === 0 && ee.grip[i - 1] === 1 && open >= 0) {
        segs.push({ i0: open, i1: i, t0: t[open], t1: t[i] });
        open = -1;
      }
    }
    const posAt = (i) => ({ x: ee.x[i], y: ee.y[i], z: ee.z[i] });
    segs.forEach((s) => {
      s.pick = posAt(s.i0);
      s.rest = posAt(s.i1);
      // a release above the pad plane is the anomaly: the part was in free air
      s.midAir = s.rest.y > GRASP_Y + 0.05;
      if (!s.midAir) s.rest.y = GRASP_Y;
    });

    // ballistic trajectory for the mid-air release
    const drop = segs.find((s) => s.midAir);
    let fall = null;
    if (drop) {
      const k = Math.max(drop.i1 - 3, 0);
      const dt = Math.max(t[drop.i1] - t[k], 1 / rate);
      const v = {
        x: (ee.x[drop.i1] - ee.x[k]) / dt,
        y: (ee.y[drop.i1] - ee.y[k]) / dt,
        z: (ee.z[drop.i1] - ee.z[k]) / dt,
      };
      const p0 = drop.rest;
      const yFloor = CUBE / 2;
      // p0.y + v.y*T - g/2 T^2 = yFloor
      const disc = Math.max(v.y * v.y + 2 * GRAV * (p0.y - yFloor), 0);
      const T = (v.y + Math.sqrt(disc)) / GRAV;
      fall = {
        t0: drop.t1, p0, v, T,
        land: { x: p0.x + v.x * T, y: yFloor, z: p0.z + v.z * T },
        vImpact: Math.sqrt(disc),
        axis: new THREE.Vector3(0.42, 0.18, -0.89).normalize(),
      };
    }

    // jaw command: gap is CLOSED for the whole taught carry window, whether or not a part is in it
    const windows = segs.map((s) => ({
      a: s.t0,
      b: s.midAir ? PROGRAMMED_RELEASE_T : s.t1,
    }));
    const holding = new Float64Array(n); // 1 while a part is actually between the jaws
    const clamped = new Float64Array(n); // 1 while the program commands the jaws shut
    for (let i = 0; i < n; i++) {
      holding[i] = ee.grip[i];
      const s = t[i];
      clamped[i] = windows.some((w) => s >= w.a && s <= w.b) ? 1 : 0;
    }
    // smooth both over ~0.16 s so the jaws move like actuators, not like step functions
    const w = Math.round(0.08 * rate);
    const smooth = (src) => {
      const outArr = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        let cnt = 0;
        for (let k = -w; k <= w; k++) {
          const j = clamp(i + k, 0, n - 1);
          acc += src[j];
          cnt++;
        }
        outArr[i] = smoothstep(acc / cnt);
      }
      return outArr;
    };

    const faultIdx = segs.findIndex((s) => s.midAir);
    const nylonSegs = segs.map((_, i) => i).filter((i) => i !== faultIdx);
    const steelSegs = faultIdx >= 0 ? [faultIdx] : [];

    return { t, ee, segs, fall, faultIdx, nylonSegs, steelSegs, hold: smooth(holding), clampCmd: smooth(clamped) };
  }

  /** Where a given cube sits at time tSec, given the grip segments it takes part in. */
  function payloadPose(segIdxs, tSec, p) {
    let held = null;
    let restIdx = -1;
    for (const k of segIdxs) {
      const s = p.segs[k];
      if (tSec >= s.t0 && tSec < s.t1) held = s;
      if (tSec >= s.t1) restIdx = k;
    }
    if (held) return { attached: true };
    if (restIdx < 0) {
      const first = p.segs[segIdxs[0]];
      return { attached: false, pos: first ? first.pick : { x: PAD_A.x, y: GRASP_Y, z: PAD_A.z } };
    }
    return { attached: false, pos: p.segs[restIdx].rest, seg: p.segs[restIdx] };
  }

  const vTmp = new THREE.Vector3();
  const qTmp = new THREE.Quaternion();
  const upAxis = new THREE.Vector3(0, 1, 0);

  function placeHeld(cube) {
    tcpAnchor.getWorldPosition(vTmp);
    tcpAnchor.getWorldQuaternion(qTmp);
    cube.position.copy(vTmp);
    cube.quaternion.copy(qTmp);
  }

  // --------------------------------------------------------------- per frame
  function update(tSec, data) {
    const J = data['/joints'];
    if (!J) return;
    if (!prep) prep = prepare(data);
    const p = prep;

    const q0 = sampleAt(J.t, J.q0, tSec);
    const q1 = sampleAt(J.t, J.q1, tSec);
    const q2 = sampleAt(J.t, J.q2, tSec);
    const q3 = sampleAt(J.t, J.q3, tSec);
    const q4 = sampleAt(J.t, J.q4, tSec);
    const q5 = sampleAt(J.t, J.q5, tSec);

    // rotation.z = -angle puts the chain's local +Y along the fk() sagittal direction
    turret.rotation.y = q0 * DEG;
    torso.rotation.z = -q1 * DEG;
    shoulder.rotation.z = -q2 * DEG;
    elbow.rotation.z = -q3 * DEG;
    wrist.rotation.z = -q4 * DEG;
    roll.rotation.y = -q5 * DEG;

    // jaws: wide open on approach, seated on the part while carrying, shut on nothing after the slip
    const hold = sampleAt(p.t, p.hold, tSec);
    const cmd = sampleAt(p.t, p.clampCmd, tSec);
    const gap = lerp(0.056, lerp(0.009, CUBE / 2 + 0.008, hold), cmd);
    jaws.forEach((j) => {
      j.g.position.x = j.side * gap;
    });

    // payload: the nylon blank shuttles every cycle except 9; the steel blank is cycle 9 only
    cubeNylon.visible = tSec < SWAP_T || tSec >= RESET_T;
    cubeSteel.visible = p.faultIdx >= 0 && tSec >= SWAP_T;

    if (cubeNylon.visible) {
      const st = payloadPose(p.nylonSegs, tSec, p);
      if (st.attached) placeHeld(cubeNylon);
      else {
        cubeNylon.position.set(st.pos.x, st.pos.y, st.pos.z);
        cubeNylon.quaternion.identity();
      }
    }

    if (cubeSteel.visible) {
      const st = payloadPose(p.steelSegs, tSec, p);
      if (st.attached) {
        placeHeld(cubeSteel);
      } else if (tSec < DROP_T) {
        cubeSteel.position.set(PAD_A.x, GRASP_Y, PAD_A.z);
        cubeSteel.quaternion.identity();
      } else if (p.fall) {
        const f = p.fall;
        const dt = tSec - f.t0;
        if (dt < f.T) {
          cubeSteel.position.set(
            f.p0.x + f.v.x * dt,
            f.p0.y + f.v.y * dt - 0.5 * GRAV * dt * dt,
            f.p0.z + f.v.z * dt
          );
          qTmp.setFromAxisAngle(f.axis, dt * 7.5);
          cubeSteel.quaternion.copy(qTmp);
        } else {
          // one small damped bounce, then it lies where it fell for the rest of the mission
          const b = dt - f.T;
          const h = Math.max(0, Math.abs(Math.sin(b * 13)) * 0.05 * Math.exp(-b * 5.2));
          cubeSteel.position.set(f.land.x, CUBE / 2 + h, f.land.z);
          qTmp.setFromAxisAngle(upAxis, 0.42);
          cubeSteel.quaternion.copy(qTmp);
        }
      }
    }

    // status LED: sage while the drives track, alert while J2 is pinned or lagging
    const tau2 = sampleAt(J.t, J.tau2, tSec);
    const ctl = data['/ctl'];
    const err2 = ctl ? sampleAt(ctl.t, ctl.err2, tSec) : 0;
    const strain = clamp(Math.max((tau2 - 9.6) / 2.4, err2 / 6), 0, 1);
    if (strain > 0.25) {
      const blink = 0.5 + 0.5 * Math.sin(tSec * 26);
      M.led.color.setHex(0xff5f57);
      M.led.emissive.setHex(0xff5f57);
      M.led.emissiveIntensity = 0.5 + blink * 2.1;
    } else {
      M.led.color.setHex(0xd3eeb6);
      M.led.emissive.setHex(0xd3eeb6);
      M.led.emissiveIntensity = 1.4;
    }
    // the J2 driver glows warmer as drv3 heats up
    const sys = data['/sys'];
    if (sys) {
      const temp = sampleAt(sys.t, sys.drv3_temp, tSec);
      const heat = clamp((temp - 38) / 34, 0, 1);
      M.chip.color.setRGB(0.18 + heat * 0.82, 0.47 - heat * 0.24, 1 - heat * 0.78);
      M.chip.emissive.copy(M.chip.color);
      M.chip.emissiveIntensity = 0.7 + heat * 0.9;
    }

    if (highlight) {
      const pulse = 0.45 + Math.abs(Math.sin(tSec * 4.6)) * 0.85;
      PARTS[highlight].forEach((m) => {
        hotMat.get(m).emissiveIntensity = pulse;
      });
    }
  }

  function dispose() {
    mount.remove(root);
    geos.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  }

  return { update, setHighlight, anchors, dispose, cameraHome };
}
