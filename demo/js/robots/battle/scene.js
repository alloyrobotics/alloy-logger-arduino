// battle/scene.js - the ICRA 2019 AI Challenge arena, as a scripted simulated round.
//
// Nothing here is invented. The arena, the seven obstacles, the four start zones, the two defense
// bonus zones and the two supplier zones all come out of the decoded payload's `meta.geometry`
// block, which is the frozen geometry manifest the generator and the tests share. The rules manual
// governs only what a geometry table cannot carry: grey lychee-grain PVC floor, wood walls at
// LiDAR height with a translucent band above them, wooden obstacles, team-colour zone stickers, a
// yellow octagon on each supplier. There are no competition logos or art anywhere in this file,
// by design: the teams are fictional and the hulls carry colour and callsign only.
//
// FRAMES. The payload is in the field frame of the manual's dimensioned drawing: origin at the
// bottom-left inner corner, +x along the 8.000 m length, +y along the 5.000 m width, z up, angles
// in degrees CCW about +z from +x. three.js is y-up, so this file maps
//
//     three.x = fieldX - 4.0        (arena centred on the origin)
//     three.y = fieldZ              (height)
//     three.z = -(fieldY - 2.5)
//     group.rotation.y = fieldYawRadians
//
// which is the same handedness flip the other replay scene uses: a field heading of yaw points
// along (cos yaw, sin yaw) in the field and lands on (cos yaw, -sin yaw) in three's (x, z), which
// is exactly what rotation.y does to local +x. Robot-local +x is therefore body FORWARD and
// robot-local -z is body +Y, which per the frozen armour map is the RIGHT plate.
//
// The scene is built LAZILY, on the first update() that arrives with a decoded payload.
// buildScene() runs before any data exists and battle-data.js is ~346 KB, so importing it here
// would drag the whole round onto the picker's boot path. update() is where the data contract
// lives (`viewer.js` passes `def.getSceneData?.() ?? def.data`), so that is where the arena gets
// built - off the preview slice on the picker card, off the full round on the demo screen, through
// one code path either way.
//
// Two viewer contracts this scene leans on:
//   * `rendering.shadow === false` - the default rig is an 80 m ground plane, two 60 m grids and a
//     1024^2 shadow map over an 18 m frustum, none of which suit an 8 x 5 m arena. Grounding comes
//     from baked contact discs instead and every mesh sets castShadow = false.
//   * `hudState(tSec)` - a follow-cam cannot show a legible referee panel in-world, so the round
//     clock, the organizer-view HP totals and the buff/supply callout ride a DOM strip. Only the
//     fields this mission actually has are filled: there are no cards, no keeper and no timeouts
//     in this ruleset, so those keys are OMITTED rather than sent as zeroes, and viewer.js renders
//     a discipline field only for a team that defines one.
//
// PER-FRAME ALLOCATION IS ZERO. Every array, matrix, colour and scratch object below is allocated
// once at build time; update() only writes into them.

// ---------------------------------------------------------------------------- constants

const HALF_L = 4.0; // half the 8.000 m length
const HALF_W = 2.5; // half the 5.000 m width

/** field x -> three x */
const tx = (x) => x - HALF_L;
/** field y -> three z */
const tz = (y) => -(y - HALF_W);

const DEG = Math.PI / 180;

// Decal stacking on the floor. Millimetres apart, so a zone fill never z-fights its own border.
const Y_FILL = 0.0016;
const Y_CONTACT = 0.0026;
const Y_LINE = 0.0034;
const Y_TILE = 0.0042;

// Robot envelope. Defaults only: every one of these is read from `meta.geometry.robotEnvelopeM`
// when the payload carries it, which it always does.
const DEF_ENVELOPE = {
  lengthM: 0.6,
  widthM: 0.45,
  heightM: 0.46,
  gimbalZM: 0.15,
  barrelZM: 0.23,
  armorZM: 0.19,
};

const CHASSIS_H = 0.16; // the box the armour modules bolt to
const CHASSIS_Y0 = 0.055; // its underside, above the wheel line
const WHEEL_R = 0.062;
const BARREL_R = 0.0085; // 17 mm bore
const BARREL_LEN = 0.26;
const HP_FULL = 2000; // initial HP, and therefore the full length of the light indicator

// Team palette. Colour is the ONLY team marking on a hull: no crest, no number decal, no art.
const TEAM_COLOR = {
  blue: { hull: 0x2c62d6, glow: 0x5f93ff, dot: 0x3f7bff },
  red: { hull: 0xc8352f, glow: 0xff6a60, dot: 0xe5484d },
};

// Projectile tracers. A 17 mm round leaves at 23 m/s and covers the 1.37 m to the obstacle in
// 48 ms, so a streak drawn only for its literal time of flight is a two-frame event nobody sees.
// The streak is drawn along the real ballistic segment for the real flight time and then held as a
// fading full-length trail, which is what a tracer actually looks like to an eye and to a camera.
const TRACER_MAX = 18; // concurrent streaks; the 7 Hz burst never needs more than a handful
const TRACER_TAIL_S = 0.11; // how long the spent trail lingers
const TRACER_LEN = 0.55; // in-flight streak length, metres
const FLASH_MAX = 20;
const FLASH_IMPACT_S = 0.45; // impact bloom lifetime
const FLASH_MUZZLE_S = 0.075;
const PLATE_FLASH_S = 0.45; // how long a struck armour module stays lit
/** The longest any per-shot effect lives, measured from the round's arrival. */
const EFFECT_MAX_S = Math.max(TRACER_TAIL_S, FLASH_IMPACT_S, FLASH_MUZZLE_S) + 0.01;

// Camera. |offset| = 5.6 m at 48 deg elevation, swung 20 deg off the arena's long axis: near
// enough to end-on that the far wall stays behind the play, far enough off it that the floor reads
// as a plane. At the viewer's widened fov that is ~8.5 m of arena across a desktop panel, so the
// whole 8 m length is in frame on "reset view" AND a 0.6 m robot is still ~7% of the width when
// the follow track is on it.
export const cameraHome = {
  position: { x: 1.28, y: 4.36, z: 3.52 },
  target: { x: 0, y: 0.2, z: 0 },
};

// The action centroid, weighted toward the instrumented robot. Blue 1 is the machine every channel
// and every finding is about, so the shot leans on it without ever losing the other three.
const W_BLUE1 = 2.4;
const W_OTHER = 1.0;
const FOCUS_SMOOTH = 22; // +/- samples of box filter on the 20 Hz pose grid, so ~1.1 s each side

// A moment mid-round, comfortably BEFORE the failure, for the no-argument hero pose.
const HERO_T = 70.0;

// ---------------------------------------------------------------------------- small helpers

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest-arc interpolation between two wrapped degree values. */
function lerpDeg(a, b, s) {
  let d = b - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return a + d * s;
}

/**
 * Uniform-grid Catmull-Rom, with the same overshoot clamp the other replay scene uses on its
 * Hermite: a 20 Hz pose grid played back at 60 fps needs C1 continuity or every sample boundary
 * shows as a tick, and an unclamped cubic blows up wherever the authored trajectory corners.
 */
