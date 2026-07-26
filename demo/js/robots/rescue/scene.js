// rescue/scene.js - tracked rescue robot climbing a rubble pile.
//
// The pile is not decoration: it is built from the SAME terrain functions data.js used to derive
// /imu.pitch, so the chart and the 3D view can never disagree about where the incline is or how
// steep it is. The robot's position comes from dead reckoning the two logged track velocities
// (data.js derivePose), and the track surfaces scroll off cmd_l/cmd_r, so when the left track loses
// grip you literally see it spinning while the machine stops and then slides back down the face.
//
// Distance compression: the mission covers ~20 m of ground, far more than fits in shot. The flat
// approach is compressed hard and the incline is played near full size, blended smoothly over the
// last 2 m of the approach so nothing jumps. World origin = the toe of the rubble pile.

import { sampleAt, clamp, lerp, smoothstep, mulberry32 } from '../../core/prng.js';
import { derivePose, contactAt, terrainPitchDeg, RAMP_D0, RAMP_LEN, CONTACT_HALF } from './data.js';

const S_FLAT = 0.055; // world units per metre on the flat approach
const S_RAMP = 0.62; // world units per metre on and after the rubble pile
const BLEND_A = RAMP_D0 - 2.0;
const BLEND_B = RAMP_D0 - 0.4;

const TRACK_R = 0.075; // road wheel / sprocket radius, world units
const TRACK_L = 0.2; // half the straight run of the track loop
const TRACK_W = 0.075;
const TRACK_Z = 0.185;
const FLIP_L = 0.1;
const FLIP_R = 0.048;
const FLIP_W = 0.055;
const N_GROUSER = 16;
const N_FLIP_GROUSER = 9;

// Integration note: the original home sat ~5 world units off a 0.4-unit chassis, which rendered the
// machine at ~40 px on a 1440 px layout and made the highlighted left track unreadable. Pulled in
// twice: to ~3.1 units, then to ~1.9 with the shot riding the machine (see cameraFocus). At 3.1 the
// chassis was still a ~90 px sliver in a field of rubble and a visitor could not find the robot.
// Parked on the -z side because that is the LEFT flank: the left track is the highlighted part and
// from the old +z side the hull occluded it, so the highlight read as a red smear behind the body.
export const cameraHome = {
  position: { x: 0.11, y: 0.74, z: -1.54 },
  target: { x: -0.8, y: 0.15, z: 0 },
};

// ---------------------------------------------------------------------------- world mapping

function scaleAt(d) {
  return lerp(S_FLAT, S_RAMP, smoothstep((d - BLEND_A) / (BLEND_B - BLEND_A)));
}

const W_STEP = 0.01;
const W_MIN = -1.5;
const W_MAX = 23.0;
const W_N = Math.round((W_MAX - W_MIN) / W_STEP) + 1;
const WX = new Float64Array(W_N);
const WY = new Float64Array(W_N);
let W_OFF_X = 0;
let W_OFF_Y = 0;
(function buildWorldTables() {
  let x = 0;
  let y = 0;
  for (let i = 0; i < W_N; i++) {
    const d = W_MIN + i * W_STEP;
    WX[i] = x;
    WY[i] = y;
    const p = (terrainPitchDeg(d + W_STEP / 2) * Math.PI) / 180;
    const s = scaleAt(d + W_STEP / 2);
    x += Math.cos(p) * s * W_STEP;
    y += Math.sin(p) * s * W_STEP;
  }
  const f = (RAMP_D0 - W_MIN) / W_STEP;
  const i = Math.floor(f);
  W_OFF_X = WX[i] + (WX[i + 1] - WX[i]) * (f - i);
  W_OFF_Y = WY[i] + (WY[i + 1] - WY[i]) * (f - i);
})();

/** Arc length along the mission path (m) -> world position on the terrain surface. */
export function worldPoint(d) {
  if (d <= W_MIN) return { x: WX[0] - W_OFF_X + (d - W_MIN) * S_FLAT, y: -W_OFF_Y };
  if (d >= W_MAX) return { x: WX[W_N - 1] - W_OFF_X + (d - W_MAX) * S_RAMP, y: WY[W_N - 1] - W_OFF_Y };
  const f = (d - W_MIN) / W_STEP;
  const i = Math.floor(f);
  const g = f - i;
  return {
    x: WX[i] + (WX[i + 1] - WX[i]) * g - W_OFF_X,
    y: WY[i] + (WY[i + 1] - WY[i]) * g - W_OFF_Y,
  };
}

