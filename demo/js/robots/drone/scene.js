// drone/scene.js - the X-quad, the survey field it flew, and the track it actually flew.
//
// Everything is posed from the telemetry: position from /pos, attitude from /att, prop blur and
// blade rate from /motors rpm. Nothing is keyframed. The failure reads three ways at once:
// motor 3's blur disc thins out as its rpm collapses, the airframe drops and swings off heading,
// and the flown track behind it turns from blue to alert red.
//
// Scale: the field is 20 x 14 m, far larger than the viewer's lit and fogged volume, so the world
// is compressed by WORLD and the aircraft is drawn oversize against it (a true-scale 0.45 m quad
// would be 13 cm wide here and unreadable). The proportions that matter, lane spacing, the 6 m
// survey altitude and the 2.1 m drop, all survive the compression.

import { sampleAt } from '../../core/prng.js';
import { FIELD, LANE_Y, T_FAIL, duration } from './data.js';

const WORLD = 0.30; // world units per metre of field
const ARM_R = 0.175; // motor offset on each body axis; 0.495 diagonal, ~3.6x true scale
const GEAR = 0.075; // skid drop below the centre plate
const DEG = Math.PI / 180;

// Visual blade rate as a fraction of the logged one, and the second fraction the anatomy step's
// drawing gets on top of it. Both are argued at the prop hub below; both are rates, never a rate
// this aircraft did not report.
const BLADE_RATE = 0.16;
const WIRE_BLADE_RATE = 0.065;
// And how far the blur discs recede while that drawing is standing in for the solid aircraft.
const WIRE_DISC = 0.2;

const COL = {
  carbon: 0x15171b,
  shell: 0x1c2026,
  metal: 0x272c33,
  blue: 0x2f78ff,
  sage: 0xd3eeb6,
  alert: 0xff5f57,
};

export const cameraHome = {
  // Same rear-left quarter as before (motor 3 is the corner facing the viewer when it is
  // highlighted), but ~3.7x closer, and the shot rides with the aircraft via cameraFocus below.
  // Framing the whole 20 x 14 m field left the quad at ~1.5 % of the viewport, where an 18 deg
  // yaw excursion and a roll wobble are simply not perceptible. What the viewer keeps of the
  // survey pattern is the lanes and the flown track passing under the aircraft.
  position: { x: -4.35, y: 1.46, z: 0.48 },
  target: { x: -3.0, y: 0.6, z: 2.1 },
};