function catmull(p0, p1, p2, p3, s) {
  const s2 = s * s;
  const s3 = s2 * s;
  const p =
    0.5 *
    (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
  const lo = Math.min(p1, p2) - 0.25 * Math.abs(p2 - p1) - 0.02;
  const hi = Math.max(p1, p2) + 0.25 * Math.abs(p2 - p1) + 0.02;
  return p < lo ? lo : p > hi ? hi : p;
}

/** Last entry of a t-ascending array at or before t. -1 when t precedes all of them. */
function holdIndex(arr, t) {
  if (!arr || !arr.length || t < arr[0].t) return -1;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** m:ss from a remaining-seconds count. The referee stage clock counts DOWN from 180. */
function clockText(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.ceil(sec - 1e-9));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
}

// ---------------------------------------------------------------------------- geometry batcher

/** Accumulates untextured triangles so the whole arena lands in a handful of draw calls. */
function Batch() {
  this.p = [];
  this.n = [];
}
Batch.prototype.tri = function tri(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) {
  this.p.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
};
Batch.prototype.quad = function quad(a, b, c, d, nx, ny, nz) {
  this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], nx, ny, nz);
  this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], nx, ny, nz);
};
/** Axis-aligned box in three coordinates; `faces` is a bitmask +X 1, -X 2, +Y 4, -Y 8, +Z 16, -Z 32. */
Batch.prototype.box = function box(cx, cy, cz, sx, sy, sz, faces) {
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  const f = faces == null ? 63 : faces;
  if (f & 1) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], 1, 0, 0);
  if (f & 2) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], -1, 0, 0);
  if (f & 4) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], 0, 1, 0);
  if (f & 8) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0, -1, 0);
  if (f & 16) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 0, 0, 1);
  if (f & 32) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], 0, 0, -1);
};
/** A flat floor rectangle, given in FIELD coordinates. */
Batch.prototype.fieldRect = function fieldRect(x0, y0, x1, y1, y) {
  this.quad(
    [tx(x0), y, tz(y0)],
    [tx(x1), y, tz(y0)],
    [tx(x1), y, tz(y1)],
    [tx(x0), y, tz(y1)],
    0, 1, 0
  );
};
/** A flat stripe on the floor between two FIELD points, `w` wide, squared off at both ends. */
Batch.prototype.fieldStripe = function fieldStripe(ax, ay, bx, by, w, y) {
  let dx = bx - ax;
  let dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const px = (dy * w) / 2;
  const py = (-dx * w) / 2;
  this.quad(
    [tx(ax + px), y, tz(ay + py)],
    [tx(bx + px), y, tz(by + py)],
    [tx(bx - px), y, tz(by - py)],
    [tx(ax - px), y, tz(ay - py)],
    0, 1, 0
  );
};
/** Rectangular outline on the floor, FIELD coordinates. */
Batch.prototype.fieldOutline = function fieldOutline(x0, y0, x1, y1, w, y) {
  this.fieldStripe(x0, y0, x1, y0, w, y);
  this.fieldStripe(x1, y0, x1, y1, w, y);
  this.fieldStripe(x1, y1, x0, y1, w, y);
  this.fieldStripe(x0, y1, x0, y0, w, y);
};
/** Regular polygon outline on the floor, FIELD coordinates. The supplier decal is an octagon. */
Batch.prototype.fieldPolyOutline = function fieldPolyOutline(cx, cy, r, sides, rot, w, y) {
  for (let i = 0; i < sides; i++) {
    const a0 = rot + (Math.PI * 2 * i) / sides;
    const a1 = rot + (Math.PI * 2 * (i + 1)) / sides;
    this.fieldStripe(
      cx + r * Math.cos(a0), cy + r * Math.sin(a0),
      cx + r * Math.cos(a1), cy + r * Math.sin(a1),
      w, y
    );
  }
};
/** Filled regular polygon on the floor, FIELD coordinates. */
Batch.prototype.fieldPolyFill = function fieldPolyFill(cx, cy, r, sides, rot, y) {
  for (let i = 0; i < sides; i++) {
    const a0 = rot + (Math.PI * 2 * i) / sides;
    const a1 = rot + (Math.PI * 2 * (i + 1)) / sides;
    this.tri(
      tx(cx), y, tz(cy),
      tx(cx + r * Math.cos(a0)), y, tz(cy + r * Math.sin(a0)),
      tx(cx + r * Math.cos(a1)), y, tz(cy + r * Math.sin(a1)),
      0, 1, 0
    );
  }
};
Batch.prototype.build = function build(THREE) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
  return g;
};

// ---------------------------------------------------------------------------- procedural surfaces

/**
 * Grey lychee-grain PVC. The manual's floor is a 3 to 3.5 mm PVC mat with the pebbled "lychee"
 * emboss, which is a high-frequency, low-amplitude grain: it belongs almost entirely in the normal
 * map, with only a whisper of mottle in the albedo. Generated into a canvas, never fetched.
 */
function pvcTextures(THREE) {
  const N = 256;
  const grain = new Float32Array(N * N);
  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // Pebbles: a jittered lattice of round bumps, which is what a lychee emboss actually is.
  const pebble = (cells, amp) => {
    const cell = N / cells;
    for (let cj = -1; cj <= cells; cj++) {
      for (let ci = -1; ci <= cells; ci++) {
        const wi = (ci + cells) % cells;
        const wj = (cj + cells) % cells;
        const px = (ci + 0.2 + 0.6 * hash(wi, wj)) * cell;
        const py = (cj + 0.2 + 0.6 * hash(wi + 37, wj + 11)) * cell;
        const r = cell * (0.34 + 0.24 * hash(wi + 71, wj + 53));
        const i0 = Math.max(0, Math.floor(px - r));
        const i1 = Math.min(N - 1, Math.ceil(px + r));
        const j0 = Math.max(0, Math.floor(py - r));
        const j1 = Math.min(N - 1, Math.ceil(py + r));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(i - px, j - py) / r;
            if (d >= 1) continue;
            const h = Math.cos(d * Math.PI * 0.5);
            grain[j * N + i] += h * h * amp;
          }
        }
      }
    }
  };
  pebble(26, 1.0);
  pebble(13, 0.35);

  const mk = (paint) => {
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    paint(img.data);
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    return t;
  };

  const map = mk((d) => {
    for (let i = 0; i < N * N; i++) {
      const v = grain[i] - 0.5;
      d[i * 4] = 116 + v * 18;
      d[i * 4 + 1] = 118 + v * 18;
      d[i * 4 + 2] = 122 + v * 18;
      d[i * 4 + 3] = 255;
    }
  });
  map.colorSpace = THREE.SRGBColorSpace;

  const rough = mk((d) => {
    for (let i = 0; i < N * N; i++) {
      const v = 214 + (grain[i] - 0.5) * 40;
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
  });

  const normal = mk((d) => {
    const at = (i, j) => grain[((j + N) % N) * N + ((i + N) % N)];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const dx = (at(i + 1, j) - at(i - 1, j)) * 3.1;
        const dy = (at(i, j + 1) - at(i, j - 1)) * 3.1;
        const len = Math.hypot(dx, dy, 1);
        const k = (j * N + i) * 4;
        d[k] = ((-dx / len) * 0.5 + 0.5) * 255;
        d[k + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
        d[k + 2] = (1 / len) * 0.5 * 255 + 127;
        d[k + 3] = 255;
      }
    }
  });

  return { map, rough, normal };
}

