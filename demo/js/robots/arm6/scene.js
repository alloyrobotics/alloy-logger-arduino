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
//
// Instrument decals (see "instrument decals" below):
//   a torque readout beside J2, a grip readout beside the jaws and a temperature readout beside the
//   driver bay, each painted from the same logged array the chart reads, and each lit only while
//   the tour is actually shooting the part it belongs to.

import { sampleAt, clamp, smoothstep, lerp } from '../../core/prng.js';
import {
  LINKS, CUBE, PAD_TOP, GRASP_Y, PADS, PAD_A, PAD_B,
  DROP_T, SWAP_T, RESET_T, PROGRAMMED_RELEASE_T, rate, TAU_CLAMP,
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

  // -------------------------------------------------------- instrument decals
  //
  // WHY THE MACHINE CARRIES A READOUT AT ALL. Three of the four anatomy cards make a claim about a
  // NUMBER rather than about a shape: J2 is "the joint that saturates at 12 Nm", the gripper's
  // "grip state is logged 0 or 1", and the driver is the part "whose temperature creeps during the
  // run". A camera move can show a shoulder, a pair of jaws and a driver bay; it cannot show a
  // torque arriving at a clamp and staying there, a channel stepping 0 to 1, or a heatsink going
  // from 37.9 to 71.3 C. All three claims were therefore being made over footage in which nothing
  // verified them, which is the finding this section answers. Each decal is the
  // claimed channel, painted next to the part it belongs to, sampled from the same array the
  // failure step's chart plots. Nothing here is authored: the clamp is `TAU_CLAMP[2]` out of
  // data.js and the thermal span is the run's own min and max, read off the built array.
  //
  // WHY THEY ARE SPRITES DRAWN OVER THE TOP. A decal is an instrument reading, not a sticker on
  // the casting: at the tour's 0.30 m stand-off on the driver bay, a plane bolted to the bay's
  // face is a parallelogram of unreadable text, and at 0.92 m on the shoulder the upper arm swings
  // in front of it twice a cycle. A billboard with `depthTest` off holds square to the lens and
  // stays legible, which is the whole point of putting a number on the screen.
  //
  // WHY THEY GATE ON THE SHOT AND NOT ON A FLAG. The scene is handed no beat index - the tour is
  // the viewer's, and `setHighlight()` is null for the whole anatomy step - so "is this part the
  // subject right now" is MEASURED rather than declared: a decal lights only while its own anchor
  // is in front of the camera, near the middle of the frame, and inside the stand-off band its
  // panel was sized for. That is true of exactly one beat each, measured off the live page over a
  // full tour cycle rather than reasoned about: J2 sits at 0.99 m and ndc -0.51 on its own beat,
  // 1.52 m away on the turret beat, 0.22 m away (inside the near band, so under its floor) on the
  // driver beat, and off the left edge at ndc -3.5 on the gripper beat. The TCP sits at 0.37-0.47 m
  // and ndc -0.05 on the gripper beat, 1.37 m away on the J2 beat, 1.02-1.29 m on the turret beat,
  // and swings past the driver beat's lens at ndc -2.3 to -43. The bay sits at 0.30 m on its own
  // beat and no nearer than 0.98 m on any other. All three gates are false at every other framing
  // in the flow, where the camera is 2.4 m out and a panel sized to be read from 0.3 m would be an
  // illegible smear across the machine.
  //
  // The camera is captured from the pedestal's own `onBeforeRender`, which is the only per-frame
  // camera the scene interface exposes. One frame of lag, on a gate that only changes at a cut.
  //
  // WHY A DECAL WAITS BEFORE IT LIGHTS. That gate is geometric and the tour's camera CUTS, so a
  // panel arrives on the first frame of its own beat. The card does not:
  // `.v-anat.is-tour .v-anat-card` crossfades over 0.4 s, so for the first fifth of a second after
  // every cut the card still lit is the OUTGOING one. Measured on the live page 25 ms into the cut
  // from the J2 beat to the gripper beat: the J2 card at opacity 1.00, the gripper card at 0.00,
  // and between them an EE GRIP panel reading "logged 0 or 1" - the gripper card's own words -
  // stating the incoming card's claim under the outgoing card's heading. A FRAMING that has moved
  // on ahead of its label is ordinary film grammar and the ssl tour has it too; a NUMBER belonging
  // to a claim nobody has made yet is not, which is why the settle is on the decals and the camera
  // still cuts. 440 ms clears the 0.4 s fade with a frame or two of slack and costs the panel an
  // eighth of a 3500 ms hold it has no use for: every reading here - the torque arriving at its
  // clamp, the grip bit stepping, the heatsink climbing 30 C - develops across the whole beat, not
  // in its first fifth of a second.
  //
  // Hiding is immediate, in the other direction, and deliberately: an OLD panel over the new shot
  // is the same false statement the other way round. The 120 ms grace only stops a one-frame gate
  // dropout - an anchor grazing the ndc limit - from costing a panel a fresh settle mid-beat. A
  // real cut leaves the gate false for a whole 3.5 s beat and always gets one.
  const DECAL_SETTLE_MS = 440;
  const DECAL_GATE_GRACE_MS = 120;
  const decalNow = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const DECAL_CANVAS_W = 340;
  const DECAL_CANVAS_H = 132;
  const SAGE = '#d3eeb6';
  const ALERT = '#ff5f57';
  const TAU2_CLAMP = TAU_CLAMP[2];
  const TAU2_SCALE = TAU2_CLAMP * 1.12; // headroom past the clamp, so the pin reads as a stop
  const decals = [];
  const textures = [];
  const decalTmp = new THREE.Vector3();
  const decalNdc = new THREE.Vector3();
  const decalRight = new THREE.Vector3();
  const decalUp = new THREE.Vector3();
  let lastCamera = null;
  base.onBeforeRender = (renderer, scn, cam) => {
    lastCamera = cam;
  };

  function roundRectPath(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /** The card's own chrome, so a decal reads as part of the same overlay as the four callouts. */
  function decalPanel(g, edge) {
    g.clearRect(0, 0, DECAL_CANVAS_W, DECAL_CANVAS_H);
    g.fillStyle = 'rgba(20,20,22,0.90)';
    roundRectPath(g, 3, 3, DECAL_CANVAS_W - 6, DECAL_CANVAS_H - 6, 14);
    g.fill();
    g.strokeStyle = edge;
    g.lineWidth = 2.5;
    g.stroke();
  }

  /** A meter with an optional hard mark on it: the limit the fill is allowed to reach. */
  function decalBar(g, y, frac, fill, markFrac) {
    const x = 20;
    const w = DECAL_CANVAS_W - 40;
    const h = 13;
    g.fillStyle = 'rgba(255,255,255,0.10)';
    roundRectPath(g, x, y, w, h, h / 2);
    g.fill();
    const lit = clamp(frac, 0, 1) * w;
    if (lit > 1) {
      g.fillStyle = fill;
      roundRectPath(g, x, y, Math.max(lit, h), h, h / 2);
      g.fill();
    }
    if (markFrac != null) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(x + w * markFrac - 1.5, y - 5, 3, h + 10);
    }
  }

  /**
   * One decal: a canvas panel on a billboard, repainted only when the digits it shows change.
   *
   * @param {number} worldWidth  metres across, sized for the stand-off of the beat that shows it
   * @param {[number,number]} lift  where the panel sits relative to the part's anchor, in metres
   *   ACROSS and UP THE FRAME rather than across the world. A panel is a thing you read, so where
   *   it belongs is a fact about the picture - clear of the callout card, clear of the part it
   *   points at - and an offset in world axes only lands there from the azimuth it was written
   *   for. Read off the live camera basis, it lands there from any of them.
   * @param {[number,number]} band  the stand-off window, metres, in which this decal is lit
   * @param {() => import('three').Vector3} anchorOf  the part's own anchor, posed now
   * @param {(ctx:CanvasRenderingContext2D, ...args:any[]) => void} paint
   */
  function makeDecal(worldWidth, lift, band, anchorOf, paint) {
    let ctx = null;
    let tex = null;
    // buildScene() is constructed under plain `node` by experience.test.mjs, where there is no
    // document: the decal still exists as a scene object, it simply has nothing painted on it.
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = DECAL_CANVAS_W;
      c.height = DECAL_CANVAS_H;
      ctx = typeof c.getContext === 'function' ? c.getContext('2d') : null;
      if (ctx) {
        tex = new THREE.CanvasTexture(c);
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
        textures.push(tex);
      }
    }
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
    });
    materials.push(mat);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(worldWidth, (worldWidth * DECAL_CANVAS_H) / DECAL_CANVAS_W, 1);
    sprite.renderOrder = 20;
    sprite.frustumCulled = false;
    sprite.visible = false;
    root.add(sprite);

    let key = null;
    // Wall ms the geometric gate has been continuously true since, and the last frame it was true
    // at all. Two clocks, because the settle has to survive a dropped frame and not a cut.
    let gateSince = 0;
    let gateLast = 0;
    const decal = {
      sprite,
      /** Position on the part, and decide whether this shot is the one this decal belongs to. */
      place() {
        const a = anchorOf();
        sprite.position.copy(a);
        if (!lastCamera) {
          sprite.visible = false;
          return;
        }
        decalRight.setFromMatrixColumn(lastCamera.matrixWorld, 0);
        decalUp.setFromMatrixColumn(lastCamera.matrixWorld, 1);
        sprite.position.addScaledVector(decalRight, lift[0]).addScaledVector(decalUp, lift[1]);
        const d = lastCamera.position.distanceTo(a);
        decalTmp.copy(a);
        lastCamera.worldToLocal(decalTmp);
        decalNdc.copy(a).project(lastCamera);
        const off = Math.max(Math.abs(decalNdc.x), Math.abs(decalNdc.y));
        const framed = decalTmp.z < -0.02 && d >= band[0] && d <= band[1] && off <= 0.92;
        if (!framed) {
          sprite.visible = false;
          return;
        }
        const t = decalNow();
        if (!gateSince || t - gateLast > DECAL_GATE_GRACE_MS) gateSince = t;
        gateLast = t;
        sprite.visible = t - gateSince >= DECAL_SETTLE_MS;
      },
      /** Repaint, but only when the reading has actually moved a displayed digit. */
      show(k, ...args) {
        if (!ctx || k === key) return;
        key = k;
        paint(ctx, ...args);
        if (tex) tex.needsUpdate = true;
      },
    };
    decals.push(decal);
    return decal;
  }

  /**
   * J2's torque against its own current limit. The bar runs past the clamp so the fill visibly
   * arrives at the mark and stops there, which is what saturation looks like; err2 rides alongside
   * because a joint out of torque is a joint falling behind its commanded angle, and that lag is
   * the sag the shot is of.
   */
  function paintTorque(g, tau, err, pinned) {
    decalPanel(g, pinned ? 'rgba(255,95,87,0.80)' : 'rgba(255,255,255,0.18)');
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.font = '600 21px Geist, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.62)';
    g.fillText('J2 TAU2', 20, 33);
    g.textAlign = 'right';
    g.font = '400 19px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText(`err2 ${err.toFixed(2)} deg`, DECAL_CANVAS_W - 20, 33);

    const value = tau.toFixed(2);
    g.textAlign = 'left';
    g.font = '600 46px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = pinned ? ALERT : '#ffffff';
    g.fillText(value, 20, 84);
    const valueW = g.measureText(value).width;
    g.font = '400 22px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText('Nm', 28 + valueW, 84);

    g.textAlign = 'right';
    g.font = '600 21px Geist, system-ui, sans-serif';
    g.fillStyle = pinned ? ALERT : 'rgba(255,255,255,0.45)';
    g.fillText(pinned ? 'SATURATED' : `clamp ${TAU2_CLAMP.toFixed(2)}`, DECAL_CANVAS_W - 20, 82);
    decalBar(g, 99, Math.abs(tau) / TAU2_SCALE, pinned ? ALERT : SAGE, TAU2_CLAMP / TAU2_SCALE);
  }

  /**
   * The driver's heatsink estimate, with the whole run drawn under it.
   *
   * WHY A TRACE AND NOT JUST A NUMBER. "Creeps during the run" is a claim about a SHAPE over 80 s,
   * and a bare reading is only evidence of it to someone who watched the previous two seconds. The
   * panel therefore carries the run's own drv3_temp track with a playhead on it, so a single frame
   * anywhere in the beat already shows the climb, where it started, where it is now and that it
   * has not levelled off. The number and the delta then say how much, in figures.
   */
  function paintTemp(g, temp, rise, peak, col, spark, playhead, at) {
    decalPanel(g, 'rgba(255,255,255,0.18)');
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.font = '600 21px Geist, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.62)';
    g.fillText('DRV3 TEMP', 20, 31);
    g.textAlign = 'right';
    g.font = '400 19px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText(`peak ${peak.toFixed(1)}`, DECAL_CANVAS_W - 20, 31);

    const value = temp.toFixed(1);
    g.textAlign = 'left';
    g.font = '600 44px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = '#ffffff';
    g.fillText(value, 20, 78);
    const valueW = g.measureText(value).width;
    g.font = '400 22px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText('C', 28 + valueW, 78);

    g.textAlign = 'right';
    g.font = '600 26px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = col;
    g.fillText(`+${rise.toFixed(1)}`, DECAL_CANVAS_W - 20, 76);

    const x0 = 20;
    const x1 = DECAL_CANVAS_W - 20;
    const yTop = 88;
    const yBot = 122;
    const n = spark ? spark.length : 0;
    const px = (i) => x0 + ((x1 - x0) * i) / Math.max(n - 1, 1);
    const py = (v) => yBot - (yBot - yTop) * v;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0, yBot + 0.5);
    g.lineTo(x1, yBot + 0.5);
    g.stroke();
    if (n > 1) {
      g.beginPath();
      g.moveTo(x0, yBot);
      for (let i = 0; i < n; i++) g.lineTo(px(i), py(spark[i]));
      g.lineTo(x1, yBot);
      g.closePath();
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) g.moveTo(px(i), py(spark[i]));
        else g.lineTo(px(i), py(spark[i]));
      }
      g.strokeStyle = 'rgba(255,255,255,0.62)';
      g.lineWidth = 2.5;
      g.stroke();
    }
    const hx = x0 + (x1 - x0) * clamp(playhead, 0, 1);
    g.strokeStyle = 'rgba(255,255,255,0.30)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(hx, yTop - 6);
    g.lineTo(hx, yBot);
    g.stroke();
    g.fillStyle = col;
    g.beginPath();
    g.arc(hx, py(clamp(at, 0, 1)), 5, 0, Math.PI * 2);
    g.fill();
  }

  /**
   * The end effector's own logged grip bit, and the seconds either side of now.
   *
   * WHY A STEP TRACE AND NOT A LIGHT. The card's claim is not "the jaws are shut", it is that the
   * grip state IS LOGGED, 0 or 1. A lamp that is on says nothing about a channel; a square step
   * from 0 to 1 with a playhead on it says there is a bit in the log, what it was a moment ago,
   * what it is now, and exactly when it changed. Both states are therefore on the panel at once -
   * the one the run is in, in figures, and the one it just left, on the trace - which is the whole
   * of "0 or 1" in a single frame. The trace is 3.2 s wide, so the pick transition the beat is cut
   * around is on it for every frame of the beat, not just the frames after it happens.
   */
  function paintGrip(g, grip, trace, playhead) {
    const on = grip >= 0.5;
    decalPanel(g, on ? 'rgba(211,238,182,0.55)' : 'rgba(255,255,255,0.18)');
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.font = '600 21px Geist, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.62)';
    g.fillText('EE GRIP', 20, 31);
    g.textAlign = 'right';
    g.font = '400 19px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText('logged 0 or 1', DECAL_CANVAS_W - 20, 31);

    const value = on ? '1' : '0';
    g.textAlign = 'left';
    g.font = '600 46px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = on ? SAGE : '#ffffff';
    g.fillText(value, 20, 82);
    const valueW = g.measureText(value).width;
    g.font = '600 21px Geist, system-ui, sans-serif';
    g.fillStyle = on ? SAGE : 'rgba(255,255,255,0.55)';
    g.fillText(on ? 'HOLDING' : 'OPEN', 30 + valueW, 80);

    // the two rails the step runs between, labelled, so the trace reads as a channel and not a bar
    const x0 = 118;
    const x1 = DECAL_CANVAS_W - 20;
    const yHi = 56;
    const yLo = 96;
    g.textAlign = 'right';
    g.font = '400 15px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.30)';
    g.fillText('1', x0 - 8, yHi + 5);
    g.fillText('0', x0 - 8, yLo + 5);
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    [yHi, yLo].forEach((y) => {
      g.beginPath();
      g.moveTo(x0, y + 0.5);
      g.lineTo(x1, y + 0.5);
      g.stroke();
    });

    const n = trace ? trace.length : 0;
    if (n > 1) {
      g.strokeStyle = SAGE;
      g.lineWidth = 2.5;
      g.lineJoin = 'miter';
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / (n - 1);
        const y = trace[i] >= 0.5 ? yHi : yLo;
        if (i === 0) g.moveTo(x, y);
        else {
          g.lineTo(x, y); // the vertical riser is this segment: the step is drawn, not smoothed
        }
      }
      g.stroke();
    }
    const hx = x0 + (x1 - x0) * clamp(playhead, 0, 1);
    g.strokeStyle = 'rgba(255,255,255,0.30)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(hx, yHi - 8);
    g.lineTo(hx, yLo + 8);
    g.stroke();
    g.fillStyle = on ? SAGE : 'rgba(255,255,255,0.75)';
    g.beginPath();
    g.arc(hx, on ? yHi : yLo, 5, 0, Math.PI * 2);
    g.fill();
  }

  // The three panels, each sized and placed for the one beat that lights it. J2 is read from 0.98 m
  // and sits a fifth of a metre above the joint, which on that shot is the empty air the upper arm
  // has just swung out of. The driver is read from 0.30 m and sits up and to the LEFT of the bay,
  // because its own callout card holds the top-right corner of the panel on that beat and a
  // readout half behind a card is a readout nobody reads. The grip panel is the same call on the
  // gripper beat: its card holds the top RIGHT, the part hangs below the TCP, so the readout takes
  // the empty left. 0.15 m across at a 0.37-0.47 m stand-off is 38 per cent of the phone frame's,
  // which is the same share of the picture the torque panel takes on its own beat.
  const torqueDecal = makeDecal(
    0.34,
    [0.02, 0.19],
    [0.62, 1.22],
    () => anchorWorld(ANCHOR_NODES.j2),
    paintTorque,
  );
  const gripDecal = makeDecal(
    0.15,
    [-0.085, 0.075],
    [0.30, 0.58],
    () => anchorWorld(ANCHOR_NODES.gripper),
    paintGrip,
  );
  const tempDecal = makeDecal(
    0.132,
    [-0.058, 0.034],
    [0.17, 0.52],
    () => anchorWorld(ANCHOR_NODES.drv3),
    paintTemp,
  );

  // 3.2 s of the grip channel, centred on the playhead. Wide enough that the pick step at 28.28 s
  // is on the trace for every frame of a beat that runs 28.1 to 29.5 s, narrow enough that a single
  // transition is a step and not a spike. 64 points is one per 50 ms, two and a half samples of a
  // 50 Hz channel, so no edge in the log can fall between two points of the trace.
  const GRIP_TRACE_HALF = 1.6;
  const GRIP_TRACE_N = 64;
  const GRIP_TRACE_MID = 0.5; // the window is centred, so now is always the middle of it
  const gripPts = new Float64Array(GRIP_TRACE_N);

  /** The sample index of `tt`, clamped: outside the log the trace holds the end value. */
  function gripIndex(p, tt) {
    const i = Math.round((tt - p.t[0]) * rate);
    return i < 0 ? 0 : i >= p.t.length ? p.t.length - 1 : i;
  }

  /** The logged bit, read out of /ee.grip rather than off the jaw animation, which is smoothed. */
  function gripAt(p, tSec) {
    return p.ee.grip[gripIndex(p, tSec)] >= 0.5 ? 1 : 0;
  }

  function gripTrace(p, tSec) {
    let key = '';
    for (let i = 0; i < GRIP_TRACE_N; i++) {
      const tt = tSec - GRIP_TRACE_HALF + (2 * GRIP_TRACE_HALF * i) / (GRIP_TRACE_N - 1);
      const v = p.ee.grip[gripIndex(p, tt)] >= 0.5 ? 1 : 0;
      gripPts[i] = v;
      key += v;
    }
    return { pts: gripPts, key };
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

    // The driver decal's scale is the run's OWN thermal range, measured here rather than written
    // down: the bar is empty at the first sample the log carries and full at the hottest one, so
    // "creeps during the run" is read off the same array the /sys chart plots.
    const sys = data['/sys'];
    let thermal = null;
    if (sys && sys.drv3_temp && sys.drv3_temp.length) {
      const a = sys.drv3_temp;
      let lo = a[0];
      let hi = a[0];
      for (let i = 1; i < a.length; i++) {
        if (a[i] < lo) lo = a[i];
        if (a[i] > hi) hi = a[i];
      }
      const span = Math.max(hi - lo, 1);
      // 68 points is one per 1.2 s of an 80 s run and about two canvas pixels apart, which is as
      // much of the track as the panel can resolve; built once, so the trace is not re-sampled on
      // every repaint.
      const N = 68;
      const spark = new Float64Array(N);
      const t0 = sys.t[0];
      const t1 = sys.t[sys.t.length - 1];
      for (let i = 0; i < N; i++) {
        spark[i] = clamp((sampleAt(sys.t, a, t0 + ((t1 - t0) * i) / (N - 1)) - lo) / span, 0, 1);
      }
      thermal = { start: a[0], lo, hi, span, spark, t0, t1 };
    }

    return { t, ee, segs, fall, faultIdx, nylonSegs, steelSegs, thermal, hold: smooth(holding), clampCmd: smooth(clamped) };
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
    let heat = 0;
    let temp = 0;
    if (sys) {
      temp = sampleAt(sys.t, sys.drv3_temp, tSec);
      heat = clamp((temp - 38) / 34, 0, 1);
      M.chip.color.setRGB(0.18 + heat * 0.82, 0.47 - heat * 0.24, 1 - heat * 0.78);
      M.chip.emissive.copy(M.chip.color);
      M.chip.emissiveIntensity = 0.7 + heat * 0.9;
    }

    // The three decals: same samples the LED, the jaws and the chip already run on, spelled out in
    // figures for the three cards that make a claim about a number. `place()` also decides whether
    // this frame's shot is the one that decal belongs to, so the panel is only ever on screen at
    // the stand-off it was sized for.
    torqueDecal.place();
    if (torqueDecal.sprite.visible) {
      const pinned = Math.abs(tau2) >= TAU2_CLAMP - 0.005;
      torqueDecal.show(`${tau2.toFixed(2)}|${err2.toFixed(2)}|${pinned}`, tau2, err2, pinned);
    }
    gripDecal.place();
    if (gripDecal.sprite.visible) {
      const grip = gripAt(p, tSec);
      const trace = gripTrace(p, tSec);
      // The key changes on the digit and on the shape of the window, so the panel repaints as the
      // trace slides and not once per frame of a run in which nothing about it has moved.
      gripDecal.show(`${grip}|${trace.key}`, grip, trace.pts, GRIP_TRACE_MID);
    }
    tempDecal.place();
    if (sys && p.thermal && tempDecal.sprite.visible) {
      const th = p.thermal;
      const rise = Math.max(temp - th.start, 0);
      const col = `rgb(${Math.round(70 + heat * 185)},${Math.round(140 - heat * 55)},${Math.round(255 - heat * 200)})`;
      const playhead = clamp((tSec - th.t0) / Math.max(th.t1 - th.t0, 1e-6), 0, 1);
      tempDecal.show(
        `${temp.toFixed(1)}|${rise.toFixed(1)}|${playhead.toFixed(3)}`,
        temp, rise, th.hi, col, th.spark, playhead, clamp((temp - th.lo) / th.span, 0, 1),
      );
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
    // The decal canvases are GPU uploads the viewer's own scene traverse cannot reach: its sweep
    // disposes geometries and materials, and a SpriteMaterial's map is neither.
    textures.forEach((t) => t.dispose());
    lastCamera = null;
  }

  return { update, setHighlight, anchors, dispose, cameraHome };
}