/** field metres -> world units */
const wx = (x) => x * WORLD;
const wz = (y) => -y * WORLD;
const wy = (alt) => alt * WORLD;

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  mount.add(root);

  const mats = [];
  const geos = [];
  const M = (m) => (mats.push(m), m);
  const G = (g) => (geos.push(g), g);

  // ---------- materials ----------
  const carbonMat = M(new THREE.MeshStandardMaterial({ color: COL.carbon, roughness: 0.52, metalness: 0.45 }));
  const shellMat = M(new THREE.MeshStandardMaterial({ color: COL.shell, roughness: 0.36, metalness: 0.55 }));
  const metalMat = M(new THREE.MeshStandardMaterial({ color: COL.metal, roughness: 0.28, metalness: 0.85 }));
  // Slate shrink-wrap, not near-black: see the pack block below. The carbon plate it hangs under is
  // 0x15171b, so the wrap has to sit clear of it on luminance or the pack is a shadow.
  const battMat = M(new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.5, metalness: 0.18 }));
  const accentMat = M(
    new THREE.MeshStandardMaterial({ color: COL.blue, roughness: 0.3, metalness: 0.3, emissive: COL.blue, emissiveIntensity: 0.45 })
  );
  const ledFrontMat = M(new THREE.MeshStandardMaterial({ color: COL.sage, emissive: COL.sage, emissiveIntensity: 1.6 }));
  const ledRearMat = M(new THREE.MeshStandardMaterial({ color: COL.blue, emissive: COL.blue, emissiveIntensity: 1.6 }));
  const lensMat = M(
    new THREE.MeshStandardMaterial({ color: 0x0a0c0f, roughness: 0.12, metalness: 0.9, emissive: COL.sage, emissiveIntensity: 0.25 })
  );

  // swap-in materials that make the highlight read
  const hotShell = M(
    new THREE.MeshStandardMaterial({ color: 0x2a1512, roughness: 0.45, metalness: 0.6, emissive: COL.alert, emissiveIntensity: 0 })
  );
  const hotAccent = M(
    new THREE.MeshStandardMaterial({ color: COL.alert, roughness: 0.3, metalness: 0.3, emissive: COL.alert, emissiveIntensity: 0 })
  );

  // ---------- one soft fill from the camera side ----------
  // The viewer's key light sits opposite this camera home, so without this the aircraft reads as a
  // silhouette. Cool, low and non-shadowing: it lifts the near faces without flattening the form.
  const fill = new THREE.DirectionalLight(0xbcd2f0, 0.6);
  fill.position.set(-6, 4.5, -5.5);
  root.add(fill);

  // travelling rim so the aircraft keeps a blue edge wherever it is over the field
  const rim = new THREE.PointLight(0x2f78ff, 3.2, 6.5, 2.0);
  root.add(rim);

  // ---------- survey field ----------
  const boundaryGeo = G(new THREE.BufferGeometry());
  boundaryGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        [-10, -7],
        [10, -7],
        [10, 7],
        [-10, 7],
        [-10, -7],
      ].flatMap(([x, y]) => [wx(x), 0.008, wz(y)]),
      3
    )
  );
  // the field dressing is context, not the subject: kept faint per the build contract
  root.add(new THREE.Line(boundaryGeo, M(new THREE.LineBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.2 }))));

  const dashPts = [];
  const DASH = 0.62;
  const GAP = 0.42;
  LANE_Y.forEach((laneY) => {
    for (let x = -10; x < 10; x += DASH + GAP) {
      dashPts.push(wx(x), 0.007, wz(laneY), wx(Math.min(x + DASH, 10)), 0.007, wz(laneY));
    }
  });
  const laneGeo = G(new THREE.BufferGeometry());
  laneGeo.setAttribute('position', new THREE.Float32BufferAttribute(dashPts, 3));
  // 0.18, up from round 7's 0.09, and it is a legibility fix rather than a change of mind about the
  // build contract's "field dressing is context, not the subject". At 0.09 these dashes are not faint,
  // they are ABSENT: measured off a rendered anatomy frame at the tour's stand-off they resolve to
  // about two counts of luminance over a 0x151619 ground, under a viewer grid drawn at 0.09 and 0.13
  // of a brighter blue. The plan the aircraft is flying was the one piece of world-fixed geometry the
  // shot could have used to show the machine moving, and it was invisible. At 0.18 the dashes read as
  // a dashed line and still sit under the flown track (0.92) and the aircraft by a wide margin.
  root.add(new THREE.LineSegments(laneGeo, M(new THREE.LineBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.18 }))));

  const pad = new THREE.Mesh(
    G(new THREE.RingGeometry(0.085, 0.105, 40)),
    M(new THREE.MeshBasicMaterial({ color: COL.sage, transparent: true, opacity: 0.3, side: THREE.DoubleSide }))
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(wx(-10), 0.009, wz(-7));
  root.add(pad);

  // ---------- flown track ----------
  // Built once from the real /pos arrays, as two lines over one shared position attribute. They
  // need separate geometries because drawRange is per-geometry, and they carry deliberately
  // different colour, because they are answering different questions.
  //
  //   ghost: where the aircraft is GOING. A faint path preview so the survey pattern is legible
  //     from the first frame. It is a preview, not a readout, so it is nominal blue end to end and
  //     never carries failure colour. It used to share the live line's per-vertex colours, which
  //     painted the post-T_FAIL leg alert red for the whole mission from frame one. That put a
  //     failure tint on screen before anything had failed, on every consumer of this scene: the
  //     success step loops [18.6, 27.7], more than 30 s before the bearing binds, and is only
  //     allowed to show the survey working.
  //
  //   live: where the aircraft HAS BEEN, revealed up to the playhead by drawRange. Its per-vertex
  //     colour is the honest one: a vertex is red only if the aircraft was already past T_FAIL when
  //     it flew through that point. Colour and reveal together mean red can only ever reach the
  //     screen where and when the failure actually happened, so the replay still turns the track
  //     from blue to alert red as it crosses the fault, and nothing red exists ahead of the
  //     playhead to give it away.
  let trailGeo = null;
  let trailVerts = 0;

  function buildTrack(data) {
    const p = data && data['/pos'];
    if (!p || trailGeo) return;
    const step = 3;
    const pos = [];
    const col = [];
    const cBlue = new THREE.Color(COL.blue);
    const cAlert = new THREE.Color(COL.alert);
    for (let i = 0; i < p.t.length; i += step) {
      pos.push(wx(p.x[i]), wy(p.alt[i]), wz(p.y[i]));
      const c = p.t[i] < T_FAIL ? cBlue : cAlert;
      col.push(c.r, c.g, c.b);
    }
    trailVerts = pos.length / 3;
    const posAttr = new THREE.Float32BufferAttribute(pos, 3);

    trailGeo = G(new THREE.BufferGeometry());
    trailGeo.setAttribute('position', posAttr);
    trailGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    trailGeo.setDrawRange(0, 0);
    root.add(new THREE.Line(trailGeo, M(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 }))));

    // No colour attribute at all rather than an all-blue one: the preview cannot go red by
    // accident later, and there is nothing to keep in step with the live line's colours.
    const ghostGeo = G(new THREE.BufferGeometry());
    ghostGeo.setAttribute('position', posAttr);
    root.add(new THREE.Line(ghostGeo, M(new THREE.LineBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.13 }))));
  }

  // drop line to the ground, so altitude is readable in a still frame
  const dropGeo = G(new THREE.BufferGeometry());
  dropGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const dropMat = M(new THREE.LineBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.22 }));
  root.add(new THREE.Line(dropGeo, dropMat));

  // camera footprint on the ground while the survey is live
  const FOOT_HX = 0.17; // world units, along the aircraft's nose axis
  const FOOT_HZ = 0.115; // and across it
  const footGeo = G(new THREE.BufferGeometry());
  footGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-FOOT_HX, 0, -FOOT_HZ, FOOT_HX, 0, -FOOT_HZ, FOOT_HX, 0, FOOT_HZ, -FOOT_HX, 0, FOOT_HZ, -FOOT_HX, 0, -FOOT_HZ],
      3
    )
  );
  const footMat = M(new THREE.LineBasicMaterial({ color: COL.sage, transparent: true, opacity: 0.3 }));
  const footprint = new THREE.Line(footGeo, footMat);
  footprint.position.y = 0.011;
  root.add(footprint);

  /**
   * How strongly the ground footprint is drawn at mission time `s` - the survey camera's own duty
   * cycle, in one place because two things read it now.
   *
   * It comes up 1.5 s after the climb starts and goes out 0.4 s after the bearing binds: the aircraft
   * is not surveying while it is climbing off the pad, and it is not surveying while it is falling.
   */
  function footAlpha(s) {
    const fadeIn = Math.min(Math.max((s - 4) / 1.5, 0), 1);
    const fadeOut = Math.max(0, 1 - (s - (T_FAIL + 0.4)) / 1.6);
    return 0.3 * fadeIn * fadeOut;
  }

  // ---------- surveyed ground ----------
  //
  // WHY THIS EXISTS, which is round 12 and the change Hugh's note asked for. The anatomy tour holds
  // four cards over an aircraft flying a survey lane at up to 2.9 m/s, and until now none of that
  // motion reached the screen. The tour's shot is an offset resolved against the aircraft every
  // frame, so the aircraft is motionless in frame BY CONSTRUCTION; the flown track and the lane
  // dashes both run ALONG the direction of travel, so they slide along themselves and read as
  // static; the field boundary is one thin line 7 m away; and the viewer's own blueprint grid is a
  // regular lattice, which is the single worst thing to show a translation against. Rendered and
  // looked at, the step was a hovering statue with labels on it - the exact failure the SSL mission's
  // step avoids by having a carpet, field lines and other robots within half a metre of its subject.
  // Six metres up over an empty field there is nothing near this aircraft at all.
  //
  // So the scene gets the survey's own PRODUCT. This aircraft carries a mapping camera whose ground
  // footprint is already drawn every frame, and the ground that footprint has swept fills in behind
  // the machine tile by tile. That is world-fixed, irregular, directly under the subject, and it
  // GROWS - so its seams stream past underneath at exactly the aircraft's own ground speed, which is
  // the parallax the shot had no source for. It is also the answer to the survey-camera card and to
  // the mission's own premise: what a lawnmower pattern is FOR is covering ground.
  //
  // WHAT IT CLAIMS, which is nothing the scene did not already draw. A tile lights when the drawn
  // footprint rectangle - the same rectangle `update()` poses from /pos and /att - has OVERLAPPED
  // it, on a frame where that footprint was being drawn at all (`footAlpha` above). So it is /pos
  // crossed with /att crossed with a rectangle already on screen, quantised to a 1 m grid because a
  // mapping camera's product is tiles and because 1 m is about the size of this footprint
  // (1.13 x 0.77 m of ground). NO exposure rate is invented and no image is implied. Nothing is ever
  // lit ahead of the playhead - a tile is dark until the aircraft has flown over it, exactly as the
  // flown track is revealed by drawRange - so a still frame of this scene can only show ground the
  // replay has already covered, and the coverage stops where the survey stopped.
  //
  // WHY OVERLAP AND NOT "THE FOOTPRINT CROSSED THE TILE'S CENTRE", which is what this shipped as and
  // is a rule that looks simpler and is quietly broken. The footprint is 0.767 m across, so it
  // reaches 0.383 m either side of the lane it is flying; a 1 m grid over a 14 m field puts its tile
  // centres on the half-metres, at y = -6.5, -5.5 ... 6.5. LANE_Y is [-7, -3.5, 0, 3.5, 7]: only
  // -3.5 and 3.5 ARE tile centres, and the other three lanes pass 0.5 m from the nearest one - 0.12 m
  // outside the footprint's own reach. Measured over the built payload, the centre rule lit 53 of 280
  // tiles and THREE OF THE FIVE LANES laid nothing at all: 1 tile for the whole of lane 1, 2 for lane
  // 3, 2 for lane 5, all of them incidental tiles from the turns. That included the lane the aircraft
  // is on when the bearing binds, so the failure replay - the one every visitor watches - ran the
  // drawn footprint rectangle over bare ground for 6.8 s. The lane spacing landing out of phase with
  // the grid is not a fact about this survey, it is an artefact of quantising, and the fix is to ask
  // the question the drawing is actually making: did the footprint cover any of the square this
  // tile DRAWS. Same payload, same rule, 122 tiles and a strip under every lane.
  const COV_CELL = 1.0; // metres of field per tile
  const COV_GAP = 0.05; // metres of dark seam on every side of one, which is what makes them tiles
  // Half the DRAWN square rather than half the cell, so what lights is what a viewer can see: a tile
  // the footprint only reached across its seam is not claimed.
  const COV_TILE_H = (COV_CELL - 2 * COV_GAP) / 2;
  // Additive, so this layer can only ever lift the ground and never darken anything under it, and so
  // a tile's weight IS its colour and one attribute write per frame is the whole animation. 0.115 of
  // COL.sage over the 0x151619 ground lands at about 0.18 luminance: legible as covered ground from
  // the tour's stand-off and from `cameraHome`, and still under the flown track, the lane dashes and
  // every lit surface on the aircraft.
  const COV_MAX = 0.115;
  const COV_FADE = 0.45; // s for a tile to come up once the footprint has reached it
  const COV_NX = Math.round(FIELD.x / COV_CELL);
  const COV_NY = Math.round(FIELD.y / COV_CELL);
  const COV_N = COV_NX * COV_NY;
  const covAt = new Float64Array(COV_N).fill(Infinity);
  let covReady = false;
  const covGeo = G(new THREE.BufferGeometry());
  {
    const cpos = new Float32Array(COV_N * 4 * 3);
    const ccol = new Float32Array(COV_N * 4 * 3);
    const cidx = new Uint16Array(COV_N * 6);
    for (let c = 0; c < COV_N; c++) {
      const gx = c % COV_NX;
      const gy = (c / COV_NX) | 0;
      const x0 = -FIELD.x / 2 + gx * COV_CELL + COV_GAP;
      const x1 = x0 + COV_CELL - 2 * COV_GAP;
      const y0 = -FIELD.y / 2 + gy * COV_CELL + COV_GAP;
      const y1 = y0 + COV_CELL - 2 * COV_GAP;
      const corners = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      const v = c * 4;
      for (let k = 0; k < 4; k++) {
        cpos[(v + k) * 3] = wx(corners[k][0]);
        cpos[(v + k) * 3 + 1] = 0.0035; // under the lane dashes (0.007) and the boundary (0.008)
        cpos[(v + k) * 3 + 2] = wz(corners[k][1]);
      }
      cidx[c * 6] = v;
      cidx[c * 6 + 1] = v + 1;
      cidx[c * 6 + 2] = v + 2;
      cidx[c * 6 + 3] = v;
      cidx[c * 6 + 4] = v + 2;
      cidx[c * 6 + 5] = v + 3;
    }
    covGeo.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
    covGeo.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
    covGeo.setIndex(new THREE.BufferAttribute(cidx, 1));
  }
  const covMat = M(
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  const covMesh = new THREE.Mesh(covGeo, covMat);
  // 280 coplanar tiles inside a 6 x 4.2 unit rectangle the camera is usually inside the bounds of:
  // a frustum test on the whole mesh is either trivially true or wrong at the edge of the field.
  covMesh.frustumCulled = false;
  root.add(covMesh);
  const covRGB = new THREE.Color(COL.sage);

  /**
   * When each tile was first swept, read off the flown path once the payload is in hand.
   *
   * Every second sample, which is 25 Hz against a footprint 1.13 m long and a top ground speed of
   * 2.94 m/s: the aircraft advances at most 0.118 m between the samples this tests, so no tile can
   * be skipped over. Only samples where the footprint is actually drawn count, so nothing is marked
   * during the climb or during the fall.
   */
  function buildCoverage(data) {
    const p = data && data['/pos'];
    const a = data && data['/att'];
    if (!p || !a || covReady) return;
    covReady = true;
    const hx = FOOT_HX / WORLD; // the drawn footprint's half-extents, in field metres
    const hy = FOOT_HZ / WORLD;
    // The candidate box has to hold both boxes' diagonals now that a tile is tested as a SQUARE and
    // not as a point, or a tile the footprint clips at a corner is never even offered to the test.
    const reach = Math.hypot(hx, hy) + Math.hypot(COV_TILE_H, COV_TILE_H);
    for (let i = 0; i < p.t.length; i += 2) {
      const s = p.t[i];
      if (footAlpha(s) <= 0.01) continue;
      // The footprint is `footprint.rotation.y = -yaw * DEG`, so its nose axis in FIELD coordinates
      // is (cos yaw, -sin yaw) and its across axis is (-sin yaw, -cos yaw). Derived from the same
      // rotation `update()` writes rather than assumed, because the survey holds heading and a
      // reader would otherwise never find out that these two disagreed.
      const ps = Math.sin(a.yaw[i] * DEG);
      const pc = Math.cos(a.yaw[i] * DEG);
      const cx = p.x[i];
      const cy = p.y[i];
      const g0 = Math.max(0, Math.floor((cx - reach + FIELD.x / 2) / COV_CELL));
      const g1 = Math.min(COV_NX - 1, Math.floor((cx + reach + FIELD.x / 2) / COV_CELL));
      const h0 = Math.max(0, Math.floor((cy - reach + FIELD.y / 2) / COV_CELL));
      const h1 = Math.min(COV_NY - 1, Math.floor((cy + reach + FIELD.y / 2) / COV_CELL));
      for (let gy = h0; gy <= h1; gy++) {
        for (let gx = g0; gx <= g1; gx++) {
          const c = gy * COV_NX + gx;
          if (covAt[c] <= s) continue;
          const dx = -FIELD.x / 2 + (gx + 0.5) * COV_CELL - cx;
          const dy = -FIELD.y / 2 + (gy + 0.5) * COV_CELL - cy;
          // Separating-axis test between two rectangles: the tile's own two axes, then the
          // footprint's. Four axes is the whole test for a pair of boxes in a plane, and the pair
          // overlaps exactly when none of the four separates them. The tile's half-extents project
          // onto either footprint axis as `COV_TILE_H * (|cos| + |sin|)`, which is the same number
          // for both because the square is symmetric - computed once.
          const apc = Math.abs(pc);
          const aps = Math.abs(ps);
          if (Math.abs(dx) > hx * apc + hy * aps + COV_TILE_H) continue;
          if (Math.abs(dy) > hx * aps + hy * apc + COV_TILE_H) continue;
          const rt = COV_TILE_H * (apc + aps);
          if (Math.abs(dx * pc - dy * ps) > hx + rt) continue;
          if (Math.abs(-dx * ps - dy * pc) > hy + rt) continue;
          covAt[c] = s;
        }
      }
    }
  }

  // ---------- aircraft ----------
  const craft = new THREE.Group();
  craft.name = 'drone-craft'; // QA hooks on to this to read the posed transform
  craft.rotation.order = 'YZX'; // yaw, then pitch, then roll
  root.add(craft);
  const body = new THREE.Group();
  craft.add(body);

  const plateGeo = G(new THREE.BoxGeometry(0.148, 0.012, 0.148));
  const lower = new THREE.Mesh(plateGeo, carbonMat);
  // Named because `update()` reads its visibility to tell whether the anatomy step's wireframe is
  // standing in for this aircraft (see the `solid` probe below), which makes it a contract rather
  // than a detail. Not a subtree anything resolves BY name - `script.js` asks for `drone-craft`.
  lower.name = 'drone-lower-plate';
  lower.position.y = -0.011;
  lower.castShadow = true;
  lower.receiveShadow = true;
  body.add(lower);
  // eslint-disable-next-line no-unused-vars -- kept named for readability; the FC board below is
  // what the `imu` anchor now reads, because the card names a board and not the plate under it.
  const upper = new THREE.Mesh(plateGeo, carbonMat);
  upper.position.y = 0.023;
  upper.castShadow = true;
  body.add(upper);

  const standGeo = G(new THREE.CylinderGeometry(0.005, 0.005, 0.034, 8));
  [
    [0.058, 0.058],
    [0.058, -0.058],
    [-0.058, 0.058],
    [-0.058, -0.058],
  ].forEach(([sx, sz]) => {
    const st = new THREE.Mesh(standGeo, metalMat);
    st.position.set(sx, 0.006, sz);
    body.add(st);
  });

  const canopy = new THREE.Mesh(G(new THREE.SphereGeometry(0.062, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.56)), shellMat);
  canopy.position.set(0.012, 0.029, 0);
  canopy.scale.set(1.42, 0.92, 1.0);
  canopy.castShadow = true;
  body.add(canopy);

  const stripe = new THREE.Mesh(G(new THREE.BoxGeometry(0.132, 0.004, 0.014)), accentMat);
  stripe.position.set(0.012, 0.0855, 0);
  body.add(stripe);

  // ---------- the flight controller ----------
  //
  // WHY THIS EXISTS AT ALL. One of the four anatomy cards is "Flight controller - closes the
  // attitude loop from roll, pitch and yaw", and until round 7 its anchor was the centre plate: the
  // card named a board this aircraft did not have, and the tour's highlight had a carbon plate to
  // light. Round 7's rule is that a card whose part has no geometry gets geometry, so the board is
  // here - a 24 x 20 mm PCB with its processor and a status LED, which is what an FC on a 0.45 m
  // survey quad is.
  //
  // WHY IT IS ON THE REAR-LEFT CORNER OF THE TOP DECK AND NOT IN THE MIDDLE OF IT, which is where a
  // real stack goes. The canopy is an ellipse 0.176 x 0.124 centred at x 0.012 and it covers the
  // whole middle of a 0.148 plate: a board under it is a board nobody can see, and the point of
  // adding it is that the highlight has something to light. The plate CORNERS are outside that
  // ellipse - at z = 0.048 the dome skirt reaches x = -0.044, and this board's inner edge stops at
  // -0.046 - so the corner is the one part of the deck that is both real airframe and in shot. Left
  // and rear, which is the quarter the tour's wide shot stands on and the same side motor 3 is on,
  // so the two parts the mission cares most about are never on the far side of the hull.
  //
  // The `imu` anchor below moves onto this board, because the anchor's job is to be where the part
  // is: a leader line and a highlight halo both belong on the board, not on the plate under it.
  const fcBoard = new THREE.Mesh(G(new THREE.BoxGeometry(0.024, 0.005, 0.02)), shellMat);
  fcBoard.position.set(-0.057, 0.0315, -0.057);
  fcBoard.castShadow = true;
  body.add(fcBoard);
  const fcChip = new THREE.Mesh(G(new THREE.BoxGeometry(0.009, 0.0022, 0.009)), metalMat);
  fcChip.position.set(-0.057, 0.035, -0.057);
  body.add(fcChip);
  // The one lit element on it, in the same sage the front arms carry: an FC that is powered says so.
  const fcLed = new THREE.Mesh(G(new THREE.BoxGeometry(0.0035, 0.0022, 0.0035)), ledFrontMat);
  fcLed.position.set(-0.0475, 0.035, -0.0635);
  body.add(fcLed);

  // ---------- the 4S pack ----------
  //
  // WHY THIS IS MORE THAN A BOX. The anatomy tour holds a card on this part that says "the 4S pack;
  // voltage and current are logged at 25 Hz", and what used to be under that card was a 0x101318
  // slab flush against a 0x15171b carbon plate: two near-blacks with 3 counts of luminance between
  // them, in a scene lit for a matte airframe. Correctly framed it was still not identifiable as a
  // battery, so the card was making a claim the footage could not carry. Three things fix that, and
  // all three are things a real pack has:
  //
  //   the wrap   a slate shrink-wrap instead of near-black, and a 4 mm standoff from the plate, so
  //              the pack is a separate module under the hull rather than part of its shadow.
  //   the cells  three seams across the wrap. Four compartments IS what 4S means, and it is the
  //              cheapest possible way to make the slab read as cells rather than as ballast.
  //   the gauge  four segments on each long face, lit from the LOGGED pack voltage - the same
  //              `/bat` v the chat quotes and the failure step plots, sampled here every frame.
  //
  // The gauge is a readout, not invented hardware, and it is deliberately the only part of the
  // aircraft that carries data it did not get from geometry. It maps pack volts to a per-cell 3.2
  // to 4.2 V scale, which is the ordinary usable band for a lithium polymer cell and covers this
  // flight end to end: 16.805 V (4.20 per cell, full) at arming, 15.75 to 15.86 V (3.94 to 3.96,
  // about three-quarters) across the anatomy tour's battery beat, and 13.010 V (3.25, nearly flat)
  // at the failsafe touchdown. It stays BLUE at every level. A gauge that turned red as the pack
  // ran down would be asserting a battery fault, and the mission's answer is the opposite one: the
  // pack is healthy and it is reporting the motor.
  const batt = new THREE.Group();
  batt.position.set(-0.006, -0.038, 0);
  body.add(batt);

  const wrap = new THREE.Mesh(G(new THREE.BoxGeometry(0.105, 0.032, 0.056)), battMat);
  wrap.castShadow = true;
  batt.add(wrap);

  // three seams at the quarter points of the 0.105 length: four cells, in a row, end to end
  const seamGeo = G(new THREE.BoxGeometry(0.0018, 0.0326, 0.0566));
  const battParts = [wrap]; // the pack's own solid geometry, for `partMeshes()`
  for (let i = 1; i <= 3; i++) {
    const seam = new THREE.Mesh(seamGeo, carbonMat);
    seam.position.x = -0.0525 + (0.105 * i) / 4;
    batt.add(seam);
    battParts.push(seam);
  }

  // Four segments a side, on both long faces, so the gauge is readable from either quarter. One
  // material per segment index, shared by the two faces: the pair is always at the same level.
  const gaugeGeo = G(new THREE.BoxGeometry(0.0205, 0.0075, 0.0022));
  const gaugeMats = [];
  for (let i = 0; i < 4; i++) {
    const gm = M(new THREE.MeshBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.22 }));
    gaugeMats.push(gm);
    [-1, 1].forEach((side) => {
      const seg = new THREE.Mesh(gaugeGeo, gm);
      seg.position.set(-0.0393 + i * 0.0262, 0.0045, side * 0.0285);
      batt.add(seg);
    });
  }

  // survey camera on a nose gimbal
  const gimbal = new THREE.Mesh(G(new THREE.SphereGeometry(0.028, 18, 14)), shellMat);
  gimbal.position.set(0.072, -0.03, 0);
  gimbal.castShadow = true;
  body.add(gimbal);
  const lens = new THREE.Mesh(G(new THREE.CylinderGeometry(0.014, 0.016, 0.014, 18)), lensMat);
  lens.rotation.z = Math.PI / 2;
  lens.position.set(0.091, -0.033, 0);
  body.add(lens);

  // ---------- arms, motors, props ----------
  const ARM_LEN = ARM_R * Math.SQRT2 - 0.03;
  const armGeo = G(new THREE.CylinderGeometry(0.0145, 0.0105, ARM_LEN, 12)); // thick at the hub
  const bellGeo = G(new THREE.CylinderGeometry(0.026, 0.0235, 0.03, 18));
  const bellTopGeo = G(new THREE.CylinderGeometry(0.01, 0.014, 0.012, 14));
  const ringGeo = G(new THREE.TorusGeometry(0.0268, 0.0035, 8, 24));
  const discGeo = G(new THREE.RingGeometry(0.02, 0.118, 44, 1));
  const bladeGeo = G(new THREE.BoxGeometry(0.23, 0.0022, 0.0165));
  const ledGeo = G(new THREE.SphereGeometry(0.0085, 10, 8));
  const legGeo = G(new THREE.CylinderGeometry(0.0038, 0.0048, GEAR + 0.012, 8));
  const skidGeo = G(new THREE.CylinderGeometry(0.0055, 0.0055, 0.27, 10));

  // M1 rear-right, M2 front-right, M3 rear-left, M4 front-left (X frame; nose +x, right +z).
  // Diagonal pairs share a rotation direction, which is why losing 3 leaves a standing yaw error.
  const MOTORS = [
    { id: 1, x: -ARM_R, z: ARM_R, cw: true },
    { id: 2, x: ARM_R, z: ARM_R, cw: false },
    { id: 3, x: -ARM_R, z: -ARM_R, cw: false },
    { id: 4, x: ARM_R, z: -ARM_R, cw: true },
  ];

  const props = [];
  const m3Parts = []; // [{ mesh, base }] restored when the highlight clears
  let m3Bell = null; // motor 3's bell, kept for the anatomy anchor below

  MOTORS.forEach((m) => {
    const front = m.x > 0;

    const arm = new THREE.Mesh(armGeo, carbonMat);
    arm.position.set(m.x * 0.53, -0.004, m.z * 0.53);
    arm.rotation.z = Math.PI / 2;
    arm.rotation.y = -Math.atan2(m.z, m.x);
    arm.castShadow = true;
    body.add(arm);

    const bell = new THREE.Mesh(bellGeo, metalMat);
    bell.position.set(m.x, 0.014, m.z);
    bell.castShadow = true;
    body.add(bell);

    const bellTop = new THREE.Mesh(bellTopGeo, metalMat);
    bellTop.position.set(m.x, 0.035, m.z);
    body.add(bellTop);

    const ring = new THREE.Mesh(ringGeo, accentMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(m.x, 0.029, m.z);
    body.add(ring);

    const discMat = M(
      new THREE.MeshBasicMaterial({ color: 0x9fb4d0, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(m.x, 0.045, m.z);
    // Left alone by the anatomy step's wireframe (`core/anatomy-wireframe.js` reads this flag). The
    // disc is not hardware: it is a READOUT, a blur whose opacity and cone are written every frame from
    // logged rpm. Drawn as edges it would be two frozen circles per corner, and hidden with the rest of
    // the solid it used to leave four still props over an aircraft that is flying, which is why round 9
    // let it keep drawing at full strength over the drawing.
    //
    // Round 10 takes that back, because the drawing now has turning blades in it and the disc's job has
    // moved. It was the only thing on screen saying the props were turning; it is now a solid smoke
    // plate, wider than the whole airframe, sitting on top of a line drawing of the mechanism a card is
    // pointing at. So `update()` takes it down to WIRE_DISC of its value for exactly as long as the
    // drawing is standing in. Nothing is restored on the way out because nothing is stored: this
    // opacity is recomputed from `/motors` on every single frame, so the frame after the drawing goes
    // away is a full-strength disc again.
    disc.userData.anatomySkip = true;
    body.add(disc);

    // ---------- the prop hub ----------
    //
    // Two blades, only SHOWN while the motor is slow enough to actually see them, on a hub that always
    // turns and is always there. The split between those two sentences is round 10's whole change, and
    // it is a change about who owns what.
    //
    // Until now the group WAS the toggle: `blades.visible` went false above ~2 krpm and the hub went
    // with it. That reads correctly on the solid aircraft and it deletes the props from the anatomy
    // step's drawing, because a wireframe replica is parented under the live group it rides and three.js
    // draws nothing under an invisible parent. Hugh's note is that the rotors should turn in that
    // drawing, so the hub is now permanent - it carries the phase and the replica pieces - and the
    // per-frame visibility moved down onto the two blade MESHES, which is the layer that was ever
    // really conditional.
    //
    // `anatomyForce` on the hub is the other half: it tells `core/anatomy-wireframe.js` to replicate
    // this subtree even on a frame where the blades are hidden, which at survey rpm is every frame. The
    // blades are real hardware and the hiding is a photographic decision, so the drawing takes them and
    // the photograph keeps its decision. The stamp is inherited, so the two meshes come with it.
    const bladeMat = M(new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.7, metalness: 0.2, transparent: true, opacity: 1 }));
    const blades = new THREE.Group();
    blades.position.set(m.x, 0.044, m.z);
    blades.userData.anatomyForce = true;
    body.add(blades);
    const bladeMeshes = [];
    for (let b = 0; b < 2; b++) {
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.rotation.y = b * Math.PI;
      blade.rotation.x = (m.cw ? 1 : -1) * 0.14;
      blade.castShadow = true;
      blades.add(blade);
      bladeMeshes.push(blade);
    }

    const led = new THREE.Mesh(ledGeo, front ? ledFrontMat : ledRearMat);
    led.position.set(m.x * 1.03, -0.012, m.z * 1.03);
    body.add(led);

    const leg = new THREE.Mesh(legGeo, metalMat);
    leg.position.set(m.x * 0.72, -0.038 - GEAR / 2, m.z * 0.72);
    leg.rotation.z = -Math.sign(m.x) * 0.16;
    leg.rotation.x = Math.sign(m.z) * 0.16;
    leg.castShadow = true;
    body.add(leg);

    props.push({ disc, discMat, blades, bladeMeshes, bladeMat, cw: m.cw, phase: m.id * 1.1 });
    if (m.id === 3) {
      m3Bell = bell;
      m3Parts.push({ mesh: arm, base: carbonMat }, { mesh: bell, base: metalMat }, { mesh: bellTop, base: metalMat });
      m3Parts.push({ mesh: ring, base: accentMat, accent: true });
    }
  });

  [-1, 1].forEach((side) => {
    const skid = new THREE.Mesh(skidGeo, metalMat);
    skid.rotation.z = Math.PI / 2;
    skid.position.set(0, -0.038 - GEAR - 0.004, side * ARM_R * 0.72);
    skid.castShadow = true;
    body.add(skid);
  });

  // alert halo, only present while motor 3 is highlighted
  const haloMat = M(new THREE.MeshBasicMaterial({ color: COL.alert, transparent: true, opacity: 0, depthWrite: false }));
  const halo = new THREE.Mesh(G(new THREE.TorusGeometry(0.082, 0.0045, 8, 32)), haloMat);
  halo.rotation.x = Math.PI / 2;
  halo.position.set(-ARM_R, 0.03, -ARM_R);
  halo.visible = false;
  body.add(halo);

  // ---------- highlight ----------
  let highlight = null;
  function setHighlight(partId) {
    highlight = partId || null;
    const on = highlight === 'm3';
    m3Parts.forEach((p) => {
      p.mesh.material = on ? (p.accent ? hotAccent : hotShell) : p.base;
    });
    halo.visible = on;
    if (!on) {
      hotShell.emissiveIntensity = 0;
      hotAccent.emissiveIntensity = 0;
      haloMat.opacity = 0;
    }
  }

  // ---------- per-frame ----------
  let lastT = 0;
  let haveT = false;
  /**
   * The longest mission-time step the prop phase will integrate, and it is derived rather than felt
   * out. `core/timeline.js` clamps its own wall step to 0.1 s before scaling it by the transport
   * speed, and the fastest button in the viewer is 2x, so ONE tick of playback can never advance
   * mission time by more than 0.2 s however badly the frame rate is behaving. Anything past 0.25 s is
   * therefore a seek by construction - a scrubber drag, a chart click, a jump to a finding - and not
   * a slow frame, which is the distinction the props care about: a slow frame is motion that has to
   * keep integrating, and a seek is not motion at all.
   *
   * Deliberately looser than the 0.1 s this used to clamp to, because clamping and refusing are not
   * the same decision and 0.1 s was sized for the first. A visitor at 2x on a 15 fps phone hands this
   * 0.133 s steps of real playback: the old code integrated 0.1 of each one and the props kept
   * turning slightly slow, and refusing at the same threshold would stop them dead, which on this
   * mission is a readout saying the motors quit.
   */
  const MAX_PHASE_DT = 0.25;

  function update(tSec, data) {
    const pos = data && data['/pos'];
    const att = data && data['/att'];
    const mot = data && data['/motors'];
    const bat = data && data['/bat'];
    if (!pos || !att || !mot) return;
    buildTrack(data);
    buildCoverage(data);

    const x = sampleAt(pos.t, pos.x, tSec);
    const y = sampleAt(pos.t, pos.y, tSec);
    const alt = sampleAt(pos.t, pos.alt, tSec);
    const roll = sampleAt(att.t, att.roll, tSec);
    const pitch = sampleAt(att.t, att.pitch, tSec);
    const yaw = sampleAt(att.t, att.yaw, tSec);

    craft.position.set(wx(x), wy(alt) + GEAR + 0.05, wz(y));
    craft.rotation.y = -yaw * DEG;
    craft.rotation.z = pitch * DEG;
    craft.rotation.x = roll * DEG;

    /**
     * How much MISSION time passed since the last frame, signed, and the sign is the whole point.
     *
     * This used to be `Math.min(Math.abs(tSec - lastT), 0.1)`, and the `Math.abs` is a bug with a
     * plausible reason behind it: a negative step looks like something to make safe, so it was
     * folded into a positive one. But every negative step here means the timeline went BACKWARD -
     * and it goes backward constantly on this mission, because `core/flow.js` and the anatomy tour
     * both run the viewer inside a loop window, so mission time wraps from the end of the window to
     * its start every couple of seconds. Absolute value turned each of those wraps into a forward
     * step the size of the whole window and spun the props by it: on the anatomy tour that is a
     * lurch on all four props, in the same direction, once per loop, on a step whose entire subject
     * is that these four rpm traces are the truth. A backward scrub did the same thing, only bigger.
     *
     * So the rule is the one the SSL wheels use (`ssl/rtt-model.js`, and the reasoning there is
     * worth reading): integrate a forward step of a plausible size, integrate NOTHING otherwise,
     * and resample either way. `lastT` is written unconditionally on the line below, so a wrap, a
     * seek, a repeated frame and a backward drag all leave the props exactly where they are and the
     * next frame carries on from the new time. Nothing is clamped, because a clamped seek is still
     * a seek that turned the props by 0.1 s of phase it never earned.
     *
     * The first frame has no previous time to difference (`lastT` starts at 0 and the first tick can
     * arrive anywhere in the mission, including inside the success step's loop at 18.6 s), so it is
     * a resample too rather than one enormous integration.
     */
    const tStep = haveT ? tSec - lastT : 0;
    const dt = tStep > 0 && tStep <= MAX_PHASE_DT ? tStep : 0;
    lastT = tSec;
    haveT = true;
    const rpms = [
      sampleAt(mot.t, mot.rpm1, tSec),
      sampleAt(mot.t, mot.rpm2, tSec),
      sampleAt(mot.t, mot.rpm3, tSec),
      sampleAt(mot.t, mot.rpm4, tSec),
    ];
    // Is this aircraft being drawn as ITSELF on this frame, or is the anatomy step's wireframe standing
    // in for it? `core/anatomy-wireframe.js` hides every mesh it replicated on its settle frame and
    // writes each one back verbatim on dispose, so any replicated mesh answers the question, and the
    // lower centre plate is the steadiest one to ask: it is in the replica set on every install (no skip
    // stamp, visible on every step of the mission) and nothing else in this file ever writes to it.
    // Reading the graph rather than being told is deliberate - the module has no channel back into a
    // scene, and inventing one so this file could be notified would be a second source of truth about a
    // flag that is already sitting there.
    const solid = lower.visible;
    // The visual blade rate, which is the one number on this aircraft that has to be stylised.
    //
    // At the anatomy tour's 6.0 to 6.2 krpm a prop is turning 103 times a second. BLADE_RATE draws that
    // at 16.5, which is 99 degrees per frame at 60 fps against a two-blade prop's 180 degree symmetry:
    // past the aliasing limit, so it reads as a slow backwards flicker, which is exactly why the solid
    // aircraft hides its blades up there and shows a blur disc instead. A line drawing has no blur to
    // hide behind, so WIRE_BLADE_RATE takes it to 1.07 turns a second, 6.4 degrees per frame, a prop a
    // visitor watches go round. Proportional and not capped: the four corners keep their relative rates,
    // spin-up still spins up, and a motor that stops draws as a stopped prop, which is the mechanism
    // this whole mission is about. Slowed, never invented - direction, ratio and rpm are all `/motors`.
    const spin = solid ? BLADE_RATE : BLADE_RATE * WIRE_BLADE_RATE;
    props.forEach((p, i) => {
      const rpm = rpms[i];
      // The ONLY place a blade phase is written, on the hub, so the solid blades and the drawing's
      // replica of them are the same rotation by construction and cannot drift apart.
      p.phase += (p.cw ? -1 : 1) * (rpm / 60) * dt * 2 * Math.PI * spin;
      p.blades.rotation.y = p.phase;
      const fast = Math.min(rpm / 2600, 1);
      const slow = Math.max(0, 1 - rpm / 2100);
      p.discMat.opacity = (0.05 + 0.22 * fast * fast) * (solid ? 1 : WIRE_DISC);
      p.bladeMat.opacity = slow;
      // Left entirely alone while the drawing is up: the wireframe hid these two meshes on its settle
      // frame and owns the restore, and a scene writing them back every frame would be fighting it.
      if (solid) {
        const show = slow > 0.02;
        const bm = p.bladeMeshes;
        for (let b = 0; b < bm.length; b++) bm[b].visible = show;
      }
      const cone = 0.965 + 0.035 * fast;
      p.disc.scale.set(cone, cone, 1);
    });

    // Pack charge, off the logged voltage. `/bat` is its own 25 Hz channel against the 50 Hz flight
    // loop, which is what the anatomy card says, and it is read here through the same `sampleAt`
    // the pose and the props use: no smoothing, no separate clock, so the gauge and the chart on
    // the failure step are reading one array. Four segments, each worth a quarter of the 3.2 to
    // 4.2 V per-cell band: segments under the level are full, the one the level falls inside is lit
    // in proportion, and the ones above it stay as faint outlines so the gauge still reads as four.
    if (bat) {
      const cell = sampleAt(bat.t, bat.v, tSec) / 4;
      const fill = Math.max(0, Math.min((cell - 3.2) / 1.0, 1));
      for (let i = 0; i < gaugeMats.length; i++) {
        const seg = Math.max(0, Math.min(fill * gaugeMats.length - i, 1));
        gaugeMats[i].opacity = 0.22 + 0.68 * seg;
      }
    }

    if (trailGeo) {
      const k = Math.max(2, Math.min(trailVerts, Math.round((tSec / duration) * trailVerts) + 1));
      trailGeo.setDrawRange(0, k);
    }

    const dp = dropGeo.attributes.position;
    dp.setXYZ(0, wx(x), wy(alt), wz(y));
    dp.setXYZ(1, wx(x), 0.006, wz(y));
    dp.needsUpdate = true;
    dropMat.opacity = 0.05 + 0.2 * Math.min(alt / 6, 1);

    footprint.position.set(wx(x), 0.011, wz(y));
    footprint.rotation.y = -yaw * DEG;
    footMat.opacity = footAlpha(tSec);
    footprint.visible = footMat.opacity > 0.01;

    // The covered ground, revealed to the playhead. One pass over 280 tiles writing three floats a
    // vertex: cheaper than the branchier alternatives and, more to the point, stateless - a wrap, a
    // seek or a backward scrub all land on exactly the coverage that time has, with nothing to undo.
    if (covReady) {
      const cc = covGeo.attributes.color;
      const arr = cc.array;
      for (let c = 0; c < COV_N; c++) {
        const age = tSec - covAt[c];
        const k = age > 0 ? Math.min(age / COV_FADE, 1) * COV_MAX : 0;
        const cr = covRGB.r * k;
        const cg = covRGB.g * k;
        const cb = covRGB.b * k;
        for (let q = 0; q < 4; q++) {
          const o = (c * 4 + q) * 3;
          arr[o] = cr;
          arr[o + 1] = cg;
          arr[o + 2] = cb;
        }
      }
      cc.needsUpdate = true;
    }

    rim.position.set(wx(x) - 0.75, wy(alt) + 0.5, wz(y) - 0.85);

    if (highlight === 'm3') {
      const pulse = 0.35 + Math.abs(Math.sin(tSec * 4.4)) * 0.8;
      hotShell.emissiveIntensity = pulse;
      hotAccent.emissiveIntensity = pulse * 1.3;
      haloMat.opacity = 0.22 + Math.abs(Math.sin(tSec * 4.4)) * 0.5;
      const s = 1 + Math.abs(Math.sin(tSec * 4.4)) * 0.12;
      halo.scale.set(s, s, 1);
    }
  }

  /** Point the viewer keeps the shot on. The viewer lags it, so the 2.1 m dip still reads. */
  function cameraFocus() {
    return { x: craft.position.x, y: craft.position.y + 0.04, z: craft.position.z };
  }

  // ---------- anatomy anchors ----------
  // World positions for the four parts the anatomy step labels, read off the real meshes rather
  // than written down as constants: this aircraft never sits still, so a fixed point would drift
  // off the part within one frame. Each closure walks the parent chain (craft -> body -> mesh) and
  // returns where the part is RIGHT NOW, after whatever update() last posed. That keeps the labels
  // and their leader lines attached while the craft flies its lanes, banks and yaws.
  //
  // The ids are the part ids the def declares. Only 'm3' is also a setHighlight target; the other
  // three are label anchors only, and setHighlight is unchanged. Every call hands back a fresh
  // vector, so the caller can project it in place without corrupting the next frame's reading.
  //
  // `imu` moved in round 7, from the centre plate to the flight-controller board that round added
  // to the top deck: the anchor is where the leader line lands and where the tour's highlight halo
  // sits, and both belong on the part the card names rather than on the plate it is bolted to.
  const anchorMap = {
    m3: () => m3Bell.getWorldPosition(new THREE.Vector3()), // motor 3 bell, rear-left corner
    battery: () => batt.getWorldPosition(new THREE.Vector3()), // pack under the lower plate
    camera: () => lens.getWorldPosition(new THREE.Vector3()), // survey lens on the nose gimbal
    imu: () => fcBoard.getWorldPosition(new THREE.Vector3()), // the FC board on the top deck
  };

  /** @returns {Record<string, () => import('three').Vector3>} same object every call */
  function anchors() {
    return anchorMap;
  }

  // ---------- part meshes ----------
  // The anatomy tour's highlight channel (`sceneApi.partMeshes()`, documented in viewer.js): the
  // meshes each card's part actually IS, so the tour can sleeve the live one in its own additive
  // glow while the camera holds the whole aircraft in frame. Separate from `setHighlight()` above,
  // which is the fault channel and paints motor 3 alert red on the failure step.
  //
  // The prop disc and the blades are deliberately not in `m3`: the disc is a blur whose opacity is
  // driven by rpm, and lighting a transparent quad would put a glowing plate over the motor rather
  // than on it. What is lit is the arm, the bell, its cap and the accent ring - the motor and the
  // boom it is bolted to.
  const PART_MESHES = {
    m3: m3Parts.map((p) => p.mesh),
    battery: battParts,
    camera: [gimbal, lens],
    imu: [fcBoard, fcChip, fcLed],
  };
  // The same four groupings, stamped on the meshes themselves, which is the channel the anatomy step's
  // wireframe reads (`core/anatomy-wireframe.js`): it walks the aircraft's subtree from the outside and
  // cannot be handed this map, so the map marks its own members. Stamped here rather than restated over
  // there so a mesh that joins a card's part joins its drawing's brighter register in the same edit.
  Object.keys(PART_MESHES).forEach((id) => {
    PART_MESHES[id].forEach((m) => {
      m.userData.anatomyPart = id;
    });
  });

  /** @returns {Record<string, import('three').Mesh[]>} */
  function partMeshes() {
    return PART_MESHES;
  }

  function dispose() {
    mount.remove(root);
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }

  return { update, setHighlight, dispose, cameraHome, cameraFocus, anchors, partMeshes };
}