// ---------------------------------------------------------------------------- track loop param

/**
 * Point on a stadium-shaped track loop, parameterised by arc length u.
 * Increasing u carries the top run forward, which is what a track does when the robot drives on.
 */
function loopPoint(u, L, R) {
  const P = 4 * L + 2 * Math.PI * R;
  let s = ((u % P) + P) % P;
  const straight = 2 * L;
  const arc = Math.PI * R;
  if (s < straight) return { x: -L + s, y: R, a: 0 };
  s -= straight;
  if (s < arc) {
    const th = s / R;
    return { x: L + R * Math.sin(th), y: R * Math.cos(th), a: -th };
  }
  s -= arc;
  if (s < straight) return { x: L - s, y: -R, a: Math.PI };
  s -= straight;
  const th = s / R;
  return { x: -L - R * Math.sin(th), y: -R * Math.cos(th), a: Math.PI - th };
}

function loopPerimeter(L, R) {
  return 4 * L + 2 * Math.PI * R;
}

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  mount.add(root);

  const geos = [];
  const mats = [];
  const keepGeo = (g) => {
    geos.push(g);
    return g;
  };
  const keepMat = (m) => {
    mats.push(m);
    return m;
  };

  // ---------------- materials (dark metals, one accent, sage indicators) ----------------
  const matChassis = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.52, metalness: 0.62 })
  );
  const matDeck = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x2d323a, roughness: 0.38, metalness: 0.74 })
  );
  const matAccent = keepMat(
    new THREE.MeshStandardMaterial({
      color: 0x025dfe,
      roughness: 0.3,
      metalness: 0.35,
      emissive: 0x02224f,
      emissiveIntensity: 0.75,
    })
  );
  const matDark = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85, metalness: 0.25 })
  );
  const matSprocket = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x454b54, roughness: 0.32, metalness: 0.88 })
  );
  const matTrackR = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.95, metalness: 0.08 })
  );
  const matTrackL = keepMat(
    new THREE.MeshStandardMaterial({
      color: 0x0e0f11,
      roughness: 0.95,
      metalness: 0.08,
      emissive: 0xff5f57,
      emissiveIntensity: 0,
    })
  );
  const matGrouserR = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x1c2025, roughness: 0.8, metalness: 0.3 })
  );
  const matGrouserL = keepMat(
    new THREE.MeshStandardMaterial({
      color: 0x1c2025,
      roughness: 0.8,
      metalness: 0.3,
      emissive: 0xff5f57,
      emissiveIntensity: 0,
    })
  );
  const matLens = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x0a0c0f, roughness: 0.15, metalness: 0.6 })
  );
  const matLed = keepMat(
    new THREE.MeshStandardMaterial({ color: 0xd3eeb6, emissive: 0xd3eeb6, emissiveIntensity: 1.5 })
  );
  const matLedB = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x2f78ff, emissive: 0x2f78ff, emissiveIntensity: 1.2 })
  );
  // highlight variants: swapped in by setHighlight('track_l'), pulsed in update()
  const matTrackHot = keepMat(
    new THREE.MeshStandardMaterial({
      color: 0x2a1416,
      roughness: 0.9,
      metalness: 0.1,
      emissive: 0xff5f57,
      emissiveIntensity: 0.6,
    })
  );
  const matGrouserHot = keepMat(
    new THREE.MeshStandardMaterial({
      color: 0x35191b,
      roughness: 0.8,
      metalness: 0.25,
      emissive: 0xff5f57,
      emissiveIntensity: 0.6,
    })
  );
  // rubble reads as neutral concrete, not khaki: the old warm greens were off-palette and, at the
  // same visual scale as the chassis, made the machine impossible to pick out of the debris
  const matRubbleA = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x25282d, roughness: 0.98, metalness: 0.02 })
  );
  const matRubbleB = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x1c1f23, roughness: 0.96, metalness: 0.05 })
  );
  const matRubbleC = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x2d3037, roughness: 1.0, metalness: 0.0 })
  );
  const matPileTop = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x212427, roughness: 1.0, metalness: 0.03 })
  );
  const matPileSide = keepMat(
    new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 1.0, metalness: 0.03 })
  );

  // ---------------- the rubble pile ----------------
  const pile = new THREE.Group();
  root.add(pile);

  {
    const shape = new THREE.Shape();
    const dA = RAMP_D0 - 1.35;
    const dB = RAMP_D0 + RAMP_LEN + 0.35;
    const steps = 78;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const d = dA + ((dB - dA) * i) / steps;
      pts.push(worldPoint(d));
    }
    const far = { x: pts[pts.length - 1].x + 6.0, y: pts[pts.length - 1].y };
    shape.moveTo(pts[0].x - 1.6, pts[0].y);
    pts.forEach((p) => shape.lineTo(p.x, p.y));
    shape.lineTo(far.x, far.y);
    shape.lineTo(far.x, -0.6);
    shape.lineTo(pts[0].x - 1.6, -0.6);
    shape.closePath();

    const W = 2.7;
    const g = keepGeo(new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false }));
    g.translate(0, 0, -W / 2);
    const pileMesh = new THREE.Mesh(g, [matPileSide, matPileTop]);
    pileMesh.position.y = -0.018; // tuck the flat part under the viewer's ground plane
    pileMesh.castShadow = true;
    pileMesh.receiveShadow = true;
    pile.add(pileMesh);
  }

  // scattered rubble: boxes half-buried in the face, seeded so it is identical every load
  {
    const rr = mulberry32(0x9134af);
    const boxGeo = keepGeo(new THREE.BoxGeometry(1, 1, 1));
    const rubbleMats = [matRubbleA, matRubbleB, matRubbleC];
    // fewer and smaller than before: at the old count and scale the pile was dozens of boxes the
    // same apparent size as the chassis, which is what made the robot unfindable
    for (let i = 0; i < 30; i++) {
      const u = -0.85 + rr() * (RAMP_LEN + 3.1);
      const d = RAMP_D0 + u;
      const p = worldPoint(d);
      const slope = (terrainPitchDeg(d) * Math.PI) / 180;
      const sz = 0.035 + rr() * rr() * 0.13;
      const m = new THREE.Mesh(boxGeo, rubbleMats[i % 3]);
      m.scale.set(sz * (0.7 + rr() * 0.9), sz * (0.5 + rr() * 0.7), sz * (0.7 + rr() * 1.1));
      const zoff = (rr() - 0.5) * 2.35;
      m.position.set(
        p.x + (rr() - 0.5) * 0.06 - Math.sin(slope) * sz * 0.2,
        p.y + Math.cos(slope) * sz * 0.18 - 0.02,
        zoff
      );
      m.rotation.set((rr() - 0.5) * 0.7, rr() * Math.PI, slope + (rr() - 0.5) * 0.75);
      m.castShadow = true;
      m.receiveShadow = true;
      pile.add(m);
    }
    // flat debris strewn across the approach so the traverse is not driving on nothing
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(boxGeo, rubbleMats[(i + 1) % 3]);
      const sz = 0.045 + rr() * 0.1;
      m.scale.set(sz * 1.8, sz * 0.28, sz * (1.0 + rr()));
      m.position.set(-0.18 - rr() * 1.9, sz * 0.14, (rr() - 0.5) * 2.9);
      m.rotation.set((rr() - 0.5) * 0.12, rr() * Math.PI, (rr() - 0.5) * 0.14);
      m.castShadow = true;
      m.receiveShadow = true;
      root.add(m);
    }
  }

  // ---------------- the robot ----------------
  const posG = new THREE.Group(); // world placement
  const yawG = new THREE.Group(); // heading
  const pitchG = new THREE.Group(); // climb angle
  const rollG = new THREE.Group(); // bank
  root.add(posG);
  posG.add(yawG);
  yawG.add(pitchG);
  pitchG.add(rollG);

  const chassis = new THREE.Group();
  rollG.add(chassis);

  // hull
  const hull = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.42, 0.13, 0.3)), matChassis);
  hull.position.y = 0.035;
  hull.castShadow = true;
  hull.receiveShadow = true;
  chassis.add(hull);

  const deck = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.29, 0.045, 0.25)), matDeck);
  deck.position.y = 0.122;
  deck.castShadow = true;
  chassis.add(deck);

  const stripe = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.3, 0.014, 0.035)), matAccent);
  stripe.position.set(0.0, 0.104, 0.128);
  chassis.add(stripe);
  const stripe2 = stripe.clone();
  stripe2.position.z = -0.128;
  chassis.add(stripe2);

  const bumper = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.035, 0.075, 0.3)), matDark);
  bumper.position.set(0.222, 0.03, 0);
  bumper.castShadow = true;
  chassis.add(bumper);

  const rearBox = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.075, 0.09, 0.2)), matDark);
  rearBox.position.set(-0.225, 0.05, 0);
  rearBox.castShadow = true;
  chassis.add(rearBox);

  // sensor mast
  const mast = new THREE.Mesh(keepGeo(new THREE.CylinderGeometry(0.011, 0.014, 0.2, 10)), matDark);
  mast.position.set(-0.075, 0.245, 0);
  mast.castShadow = true;
  chassis.add(mast);

  const head = new THREE.Group();
  head.position.set(-0.075, 0.362, 0);
  chassis.add(head);
  const headBox = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.085, 0.058, 0.062)), matDeck);
  headBox.castShadow = true;
  head.add(headBox);
  const lens = new THREE.Mesh(keepGeo(new THREE.CylinderGeometry(0.019, 0.019, 0.016, 14)), matLens);
  lens.rotation.z = Math.PI / 2;
  lens.position.set(0.05, 0.004, 0);
  head.add(lens);
  const camLed = new THREE.Mesh(keepGeo(new THREE.SphereGeometry(0.006, 8, 8)), matLedB);
  camLed.position.set(0.045, 0.022, 0.022);
  head.add(camLed);

  const antenna = new THREE.Mesh(keepGeo(new THREE.CylinderGeometry(0.004, 0.004, 0.17, 6)), matDark);
  antenna.position.set(-0.2, 0.175, 0.085);
  antenna.rotation.z = 0.18;
  chassis.add(antenna);

  const statusLed = new THREE.Mesh(keepGeo(new THREE.SphereGeometry(0.011, 10, 10)), matLed);
  statusLed.position.set(0.1, 0.15, 0.06);
  chassis.add(statusLed);

  // ---------------- tracks ----------------
  function stadiumShape(L, R) {
    const s = new THREE.Shape();
    s.moveTo(-L, R);
    s.lineTo(L, R);
    s.absarc(L, 0, R, Math.PI / 2, -Math.PI / 2, true);
    s.lineTo(-L, -R);
    s.absarc(-L, 0, R, -Math.PI / 2, -Math.PI * 1.5, true);
    return s;
  }

  const trackGeo = keepGeo(
    new THREE.ExtrudeGeometry(stadiumShape(TRACK_L, TRACK_R), {
      depth: TRACK_W,
      bevelEnabled: false,
      curveSegments: 16,
    })
  );
  trackGeo.translate(0, 0, -TRACK_W / 2);
  const flipGeo = keepGeo(
    new THREE.ExtrudeGeometry(stadiumShape(FLIP_L, FLIP_R), {
      depth: FLIP_W,
      bevelEnabled: false,
      curveSegments: 12,
    })
  );
  flipGeo.translate(0, 0, -FLIP_W / 2);

  const grouserGeo = keepGeo(new THREE.BoxGeometry(0.032, 0.016, TRACK_W + 0.014));
  const flipGrouserGeo = keepGeo(new THREE.BoxGeometry(0.022, 0.012, FLIP_W + 0.012));
  const sprocketGeo = keepGeo(new THREE.CylinderGeometry(TRACK_R * 0.5, TRACK_R * 0.5, 0.014, 14));
  const hubGeo = keepGeo(new THREE.CylinderGeometry(TRACK_R * 0.22, TRACK_R * 0.22, 0.02, 10));

  const P_TRACK = loopPerimeter(TRACK_L, TRACK_R);
  const P_FLIP = loopPerimeter(FLIP_L, FLIP_R);

  /** One side: track loop, grousers, sprockets, front + rear flipper sub-tracks. */
  function buildSide(sign, trackMat, grouserMat) {
    const side = new THREE.Group();
    side.position.z = sign * TRACK_Z;
    chassis.add(side);

    const slab = new THREE.Mesh(trackGeo, trackMat);
    slab.castShadow = true;
    slab.receiveShadow = true;
    side.add(slab);

    const grousers = [];
    for (let i = 0; i < N_GROUSER; i++) {
      const g = new THREE.Mesh(grouserGeo, grouserMat);
      g.castShadow = true;
      side.add(g);
      grousers.push(g);
    }

    const sprockets = [];
    [TRACK_L, -TRACK_L].forEach((sx) => {
      const s = new THREE.Mesh(sprocketGeo, matSprocket);
      s.rotation.x = Math.PI / 2;
      s.position.set(sx, 0, sign * (TRACK_W / 2 + 0.008));
      s.castShadow = true;
      side.add(s);
      sprockets.push(s);
      const h = new THREE.Mesh(hubGeo, matDark);
      h.rotation.x = Math.PI / 2;
      h.position.set(sx, 0, sign * (TRACK_W / 2 + 0.016));
      side.add(h);
    });

    function buildFlipper(dir) {
      const pivot = new THREE.Group();
      pivot.position.set(dir * TRACK_L, 0, sign * -0.006);
      side.add(pivot);
      const loop = new THREE.Mesh(flipGeo, trackMat);
      loop.position.x = dir * FLIP_L;
      loop.castShadow = true;
      pivot.add(loop);
      const gs = [];
      for (let i = 0; i < N_FLIP_GROUSER; i++) {
        const g = new THREE.Mesh(flipGrouserGeo, grouserMat);
        g.castShadow = true;
        loop.add(g);
        gs.push(g);
      }
      const cap = new THREE.Mesh(hubGeo, matSprocket);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(dir * (FLIP_L * 2), 0, sign * (FLIP_W / 2 + 0.006));
      pivot.add(cap);
      return { pivot, loop, gs, dir };
    }

    const front = buildFlipper(1);
    const rear = buildFlipper(-1);
    return { side, slab, grousers, sprockets, front, rear };
  }

  const left = buildSide(-1, matTrackL, matGrouserL);
  const right = buildSide(1, matTrackR, matGrouserR);

  // parts addressable by setHighlight
  const parts = new Map();
  parts.set('track_l', [
    left.slab,
    ...left.grousers,
    left.front.loop,
    left.rear.loop,
    ...left.front.gs,
    ...left.rear.gs,
  ]);

  const hotFor = new Map();
  hotFor.set(matTrackL, matTrackHot);
  hotFor.set(matGrouserL, matGrouserHot);

  let highlight = null;
  function setHighlight(partId) {
    highlight = partId || null;
    const meshes = parts.get('track_l') || [];
    meshes.forEach((m) => {
      if (!m) return;
      if (!m.userData.baseMat) m.userData.baseMat = m.material;
      const hot = hotFor.get(m.userData.baseMat);
      m.material = highlight === 'track_l' && hot ? hot : m.userData.baseMat;
    });
    if (highlight !== 'track_l') {
      matTrackHot.emissiveIntensity = 0.6;
      matGrouserHot.emissiveIntensity = 0.6;
    }
  }

  // ---------------- per-frame pose ----------------
  let phaseL = 0;
  let phaseR = 0;
  let lastT = 0;

  function placeGrousers(list, phase, L, R, P, geoOff) {
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const p = loopPoint((i / n) * P + phase, L, R);
      const nx = -Math.sin(p.a);
      const ny = Math.cos(p.a);
      list[i].position.set(p.x + nx * geoOff, p.y + ny * geoOff, 0);
      list[i].rotation.z = p.a;
    }
  }

  function update(tSec, data) {
    const dr = data['/drive'];
    const imu = data['/imu'];
    const fl = data['/flipper'];
    const sys = data['/sys'];
    if (!dr || !imu) return;

    const pose = derivePose(dr);
    const d = sampleAt(pose.t, pose.dist, tSec);
    const lat = sampleAt(pose.t, pose.lat, tSec);
    const yaw = sampleAt(pose.t, pose.yaw, tSec);
    const pitchDeg = sampleAt(imu.t, imu.pitch, tSec);
    const rollDeg = sampleAt(imu.t, imu.roll, tSec);
    const cmdL = sampleAt(dr.t, dr.cmd_l, tSec);
    const cmdR = sampleAt(dr.t, dr.cmd_r, tSec);
    const velL = sampleAt(dr.t, dr.vel_l, tSec);
    const velR = sampleAt(dr.t, dr.vel_r, tSec);
    const iL = sampleAt(dr.t, dr.i_l, tSec);
    const tempL = sys ? sampleAt(sys.t, sys.temp_l, tSec) : 40;

    // place the hull on the chord between the two track ground contacts
    const a = worldPoint(d - CONTACT_HALF);
    const b = worldPoint(d + CONTACT_HALF);
    const pitchRad = (pitchDeg * Math.PI) / 180;
    posG.position.set(
      (a.x + b.x) / 2 - Math.sin(pitchRad) * TRACK_R,
      (a.y + b.y) / 2 + Math.cos(pitchRad) * TRACK_R,
      -lat * S_RAMP
    );
    yawG.rotation.y = (yaw * Math.PI) / 180;
    pitchG.rotation.z = pitchRad;
    rollG.rotation.x = (rollDeg * Math.PI) / 180;

    // track surface speed: normally the commanded speed (the track turns even when the ground
    // does not cooperate); once the current runs away the track is jammed and moves with the body
    const jam = clamp((iL - 15) / 7, 0, 1);
    const surfL = lerp(cmdL, velL, jam) * S_RAMP;
    const surfR = cmdR * S_RAMP;

    const dt = Math.min(Math.abs(tSec - lastT), 0.12);
    lastT = tSec;
    phaseL += surfL * dt;
    phaseR += surfR * dt;

    placeGrousers(left.grousers, phaseL, TRACK_L, TRACK_R, P_TRACK, 0.008);
    placeGrousers(right.grousers, phaseR, TRACK_L, TRACK_R, P_TRACK, 0.008);
    placeGrousers(left.front.gs, phaseL * 1.6, FLIP_L, FLIP_R, P_FLIP, 0.006);
    placeGrousers(left.rear.gs, phaseL * 1.6, FLIP_L, FLIP_R, P_FLIP, 0.006);
    placeGrousers(right.front.gs, phaseR * 1.6, FLIP_L, FLIP_R, P_FLIP, 0.006);
    placeGrousers(right.rear.gs, phaseR * 1.6, FLIP_L, FLIP_R, P_FLIP, 0.006);

    left.sprockets.forEach((s) => {
      s.rotation.y = -phaseL / TRACK_R;
    });
    right.sprockets.forEach((s) => {
      s.rotation.y = -phaseR / TRACK_R;
    });

    // flippers: negative angle is tip down into the rubble
    if (fl) {
      const front = sampleAt(fl.t, fl.front, tSec);
      const rear = sampleAt(fl.t, fl.rear, tSec);
      const fr = (front * Math.PI) / 180;
      const rr = (rear * Math.PI) / 180;
      left.front.pivot.rotation.z = fr;
      right.front.pivot.rotation.z = fr;
      left.rear.pivot.rotation.z = -rr;
      right.rear.pivot.rotation.z = -rr;
    }

    // strain shudder: current in the motor with nothing to show for it
    const strain = clamp((iL - 11) / 11, 0, 1) * (1 - clamp(Math.abs(velL) / 0.25, 0, 1));
    chassis.rotation.z = Math.sin(tSec * 53) * 0.02 * strain;
    chassis.position.y = Math.abs(Math.sin(tSec * 67)) * 0.008 * strain;

    // left drive runs hot: a warm bloom on the left track, independent of the highlight pulse
    const heat = clamp((tempL - 52) / 30, 0, 1);
    matTrackL.emissiveIntensity = heat * 0.28;
    matGrouserL.emissiveIntensity = heat * 0.2;

    // status LED: sage nominal, amber when the left drive is over temp, red while it is stalling
    const led = statusLed.material;
    if (strain > 0.25) {
      led.color.setHex(0xff5f57);
      led.emissive.setHex(0xff5f57);
      led.emissiveIntensity = 0.4 + Math.abs(Math.sin(tSec * 11)) * 1.8;
    } else if (tempL > 62) {
      led.color.setHex(0xf5a623);
      led.emissive.setHex(0xf5a623);
      led.emissiveIntensity = 1.1 + Math.abs(Math.sin(tSec * 2.2)) * 0.5;
    } else {
      led.color.setHex(0xd3eeb6);
      led.emissive.setHex(0xd3eeb6);
      led.emissiveIntensity = 1.4;
    }

    if (highlight === 'track_l') {
      const pulse = 0.45 + Math.abs(Math.sin(tSec * 4.2)) * 0.95;
      matTrackHot.emissiveIntensity = pulse;
      matGrouserHot.emissiveIntensity = pulse;
    }
  }

  /** Keep the shot on the machine: it travels ~4 world units across the mission. */
  function cameraFocus() {
    return { x: posG.position.x, y: posG.position.y + 0.12, z: posG.position.z };
  }

  function dispose() {
    mount.remove(root);
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }

  return { update, setHighlight, dispose, cameraHome, cameraFocus };
}