/** Plywood: a directional grain, warm, matte. Walls below LiDAR height and all seven obstacles. */
function woodTextures(THREE) {
  const N = 256;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const d = img.data;
  const hash = (x, y) => {
    const s = Math.sin(x * 91.7 + y * 47.3) * 21421.13;
    return s - Math.floor(s);
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      // rings stretched hard along u, so the grain runs with the board
      const w = Math.sin((j + Math.sin(i * 0.031) * 9) * 0.42) * 0.5 + 0.5;
      const fine = hash(Math.floor(i / 2), j) * 0.35;
      const v = 0.62 + w * 0.24 + fine * 0.14;
      const k = (j * N + i) * 4;
      d[k] = Math.min(255, 176 * v);
      d[k + 1] = Math.min(255, 138 * v);
      d[k + 2] = Math.min(255, 92 * v);
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round contact patch, so a shadowless robot still sits ON the floor. */
function contactTexture(THREE) {
  const N = 64;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------- buildScene

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  root.name = 'battle-root';
  mount.add(root);

  const disposables = [];
  const keep = (o) => {
    disposables.push(o);
    return o;
  };

  let D = null; // decoded round payload, once update() hands it over
  let built = false;
  let env = DEF_ENVELOPE;
  let robots = []; // in ROBOT_ORDER
  let robotByWire = null; // wire id -> robot record
  let contacts = null;
  let tracers = null;
  let flashes = null;
  let zoneDecals = null; // { blue_defense, red_defense, blue_supplier, red_supplier }
  let zoneKeys = null; // its key list, resolved once: Object.keys() in update() is an allocation
  let shots = []; // resolved ballistic segments, t-ascending
  let hitEvents = [];
  let buffs = [];
  let supplies = []; // one row per dispense window
  let zoneRows = [];
  let focusX = null; // smoothed action-centroid track, pose grid
  let focusY = null;
  let heroFocus = null;
  let lastFocus = null;
  let highlight = null;
  let hot = null;

  const dummy = new THREE.Object3D();
  const scratchColor = new THREE.Color();
  const focusOut = { x: 0, y: 0.22, z: 0 };
  const heroOut = { x: 0, y: 0.22, z: 0 };

  // The HUD object is allocated ONCE and mutated in place, exactly like its version key: the strip
  // is rendered off `version`, so a producer that reallocated would still be correct but would
  // churn a fresh object 60 times a second for a string that changes twice a minute.
  //
  // Note which keys are ABSENT. This ruleset has no cards, no goalkeeper and no timeouts, so those
  // fields are not on the team objects at all and viewer.js renders nothing for them. Sending them
  // as zeroes would have put a truthful-looking "0Y" on a strip for a game that has no cards.
  const hud = {
    version: '',
    clock: '--:--',
    stage: '',
    state: { label: 'ROUND', tone: 'live', note: '' },
    teams: [
      { name: '', color: 'blue', score: 0 },
      { name: '', color: 'red', score: 0 },
    ],
  };

  const ROBOT_ORDER = ['blue1', 'blue2', 'red1', 'red2'];

  // ------------------------------------------------------------------ the arena

  function buildArena(geo) {
    const wallBand = geo.arena && geo.arena.wallBandM ? geo.arena.wallBandM : 0.075;
    const L = (geo.arena && geo.arena.xM) || 8.0;
    const W = (geo.arena && geo.arena.yM) || 5.0;

    // ---- floor
    const pvc = pvcTextures(THREE);
    keep(pvc.map);
    keep(pvc.rough);
    keep(pvc.normal);
    [pvc.map, pvc.rough, pvc.normal].forEach((t) => t.repeat.set(L / 0.42, W / 0.42));
    const floorMat = keep(
      new THREE.MeshStandardMaterial({
        map: pvc.map,
        roughnessMap: pvc.rough,
        normalMap: pvc.normal,
        roughness: 1.0,
        metalness: 0.0,
      })
    );
    floorMat.normalScale.set(0.9, 0.9);
    const floorGeo = keep(new THREE.PlaneGeometry(L, W));
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;
    floor.receiveShadow = false;
    floor.name = 'floor';
    root.add(floor);

    // ---- walls. Solid wood up to LiDAR height, translucent matte above it: that split is the
    // venue's, and it is why a 2D LiDAR sees a closed box while a camera sees out of the arena.
    const WOOD_H = 0.25;
    const CLEAR_H = 0.34;
    const woodTex = keep(woodTextures(THREE));
    woodTex.repeat.set(6, 1);
    const woodMat = keep(
      new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.86, metalness: 0.0 })
    );
    const lower = new Batch();
    const cz = W / 2 + wallBand / 2;
    const cx = L / 2 + wallBand / 2;
    lower.box(0, WOOD_H / 2, -cz, L + 2 * wallBand, WOOD_H, wallBand, 63);
    lower.box(0, WOOD_H / 2, cz, L + 2 * wallBand, WOOD_H, wallBand, 63);
    lower.box(-cx, WOOD_H / 2, 0, wallBand, WOOD_H, W, 63);
    lower.box(cx, WOOD_H / 2, 0, wallBand, WOOD_H, W, 63);
    const lowerMesh = new THREE.Mesh(keep(lower.build(THREE)), woodMat);
    lowerMesh.castShadow = false;
    lowerMesh.name = 'wall-wood';
    root.add(lowerMesh);

    const upper = new Batch();
    const uy = WOOD_H + CLEAR_H / 2;
    upper.box(0, uy, -cz, L + 2 * wallBand, CLEAR_H, wallBand, 63);
    upper.box(0, uy, cz, L + 2 * wallBand, CLEAR_H, wallBand, 63);
    upper.box(-cx, uy, 0, wallBand, CLEAR_H, W, 63);
    upper.box(cx, uy, 0, wallBand, CLEAR_H, W, 63);
    const clearMat = keep(
      new THREE.MeshStandardMaterial({
        color: 0xb8c6d2,
        roughness: 0.42,
        metalness: 0.0,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      })
    );
    const upperMesh = new THREE.Mesh(keep(upper.build(THREE)), clearMat);
    upperMesh.castShadow = false;
    upperMesh.renderOrder = 4;
    upperMesh.name = 'wall-clear';
    root.add(upperMesh);

    // ---- the seven obstacles, straight off the frozen manifest
    const obs = new Batch();
    (geo.obstacles || []).forEach((o) => {
      const h = o.heightM || 0.4;
      obs.box(
        tx((o.x0 + o.x1) / 2), h / 2, tz((o.y0 + o.y1) / 2),
        o.x1 - o.x0, h, o.y1 - o.y0,
        63
      );
    });
    const obsTex = keep(woodTextures(THREE));
    obsTex.repeat.set(2, 1);
    const obsMat = keep(
      new THREE.MeshStandardMaterial({ map: obsTex, roughness: 0.82, metalness: 0.0 })
    );
    const obsMesh = new THREE.Mesh(keep(obs.build(THREE)), obsMat);
    obsMesh.castShadow = false;
    obsMesh.name = 'obstacles';
    root.add(obsMesh);
  }

  /**
   * Zone markings. Four start zones (1000 outer, 920 inner marking in the owning team's colour),
   * two fixed defense bonus zones (team-colour decal plus the RFID tile the robot's underside
   * reader triggers on) and two supplier zones (yellow octagon, each on the OPPOSING side's
   * centre, which is the drawing's cross-side placement).
   */
  function buildZones(geo) {
    const z = geo.zones || {};
    const out = {};

    const mkFill = (name, colorHex, base) => {
      const mat = keep(
        new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: base,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      return { mat, base, name };
    };

    // start zones: colour the marking, not the floor
    const startLines = { blue: new Batch(), red: new Batch() };
    [['blue_start_a', 'blue'], ['blue_start_b', 'blue'], ['red_start_a', 'red'], ['red_start_b', 'red']].forEach(
      ([key, team]) => {
        const r = z[key];
        if (!r) return;
        const cxF = (r.x0 + r.x1) / 2;
        const cyF = (r.y0 + r.y1) / 2;
        const half = 0.46; // the 920 mm inner marking
        startLines[team].fieldOutline(cxF - half, cyF - half, cxF + half, cyF + half, 0.03, Y_LINE);
      }
    );
    ['blue', 'red'].forEach((team) => {
      const mat = keep(
        new THREE.MeshBasicMaterial({
          color: TEAM_COLOR[team].dot,
          transparent: true,
          opacity: 0.72,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const m = new THREE.Mesh(keep(startLines[team].build(THREE)), mat);
      m.renderOrder = 2;
      m.castShadow = false;
      root.add(m);
    });

    // defense bonus zones: fill + border + RFID tile
    [['blue_defense', 'blue'], ['red_defense', 'red']].forEach(([key, team]) => {
      const r = z[key];
      if (!r) return;
      const fill = new Batch();
      fill.fieldRect(r.x0, r.y0, r.x1, r.y1, Y_FILL);
      const f = mkFill(key, TEAM_COLOR[team].dot, 0.14);
      const fm = new THREE.Mesh(keep(fill.build(THREE)), f.mat);
      fm.renderOrder = 1;
      fm.castShadow = false;
      root.add(fm);

      const line = new Batch();
      line.fieldOutline(r.x0 + 0.04, r.y0 + 0.04, r.x1 - 0.04, r.y1 - 0.04, 0.035, Y_LINE);
      const lineMat = keep(
        new THREE.MeshBasicMaterial({
          color: TEAM_COLOR[team].glow,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const lm = new THREE.Mesh(keep(line.build(THREE)), lineMat);
      lm.renderOrder = 2;
      lm.castShadow = false;
      root.add(lm);

      // the RFID tile itself: a small plate at the zone centre, which is what the underside
      // reader has to sit over for the 5 s dwell to count
      const tile = new Batch();
      const cxF = (r.x0 + r.x1) / 2;
      const cyF = (r.y0 + r.y1) / 2;
      tile.fieldRect(cxF - 0.11, cyF - 0.11, cxF + 0.11, cyF + 0.11, Y_TILE);
      const tileMat = keep(
        new THREE.MeshBasicMaterial({ color: 0xdfe6ec, transparent: true, opacity: 0.5, depthWrite: false })
      );
      const tm = new THREE.Mesh(keep(tile.build(THREE)), tileMat);
      tm.renderOrder = 2;
      tm.castShadow = false;
      root.add(tm);

      out[key] = { fill: f, lineMat, baseLine: 0.8 };
    });

    // supplier zones: yellow octagon decal
    [['blue_supplier', 'blue'], ['red_supplier', 'red']].forEach(([key]) => {
      const r = z[key];
      if (!r) return;
      const cxF = (r.x0 + r.x1) / 2;
      const cyF = (r.y0 + r.y1) / 2;
      const R = 0.5; // inscribed in the 1000 x 1000 maximum outer footprint
      const rot = Math.PI / 8;
      const fill = new Batch();
      fill.fieldPolyFill(cxF, cyF, R * 0.98, 8, rot, Y_FILL);
      const f = mkFill(key, 0xf5c518, 0.1);
      const fm = new THREE.Mesh(keep(fill.build(THREE)), f.mat);
      fm.renderOrder = 1;
      fm.castShadow = false;
      root.add(fm);

      const line = new Batch();
      line.fieldPolyOutline(cxF, cyF, R, 8, rot, 0.04, Y_LINE);
      line.fieldPolyOutline(cxF, cyF, R * 0.72, 8, rot, 0.025, Y_LINE);
      const lineMat = keep(
        new THREE.MeshBasicMaterial({
          color: 0xf5c518,
          transparent: true,
          opacity: 0.62,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const lm = new THREE.Mesh(keep(line.build(THREE)), lineMat);
      lm.renderOrder = 2;
      lm.castShadow = false;
      root.add(lm);

      out[key] = { fill: f, lineMat, baseLine: 0.62 };
    });

    return out;
  }

  // ------------------------------------------------------------------ the robots

  /**
   * One standard. Chassis, four wheels, four armour modules with their light bars, the HP light
   * indicator, and a gimbal carrying the 17 mm launcher. Colour and callsign are the only team
   * marking: no crest, no sponsor art, no competition logo.
   */
  function buildRobot(THREE_, teamKey, callsign) {
    const pal = TEAM_COLOR[teamKey];
    const L = env.lengthM;
    const Wd = env.widthM;

    const g = new THREE.Group();
    g.name = `bot_${callsign.replace(/\s+/g, '').toLowerCase()}`;
    root.add(g);

    // ---- chassis shell, skirt and wheels, one batch
    const body = new Batch();
    body.box(0, CHASSIS_Y0 + CHASSIS_H / 2, 0, L * 0.92, CHASSIS_H, Wd * 0.9, 63);
    body.box(0, CHASSIS_Y0 - 0.012, 0, L * 0.82, 0.03, Wd * 0.98, 63); // skirt
    body.box(0, CHASSIS_Y0 + CHASSIS_H + 0.02, 0, L * 0.5, 0.04, Wd * 0.62, 63); // gimbal riser
    const bodyMat = keep(
      new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.82, metalness: 0.12, emissive: 0x000000 })
    );
    const bodyMesh = new THREE.Mesh(keep(body.build(THREE)), bodyMat);
    bodyMesh.castShadow = false;
    g.add(bodyMesh);

    // team-colour hull accents: two rails down the long sides, nothing else
    const accent = new Batch();
    [-1, 1].forEach((s) => {
      accent.box(0, CHASSIS_Y0 + CHASSIS_H - 0.022, s * (Wd * 0.45 + 0.004), L * 0.86, 0.026, 0.012, 63);
    });
    const accentMat = keep(
      new THREE.MeshStandardMaterial({
        color: pal.hull,
        roughness: 0.5,
        metalness: 0.2,
        emissive: pal.hull,
        emissiveIntensity: 0.22,
      })
    );
    const accentMesh = new THREE.Mesh(keep(accent.build(THREE)), accentMat);
    accentMesh.castShadow = false;
    g.add(accentMesh);

    const wgeo = keep(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.05, 10));
    const wmat = keep(new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.95, metalness: 0.0 }));
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      const w = new THREE.Mesh(wgeo, wmat);
      w.position.set(sx * L * 0.34, WHEEL_R, sz * (Wd / 2 + 0.006));
      w.rotation.x = Math.PI / 2;
      w.castShadow = false;
      g.add(w);
    });

    // ---- four armour modules. Each is its own mesh with its own material, because a hit lights
    // exactly ONE of them and a shared material would light all four.
    // Local +x = body FORWARD (armour 0), -x = BACKWARD (2), +z = body -Y = LEFT (1),
    // -z = body +Y = RIGHT (3), per the frozen armour map, which is also the order damage_source
    // reports in.
    const PLATE_H = 0.085;
    const plateMat = [];
    const plateSpec = [
      { px: L * 0.47, pz: 0, sx: 0.014, sz: Wd * 0.62, nx: 1, nz: 0 },
      { px: 0, pz: Wd * 0.47, sx: L * 0.6, sz: 0.014, nx: 0, nz: 1 },
      { px: -L * 0.47, pz: 0, sx: 0.014, sz: Wd * 0.62, nx: -1, nz: 0 },
      { px: 0, pz: -Wd * 0.47, sx: L * 0.6, sz: 0.014, nx: 0, nz: -1 },
    ];
    plateSpec.forEach((sp) => {
      const pb = new Batch();
      pb.box(sp.px, env.armorZM, sp.pz, sp.sx, PLATE_H, sp.sz, 63);
      const m = keep(
        new THREE.MeshStandardMaterial({
          color: 0x24272b,
          roughness: 0.7,
          metalness: 0.15,
          emissive: 0xffffff,
          emissiveIntensity: 0,
        })
      );
      const mesh = new THREE.Mesh(keep(pb.build(THREE)), m);
      mesh.castShadow = false;
      g.add(mesh);
      plateMat.push(m);
    });

    // light bars: two per module, standing just proud of the plate so the emissive strip is never
    // co-planar with the matte panel behind it
    const bars = new Batch();
    plateSpec.forEach((sp) => {
      const alongX = sp.nz !== 0;
      const span = alongX ? sp.sx : sp.sz;
      [-1, 1].forEach((s) => {
        const off = s * span * 0.36;
        bars.box(
          sp.px + (alongX ? off : sp.nx * 0.009),
          env.armorZM,
          sp.pz + (alongX ? sp.nz * 0.009 : off),
          alongX ? 0.022 : 0.008,
          PLATE_H * 0.82,
          alongX ? 0.008 : 0.022,
          63
        );
      });
    });
    const barMat = keep(
      new THREE.MeshStandardMaterial({
        color: pal.glow,
        roughness: 0.4,
        metalness: 0.0,
        emissive: pal.glow,
        emissiveIntensity: 1.3,
      })
    );
    const barMesh = new THREE.Mesh(keep(bars.build(THREE)), barMat);
    barMesh.castShadow = false;
    g.add(barMesh);

    // ---- HP light indicator: a strip down each side of the chassis deck whose LIT LENGTH is the
    // remaining HP. Geometry origin is at the left end, so the scale is a drain and not a slide,
    // and there is one per side so the state reads from either half of the arena.
    const hpFull = L * 0.68;
    const hpGeo = keep(new THREE.BoxGeometry(1, 0.014, 0.032));
    hpGeo.translate(0.5, 0, 0);
    const hpMat = keep(
      new THREE.MeshStandardMaterial({
        color: pal.glow,
        roughness: 0.35,
        metalness: 0.0,
        emissive: pal.glow,
        emissiveIntensity: 1.5,
      })
    );
    const hpRailGeo = keep(new THREE.BoxGeometry(hpFull, 0.009, 0.038));
    const hpRailMat = keep(new THREE.MeshStandardMaterial({ color: 0x131518, roughness: 0.9 }));
    const hpBars = [];
    const hpDeckY = CHASSIS_Y0 + CHASSIS_H + 0.012;
    [-1, 1].forEach((s) => {
      const rail = new THREE.Mesh(hpRailGeo, hpRailMat);
      rail.position.set(0, hpDeckY, s * Wd * 0.36);
      rail.castShadow = false;
      g.add(rail);
      const bar = new THREE.Mesh(hpGeo, hpMat);
      bar.position.set(-hpFull / 2, hpDeckY + 0.005, s * Wd * 0.36);
      bar.scale.x = hpFull;
      bar.castShadow = false;
      g.add(bar);
      hpBars.push(bar);
    });

    // ---- gimbal + 17 mm launcher, on its own pivot at the manifest's gimbal z-offset
    const turret = new THREE.Group();
    turret.position.y = env.gimbalZM;
    g.add(turret);

    const barrelY = env.barrelZM - env.gimbalZM; // the launcher axis, in the gimbal's own frame
    const tb = new Batch();
    tb.box(-0.01, 0.1, 0, 0.2, 0.19, 0.18, 63); // yaw block
    tb.box(-0.11, 0.135, 0, 0.09, 0.1, 0.13, 63); // magazine feed at the back
    tb.box(0.13, barrelY, 0, 0.14, 0.075, 0.095, 63); // friction-wheel housing
    const turretMat = keep(
      new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.66, metalness: 0.2, emissive: 0x000000 })
    );
    const turretMesh = new THREE.Mesh(keep(tb.build(THREE)), turretMat);
    turretMesh.castShadow = false;
    turret.add(turretMesh);

    // A fore-aft colour stripe on the yaw block. It is a facing marker, not a badge: at the shot
    // sizes this scene is framed for, it is the one thing that says which way a gimbal is pointing
    // when the barrel is end-on to the camera.
    const tAcc = new Batch();
    tAcc.box(0.01, 0.196, 0, 0.15, 0.012, 0.05, 63);
    const tAccMesh = new THREE.Mesh(keep(tAcc.build(THREE)), accentMat);
    tAccMesh.castShadow = false;
    turret.add(tAccMesh);

    // The bore is 17 mm and would be one pixel wide, so the launcher is drawn as what it actually
    // is: the friction-wheel housing above, and a visible 22 mm tube carrying the 17 mm bore.
    const barrelGeo = keep(new THREE.CylinderGeometry(BARREL_R * 1.3, BARREL_R * 1.3, BARREL_LEN, 10));
    barrelGeo.rotateZ(-Math.PI / 2);
    barrelGeo.translate(0.19 + BARREL_LEN / 2, 0, 0);
    const barrelMat = keep(new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.5, metalness: 0.5 }));
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.y = barrelY;
    barrel.castShadow = false;
    turret.add(barrel);

    const muzzleX = 0.19 + BARREL_LEN;

    // highlight halo, parked under this robot when a finding points at it
    const haloGeo = keep(new THREE.RingGeometry(0.42, 0.55, 40));
    haloGeo.rotateX(-Math.PI / 2);
    const haloMat = keep(
      new THREE.MeshBasicMaterial({
        color: 0xff5f57,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.y = Y_LINE + 0.001;
    halo.renderOrder = 3;
    halo.visible = false;
    g.add(halo);

    return {
      team: teamKey,
      callsign,
      group: g,
      turret,
      bodyMat,
      accentMat,
      turretMat,
      barMat,
      plateMat,
      hpBars,
      hpMat,
      hpFull,
      halo,
      muzzleX,
      muzzleY: env.barrelZM,
      // live pose, written by update() and read by the tracer/flash passes in the same frame
      x: 0,
      y: 0,
      yawDeg: 0,
      gimbalDeg: 0,
      plateLit: [0, 0, 0, 0],
    };
  }

  function buildRobots(data) {
    const teams = data.meta.teams || [];
    const byKey = {};
    teams.forEach((t) => {
      (t.robots || []).forEach((r) => {
        byKey[r.key] = { team: t.key, callsign: r.callsign, wireId: r.wireId };
      });
    });
    const out = [];
    robotByWire = new Map();
    ROBOT_ORDER.forEach((key) => {
      const info = byKey[key] || { team: key.startsWith('blue') ? 'blue' : 'red', callsign: key, wireId: 0 };
      const rec = buildRobot(THREE, info.team, info.callsign);
      rec.key = key;
      rec.wireId = info.wireId;
      rec.pose = data.poses[key];
      out.push(rec);
      robotByWire.set(info.wireId, rec);
    });

    // one instanced contact patch for all four
    const contactTex = keep(contactTexture(THREE));
    const cg = keep(new THREE.PlaneGeometry(env.lengthM * 1.18, env.lengthM * 1.18));
    cg.rotateX(-Math.PI / 2);
    cg.translate(0, Y_CONTACT, 0);
    const cm = keep(
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: contactTex,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      })
    );
    contacts = new THREE.InstancedMesh(cg, cm, out.length);
    contacts.frustumCulled = false;
    contacts.castShadow = false;
    contacts.renderOrder = 1;
    root.add(contacts);

    return out;
  }

  // ------------------------------------------------------------------ projectile effects

  function buildEffects() {
    // Tracer: a unit-length bar along +x with its origin at the tail, so one instance matrix
    // carries position, direction and length with no geometry churn.
    const tg = keep(new THREE.BoxGeometry(1, 0.022, 0.022));
    tg.translate(0.5, 0, 0);
    const tm = keep(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    tracers = new THREE.InstancedMesh(tg, tm, TRACER_MAX);
    tracers.frustumCulled = false;
    tracers.castShadow = false;
    tracers.renderOrder = 5;
    tracers.count = 0;
    root.add(tracers);

    const fg = keep(new THREE.SphereGeometry(1, 7, 5));
    const fm = keep(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    flashes = new THREE.InstancedMesh(fg, fm, FLASH_MAX);
    flashes.frustumCulled = false;
    flashes.castShadow = false;
    flashes.renderOrder = 6;
    flashes.count = 0;
    root.add(flashes);

    // Allocate the per-instance colour buffers HERE. `setColorAt` lazily creates the attribute on
    // first use, and doing that inside update() would be an allocation on the first drawn frame.
    scratchColor.setRGB(0, 0, 0);
    for (let i = 0; i < TRACER_MAX; i++) tracers.setColorAt(i, scratchColor);
    for (let i = 0; i < FLASH_MAX; i++) flashes.setColorAt(i, scratchColor);
  }

  /** Nearest pose sample index on the uniform pose grid. */
  function poseIndex(t) {
    const p = D.poses;
    const i = Math.round((t - p.t[0]) * p.rateHz);
    return i < 0 ? 0 : i >= p.t.length ? p.t.length - 1 : i;
  }

  /**
   * Resolve every shot in the ledger to a ballistic SEGMENT, once, at build time.
   *
   * The ledger stores the fire time, the flight time, the muzzle speed and, for the burst, the
   * obstacle it struck and where. It does not store a start point, because the start point is the
   * shooter's own muzzle at the fire instant, and it does not store an end point for an aimed shot,
   * because that is the target's armour at the impact instant. Both are derivable from the pose
   * track exactly, so they are derived here rather than authored twice.
   */
  function resolveShots(data) {
    const src = (data.events && data.events.shots) || [];
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      const shooter = robotByWire.get(s.robotId);
      if (!shooter) continue;
      const j = poseIndex(s.t);
      const sx = shooter.pose.xM[j];
      const sy = shooter.pose.yM[j];
      const gy = shooter.pose.gimbalYawDeg[j] * DEG;
      const x0 = sx + Math.cos(gy) * shooter.muzzleX;
      const y0 = sy + Math.sin(gy) * shooter.muzzleX;
      const flight = Number.isFinite(s.flightS) ? s.flightS : 0.05;
      let x1;
      let y1;
      let z1;
      if (s.impactXY) {
        // burst into the obstacle: the ledger names the face and the point
        x1 = s.impactXY[0];
        y1 = s.impactXY[1];
        z1 = 0.26;
      } else {
        const target = robotByWire.get(s.targetId);
        const k = poseIndex(s.t + flight);
        if (target) {
          x1 = target.pose.xM[k];
          y1 = target.pose.yM[k];
          z1 = env.armorZM;
          if (!s.hit) {
            // a miss passes the target rather than stopping at it: carry on past, offset to the
            // side the shot actually went, which is deterministic in the shot index
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy) || 1;
            const side = i % 2 === 0 ? 1 : -1;
            x1 += (dx / len) * 0.5 - (dy / len) * 0.34 * side;
            y1 += (dy / len) * 0.5 + (dx / len) * 0.34 * side;
          }
        } else {
          const r = Number.isFinite(s.rangeM) ? s.rangeM : 2.0;
          x1 = x0 + Math.cos(gy) * r;
          y1 = y0 + Math.sin(gy) * r;
          z1 = env.armorZM;
        }
      }
      out.push({
        t0: s.t,
        t1: s.t + flight,
        x0,
        y0,
        z0: shooter.muzzleY,
        x1,
        y1,
        z1,
        burst: s.kind === 'BURST',
        shooter,
      });
    }
    out.sort((a, b) => a.t0 - b.t0);
    return out;
  }

  // ------------------------------------------------------------------ camera focus track

  function buildFocus(data) {
    const p = data.poses;
    const n = p.t.length;
    const rx = new Float32Array(n);
    const ry = new Float32Array(n);
    const wsum = W_BLUE1 + 3 * W_OTHER;
    for (let i = 0; i < n; i++) {
      let ax = 0;
      let ay = 0;
      for (let k = 0; k < robots.length; k++) {
        const r = robots[k];
        const w = r.key === 'blue1' ? W_BLUE1 : W_OTHER;
        ax += r.pose.xM[i] * w;
        ay += r.pose.yM[i] * w;
      }
      rx[i] = ax / wsum;
      ry[i] = ay / wsum;
    }
    // box filter, twice, which is a cheap approximation of a gaussian and is what keeps the shot
    // from twitching on every reorientation of a 2.6 m/s^2 chassis
    focusX = smooth(smooth(rx, FOCUS_SMOOTH), FOCUS_SMOOTH >> 1);
    focusY = smooth(smooth(ry, FOCUS_SMOOTH), FOCUS_SMOOTH >> 1);
  }

  function smooth(src, half) {
    const n = src.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0;
      let c = 0;
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      for (let k = lo; k <= hi; k++) {
        a += src[k];
        c++;
      }
      out[i] = a / c;
    }
    return out;
  }

  function sampleFocus(t, out) {
    const p = D.poses;
    const x = (t - p.t[0]) * p.rateHz;
    const n = focusX.length;
    let i;
    let s;
    if (!(x > 0)) {
      i = 0;
      s = 0;
    } else if (x >= n - 1) {
      i = n - 2 < 0 ? 0 : n - 2;
      s = 1;
    } else {
      i = Math.floor(x);
      s = x - i;
    }
    const i1 = Math.min(i + 1, n - 1);
    out.x = tx(focusX[i] + (focusX[i1] - focusX[i]) * s);
    out.y = 0.22;
    out.z = tz(focusY[i] + (focusY[i1] - focusY[i]) * s);
    return out;
  }

  // ------------------------------------------------------------------ lazy build

  function build(data) {
    D = data;
    const geo = data.meta.geometry || {};
    env = Object.assign({}, DEF_ENVELOPE, geo.robotEnvelopeM || {});
    buildArena(geo);
    zoneDecals = buildZones(geo);
    zoneKeys = Object.keys(zoneDecals);
    robots = buildRobots(data);
    buildEffects();
    shots = resolveShots(data);
    hitEvents = ((data.events && data.events.hits) || []).slice().sort((a, b) => a.t - b.t);
    buffs = (data.events && data.events.buffs) || [];
    zoneRows = (data.events && data.events.zones) || [];
    supplies = collapseSupplier((data.events && data.events.supplier) || []);
    buildFocus(data);
    heroFocus = sampleFocus(clampT(HERO_T), heroOut);
    built = true;
    root.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    if (highlight) applyHighlight();
  }

  /**
   * The supplier ledger is a step trace (PREPARING, SUPPLYING, CLOSE). The scene and the HUD want
   * the WINDOW, so the steps collapse into one row per instruction: dispensing from the booking
   * until the hatch closes.
   */
  function collapseSupplier(rows) {
    const out = [];
    let open = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.step === 'PREPARING') {
        open = { t: r.t, tEnd: r.t + 3, team: r.team, zone: r.zone, supplyNum: r.supplyNum };
        out.push(open);
      } else if (open && open.team === r.team) {
        open.tEnd = r.t;
        if (r.step === 'CLOSE') open = null;
      }
    }
    return out;
  }

  const clampT = (t) => {
    const w = D.window;
    return t < w.t0 ? w.t0 : t > w.t1 ? w.t1 : t;
  };

  // ------------------------------------------------------------------ per-frame

  function update(tSec, data) {
    if (!built) {
      if (!data || !data.poses || !data.poses.t || !data.meta || !data.meta.geometry || !data.hp) return;
      build(data);
    }
    const t = clampT(Number.isFinite(tSec) ? tSec : 0);
    lastFocus = sampleFocus(t, focusOut);

    poseRobots(t);
    driveHp(t);
    driveArmour(t);
    driveTracers(t);
    driveZones(t);
    driveHighlight(t);
  }

  function poseRobots(t) {
    const p = D.poses;
    const n = p.t.length;
    const x = (t - p.t[0]) * p.rateHz;
    const i1 = Math.max(0, Math.min(n - 1, Math.floor(x)));
    const s = clamp01(x - i1);
    const i2 = Math.min(i1 + 1, n - 1);
    const i0 = Math.max(i1 - 1, 0);
    const i3 = Math.min(i1 + 2, n - 1);

    for (let k = 0; k < robots.length; k++) {
      const r = robots[k];
      const po = r.pose;
      const fx = catmull(po.xM[i0], po.xM[i1], po.xM[i2], po.xM[i3], s);
      const fy = catmull(po.yM[i0], po.yM[i1], po.yM[i2], po.yM[i3], s);
      const yaw = lerpDeg(po.yawDeg[i1], po.yawDeg[i2], s);
      const gim = lerpDeg(po.gimbalYawDeg[i1], po.gimbalYawDeg[i2], s);
      r.x = fx;
      r.y = fy;
      r.yawDeg = yaw;
      r.gimbalDeg = gim;
      r.group.position.set(tx(fx), 0, tz(fy));
      r.group.rotation.y = yaw * DEG;
      // the gimbal is stored as ABSOLUTE map-frame yaw, so the turret's own rotation is the
      // chassis-relative angle, which is the one the hardware clamps to +/- 90 deg
      let rel = gim - yaw;
      if (rel > 180) rel -= 360;
      else if (rel < -180) rel += 360;
      r.turret.rotation.y = rel * DEG;

      dummy.position.set(tx(fx), 0, tz(fy));
      dummy.rotation.set(0, yaw * DEG, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      contacts.setMatrixAt(k, dummy.matrix);
    }
    contacts.instanceMatrix.needsUpdate = true;
  }

  /** HP light indicator, off the organizer-view timeline. Held at the referee tick, not smoothed. */
  function driveHp(t) {
    const h = D.hp;
    const i = Math.max(0, Math.min(h.t.length - 1, Math.floor((t - h.t[0]) * h.rateHz + 1e-6)));
    for (let k = 0; k < robots.length; k++) {
      const r = robots[k];
      const col = h[r.key];
      const frac = col ? clamp01(col[i] / HP_FULL) : 1;
      const len = Math.max(0.001, r.hpFull * frac);
      r.hpBars[0].scale.x = len;
      r.hpBars[1].scale.x = len;
      // the strip dims as it drains, so a hurt robot reads as hurt from across the arena
      r.hpMat.emissiveIntensity = 0.5 + 1.1 * frac;
    }
  }

  /**
   * Armour-hit flash. A struck module lights white and decays; the burst never produces one,
   * because none of those 14 rounds ever reached a robot.
   */
  const DIR_INDEX = { FORWARD: 0, LEFT: 1, BACKWARD: 2, RIGHT: 3 };
  function driveArmour(t) {
    for (let k = 0; k < robots.length; k++) {
      const r = robots[k];
      for (let i = 0; i < 4; i++) r.plateLit[i] = 0;
    }
    // hits are single-digit per second at worst, and the window is short, so a hold-index walk
    // backwards over the flash lifetime is cheaper than any structure
    let i = holdIndex(hitEvents, t);
    while (i >= 0) {
      const ev = hitEvents[i];
      const age = t - ev.t;
      if (age > PLATE_FLASH_S) break;
      const target = robotByWire.get(ev.targetId);
      const di = DIR_INDEX[ev.damageSource];
      if (target && di !== undefined) {
        const v = 1 - age / PLATE_FLASH_S;
        if (v > target.plateLit[di]) target.plateLit[di] = v;
      }
      i--;
    }
    for (let k = 0; k < robots.length; k++) {
      const r = robots[k];
      for (let d = 0; d < 4; d++) {
        const v = r.plateLit[d];
        const m = r.plateMat[d];
        if (m.emissiveIntensity !== v) m.emissiveIntensity = v * 1.6;
      }
    }
  }

  /**
   * Tracers, muzzle flashes and impact blooms, all off the shot ledger.
   *
   * Both instanced meshes are written from scratch every frame and their `count` is set to what
   * was actually written, so nothing stale is left on screen after a seek and nothing is allocated.
   */
  function driveTracers(t) {
    let nT = 0;
    let nF = 0;
    // Walk BACKWARDS from the last shot fired at or before t. Everything older than the longest
    // effect lifetime is off screen, so the walk is a handful of iterations even mid-burst.
    let i = shotIndexAtOrBefore(t);
    while (i >= 0) {
      const sh = shots[i];
      const age = t - sh.t0;
      // The walk stops at the LONGEST of the three effect lifetimes, not the tracer's. Stopping at
      // the tracer's cut every impact bloom off after 0.16 s, which is shorter than the interval
      // between two rounds of a 7 Hz burst: the obstacle never accumulated a hot spot because the
      // loop had already broken out before it reached the shots that made it.
      if (age > sh.t1 - sh.t0 + EFFECT_MAX_S) break;
      if (nT >= TRACER_MAX && nF >= FLASH_MAX) break;
      const dx = sh.x1 - sh.x0;
      const dy = sh.y1 - sh.y0;
      const dz = sh.z1 - sh.z0;
      const flight = Math.max(1e-4, sh.t1 - sh.t0);
      const inFlight = age <= flight;
      const s = clamp01(age / flight);
      // head of the streak: where the round is, or the impact point once it has arrived
      const hx = sh.x0 + dx * s;
      const hy = sh.y0 + dy * s;
      const hz = sh.z0 + dz * s;
      const total = Math.hypot(dx, dy, dz) || 1e-4;
      const travelled = total * s;
      const len = inFlight ? Math.min(TRACER_LEN, travelled) : total;
      const fade = inFlight ? 1 : 1 - clamp01((age - flight) / TRACER_TAIL_S);
      if (len > 0.01 && fade > 0.02 && nT < TRACER_MAX) {
        const ux = dx / total;
        const uy = dy / total;
        const uz = dz / total;
        const tailX = hx - ux * len;
        const tailY = hy - uy * len;
        const tailZ = hz - uz * len;
        dummy.position.set(tx(tailX), tailZ, tz(tailY));
        // The bar runs along local +x. Under three's default XYZ Euler order and a zero x term,
        // local +x lands on (cosY cosZ, sinZ, -cosY sinZ), so the field bearing goes in rotation.y
        // and the elevation out of the floor plane goes in rotation.z.
        const flat = Math.hypot(dx, dy) || 1e-4;
        dummy.rotation.set(0, Math.atan2(dy, dx), Math.atan2(dz, flat));
        dummy.scale.set(len, fade * 0.85 + 0.3, fade * 0.85 + 0.3);
        dummy.updateMatrix();
        tracers.setMatrixAt(nT, dummy.matrix);
        scratchColor.setRGB(1.0 * fade, 0.6 * fade, 0.22 * fade);
        tracers.setColorAt(nT, scratchColor);
        nT++;
      }
      // muzzle flash at the launcher
      if (age <= FLASH_MUZZLE_S && nF < FLASH_MAX) {
        const v = 1 - age / FLASH_MUZZLE_S;
        dummy.position.set(tx(sh.x0), sh.z0, tz(sh.y0));
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.018 + 0.03 * v);
        dummy.updateMatrix();
        flashes.setMatrixAt(nF, dummy.matrix);
        scratchColor.setRGB(1.0 * v, 0.8 * v, 0.36 * v);
        flashes.setColorAt(nF, scratchColor);
        nF++;
      }
      // impact bloom where the round arrived: on O7's face for the burst, on armour otherwise
      const iAge = t - sh.t1;
      if (iAge >= 0 && iAge <= FLASH_IMPACT_S && nF < FLASH_MAX) {
        const v = 1 - iAge / FLASH_IMPACT_S;
        // stand the bloom a few centimetres off the struck face, so it reads as light ON the
        // obstacle rather than as a sphere buried inside it
        const total2 = Math.hypot(dx, dy, dz) || 1e-4;
        dummy.position.set(
          tx(sh.x1 - (dx / total2) * 0.045),
          sh.z1 - (dz / total2) * 0.045,
          tz(sh.y1 - (dy / total2) * 0.045)
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.04 + 0.15 * v * v);
        dummy.updateMatrix();
        flashes.setMatrixAt(nF, dummy.matrix);
        if (sh.burst) scratchColor.setRGB(1.0 * v, 0.5 * v, 0.16 * v);
        else scratchColor.setRGB(1.0 * v, 0.95 * v, 0.85 * v);
        flashes.setColorAt(nF, scratchColor);
        nF++;
      }
      i--;
    }
    tracers.count = nT;
    flashes.count = nF;
    if (nT) {
      tracers.instanceMatrix.needsUpdate = true;
      if (tracers.instanceColor) tracers.instanceColor.needsUpdate = true;
    }
    if (nF) {
      flashes.instanceMatrix.needsUpdate = true;
      if (flashes.instanceColor) flashes.instanceColor.needsUpdate = true;
    }
  }

  /** Last shot fired at or before t. -1 before the first one. */
  function shotIndexAtOrBefore(t) {
    if (!shots.length || t < shots[0].t0) return -1;
    let lo = 0;
    let hi = shots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (shots[mid].t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Which team's defense buff is live at t, or null. */
  function buffAt(t) {
    for (let i = 0; i < buffs.length; i++) {
      if (t >= buffs[i].tStartS && t < buffs[i].tEndS) return buffs[i];
    }
    return null;
  }

  /** The supply window live at t, or null. */
  function supplyAt(t) {
    for (let i = 0; i < supplies.length; i++) {
      if (t >= supplies[i].t && t < supplies[i].tEnd) return supplies[i];
    }
    return null;
  }

  /** Zone dwell: a robot is standing on the RFID tile but the 5 s has not elapsed yet. */
  function dwellZone(t) {
    const i = holdIndex(zoneRows, t);
    if (i < 0) return null;
    const row = zoneRows[i];
    return row.state === 'BEING_OCCUPIED' ? row.zone : null;
  }

  function driveZones(t) {
    if (!zoneDecals) return;
    const buff = buffAt(t);
    const dwell = dwellZone(t);
    const supply = supplyAt(t);
    const pulse = 0.5 + 0.5 * Math.sin(t * 4.4);
    for (let k = 0; k < zoneKeys.length; k++) {
      const key = zoneKeys[k];
      const dec = zoneDecals[key];
      let fill = dec.fill.base;
      let line = dec.baseLine;
      if (buff && key === `${buff.team}_defense`) {
        // an ACTIVE zone burns: the buff is team-wide and lasts 30 s, and this is the only
        // in-world signal that armour damage against that team is halved
        fill = 0.34 + 0.18 * pulse;
        line = 0.95;
      } else if (dwell && key === dwell) {
        // the 5 s occupation, not yet earned
        fill = dec.fill.base + 0.12 * pulse;
        line = 0.55 + 0.35 * pulse;
      } else if (supply && key === supply.zone) {
        fill = dec.fill.base + 0.2 * pulse;
        line = 0.55 + 0.4 * pulse;
      }
      dec.fill.mat.opacity = fill;
      dec.lineMat.opacity = line;
    }
  }

  function driveHighlight(t) {
    if (!hot) return;
    const pulse = 0.3 + Math.abs(Math.sin(t * 4.2)) * 0.55;
    hot.halo.material.opacity = pulse * 0.85;
    hot.bodyMat.emissiveIntensity = pulse * 0.5;
    hot.turretMat.emissiveIntensity = pulse * 0.5;
  }

  // ------------------------------------------------------------------ HUD contract

  /**
   * The referee state at t, version-keyed so the viewer only touches the DOM on a transition.
   *
   * `score` is the ORGANIZER view: the sum of a team's two robots' remaining HP. It is on the HUD
   * and nowhere else on purpose. The referee bus never exposes enemy state to a robot, so no Blue 1
   * channel carries it, and the strip is labelled organizer-view in the mission copy.
   *
   * The version key covers EVERY rendered field - the clock text, both totals, the state label, the
   * tone AND the note. A note that changed while the version did not would sit stale behind the
   * viewer's short-circuit, which is exactly the failure the buff and supply callouts would hit.
   */
  let hudHpI = -2;
  let hudSec = -2;
  let hudNote = null;
  function hudState(tSec) {
    if (!built || !D.hp) return null;
    const t = clampT(Number.isFinite(tSec) ? tSec : 0);
    const h = D.hp;
    const i = Math.max(0, Math.min(h.t.length - 1, Math.floor((t - h.t[0]) * h.rateHz + 1e-6)));

    // Short-circuit on the three things any rendered field can move with: the HP settlement tick,
    // the whole second the clock shows, and the note. Without it this rebuilds five strings sixty
    // times a second for a strip that changes a few times a minute.
    const remainNow =
      typeof D.stageRemainTime === 'function' ? D.stageRemainTime(t) : Math.max(0, D.durationS - t);
    const sec = Math.max(0, Math.ceil(remainNow - 1e-9));
    const buffNow = buffAt(t);
    const supplyNow = buffNow ? null : supplyAt(t);
    const noteNow = buffNow
      ? `${buffNow.team.toUpperCase()} DEFENSE +`
      : supplyNow
        ? `${supplyNow.team.toUpperCase()} SUPPLY ${supplyNow.supplyNum}`
        : '';
    if (i === hudHpI && sec === hudSec && noteNow === hudNote) return hud;
    hudHpI = i;
    hudSec = sec;
    hudNote = noteNow;

    const blue = Math.round((h.blue1 ? h.blue1[i] : 0) + (h.blue2 ? h.blue2[i] : 0));
    const red = Math.round((h.red1 ? h.red1[i] : 0) + (h.red2 ? h.red2[i] : 0));

    const teams = D.meta.teams || [];
    hud.teams[0].name = (teams[0] && teams[0].name) || 'Blue';
    hud.teams[0].color = 'blue';
    hud.teams[0].score = blue;
    hud.teams[1].name = (teams[1] && teams[1].name) || 'Red';
    hud.teams[1].color = 'red';
    hud.teams[1].score = red;

    hud.clock = clockText(remainNow);
    // `game_progress` is ROUND for the whole replay and CALCULATION at the end. The 5 s pre-round
    // countdown is not replayed, so no countdown state ever appears here.
    const over = remainNow <= 0;
    hud.state.label = over ? 'CALCULATION' : 'ROUND';
    hud.state.tone = over ? 'goal' : 'live';
    hud.state.note = noteNow;

    // EVERY rendered field is in the key. A note that moved while the version did not would sit
    // stale behind the viewer's short-circuit, which is exactly the failure a buff callout invites.
    hud.version =
      hud.clock +
      '|' + blue + ':' + red +
      '|' + hud.state.label +
      '|' + hud.state.tone +
      '|' + noteNow;
    return hud;
  }

  // ------------------------------------------------------------------ camera + highlight

  /**
   * With an argument: the smoothed action centroid, precomputed on the pose grid and weighted
   * toward Blue 1, which is the machine every channel and every finding is about.
   *
   * Without one, this is the picker card asking where the machine IS at the moment it was just
   * posed at, so it answers with the focus point of the last update() and falls back to the hero
   * moment, which sits mid-round and comfortably BEFORE the failure.
   */
  function cameraFocus(tSec) {
    if (!built) return null;
    if (Number.isFinite(tSec)) return sampleFocus(clampT(tSec), focusOut);
    return lastFocus || heroFocus;
  }

  // The focus track is already double-smoothed, so the spring only absorbs the seek and leads the
  // shot into a break. An 8 x 5 m arena is small and a chassis tops out at 3 m/s, so the lead is
  // short and the snap sits just above the widest legitimate frame-to-frame move.
  const followTuning = { omega: 3.0, lead: 0.12, snap: 2.2 };

  function applyHighlight() {
    hot = null;
    for (let i = 0; i < robots.length; i++) {
      const r = robots[i];
      const on = r.key === highlight;
      if (on) hot = r;
      r.bodyMat.emissive.setHex(on ? 0xff5f57 : 0x000000);
      r.turretMat.emissive.setHex(on ? 0xff5f57 : 0x000000);
      r.bodyMat.emissiveIntensity = on ? 0.4 : 0;
      r.turretMat.emissiveIntensity = on ? 0.4 : 0;
      r.halo.visible = on;
      r.halo.material.opacity = on ? 0.4 : 0;
    }
  }

  /** `blue1`, `red2`: the payload's own robot keys, which is what data.js's findings point at. */
  function setHighlight(partId) {
    highlight = partId && /^(blue|red)[12]$/.test(partId) ? partId : null;
    if (built) applyHighlight();
  }

  function dispose() {
    mount.remove(root);
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => m.dispose && m.dispose());
      }
    });
    disposables.forEach((d) => d.dispose && d.dispose());
    robots = [];
    robotByWire = null;
    shots = [];
    hitEvents = [];
    buffs = [];
    supplies = [];
    zoneRows = [];
    zoneDecals = null;
    zoneKeys = null;
    contacts = null;
    tracers = null;
    flashes = null;
    focusX = null;
    focusY = null;
    lastFocus = null;
    heroFocus = null;
    hot = null;
    highlight = null;
    hudHpI = -2;
    hudSec = -2;
    hudNote = null;
    built = false;
    D = null;
  }

  return {
    update,
    setHighlight,
    dispose,
    cameraHome,
    cameraFocus,
    followTuning,
    hudState,
    // The viewer's default rig is wrong for an 8 x 5 m arena: an 80 m ground plane and two 60 m
    // grids sit under the floor, and a 1024^2 shadow map over an 18 m frustum is ~18 mm/texel on
    // 600 mm robots. Grounding is the baked contact discs instead.
    rendering: {
      ground: false,
      grids: false,
      shadow: false,
      anisotropy: true,
      fog: { color: 0x0e1114, near: 9, far: 34 },
    },
  };
}
